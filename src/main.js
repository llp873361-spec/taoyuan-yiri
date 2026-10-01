// 入口：初始化渲染器和各模块、开场卡、主循环、键盘鼠标、结尾与致谢。流程见 reference/notes/design-stage0.md 第 1、10、11 节。

import './style.css';
import * as THREE from 'three/webgpu';
import config from './config.js';
import credits from '../assets/credits.json';
import { createRenderer } from './core/renderer.js';
import { createQuality } from './core/quality.js';
import { createPipeline } from './core/pipeline.js';
import { createDirector } from './core/camera.js';
import { createTimeline } from './core/timeline.js';
import { createAudio } from './core/audio.js';
import { createDebug } from './core/debug.js';
import * as garden from './scenes/garden.js';
import * as sunset from './scenes/sunset.js';
import * as gothic from './scenes/gothic.js';
import * as starry from './scenes/starry.js';
import * as aurora from './scenes/aurora.js';

const sceneModules = [ garden, sunset, gothic, starry, aurora ];

// ===== 收集 console 的 warn / error，截图脚本会读 window.__gift.logs =====
const logs = [];
for ( const level of [ 'warn', 'error' ] ) {

	const original = console[ level ].bind( console );
	console[ level ] = ( ...args ) => {

		logs.push( level + ': ' + args.map( ( item ) => ( item && item.stack ) ? item.stack : String( item ) ).join( ' ' ) );
		original( ...args );

	};

}

// ===== URL 参数 =====
const params = new URLSearchParams( location.search );
const forceWebGL = params.get( 'webgl' ) === '1';
const forcedTier = params.get( 'q' ) || '';
const debugEnabled = params.has( 'debug' );
const isShotMode = params.get( 'shot' ) === '1';

// ===== DOM =====
const elements = {
	canvasHost: document.getElementById( 'canvasHost' ),
	hud: document.getElementById( 'hud' ),
	cardBackdrop: document.getElementById( 'cardBackdrop' ),
	card: document.getElementById( 'card' ),
	cardTitle: document.getElementById( 'cardTitle' ),
	cardSubtitle: document.getElementById( 'cardSubtitle' ),
	cardStart: document.getElementById( 'cardStart' ),
	cardHints: document.getElementById( 'cardHints' ),
	cardProgress: document.getElementById( 'cardProgress' ),
	cardStatus: document.getElementById( 'cardStatus' ),
	ending: document.getElementById( 'ending' ),
	creditsButton: document.getElementById( 'creditsButton' ),
	creditsPanel: document.getElementById( 'creditsPanel' ),
	replayButton: document.getElementById( 'replayButton' ),
	fatal: document.getElementById( 'fatal' ),
	fatalMessage: document.getElementById( 'fatalMessage' ),
};

function showFatalPage( message ) {

	elements.fatalMessage.textContent = message;
	elements.fatal.classList.add( 'visible' );
	elements.hud.classList.add( 'hidden' );
	console.error( message );

}

// ===== window.__gift：截图脚本和手动调试用 =====
let resolveReady;
let rejectReady;
const gift = {
	ready: new Promise( ( resolve, reject ) => {

		resolveReady = resolve;
		rejectReady = reject;

	} ),
	logs,
	getConfig: () => config,
	start: null,
	jumpTo: null,
	step: null,
	settle: null,
	info: null,
};
window.__gift = gift;
// 没人接这个 Promise 的拒绝时别再多报一条错
gift.ready.catch( () => {} );

// ===== 开场卡文字 =====
function fillCard() {

	elements.cardTitle.textContent = config.openingTitle;
	elements.cardSubtitle.textContent = config.openingSubtitle || '';
	elements.cardStart.textContent = config.clickToStart;
	elements.cardHints.innerHTML = '';
	for ( const hint of config.openingHints ) {

		const item = document.createElement( 'li' );
		item.textContent = hint;
		elements.cardHints.appendChild( item );

	}

	elements.creditsButton.textContent = config.creditsLabel;
	elements.replayButton.textContent = config.replayLabel;

}

// ===== 柔光粒子进度 =====
const progressDots = 40;
let progressValue = 0;
let progressAnimation = null;

function drawProgress( timestamp ) {

	const canvas = elements.cardProgress;
	const context2d = canvas.getContext( '2d' );
	if ( ! context2d ) return;

	const width = canvas.width;
	const height = canvas.height;
	context2d.clearRect( 0, 0, width, height );

	const spacing = width / ( progressDots + 1 );
	for ( let i = 0; i < progressDots; i ++ ) {

		const x = spacing * ( i + 1 );
		const y = height / 2 + Math.sin( timestamp * 0.002 + i * 0.5 ) * 4;
		const lit = ( i + 1 ) / progressDots <= progressValue;
		const breathe = 0.7 + 0.3 * Math.sin( timestamp * 0.003 + i * 0.4 );
		const radius = lit ? 4 + breathe * 2 : 2;
		const alpha = lit ? 0.55 + 0.45 * breathe : 0.18;

		// 外圈柔光 + 内核
		const glow = context2d.createRadialGradient( x, y, 0, x, y, radius * 3 );
		glow.addColorStop( 0, `rgba(232, 180, 184, ${ alpha })` );
		glow.addColorStop( 1, 'rgba(232, 180, 184, 0)' );
		context2d.fillStyle = glow;
		context2d.beginPath();
		context2d.arc( x, y, radius * 3, 0, Math.PI * 2 );
		context2d.fill();

		context2d.fillStyle = `rgba(255, 244, 236, ${ alpha })`;
		context2d.beginPath();
		context2d.arc( x, y, radius * 0.6, 0, Math.PI * 2 );
		context2d.fill();

	}

	progressAnimation = requestAnimationFrame( drawProgress );

}

function setProgress( value, statusText ) {

	progressValue = Math.min( 1, Math.max( 0, value ) );
	if ( statusText !== undefined ) elements.cardStatus.textContent = statusText;

}

// ===== 主逻辑 =====
async function boot() {

	fillCard();

	if ( window.innerWidth <= 0 || window.innerHeight <= 0 ) {

		console.warn( `窗口尺寸为 ${ window.innerWidth }×${ window.innerHeight }，先按 1×1 初始化，等 resize 再修正` );

	}

	let rendererBundle;
	try {

		rendererBundle = await createRenderer( { forceWebGL } );

	} catch ( error ) {

		const reason = error && error.message ? error.message : String( error );
		const hint = forceWebGL
			? '这台电脑的浏览器打不开 WebGL2。请换最新版 Chrome 或 Edge，或者更新显卡驱动后再试。'
			: '这台电脑的浏览器既不支持 WebGPU 也打不开 WebGL2。请换最新版 Chrome 或 Edge，或者更新显卡驱动后再试。';
		showFatalPage( `${ hint }（${ reason }）` );
		rejectReady( new Error( reason ) );
		return;

	}

	const { renderer, backend, gpuName, timer } = rendererBundle;
	elements.canvasHost.appendChild( renderer.domElement );

	const camera = new THREE.PerspectiveCamera( config.camera.fov, Math.max( 1, window.innerWidth ) / Math.max( 1, window.innerHeight ), config.camera.near, config.camera.far );

	const ctx = {
		renderer,
		backend,
		gpuName,
		timer,
		camera,
		config,
		quality: null,
		pipeline: null,
		director: null,
		audio: null,
		debug: null,
		isShotMode,
	};

	ctx.quality = createQuality( ctx, forcedTier );
	ctx.pipeline = createPipeline( ctx );
	ctx.director = createDirector( ctx );
	ctx.audio = createAudio( ctx );
	ctx.debug = createDebug( ctx, debugEnabled );
	ctx.pipeline.registerDebug();
	ctx.pipeline.resize();

	const timeline = createTimeline( ctx, sceneModules );
	ctx.debug.setTimelineHooks( {
		getTime: timeline.getTime,
		getDuration: timeline.getDuration,
		seek: timeline.seek,
		pause: timeline.pause,
		resume: timeline.resume,
		togglePause: timeline.togglePause,
		jumpTo: timeline.jumpTo,
		getSceneList: timeline.getSceneList,
		getSceneIndex: timeline.getSceneIndex,
		isPaused: timeline.isPaused,
	} );

	// ===== 主循环 =====
	let lastFrameStart = performance.now();
	let started = false;

	function frame( manualDt ) {

		const frameStart = performance.now();
		const frameMs = frameStart - lastFrameStart;
		lastFrameStart = frameStart;

		timer.update();
		let dt;
		if ( typeof manualDt === 'number' ) {

			// 手动推进（截图脚本）给多少走多少
			dt = Math.max( 0, manualDt );

		} else {

			dt = timer.getDelta();
			if ( ! Number.isFinite( dt ) || dt < 0 ) dt = 0;
			if ( dt > 0.1 ) dt = 0.1;   // 切回标签页时不让一帧跳太远

		}

		if ( started ) {

			timeline.update( dt );
			updateEnding( dt );

		}

		ctx.director.update( dt );
		ctx.pipeline.render();
		if ( started && ! isShotMode ) ctx.quality.onFrame( frameMs );
		ctx.debug.onFrame();

	}

	// 基准测试时只画一帧（场景 1 还没进来之前画的是空场景，测的是管线开销）
	function renderOneFrame() {

		timer.update();
		ctx.director.update( 0 );
		ctx.pipeline.render();

	}

	// ===== 结尾：按时间线的时间累计，暂停时跟着停 =====
	let endingElapsed = - 1;   // -1 表示还没到结尾

	function showEnding() {

		endingElapsed = 0;
		elements.ending.textContent = config.endingText || '';

	}

	function updateEnding( dt ) {

		if ( endingElapsed < 0 || timeline.state.paused ) return;
		endingElapsed += dt;

		const endingConfig = config.ending;
		if ( endingElapsed >= endingConfig.textDelay ) {

			elements.ending.classList.add( 'visible' );
			elements.replayButton.classList.add( 'visible' );

		}

		if ( endingElapsed >= endingConfig.textDelay + endingConfig.creditsDelay ) {

			elements.creditsButton.classList.add( 'visible' );

		}

	}

	function hideEnding() {

		endingElapsed = - 1;
		elements.ending.classList.remove( 'visible' );
		elements.creditsButton.classList.remove( 'visible' );
		elements.replayButton.classList.remove( 'visible' );
		elements.creditsPanel.classList.remove( 'visible' );

	}

	function fillCredits() {

		const items = ( credits && Array.isArray( credits.items ) ) ? credits.items : [];
		const panel = elements.creditsPanel;
		panel.innerHTML = '';
		const title = document.createElement( 'h3' );
		title.textContent = config.creditsLabel;
		panel.appendChild( title );

		const list = document.createElement( 'ul' );
		if ( items.length === 0 ) {

			const item = document.createElement( 'li' );
			item.textContent = '这一版全部是程序生成的画面，没有用到外部素材。';
			list.appendChild( item );

		}

		for ( const entry of items ) {

			const item = document.createElement( 'li' );
			const name = document.createElement( 'div' );
			name.textContent = `${ entry.title || '' }　${ entry.author ? '· ' + entry.author : '' }`;
			const meta = document.createElement( 'span' );
			meta.textContent = `${ entry.license || '' }　${ entry.url || '' }`;
			item.appendChild( name );
			item.appendChild( meta );
			list.appendChild( item );

		}

		panel.appendChild( list );

	}

	timeline.onEnd( showEnding );

	elements.creditsButton.addEventListener( 'click', () => {

		fillCredits();
		elements.creditsPanel.classList.toggle( 'visible' );

	} );

	elements.replayButton.addEventListener( 'click', () => {

		hideEnding();
		timeline.restart().catch( ( error ) => {

			console.error( '再走一遍失败：', error );

		} );

	} );

	// ===== 开场点击 =====
	let starting = false;

	async function startExperience() {

		if ( starting || started ) return;
		starting = true;
		elements.cardStart.disabled = true;

		// 必须在用户手势的同步阶段做：解锁音频、请求全屏
		ctx.audio.unlock();
		if ( ! isShotMode ) {

			requestFullscreenSafe();

		}

		elements.cardProgress.classList.add( 'visible' );
		progressAnimation = requestAnimationFrame( drawProgress );
		setProgress( 0.05, '正在准备' );

		try {

			if ( ! isShotMode ) {

				setProgress( 0.15, '正在测试显卡' );
				await ctx.quality.runBenchmark( renderOneFrame );

			}

			setProgress( 0.35, '正在布置第一个场景' );
			await timeline.prepareFirst();
			setProgress( 1, '' );

		} catch ( error ) {

			const reason = error && error.message ? error.message : String( error );
			showFatalPage( `场景初始化失败：${ reason }` );
			return;

		}

		// 进度条亮满后再淡出卡片
		await new Promise( ( resolve ) => setTimeout( resolve, isShotMode ? 0 : 500 ) );
		elements.card.classList.add( 'fadeOut' );
		elements.cardBackdrop.classList.add( 'fadeOut' );
		if ( progressAnimation !== null ) {

			cancelAnimationFrame( progressAnimation );
			progressAnimation = null;

		}

		timeline.start();
		started = true;

		if ( ! isShotMode ) {

			renderer.setAnimationLoop( () => frame() );

		}

		console.log( '开始播放' );

	}

	elements.cardStart.addEventListener( 'click', () => {

		startExperience().catch( ( error ) => {

			showFatalPage( `启动失败：${ error && error.message ? error.message : error }` );

		} );

	} );

	// ===== 全屏 =====
	function requestFullscreenSafe() {

		const root = document.documentElement;
		if ( ! root.requestFullscreen ) {

			console.warn( '这个浏览器不支持全屏接口' );
			return;

		}

		root.requestFullscreen().catch( ( error ) => {

			console.warn( '进入全屏失败（可以按 F 再试）：', error && error.message ? error.message : error );

		} );

	}

	function toggleFullscreen() {

		if ( document.fullscreenElement ) {

			document.exitFullscreen().catch( () => {} );

		} else {

			requestFullscreenSafe();

		}

	}

	// ===== 键盘 =====
	let hudHidden = false;

	window.addEventListener( 'keydown', ( event ) => {

		if ( event.repeat ) return;
		const keyName = event.key.toLowerCase();

		if ( keyName === ' ' ) {

			event.preventDefault();
			if ( started ) timeline.togglePause();

		} else if ( keyName === 'arrowleft' || keyName === 'arrowright' ) {

			event.preventDefault();
			if ( ! started ) return;
			const delta = keyName === 'arrowleft' ? - 1 : 1;
			const target = timeline.getSceneIndex() + delta;
			if ( target < 0 || target >= config.scenes.length ) return;
			hideEnding();
			timeline.jumpTo( target, 0 ).catch( ( error ) => console.error( '跳转场景失败：', error ) );

		} else if ( keyName === 'f' ) {

			toggleFullscreen();

		} else if ( keyName === 'h' ) {

			hudHidden = ! hudHidden;
			elements.hud.classList.toggle( 'hidden', hudHidden );
			ctx.debug.setVisible( ! hudHidden );

		}

	} );

	// ===== 鼠标不动就藏光标 =====
	let cursorTimer = null;

	function onMouseActivity() {

		document.body.classList.remove( 'cursorHidden' );
		if ( cursorTimer !== null ) clearTimeout( cursorTimer );
		cursorTimer = setTimeout( () => {

			if ( started ) document.body.classList.add( 'cursorHidden' );

		}, config.camera.idleCursorHide * 1000 );

	}

	window.addEventListener( 'mousemove', onMouseActivity );
	onMouseActivity();

	// ===== resize =====
	window.addEventListener( 'resize', () => {

		if ( window.innerWidth <= 0 || window.innerHeight <= 0 ) {

			console.warn( `窗口尺寸为 ${ window.innerWidth }×${ window.innerHeight }，忽略这次 resize` );
			return;

		}

		ctx.pipeline.resize();

	} );

	// ===== 截图脚本接口 =====
	gift.start = () => startExperience();
	gift.jumpTo = async ( index, time = 0 ) => {

		if ( ! started ) throw new Error( '还没 start' );
		hideEnding();
		return timeline.jumpTo( index, time );

	};
	gift.step = async ( dt = 1 / 60 ) => {

		frame( dt );
		// 等一帧真实的 rAF 再返回：后台的着色器异步编译要真实时间推进，否则连续推进会把它甩在后面
		await new Promise( ( resolve ) => requestAnimationFrame( resolve ) );
		return true;

	};
	// 等后台预加载都结束，取内存快照才稳定
	gift.settle = () => timeline.waitIdle();
	gift.info = () => {

		const info = renderer.info;
		return {
			backend,
			gpuName,
			tier: ctx.quality.tier,
			renderScale: ctx.quality.renderScale,
			sceneKey: timeline.getSceneKey(),
			sceneIndex: timeline.getSceneIndex(),
			sceneTime: timeline.getTime(),
			phase: timeline.state.phase,
			paused: timeline.state.paused,
			transitionTime: timeline.state.transitionTime,
			loadStates: timeline.getLoadStates(),
			geometries: info.memory.geometries,
			textures: info.memory.textures,
			renderTargets: info.memory.renderTargets,
			programs: info.memory.programs,
			drawCalls: info.render.drawCalls,
		};

	};

	resolveReady( { backend, gpuName, tier: ctx.quality.tier } );

	console.log( `准备就绪：${ backend === 'webgpu' ? 'WebGPU' : 'WebGL2' }，档位 ${ ctx.quality.tier }${ isShotMode ? '，截图模式' : '' }` );

}

boot().catch( ( error ) => {

	showFatalPage( `启动出错：${ error && error.message ? error.message : error }` );
	rejectReady( error );

} );
