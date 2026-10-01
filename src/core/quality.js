// 画质分档 + 动态分辨率。契约见 reference/notes/design-stage0.md 第 4 节，规则见 CLAUDE.md 6.1。
// 所有数字从 ctx.config.quality 读。

import { safeSetSize } from './renderer.js';

const tierOrder = [ 'hi', 'mid', 'lo' ];

function isValidTier( tier ) {

	return tierOrder.includes( tier );

}

// 比较两档高低：返回更低的那一档
function lowerOf( tierA, tierB ) {

	return tierOrder.indexOf( tierA ) >= tierOrder.indexOf( tierB ) ? tierA : tierB;

}

// 降一档；lo 不再降，返回 null
function nextLowerTier( tier ) {

	const index = tierOrder.indexOf( tier );
	return index >= 0 && index < tierOrder.length - 1 ? tierOrder[ index + 1 ] : null;

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

export function createQuality( ctx, forcedTier ) {

	const qualityConfig = ctx.config.quality;
	const dynamicConfig = qualityConfig.dynamic;
	const renderer = ctx.renderer;

	const forced = isValidTier( forcedTier );
	if ( forcedTier !== undefined && forcedTier !== null && forcedTier !== '' && ! forced ) {

		console.warn( `画质参数 ?q=${ forcedTier } 不合法，只接受 hi / mid / lo，改为自动判断` );

	}

	const tierCallbacks = [];

	// 动态分辨率的连续计数
	let slowCount = 0;
	let fastCount = 0;
	let bottomWarned = false;   // lo 档 + 最低比例还卡时只提示一次

	function detectInitialTier( backend, gpuName ) {

		const name = typeof gpuName === 'string' ? gpuName.toLowerCase() : '';
		const matched = qualityConfig.integratedKeywords.find( ( keyword ) => name.includes( String( keyword ).toLowerCase() ) );

		let tier = matched ? 'mid' : 'hi';
		if ( matched ) console.log( `显卡名含「${ matched }」，判定为核显，从中档起步` );

		// WebGL2 兜底路径最高只给到 webglMaxTier
		if ( backend === 'webgl2' && isValidTier( qualityConfig.webglMaxTier ) ) {

			const clamped = lowerOf( tier, qualityConfig.webglMaxTier );
			if ( clamped !== tier ) console.log( `WebGL2 后端，档位从 ${ tier } 压到 ${ clamped }` );
			tier = clamped;

		}

		return tier;

	}

	const quality = {
		tier: 'hi',
		params: null,
		renderScale: 1,
		gpuMs: 0,
		gpuSamples: [],
		detectInitialTier,
		runBenchmark,
		onFrame,
		afterRender,
		applyResolution,
		setTier,
		onTierChange,
	};

	function applyResolution() {

		const devicePixelRatio = ( typeof window !== 'undefined' && Number.isFinite( window.devicePixelRatio ) && window.devicePixelRatio > 0 )
			? window.devicePixelRatio
			: 1;
		const params = quality.params;
		const pixelRatio = Math.min( devicePixelRatio, params.pixelRatioCap, params.pixelRatio ) * quality.renderScale;

		if ( ! Number.isFinite( pixelRatio ) || pixelRatio <= 0 ) {

			console.warn( `像素比算出来不合法（${ pixelRatio }），本次不改分辨率` );
			return;

		}

		// 只改像素比不碰 CSS，画面自动拉伸；相同值 setPixelRatio 内部直接 return
		renderer.setPixelRatio( pixelRatio );
		safeSetSize( renderer, window.innerWidth, window.innerHeight );

	}

	function setTier( tier ) {

		if ( ! isValidTier( tier ) ) {

			console.warn( `档位 ${ tier } 不合法，只接受 hi / mid / lo，忽略` );
			return;

		}

		quality.tier = tier;
		quality.params = qualityConfig.tiers[ tier ];
		quality.renderScale = 1;
		slowCount = 0;
		fastCount = 0;
		bottomWarned = false;

		applyResolution();

		for ( let i = 0; i < tierCallbacks.length; i ++ ) {

			try {

				tierCallbacks[ i ]( tier, quality.params );

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

	// ===================== 怎么判断"显卡跟不跟得上" =====================
	// 不能只看两帧之间隔了多久：显示器 60Hz 时帧间隔被垂直同步卡在 16.7 ms，再快也看不出来；
	// 浏览器窗口被遮住、失焦，或者笔记本拔电源开了省电模式时，浏览器会把帧率压到 30，帧间隔变成 33 ms，
	// 但显卡其实很闲——按帧间隔判断会一路误降到最低档、渲染比例 0.5，画面糊成一片，而且再也升不回来。
	// 所以：WebGPU 有时间戳查询时，直接读显卡每帧实际干活的时间（不受垂直同步和限帧影响）；
	// 没有时（WebGL2 大多没有），先在什么都不画的空帧里量出"刷新间隔"（或被限到的间隔），
	// 只有帧间隔明显比它长（掉帧）才算慢，被限帧时不算。

	const gpuTiming = {
		enabled: ctx.gpuTiming === true,
		pending: false,
		framesSinceResolve: 0,
	};
	// 没有显卡计时时用的"刷新间隔"（毫秒）：只从开场基准测试的空帧量来（吸附到常见刷新率），不拿渲染中的帧去估——
	// 渲染一直慢时，拿渲染帧估出来的"刷新间隔"会跟着变慢，就再也不降分辨率了。
	// 运行中被浏览器限帧（省电模式、后台）：降了分辨率以后帧间隔一点没变，就判定是限帧，把刷新间隔改成量到的值，分辨率退回去
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

	function medianOf( values ) {

		const sorted = values.slice().sort( ( first, second ) => first - second );
		return sorted[ Math.floor( sorted.length / 2 ) ];

	}

	if ( gpuTiming.enabled ) console.log( '画质：用显卡时间戳判断负载（不受垂直同步和浏览器限帧影响）' );

	// 每画完一帧调一次：把这几帧的显卡时间结算出来（异步，不等）
	function afterRender() {

		if ( ! gpuTiming.enabled ) return;
		gpuTiming.framesSinceResolve ++;
		if ( gpuTiming.pending ) return;

		gpuTiming.framesSinceResolve = 0;
		gpuTiming.pending = true;
		renderer.resolveTimestampsAsync( 'render' ).then( ( duration ) => {

			gpuTiming.pending = false;
			// three r186 两个后端的 resolveTimestampsAsync 返回的都是"最近结算到的那一帧"的显卡时间
			// （TimestampQueryPool：framesDuration[ 最后一帧 ]），不是这几帧的总和，不能再除以帧数
			if ( typeof duration === 'number' && Number.isFinite( duration ) && duration > 0 ) {

				// 调试面板看的平均显卡时间（毫秒 / 帧，指数平均）；性能探针读最近的原始值
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
		intervals.sort( ( first, second ) => first - second );
		return intervals[ Math.floor( intervals.length / 2 ) ];

	}

	// 开场页基准测试：跑 benchmarkSeconds 秒。
	// 有显卡计时：平均显卡时间超过这一档的预算就降一档；没有：帧间隔比空帧的刷新间隔长 25% 以上才算慢
	async function runBenchmark( renderOneFrame ) {

		if ( forced ) {

			console.log( '档位由 ?q=' + quality.tier + ' 强制指定，跳过基准测试' );
			return quality.tier;

		}

		if ( typeof renderOneFrame !== 'function' ) {

			console.warn( '基准测试没有拿到渲染函数，保持当前档位' );
			return quality.tier;

		}

		const idle = await measureIdleInterval( 24 );
		if ( idle !== null ) refreshInterval = snapPeriod( idle );

		const durationMs = qualityConfig.benchmarkSeconds * 1000;
		const warmupFrames = 10;   // 前几帧有着色器编译和缓存抖动，丢掉
		const startTime = performance.now();
		let previousTimestamp = null;
		let frameIndex = 0;
		let sampleCount = 0;
		let sampleSum = 0;
		let gpuSum = 0;
		let gpuCount = 0;

		while ( performance.now() - startTime < durationMs ) {

			const frame = await waitFrame( 250 );

			if ( ! frame.real ) {

				// 页面被隐藏了，rAF 不跑，这段时间不计入
				previousTimestamp = null;
				continue;

			}

			try {

				renderOneFrame();

			} catch ( error ) {

				throw new Error( '基准测试渲染出错：' + ( error && error.message ? error.message : error ) );

			}

			frameIndex ++;
			if ( frameIndex > warmupFrames ) {

				if ( previousTimestamp !== null ) {

					sampleCount ++;
					sampleSum += frame.timestamp - previousTimestamp;

				}

				if ( gpuTiming.enabled ) {

					const duration = await renderer.resolveTimestampsAsync( 'render' ).catch( () => null );
					if ( typeof duration === 'number' && Number.isFinite( duration ) && duration > 0 ) {

						gpuSum += duration;
						gpuCount ++;

					}

				}

			} else if ( gpuTiming.enabled ) {

				// 预热帧的时间戳也要结算掉，不然算进下一帧
				await renderer.resolveTimestampsAsync( 'render' ).catch( () => null );

			}

			previousTimestamp = frame.timestamp;

		}

		if ( sampleCount === 0 ) {

			console.warn( '基准测试没有采到有效帧（页面可能被隐藏），保持当前档位 ' + quality.tier );
			return quality.tier;

		}

		const averageMs = sampleSum / sampleCount;
		let slow;
		if ( gpuCount > 0 ) {

			const gpuMs = gpuSum / gpuCount;
			const budget = dynamicConfig.gpuBudgetMs[ quality.tier ];
			slow = gpuMs > budget;
			console.log( '基准测试：' + gpuCount + ' 帧，显卡平均 ' + gpuMs.toFixed( 2 ) + ' ms（预算 ' + budget + ' ms），帧间隔平均 ' + averageMs.toFixed( 2 ) + ' ms，当前档位 ' + quality.tier );

		} else {

			const threshold = Math.max( qualityConfig.benchmarkDowngradeMs, refreshInterval * 1.25 );
			slow = averageMs > threshold;
			console.log( '基准测试：' + sampleCount + ' 帧，帧间隔平均 ' + averageMs.toFixed( 2 ) + ' ms，空帧刷新间隔 ' + refreshInterval.toFixed( 2 ) + ' ms，阈值 ' + threshold.toFixed( 2 ) + ' ms，当前档位 ' + quality.tier );

		}

		if ( slow ) {

			const lower = nextLowerTier( quality.tier );
			if ( lower ) {

				console.log( '基准测试超出预算，档位 ' + quality.tier + ' → ' + lower );
				setTier( lower );

			} else {

				console.log( '已经是最低档，不再下降' );

			}

		} else {

			console.log( '基准测试通过，保持 ' + quality.tier + ' 档' );

		}

		return quality.tier;

	}

	function lowerScale( reason ) {

		const step = dynamicConfig.step;
		const minScale = dynamicConfig.minScale;
		lastDownscaleTime = performance.now();

		if ( quality.renderScale > minScale + 1e-6 ) {

			// 乘 100 再除是为了避免 0.1 累加出 0.7000000001
			quality.renderScale = Math.max( minScale, Math.round( ( quality.renderScale - step ) * 100 ) / 100 );
			applyResolution();
			console.log( reason + '，渲染比例降到 ' + quality.renderScale.toFixed( 2 ) );
			return;

		}

		const lower = nextLowerTier( quality.tier );
		if ( lower ) {

			console.log( '渲染比例已到最低 ' + minScale + ' 还超出预算，档位 ' + quality.tier + ' → ' + lower );
			setTier( lower );

		} else if ( ! bottomWarned ) {

			bottomWarned = true;
			console.warn( '已经是最低档 + 最低渲染比例，仍然超出预算，没有更多可降的了' );

		}

	}

	function raiseScale( reason ) {

		quality.renderScale = Math.min( 1, Math.round( ( quality.renderScale + dynamicConfig.step ) * 100 ) / 100 );
		applyResolution();
		console.log( reason + '，渲染比例升到 ' + quality.renderScale.toFixed( 2 ) );

	}

	// 有显卡计时：按这一档的显卡时间预算调渲染比例。
	// 升比例前先估算：像素数和比例的平方成正比，升完预计还在预算的 85% 以内才升，免得来回抖
	function onGpuFrame( gpuMs ) {

		if ( forced ) return;
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
		if ( quality.renderScale >= 1 - 1e-6 ) {

			fastCount = 0;
			return;

		}

		const nextScale = Math.min( 1, quality.renderScale + dynamicConfig.step );
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

	// 没有显卡计时：按帧间隔判断，但以"刷新间隔"为基准——被垂直同步或浏览器限帧卡住时不算慢
	function onFrame( frameMs ) {

		if ( forced || gpuTiming.enabled ) return;
		if ( ! Number.isFinite( frameMs ) || frameMs <= 0 ) return;

		// 超过 250 ms 的是卡顿（加载、编译、切标签页），不代表显卡负载，打断计数
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
					applyResolution();
					console.log( `画质：降了分辨率帧间隔也没变（${ downscaleCheck.before.toFixed( 1 ) } → ${ after.toFixed( 1 ) } ms），是浏览器限帧，不是显卡跟不上；刷新间隔按 ${ refreshInterval.toFixed( 1 ) } ms 算，分辨率退回 ${ quality.renderScale.toFixed( 2 ) }` );

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
		// 稳稳跟上刷新间隔一段时间、离上次降比例也够久了，才试着升回去
		if ( quality.renderScale < 1 - 1e-6 && frameMs <= refreshInterval * 1.1 && performance.now() - lastDownscaleTime > dynamicConfig.raiseCooldown * 1000 ) {

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

	// 初始档位：强制 > 自动判断
	const initialTier = forced ? forcedTier : detectInitialTier( ctx.backend, ctx.gpuName );
	quality.tier = initialTier;
	quality.params = qualityConfig.tiers[ initialTier ];
	applyResolution();

	console.log( `画质初始档位 ${ initialTier }${ forced ? '（强制）' : '（自动）' }，像素比 ${ renderer.getPixelRatio().toFixed( 2 ) }` );

	return quality;

}
