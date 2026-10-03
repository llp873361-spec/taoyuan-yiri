// 树林布点的离线烘焙（规格书 §4：src/core/forest.js 的布点规则，Node 烘焙和浏览器兜底共用一份代码）。
// 布点要用到浏览器里才建得起来的东西（地表图、噪声贴图、烘焙地形的遮罩），所以直接在构建好的页面里跑一遍：
// 用本机 Chrome 打开 dist/index.html?shot=1 两次（hi 档、mid 档；hi 的候选格 9 米、其余 12 米），等远景建好，取 __gift.dumpForest()，
// gzip 以后写到 assets/opt/forest/，清单带指纹（配置一改指纹就变，页面上退回当场算并警告）。
// 用法：npx vite build && node scripts/bake-forest.mjs && npx vite build
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import fs from 'node:fs';

const outDir = path.resolve( 'assets/opt/forest' );
fs.mkdirSync( outDir, { recursive: true } );
const started = Date.now();
const browser = await chromium.launch( { channel: 'chrome', headless: true } );
const files = [];
let hash = null;
for ( const [ key, query ] of [ [ 'hi', 'q=hi' ], [ 'lo', 'q=mid' ] ] ) {

	const page = await ( await browser.newContext( { viewport: { width: 640, height: 360 }, offline: true } ) ).newPage();
	const problems = [];
	page.on( 'pageerror', ( error ) => problems.push( error.message ) );
	await page.goto( pathToFileURL( path.resolve( 'dist/index.html' ) ).href + '?shot=1&' + query );
	await page.evaluate( () => window.__gift.ready );
	await page.evaluate( () => window.__gift.start() );
	const dump = await page.evaluate( () => window.__gift.dumpForest() );
	if ( ! dump ) throw new Error( `树林布点：${ key } 档取不到树表（远景没建好？）${ problems.join( '；' ) }` );
	if ( dump.key !== key ) throw new Error( `树林布点：要的是 ${ key } 档，页面给的是 ${ dump.key } 档` );
	if ( hash && hash !== dump.hash ) throw new Error( `树林布点：两档的指纹不一样（${ hash } / ${ dump.hash }）` );
	hash = dump.hash;
	const raw = Buffer.from( dump.base64, 'base64' );
	const file = `forest-${ key }.f32.gz`;
	const packed = gzipSync( raw, { level: 9 } );
	fs.writeFileSync( path.join( outDir, file ), packed );
	files.push( { id: `forest-${ key }`, file, mime: 'application/gzip', bytes: packed.length, count: dump.count } );
	console.log( `树林布点 ${ key }：${ dump.count } 棵，${ ( raw.length / 1024 ).toFixed( 0 ) } KB → gzip ${ ( packed.length / 1024 ).toFixed( 0 ) } KB` );
	await page.close();

}

fs.writeFileSync( path.join( outDir, 'manifest.json' ), JSON.stringify( { note: '树林布点（scripts/bake-forest.mjs 生成）：每棵 10 个 32 位浮点 x、y、z、size、tint、yaw、cull、树种序号、变体、种类', hash, files }, null, '\t' ) );
console.log( `指纹 ${ hash }；用时 ${ ( ( Date.now() - started ) / 1000 ).toFixed( 1 ) } 秒。再跑一次 npx vite build 把它内联进去` );
await browser.close();
