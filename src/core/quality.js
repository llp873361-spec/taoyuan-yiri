// 画质：三种方式自动选（规格书 6.1）+ 动态分辨率。所有数字从 ctx.config.quality 读。
//
// 对外档位（tier）：
//   hi   实时原生：原生分辨率、最高画质参数；显卡吃紧时先变成"hi 加放大"（场景按 0.9 → 0.67 倍画，fsr1 放大回原生；
//        30 帧目标时 1 → 0.8 → … → 0.55）
//   mid  实时放大：画布像素比上限 1.25，场景按 0.77 → 0.5 倍画再用 fsr1 放大；效果参数用"低"那一列（content = 'lo'）
//   pano 全景：播放预烘焙的全景和飞行视频（阶段 6）；运行中换档（hi → mid、mid → pano、插电后升回去）只在下一次起飞时发生，不在地点中途硬切
// 内容参数档（content）：hi / mid / lo，对应 config.quality.tiers 和各场景按档位取的数组（网格分段、粒子数……）。
// 内容参数只在建场景时用：运行中降档只影响之后加载的地点，正在画的地点只改分辨率和后期链。
//
// 怎么判断：显卡名含软件渲染的字样、或者 WebGPU 报告是兜底适配器 → 直接 pano，不测；
// 其余跑基准测试：离屏 1280×720 的重负载着色器，预热后画 10 帧，每帧读回 1 个像素强制等显卡做完再计时（不被垂直同步卡住）；
// 第一帧超过 120 毫秒立即判 pano；倍数 r = 每帧时间 / 开发机基准值：r ≤ 12 → hi，r ≤ 25 → mid（config.quality.benchmark）。
// hi 里再按 r 定帧目标：r ≤ 2.5 按 60 帧（显卡预算 14 ms），其余（Iris Xe、780M、Arc 核显）按 30 帧（预算 27 ms、比例下限 0.55）。
// 显卡名只作先验：独显至少给 mid，基准测试没采到数据时按先验。拔着电源时测出来的时间按 batteryPenalty 加重（判定更保守），
// 插上电以后下一次起飞时可以升回去。
//
// 对外给场景用的：quality.renderScale（场景按画布的多少倍画）、quality.mode（'native' / 'upscale' / 'pano'，
// renderScale < 1 时是 'upscale'）、quality.frameTarget（60 / 30）、quality.budgetMs（每帧显卡时间预算）、quality.flying（飞行中）、
// quality.arriving（到达后飞行收尾还没完）。时间线在起飞、到达、飞行结束时分别调 onFlightStart、onArrival、onFlightEnd。
//
// 调试参数（地址栏）：?gpuSlow=7.5 模拟慢显卡（基准测试时间和每帧显卡时间都乘这个数，开发机上走一遍核显的判档和动态分辨率）；
// ?q=hi&dynamic=1 档位强制 hi，但动态分辨率、顶点压力照常（也跑基准测试，定帧目标）；?gpuTiming=0 不用显卡时间戳判断、
// 走帧间隔那条路（WebGPU 上测 WebGL2 的逻辑；配 ?gpuSlow 时帧间隔按模拟的显卡时间、对齐到刷新间隔的整数倍）；
// ?msaa=0 / ?msaa=4 场景 MSAA 采样数（研究用，见 config.post.msaaOffForSlowHi）。

import * as THREE from 'three/webgpu';
import { Fn, Loop, float, vec2, vec4, uv, sin, cos, fract, array, vertexIndex } from 'three/tsl';
import { fbm2D, voronoi2D } from '../tsl/noise.js';
import { safeSetSize } from './renderer.js';

const tierOrder = [ 'hi', 'mid', 'pano' ];

function isValidTier( tier ) {

	return tierOrder.includes( tier );

}

function tierRank( tier ) {

	return tierOrder.indexOf( tier );

}

// 等下一帧；页面隐藏时 rAF 不会触发，用 setTimeout 兜底避免基准测试卡死
function waitFrame( fallbackMs ) {

	return new Promise( ( resolve ) => {

		let settled = false;
		const timeoutId = setTimeout( () => {

			if ( settled ) return;
			settled = true;
			resolve( { timestamp: performance.now(), real: false } );

		}, fallbackMs );

		requestAnimationFrame( ( timestamp ) => {

			if ( settled ) return;
			settled = true;
			clearTimeout( timeoutId );
			resolve( { timestamp, real: true } );

		} );

	} );

}

function medianOf( values ) {

	const sorted = values.slice().sort( ( first, second ) => first - second );
	return sorted[ Math.floor( sorted.length / 2 ) ];

}

// 基准测试的重负载着色器：6 个八度的 fbm、两层 voronoi，再在一个 64 步的循环里每步再取一次 fbm（像体积步进；开发机上每帧约 3 毫秒，显卡的活比读回的开销大得多），
// 和场景里最重的那几种材质（雪、海面、极光）是一类活
function createBenchmarkPass() {

	const material = new THREE.NodeMaterial();
	material.name = '画质基准测试';
	material.fragmentNode = Fn( () => {

		const point = uv().mul( vec2( 16, 9 ) ).toVar();
		const total = fbm2D( point, 6 ).toVar();
		const cells = voronoi2D( point.mul( 3 ), float( 1 ), float( 1 ) );
		total.addAssign( cells.y.sub( cells.x ) );
		total.addAssign( voronoi2D( point.mul( 7.3 ).add( 1.7 ), float( 0.9 ), float( 1 ) ).x );
		Loop( 64, ( { i } ) => {

			const step = float( i ).mul( 0.37 );
			const offset = vec2( sin( step.add( total ) ), cos( step.mul( 1.3 ).sub( total ) ) );
			total.addAssign( fbm2D( point.add( offset ).mul( 1.7 ), 3 ).mul( 0.2 ) );

		} );
		return vec4( fract( total ), fract( total.mul( 1.37 ) ), fract( total.mul( 2.11 ) ), 1 );

	} )();
	// 全屏三角形的顶点固定写进材质（同 QuadMesh.render 临时换的那个）：按普通变换画，三角形正好落在正交相机的近平面上，WebGL2 会把它裁掉
	material.vertexNode = vec4( array( [ - 1.0, - 1.0, 3.0 ] ).element( vertexIndex ), array( [ 3.0, - 1.0, - 1.0 ] ).element( vertexIndex ), 0.0, 1.0 );
	const quad = new THREE.QuadMesh( material );
	quad.frustumCulled = false;
	const scene = new THREE.Scene();
	scene.add( quad );
	return { material, quad, scene };

}

export function createQuality( ctx, forcedTier ) {

	const qualityConfig = ctx.config.quality;
	const dynamicConfig = qualityConfig.dynamic;
	const slowTargetConfig = dynamicConfig.target30;
	const renderer = ctx.renderer;

	// 调试参数（见文件头）。主循环、截图脚本都不传，直接读地址栏
	const urlParams = typeof location !== 'undefined' ? new URLSearchParams( location.search ) : new URLSearchParams();
	const slowParam = urlParams.get( 'gpuSlow' );
	const slowValue = slowParam === null ? 1 : Number.parseFloat( slowParam );
	if ( slowParam !== null && ! ( slowValue >= 1 ) ) console.warn( `画质：?gpuSlow=${ slowParam } 不合法（要 ≥ 1 的数），按 1 处理` );
	const gpuSlow = slowValue >= 1 ? slowValue : 1;
	const forcedDynamic = urlParams.get( 'dynamic' ) === '1';
	const intervalOnly = urlParams.get( 'gpuTiming' ) === '0';
	const msaaParam = urlParams.get( 'msaa' );
	if ( msaaParam !== null && msaaParam !== '0' && msaaParam !== '4' ) console.warn( `画质：?msaa=${ msaaParam } 不合法（只接受 0 或 4），按默认处理` );

	// ?q=lo 是旧的写法，按 mid 处理
	const normalizedForced = forcedTier === 'lo' ? 'mid' : forcedTier;
	const forced = isValidTier( normalizedForced );
	if ( forcedTier !== undefined && forcedTier !== null && forcedTier !== '' && ! forced ) {

		console.warn( `画质参数 ?q=${ forcedTier } 不合法，只接受 hi / mid / pano，改为自动判断` );

	}

	// 档位强制时默认不动态调（截图、对比用）；?dynamic=1 时档位还是强制的，比例和顶点压力照常调
	const dynamicEnabled = ! forced || forcedDynamic;
	if ( gpuSlow > 1 ) console.log( `画质：?gpuSlow=${ gpuSlow }，模拟慢显卡：基准测试时间和每帧显卡时间都乘 ${ gpuSlow }` );
	if ( forced && forcedDynamic ) console.log( `画质：?q=${ normalizedForced }&dynamic=1，档位强制，动态分辨率照常` );

	const tierCallbacks = [];

	// 动态分辨率的连续计数
	let slowCount = 0;
	let fastCount = 0;
	let bottomWarned = false;
	let bottomLogged = false;      // hi 比例、顶点压力都到底了（只打一次）
	let scaleUntouched = true;     // 场景比例还是开局值（动态分辨率没动过）：窗口尺寸变了按像素预算重算
	let vertexBound = false;       // 上次降比例几乎没省下显卡时间：瓶颈在顶点，下一步先降顶点压力（到下一个地点清掉）
	let scaleCheck = null;         // 降比例以后的效果检查（有显卡计时）：{ beforeMs, beforeScale, afterScale, frames }
	let flightSaved = null;        // 起飞时记下的 { scale, pressure, untouched }：到达时恢复
	let lowFpsSince = null;        // hi → mid 判断：从什么时候起一直低于 tierDropFps 帧
	let lastGpuMs = 0;             // 最近一帧的显卡时间（乘过 gpuSlow）
	let pendingHiTarget = null;    // 插上电以后等起飞时换的 hi 帧目标
	const fpsWindow = [];          // 最近十几帧的帧间隔（hi → mid 判断用）
	const drawingSize = new THREE.Vector2();

	const quality = {
		tier: 'hi',
		content: 'hi',
		params: null,
		mode: 'native',          // native 原生链 / upscale 低分辨率 + fsr1 放大 / pano 全景
		renderScale: 1,          // 场景按画布的多少倍画（< 1 时走放大链）
		vertexPressure: 1,       // 顶点压力（1、0.8、0.6）：场景比例降到底还超预算时，草按这个比例变稀、林下半径跟着缩（只改实例数和 uniform，不重新编译）
		vertexPressureUsedAt: - Infinity,   // 最近一次有东西读顶点压力的时刻（草每帧写）：雪原、星月夜这种没有草的地方不降它，直接降档
		pendingTier: null,       // 等下一次起飞时才切的档位（hi → mid、降到 pano、插电后升回去）
		frameTarget: 60,         // 帧目标：hi 按基准测试定 60 / 30，mid 按 30（没有显卡计时时，帧间隔超过目标帧时长 1.2 倍才算慢）
		hiFrameTarget: 60,       // 基准测试给 hi 定的帧目标（换到 hi 时用）
		budgetMs: dynamicConfig.gpuBudgetMs.hi,   // 当前档位、帧目标下每帧显卡时间的预算
		flying: false,           // 飞行中（起飞到到达）：只降不升
		arriving: false,         // 到达以后、飞行收尾还没完（出窄处、画布蔓延那几秒）：负载还在变，不算进 hi → mid 和顶点瓶颈的判断
		sceneSamples: renderer.samples,   // 场景目标的 MSAA 采样数（开场卡判完档、预编译之前由 main 交给 pipeline.setSceneSamples）
		gpuSlow,
		gpuMs: 0,
		gpuSamples: [],
		benchmark: null,         // { firstMs, medianMs, ratio, tier, unpenalizedTier, unpenalizedTarget, reason }
		onBattery: false,
		software: false,         // 软件渲染（SwiftShader 之类）：全景档的实时叠加再省一档
		detectInitialTier,
		runBenchmark,
		onFrame,
		afterRender,
		applyResolution,
		setTier,
		onTierChange,
		onDeparture,
		onFlightStart,
		onArrival,
		onFlightEnd,
	};

	// ===================== 档位和分辨率 =====================

	function contentOf( tier ) {

		return qualityConfig.tierContent[ tier ] || 'lo';

	}

	// hi 档 30 帧目标（核显）
	function isSlowTarget() {

		return quality.tier === 'hi' && quality.frameTarget === 30;

	}

	// 这一档的场景比例范围 [最小, 最大]；30 帧目标的 hi 下限放到 0.55（核显靠放大撑住，不降到 mid）
	function scaleRangeOf( tier ) {

		const range = qualityConfig.sceneScale[ tier ];
		if ( ! range ) return [ 1, 1 ];
		if ( tier === 'hi' && quality.frameTarget === 30 ) return [ slowTargetConfig.minScale, range[ 1 ] ];
		return range;

	}

	function updateBudget() {

		quality.budgetMs = isSlowTarget() ? slowTargetConfig.budgetMs : ( dynamicConfig.gpuBudgetMs[ quality.tier ] || dynamicConfig.gpuBudgetMs.mid );

	}

	// 开局的场景比例：30 帧目标时按场景像素预算（1920×1200 ≈ 2.3 MP）定，2560×1600 的高分屏开局就是 0.75，不用等动态分辨率一格格降；其余用这一档的最高比例
	function initialScale() {

		const [ minScale, maxScale ] = scaleRangeOf( quality.tier );
		if ( ! isSlowTarget() ) return maxScale;
		renderer.getDrawingBufferSize( drawingSize );
		const pixels = drawingSize.x * drawingSize.y;
		if ( ! ( pixels > 0 ) ) return maxScale;
		const fit = Math.floor( Math.sqrt( slowTargetConfig.pixelBudget / pixels ) * 100 ) / 100;
		return Math.min( maxScale, Math.max( minScale, fit ) );

	}

	// 场景 MSAA 采样数：?msaa= 强制；config.post.msaaOffForSlowHi 打开时 30 帧目标的 hi 关掉；其余用渲染器的（antialias → 4）
	function decideSceneSamples() {

		if ( msaaParam === '0' ) return 0;
		if ( msaaParam === '4' ) return 4;
		if ( ctx.config.post.msaaOffForSlowHi === true && isSlowTarget() ) return 0;
		return renderer.samples;

	}

	function updateMode() {

		if ( quality.tier === 'pano' ) quality.mode = 'pano';
		else quality.mode = quality.renderScale < 1 - 1e-6 ? 'upscale' : 'native';

	}

	// 画布像素比按档位定（hi 1.5、上限 2；mid 上限 1.25），场景比例只改场景目标，不动画布
	function applyResolution() {

		const devicePixelRatio = ( typeof window !== 'undefined' && Number.isFinite( window.devicePixelRatio ) && window.devicePixelRatio > 0 )
			? window.devicePixelRatio
			: 1;
		const params = quality.params;
		// pano 档：画布本身按 panoPixelRatio 画（浏览器用 CSS 拉伸到窗口，几乎不花钱）——软件渲染下每个像素都贵
		const pixelRatio = quality.tier === 'pano' ? qualityConfig.panoPixelRatio : Math.min( devicePixelRatio, params.pixelRatioCap, params.pixelRatio );

		if ( ! Number.isFinite( pixelRatio ) || pixelRatio <= 0 ) {

			console.warn( `像素比算出来不合法（${ pixelRatio }），本次不改分辨率` );
			return;

		}

		// 只改像素比不碰 CSS，画面自动拉伸；相同值 setPixelRatio 内部直接 return
		renderer.setPixelRatio( pixelRatio );
		safeSetSize( renderer, window.innerWidth, window.innerHeight );
		// 开局比例按画布像素定，窗口尺寸变了（开场卡点开时进全屏）、动态分辨率还没动过时跟着重算
		if ( scaleUntouched && quality.tier !== 'pano' ) quality.renderScale = initialScale();
		updateMode();

	}

	function setTier( tier ) {

		const normalized = tier === 'lo' ? 'mid' : tier;
		if ( ! isValidTier( normalized ) ) {

			console.warn( `档位 ${ tier } 不合法，只接受 hi / mid / pano，忽略` );
			return;

		}

		quality.tier = normalized;
		quality.frameTarget = normalized === 'hi' ? quality.hiFrameTarget : 30;
		quality.content = contentOf( normalized );
		quality.params = qualityConfig.tiers[ quality.content ];
		quality.renderScale = scaleRangeOf( normalized )[ 1 ];
		quality.pendingTier = null;
		pendingHiTarget = null;
		slowCount = 0;
		fastCount = 0;
		bottomWarned = false;
		bottomLogged = false;
		scaleUntouched = true;
		vertexBound = false;
		scaleCheck = null;
		lowFpsSince = null;
		updateBudget();

		applyResolution();
		if ( normalized !== 'pano' && quality.renderScale < scaleRangeOf( normalized )[ 1 ] - 1e-6 ) {

			renderer.getDrawingBufferSize( drawingSize );
			console.log( `画质：画布 ${ drawingSize.x }×${ drawingSize.y }（${ ( drawingSize.x * drawingSize.y / 1e6 ).toFixed( 1 ) } MP）超过 30 帧目标的场景像素预算，开局场景比例 ${ quality.renderScale.toFixed( 2 ) }` );

		}

		for ( let i = 0; i < tierCallbacks.length; i ++ ) {

			try {

				tierCallbacks[ i ]( normalized, quality.params );

			} catch ( error ) {

				console.error( '档位切换回调出错：', error );

			}

		}

	}

	function onTierChange( callback ) {

		if ( typeof callback !== 'function' ) {

			console.warn( 'onTierChange 需要传函数，忽略' );
			return;

		}

		tierCallbacks.push( callback );

	}

	// 起飞时调（时间线）：等着的档位变化（hi → mid、降到 pano、插电以后升回去）在这一刻生效
	function onDeparture() {

		if ( quality.pendingTier === null || forced ) return;
		const next = quality.pendingTier;
		if ( pendingHiTarget !== null ) quality.hiFrameTarget = pendingHiTarget;
		console.log( `画质：起飞时换档 ${ quality.tier } → ${ next }${ next === 'hi' ? `（帧目标 ${ quality.hiFrameTarget }）` : '' }` );
		setTier( next );

	}

	// 起飞（时间线 beginFlight，在 onDeparture 之后）：记下离开这个地点时的比例和顶点压力。
	// 飞行中只画远景，比原来的地点便宜得多：原来这时比例会升回 1，落地后又要四五秒才降回去，这几秒核显上掉到十几帧
	function onFlightStart() {

		if ( quality.tier === 'pano' ) return;
		flightSaved = { scale: quality.renderScale, pressure: quality.vertexPressure, untouched: scaleUntouched };
		quality.flying = true;
		fastCount = 0;

	}

	// 到达（在窄处里切到目的地的那一刻）：恢复离开上一个地点时的比例和顶点压力，计数都清掉。
	// 之后到飞行收尾结束（onFlightEnd）之间是"到达收尾"：镜头还在出窄处、画布还在蔓延，比停下来贵得多（?gpuSlow=7.5 实测
	// 进星月夜那几秒 38~42 ms，停下来只有 6~11 ms），这几秒不算进 hi → mid 的判断，不然会因为它在下一次起飞时降到 mid
	function onArrival() {

		if ( ! quality.flying ) return;
		quality.flying = false;
		quality.arriving = true;
		if ( flightSaved !== null && quality.tier !== 'pano' ) {

			const [ minScale, maxScale ] = scaleRangeOf( quality.tier );
			const restored = Math.min( maxScale, Math.max( minScale, flightSaved.scale ) );
			if ( Math.abs( restored - quality.renderScale ) > 1e-6 || flightSaved.pressure !== quality.vertexPressure ) {

				console.log( `画质：到达，场景比例恢复到离开上一个地点时的 ${ restored.toFixed( 2 ) }（飞行中是 ${ quality.renderScale.toFixed( 2 ) }），顶点压力 ${ flightSaved.pressure }` );

			}

			quality.renderScale = restored;
			quality.vertexPressure = flightSaved.pressure;
			scaleUntouched = flightSaved.untouched;
			updateMode();

		}

		flightSaved = null;
		slowCount = 0;
		fastCount = 0;
		scaleCheck = null;
		vertexBound = false;
		downscaleCheck = null;
		lowFpsSince = null;
		recentIntervals.length = 0;
		fpsWindow.length = 0;

	}

	// 飞行整个结束（时间线 finishFlight），或者飞行被方向键、跳转打断：没到达过的先按到达恢复比例，再清掉"到达收尾"
	function onFlightEnd() {

		if ( quality.flying ) onArrival();
		quality.arriving = false;
		lowFpsSince = null;
		fpsWindow.length = 0;

	}

	// ===================== 初始判断：显卡名 =====================

	// 显卡名的先验（基准测试没数据时用；独显至少 mid）。返回 { tier, discrete, software }
	function detectInitialTier( backend, gpuName ) {

		const name = typeof gpuName === 'string' ? gpuName.toLowerCase() : '';
		const has = ( list ) => list.find( ( keyword ) => name.includes( String( keyword ).toLowerCase() ) );

		const software = has( qualityConfig.softwareKeywords ) || ctx.fallbackAdapter === true;
		if ( software ) return { tier: 'pano', discrete: false, software: true, reason: ctx.fallbackAdapter ? 'WebGPU 报告是兜底适配器' : `显卡名含「${ software }」` };

		const discrete = has( qualityConfig.discreteKeywords );
		if ( discrete ) return { tier: 'hi', discrete: true, software: false, reason: `显卡名含「${ discrete }」，按独显` };

		const old = has( qualityConfig.oldIntegratedKeywords );
		if ( old ) return { tier: 'pano', discrete: false, software: false, reason: `显卡名含「${ old }」，按老核显` };

		const recent = has( qualityConfig.recentIntegratedKeywords );
		if ( recent ) return { tier: 'mid', discrete: false, software: false, reason: `显卡名含「${ recent }」，按较新的核显` };

		return { tier: 'mid', discrete: false, software: false, reason: '显卡名认不出来（浏览器常常遮掉），先按 mid' };

	}

	// ===================== 基准测试 =====================

	// 拔着电源：navigator.getBattery（Safari、Firefox 没有，当成插着电）
	async function readBattery() {

		if ( typeof navigator === 'undefined' || typeof navigator.getBattery !== 'function' ) return null;
		try {

			const battery = await navigator.getBattery();
			quality.onBattery = battery.charging === false;
			battery.addEventListener( 'chargingchange', () => {

				quality.onBattery = battery.charging === false;
				// 插上电：拔电时被保守判低了的话（档位低了，或者 hi 的帧目标从 60 判成了 30），下一次起飞时升回不加惩罚时该有的
				const benchmark = quality.benchmark;
				if ( ! battery.charging || ! benchmark || ! benchmark.unpenalizedTier || forced ) return;
				const betterTier = tierRank( benchmark.unpenalizedTier ) < tierRank( quality.tier );
				const betterTarget = benchmark.unpenalizedTier === 'hi' && benchmark.unpenalizedTarget > quality.hiFrameTarget;
				if ( betterTier || betterTarget ) {

					quality.pendingTier = benchmark.unpenalizedTier;
					pendingHiTarget = benchmark.unpenalizedTier === 'hi' ? benchmark.unpenalizedTarget : null;
					console.log( `画质：插上电源了，下一次起飞时升到 ${ quality.pendingTier }${ pendingHiTarget !== null ? `（帧目标 ${ pendingHiTarget }）` : '' }` );

				}

			} );
			return battery;

		} catch ( error ) {

			console.warn( '读电池状态失败，按插着电处理：', error && error.message ? error.message : error );
			return null;

		}

	}

	// 倍数 r（基准测试每帧时间 / 开发机的）→ 档位、hi 的帧目标
	function tierFromRatio( ratio ) {

		const benchmarkConfig = qualityConfig.benchmark;
		if ( ratio <= benchmarkConfig.hiFactor ) return 'hi';
		if ( ratio <= benchmarkConfig.midFactor ) return 'mid';
		return 'pano';

	}

	function frameTargetFromRatio( ratio ) {

		return ratio <= qualityConfig.benchmark.hi60Factor ? 60 : 30;

	}

	// 离屏画 1280×720 的重负载着色器。读回 1 个像素强制等显卡做完再计时（不被垂直同步卡住）；
	// WebGL2 的读回要轮询，等一次就是十几毫秒，所以连画 frames 帧、最后读回一次，开销摊到每帧里；两批取快的那批。
	// "第一帧"在一次不计时的热身之后再量（第一次画要建绑定，WebGL2 上能有几十毫秒，不算显卡慢）。
	// 返回 { firstMs, medianMs（每帧平均）} 或 null（没测成）
	async function measureBenchmark() {

		const benchmarkConfig = qualityConfig.benchmark;
		const target = new THREE.RenderTarget( benchmarkConfig.width, benchmarkConfig.height, { type: THREE.UnsignedByteType, depthBuffer: false } );
		const pass = createBenchmarkPass();
		const previousTarget = renderer.getRenderTarget();
		const draw = () => {

			renderer.setRenderTarget( target );
			renderer.render( pass.scene, pass.quad.camera );
			renderer.setRenderTarget( previousTarget );

		};
		const finish = () => renderer.readRenderTargetPixelsAsync( target, 0, 0, 1, 1 );

		try {

			// 先异步编好着色器：编译时间不算进"第一帧"
			const previousDepth = renderer.depth;
			renderer.setRenderTarget( target );
			renderer.depth = false;
			const compiling = renderer.compileAsync( pass.scene, pass.quad.camera );
			renderer.depth = previousDepth;
			renderer.setRenderTarget( previousTarget );
			await compiling;

			draw();
			await finish();

			// ?gpuSlow 模拟慢显卡：量出来的时间乘这个倍数
			let started = performance.now();
			draw();
			await finish();
			const firstMs = ( performance.now() - started ) * gpuSlow;
			if ( firstMs > benchmarkConfig.firstFrameLimitMs ) return { firstMs, medianMs: firstMs };

			for ( let i = 0; i < benchmarkConfig.warmupFrames; i ++ ) draw();
			await finish();
			let best = Infinity;
			for ( let batch = 0; batch < 2; batch ++ ) {

				started = performance.now();
				for ( let i = 0; i < benchmarkConfig.frames; i ++ ) draw();
				await finish();
				best = Math.min( best, ( performance.now() - started ) / benchmarkConfig.frames );

			}

			return { firstMs, medianMs: best * gpuSlow };

		} catch ( error ) {

			console.warn( '画质：基准测试出错，按显卡名的先验定档：', error && error.message ? error.message : error );
			return null;

		} finally {

			target.dispose();
			pass.material.dispose();

		}

	}

	// 开场卡点击时跑。refreshInterval 顺便从空帧量出来（没有显卡计时时，运行中的掉帧判断要用）
	async function runBenchmark() {

		const idle = await measureIdleInterval( 20 );
		if ( idle !== null ) refreshInterval = snapPeriod( idle );

		const prior = detectInitialTier( ctx.backend, ctx.gpuName );
		quality.software = prior.software;
		if ( forced && ! forcedDynamic ) {

			console.log( `画质：档位由 ?q=${ quality.tier } 强制指定，跳过基准测试` );
			quality.sceneSamples = decideSceneSamples();
			return quality.tier;

		}

		if ( prior.software && ! forced ) {

			console.log( `画质：${ prior.reason }，直接用全景（pano），不测` );
			quality.benchmark = { tier: 'pano', reason: prior.reason };
			setTier( 'pano' );
			return quality.tier;

		}

		await readBattery();
		const measured = await measureBenchmark();
		const benchmarkConfig = qualityConfig.benchmark;
		let tier;
		let unpenalizedTier = null;
		let unpenalizedTarget = null;
		let ratio = null;
		let hiTarget;
		if ( ! measured ) {

			tier = prior.tier;
			// 没测成：独显按 60 帧，其余（认不出来的多半是核显）按 30 帧
			hiTarget = prior.discrete ? 60 : 30;

		} else {

			const penalty = quality.onBattery ? benchmarkConfig.batteryPenalty : 1;
			const firstTooSlow = measured.firstMs > benchmarkConfig.firstFrameLimitMs;
			ratio = measured.medianMs * penalty / benchmarkConfig.baselineMs;
			const unpenalizedRatio = measured.medianMs / benchmarkConfig.baselineMs;
			unpenalizedTier = firstTooSlow ? 'pano' : tierFromRatio( unpenalizedRatio );
			unpenalizedTarget = frameTargetFromRatio( unpenalizedRatio );
			tier = firstTooSlow ? 'pano' : tierFromRatio( ratio );
			hiTarget = frameTargetFromRatio( ratio );
			// 独显至少 mid：基准测试被别的东西干扰（后台下载、刚切窗口）时不至于掉到全景
			if ( prior.discrete && tierRank( tier ) > tierRank( 'mid' ) ) tier = 'mid';
			console.log( `画质：基准测试第一帧 ${ measured.firstMs.toFixed( 1 ) } ms，每帧 ${ measured.medianMs.toFixed( 2 ) } ms，是开发机（${ benchmarkConfig.baselineMs } ms）的 ${ ratio.toFixed( 2 ) } 倍` +
				`（hi ≤ ${ benchmarkConfig.hiFactor } 倍，其中 ≤ ${ benchmarkConfig.hi60Factor } 倍按 60 帧、其余按 30 帧；mid ≤ ${ benchmarkConfig.midFactor } 倍）` +
				`${ penalty > 1 ? `，没插电源按 ${ penalty } 倍算` : '' }；${ prior.reason }` );

		}

		quality.hiFrameTarget = hiTarget;
		quality.benchmark = { ...( measured || {} ), ratio, tier, unpenalizedTier, unpenalizedTarget, reason: prior.reason };
		if ( forced ) {

			// ?q=…&dynamic=1：档位不变，只用基准测试定 hi 的帧目标
			console.log( `画质：基准测试判的是 ${ tier }，档位按 ?q= 强制为 ${ quality.tier }${ quality.tier === 'hi' ? `，帧目标 ${ hiTarget } 帧` : '' }` );
			setTier( quality.tier );

		} else {

			setTier( tier );
			console.log( `画质：判定为 ${ tier }${ tier === 'hi' ? `，帧目标 ${ quality.frameTarget } 帧（每帧显卡预算 ${ quality.budgetMs } ms，场景比例 ${ scaleRangeOf( 'hi' )[ 0 ] }~1）` : '' }` );

		}

		quality.sceneSamples = decideSceneSamples();
		if ( quality.sceneSamples !== renderer.samples ) console.log( `画质：场景 MSAA 采样数 ${ renderer.samples } → ${ quality.sceneSamples }${ msaaParam !== null ? '（?msaa= 强制）' : '（config.post.msaaOffForSlowHi）' }` );
		return quality.tier;

	}

	// ===================== 运行中：显卡时间 / 帧间隔 → 动态分辨率 =====================
	// 不能只看两帧之间隔了多久：显示器 60Hz 时帧间隔被垂直同步卡在 16.7 ms，再快也看不出来；
	// 浏览器窗口被遮住、失焦，或者笔记本拔电源开了省电模式时，浏览器会把帧率压到 30，帧间隔变成 33 ms，
	// 但显卡其实很闲。所以：WebGPU 有时间戳查询时直接读显卡每帧实际干活的时间；没有时（WebGL2），
	// 以开场卡空帧量出的"刷新间隔"为基准，只有帧间隔明显比它长（掉帧）才算慢，被限帧时不算。

	const gpuTiming = {
		enabled: ctx.gpuTiming === true,
		pending: false,
	};
	let refreshInterval = 1000 / 60;
	const recentIntervals = [];
	let lastDownscaleTime = - Infinity;
	let framesSinceRaise = 0;    // 30 帧目标：上次升比例以后过了多少帧（没有显卡计时时）
	let downscaleCheck = null;   // 降分辨率以后的检查：{ before 降之前的帧间隔中位数, tier, scale, pressure, frames }
	const standardPeriods = [ 1000 / 165, 1000 / 144, 1000 / 120, 1000 / 90, 1000 / 75, 1000 / 60, 1000 / 50, 1000 / 30 ];

	// 吸附到最近的常见刷新间隔（差 12% 以内），量不准的空帧间隔不会带歪判断
	function snapPeriod( milliseconds ) {

		let best = milliseconds;
		let bestError = 0.12;
		for ( const period of standardPeriods ) {

			const error = Math.abs( milliseconds - period ) / period;
			if ( error < bestError ) {

				best = period;
				bestError = error;

			}

		}

		return best;

	}

	if ( gpuTiming.enabled && ! intervalOnly ) console.log( '画质：用显卡时间戳判断负载（不受垂直同步和浏览器限帧影响）' );
	if ( intervalOnly ) console.log( '画质：?gpuTiming=0，按帧间隔判断负载（和 WebGL2 一样）' );

	// 每画完一帧调一次：把显卡时间结算出来（异步，不等）
	function afterRender() {

		if ( ! gpuTiming.enabled || gpuTiming.pending ) return;
		gpuTiming.pending = true;
		renderer.resolveTimestampsAsync( 'render' ).then( ( measured ) => {

			gpuTiming.pending = false;
			// three r186 两个后端的 resolveTimestampsAsync 返回的都是"最近结算到的那一帧"的显卡时间，不是累计
			if ( typeof measured === 'number' && Number.isFinite( measured ) && measured > 0 ) {

				const duration = measured * gpuSlow;
				lastGpuMs = duration;
				quality.gpuMs = quality.gpuMs > 0 ? quality.gpuMs * 0.8 + duration * 0.2 : duration;
				quality.gpuSamples.push( duration );
				if ( quality.gpuSamples.length > 240 ) quality.gpuSamples.shift();
				if ( ! intervalOnly ) onGpuFrame( duration );

			}

		} ).catch( ( error ) => {

			gpuTiming.pending = false;
			gpuTiming.enabled = false;
			console.warn( '画质：读显卡时间戳失败，改用帧间隔判断：', error );

		} );

	}

	// 只等一帧 rAF，不画任何东西，量刷新间隔
	async function measureIdleInterval( frameCount ) {

		const intervals = [];
		let previous = null;
		for ( let i = 0; i < frameCount; i ++ ) {

			const frame = await waitFrame( 250 );
			if ( ! frame.real ) {

				previous = null;
				continue;

			}

			if ( previous !== null ) intervals.push( frame.timestamp - previous );
			previous = frame.timestamp;

		}

		if ( intervals.length === 0 ) return null;
		return medianOf( intervals );

	}

	// 顶点压力还能不能降：没到 0.6，而且最近 2 秒有东西在用它（没有草的地点降了也没用）
	function pressureUsable() {

		return quality.vertexPressure > 0.6 + 1e-6 && performance.now() - quality.vertexPressureUsedAt < 2000;

	}

	function lowerPressure( reason ) {

		quality.vertexPressure = Math.max( 0.6, Math.round( ( quality.vertexPressure - 0.2 ) * 10 ) / 10 );
		console.log( `${ reason }，顶点压力降到 ${ quality.vertexPressure }（草变稀、林下和近处 3D 树的范围缩）` );
		return 'pressure';

	}

	// 降一步：先缩场景（hi 加放大），缩到下限先降顶点压力；hi 到底以后不在这里降档（见 checkTierDrop，等起飞）；
	// mid 缩到下限还不够，下一次起飞时换全景。suggestedScale：显卡时间远超预算时按它一步跳下去（不比正常一步高）。
	// 返回这一步改了什么：'scale' 场景比例、'pressure' 顶点压力、'pending' 等起飞换全景、'none' 已经到底
	function lowerScale( reason, suggestedScale = null ) {

		const step = dynamicConfig.step;
		const [ minScale, maxScale ] = scaleRangeOf( quality.tier );
		lastDownscaleTime = performance.now();

		// 上次降比例几乎没省下显卡时间（顶点瓶颈）：分辨率再低也没用，先让草变稀、林下缩
		if ( vertexBound && pressureUsable() ) return lowerPressure( `${ reason }，上次降比例几乎没省下来（顶点瓶颈）` );

		if ( quality.renderScale > minScale + 1e-6 ) {

			// 30 帧目标从最高比例起步时第一步直接降到 0.8：一格 0.1 只省 19% 的像素，核显上要降好几轮、每轮 30 帧
			const firstStep = isSlowTarget() && quality.renderScale >= maxScale - 1e-6 ? slowTargetConfig.firstStep : step;
			let next = quality.renderScale - firstStep;
			if ( Number.isFinite( suggestedScale ) ) next = Math.min( next, suggestedScale );
			quality.renderScale = Math.max( minScale, Math.round( next * 100 ) / 100 );
			scaleUntouched = false;
			updateMode();
			console.log( `${ reason }，场景比例降到 ${ quality.renderScale.toFixed( 2 ) }（${ quality.mode === 'upscale' ? 'fsr1 放大' : '原生' }）` );
			return 'scale';

		}

		// 场景比例到底了：分辨率再低也省不了顶点，先让草变稀、林下缩（1 → 0.8 → 0.6）
		if ( pressureUsable() ) return lowerPressure( `${ reason }，场景比例已经到底` );

		if ( quality.tier === 'hi' ) {

			// hi 不在地点中途降档：连续 tierDropSeconds 秒低于 tierDropFps 帧（checkTierDrop），才在下一次起飞时降到 mid
			if ( ! bottomLogged ) {

				bottomLogged = true;
				console.log( `${ reason }，hi 的场景比例（${ minScale }）和顶点压力都到底了；连续 ${ dynamicConfig.tierDropSeconds } 秒低于 ${ dynamicConfig.tierDropFps } 帧才在下一次起飞时降到 mid` );

			}

			return 'none';

		}

		if ( quality.tier === 'mid' && quality.pendingTier !== 'pano' ) {

			quality.pendingTier = 'pano';
			console.log( `${ reason }，mid 缩到 ${ minScale } 还不够，下一次起飞时换成全景` );
			return 'pending';

		}

		if ( ! bottomWarned ) {

			bottomWarned = true;
			console.warn( '画质已经降到底（等着换全景），仍然超出预算' );

		}

		return 'none';

	}

	// 还一步顶点压力（降的时候它在比例之后，所以先还它）
	function raisePressure( reason ) {

		quality.vertexPressure = Math.min( 1, Math.round( ( quality.vertexPressure + 0.2 ) * 10 ) / 10 );
		console.log( `${ reason }，顶点压力升到 ${ quality.vertexPressure }` );

	}

	function raiseScale( reason ) {

		const [ , maxScale ] = scaleRangeOf( quality.tier );
		quality.renderScale = Math.min( maxScale, Math.round( ( quality.renderScale + dynamicConfig.step ) * 100 ) / 100 );
		scaleUntouched = false;
		updateMode();
		console.log( `${ reason }，场景比例升到 ${ quality.renderScale.toFixed( 2 ) }` );

	}

	// 降比例以后看实际省了多少：像素数按比例的平方算，预计省 before × (1 − (新/旧)²)；
	// 实际省下的不到预计的 vertexBoundRatio（40%），说明这一帧的时间大头不在像素上（顶点：草、树、倒影里又画一遍的几何）。
	// 飞行中、到达收尾里不判：镜头一直在动、地形一直在换，降之前和之后画的根本不是同一个画面（?gpuSlow=7.5 实测飞行里"实际省了 −1 ms"）
	function judgeScaleDrop( check, after, unit ) {

		if ( quality.flying || quality.arriving ) return;
		const pixelRatio = ( check.afterScale * check.afterScale ) / ( check.beforeScale * check.beforeScale );
		const predicted = check.before * ( 1 - pixelRatio );
		const saved = check.before - after;
		if ( predicted > 0 && saved < predicted * dynamicConfig.vertexBoundRatio ) {

			vertexBound = true;
			console.log( `画质：比例 ${ check.beforeScale.toFixed( 2 ) } → ${ check.afterScale.toFixed( 2 ) } 预计省 ${ predicted.toFixed( 1 ) } ms ${ unit }、实际省了 ${ saved.toFixed( 1 ) } ms，判成顶点瓶颈：下一步先降顶点压力` );

		}

	}

	// hi → mid（规格书 6.1）：比例到底、顶点压力到 0.6（或这里没有草）、连续 tierDropSeconds 秒低于 tierDropFps 帧，
	// 才记成"下一次起飞时降"。飞行中、到达收尾里不判（只画远景 / 出窄处、画布蔓延，负载和停下来不一样）；
	// 超过 250 ms 的卡顿（加载、切标签页）打断
	function checkTierDrop( interval ) {

		if ( ! dynamicEnabled || forced || quality.tier !== 'hi' || quality.pendingTier !== null || quality.flying || quality.arriving || interval > 250 ) {

			lowFpsSince = null;
			fpsWindow.length = 0;
			return;

		}

		fpsWindow.push( interval );
		if ( fpsWindow.length > 15 ) fpsWindow.shift();
		const [ minScale ] = scaleRangeOf( 'hi' );
		const atBottom = quality.renderScale <= minScale + 1e-6 && ! pressureUsable();
		const average = fpsWindow.reduce( ( sum, value ) => sum + value, 0 ) / fpsWindow.length;
		if ( ! atBottom || fpsWindow.length < 15 || average <= 1000 / dynamicConfig.tierDropFps ) {

			lowFpsSince = null;
			return;

		}

		const now = performance.now();
		if ( lowFpsSince === null ) {

			lowFpsSince = now;
			return;

		}

		if ( now - lowFpsSince >= dynamicConfig.tierDropSeconds * 1000 ) {

			quality.pendingTier = 'mid';
			lowFpsSince = null;
			console.log( `画质：hi 的场景比例和顶点压力都到底了，还连续 ${ dynamicConfig.tierDropSeconds } 秒低于 ${ dynamicConfig.tierDropFps } 帧（最近约 ${ ( 1000 / average ).toFixed( 1 ) } 帧），下一次起飞时降到 mid` );

		}

	}

	// ?gpuSlow 时的帧间隔：按模拟的显卡时间、对齐到刷新间隔的整数倍（垂直同步下帧间隔是一格一格的），比真实的帧间隔长才用它
	function effectiveInterval( frameMs ) {

		if ( gpuSlow === 1 || ! ( lastGpuMs > 0 ) ) return frameMs;
		return Math.max( frameMs, Math.ceil( lastGpuMs / refreshInterval - 0.05 ) * refreshInterval );

	}

	// 有显卡计时：按这一档的显卡时间预算调场景比例。
	// 升比例前先估算：像素数和比例的平方成正比，升完预计还在预算的 raiseMargin 倍以内才升（30 帧目标 0.8，其余 0.85），免得来回抖
	function onGpuFrame( gpuMs ) {

		if ( ! dynamicEnabled || quality.tier === 'pano' ) return;
		const budget = quality.budgetMs;

		// 上次降比例的效果：等 slowFrames 帧（时间戳结算晚一两帧），取后三分之二的中位数
		if ( scaleCheck !== null ) {

			scaleCheck.frames ++;
			if ( scaleCheck.frames >= dynamicConfig.slowFrames ) {

				judgeScaleDrop( scaleCheck, medianOf( quality.gpuSamples.slice( - Math.ceil( dynamicConfig.slowFrames * 2 / 3 ) ) ), '显卡时间' );
				scaleCheck = null;

			}

		}

		if ( gpuMs > budget ) {

			slowCount ++;
			fastCount = 0;
			if ( slowCount >= dynamicConfig.slowFrames ) {

				slowCount = 0;
				const recent = medianOf( quality.gpuSamples.slice( - dynamicConfig.slowFrames ) );
				// 远超预算（到达时比例偏高、换了个重地点）：按像素数一步跳到 比例 × √(0.9 × 预算 / 显卡时间)，不一格格降
				const suggested = recent > budget * dynamicConfig.jumpRatio ? quality.renderScale * Math.sqrt( dynamicConfig.jumpHeadroom * budget / recent ) : null;
				const beforeScale = quality.renderScale;
				const changed = lowerScale( `连续 ${ dynamicConfig.slowFrames } 帧显卡时间超过 ${ budget } ms（中位数 ${ recent.toFixed( 1 ) } ms）`, suggested );
				if ( changed === 'scale' ) scaleCheck = { before: recent, beforeScale, afterScale: quality.renderScale, frames: 0 };

			}

			return;

		}

		slowCount = 0;
		// 飞行中只降不升：远景比地点便宜，升上去落地又得降回来（到达时恢复离开上一个地点时的比例）
		if ( quality.flying ) {

			fastCount = 0;
			return;

		}

		// 升（先还顶点压力，再升比例）：连续 fastFrames 帧没超预算，再看这些帧的平均。
		// 不要求"每一帧都有余量"：星月夜每 12 帧重画一次地面底稿，那一帧贵一半，按每一帧算永远升不上去
		// （?gpuSlow=7.5 2560×1600 实测降到 0.55 以后平均 10 ms、预算 27 ms 也一直卡在 0.55）；偶尔一帧贵一点不会超预算太多，
		// 真超了 slowFrames 帧才降
		const [ , maxScale ] = scaleRangeOf( quality.tier );
		const pressureLeft = quality.vertexPressure < 1 - 1e-6;
		if ( ! pressureLeft && quality.renderScale >= maxScale - 1e-6 ) {

			fastCount = 0;
			return;

		}

		fastCount ++;
		if ( fastCount < dynamicConfig.fastFrames ) return;
		fastCount = 0;
		const recent = quality.gpuSamples.slice( - dynamicConfig.fastFrames );
		const average = recent.reduce( ( sum, value ) => sum + value, 0 ) / recent.length;

		// 顶点压力还没还完：平均低于预算的 60% 才还一步（还顶点压力能多花多少估不准，留大一点余量，免得 0.6 ↔ 0.8 来回抖）
		if ( pressureLeft ) {

			if ( average < budget * 0.6 ) raisePressure( `最近 ${ recent.length } 帧显卡时间平均 ${ average.toFixed( 1 ) } ms，不到预算的六成` );
			return;

		}

		const nextScale = Math.min( maxScale, quality.renderScale + dynamicConfig.step );
		const predicted = average * ( nextScale * nextScale ) / ( quality.renderScale * quality.renderScale );
		const raiseMargin = isSlowTarget() ? slowTargetConfig.raiseMargin : dynamicConfig.raiseMargin;
		if ( predicted < budget * raiseMargin ) raiseScale( `最近 ${ recent.length } 帧显卡时间平均 ${ average.toFixed( 1 ) } ms，升一格预计 ${ predicted.toFixed( 1 ) } ms，在预算的 ${ raiseMargin } 倍以内` );

	}

	// 每帧调（主循环，开场卡点开以后）：hi → mid 的判断两个后端都做；没有显卡计时（WebGL2、?gpuTiming=0）时还按帧间隔调比例
	function onFrame( frameMs ) {

		if ( ! Number.isFinite( frameMs ) || frameMs <= 0 ) return;
		const interval = effectiveInterval( frameMs );
		checkTierDrop( interval );
		if ( ! dynamicEnabled || quality.tier === 'pano' ) return;
		if ( gpuTiming.enabled && ! intervalOnly ) return;
		onInterval( interval );

	}

	// 没有显卡计时：按帧间隔判断，以开场卡量出的"刷新间隔"为基准——被垂直同步或浏览器限帧卡住时不算慢
	function onInterval( frameMs ) {

		// 超过 250 ms 的是卡顿（加载、切标签页），不代表显卡负载，打断计数
		if ( frameMs > 250 ) {

			slowCount = 0;
			fastCount = 0;
			return;

		}

		recentIntervals.push( frameMs );
		if ( recentIntervals.length > dynamicConfig.intervalRaiseFrames ) recentIntervals.shift();
		framesSinceRaise ++;

		// 上次降分辨率以后过了 60 帧：帧间隔几乎没变（还剩 93% 以上）、而且正好是浏览器会限的那几档刷新间隔（30、60 帧……），
		// 说明不是显卡跟不上，是被浏览器限帧了；变了、但省下的不到按像素数预计的四成：瓶颈在顶点，下一步先降顶点压力。
		// 帧间隔是 50 ms 这种（垂直同步下显卡跟不上、卡在 3 个刷新周期）不算限帧：原来会把刷新间隔记成 50 ms，
		// 之后 72 ms 以下的帧都不算慢，30 帧目标的核显在星月夜到达那几秒就这样卡住不降（?gpuSlow=7.5&gpuTiming=0 实测）
		if ( downscaleCheck !== null ) {

			downscaleCheck.frames ++;
			if ( downscaleCheck.frames >= 60 ) {

				const after = medianOf( recentIntervals.slice( - 45 ) );
				const snapped = snapPeriod( after );
				if ( after > downscaleCheck.before * 0.93 && standardPeriods.includes( snapped ) ) {

					refreshInterval = snapped;
					if ( quality.tier !== downscaleCheck.tier ) setTier( downscaleCheck.tier );
					quality.renderScale = downscaleCheck.scale;
					quality.vertexPressure = downscaleCheck.pressure;
					quality.pendingTier = null;
					updateMode();
					console.log( `画质：降了分辨率帧间隔也没变（${ downscaleCheck.before.toFixed( 1 ) } → ${ after.toFixed( 1 ) } ms），是浏览器限帧，不是显卡跟不上；刷新间隔按 ${ refreshInterval.toFixed( 1 ) } ms 算，退回 ${ quality.tier } ${ quality.renderScale.toFixed( 2 ) }` );

				} else {

					judgeScaleDrop( { before: downscaleCheck.before, beforeScale: downscaleCheck.scale, afterScale: quality.renderScale }, after, '帧间隔' );

				}

				downscaleCheck = null;

			}

		}

		// 慢帧：比刷新间隔长 45%、而且比目标帧时长长 20%（30 帧目标时 33 ms 的帧不算慢；原来 30 帧时每帧都算慢帧，一路降到底）
		const targetFrameMs = 1000 / quality.frameTarget;
		const slowThreshold = Math.max( dynamicConfig.slowFrameMs, refreshInterval * 1.45, targetFrameMs * dynamicConfig.intervalSlowRatio );
		if ( frameMs > slowThreshold ) {

			slowCount ++;
			fastCount = 0;
			if ( slowCount >= dynamicConfig.slowFrames && downscaleCheck === null ) {

				slowCount = 0;
				const before = { before: medianOf( recentIntervals.slice( - 30 ) ), tier: quality.tier, scale: quality.renderScale, pressure: quality.vertexPressure, frames: 0 };
				const changed = lowerScale( '连续 ' + dynamicConfig.slowFrames + ' 帧明显掉帧（超过 ' + slowThreshold.toFixed( 1 ) + ' ms）' );
				// 只有改了分辨率才推断"是不是浏览器限帧"：降顶点压力时瓶颈在片元的话帧间隔本来就不变，不能据此判成限帧
				if ( changed === 'scale' ) downscaleCheck = before;

			}

			return;

		}

		slowCount = 0;
		const [ , maxScale ] = scaleRangeOf( quality.tier );
		// 稳稳跟上一段时间、离上次降比例也够久了，才试着升回去：先还顶点压力，再升比例；飞行中不升
		const canRaise = ! quality.flying && ( quality.vertexPressure < 1 - 1e-6 || quality.renderScale < maxScale - 1e-6 ) &&
			performance.now() - lastDownscaleTime > dynamicConfig.raiseCooldown * 1000;
		if ( ! canRaise ) {

			fastCount = 0;
			return;

		}

		if ( quality.frameTarget === 30 ) {

			// 30 帧目标：最近 240 帧的平均间隔不到目标帧时长的 0.75 倍（多半的帧能跟上 60 帧），才升一步；升完再攒 240 帧
			if ( framesSinceRaise < dynamicConfig.intervalRaiseFrames || recentIntervals.length < dynamicConfig.intervalRaiseFrames ) return;
			const average = recentIntervals.reduce( ( sum, value ) => sum + value, 0 ) / recentIntervals.length;
			if ( average >= targetFrameMs * dynamicConfig.intervalRaiseRatio ) return;
			framesSinceRaise = 0;
			const reason = `最近 ${ recentIntervals.length } 帧平均间隔 ${ average.toFixed( 1 ) } ms，不到目标帧时长的 ${ dynamicConfig.intervalRaiseRatio } 倍`;
			if ( quality.vertexPressure < 1 - 1e-6 ) raisePressure( reason );
			else raiseScale( reason );
			return;

		}

		// 60 帧目标：连续两倍 fastFrames 帧跟得上刷新
		if ( frameMs <= refreshInterval * 1.1 ) {

			fastCount ++;
			if ( fastCount >= dynamicConfig.fastFrames * 2 ) {

				fastCount = 0;
				if ( quality.vertexPressure < 1 - 1e-6 ) raisePressure( '连续 ' + dynamicConfig.fastFrames * 2 + ' 帧跟得上刷新' );
				else raiseScale( '连续 ' + dynamicConfig.fastFrames * 2 + ' 帧跟得上刷新' );

			}

		} else {

			fastCount = 0;

		}

	}

	// 切回标签页：之前攒的计数和帧间隔都作废（隐藏期间 rAF 停了，回来头几帧的间隔不代表负载）
	if ( typeof document !== 'undefined' ) {

		document.addEventListener( 'visibilitychange', () => {

			slowCount = 0;
			fastCount = 0;
			recentIntervals.length = 0;
			fpsWindow.length = 0;
			downscaleCheck = null;
			scaleCheck = null;
			lowFpsSince = null;

		} );

	}

	// 初始档位：强制 > 显卡名的先验（基准测试在点开场卡时再定）
	const initialTier = forced ? normalizedForced : detectInitialTier( ctx.backend, ctx.gpuName ).tier;
	quality.tier = initialTier;
	quality.frameTarget = initialTier === 'hi' ? quality.hiFrameTarget : 30;
	quality.content = contentOf( initialTier );
	quality.params = qualityConfig.tiers[ quality.content ];
	quality.renderScale = scaleRangeOf( initialTier )[ 1 ];
	updateBudget();
	quality.sceneSamples = decideSceneSamples();
	applyResolution();

	console.log( `画质初始档位 ${ initialTier }${ forced ? '（强制）' : '（显卡名先验，开场卡点开后跑基准测试）' }，像素比 ${ renderer.getPixelRatio().toFixed( 2 ) }，场景比例 ${ quality.renderScale }` );

	return quality;

}
