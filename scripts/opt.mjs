// 素材处理：assets/raw 里的模型、贴图、音频 → 压缩后放到 assets/opt。规则见 CLAUDE.md 12.2，API 依据 reference/notes/assets-and-build.md 第 8 节。
// 用法：node scripts/opt.mjs [--ratio=0.5] [--small] [--check-credits-only]
//   --ratio=  simplify 保留的三角比例（默认 0.5）；文件名含 ".keep." 的模型跳过简化
//   --small   贴图最长边限制 1024（默认 2048）
//   --check-credits-only  只校验 credits.json

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, simplify, meshopt, textureCompress, prune, resample } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const projectRoot = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const rawDir = path.join( projectRoot, 'assets', 'raw' );
const optDir = path.join( projectRoot, 'assets', 'opt' );
const creditsPath = path.join( projectRoot, 'assets', 'credits.json' );

const options = { ratio: 0.5, maxSize: 2048, checkCreditsOnly: false };
for ( const arg of process.argv.slice( 2 ) ) {

	if ( arg.startsWith( '--ratio=' ) ) {

		options.ratio = Number( arg.slice( '--ratio='.length ) );
		if ( ! ( options.ratio > 0 && options.ratio <= 1 ) ) {

			console.error( '--ratio 必须在 (0, 1] 之间，收到：' + arg );
			process.exit( 1 );

		}

	} else if ( arg === '--small' ) {

		options.maxSize = 1024;

	} else if ( arg === '--check-credits-only' ) {

		options.checkCreditsOnly = true;

	} else {

		console.error( '不认识的参数：' + arg );
		process.exit( 1 );

	}

}

function walk( dir, filter, skipDirName ) {

	const found = [];
	if ( ! fs.existsSync( dir ) ) return found;
	for ( const entry of fs.readdirSync( dir, { withFileTypes: true } ) ) {

		const full = path.join( dir, entry.name );
		if ( entry.isDirectory() ) {

			if ( skipDirName && entry.name === skipDirName ) continue;
			found.push( ...walk( full, filter, skipDirName ) );

		} else if ( filter( entry.name ) ) {

			found.push( full );

		}

	}

	return found;

}

function formatBytes( bytes ) {

	if ( bytes >= 1024 * 1024 ) return ( bytes / 1024 / 1024 ).toFixed( 2 ) + ' MB';
	return ( bytes / 1024 ).toFixed( 1 ) + ' KB';

}

// 三角数：每个 TRIANGLES 图元的索引数 / 3，没索引就用顶点数
function countTriangles( document ) {

	let total = 0;
	for ( const mesh of document.getRoot().listMeshes() ) {

		for ( const primitive of mesh.listPrimitives() ) {

			if ( primitive.getMode() !== 4 ) continue;
			const indices = primitive.getIndices();
			const position = primitive.getAttribute( 'POSITION' );
			const count = indices ? indices.getCount() : ( position ? position.getCount() : 0 );
			total += count / 3;

		}

	}

	return Math.round( total );

}

async function processModels() {

	const files = walk( rawDir, ( name ) => /\.(glb|gltf)$/i.test( name ), 'audio' );
	if ( files.length === 0 ) {

		console.log( '模型：assets/raw 里没有 glb/gltf，跳过' );
		return;

	}

	await MeshoptEncoder.ready;
	await MeshoptSimplifier.ready;

	const io = new NodeIO()
		.registerExtensions( ALL_EXTENSIONS )
		.registerDependencies( { 'meshopt.encoder': MeshoptEncoder } );

	for ( const file of files ) {

		const relative = path.relative( rawDir, file );
		const baseName = path.basename( file, path.extname( file ) );
		const outPath = path.join( optDir, baseName + '.glb' );
		const beforeBytes = fs.statSync( file ).size;

		console.log( `模型：处理 ${ relative }` );
		const document = await io.read( file );
		const beforeTriangles = countTriangles( document );

		const keepDetail = /\.keep\./i.test( path.basename( file ) );
		const transforms = [ dedup(), prune(), weld(), resample() ];
		if ( ! keepDetail ) {

			transforms.push( simplify( { simplifier: MeshoptSimplifier, ratio: options.ratio, error: 0.001 } ) );

		}

		transforms.push(
			textureCompress( { encoder: sharp, targetFormat: 'webp', resize: [ options.maxSize, options.maxSize ], quality: 82 } ),
			prune(),
			meshopt( { encoder: MeshoptEncoder, level: 'medium' } ),
		);

		await document.transform( ...transforms );

		fs.mkdirSync( path.dirname( outPath ), { recursive: true } );
		await io.write( outPath, document );
		const afterBytes = fs.statSync( outPath ).size;
		const afterTriangles = countTriangles( document );
		const extensions = document.getRoot().listExtensionsUsed().map( ( extension ) => extension.extensionName ).join( ', ' );

		console.log( `  ${ formatBytes( beforeBytes ) } → ${ formatBytes( afterBytes ) }，三角 ${ beforeTriangles } → ${ afterTriangles }${ keepDetail ? '（未简化）' : '' }，扩展：${ extensions || '无' }` );

	}

}

async function processImages() {

	const files = walk( rawDir, ( name ) => /\.(png|jpe?g)$/i.test( name ), 'audio' );
	if ( files.length === 0 ) {

		console.log( '贴图：assets/raw 里没有独立的 png/jpg，跳过' );
		return;

	}

	for ( const file of files ) {

		const relative = path.relative( rawDir, file );
		const outPath = path.join( optDir, relative.replace( /\.(png|jpe?g)$/i, '.webp' ) );
		fs.mkdirSync( path.dirname( outPath ), { recursive: true } );
		const beforeBytes = fs.statSync( file ).size;

		await sharp( file )
			.resize( { width: options.maxSize, height: options.maxSize, fit: 'inside', withoutEnlargement: true } )
			.webp( { quality: 82 } )
			.toFile( outPath );

		const afterBytes = fs.statSync( outPath ).size;
		console.log( `贴图：${ relative } ${ formatBytes( beforeBytes ) } → ${ formatBytes( afterBytes ) }` );

	}

}

function hasFfmpeg() {

	const result = spawnSync( 'ffmpeg', [ '-version' ], { stdio: 'ignore' } );
	return ! result.error && result.status === 0;

}

function processAudio() {

	const audioDir = path.join( rawDir, 'audio' );
	const files = walk( audioDir, ( name ) => /\.(wav|mp3|ogg|flac|m4a|opus)$/i.test( name ) );
	if ( files.length === 0 ) {

		console.log( '音频：assets/raw/audio 里没有文件，跳过' );
		return;

	}

	if ( ! hasFfmpeg() ) {

		console.log( '音频：系统里没有 ffmpeg，无法转 Opus，先跳过（装好 ffmpeg 再跑一次）' );
		return;

	}

	const outDir = path.join( optDir, 'audio' );
	fs.mkdirSync( outDir, { recursive: true } );

	for ( const file of files ) {

		const outPath = path.join( outDir, path.basename( file, path.extname( file ) ) + '.opus' );
		const result = spawnSync( 'ffmpeg', [ '-y', '-i', file, '-c:a', 'libopus', '-b:a', '64k', '-vbr', 'on', outPath ], { stdio: 'ignore' } );
		if ( result.status !== 0 ) {

			console.error( `音频：${ path.basename( file ) } 转码失败` );
			process.exitCode = 1;
			continue;

		}

		console.log( `音频：${ path.basename( file ) } ${ formatBytes( fs.statSync( file ).size ) } → ${ formatBytes( fs.statSync( outPath ).size ) }` );

	}

}

function checkCredits() {

	if ( ! fs.existsSync( creditsPath ) ) {

		console.error( '找不到 assets/credits.json' );
		return false;

	}

	let credits;
	try {

		credits = JSON.parse( fs.readFileSync( creditsPath, 'utf8' ) );

	} catch ( error ) {

		console.error( 'credits.json 不是合法 JSON：' + error.message );
		return false;

	}

	const items = Array.isArray( credits.items ) ? credits.items : null;
	if ( ! items ) {

		console.error( 'credits.json 里缺 items 数组' );
		return false;

	}

	const requiredFields = [ 'title', 'author', 'license', 'url', 'usedFor' ];
	let ok = true;

	items.forEach( ( item, index ) => {

		const missing = requiredFields.filter( ( field ) => typeof item[ field ] !== 'string' || item[ field ].trim() === '' );
		if ( missing.length > 0 ) {

			console.error( `credits.json 第 ${ index + 1 } 条缺字段：${ missing.join( '、' ) }` );
			ok = false;

		}

	} );

	// assets/opt 里每个 glb 都要有对应条目（按 file 字段匹配文件名）
	const optModels = walk( optDir, ( name ) => /\.glb$/i.test( name ) ).map( ( file ) => path.basename( file ) );
	const creditedFiles = new Set( items.map( ( item ) => item.file ).filter( Boolean ) );
	for ( const model of optModels ) {

		if ( ! creditedFiles.has( model ) ) {

			console.error( `assets/opt/${ model } 在 credits.json 里没有条目（需要一条 file 为 "${ model }" 的记录）` );
			ok = false;

		}

	}

	if ( ok ) console.log( `credits.json 校验通过，${ items.length } 条记录，${ optModels.length } 个模型都有署名` );
	return ok;

}

async function main() {

	if ( ! options.checkCreditsOnly ) {

		if ( ! fs.existsSync( rawDir ) ) {

			console.log( '没有 assets/raw 目录，没有原始素材，跳过处理' );

		} else {

			fs.mkdirSync( optDir, { recursive: true } );
			await processModels();
			await processImages();
			processAudio();

		}

	}

	const creditsOk = checkCredits();
	if ( ! creditsOk ) process.exitCode = 1;

}

main().catch( ( error ) => {

	console.error( '素材处理出错：' + ( error && error.stack || error ) );
	process.exit( 1 );

} );
