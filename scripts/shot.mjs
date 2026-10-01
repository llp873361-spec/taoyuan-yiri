// Playwright 自动截图验收：用本机 Chrome 无头打开 dist/index.html（file://、断网），
// 按 config.scenes 里每个场景的 shots 时间点手动推进时间、截图，顺便收集控制台错误、外部请求、renderer.info 泄漏。
// 用法见 printHelp()。页面侧接口 window.__gift 由 src/main.js 提供（契约第 1 节第 7 条）。

import { chromium } from 'playwright';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';

const projectRoot = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const distPath = path.join( projectRoot, 'dist', 'index.html' );

// 每一步 evaluate 的超时（毫秒）
const stepTimeoutMs = 60000;
// jpeg 粗检：quality 50 的 1920×1080 截图小于这个字节数就视为可疑纯色
const suspiciousJpegBytes = 15 * 1024;
// 泄漏检查里要对比的 renderer.info 字段
const leakFields = [ 'geometries', 'textures', 'renderTargets', 'programs' ];

function printHelp() {
	console.log( [
		'用法：node scripts/shot.mjs [选项]',
		'',
		'  --backend=webgpu|webgl|both   要截的后端，默认 both',
		'  --scene=key                   只截一个场景（key 见 src/config.js 的 scenes），泄漏检查仍跑全部场景',
		'  --out=目录                    截图输出目录，默认 shots',
		'  --software                    加 --use-angle=swiftshader 模拟没显卡的机器（WebGPU 会自动退回 WebGL2）',
		'  --help                        打印这段',
		'',
		'输出：<out>/<backend>/<场景key>_<秒>s.png 和 <out>/report.json；',
		'任何 console error / pageerror / 外部请求 / 泄漏 → 退出码 1；warning 只列出不致命。',
	].join( '\n' ) );
}

function parseArgs( argv ) {
	const options = { backend: 'both', scene: '', out: 'shots', software: false, help: false };
	for ( const arg of argv ) {
		if ( arg === '--help' || arg === '-h' ) options.help = true;
		else if ( arg === '--software' ) options.software = true;
		else if ( arg.startsWith( '--backend=' ) ) options.backend = arg.slice( '--backend='.length );
		else if ( arg.startsWith( '--scene=' ) ) options.scene = arg.slice( '--scene='.length );
		else if ( arg.startsWith( '--out=' ) ) options.out = arg.slice( '--out='.length );
		else {
			console.error( '不认识的参数：' + arg );
			printHelp();
			process.exit( 1 );
		}
	}
	if ( ! [ 'webgpu', 'webgl', 'both' ].includes( options.backend ) ) {
		console.error( '--backend 只能是 webgpu、webgl、both，收到：' + options.backend );
		process.exit( 1 );
	}
	return options;
}

// 给任意 Promise 加超时；evaluate 本身没有 timeout 选项
function withTimeout( promise, label ) {
	let timer;
	const timeout = new Promise( ( _, reject ) => {
		timer = setTimeout( () => reject( new Error( label + ' 超过 ' + ( stepTimeoutMs / 1000 ) + ' 秒没有返回' ) ), stepTimeoutMs );
	} );
	return Promise.race( [ promise, timeout ] ).finally( () => clearTimeout( timer ) );
}

// 页面里调 __gift 的某个方法；返回 Promise 时 Playwright 会自动等它
function callGift( page, method, args, label ) {
	return withTimeout( page.evaluate( ( [ methodName, callArgs ] ) => window.__gift[ methodName ]( ...callArgs ), [ method, args ] ), label || ( '__gift.' + method ) );
}

function formatTime( seconds ) {
	return String( seconds ).replace( /\./g, 'p' );
}

async function shootBackend( requested, options ) {
	const result = {
		requested,
		backend: '',
		gpuName: '',
		tier: '',
		query: requested === 'webgl' ? '?shot=1&webgl=1' : '?shot=1',
		shots: [],
		warnings: [],
		errors: [],
		pageErrors: [],
		externalRequests: [],
		consoleAll: [],
		pageLogs: [],
		leak: { round1: null, round2: null, leaked: [] },
		suspiciousShots: [],
		fatal: '',
	};

	const launchOptions = { channel: 'chrome', headless: true, args: [] };
	// 只有模拟没显卡时才加 swiftshader；不要加 --enable-features=*（会覆盖 Playwright 自己的 CDPScreenshotNewSurface，截图变慢）
	if ( options.software ) launchOptions.args.push( '--use-angle=swiftshader' );

	let browser;
	try {
		browser = await chromium.launch( launchOptions );
	} catch ( error ) {
		result.fatal = '启动本机 Chrome 失败（需要装了 Chrome，channel=chrome）：' + error.message;
		return result;
	}

	const outDir = path.join( options.out, requested );
	fs.mkdirSync( outDir, { recursive: true } );

	try {
		// offline: true 切断 http/https，file:// 和 data:/blob: 不受影响（笔记第 4 节）
		const context = await browser.newContext( { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, offline: true } );
		const page = await context.newPage();

		page.on( 'console', ( message ) => {
			const entry = { type: message.type(), text: message.text() };
			result.consoleAll.push( entry );
			if ( entry.type === 'warning' ) result.warnings.push( entry.text );
			else if ( entry.type === 'error' ) result.errors.push( entry.text );
		} );
		page.on( 'pageerror', ( error ) => result.pageErrors.push( error.message ) );
		page.on( 'request', ( request ) => {
			// 离线礼物不许联网，任何 http(s) 请求都算违规
			if ( /^https?:/i.test( request.url() ) ) result.externalRequests.push( request.url() );
		} );

		const url = pathToFileURL( distPath ).href + result.query;
		await page.goto( url, { timeout: stepTimeoutMs } );

		// 等 main.js 把 __gift 挂上来，再等 ready 这个 Promise
		await page.waitForFunction( () => window.__gift && window.__gift.ready, null, { timeout: stepTimeoutMs } );
		const ready = await withTimeout( page.evaluate( () => window.__gift.ready ), '__gift.ready' );
		result.backend = ready.backend;
		result.gpuName = ready.gpuName;
		result.tier = ready.tier;
		console.log( '[' + requested + '] 渲染器就绪：后端 ' + ready.backend + '，显卡 ' + ready.gpuName + '，档位 ' + ready.tier );

		if ( requested === 'webgpu' && ready.backend !== 'webgpu' ) {
			result.warnings.push( '要求 webgpu 但实际后端是 ' + ready.backend + ( options.software ? '（--software 下这是预期的兜底）' : '' ) );
		}
		if ( requested === 'webgl' && ready.backend !== 'webgl2' ) {
			result.errors.push( '?webgl=1 下实际后端应是 webgl2，拿到的是 ' + ready.backend );
		}

		await callGift( page, 'start', [], '__gift.start()' );

		const config = await withTimeout( page.evaluate( () => window.__gift.getConfig() ), '__gift.getConfig()' );
		const scenes = config.scenes;
		if ( ! Array.isArray( scenes ) || scenes.length === 0 ) throw new Error( 'config.scenes 为空，没东西可截' );

		let targets = scenes.map( ( scene, index ) => ( { index, key: scene.key, shots: scene.shots || [] } ) );
		if ( options.scene ) {
			targets = targets.filter( ( target ) => target.key === options.scene );
			if ( targets.length === 0 ) throw new Error( '没有 key 为 ' + options.scene + ' 的场景，可选：' + scenes.map( ( scene ) => scene.key ).join( ', ' ) );
		}

		// 逐场景逐时间点截图
		for ( const target of targets ) {
			for ( const seconds of target.shots ) {
				const startedAt = Date.now();
				await callGift( page, 'jumpTo', [ target.index, seconds ], '__gift.jumpTo(' + target.index + ', ' + seconds + ')' );
				await callGift( page, 'step', [ 1 / 60 ], '__gift.step' );
				await callGift( page, 'step', [ 1 / 60 ], '__gift.step' );
				const fileName = target.key + '_' + formatTime( seconds ) + 's.png';
				const filePath = path.join( outDir, fileName );
				await page.screenshot( { path: filePath, type: 'png' } );
				// 粗检纯色：低质量 jpeg 太小说明画面几乎没有内容
				const jpegBuffer = await page.screenshot( { type: 'jpeg', quality: 50 } );
				const suspicious = jpegBuffer.length < suspiciousJpegBytes;
				const entry = { scene: target.key, time: seconds, path: filePath, ms: Date.now() - startedAt, jpegBytes: jpegBuffer.length, suspicious };
				result.shots.push( entry );
				if ( suspicious ) result.suspiciousShots.push( filePath );
				console.log( '[' + requested + '] ' + fileName + '  ' + entry.ms + ' ms' + ( suspicious ? '  （可疑：画面几乎纯色，jpeg 只有 ' + jpegBuffer.length + ' 字节）' : '' ) );
			}
		}

		// 泄漏检查：五个场景按顺序走三轮，第一轮是热身（有些贴图/渲染目标首次用到才创建），第三轮任一项高于第二轮就算泄漏
		const rounds = [];
		for ( let round = 0; round < 3; round ++ ) {
			for ( let i = 0; i < scenes.length; i ++ ) {
				await callGift( page, 'jumpTo', [ i, 0 ], '泄漏检查 jumpTo(' + i + ')' );
				await callGift( page, 'step', [ 1 / 60 ], '泄漏检查 step' );
				await callGift( page, 'step', [ 1 / 60 ], '泄漏检查 step' );
			}
			// 先等后台预加载结束再取快照，否则数字随机器快慢抖动
			await callGift( page, 'settle', [], '泄漏检查 settle' );
			await callGift( page, 'step', [ 1 / 60 ], '泄漏检查 step' );
			const info = await withTimeout( page.evaluate( () => window.__gift.info() ), '__gift.info()' );
			const snapshot = {};
			for ( const field of leakFields ) snapshot[ field ] = info[ field ];
			rounds.push( snapshot );
			console.log( '[' + requested + '] 泄漏检查第 ' + ( round + 1 ) + ' 轮：' + leakFields.map( ( field ) => field + '=' + snapshot[ field ] ).join( ' ' ) );
		}
		result.leak.round1 = rounds[ 1 ];
		result.leak.round2 = rounds[ 2 ];
		for ( const field of leakFields ) {
			const first = rounds[ 1 ][ field ];
			const second = rounds[ 2 ][ field ];
			if ( typeof first !== 'number' || typeof second !== 'number' ) {
				result.warnings.push( '__gift.info() 没有给出数值型的 ' + field + '，泄漏检查跳过这一项' );
				continue;
			}
			if ( second > first ) result.leak.leaked.push( field + '：' + first + ' → ' + second );
		}

		// 页面自己收的 console.error / console.warn 文本，和 Playwright 这边的互相印证
		result.pageLogs = await withTimeout( page.evaluate( () => Array.isArray( window.__gift.logs ) ? window.__gift.logs.map( ( item ) => String( item ) ) : [] ), '__gift.logs' );

		await context.close();
	} catch ( error ) {
		result.fatal = error.message;
	} finally {
		await browser.close();
	}
	return result;
}

function summarize( backendResult ) {
	const tag = '[' + backendResult.requested + ']';
	if ( backendResult.fatal ) console.log( tag + ' 中途失败：' + backendResult.fatal );
	console.log( tag + ' 截图 ' + backendResult.shots.length + ' 张，warning ' + backendResult.warnings.length + ' 条，error ' + backendResult.errors.length + ' 条，pageerror ' + backendResult.pageErrors.length + ' 条，外部请求 ' + backendResult.externalRequests.length + ' 条，泄漏 ' + backendResult.leak.leaked.length + ' 项，可疑纯色图 ' + backendResult.suspiciousShots.length + ' 张' );
	for ( const text of backendResult.warnings ) console.log( tag + '   warning：' + text );
	for ( const text of backendResult.errors ) console.log( tag + '   error：' + text );
	for ( const text of backendResult.pageErrors ) console.log( tag + '   pageerror：' + text );
	for ( const text of backendResult.externalRequests ) console.log( tag + '   外部请求：' + text );
	for ( const text of backendResult.leak.leaked ) console.log( tag + '   泄漏：' + text );
	for ( const text of backendResult.suspiciousShots ) console.log( tag + '   可疑纯色：' + text );
}

function hasFailure( backendResult ) {
	return Boolean( backendResult.fatal )
		|| backendResult.errors.length > 0
		|| backendResult.pageErrors.length > 0
		|| backendResult.externalRequests.length > 0
		|| backendResult.leak.leaked.length > 0;
}

async function main() {
	const options = parseArgs( process.argv.slice( 2 ) );
	if ( options.help ) {
		printHelp();
		return 0;
	}
	if ( ! fs.existsSync( distPath ) ) {
		console.error( '找不到 ' + distPath + '，先跑 npm run build 再截图' );
		return 1;
	}
	options.out = path.resolve( projectRoot, options.out );
	fs.mkdirSync( options.out, { recursive: true } );

	const backends = options.backend === 'both' ? [ 'webgpu', 'webgl' ] : [ options.backend ];
	const report = {
		time: new Date().toISOString(),
		dist: distPath,
		options,
		backends: [],
		ok: true,
	};

	for ( const requested of backends ) {
		console.log( '===== 开始截 ' + requested + ( options.software ? '（软件渲染）' : '' ) + ' =====' );
		const backendResult = await shootBackend( requested, options );
		report.backends.push( backendResult );
		summarize( backendResult );
		if ( hasFailure( backendResult ) ) report.ok = false;
	}

	const reportPath = path.join( options.out, 'report.json' );
	fs.writeFileSync( reportPath, JSON.stringify( report, null, '\t' ) );
	console.log( '报告写到 ' + reportPath );
	console.log( report.ok ? '验收通过（warning 请人工过目）' : '验收不通过，见上面的 error / pageerror / 外部请求 / 泄漏' );
	return report.ok ? 0 : 1;
}

main().then( ( code ) => {
	process.exit( code );
}, ( error ) => {
	console.error( '截图脚本异常退出：' + ( error && error.stack || error ) );
	process.exit( 1 );
} );
