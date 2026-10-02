// 全景和飞行视频烘焙（规格书 6.5）：在开发机上用 Playwright + 本机显卡打开 dist/index.html?shot=1&bake=1&q=hi，
// 冻结时间和机位，关掉需要实时叠加的层，每个烘焙点渲立方体六面（每面 config.panorama.faceFov 度，含每边 15° 余量），
// 在 Node 里拼成等距柱状全景图（约定和 src/scenes/panorama.js 一样：u = 0.5 是本地 −z、往右 u 变大，第一行是正上方），
// 再烘遮罩（R 天空、G 闪光密度）和夜空高精度渐变（开着颗粒连截几帧求平均，得到超出 8 位精度的颜色，存半精度）；
// 每段飞行按最高画质一帧帧推进截图，交给 ffmpeg 编成 1080p H.264 视频。写 assets/opt/pano/manifest.json 并打印体积。
//
// 用法：node scripts/bake-pano.mjs [--locations=sunset,aurora] [--no-panoramas] [--no-flights] [--legs=garden-sunset,...] [--html=产物副本]
// 烘焙之前先 npm run build（烘的是 dist/index.html 里的画面）；烘完再 npm run build 一次，素材才会进产物。

import { chromium } from 'playwright';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import sharp from 'sharp';
import zlib from 'node:zlib';
import * as THREE from 'three';
import config from '../src/config.js';

const projectRoot = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
let distPath = path.join( projectRoot, 'dist', 'index.html' );
const outDir = path.join( projectRoot, 'assets', 'opt', 'pano' );
const manifestPath = path.join( outDir, 'manifest.json' );
const panoramaConfig = config.panorama;
const degree = Math.PI / 180;

const args = Object.fromEntries( process.argv.slice( 2 ).map( ( item ) => {

	const [ name, ...rest ] = item.replace( /^--/, '' ).split( '=' );
	return [ name, rest.length ? rest.join( '=' ) : true ];

} ) );

// --html=路径：烘焙一份冻结的产物副本（烘焙要几十分钟，期间可以继续改代码、重新构建）
if ( args.html ) distPath = path.resolve( String( args.html ) );
const sceneKeys = config.scenes.map( ( scene ) => scene.key );
const locationKeys = args.locations ? String( args.locations ).split( ',' ) : sceneKeys.filter( ( key ) => panoramaConfig.locations[ key ] );
const bakePanoramas = ! args[ 'no-panoramas' ];
const bakeFlights = ! args[ 'no-flights' ];

fs.mkdirSync( outDir, { recursive: true } );
const manifest = fs.existsSync( manifestPath ) ? JSON.parse( fs.readFileSync( manifestPath, 'utf8' ) ) : { version: 1, files: [], locations: {}, flights: {} };
manifest.files = manifest.files || [];
manifest.locations = manifest.locations || {};
manifest.flights = manifest.flights || {};

function registerFile( id, file, mime ) {

	manifest.files = manifest.files.filter( ( item ) => item.id !== id );
	manifest.files.push( { id, file, mime, bytes: fs.statSync( path.join( outDir, file ) ).size } );

}

// ===================== 立方体的六个面 =====================
// 偏航 0 = 本地 −z，往右为正；相机的姿态和页面里 __gift.bakePose 一样（Euler(pitch, −yaw, 0, 'YXZ')）
const faces = [
	{ name: 'front', yaw: 0, pitch: 0 },
	{ name: 'right', yaw: 90, pitch: 0 },
	{ name: 'back', yaw: 180, pitch: 0 },
	{ name: 'left', yaw: 270, pitch: 0 },
	{ name: 'up', yaw: 0, pitch: 90 },
	{ name: 'down', yaw: 0, pitch: - 90 },
].map( ( face ) => {

	const quaternion = new THREE.Quaternion().setFromEuler( new THREE.Euler( face.pitch * degree, - face.yaw * degree, 0, 'YXZ' ) );
	return {
		...face,
		forward: new THREE.Vector3( 0, 0, - 1 ).applyQuaternion( quaternion ),
		right: new THREE.Vector3( 1, 0, 0 ).applyQuaternion( quaternion ),
		up: new THREE.Vector3( 0, 1, 0 ).applyQuaternion( quaternion ),
	};

} );

// 截图（PNG）→ 原始 RGB 字节
async function captureRaw( page ) {

	const buffer = await page.screenshot( { type: 'png' } );
	const { data, info } = await sharp( buffer ).removeAlpha().raw().toBuffer( { resolveWithObject: true } );
	return { data, width: info.width, height: info.height };

}

async function step( page, frames = 1 ) {

	for ( let i = 0; i < frames; i ++ ) await page.evaluate( () => window.__gift.step( 1 / 60 ) );

}

// 方向 → 哪一面、面上的像素坐标（面的中心 90° 用来拼，余量只是给泛光、抗锯齿留的）
const tanHalf = Math.tan( panoramaConfig.faceFov / 2 * degree );
function sampleFaces( faceImages, direction, channels, out, offset ) {

	let best = 0;
	let bestDot = - Infinity;
	for ( let i = 0; i < 6; i ++ ) {

		const value = direction.dot( faces[ i ].forward );
		if ( value > bestDot ) {

			bestDot = value;
			best = i;

		}

	}

	const face = faces[ best ];
	const image = faceImages[ best ];
	const x = direction.dot( face.right ) / bestDot / tanHalf;
	const y = direction.dot( face.up ) / bestDot / tanHalf;
	const pixelX = ( x * 0.5 + 0.5 ) * image.width - 0.5;
	const pixelY = ( 0.5 - y * 0.5 ) * image.height - 0.5;
	const x0 = Math.max( 0, Math.min( image.width - 2, Math.floor( pixelX ) ) );
	const y0 = Math.max( 0, Math.min( image.height - 2, Math.floor( pixelY ) ) );
	const fx = Math.min( 1, Math.max( 0, pixelX - x0 ) );
	const fy = Math.min( 1, Math.max( 0, pixelY - y0 ) );
	const data = image.data;
	const stride = image.width * channels;
	for ( let c = 0; c < channels; c ++ ) {

		const top = data[ y0 * stride + x0 * channels + c ] * ( 1 - fx ) + data[ y0 * stride + ( x0 + 1 ) * channels + c ] * fx;
		const bottom = data[ ( y0 + 1 ) * stride + x0 * channels + c ] * ( 1 - fx ) + data[ ( y0 + 1 ) * stride + ( x0 + 1 ) * channels + c ] * fx;
		out[ offset + c ] = top * ( 1 - fy ) + bottom * fy;

	}

}

// 六面 → 等距柱状（width × width/2），channels 个通道，结果是 Float32Array
function stitch( faceImages, width, channels ) {

	const height = width / 2;
	const out = new Float32Array( width * height * channels );
	const direction = new THREE.Vector3();
	for ( let row = 0; row < height; row ++ ) {

		const elevation = ( 0.5 - ( row + 0.5 ) / height ) * Math.PI;
		const cosine = Math.cos( elevation );
		for ( let column = 0; column < width; column ++ ) {

			const azimuth = ( ( column + 0.5 ) / width - 0.5 ) * Math.PI * 2;
			direction.set( Math.sin( azimuth ) * cosine, Math.sin( elevation ), - Math.cos( azimuth ) * cosine );
			sampleFaces( faceImages, direction, channels, out, ( row * width + column ) * channels );

		}

	}

	return out;

}

// float → 半精度（夜空渐变存成半精度原始数据）
const floatView = new Float32Array( 1 );
const intView = new Uint32Array( floatView.buffer );
// 半精度 RGB → 每行按通道和左边一格做差（渐变里相邻的值很接近，差值小，gzip 压得动）→ gzip。
// 页面里 src/scenes/panorama.js 的 halfTextureOf 反过来：解压、逐行累加、补上 alpha
function packSky( half, width ) {

	const delta = new Uint16Array( half.length );
	const rowLength = width * 3;
	for ( let start = 0; start < half.length; start += rowLength ) {

		for ( let i = 0; i < rowLength; i ++ ) {

			const previous = i < 3 ? 0 : half[ start + i - 3 ];
			delta[ start + i ] = ( half[ start + i ] - previous ) & 0xffff;

		}

	}

	return zlib.gzipSync( Buffer.from( delta.buffer ), { level: 9 } );

}

function toHalf( value ) {

	floatView[ 0 ] = value;
	const bits = intView[ 0 ];
	const sign = ( bits >> 16 ) & 0x8000;
	let exponent = ( ( bits >> 23 ) & 0xff ) - 127 + 15;
	let mantissa = bits & 0x7fffff;
	if ( exponent <= 0 ) return sign;
	if ( exponent >= 31 ) return sign | 0x7c00;
	return sign | ( exponent << 10 ) | ( mantissa >> 13 );

}

function srgbToLinear( value ) {

	const v = value / 255;
	return v <= 0.04045 ? v / 12.92 : Math.pow( ( v + 0.055 ) / 1.055, 2.4 );

}

// ===================== 烘一个点 =====================
async function bakePoint( page, key, pointIndex, point ) {

	const locationConfig = panoramaConfig.locations[ key ];
	const sceneIndex = sceneKeys.indexOf( key );
	await page.evaluate( ( [ index, time ] ) => window.__gift.bakeLocation( index, time ), [ sceneIndex, point.time ] );
	const position = await page.evaluate( ( value ) => window.__gift.bakePointPosition( value ), point.position );
	for ( const layer of locationConfig.off || [] ) await page.evaluate( ( name ) => window.__gift.setLayer( name, false ), layer );

	const colorFaces = [];
	const maskFaces = [];
	const sparkleFaces = [];
	const skyFaces = [];
	for ( const face of faces ) {

		await page.evaluate( ( [ where, yaw, pitch, fov ] ) => window.__gift.bakePose( where, yaw, pitch, fov ), [ position, face.yaw, face.pitch, panoramaConfig.faceFov ] );
		await step( page, 3 );
		colorFaces.push( await captureRaw( page ) );

		// 遮罩：R 天空
		await page.evaluate( () => window.__gift.bakeChain( 'mask' ) );
		await step( page, 1 );
		maskFaces.push( await captureRaw( page ) );
		await page.evaluate( () => window.__gift.bakeChain( null ) );

		// 闪光密度：闪点那一层开、关各截一张求差（同一时刻），亮度差越大闪光越密
		if ( locationConfig.sparkleLayer ) {

			await page.evaluate( ( name ) => window.__gift.setLayer( name, true ), locationConfig.sparkleLayer );
			await step( page, 1 );
			const on = await captureRaw( page );
			await page.evaluate( ( name ) => window.__gift.setLayer( name, false ), locationConfig.sparkleLayer );
			await step( page, 1 );
			const off = await captureRaw( page );
			const difference = Buffer.alloc( on.width * on.height );
			for ( let i = 0; i < difference.length; i ++ ) {

				const delta = ( on.data[ i * 3 ] - off.data[ i * 3 ] ) * 0.2126 + ( on.data[ i * 3 + 1 ] - off.data[ i * 3 + 1 ] ) * 0.7152 + ( on.data[ i * 3 + 2 ] - off.data[ i * 3 + 2 ] ) * 0.0722;
				difference[ i ] = Math.max( 0, Math.min( 255, delta * 3 ) );

			}

			sparkleFaces.push( { data: difference, width: on.width, height: on.height } );

		}

		// 高精度渐变：开着颗粒（每帧不一样的随机抖动）连截 3 帧，求平均
		await page.evaluate( () => window.__gift.bakeGrain( true ) );
		const sum = new Float32Array( colorFaces[ 0 ].width * colorFaces[ 0 ].height * 3 );
		const frames = 3;
		for ( let k = 0; k < frames; k ++ ) {

			await step( page, 1 );
			const shot = await captureRaw( page );
			for ( let i = 0; i < sum.length; i ++ ) sum[ i ] += srgbToLinear( shot.data[ i ] ) / frames;

		}

		await page.evaluate( () => window.__gift.bakeGrain( false ) );
		skyFaces.push( { data: sum, width: colorFaces[ 0 ].width, height: colorFaces[ 0 ].height } );
		process.stdout.write( '.' );

	}

	for ( const layer of locationConfig.off || [] ) await page.evaluate( ( name ) => window.__gift.setLayer( name, true ), layer );

	// CSS 3D 兜底没有实时叠加：有叠加层的地点，把叠加层开着再拍一遍六面，存一张"全开"的全景（宽 cssWidth）
	const fullFaces = [];
	if ( ( locationConfig.off || [] ).length > 0 ) {

		for ( const face of faces ) {

			await page.evaluate( ( [ where, yaw, pitch, fov ] ) => window.__gift.bakePose( where, yaw, pitch, fov ), [ position, face.yaw, face.pitch, panoramaConfig.faceFov ] );
			await step( page, fullFaces.length === 0 ? 8 : 3 );
			fullFaces.push( await captureRaw( page ) );

		}

	}

	const width = panoramaConfig.width;
	const base = `${ key }-${ pointIndex }`;

	let full = null;
	if ( fullFaces.length ) {

		const cssWidth = panoramaConfig.cssWidth;
		const fullColor = stitch( fullFaces, cssWidth, 3 );
		const fullBytes = Buffer.alloc( fullColor.length );
		for ( let i = 0; i < fullColor.length; i ++ ) fullBytes[ i ] = Math.max( 0, Math.min( 255, Math.round( fullColor[ i ] ) ) );
		await sharp( fullBytes, { raw: { width: cssWidth, height: cssWidth / 2, channels: 3 } } ).webp( { quality: 85, effort: 5 } ).toFile( path.join( outDir, base + '-full.webp' ) );
		registerFile( base + '-full', base + '-full.webp', 'image/webp' );
		full = base + '-full';

	}

	// 全景图
	const color = stitch( colorFaces, width, 3 );
	const colorBytes = Buffer.alloc( color.length );
	for ( let i = 0; i < color.length; i ++ ) colorBytes[ i ] = Math.max( 0, Math.min( 255, Math.round( color[ i ] ) ) );
	await sharp( colorBytes, { raw: { width, height: width / 2, channels: 3 } } ).webp( { quality: panoramaConfig.webpQuality, effort: 5 } ).toFile( path.join( outDir, base + '.webp' ) );
	registerFile( base, base + '.webp', 'image/webp' );

	// 遮罩：R 天空、G 闪光密度（B、A 留给窗户和水面，以后的地点用）
	const maskWidth = panoramaConfig.maskWidth;
	const sky = stitch( maskFaces, maskWidth, 3 );
	const sparkle = sparkleFaces.length ? stitch( sparkleFaces, maskWidth, 1 ) : null;
	const maskBytes = Buffer.alloc( maskWidth * maskWidth / 2 * 4 );
	for ( let i = 0; i < maskWidth * maskWidth / 2; i ++ ) {

		maskBytes[ i * 4 ] = Math.round( sky[ i * 3 ] );
		maskBytes[ i * 4 + 1 ] = sparkle ? Math.round( sparkle[ i ] ) : 0;
		maskBytes[ i * 4 + 2 ] = 0;
		maskBytes[ i * 4 + 3 ] = 255;

	}

	await sharp( maskBytes, { raw: { width: maskWidth, height: maskWidth / 2, channels: 4 } } ).webp( { lossless: true } ).toFile( path.join( outDir, base + '-mask.webp' ) );
	registerFile( base + '-mask', base + '-mask.webp', 'image/webp' );

	// 夜空高精度渐变：先拼成遮罩那么宽（线性颜色），再在天空里按面积平均缩到 skyWidth，存半精度
	const skyColor = stitch( skyFaces, maskWidth, 3 );
	const skyWidth = panoramaConfig.skyWidth;
	const skyHeight = skyWidth / 2;
	const factor = maskWidth / skyWidth;
	const half = new Uint16Array( skyWidth * skyHeight * 3 );
	for ( let row = 0; row < skyHeight; row ++ ) {

		for ( let column = 0; column < skyWidth; column ++ ) {

			let red = 0, green = 0, blue = 0, weight = 0, plainRed = 0, plainGreen = 0, plainBlue = 0;
			for ( let dy = 0; dy < factor; dy ++ ) {

				for ( let dx = 0; dx < factor; dx ++ ) {

					const index = ( row * factor + dy ) * maskWidth + column * factor + dx;
					const skyWeight = sky[ index * 3 ] / 255;
					red += skyColor[ index * 3 ] * skyWeight;
					green += skyColor[ index * 3 + 1 ] * skyWeight;
					blue += skyColor[ index * 3 + 2 ] * skyWeight;
					weight += skyWeight;
					plainRed += skyColor[ index * 3 ];
					plainGreen += skyColor[ index * 3 + 1 ];
					plainBlue += skyColor[ index * 3 + 2 ];

				}

			}

			const count = factor * factor;
			const useSky = weight > 0.5;
			// 半精度纹理第一行在下（和全景图翻转以后一样）
			const outIndex = ( ( skyHeight - 1 - row ) * skyWidth + column ) * 3;
			half[ outIndex ] = toHalf( useSky ? red / weight : plainRed / count );
			half[ outIndex + 1 ] = toHalf( useSky ? green / weight : plainGreen / count );
			half[ outIndex + 2 ] = toHalf( useSky ? blue / weight : plainBlue / count );

		}

	}

	fs.writeFileSync( path.join( outDir, base + '-sky.bin.gz' ), packSky( half, skyWidth ) );
	registerFile( base + '-sky', base + '-sky.bin.gz', 'application/gzip' );

	return { image: base, mask: base + '-mask', sky: base + '-sky', full, skyWidth, skyHeight, position, time: point.time };

}

// ===================== 烘一段飞行 =====================
async function bakeFlight( page, leg ) {

	const toIndex = sceneKeys.indexOf( leg.to );
	const video = panoramaConfig.video;
	const frameDir = fs.mkdtempSync( path.join( os.tmpdir(), 'bake-flight-' ) );
	const ok = await page.evaluate( ( index ) => window.__gift.flightTo( index, 0 ), toIndex );
	if ( ! ok ) throw new Error( `飞行 ${ leg.from } → ${ leg.to } 没起飞` );
	// 颗粒不进视频：每帧不一样的噪声让 H.264 码率翻好几倍（22 秒 23 MB），播放时也看不出区别
	await page.evaluate( () => window.__gift.bakeGrain( false ) );
	const duration = await page.evaluate( () => window.__gift.info().flight.duration );
	const frameCount = Math.round( duration * video.fps );
	for ( let frame = 0; frame <= frameCount; frame ++ ) {

		await page.screenshot( { path: path.join( frameDir, String( frame ).padStart( 5, '0' ) + '.jpg' ), type: 'jpeg', quality: 95 } );
		await page.evaluate( ( dt ) => window.__gift.step( dt ), 1 / video.fps );
		if ( frame % 60 === 0 ) process.stdout.write( '.' );

	}

	const file = `flight-${ leg.from }-${ leg.to }.mp4`;
	execFileSync( 'ffmpeg', [
		'-y', '-loglevel', 'error', '-framerate', String( video.fps ), '-i', path.join( frameDir, '%05d.jpg' ),
		'-c:v', 'libx264', '-preset', 'slow', '-crf', String( video.crf ), '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
		path.join( outDir, file ),
	] );
	fs.rmSync( frameDir, { recursive: true, force: true } );
	const id = `flight-${ leg.from }-${ leg.to }`;
	registerFile( id, file, 'video/mp4' );
	manifest.flights[ leg.from + '-' + leg.to ] = { video: id, duration: ( frameCount + 1 ) / video.fps };

}

// ===================== 主流程 =====================
async function openPage( width, height ) {

	const browser = await chromium.launch( { channel: 'chrome', headless: true } );
	const page = await ( await browser.newContext( { viewport: { width, height }, deviceScaleFactor: 1, offline: true } ) ).newPage();
	const problems = [];
	page.on( 'console', ( message ) => {

		if ( message.type() === 'error' ) problems.push( message.text() );

	} );
	page.on( 'pageerror', ( error ) => problems.push( error.message ) );
	await page.goto( pathToFileURL( distPath ).href + '?shot=1&bake=1&q=hi' );
	await page.evaluate( () => window.__gift.ready );
	await page.evaluate( () => window.__gift.start() );
	return { browser, page, problems };

}

const started = Date.now();
if ( bakePanoramas ) {

	const { browser, page, problems } = await openPage( panoramaConfig.faceSize, panoramaConfig.faceSize );
	for ( const key of locationKeys ) {

		const locationConfig = panoramaConfig.locations[ key ];
		if ( ! locationConfig ) throw new Error( 'config.panorama.locations 里没有 ' + key );
		const points = [];
		for ( let i = 0; i < locationConfig.points.length; i ++ ) {

			process.stdout.write( `烘 ${ key } 第 ${ i + 1 } 个点` );
			points.push( await bakePoint( page, key, i, locationConfig.points[ i ] ) );
			console.log( ' 好了' );

		}

		manifest.locations[ key ] = { points };

	}

	if ( problems.length ) console.log( '烘全景时页面报错：', problems );
	await browser.close();

}

if ( bakeFlights ) {

	const legs = config.world.legs.filter( ( leg ) => ! args.legs || String( args.legs ).split( ',' ).includes( leg.from + '-' + leg.to ) );
	const { browser, page, problems } = await openPage( panoramaConfig.video.width, panoramaConfig.video.height );
	for ( const leg of legs ) {

		process.stdout.write( `烘飞行 ${ leg.from } → ${ leg.to }` );
		await bakeFlight( page, leg );
		console.log( ' 好了' );

	}

	if ( problems.length ) console.log( '烘飞行时页面报错：', problems );
	await browser.close();

}

// 清单里只留实际存在的文件
manifest.files = manifest.files.filter( ( item ) => fs.existsSync( path.join( outDir, item.file ) ) );
fs.writeFileSync( manifestPath, JSON.stringify( manifest, null, '\t' ) + '\n' );
const totalBytes = manifest.files.reduce( ( sum, item ) => sum + item.bytes, 0 );
console.log( `清单写到 ${ path.relative( projectRoot, manifestPath ) }：${ manifest.files.length } 个文件，合计 ${ ( totalBytes / 1048576 ).toFixed( 1 ) } MB（内联成 base64 以后约 ${ ( totalBytes * 4 / 3 / 1048576 ).toFixed( 1 ) } MB），用时 ${ ( ( Date.now() - started ) / 60000 ).toFixed( 1 ) } 分钟` );
console.log( '记得再 npm run build 一次，素材才会进 dist/index.html' );
