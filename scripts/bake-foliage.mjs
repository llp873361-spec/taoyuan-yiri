// 远处树的替身图集烘焙（规格书 §4 阶段 12：scripts/bake-foliage.mjs → assets/opt/foliage/）
// 起一个 vite 开发服务器，用本机 Chrome（真显卡）打开 /tools/foliage.html?mode=atlas，
// 每个树种 × 变体 × 8 个方位 × 两遍（反照率、法线）逐格取回像素；每格 256 像素缩到 120（2×2 超采样）、四周留 4 像素边 → 128，
// 透明处把颜色往外扩（插值、mipmap 不会把黑边拉进来），拼成两张图集：一行一个模板、一列一个方位。
// 用法：node scripts/bake-foliage.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve( 'assets/opt/foliage' );
const renderSize = 256;
const innerSize = 120;
const tileSize = 128;
const padding = ( tileSize - innerSize ) / 2;

fs.mkdirSync( outDir, { recursive: true } );
const server = await createServer( { configFile: 'vite.config.js', server: { port: 5198, strictPort: true }, logLevel: 'error' } );
await server.listen();
const browser = await chromium.launch( { channel: 'chrome', headless: true } );
const page = await browser.newPage( { viewport: { width: 640, height: 480 } } );
const problems = [];
page.on( 'console', ( msg ) => {

	if ( msg.type() === 'error' || msg.type() === 'warning' ) {

		problems.push( msg.text() );
		console.log( '页面' + msg.type() + '：' + msg.text() );

	} else console.log( '页面：' + msg.text() );

} );
page.on( 'pageerror', ( error ) => {

	problems.push( 'pageerror ' + error.message );
	console.log( '页面出错：' + error.message );

} );
const started = Date.now();
await page.goto( `http://localhost:5198/tools/foliage.html?mode=atlas&tile=${ renderSize }` );
await page.waitForFunction( () => window.__foliageReady === true, null, { timeout: 180000 } );
const meta = await page.evaluate( () => ( { info: window.__foliageBake.info, views: window.__foliageBake.views, elevation: window.__foliageBake.elevation, hash: window.__foliageBake.hash } ) );
const rows = meta.info.length;
const columns = meta.views;
console.log( `替身烘焙：${ rows } 个模板 × ${ columns } 个方位` );

// 透明处往外扩色：每一遍把透明像素染成 8 邻域里不透明像素的平均色，扩 6 遍（只动 RGB，alpha 不变）
function bleed( data, size ) {

	const solid = new Uint8Array( size * size );
	for ( let i = 0; i < size * size; i ++ ) solid[ i ] = data[ i * 4 + 3 ] > 8 ? 1 : 0;
	for ( let pass = 0; pass < 6; pass ++ ) {

		const next = solid.slice();
		for ( let y = 0; y < size; y ++ ) {

			for ( let x = 0; x < size; x ++ ) {

				const index = y * size + x;
				if ( solid[ index ] ) continue;
				let r = 0, g = 0, b = 0, count = 0;
				for ( let dy = - 1; dy <= 1; dy ++ ) for ( let dx = - 1; dx <= 1; dx ++ ) {

					const nx = x + dx, ny = y + dy;
					if ( nx < 0 || ny < 0 || nx >= size || ny >= size ) continue;
					const neighbor = ny * size + nx;
					if ( ! solid[ neighbor ] ) continue;
					r += data[ neighbor * 4 ]; g += data[ neighbor * 4 + 1 ]; b += data[ neighbor * 4 + 2 ]; count ++;

				}

				if ( count === 0 ) continue;
				data[ index * 4 ] = r / count; data[ index * 4 + 1 ] = g / count; data[ index * 4 + 2 ] = b / count;
				next[ index ] = 1;

			}

		}

		solid.set( next );

	}

}

const atlases = [ Buffer.alloc( columns * tileSize * rows * tileSize * 4 ), Buffer.alloc( columns * tileSize * rows * tileSize * 4 ) ];
const atlasWidth = columns * tileSize;
for ( let row = 0; row < rows; row ++ ) {

	for ( let view = 0; view < columns; view ++ ) {

		for ( let pass = 0; pass < 2; pass ++ ) {

			const base64 = await page.evaluate( ( [ index, v, p ] ) => window.__foliageBake.tile( index, v, p ), [ row, view, pass ] );
			// WebGPU 读回的行从上往下；缩小时 sharp 按预乘 alpha 插值，边上不发黑
			const raw = Buffer.from( base64, 'base64' );
			const { data } = await sharp( raw, { raw: { width: renderSize, height: renderSize, channels: 4 } } )
				.resize( innerSize, innerSize, { kernel: 'lanczos3' } )
				.extend( { top: padding, bottom: padding, left: padding, right: padding, background: { r: 0, g: 0, b: 0, alpha: 0 } } )
				.raw().toBuffer( { resolveWithObject: true } );
			bleed( data, tileSize );
			for ( let y = 0; y < tileSize; y ++ ) data.copy( atlases[ pass ], ( ( row * tileSize + y ) * atlasWidth + view * tileSize ) * 4, y * tileSize * 4, ( y + 1 ) * tileSize * 4 );

		}

	}

	console.log( `  ${ meta.info[ row ].species }·${ meta.info[ row ].variant } 烘完` );

}

const files = [];
for ( const [ pass, name, quality ] of [ [ 0, 'impostor-color', 92 ], [ 1, 'impostor-normal', 95 ] ] ) {

	const file = name + '.webp';
	await sharp( atlases[ pass ], { raw: { width: atlasWidth, height: rows * tileSize, channels: 4 } } ).webp( { quality, alphaQuality: 100, effort: 6 } ).toFile( path.join( outDir, file ) );
	const bytes = fs.statSync( path.join( outDir, file ) ).size;
	files.push( { id: name, file, mime: 'image/webp', bytes } );
	console.log( `${ file }：${ atlasWidth }×${ rows * tileSize }，${ ( bytes / 1024 ).toFixed( 0 ) } KB` );

}

// 清单：每个模板一行；size 是格子边长对应的米数（留边以后），root 是树根在格子里的竖直位置（0 底、1 顶）
const templates = meta.info.map( ( item ) => ( {
	species: item.species,
	variant: item.variant,
	size: item.size * tileSize / innerSize,
	root: ( padding + item.root * innerSize ) / tileSize,
} ) );
fs.writeFileSync( path.join( outDir, 'manifest.json' ), JSON.stringify( { note: '远处树的替身图集（scripts/bake-foliage.mjs 生成）', hash: meta.hash, tile: tileSize, views: columns, elevation: meta.elevation, templates, files }, null, '\t' ) );
console.log( `用时 ${ ( ( Date.now() - started ) / 1000 ).toFixed( 1 ) } 秒；问题：${ problems.length ? problems.join( '\n' ) : '无' }` );
await browser.close();
await server.close();
