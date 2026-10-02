// 画质：三种方式自动选（规格书 6.1）+ 动态分辨率。所有数字从 ctx.config.quality 读。
//
// 对外档位（tier）：
//   hi   实时原生：原生分辨率、最高画质参数；显卡吃紧时先变成"hi 加放大"（场景按 0.9 → 0.67 倍画，fsr1 放大回原生）
//   mid  实时放大：画布像素比上限 1.25，场景按 0.77 → 0.5 倍画再用 fsr1 放大；效果参数用"低"那一列（content = 'lo'）
//   pano 全景：播放预烘焙的全景和飞行视频（阶段 6）；运行中降到 pano 只在下一次起飞时发生，不在地点中途硬切
// 内容参数档（content）：hi / mid / lo，对应 config.quality.tiers 和各场景按档位取的数组（网格分段、粒子数……）。
// 内容参数只在建场景时用：运行中降档只影响之后加载的地点，正在画的地点只改分辨率和后期链。
//
// 怎么判断：显卡名含软件渲染的字样、或者 WebGPU 报告是兜底适配器 → 直接 pano，不测；
// 其余跑基准测试：离屏 1280×720 的重负载着色器，预热后画 10 帧，每帧读回 1 个像素强制等显卡做完再计时（不被垂直同步卡住）；
// 第一帧超过 120 毫秒立即判 pano；阈值是开发机基准值的倍数（config.quality.benchmark）。显卡名只作先验：独显至少给 mid，
// 基准测试没采到数据时按先验。拔着电源时测出来的时间按 batteryPenalty 加重（判定更保守），插上电以后下一次起飞时可以升回去。

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
	const renderer = ctx.renderer;

	// ?q=lo 是旧的写法，按 mid 处理
	const normalizedForced = forcedTier === 'lo' ? 'mid' : forcedTier;
	const forced = isValidTier( normalizedForced );
	if ( forcedTier !== undefined && forcedTier !== null && forcedTier !== '' && ! forced ) {

		console.warn( `画质参数 ?q=${ forcedTier } 不合法，只接受 hi / mid / pano，改为自动判断` );

	}

	const tierCallbacks = [];

	// 动态分辨率的连续计数
	let slowCount = 0;
	let fastCount = 0;
	let bottomWarned = false;

	const quality = {
		tier: 'hi',
		content: 'hi',
		params: null,
		mode: 'native',          // native 原生链 / upscale 低分辨率 + fsr1 放大 / pano 全景
		renderScale: 1,          // 场景按画布的多少倍画（< 1 时走放大链）
		pendingTier: null,       // 等下一次起飞时才切的档位（降到 pano、插电后升回去）
		gpuMs: 0,
		gpuSamples: [],
		benchmark: null,         // { firstMs, medianMs, penalty, tier, reason }
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
	};

	// ===================== 档位和分辨率 =====================

	function contentOf( tier ) {

		return qualityConfig.tierContent[ tier ] || 'lo';

	}

	// 这一档的场景比例范围 [最小, 最大]
	function scaleRangeOf( tier ) {

		const range = qualityConfig.sceneScale[ tier ];
		return range ? range : [ 1, 1 ];

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
		updateMode();

	}

	function setTier( tier ) {

		const normalized = tier === 'lo' ? 'mid' : tier;
		if ( ! isValidTier( normalized ) ) {

			console.warn( `档位 ${ tier } 不合法，只接受 hi / mid / pano，忽略` );
			return;

		}

		quality.tier = normalized;
		quality.content = contentOf( normalized );
		quality.params = qualityConfig.tiers[ quality.content ];
		quality.renderScale = scaleRangeOf( normalized )[ 1 ];
		quality.pendingTier = null;
		slowCount = 0;
		fastCount = 0;
		bottomWarned = false;

		applyResolution();

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

	// 起飞时调（时间线）：等着的档位变化（降到 pano、插电以后升回去）在这一刻生效
	function onDeparture() {

		if ( quality.pendingTier === null || forced ) return;
		const next = quality.pendingTier;
		console.log( `画质：起飞时换档 ${ quality.tier } → ${ next }` );
		setTier( next );

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
				// 插上电：拔电时被保守判低了的话，下一次起飞时升回不加惩罚时该有的档位
				if ( battery.charging && quality.benchmark && quality.benchmark.unpenalizedTier && tierRank( quality.benchmark.unpenalizedTier ) < tierRank( quality.tier ) ) {

					quality.pendingTier = quality.benchmark.unpenalizedTier;
					console.log( `画质：插上电源了，下一次起飞时升到 ${ quality.pendingTier }` );

				}

			} );
			return battery;

		} catch ( error ) {

			console.warn( '读电池状态失败，按插着电处理：', error && error.message ? error.message : error );
			return null;

		}

	}

	function tierFromTime( milliseconds ) {

		const benchmarkConfig = qualityConfig.benchmark;
		if ( milliseconds <= benchmarkConfig.baselineMs * benchmarkConfig.hiFactor ) return 'hi';
		if ( milliseconds <= benchmarkConfig.baselineMs * benchmarkConfig.midFactor ) return 'mid';
		return 'pano';

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

			let started = performance.now();
			draw();
			await finish();
			const firstMs = performance.now() - started;
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

			return { firstMs, medianMs: best };

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
		if ( forced ) {

			console.log( `画质：档位由 ?q=${ quality.tier } 强制指定，跳过基准测试` );
			return quality.tier;

		}

		if ( prior.software ) {

			console.log( `画质：${ prior.reason }，直接用全景（pano），不测` );
			quality.benchmark = { tier: 'pano', reason: prior.reason };
			setTier( 'pano' );
			return quality.tier;

		}

		await readBattery();
		const measured = await measureBenchmark();
		let tier;
		let unpenalizedTier = null;
		if ( ! measured ) {

			tier = prior.tier;

		} else {

			const penalty = quality.onBattery ? qualityConfig.benchmark.batteryPenalty : 1;
			unpenalizedTier = measured.firstMs > qualityConfig.benchmark.firstFrameLimitMs ? 'pano' : tierFromTime( measured.medianMs );
			tier = measured.firstMs > qualityConfig.benchmark.firstFrameLimitMs ? 'pano' : tierFromTime( measured.medianMs * penalty );
			// 独显至少 mid：基准测试被别的东西干扰（后台下载、刚切窗口）时不至于掉到全景
			if ( prior.discrete && tierRank( tier ) > tierRank( 'mid' ) ) tier = 'mid';
			console.log( `画质：基准测试第一帧 ${ measured.firstMs.toFixed( 1 ) } ms，每帧 ${ measured.medianMs.toFixed( 2 ) } ms（开发机 ${ qualityConfig.benchmark.baselineMs } ms；hi ≤ ${ qualityConfig.benchmark.hiFactor } 倍，mid ≤ ${ qualityConfig.benchmark.midFactor } 倍）${ penalty > 1 ? `，没插电源按 ${ penalty } 倍算` : '' }；${ prior.reason }` );

		}

		quality.benchmark = { ...( measured || {} ), tier, unpenalizedTier, reason: prior.reason };
		console.log( `画质：判定为 ${ tier }` );
		setTier( tier );
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
	let downscaleCheck = null;   // 降分辨率以后的检查：{ before 降之前的帧间隔中位数, tier, scale, frames }
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

	if ( gpuTiming.enabled ) console.log( '画质：用显卡时间戳判断负载（不受垂直同步和浏览器限帧影响）' );

	// 每画完一帧调一次：把显卡时间结算出来（异步，不等）
	function afterRender() {

		if ( ! gpuTiming.enabled || gpuTiming.pending ) return;
		gpuTiming.pending = true;
		renderer.resolveTimestampsAsync( 'render' ).then( ( duration ) => {

			gpuTiming.pending = false;
			// three r186 两个后端的 resolveTimestampsAsync 返回的都是"最近结算到的那一帧"的显卡时间，不是累计
			if ( typeof duration === 'number' && Number.isFinite( duration ) && duration > 0 ) {

				quality.gpuMs = quality.gpuMs > 0 ? quality.gpuMs * 0.8 + duration * 0.2 : duration;
				quality.gpuSamples.push( duration );
				if ( quality.gpuSamples.length > 240 ) quality.gpuSamples.shift();
				onGpuFrame( duration );

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

	// 降一步：hi 先缩场景（hi 加放大），缩到 hi 的下限就降 mid；mid 缩到下限还不够，下一次起飞时换全景
	function lowerScale( reason ) {

		const step = dynamicConfig.step;
		const [ minScale ] = scaleRangeOf( quality.tier );
		lastDownscaleTime = performance.now();

		if ( quality.renderScale > minScale + 1e-6 ) {

			quality.renderScale = Math.max( minScale, Math.round( ( quality.renderScale - step ) * 100 ) / 100 );
			updateMode();
			console.log( `${ reason }，场景比例降到 ${ quality.renderScale.toFixed( 2 ) }（${ quality.mode === 'upscale' ? 'fsr1 放大' : '原生' }）` );
			return;

		}

		if ( quality.tier === 'hi' ) {

			console.log( `${ reason }，hi 缩到 ${ minScale } 还不够，降到 mid` );
			setTier( 'mid' );
			return;

		}

		if ( quality.tier === 'mid' && quality.pendingTier !== 'pano' ) {

			quality.pendingTier = 'pano';
			console.log( `${ reason }，mid 缩到 ${ minScale } 还不够，下一次起飞时换成全景` );
			return;

		}

		if ( ! bottomWarned ) {

			bottomWarned = true;
			console.warn( '画质已经降到底（等着换全景），仍然超出预算' );

		}

	}

	function raiseScale( reason ) {

		const [ , maxScale ] = scaleRangeOf( quality.tier );
		quality.renderScale = Math.min( maxScale, Math.round( ( quality.renderScale + dynamicConfig.step ) * 100 ) / 100 );
		updateMode();
		console.log( `${ reason }，场景比例升到 ${ quality.renderScale.toFixed( 2 ) }` );

	}

	// 有显卡计时：按这一档的显卡时间预算调场景比例。
	// 升比例前先估算：像素数和比例的平方成正比，升完预计还在预算的 85% 以内才升，免得来回抖
	function onGpuFrame( gpuMs ) {

		if ( forced || quality.tier === 'pano' ) return;
		const budget = dynamicConfig.gpuBudgetMs[ quality.tier ];

		if ( gpuMs > budget ) {

			slowCount ++;
			fastCount = 0;
			if ( slowCount >= dynamicConfig.slowFrames ) {

				slowCount = 0;
				lowerScale( '连续 ' + dynamicConfig.slowFrames + ' 帧显卡时间超过 ' + budget + ' ms' );

			}

			return;

		}

		slowCount = 0;
		const [ , maxScale ] = scaleRangeOf( quality.tier );
		if ( quality.renderScale >= maxScale - 1e-6 ) {

			fastCount = 0;
			return;

		}

		const nextScale = Math.min( maxScale, quality.renderScale + dynamicConfig.step );
		const predicted = gpuMs * ( nextScale * nextScale ) / ( quality.renderScale * quality.renderScale );
		if ( predicted < budget * 0.85 ) {

			fastCount ++;
			if ( fastCount >= dynamicConfig.fastFrames ) {

				fastCount = 0;
				raiseScale( '连续 ' + dynamicConfig.fastFrames + ' 帧显卡有余量' );

			}

		} else {

			fastCount = 0;

		}

	}

	// 没有显卡计时：按帧间隔判断，以开场卡量出的"刷新间隔"为基准——被垂直同步或浏览器限帧卡住时不算慢
	function onFrame( frameMs ) {

		if ( forced || gpuTiming.enabled || quality.tier === 'pano' ) return;
		if ( ! Number.isFinite( frameMs ) || frameMs <= 0 ) return;

		// 超过 250 ms 的是卡顿（加载、切标签页），不代表显卡负载，打断计数
		if ( frameMs > 250 ) {

			slowCount = 0;
			fastCount = 0;
			return;

		}

		recentIntervals.push( frameMs );
		if ( recentIntervals.length > 60 ) recentIntervals.shift();

		// 上次降分辨率以后过了 60 帧：帧间隔几乎没变（还剩 93% 以上），说明不是显卡跟不上，是被浏览器限帧了
		if ( downscaleCheck !== null ) {

			downscaleCheck.frames ++;
			if ( downscaleCheck.frames >= 60 ) {

				const after = medianOf( recentIntervals.slice( - 45 ) );
				if ( after > downscaleCheck.before * 0.93 ) {

					refreshInterval = snapPeriod( after );
					if ( quality.tier !== downscaleCheck.tier ) setTier( downscaleCheck.tier );
					quality.renderScale = downscaleCheck.scale;
					quality.pendingTier = null;
					updateMode();
					console.log( `画质：降了分辨率帧间隔也没变（${ downscaleCheck.before.toFixed( 1 ) } → ${ after.toFixed( 1 ) } ms），是浏览器限帧，不是显卡跟不上；刷新间隔按 ${ refreshInterval.toFixed( 1 ) } ms 算，退回 ${ quality.tier } ${ quality.renderScale.toFixed( 2 ) }` );

				}

				downscaleCheck = null;

			}

		}

		const slowThreshold = Math.max( dynamicConfig.slowFrameMs, refreshInterval * 1.45 );
		if ( frameMs > slowThreshold ) {

			slowCount ++;
			fastCount = 0;
			if ( slowCount >= dynamicConfig.slowFrames && downscaleCheck === null ) {

				slowCount = 0;
				const before = { before: medianOf( recentIntervals.slice( - 30 ) ), tier: quality.tier, scale: quality.renderScale, frames: 0 };
				lowerScale( '连续 ' + dynamicConfig.slowFrames + ' 帧明显掉帧（超过 ' + slowThreshold.toFixed( 1 ) + ' ms）' );
				downscaleCheck = before;

			}

			return;

		}

		slowCount = 0;
		const [ , maxScale ] = scaleRangeOf( quality.tier );
		// 稳稳跟上刷新间隔一段时间、离上次降比例也够久了，才试着升回去
		if ( quality.renderScale < maxScale - 1e-6 && frameMs <= refreshInterval * 1.1 && performance.now() - lastDownscaleTime > dynamicConfig.raiseCooldown * 1000 ) {

			fastCount ++;
			if ( fastCount >= dynamicConfig.fastFrames * 2 ) {

				fastCount = 0;
				raiseScale( '连续 ' + dynamicConfig.fastFrames * 2 + ' 帧跟得上刷新' );

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
			downscaleCheck = null;

		} );

	}

	// 初始档位：强制 > 显卡名的先验（基准测试在点开场卡时再定）
	const initialTier = forced ? normalizedForced : detectInitialTier( ctx.backend, ctx.gpuName ).tier;
	quality.tier = initialTier;
	quality.content = contentOf( initialTier );
	quality.params = qualityConfig.tiers[ quality.content ];
	quality.renderScale = scaleRangeOf( initialTier )[ 1 ];
	applyResolution();

	console.log( `画质初始档位 ${ initialTier }${ forced ? '（强制）' : '（显卡名先验，开场卡点开后跑基准测试）' }，像素比 ${ renderer.getPixelRatio().toFixed( 2 ) }，场景比例 ${ quality.renderScale }` );

	return quality;

}
