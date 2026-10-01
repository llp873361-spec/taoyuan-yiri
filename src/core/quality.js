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
		detectInitialTier,
		runBenchmark,
		onFrame,
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

	// 开场页基准测试：跑 benchmarkSeconds 秒，平均帧时间超过阈值就降一档
	async function runBenchmark( renderOneFrame ) {

		if ( forced ) {

			console.log( `档位由 ?q=${ quality.tier } 强制指定，跳过基准测试` );
			return quality.tier;

		}

		if ( typeof renderOneFrame !== 'function' ) {

			console.warn( '基准测试没有拿到渲染函数，保持当前档位' );
			return quality.tier;

		}

		const durationMs = qualityConfig.benchmarkSeconds * 1000;
		const warmupFrames = 10;   // 前几帧有着色器编译和缓存抖动，丢掉
		const startTime = performance.now();
		let previousTimestamp = null;
		let frameIndex = 0;
		let sampleCount = 0;
		let sampleSum = 0;
		let sampleMax = 0;

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

				throw new Error( `基准测试渲染出错：${ error && error.message ? error.message : error }` );

			}

			if ( previousTimestamp !== null ) {

				const frameMs = frame.timestamp - previousTimestamp;
				frameIndex ++;

				if ( frameIndex > warmupFrames && frameMs > 0 ) {

					sampleCount ++;
					sampleSum += frameMs;
					if ( frameMs > sampleMax ) sampleMax = frameMs;

				}

			}

			previousTimestamp = frame.timestamp;

		}

		if ( sampleCount === 0 ) {

			console.warn( '基准测试没有采到有效帧（页面可能被隐藏），保持当前档位 ' + quality.tier );
			return quality.tier;

		}

		const averageMs = sampleSum / sampleCount;
		const threshold = qualityConfig.benchmarkDowngradeMs;
		console.log( `基准测试：${ sampleCount } 帧，平均 ${ averageMs.toFixed( 2 ) } ms，最慢 ${ sampleMax.toFixed( 1 ) } ms，阈值 ${ threshold } ms，当前档位 ${ quality.tier }` );

		if ( averageMs > threshold ) {

			const lower = nextLowerTier( quality.tier );
			if ( lower ) {

				console.log( `基准测试平均帧时间超标，档位 ${ quality.tier } → ${ lower }` );
				setTier( lower );

			} else {

				console.log( '已经是最低档，不再下降' );

			}

		} else {

			console.log( `基准测试通过，保持 ${ quality.tier } 档` );

		}

		return quality.tier;

	}

	// 每帧调：连续慢帧降比例，连续快帧升比例；降到底还卡就降一档
	function onFrame( frameMs ) {

		if ( forced ) return;   // 强制档位时跳过所有自动调整
		if ( ! Number.isFinite( frameMs ) || frameMs <= 0 ) return;

		const step = dynamicConfig.step;
		const minScale = dynamicConfig.minScale;

		if ( frameMs > dynamicConfig.slowFrameMs ) {

			slowCount ++;
			fastCount = 0;

			if ( slowCount >= dynamicConfig.slowFrames ) {

				slowCount = 0;

				if ( quality.renderScale > minScale + 1e-6 ) {

					// 乘 100 再除是为了避免 0.1 累加出 0.7000000001
					quality.renderScale = Math.max( minScale, Math.round( ( quality.renderScale - step ) * 100 ) / 100 );
					applyResolution();
					console.log( `连续 ${ dynamicConfig.slowFrames } 帧超过 ${ dynamicConfig.slowFrameMs } ms，渲染比例降到 ${ quality.renderScale.toFixed( 2 ) }` );

				} else {

					const lower = nextLowerTier( quality.tier );
					if ( lower ) {

						console.log( `渲染比例已到最低 ${ minScale } 还卡，档位 ${ quality.tier } → ${ lower }` );
						setTier( lower );

					} else if ( ! bottomWarned ) {

						bottomWarned = true;
						console.warn( '已经是最低档 + 最低渲染比例，仍然掉帧，没有更多可降的了' );

					}

				}

			}

		} else if ( frameMs < dynamicConfig.fastFrameMs ) {

			fastCount ++;
			slowCount = 0;

			if ( fastCount >= dynamicConfig.fastFrames ) {

				fastCount = 0;

				if ( quality.renderScale < 1 - 1e-6 ) {

					quality.renderScale = Math.min( 1, Math.round( ( quality.renderScale + step ) * 100 ) / 100 );
					applyResolution();
					console.log( `连续 ${ dynamicConfig.fastFrames } 帧低于 ${ dynamicConfig.fastFrameMs } ms，渲染比例升到 ${ quality.renderScale.toFixed( 2 ) }` );

				}

			}

		} else {

			// 中间地带的一帧打断两边的连续计数
			slowCount = 0;
			fastCount = 0;

		}

	}

	// 初始档位：强制 > 自动判断
	const initialTier = forced ? forcedTier : detectInitialTier( ctx.backend, ctx.gpuName );
	quality.tier = initialTier;
	quality.params = qualityConfig.tiers[ initialTier ];
	applyResolution();

	console.log( `画质初始档位 ${ initialTier }${ forced ? '（强制）' : '（自动）' }，像素比 ${ renderer.getPixelRatio().toFixed( 2 ) }` );

	return quality;

}
