// 场景时间线：顺序播放、转场、预加载下一场景、退出后释放。契约见 reference/notes/design-stage0.md 第 9 节，规则见 CLAUDE.md 5.2~5.4。

import * as THREE from 'three/webgpu';

function smoothStep( edge0, edge1, value ) {

	const t = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return t * t * ( 3 - 2 * t );

}

export function createTimeline( ctx, sceneModules ) {

	const config = ctx.config;
	const transitionConfig = config.transition;

	if ( ! Array.isArray( sceneModules ) || sceneModules.length !== config.scenes.length ) {

		throw new Error( `时间线：场景模块数量（${ sceneModules ? sceneModules.length : 0 }）和 config.scenes（${ config.scenes.length }）对不上` );

	}

	const entries = sceneModules.map( ( module, index ) => {

		const sceneConfig = config.scenes[ index ];
		if ( module.key !== sceneConfig.key ) {

			throw new Error( `时间线：第 ${ index } 个场景模块的 key 是 ${ module.key }，config 里是 ${ sceneConfig.key }` );

		}

		return { module, config: sceneConfig, scene: null, inited: false, failed: false, initPromise: null };

	} );

	const state = {
		index: - 1,
		sceneTime: 0,
		phase: 'idle',     // idle | playing | transition | ended
		paused: false,
		transitionTime: 0,
	};

	const endCallbacks = [];
	let endFired = false;
	let generation = 0;           // 重播时 +1，让旧代次的后台 init 完成后自己释放
	let switching = false;        // 转场中途正在等目标场景 init
	let switched = false;         // 本次转场是否已经切过场景
	let transitionTarget = - 1;
	let jumpTarget = - 1;         // jumpTo 正在等它 init 的场景
	const flashColorFrom = new THREE.Color();
	const flashColorTo = new THREE.Color();
	const flashColor = new THREE.Color();
	const white = new THREE.Color( 0xffffff );

	// ===== 初始化与释放 =====

	// 哪些场景允许留在内存里：当前、下一个、转场目标、跳转目标；其余 init 完就立刻释放
	function shouldKeep( index ) {

		if ( state.index < 0 ) return true;
		if ( index === state.index || index === state.index + 1 ) return true;
		if ( state.phase === 'transition' && index === transitionTarget ) return true;
		if ( index === jumpTarget ) return true;
		return false;

	}

	function ensureInit( index ) {

		const entry = entries[ index ];
		if ( ! entry ) return Promise.resolve( false );
		if ( entry.inited ) return Promise.resolve( true );
		if ( entry.initPromise ) return entry.initPromise;

		entry.failed = false;
		const myGeneration = generation;
		entry.initPromise = ( async () => {

			const started = performance.now();
			const result = await entry.module.init( ctx );
			if ( ! result || ! result.scene || ! result.scene.isScene ) {

				throw new Error( 'init 没有返回 { scene }' );

			}

			entry.scene = result.scene;
			await ctx.renderer.compileAsync( entry.scene, ctx.camera );

			if ( myGeneration !== generation || ! shouldKeep( index ) ) {

				// 加载期间重播过了或者已经跳到别处，这份用不上，直接释放
				entry.module.dispose();
				entry.scene = null;
				entry.inited = false;
				console.log( `时间线：场景「${ entry.config.name }」加载完成时已经用不上，已释放` );
				return false;

			}

			entry.inited = true;
			console.log( `时间线：场景「${ entry.config.name }」加载并预编译完成，用时 ${ ( performance.now() - started ).toFixed( 0 ) } ms` );
			return true;

		} )().catch( ( error ) => {

			entry.failed = true;
			entry.inited = false;
			entry.scene = null;
			console.error( `时间线：场景「${ entry.config.name }」初始化失败，播放时会跳过它：`, error );
			return false;

		} ).finally( () => {

			entry.initPromise = null;

		} );

		return entry.initPromise;

	}

	function disposeEntry( index ) {

		const entry = entries[ index ];
		if ( ! entry || ! entry.inited ) return;

		try {

			entry.module.dispose();

		} catch ( error ) {

			console.error( `时间线：释放场景「${ entry.config.name }」时出错：`, error );

		}

		entry.scene = null;
		entry.inited = false;

	}

	function logMemory( label ) {

		const memory = ctx.renderer.info.memory;
		console.log( `时间线：${ label }，几何体 ${ memory.geometries }，贴图 ${ memory.textures }，渲染目标 ${ memory.renderTargets }，程序 ${ memory.programs }` );

	}

	// 从 index 往后找第一个没失败的场景；没有返回 -1
	function nextPlayableIndex( fromIndex ) {

		for ( let i = fromIndex; i < entries.length; i ++ ) {

			if ( ! entries[ i ].failed ) return i;

		}

		return - 1;

	}

	function enterScene( index, time = 0 ) {

		const entry = entries[ index ];
		if ( ! entry.inited ) {

			throw new Error( `时间线：场景「${ entry.config.name }」还没 init 就要 enter` );

		}

		ctx.pipeline.setScene( entry.scene );
		ctx.pipeline.setGrading( entry.config.grading );
		entry.module.enter();
		ctx.audio.playScene( entry.config.key );

		state.index = index;
		state.sceneTime = time;
		ctx.director.setTime( time );
		entry.module.update( 0, time );

		logMemory( `进入场景 ${ index + 1 }「${ entry.config.name }」` );

		preloadNext();

	}

	function preloadNext() {

		const nextIndex = state.index + 1;
		if ( nextIndex >= entries.length ) return;
		if ( entries[ nextIndex ].inited || entries[ nextIndex ].initPromise ) return;

		// 不 await，后台加载；失败已经在 ensureInit 里打印
		ensureInit( nextIndex );

	}

	// ===== 对外：准备、开始 =====

	async function prepareFirst() {

		const first = nextPlayableIndex( 0 );
		if ( first < 0 ) throw new Error( '时间线：没有任何场景可以播放' );
		const ok = await ensureInit( first );
		if ( ! ok ) {

			// 第一个失败就试下一个，全失败才报错
			for ( let i = first + 1; i < entries.length; i ++ ) {

				if ( await ensureInit( i ) ) return;

			}

			throw new Error( '时间线：所有场景都初始化失败' );

		}

	}

	function start() {

		const first = nextPlayableIndex( 0 );
		if ( first < 0 || ! entries[ first ].inited ) {

			throw new Error( '时间线：start 之前要先 prepareFirst' );

		}

		state.phase = 'playing';
		state.paused = false;
		endFired = false;
		enterScene( first, 0 );

	}

	// ===== 转场 =====

	function beginTransition() {

		const target = nextPlayableIndex( state.index + 1 );
		if ( target < 0 ) {

			finish();
			return;

		}

		transitionTarget = target;
		state.phase = 'transition';
		state.transitionTime = 0;
		switched = false;
		switching = false;
		flashColorFrom.set( entries[ state.index ].config.mainColor );
		flashColorTo.set( entries[ target ].config.mainColor );

	}

	function finish() {

		if ( endFired ) return;
		endFired = true;
		state.phase = 'ended';
		console.log( '时间线：最后一个场景播放完毕，停留在结尾' );

		for ( const callback of endCallbacks ) {

			try {

				callback();

			} catch ( error ) {

				console.error( '时间线：结尾回调出错：', error );

			}

		}

	}

	function applyTransitionLook( progress ) {

		const peakAt = transitionConfig.peakAt;
		const amount = progress < peakAt
			? smoothStep( 0, peakAt, progress )
			: 1 - smoothStep( peakAt, 1, progress );

		const targetStyle = entries[ transitionTarget ].config.transitionStyle;

		if ( targetStyle === 'canvas' ) {

			ctx.pipeline.setCanvasReveal( amount );
			ctx.pipeline.setFlash( 0 );

		} else {

			flashColor.copy( flashColorFrom ).lerp( flashColorTo, progress ).lerp( white, transitionConfig.whiteness );
			ctx.pipeline.setFlash( amount, flashColor );
			ctx.pipeline.setCanvasReveal( 0 );

		}

	}

	function doSwitch() {

		const oldIndex = state.index;
		const entry = entries[ oldIndex ];

		try {

			entry.module.exit();

		} catch ( error ) {

			console.error( `时间线：场景「${ entry.config.name }」exit 出错：`, error );

		}

		disposeEntry( oldIndex );
		enterScene( transitionTarget, 0 );
		switched = true;

	}

	function updateTransition( dt ) {

		const duration = transitionConfig.duration;
		const peakAt = transitionConfig.peakAt;

		if ( ! switching ) state.transitionTime += dt;

		let progress = Math.min( 1, state.transitionTime / duration );

		// 到最亮点切场景；目标还没 init 完就停在最亮点等
		if ( ! switched && progress >= peakAt ) {

			progress = peakAt;

			if ( ! switching ) {

				const target = entries[ transitionTarget ];

				if ( target.inited ) {

					doSwitch();

				} else if ( target.failed ) {

					// 预加载失败了，跳到再下一个
					const fallback = nextPlayableIndex( transitionTarget + 1 );
					if ( fallback < 0 ) {

						ctx.pipeline.setFlash( 0 );
						ctx.pipeline.setCanvasReveal( 0 );
						finish();
						return;

					}

					transitionTarget = fallback;
					flashColorTo.set( entries[ fallback ].config.mainColor );

				} else {

					switching = true;
					console.log( `时间线：下一场景「${ target.config.name }」还没加载完，在最亮处等待` );
					ensureInit( transitionTarget ).then( () => {

						switching = false;

					} );

				}

			}

		}

		// 旧场景（或切换后的新场景）继续更新
		const current = entries[ state.index ];
		if ( current.inited ) {

			state.sceneTime += dt;
			ctx.director.setTime( state.sceneTime );
			current.module.update( dt, state.sceneTime );

		}

		applyTransitionLook( progress );

		if ( switched && progress >= 1 ) {

			state.phase = 'playing';
			ctx.pipeline.setFlash( 0 );
			ctx.pipeline.setCanvasReveal( 0 );

		}

	}

	// ===== 每帧 =====

	function update( dt ) {

		if ( state.paused ) return;
		if ( state.phase === 'idle' ) return;

		if ( state.phase === 'transition' ) {

			updateTransition( dt );
			return;

		}

		const entry = entries[ state.index ];
		if ( ! entry || ! entry.inited ) return;

		state.sceneTime += dt;
		ctx.director.setTime( state.sceneTime );
		entry.module.update( dt, state.sceneTime );

		if ( state.phase === 'playing' && state.sceneTime >= entry.config.duration ) {

			if ( state.index >= entries.length - 1 || nextPlayableIndex( state.index + 1 ) < 0 ) {

				finish();

			} else {

				beginTransition();

			}

		}

	}

	// ===== 跳转、暂停、重播 =====

	async function jumpTo( index, time = 0 ) {

		if ( ! Number.isInteger( index ) || index < 0 || index >= entries.length ) return false;
		if ( switching ) {

			console.warn( '时间线：转场切换进行中，稍后再跳' );
			return false;

		}

		const target = entries[ index ];
		if ( target.failed && ! target.inited ) {

			console.warn( `时间线：场景「${ target.config.name }」之前初始化失败，再试一次` );

		}

		ctx.pipeline.setFlash( 0 );
		ctx.pipeline.setCanvasReveal( 0 );

		if ( state.index === index && target.inited ) {

			seek( time );
			state.phase = index === entries.length - 1 && time >= target.config.duration ? 'ended' : 'playing';
			return true;

		}

		jumpTarget = index;
		const ok = await ensureInit( index );
		jumpTarget = - 1;
		if ( ! ok ) {

			console.error( `时间线：跳转失败，场景「${ target.config.name }」无法初始化` );
			return false;

		}

		if ( state.index >= 0 && entries[ state.index ].inited && state.index !== index ) {

			try {

				entries[ state.index ].module.exit();

			} catch ( error ) {

				console.error( '时间线：exit 出错：', error );

			}

			disposeEntry( state.index );

		}

		state.phase = 'playing';
		endFired = false;
		enterScene( index, Math.max( 0, time ) );

		// 跳着走时可能留下别的已加载场景（比如原来的下一个），不是当前和下一个的都释放
		for ( let i = 0; i < entries.length; i ++ ) {

			if ( entries[ i ].inited && ! shouldKeep( i ) ) disposeEntry( i );

		}

		return true;

	}

	function seek( time ) {

		const entry = entries[ state.index ];
		if ( ! entry || ! entry.inited ) return;
		state.sceneTime = Math.min( entry.config.duration, Math.max( 0, time ) );
		ctx.director.setTime( state.sceneTime );
		entry.module.update( 0, state.sceneTime );

	}

	function pause() {

		state.paused = true;

	}

	function resume() {

		state.paused = false;

	}

	function togglePause() {

		state.paused = ! state.paused;
		console.log( state.paused ? '时间线：已暂停' : '时间线：继续' );
		return state.paused;

	}

	async function restart() {

		if ( switching ) return false;

		if ( state.index >= 0 && entries[ state.index ].inited ) {

			try {

				entries[ state.index ].module.exit();

			} catch ( error ) {

				console.error( '时间线：exit 出错：', error );

			}

		}

		for ( let i = 0; i < entries.length; i ++ ) {

			disposeEntry( i );
			entries[ i ].failed = false;

		}

		ctx.pipeline.setFlash( 0 );
		ctx.pipeline.setCanvasReveal( 0 );
		state.index = - 1;
		state.phase = 'idle';
		endFired = false;
		generation ++;
		await waitIdle();
		logMemory( '重播前已释放全部场景' );

		await prepareFirst();
		start();
		return true;

	}

	// 等所有后台 init 结束（截图脚本取内存快照前用，重播前也用）
	function waitIdle() {

		const pending = entries.map( ( entry ) => entry.initPromise ).filter( Boolean );
		return Promise.all( pending ).then( () => true );

	}

	function onEnd( callback ) {

		if ( typeof callback === 'function' ) endCallbacks.push( callback );

	}

	function getCurrentEntry() {

		return state.index >= 0 ? entries[ state.index ] : null;

	}

	return {
		state,
		prepareFirst,
		preloadNext,
		start,
		update,
		jumpTo,
		seek,
		pause,
		resume,
		togglePause,
		restart,
		waitIdle,
		onEnd,
		getTime: () => state.sceneTime,
		getDuration: () => ( getCurrentEntry() ? getCurrentEntry().config.duration : 0 ),
		isPaused: () => state.paused,
		getSceneIndex: () => state.index,
		getSceneKey: () => ( getCurrentEntry() ? getCurrentEntry().config.key : '' ),
		// 每个场景的加载状态：已加载 / 加载中 / 失败 / 空，调试和截图脚本看
		getLoadStates: () => entries.map( ( entry ) => entry.inited ? '已加载' : ( entry.initPromise ? '加载中' : ( entry.failed ? '失败' : '空' ) ) ),
		getSceneList: () => config.scenes.map( ( scene ) => scene.name ),
	};

}
