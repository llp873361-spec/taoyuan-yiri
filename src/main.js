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
import { createWorld, directionFromAngles } from './core/world.js';
import * as backdrop from './scenes/backdrop.js';
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
const worldMode = params.get( 'world' ) === '1';   // 秘境俯瞰：只看常驻远景（规格书 6.3）

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
	pause: null,
	resume: null,
	getViews: null,
	setView: null,
	setPose: null,
	getLayers: null,
	setLayer: null,
	info: null,
	setDayTime: null,
	setWorldView: null,
	getWorldLocations: null,
	setCameraRange: null,
	setCompression: null,
	measureGpu: null,
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

		rendererBundle = await createRenderer( { forceWebGL, trackTimestamp: ! isShotMode } );

	} catch ( error ) {

		const reason = error && error.message ? error.message : String( error );
		const hint = forceWebGL
			? '这台电脑的浏览器打不开 WebGL2。请换最新版 Chrome 或 Edge，或者更新显卡驱动后再试。'
			: '这台电脑的浏览器既不支持 WebGPU 也打不开 WebGL2。请换最新版 Chrome 或 Edge，或者更新显卡驱动后再试。';
		showFatalPage( `${ hint }（${ reason }）` );
		rejectReady( new Error( reason ) );
		return;

	}

	const { renderer, backend, gpuName, timer, gpuTiming } = rendererBundle;
	elements.canvasHost.appendChild( renderer.domElement );

	const camera = new THREE.PerspectiveCamera( config.camera.fov, Math.max( 1, window.innerWidth ) / Math.max( 1, window.innerHeight ), config.camera.near, config.camera.far );

	const ctx = {
		renderer,
		backend,
		gpuName,
		timer,
		gpuTiming,
		camera,
		config,
		quality: null,
		pipeline: null,
		director: null,
		audio: null,
		debug: null,
		world: null,
		isShotMode,
	};

	ctx.world = createWorld( config );
	ctx.quality = createQuality( ctx, forcedTier );
	ctx.pipeline = createPipeline( ctx );
	ctx.director = createDirector( ctx );
	ctx.audio = createAudio( ctx );
	// 俯瞰模式默认带调试面板（时刻滑条、跳地点）；截图模式下不要，免得挡住画面
	ctx.debug = createDebug( ctx, debugEnabled || ( worldMode && ! isShotMode ) );
	ctx.pipeline.registerDebug();
	ctx.pipeline.resize();

	const timeline = createTimeline( ctx, sceneModules );
	if ( ! worldMode ) ctx.debug.setTimelineHooks( {
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
		if ( overview ) overview.update( dt );
		ctx.pipeline.render();
		// 每帧都结算显卡时间戳（开场卡阶段也要，不然查询一直攒着）
		if ( ! isShotMode ) ctx.quality.afterRender();
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

	// ===== 秘境俯瞰（?world=1）：只看常驻远景，自由飞行，拖时刻滑条，跳到各地点 =====
	const overviewConfig = config.world.overview;
	let overview = null;

	// 地点的眼睛位置：原点高度和"地面 + 1.7 米"取高的（哥特、星月夜的原点本身就是机位高度），朝 yaw 方向略微抬头。
	// 地面按远景网格画出来的高度算（远景还没建好时用解析高度）：网格 12.5 米一格，按解析高度算有时会钻到网格下面
	function locationView( key ) {

		const location = ctx.world.locations[ key ];
		const [ x, y, z ] = location.origin;
		const meshGround = backdrop.getTerrainHeight( x, z );
		const ground = Number.isFinite( meshGround ) ? meshGround : ctx.world.worldHeight( x, z );
		const eyeY = Math.max( y, ground + 1.7 );
		const direction = directionFromAngles( location.yaw, 2, new THREE.Vector3() );
		return {
			key,
			name: location.name,
			origin: location.origin,
			yaw: location.yaw,
			landmark: location.landmark || null,
			time: overviewConfig.locationTimes[ key ],
			position: [ x, eyeY, z ],
			lookAt: [ x + direction.x * 100, eyeY + direction.y * 100, z + direction.z * 100 ],
		};

	}

	async function startOverview() {

		elements.card.classList.add( 'fadeOut' );
		elements.cardBackdrop.classList.add( 'fadeOut' );
		camera.near = overviewConfig.near;
		camera.far = overviewConfig.far;
		camera.updateProjectionMatrix();

		ctx.world.setDayTime( overviewConfig.startTime );
		const overviewBuildStart = performance.now();
		const result = await backdrop.init( ctx );
		await renderer.compileAsync( result.scene, camera );
		backdrop.enter();
		ctx.pipeline.setScene( result.scene );
		ctx.pipeline.setGrading( overviewConfig.grading );

		ctx.director.setFreeSpeed( overviewConfig.moveSpeed );
		ctx.director.freeMode = true;
		ctx.director.setFreePose( overviewConfig.aerial.position, overviewConfig.aerial.lookAt );

		overview = {
			time: 0,
			daySpeed: 0,   // 时刻流速（小时/秒），0 = 停住
			update( dt ) {

				this.time += dt;
				if ( this.daySpeed !== 0 ) ctx.world.setDayTime( ctx.world.getDayTime() + this.daySpeed * dt );
				backdrop.update( dt, this.time );
				// 俯瞰时的自动曝光：夜里天光弱，按天空亮度把曝光抬起来（4b 起飞行途中用两个地点的调色插值）
				const intensity = ctx.world.uniforms.skyIntensity.value;
				ctx.pipeline.grading.exposure.value = overviewConfig.grading.exposure / ( 0.4 + 0.6 * Math.pow( intensity, 0.7 ) );

			},
		};

		for ( const [ label, target ] of Object.entries( backdrop.getLayers() ) ) ctx.debug.addLayerToggle( '远景', label, target );

		ctx.debug.addWorldControls( {
			getDayTime: () => ctx.world.getDayTime(),
			setDayTime: ( hours ) => ctx.world.setDayTime( hours ),
			setDaySpeed: ( speed ) => {

				overview.daySpeed = speed;

			},
			getLocations: () => Object.keys( ctx.world.locations ).map( locationView ),
			jumpToLocation: ( key ) => {

				const view = locationView( key );
				ctx.world.setDayTime( view.time );
				ctx.director.setFreePose( view.position, view.lookAt );

			},
			showAerial: () => ctx.director.setFreePose( overviewConfig.aerial.position, overviewConfig.aerial.lookAt ),
			showMap: () => ctx.director.setFreePose( overviewConfig.map.position, overviewConfig.map.lookAt ),
		} );

		if ( ! isShotMode ) renderer.setAnimationLoop( () => frame() );
		console.log( `秘境俯瞰：远景准备好了，用时 ${ ( performance.now() - overviewBuildStart ).toFixed( 0 ) } ms。WASD 飞、QE 升降、Shift 加速、按住左键转头` );

	}

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
	// 截图对比用：冻结 / 恢复时间（冻结后照样渲染）
	gift.pause = () => {

		timeline.pause();
		return true;

	};
	gift.resume = () => {

		timeline.resume();
		return true;

	};
	// 等后台预加载都结束，取内存快照才稳定
	gift.settle = () => timeline.waitIdle();
	// 当前场景的截图机位（自由漫游的场景才有）
	gift.getViews = () => {

		const module = timeline.getCurrentModule();
		if ( ! module || typeof module.getShotViews !== 'function' ) return [];
		return module.getShotViews().map( ( view ) => view.name );

	};
	gift.setView = ( name ) => {

		const module = timeline.getCurrentModule();
		const views = module && typeof module.getShotViews === 'function' ? module.getShotViews() : [];
		const view = views.find( ( item ) => item.name === name );
		if ( ! view ) throw new Error( `当前场景没有叫「${ name }」的机位` );
		if ( ! ctx.director.isWalking() ) throw new Error( '当前场景不是步行漫游，机位不生效' );
		ctx.director.setPose( view.position, view.lookAt );
		return true;

	};
	// 调试用：把步行的人放到任意位置（检查边界、找机位）
	gift.setPose = ( position, lookAt ) => {

		if ( ! ctx.director.isWalking() ) throw new Error( '当前场景不是步行漫游' );
		ctx.director.setPose( position, lookAt );
		return true;

	};
	// 当前场景的效果层：列出名字、单独开关（俯瞰模式下是远景的层）
	const layerModule = () => ( overview ? backdrop : timeline.getCurrentModule() );
	gift.getLayers = () => {

		const module = layerModule();
		return module && typeof module.getLayers === 'function' ? Object.keys( module.getLayers() ) : [];

	};
	gift.setLayer = ( label, enabled ) => {

		const module = layerModule();
		const layers = module && typeof module.getLayers === 'function' ? module.getLayers() : {};
		const target = layers[ label ];
		if ( target === undefined ) throw new Error( `当前场景没有叫「${ label }」的效果层` );
		if ( typeof target === 'function' ) target( Boolean( enabled ) );
		else target.value = enabled ? 1 : 0;
		return true;

	};
	// 秘境：设时刻、摆机位、列出地点、改相机远近裁剪面、远景深度压缩（只在俯瞰模式下有意义）
	gift.setDayTime = ( hours ) => {

		ctx.world.setDayTime( hours );
		if ( overview ) backdrop.update( 0, overview.time );
		return ctx.world.getDayTime();

	};
	gift.setWorldView = ( position, lookAt ) => {

		if ( ! overview ) throw new Error( '不在秘境俯瞰模式（?world=1）' );
		ctx.director.setFreePose( position, lookAt );
		return true;

	};
	gift.getWorldLocations = () => Object.keys( ctx.world.locations ).map( locationView );
	gift.setCameraRange = ( near, far ) => {

		if ( ! Number.isFinite( near ) || ! Number.isFinite( far ) || near <= 0 || far <= near ) throw new Error( `setCameraRange 参数不对（near ${ near }、far ${ far }），要 0 < near < far` );
		camera.near = near;
		camera.far = far;
		camera.updateProjectionMatrix();
		return true;

	};
	gift.setCompression = ( start, end ) => backdrop.setCompression( start, end );
	// 性能探针用：连续 frameCount 帧，每帧等这一帧的显卡时间戳结算完再画下一帧（帧和帧不重叠，量的是一帧本身的显卡时间），
	// 返回中位数和最大值（毫秒）。显卡计时只在 WebGPU 上开（WebGL2 上关了，见 renderer.js）；没有时间戳返回 null
	gift.measureGpu = async ( frameCount = 60 ) => {

		if ( ! ctx.gpuTiming || isShotMode ) return null;
		const samples = [];
		for ( let i = 0; i < frameCount; i ++ ) {

			await new Promise( ( resolve ) => requestAnimationFrame( resolve ) );
			const duration = await renderer.resolveTimestampsAsync( 'render' ).catch( () => null );
			if ( typeof duration === 'number' && Number.isFinite( duration ) && duration > 0 ) samples.push( duration );

		}

		if ( samples.length === 0 ) return null;
		samples.sort( ( first, second ) => first - second );
		return { median: samples[ Math.floor( samples.length / 2 ) ], max: samples[ samples.length - 1 ], count: samples.length };

	};
	gift.info = () => {

		const info = renderer.info;
		return {
			backend,
			gpuName,
			tier: ctx.quality.tier,
			renderScale: ctx.quality.renderScale,
			gpuMs: ctx.quality.gpuMs,
			dayTime: ctx.world.getDayTime(),
			sceneKey: timeline.getSceneKey(),
			sceneIndex: timeline.getSceneIndex(),
			sceneTime: timeline.getTime(),
			phase: timeline.state.phase,
			paused: timeline.state.paused,
			transitionTime: timeline.state.transitionTime,
			loadStates: timeline.getLoadStates(),
			cameraPosition: camera.position.toArray().map( ( value ) => Math.round( value * 100 ) / 100 ),
			geometries: info.memory.geometries,
			textures: info.memory.textures,
			renderTargets: info.memory.renderTargets,
			programs: info.memory.programs,
			drawCalls: info.render.drawCalls,
		};

	};

	if ( worldMode ) await startOverview();

	resolveReady( { backend, gpuName, tier: ctx.quality.tier } );

	console.log( `准备就绪：${ backend === 'webgpu' ? 'WebGPU' : 'WebGL2' }，档位 ${ ctx.quality.tier }${ isShotMode ? '，截图模式' : '' }` );

}

boot().catch( ( error ) => {

	showFatalPage( `启动出错：${ error && error.message ? error.message : error }` );
	rejectReady( error );

} );
