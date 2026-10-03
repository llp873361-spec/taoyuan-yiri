// 时间线：一天的顺序（规格书 5.2）、地点之间飞过去（5.3）、同色薄雾交接、预加载和预编译、方向键跳转、再走一遍、结尾。
//
// 阶段：idle（开场卡）→ playing（停留在某个地点）→ flight（飞往下一个地点）→ playing → … → ended（最后一个地点停稳）；
// 方向键、再走一遍走 jump（同色薄雾淡出、在雾里换地点、淡入）。
// 坐标：停留时画地点自己的场景（地点局部坐标），常驻远景的根节点挂进去、用 world.worldToAnchorMatrix 换到局部坐标；
// 飞行巡航时只画远景自己的场景（世界坐标）。两次切换都发生在薄雾到顶（整屏都是雾）的那几帧，相机远近、深度压缩、
// 替身显隐都在这一刻换，看不出来。同一个 ctx.camera 贯穿全程，每帧由这里把世界位姿换到当前场景的坐标。
// 编译：下一个地点在停留期间（8 秒后、她没在动时，最迟停留一半）后台 init，再按主场景真正画的上下文异步预编译，
// 最后在小目标上热身画一帧（阴影、反射）。飞行途中不启动、不推进任何编译；没准备好就继续停留。
// 阶段 12：引路（花瓣、光点，tsl/guide.js）每帧按阶段写路径和队形；有窄处（leg.frame）的航段不再在到达时起雾，
// 而是在窄处里面换场景：窄处暗、曝光抬高，出口过曝，曝光约 1.4 秒落回（"豁然开朗"）。

import * as THREE from 'three/webgpu';
import { createFlight } from './flight.js';
import { hasPanorama, flightVideoOf } from '../scenes/panorama.js';

function clamp( value, low, high ) {

	return Math.min( high, Math.max( low, value ) );

}

function smoothStep( edge0, edge1, value ) {

	const t = clamp( ( value - edge0 ) / ( edge1 - edge0 ), 0, 1 );
	return t * t * ( 3 - 2 * t );

}

// 时刻总是往前走：from → to 跨过午夜也对（setDayTime 自己会对 24 取模）
function hoursLerp( from, to, amount ) {

	return from + ( ( ( to - from ) % 24 ) + 24 ) % 24 * amount;

}

// panoramaModules：每个地点的全景替身（pano 档用，见 scenes/panorama.js），和 sceneModules 一一对应
export function createTimeline( ctx, sceneModules, panoramaModules = [] ) {

	const config = ctx.config;
	const world = ctx.world;
	const backdrop = ctx.backdrop;
	const timelineConfig = config.timeline;
	const flightConfig = config.world.flight;
	const veilConfig = flightConfig.veil;
	const guideConfig = config.guide;

	if ( ! world || ! backdrop ) throw new Error( '时间线：ctx.world 和 ctx.backdrop 要先建好' );
	if ( ! Array.isArray( sceneModules ) || sceneModules.length !== config.scenes.length ) {

		throw new Error( `时间线：场景模块数量（${ sceneModules ? sceneModules.length : 0 }）和 config.scenes（${ config.scenes.length }）对不上` );

	}

	const entries = sceneModules.map( ( module, index ) => {

		const sceneConfig = config.scenes[ index ];
		if ( module.key !== sceneConfig.key ) {

			throw new Error( `时间线：第 ${ index } 个场景模块的 key 是 ${ module.key }，config 里是 ${ sceneConfig.key }` );

		}

		if ( ! world.locations[ sceneConfig.key ] ) throw new Error( `时间线：config.world.locations 里没有地点「${ sceneConfig.key }」` );
		const panoramaModule = panoramaModules[ index ] || null;
		if ( panoramaModule && panoramaModule.key !== sceneConfig.key ) throw new Error( `时间线：第 ${ index } 个全景替身的 key 是 ${ panoramaModule.key }，config 里是 ${ sceneConfig.key }` );
		return { module, realModule: module, panoramaModule, config: sceneConfig, key: sceneConfig.key, hours: world.locationHours( sceneConfig.key ), scene: null, inited: false, failed: false, initPromise: null };

	} );

	const state = {
		index: - 1,         // 当前画的地点；飞行中到达切换之前是出发地，之后是目的地
		sceneTime: 0,       // 当前地点的时间（进入地点或到达切换时归零）
		phase: 'idle',      // idle | playing | flight | jump | ended
		paused: false,
		worldTime: 0,       // 连续时钟（云、窗灯、镜头晃动），换地点不归零
		overtime: 0,        // 停留到点以后多等的秒数
		preloadStarted: false,
		preloadTarget: - 1,
		loadWaitWarned: false,
		flight: null,
		jump: null,
		storm: null,        // "再走一遍"先起的花瓣风暴 { time }
	};

	const endCallbacks = [];
	let endFired = false;
	let jumpToken = 0;
	let jumpTargetHold = - 1;   // 瞬时 jumpTo 正在等它 init 的地点（要留着）
	const phaseLog = [];   // 每次换阶段记一条（截图脚本把长任务按阶段归类）

	const flightCamera = { near: flightConfig.near, far: flightConfig.far };
	// pano 档飞行时画的空场景（视频盖在画布上面）；远景没建的时候（pano 档一开始就判定）飞行也用它
	const emptyScene = new THREE.Scene();
	emptyScene.name = '飞行（全景模式）';
	emptyScene.background = new THREE.Color( 0x000000 );

	// 现在是不是该用全景替身：pano 档、而且这个地点烘焙过
	function wantsPanorama( entry ) {

		return Boolean( ctx.quality && ctx.quality.tier === 'pano' && entry.panoramaModule && hasPanorama( entry.key ) );

	}

	function backdropBuilt() {

		return Boolean( backdrop.getRoot() );

	}
	const warmCamera = new THREE.PerspectiveCamera( ctx.camera.fov, ctx.camera.aspect, 0.1, 2000 );
	const tempPosition = new THREE.Vector3();
	const tempQuaternion = new THREE.Quaternion();
	const tempTarget = new THREE.Vector3();
	const tempMatrix = new THREE.Matrix4();
	const flightPose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
	const framePosition = new THREE.Vector3();
	const frameQuaternion = new THREE.Quaternion();

	function logPhase( phase, detail = '' ) {

		phaseLog.push( { time: performance.now(), phase, detail } );
		if ( phaseLog.length > 400 ) phaseLog.shift();
		if ( typeof performance.mark === 'function' ) performance.mark( `时间线:${ phase }${ detail ? ':' + detail : '' }` );

	}

	function logMemory( label ) {

		const memory = ctx.renderer.info.memory;
		console.log( `时间线：${ label }，几何体 ${ memory.geometries }，贴图 ${ memory.textures }，渲染目标 ${ memory.renderTargets }，程序 ${ memory.programs }` );

	}

	// ===== 远景挂到哪个场景上 =====

	// withBackdrop = false：全景替身的场景自己就是完整的画面，不挂远景
	function attachBackdrop( scene, key, withBackdrop = true ) {

		world.setAnchor( key );
		const view = key ? world.locationView( key ) : null;
		const root = backdrop.getRoot();
		if ( root && withBackdrop ) {

			root.matrixAutoUpdate = false;
			world.worldToAnchorMatrix( root.matrix );
			root.matrixWorldNeedsUpdate = true;
			scene.add( root );
			root.updateMatrixWorld( true );
			for ( const proxyKey of backdrop.getProxyKeys() ) backdrop.setProxyVisible( proxyKey, ! ( view && key === proxyKey && view.hideProxy ) );
			backdrop.resetLocationSettings();

		} else if ( root && root.parent && root.parent !== backdrop.getScene() ) {

			// 远景还挂在别的场景上：摘回它自己的场景（不画）
			backdrop.getScene().add( root );

		}

		const camera = ctx.camera;
		camera.near = view ? view.near : flightCamera.near;
		camera.far = view ? view.far : flightCamera.far;
		camera.updateProjectionMatrix();
		// 压缩要在改完 far 之后设（终点不能超过 0.85 × far）
		if ( root ) {

			if ( view && view.compressStart && withBackdrop ) backdrop.setCompression( view.compressStart, view.compressEnd );
			else backdrop.setCompression( null );

		}

		ctx.pipeline.setScene( scene );

	}

	// 飞行时画的场景：远景自己的场景（世界坐标）；全景模式飞行（视频）或远景没建时画空场景
	function useFlightScene( panorama = false ) {

		if ( panorama || ! backdropBuilt() ) attachBackdrop( emptyScene, null, false );
		else attachBackdrop( backdrop.getScene(), null );

	}

	// ===== 初始化、预编译、释放 =====

	// 哪些地点允许留在内存里：当前、预加载目标、飞行目标、跳转目标；别的 init 完就立刻释放
	function shouldKeep( index ) {

		if ( state.index < 0 ) return true;
		if ( index === state.index || index === state.preloadTarget ) return true;
		if ( state.flight && index === state.flight.to ) return true;
		if ( state.jump && index === state.jump.target ) return true;
		return index === jumpTargetHold;

	}

	// 出生点（地点局部坐标的 { position, lookAt }）：模块自己给，没有就站在原点、朝 yaw 方向略微低头
	function getSpawn( entry ) {

		if ( typeof entry.module.getSpawn === 'function' ) {

			const spawn = entry.module.getSpawn();
			if ( spawn && Array.isArray( spawn.position ) && Array.isArray( spawn.lookAt ) ) return spawn;
			console.warn( `时间线：「${ entry.config.name }」的 getSpawn 返回的格式不对，用默认出生点` );

		}

		const location = world.locations[ entry.key ];
		const [ x, y, z ] = location.origin;
		const ground = backdrop.getTerrainHeight( x, z );
		const eye = Math.max( y, ( Number.isFinite( ground ) ? ground : world.worldHeight( x, z ) ) + config.camera.eyeHeight ) - y;
		return { position: [ 0, eye, 0 ], lookAt: [ 0, eye - 3.5, - 100 ] };

	}

	// 预编译：热身相机放在出生点（视锥剔除在编译时是关掉的，放哪都行，主要是让相机相关的节点一致）；
	// 地点场景、远景（按这个地点的灯光和雾）、模块自己的辅助渲染（反射、极光、环境光贴图）并发编译；
	// 编完在 4×4 的同格式小目标上真画一帧，把阴影这些 compileAsync 编不到的变体建好
	async function compileEntry( entry ) {

		if ( entry.module.customCompile ) {

			warmCamera.near = 0.1;
			warmCamera.far = 30000;
			warmCamera.position.set( 0, 0, 0 );
			warmCamera.lookAt( 0, 0, - 1 );
			warmCamera.updateProjectionMatrix();
			warmCamera.updateMatrixWorld();
			await entry.module.compile( warmCamera );
			return;

		}

		const view = world.locationView( entry.key );
		const spawn = getSpawn( entry );
		warmCamera.near = view.near;
		warmCamera.far = view.far;
		warmCamera.fov = ctx.camera.fov;
		warmCamera.aspect = ctx.camera.aspect;
		warmCamera.position.fromArray( spawn.position );
		warmCamera.lookAt( tempTarget.fromArray( spawn.lookAt ) );
		warmCamera.updateProjectionMatrix();
		warmCamera.updateMatrixWorld();

		const jobs = [
			ctx.pipeline.compileScene( entry.scene, warmCamera ),
			ctx.pipeline.compileScene( backdrop.getRoot(), warmCamera, entry.scene ),
		];
		if ( typeof entry.module.compile === 'function' ) jobs.push( entry.module.compile( warmCamera ) );
		await Promise.all( jobs );
		ctx.pipeline.warmUp( entry.scene, warmCamera );

	}

	function ensureInit( index ) {

		const entry = entries[ index ];
		if ( ! entry ) return Promise.resolve( false );
		if ( entry.inited ) return Promise.resolve( true );
		if ( entry.initPromise ) return entry.initPromise;

		entry.failed = false;
		// 按现在的档位挑实时场景还是全景替身
		entry.module = wantsPanorama( entry ) ? entry.panoramaModule : entry.realModule;
		entry.initPromise = ( async () => {

			const started = performance.now();
			logPhase( 'compile-start', entry.key );
			const result = await entry.module.init( ctx );
			if ( ! result || ! result.scene || ! result.scene.isScene ) throw new Error( 'init 没有返回 { scene }' );
			entry.scene = result.scene;
			const initDone = performance.now();
			await compileEntry( entry );

			if ( ! shouldKeep( index ) ) {

				// 加载期间已经跳到别处，这份用不上，直接释放
				entry.module.dispose();
				entry.scene = null;
				entry.inited = false;
				console.log( `时间线：场景「${ entry.config.name }」加载完成时已经用不上，已释放` );
				return false;

			}

			entry.inited = true;
			logPhase( 'compile-end', entry.key );
			console.log( `时间线：场景「${ entry.config.name }」加载并预编译完成，用时 ${ ( performance.now() - started ).toFixed( 0 ) } ms（init ${ ( initDone - started ).toFixed( 0 ) }，编译 ${ ( performance.now() - initDone ).toFixed( 0 ) }）` );
			return true;

		} )().catch( ( error ) => {

			entry.failed = true;
			entry.inited = false;
			if ( entry.scene ) {

				try {

					entry.module.dispose();

				} catch ( disposeError ) {

					console.error( `时间线：释放加载失败的场景「${ entry.config.name }」时出错：`, disposeError );

				}

			}

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
		const root = backdrop.getRoot();
		if ( root && entry.scene && root.parent === entry.scene ) {

			console.error( `时间线：释放「${ entry.config.name }」时远景还挂在它上面，先摘下来（否则会跟着一起被释放）` );
			useFlightScene( ! backdropBuilt() );

		}

		try {

			entry.module.dispose();

		} catch ( error ) {

			console.error( `时间线：释放场景「${ entry.config.name }」时出错：`, error );

		}

		entry.scene = null;
		entry.inited = false;

	}

	// 从 index 往后找第一个没失败的地点；没有返回 -1
	function nextPlayableIndex( fromIndex ) {

		for ( let i = fromIndex; i < entries.length; i ++ ) {

			if ( ! entries[ i ].failed ) return i;

		}

		return - 1;

	}

	function previousPlayableIndex( fromIndex ) {

		for ( let i = fromIndex; i >= 0; i -- ) {

			if ( ! entries[ i ].failed ) return i;

		}

		return - 1;

	}

	// ===== 进出地点 =====

	function hoursAt( entry, time ) {

		return hoursLerp( entry.hours[ 0 ], entry.hours[ 1 ], clamp( time / entry.config.duration, 0, 1 ) );

	}

	// options.arrival：'cave' = 从开场的山洞里原地接过来（花园接着走出洞），别的情况（开始、方向键、再走一遍）是 undefined
	function enterLocation( index, time = 0, options = {} ) {

		const entry = entries[ index ];
		if ( ! entry.inited ) throw new Error( `时间线：场景「${ entry.config.name }」还没 init 就要进入` );

		ctx.director.clearExternal();
		ctx.director.setFlightDragLimit( null );
		attachBackdrop( entry.scene, entry.key, ! entry.module.isPanorama );
		if ( backdropBuilt() ) for ( const proxyKey of backdrop.getProxyKeys() ) backdrop.setProxyWindows( proxyKey, 1 );
		ctx.pipeline.setGrading( entry.config.grading );
		ctx.pipeline.setCanvasReveal( entry.config.arrival === 'canvas' ? 1 : 0 );
		// 明暗适应：进洞交接时保持（花园出洞时自己落回 1），别的进场方式都从 1 开始
		if ( options.arrival !== 'cave' ) ctx.pipeline.setAdaptation( 1 );
		world.setDayTime( hoursAt( entry, time ) );
		entry.module.enter( options );
		ctx.audio.playScene( entry.key );

		state.index = index;
		state.sceneTime = time;
		state.overtime = 0;
		state.preloadStarted = false;
		state.preloadTarget = - 1;
		state.loadWaitWarned = false;
		ctx.director.setTime( time );
		entry.module.update( 0, time );
		logMemory( `进入地点 ${ index + 1 }「${ entry.config.name }」` );

	}

	function leaveLocation( index ) {

		const entry = entries[ index ];
		if ( ! entry || ! entry.inited ) return;
		const root = backdrop.getRoot();
		if ( root && root.parent === entry.scene ) useFlightScene( ! backdropBuilt() );

		try {

			entry.module.exit();

		} catch ( error ) {

			console.error( `时间线：场景「${ entry.config.name }」exit 出错：`, error );

		}

		backdrop.resetLocationSettings();
		disposeEntry( index );

	}

	// ===== 准备、开始 =====

	// 开场卡阶段：建常驻远景并编译飞行时画的那个场景
	async function prepareWorld() {

		const started = performance.now();
		// 烘焙的地形（main.js 启动时就在后台解压）：地点、飞行、远景都按它取高度，先等它挂上
		ctx.terrainBake = await ctx.terrainBakePromise;
		if ( entries.every( ( entry ) => wantsPanorama( entry ) ) ) {

			// pano 档：每个地点都有烘焙好的全景，飞行是视频，常驻远景用不上（软件渲染下建它要十几秒），不建
			useFlightScene( true );
			console.log( '时间线：全景模式，每个地点都有烘焙好的全景，常驻远景不建' );
			return;

		}

		await backdrop.init( ctx );
		useFlightScene();
		await ctx.pipeline.compileScene( backdrop.getScene(), ctx.camera );
		console.log( `时间线：常驻远景准备好了，用时 ${ ( performance.now() - started ).toFixed( 0 ) } ms` );

	}

	async function prepareFirst() {

		const first = nextPlayableIndex( 0 );
		if ( first < 0 ) throw new Error( '时间线：没有任何场景可以播放' );
		if ( await ensureInit( first ) ) {

			// 开场在洞里原地交给花园，没有飞行可以等：开场卡上把花园也准备好（规格书 5.1：预编译开场序列 + 花园）
			const next = nextPlayableIndex( first + 1 );
			if ( next >= 0 && entries[ next ].config.arrival === 'cave' ) await ensureInit( next );
			return;

		}

		// 第一个失败就试下一个，全失败才报错
		for ( let i = first + 1; i < entries.length; i ++ ) {

			if ( await ensureInit( i ) ) return;

		}

		throw new Error( '时间线：所有场景都初始化失败' );

	}

	function start() {

		const first = entries.findIndex( ( entry ) => entry.inited );
		if ( first < 0 ) throw new Error( '时间线：start 之前要先 prepareFirst' );
		state.paused = false;
		endFired = false;
		enterLocation( first, 0 );
		state.phase = 'playing';
		logPhase( 'stay', entries[ first ].key );

	}

	function finish() {

		if ( endFired ) return;
		endFired = true;
		state.phase = 'ended';
		logPhase( 'ended' );
		console.log( '时间线：最后一个地点停稳，到了结尾' );

		for ( const callback of endCallbacks ) {

			try {

				callback();

			} catch ( error ) {

				console.error( '时间线：结尾回调出错：', error );

			}

		}

	}

	// ===== 停留 =====

	function updateCurrentLocation( dt ) {

		const entry = entries[ state.index ];
		if ( ! entry || ! entry.inited ) return;
		state.sceneTime += dt;
		world.setDayTime( hoursAt( entry, state.sceneTime ) );
		ctx.director.setTime( state.sceneTime );
		entry.module.update( dt, state.sceneTime );

	}

	// 停留 preloadDelay 秒后、她静止 preloadIdle 秒，或者到了停留的 preloadLatestFraction，开始准备下一个地点（每个地点只触发一次）
	function schedulePreload() {

		if ( state.preloadStarted ) return;
		const entry = entries[ state.index ];
		const next = nextPlayableIndex( state.index + 1 );
		if ( next < 0 ) return;
		const idleEnough = state.sceneTime >= timelineConfig.preloadDelay && ctx.director.getIdleSeconds() >= timelineConfig.preloadIdle;
		const latest = state.sceneTime >= entry.config.duration * timelineConfig.preloadLatestFraction;
		if ( ! idleEnough && ! latest ) return;
		startPreload( next );

	}

	function startPreload( next ) {

		state.preloadStarted = true;
		state.preloadTarget = next;
		ensureInit( next );

	}

	function updateStay( dt ) {

		updateCurrentLocation( dt );
		const entry = entries[ state.index ];
		if ( ! entry || ! entry.inited ) return;
		schedulePreload();
		if ( state.sceneTime < entry.config.duration ) return;

		const next = nextPlayableIndex( state.index + 1 );
		if ( next < 0 ) {

			finish();
			return;

		}

		if ( entries[ next ].config.arrival === 'cave' ) tryCaveHandoff( dt, next );
		else tryDepart( dt, next );

	}

	// 开场 → 花园：在洞里原地交接，不飞（规格书 5.3）。下一个地点没准备好就在洞里多停一会儿（镜头停在交接处）；
	// 全景替身没有洞，交接用一次很短的同色薄雾
	function tryCaveHandoff( dt, next ) {

		state.overtime += dt;
		const target = entries[ next ];
		if ( target.inited && target.module !== ( wantsPanorama( target ) ? target.panoramaModule : target.realModule ) ) {

			disposeEntry( next );
			state.preloadStarted = false;

		}

		if ( ! target.inited ) {

			if ( ! state.preloadStarted || state.preloadTarget !== next ) startPreload( next );
			else if ( ! target.initPromise ) ensureInit( next );
			if ( state.overtime > timelineConfig.loadMaxWait && ! state.loadWaitWarned ) {

				state.loadWaitWarned = true;
				console.warn( `时间线：「${ target.config.name }」多等了 ${ timelineConfig.loadMaxWait } 秒还没准备好，在洞里继续等` );

			}

			return;

		}

		const from = state.index;
		if ( entries[ from ].module.isPanorama || target.module.isPanorama ) {

			requestJump( next, { seconds: 0.8 } );
			return;

		}

		leaveLocation( from );
		enterLocation( next, 0, { arrival: 'cave' } );
		state.phase = 'playing';
		logPhase( 'stay', target.key );
		console.log( `时间线：在洞里交给「${ target.config.name }」` );

	}

	// 到点了：下一个地点没准备好就继续停留（规格书：最多 20 秒，超过只报一次、继续等，不能飞去没编好的地点）；
	// 她正在走就等她停下 departIdle 秒，最多多等 departMaxWait 秒
	function tryDepart( dt, next ) {

		state.overtime += dt;
		const target = entries[ next ];
		// 档位等着在起飞时变（降到 pano、插上电以后升回去）：远景没建就不能离开 pano。
		// 这里提前换只为进出 pano（目的地要换成全景替身或实时场景再加载）；hi ↔ mid 留到 beginFlight 真起飞时换，
		// 不然她还在地点里走着（等她停下最多十几秒）画面就先变了
		const panoChange = ctx.quality && ctx.quality.pendingTier !== null && ( ctx.quality.pendingTier === 'pano' || ctx.quality.tier === 'pano' );
		if ( panoChange && ( ctx.quality.pendingTier === 'pano' || backdropBuilt() ) ) ctx.quality.onDeparture();
		// 目的地已经按另一种方式加载好了（实时 / 全景）：放掉重新加载
		if ( target.inited && target.module !== ( wantsPanorama( target ) ? target.panoramaModule : target.realModule ) ) {

			console.log( `时间线：档位变了，「${ target.config.name }」改用${ wantsPanorama( target ) ? '全景替身' : '实时场景' }重新加载` );
			disposeEntry( next );
			state.preloadStarted = false;

		}

		if ( ! target.inited ) {

			if ( ! state.preloadStarted || state.preloadTarget !== next ) startPreload( next );
			else if ( ! target.initPromise && ! target.inited ) ensureInit( next );
			if ( state.overtime > timelineConfig.loadMaxWait && ! state.loadWaitWarned ) {

				state.loadWaitWarned = true;
				console.warn( `时间线：「${ target.config.name }」多等了 ${ timelineConfig.loadMaxWait } 秒还没准备好，继续停留等它` );

			}

			return;

		}

		if ( ctx.director.getIdleSeconds() < timelineConfig.departIdle && state.overtime < timelineConfig.departMaxWait ) return;
		beginFlight( next );

	}

	// ===== 飞行 =====

	function findLeg( fromKey, toKey ) {

		return config.world.legs.find( ( leg ) => leg.from === fromKey && leg.to === toKey ) || null;

	}

	// 看得见的地面：远景网格画出来的高度和水面取高的
	function groundAt( x, z ) {

		const mesh = backdrop.getTerrainHeight( x, z );
		const sample = world.sample( x, z );
		return Math.max( Number.isFinite( mesh ) ? mesh : sample.height, sample.waterLevel );

	}

	function beginFlight( next ) {

		const from = entries[ state.index ];
		const to = entries[ next ];

		// 起点：她现在的位姿（没加晃动），从出发地的局部坐标换到世界
		ctx.director.getBasePose( tempPosition, tempQuaternion );
		const start = {
			position: world.toWorld( tempPosition, from.key, new THREE.Vector3() ),
			quaternion: world.quaternionToWorld( tempQuaternion, from.key, new THREE.Quaternion() ),
		};

		// 终点：目的地的出生点
		const spawn = getSpawn( to );
		tempPosition.fromArray( spawn.position );
		tempMatrix.lookAt( tempPosition, tempTarget.fromArray( spawn.lookAt ), THREE.Object3D.DEFAULT_UP );
		tempQuaternion.setFromRotationMatrix( tempMatrix );
		const end = {
			position: world.toWorld( tempPosition, to.key, new THREE.Vector3() ),
			quaternion: world.quaternionToWorld( tempQuaternion, to.key, new THREE.Quaternion() ),
		};

		const leg = findLeg( from.key, to.key );
		const label = `${ world.locations[ from.key ].name } → ${ world.locations[ to.key ].name }`;
		const panoramaFlight = to.module.isPanorama || ! backdropBuilt();
		// 目的地自己有地形块（落日的半岛）时，离地按它和远景取高的（窄处从地点自己的山里穿过来，不能钻进山里）
		const ownGround = typeof to.module.ownGroundAt === 'function' ? to.module.ownGroundAt : null;
		const toOrigin = world.locations[ to.key ].origin;
		const flightGround = ownGround ? ( x, z ) => {

			const local = world.toLocal( tempTarget.set( x, 0, z ), to.key, tempPosition.clone() );
			const own = ownGround( local.x, local.z );
			const visible = groundAt( x, z );
			return Number.isFinite( own ) ? Math.max( visible, own + toOrigin[ 1 ] ) : visible;

		} : groundAt;
		const path = panoramaFlight ? createPanoramaFlight( from.key, to.key ) : createFlight( { groundAt: flightGround, flightConfig, leg, start, end, label } );

		state.flight = {
			from: state.index,
			to: next,
			path,
			time: 0,
			departed: false,
			arrived: false,
			fromSceneTime: state.sceneTime,
		};
		state.phase = 'flight';
		state.overtime = 0;
		logPhase( 'flight', `${ from.key }-${ to.key }` );
		if ( ctx.quality && typeof ctx.quality.onDeparture === 'function' ) ctx.quality.onDeparture();
		// 画质：记下离开时的场景比例，飞行中只降不升，到达时恢复（quality.js onFlightStart / onArrival）
		if ( ctx.quality && typeof ctx.quality.onFlightStart === 'function' ) ctx.quality.onFlightStart();
		applyFlightPose( state.flight );

	}

	// 当前渲染的是哪个坐标系：出发切换之前是出发地，到达切换之后是目的地，中间是世界
	function flightFrameKey( flight ) {

		if ( ! flight.departed ) return entries[ flight.from ].key;
		if ( flight.arrived ) return entries[ flight.to ].key;
		return null;

	}

	// 全景模式的飞行：播烘焙好的视频（前 0.5 秒淡入盖住出发地，最后 0.5 秒淡出露出目的地的全景）；
	// 没烘焙视频就是 3 秒的同色薄雾交接。镜头不动（画布被视频盖住，或者在雾里）
	function createPanoramaFlight( fromKey, toKey ) {

		const video = ctx.flightVideo && flightVideoOf( fromKey, toKey );
		if ( video ) {

			ctx.flightVideo.prepare( fromKey, toKey ).catch( ( error ) => console.error( '全景：飞行视频准备失败：', error ) );
			return { panorama: true, video: true, duration: video.duration, departSwitchAt: 0.5, arriveSwitchAt: video.duration - 0.5, length: 0, cruiseSpeed: 0 };

		}

		console.warn( `全景：没有「${ fromKey } → ${ toKey }」的飞行视频，改成薄雾交接` );
		return { panorama: true, video: false, duration: 3, departSwitchAt: 1.45, arriveSwitchAt: 1.55, length: 0, cruiseSpeed: 0 };

	}

	function applyFlightPose( flight ) {

		if ( flight.path.panorama ) return;
		flight.path.sample( Math.min( flight.time, flight.path.duration ), flightPose );
		const key = flightFrameKey( flight );
		world.toLocal( flightPose.position, key, framePosition );
		world.quaternionToLocal( flightPose.quaternion, key, frameQuaternion );
		ctx.director.setExternalPose( framePosition, frameQuaternion, ctx.camera.fov );

	}

	// 一段飞行里的各条包络（0~1），时间 t 秒，总长 T 秒
	function flightEnvelopes( flight ) {

		const t = flight.time;
		const T = flight.path.duration;
		const departInEnd = veilConfig.departIn;
		const departOutStart = departInEnd + veilConfig.departHold;
		const departOutEnd = departOutStart + veilConfig.departOut;
		const arriveOutEnd = T - veilConfig.clearBeforeEnd;
		const arriveOutStart = arriveOutEnd - veilConfig.arriveOut;
		const arriveInEnd = arriveOutStart - veilConfig.arriveHold;
		const arriveInStart = arriveInEnd - veilConfig.arriveIn;

		const frame = flight.path.frame;
		let veil = 0;
		if ( t < departOutEnd ) veil = t < departOutStart ? smoothStep( 0, departInEnd, t ) : 1 - smoothStep( departOutStart, departOutEnd, t );
		// 有窄处的航段到达时不起雾（在窄处里换场景）
		if ( t > arriveInStart && ! frame ) veil = Math.max( veil, t < arriveOutStart ? smoothStep( arriveInStart, arriveInEnd, t ) : 1 - smoothStep( arriveOutStart, arriveOutEnd, t ) );

		// 出发：天空先变成统一天空，内容化进雾里；到达：内容从雾里显出来，天空最后换回地点自己的
		let skyBlend = 1;
		let contentVeil = 1;
		if ( ! flight.departed ) {

			skyBlend = smoothStep( 0, departInEnd * 0.75, t );
			contentVeil = smoothStep( 0, departInEnd, t );

		} else if ( flight.arrived && frame ) {

			// 窄处里换的场景：地点内容 contentIn 秒从雾里显出来，天空 skyIn 秒换回地点自己的
			const since = t - frame.switchTime;
			skyBlend = 1 - smoothStep( 0.2, frame.settings.skyIn, since );
			contentVeil = 1 - smoothStep( 0, frame.settings.contentIn, since );

		} else if ( flight.arrived ) {

			skyBlend = 1 - smoothStep( T - 2.5, T, t );
			contentVeil = 1 - smoothStep( T - 2.9, T, t );

		}

		// 画布：离开星月夜时从中间往四周退去，进星月夜时从四周往中间蔓延（有窄处时从换场景前 1 秒就开始蔓延，盖住切换）
		// 离开星月夜：画布在起飞的薄雾底下退去，退完的时刻不晚于切出地点（原来 3.5 秒，切出时边上还有笔触，一下子没了）。
		// 不能不起雾直接退：画外真实的夜空几乎是黑的，亮蓝的画中间开一个黑洞（2026-10-02 试过）
		let canvas = 0;
		if ( entries[ flight.from ].config.arrival === 'canvas' ) canvas = 1 - smoothStep( 0, Math.min( flightConfig.canvasSeconds, flight.path.departSwitchAt - 0.1 ), t );

		if ( entries[ flight.to ].config.arrival === 'canvas' ) {

			const canvasStart = frame ? Math.min( T - flightConfig.canvasSeconds, frame.switchTime - 1 ) : T - flightConfig.canvasSeconds;
			canvas = Math.max( canvas, smoothStep( canvasStart, T, t ) );

		}

		// 巡航时的曝光补偿（夜里按天空亮度抬，公式同俯瞰模式）；两次切换的时刻都是 1，曝光连续。
		// 夜里（天光弱）补偿更强：有窄处时一直保留到进窄处（窄处里另有明暗适应）。原来落日 → 哥特约 20 秒近乎黑屏（2026-10-02 审查 R3）
		const intensity = world.uniforms.skyIntensity.value;
		const night = 1 - smoothStep( 0.15, 0.5, intensity );
		const cruiseLevel = 1 + ( 1 / ( 0.4 + 0.6 * Math.pow( Math.max( intensity, 1e-4 ), 0.7 ) ) - 1 ) * flightConfig.autoExposure * ( 1 + night * flightConfig.nightExposureBoost );
		const arriveFade = frame ? Math.min( flight.path.arriveSwitchAt, frame.entryTime + 1 ) : flight.path.arriveSwitchAt;
		// 夜里收得晚（进窄处前 0.8 秒才开始收），收掉的部分由下面窄处的适应接上
		const fadeStart = arriveFade - 3 + ( frame ? night * 1.2 : - night * 2 );
		const fadeOut = smoothStep( fadeStart, arriveFade, t );
		const cruise = smoothStep( flight.path.departSwitchAt, flight.path.departSwitchAt + 3, t ) * ( 1 - fadeOut );
		const exposureScale = 1 + ( cruiseLevel - 1 ) * cruise;

		// 窄处里的明暗适应：进去以后曝光慢慢抬高（白天抬得多，夜里少），出口那一下过曝，再 adaptationFall 秒落回 1。
		// 夜里窄处里的总曝光不低于巡航时的九成：巡航补偿收掉多少，适应就接上多少（原来进窄处时巡航的三四倍补偿收掉、
		// 换成 1.7 倍的适应，冰碛岗、林间小路里反而一下黑了，审查 R4）
		let adaptation = 1;
		if ( frame ) {

			const day = smoothStep( 0.15, 0.6, intensity );
			const peak = frame.settings.adaptation[ 1 ] + ( frame.settings.adaptation[ 0 ] - frame.settings.adaptation[ 1 ] ) * day;
			const fall = 1 - smoothStep( frame.exitTime, frame.exitTime + frame.settings.adaptationFall, t );
			adaptation = 1 + ( peak - 1 ) * smoothStep( frame.entryTime - 0.3, frame.entryTime + frame.settings.adaptationRise, t ) * fall;
			const nightLift = ( cruiseLevel * 0.9 - 1 ) * night * fadeOut * fall;
			if ( nightLift > 0 ) adaptation = Math.max( adaptation, ( exposureScale + nightLift ) / exposureScale );

		}

		return { veil, skyBlend, contentVeil, canvas, exposureScale, adaptation };

	}

	function departSwitch( flight ) {

		const from = flight.from;
		useFlightScene( Boolean( flight.path.panorama ) );
		leaveLocation( from );
		ctx.audio.playScene( 'flight' );
		flight.departed = true;
		logPhase( 'cruise', `${ entries[ from ].key }-${ entries[ flight.to ].key }` );
		logMemory( '出发' );

	}

	function arriveSwitch( flight ) {

		const entry = entries[ flight.to ];
		attachBackdrop( entry.scene, entry.key, ! entry.module.isPanorama );
		state.index = flight.to;
		state.sceneTime = 0;
		state.preloadStarted = false;
		state.preloadTarget = - 1;
		state.loadWaitWarned = false;
		world.uniforms.locationVeil.value = 1;
		world.uniforms.worldSkyBlend.value = 1;
		world.setDayTime( hoursAt( entry, 0 ) );
		entry.module.enter( flight.path.frame ? { arrival: 'frame', revealIn: flight.path.frame.settings.contentIn } : {} );
		ctx.audio.playScene( entry.key );
		flight.arrived = true;
		if ( ctx.quality && typeof ctx.quality.onArrival === 'function' ) ctx.quality.onArrival();
		ctx.director.setTime( 0 );
		entry.module.update( 0, 0 );
		logPhase( 'arrive', entry.key );
		logMemory( `到达「${ entry.config.name }」` );

	}

	function finishFlight( flight ) {

		const entry = entries[ flight.to ];
		ctx.director.clearExternal();
		ctx.director.setFlightDragLimit( null );
		if ( flight.path.frame ) ctx.pipeline.setAdaptation( 1 );
		if ( backdropBuilt() ) backdrop.setProxyWindows( entry.key, 1 );
		if ( ctx.flightVideo ) ctx.flightVideo.hide();
		ctx.pipeline.setVeil( 0 );
		world.uniforms.worldSkyBlend.value = 0;
		world.uniforms.locationVeil.value = 0;
		ctx.pipeline.setCanvasReveal( entry.config.arrival === 'canvas' ? 1 : 0 );
		ctx.pipeline.setGrading( entry.config.grading );
		state.flight = null;
		// 画质：飞行收尾结束，之后的帧才算进 hi → mid 的判断（quality.js onFlightEnd）
		if ( ctx.quality && typeof ctx.quality.onFlightEnd === 'function' ) ctx.quality.onFlightEnd();
		state.phase = 'playing';
		state.overtime = 0;
		logPhase( 'stay', entry.key );

	}

	function updateFlight( dt ) {

		const flight = state.flight;
		flight.time += dt;
		const path = flight.path;
		if ( ! flight.departed && flight.time >= path.departSwitchAt ) departSwitch( flight );
		if ( flight.departed && ! flight.arrived && flight.time >= path.arriveSwitchAt ) arriveSwitch( flight );

		const from = entries[ flight.from ];
		const to = entries[ flight.to ];
		const envelopes = flightEnvelopes( flight );
		if ( path.panorama ) {

			// 全景模式：视频的淡入淡出代替薄雾和调色；没视频时整段就是一次薄雾
			const T = path.duration;
			if ( path.video ) {

				envelopes.veil = 0;
				const opacity = Math.min( 1, flight.time / 0.5, ( T - flight.time ) / 0.5 );
				ctx.flightVideo.sync( flight.time, opacity, state.paused );

			} else {

				const amount = 1 - Math.abs( flight.time - T / 2 ) / ( T / 2 );
				envelopes.veil = Math.min( 1, Math.max( 0, amount * 1.6 ) );

			}

			envelopes.skyBlend = 0;
			envelopes.contentVeil = 0;
			envelopes.exposureScale = 1;

		}

		ctx.pipeline.setVeil( envelopes.veil, state.worldTime );
		// 夜里飞行时远景的月光补光抬高（地面、林子、小镇不至于一片死黑），按天光弱的程度；到达以后地点自己设
		if ( backdropBuilt() && ! path.panorama && ! flight.arrived ) {

			const night = 1 - smoothStep( 0.15, 0.5, world.uniforms.skyIntensity.value );
			backdrop.setNightFill( 1 + night * ( flightConfig.nightFill - 1 ) );
			// 月亮还没升高（19:30~21:00）时只有天光：天光环境项也抬（天越黑抬得越多），不然地面、林子一片死黑
			const dusk = 1 - smoothStep( 0.08, 0.6, world.uniforms.skyIntensity.value );
			backdrop.setAmbientStrength( 1 + dusk * ( flightConfig.nightAmbient - 1 ) );

		}

		world.uniforms.worldSkyBlend.value = envelopes.skyBlend;
		world.uniforms.locationVeil.value = envelopes.contentVeil;
		ctx.pipeline.setCanvasReveal( envelopes.canvas );
		if ( path.frame ) {

			ctx.pipeline.setAdaptation( envelopes.adaptation );
			// 到达前最后几秒拖动转头收紧（规格书：最后 6 秒 ±10°），不让她在窄处里转头看到墙外面
			const limited = flight.time > path.duration - path.frame.settings.dragLimitSeconds;
			ctx.director.setFlightDragLimit( limited ? [ path.frame.settings.dragYawMax, path.frame.settings.dragPitchMax ] : null );

		}

		// 飞往哪个地点，那个地点替身的窗先不亮（哥特：穿出林间小路以后真窗灯一扇扇亮）。
		// 星月夜的小镇不算：飞过小镇时窗是亮着的（原画里最暖的那几点，审查 R30），画布盖上来以后画里的窗接着亮
		if ( backdropBuilt() && ! path.panorama && to.key !== 'starry' ) backdrop.setProxyWindows( to.key, 0 );
		ctx.pipeline.setGradingBlend( from.config.grading, to.config.grading, smoothStep( path.departSwitchAt, path.arriveSwitchAt, flight.time ), envelopes.exposureScale );

		// 时刻：到达之前从出发地的最后时刻走到目的地的最初时刻，两头慢中间快（正午一掠而过）；到达以后按目的地的停留走
		if ( ! flight.arrived ) {

			world.setDayTime( hoursLerp( from.hours[ 1 ], to.hours[ 0 ], smoothStep( 0, path.arriveSwitchAt, flight.time ) ) );

		}

		applyFlightPose( flight );
		ctx.director.setTime( flight.time );

		// 出发地在切换之前继续动（海浪、极光），目的地在到达切换以后开始动
		if ( ! flight.departed && from.inited ) {

			flight.fromSceneTime += dt;
			from.module.update( dt, flight.fromSceneTime );

		} else if ( flight.arrived && to.inited ) {

			state.sceneTime += dt;
			world.setDayTime( hoursAt( to, state.sceneTime ) );
			to.module.update( dt, state.sceneTime );

		}

		if ( flight.time >= path.duration ) finishFlight( flight );

	}

	// ===== 方向键跳转、再走一遍：同色薄雾淡出、在雾里换地点、淡入 =====

	function requestJump( target, { seconds = timelineConfig.jumpVeilSeconds } = {} ) {

		if ( ! Number.isInteger( target ) || target < 0 || target >= entries.length ) return false;
		if ( state.phase === 'idle' ) return false;
		if ( state.jump ) {

			// 雾还没到顶就换目标（连按两下）：接着同一层雾走
			if ( ! state.jump.switched ) {

				state.jump.target = target;
				ensureInit( target );
				return true;

			}

			return false;

		}

		const half = Math.max( 0.1, seconds / 2 );
		state.jump = { target, time: 0, half, hold: 0.15, switched: false, waiting: false, previousPhase: state.phase, startVeil: ctx.pipeline.getVeil() };
		state.phase = 'jump';
		ensureInit( target );
		logPhase( 'jump', entries[ target ].key );
		return true;

	}

	function jumpSwitch( jump ) {

		const target = jump.target;
		if ( state.flight ) {

			// 飞行中跳：出发地如果还挂着就先离开；飞行目标不是跳转目标的话也不留
			const flight = state.flight;
			state.flight = null;
			// 飞行被打断也算到达、飞行结束：画质恢复离开时的比例、不再卡在"飞行中只降不升"
			if ( ctx.quality && typeof ctx.quality.onFlightEnd === 'function' ) ctx.quality.onFlightEnd();
			ctx.director.clearExternal();
			if ( ctx.flightVideo ) ctx.flightVideo.hide();
			if ( ! flight.departed && flight.from !== target ) leaveLocation( flight.from );
			if ( flight.to !== target && entries[ flight.to ].inited ) leaveLocation( flight.to );

		}

		if ( state.index >= 0 && state.index !== target && entries[ state.index ].inited ) leaveLocation( state.index );
		if ( state.index === target && entries[ target ].inited ) {

			// 跳回当前地点（在第一个地点点"再走一遍"）：退出再重新进，回到出生点
			try {

				entries[ target ].module.exit();

			} catch ( error ) {

				console.error( '时间线：exit 出错：', error );

			}

		}

		world.uniforms.worldSkyBlend.value = 0;
		enterLocation( target, 0 );
		endFired = false;
		jump.switched = true;
		jump.switchTime = jump.time;

		// 跳着走时可能留下别的已加载地点，不是当前的都释放
		for ( let i = 0; i < entries.length; i ++ ) {

			if ( i !== target && entries[ i ].inited && ! shouldKeep( i ) ) disposeEntry( i );

		}

	}

	function updateJump( dt ) {

		const jump = state.jump;
		if ( ! jump.waiting ) jump.time += dt;

		// 跳转前的地点照常动（飞行中跳的话镜头停在原地）
		if ( ! jump.switched && ! state.flight && state.index >= 0 ) updateCurrentLocation( dt );

		if ( ! jump.switched ) {

			const rising = jump.startVeil + ( 1 - jump.startVeil ) * smoothStep( 0, jump.half, jump.time );
			ctx.pipeline.setVeil( rising, state.worldTime );
			if ( jump.time < jump.half ) return;

			const target = entries[ jump.target ];
			if ( target.inited ) {

				jump.waiting = false;
				jumpSwitch( jump );

			} else if ( target.failed ) {

				console.error( `时间线：跳转失败，「${ target.config.name }」无法初始化，回到原来的画面` );
				state.jump = null;
				state.phase = jump.previousPhase;
				ctx.pipeline.setVeil( 0 );
				return;

			} else {

				// 雾到顶了目标还在加载：保持整屏薄雾等它（不是飞行，雾里编译是允许的）
				jump.waiting = true;
				if ( ! target.initPromise ) ensureInit( jump.target );
				return;

			}

		}

		updateCurrentLocation( dt );
		const fade = 1 - smoothStep( jump.switchTime + jump.hold, jump.switchTime + jump.hold + jump.half, jump.time );
		ctx.pipeline.setVeil( fade, state.worldTime );
		world.uniforms.locationVeil.value = fade;
		if ( fade <= 0 ) {

			state.jump = null;
			world.uniforms.locationVeil.value = 0;
			const entry = entries[ state.index ];
			const last = nextPlayableIndex( state.index + 1 ) < 0;
			state.phase = 'playing';
			if ( last && state.sceneTime >= entry.config.duration ) finish();
			logPhase( 'stay', entry.key );

		}

	}

	// ===== 每帧 =====

	// 在 director.update 之前调
	function update( dt ) {

		if ( state.paused || state.phase === 'idle' ) {

			ctx.director.setSwayClock( state.worldTime );
			return;

		}

		state.worldTime += dt;
		ctx.director.setSwayClock( state.worldTime );

		if ( state.storm ) {

			// 花瓣风暴：地点照常动，风暴起完再接原来的薄雾和黑场淡入
			state.storm.time += dt;
			if ( state.phase === 'playing' || state.phase === 'ended' ) updateCurrentLocation( dt );
			if ( state.storm.time >= guideConfig.stormSeconds ) {

				state.storm = null;
				const first = nextPlayableIndex( 0 );
				if ( first >= 0 ) requestJump( first, { seconds: timelineConfig.restartVeilSeconds } );

			}

			return;

		}

		if ( state.phase === 'jump' ) updateJump( dt );
		else if ( state.phase === 'flight' ) updateFlight( dt );
		else if ( state.phase === 'playing' ) updateStay( dt );
		else if ( state.phase === 'ended' ) updateCurrentLocation( dt );

	}

	// 在 director.update 之后、渲染之前调：远景按相机最终的位置重算（天空球跟着相机、场景坐标 → 世界坐标）
	function lateUpdate( dt ) {

		if ( state.phase === 'idle' && state.index < 0 ) return;
		if ( backdropBuilt() ) {

			backdrop.update( dt, state.worldTime );
			updateGuide( state.paused ? 0 : dt );

		}

	}

	// ===== 引路（规格书 5.3 阶段 12）=====
	// 每帧在镜头的最终位姿定下来以后（lateUpdate）算：路径点（世界坐标，从镜头往前）、队形、颜色。
	//   停留最后 gatherSeconds 秒：花瓣在身边聚起来打旋，再朝下一段航线第一个航点的方向飘出去；
	//   飞行：沿航线往前流，窄处里收拢，穿出窄处后散开淡出；没窄处的航段到达时随薄雾淡掉；
	//   开场：38 秒（林尽水源）起顺着船和人的路线流，领进山洞；花园出洞时接着流出洞口，出洞后散开淡出；
	//   再走一遍：先起一阵花瓣风暴（围着镜头越转越大），再接薄雾；方向键跳转：直接收起
	const guidePoints = Array.from( { length: 40 }, () => ( { x: 0, y: 0, z: 0, width: 1 } ) );
	const guideViewer = new THREE.Vector3();
	const guideForward = new THREE.Vector3();
	const guidePoint = new THREE.Vector3();
	const guideTarget = new THREE.Vector3();
	const guideColor = new THREE.Color();
	const guideNight = new THREE.Color( guideConfig.nightMoteColor );
	const guideDay = new THREE.Color( guideConfig.dayMoteColor );
	const guideSnow = new THREE.Color( guideConfig.snowMoteColor );
	const guideState = { phase: 0, amount: 0 };

	// 点到山洞中线（外口 → 内口）的水平距离：洞里的花瓣收得很窄
	function caveWidthAt( point ) {

		const outer = world.config.cave.outer;
		const inner = world.config.cave.inner;
		const axisX = inner[ 0 ] - outer[ 0 ];
		const axisZ = inner[ 2 ] - outer[ 2 ];
		const along = clamp( ( ( point.x - outer[ 0 ] ) * axisX + ( point.z - outer[ 2 ] ) * axisZ ) / ( axisX * axisX + axisZ * axisZ ), - 0.2, 1.2 );
		const inside = along > - 0.05 && along < 1.05 && Math.hypot( point.x - outer[ 0 ] - axisX * along, point.z - outer[ 2 ] - axisZ * along ) < 6;
		return inside ? 0.28 : 1;

	}

	// 沿地点自己的路线（开场、花园出洞，局部坐标）写路径：从现在走到的地方往前，每 spacing 米一个点
	function pathFromRoute( route, key, time, spacing ) {

		const start = route.distanceAt( time );
		for ( let k = 0; k < guidePoints.length; k ++ ) {

			route.pointAt( start + k * spacing, guidePoint );
			world.toWorld( guidePoint, key, guideTarget );
			const item = guidePoints[ k ];
			item.x = guideTarget.x;
			item.y = guideTarget.y;
			item.z = guideTarget.z;
			item.width = caveWidthAt( guideTarget );

		}

		return spacing * ( guidePoints.length - 1 );

	}

	// 从镜头朝某个世界点的水平方向飘出去，慢慢抬高（停留时朝下一段航线飘）
	function pathToward( target, spacing ) {

		guideForward.set( target.x - guideViewer.x, 0, target.z - guideViewer.z );
		if ( guideForward.lengthSq() < 1 ) guideForward.set( 0, 0, - 1 );
		guideForward.normalize();
		for ( let k = 0; k < guidePoints.length; k ++ ) {

			// 同飞行：从身后几米开始
			const along = k * spacing - guideConfig.behind * 0.5;
			const item = guidePoints[ k ];
			item.x = guideViewer.x + guideForward.x * along;
			item.y = guideViewer.y - 0.3 + Math.max( 0, along ) * 0.12;
			item.z = guideViewer.z + guideForward.z * along;
			item.width = 1;

		}

		return spacing * ( guidePoints.length - 1 );

	}

	function updateGuide( dt ) {

		const guide = backdrop.getGuide();
		if ( ! guide ) return;
		const uniforms = guide.uniforms;
		ctx.camera.updateMatrixWorld();
		guideViewer.setFromMatrixPosition( ctx.camera.matrixWorld ).applyMatrix4( backdrop.getSceneToWorld().value );

		let amount = 0;
		let gather = 0;
		let scatter = 0;
		let keep = 0;
		let swirl = 1;
		let flowSpeed = 0;
		let pathLength = 0;
		let gatherRadius = guideConfig.gatherRadius;
		let forcePetals = false;
		let moteScale = 1;
		const entry = state.index >= 0 ? entries[ state.index ] : null;
		const flight = state.flight;

		if ( state.storm ) {

			// 花瓣风暴：围着镜头越转越快、越转越大
			const progress = state.storm.time / guideConfig.stormSeconds;
			amount = smoothStep( 0, 0.25, progress );
			gather = 1;
			gatherRadius = guideConfig.gatherRadius * ( 0.8 + 2.4 * progress );
			swirl = 2.5 + 3 * progress;
			keep = 1;
			forcePetals = true;
			guideTarget.copy( guideViewer );
			guideTarget.z -= 50;
			pathLength = pathToward( guideTarget, guideConfig.staySpacing );

		} else if ( state.phase === 'flight' && flight && ! flight.path.panorama ) {

			const path = flight.path;
			const t = flight.time;
			const T = path.duration;
			const distance = path.distanceAt( t );
			const frame = path.frame;
			const narrowWidth = frame ? clamp( frame.settings.width / 12, 0.3, 1 ) : 1;
			// 路径从镜头身后 guideBehind 米开始：粒子取模换位发生在身后看不见的地方，再从身后涌上来、超过镜头往前流。
			// 剩下的航线不够 40 个点时按剩下的距离排（不然点都挤在终点，花瓣在出生点堆成一团）
			const behind = guideConfig.behind;
			const spacing = clamp( ( path.length - distance + behind ) / ( guidePoints.length - 1 ), 0.5, guideConfig.flightSpacing );
			for ( let k = 0; k < guidePoints.length; k ++ ) {

				const along = distance - behind + k * spacing;
				path.pointAtDistance( along, guidePoint );
				const item = guidePoints[ k ];
				item.x = guidePoint.x;
				item.y = guidePoint.y;
				item.z = guidePoint.z;
				// 窄处里（入口前 30 米到出口后 10 米）收拢
				const inside = frame ? smoothStep( frame.entryDistance - 30, frame.entryDistance, along ) * ( 1 - smoothStep( frame.exitDistance, frame.exitDistance + 10, along ) ) : 0;
				item.width = 1 + ( narrowWidth - 1 ) * inside;

			}

			pathLength = spacing * ( guidePoints.length - 1 );
			flowSpeed = guideConfig.flightFlowSpeed;
			keep = 1;
			// 起飞：停留时聚着的那团在薄雾里还围着镜头（离得近，不被雾吞），雾散的时候慢慢松开、被航线带走
			gather = 0.6 * ( 1 - smoothStep( 1.5, 5, t ) );
			gatherRadius = guideConfig.gatherRadius;
			if ( frame ) {

				scatter = smoothStep( frame.exitTime, frame.exitTime + guideConfig.scatterSeconds, t );
				amount = 1 - smoothStep( frame.exitTime + 0.5, Math.max( frame.exitTime + 1, T - 0.5 ), t );

			} else {

				amount = 1 - smoothStep( path.arriveSwitchAt - 2.5, path.arriveSwitchAt, t );

			}

		} else if ( ( state.phase === 'playing' || state.phase === 'ended' ) && entry && entry.inited && ! entry.module.isPanorama ) {

			const time = state.sceneTime;
			const duration = entry.config.duration;
			const next = nextPlayableIndex( state.index + 1 );
			const route = typeof entry.module.getGuideRoute === 'function' ? entry.module.getGuideRoute() : null;
			if ( entry.key === 'overture' && route ) {

				// 开场：林尽水源起顺着路线流，领进山洞（洞里收得很窄，也少一些，不然 1 米多宽的洞里满眼都是光点）
				pathLength = pathFromRoute( route, entry.key, time, 2 );
				// 洞里只留一成多（原来三成半，1 米多宽的洞里还是满屏花瓣光点，把洞壁和出口的光全挡住，2026-10-02 自查）：洞里领路的是出口的光
				amount = smoothStep( guideConfig.overtureFrom, guideConfig.overtureFrom + 4, time ) * ( caveWidthAt( guideViewer ) < 1 ? 0.12 : 1 );
				flowSpeed = guideConfig.stayFlowSpeed * 1.5;
				keep = 1;
				// 开场领路的是花瓣（"落英缤纷"），光点只留四成（审查 R38：崖前满屏光点像雪、像灰尘）
				moteScale = 0.4;

			} else if ( route && route.exitTime !== undefined && time < guideConfig.gardenIntroUntil ) {

				// 花园出洞：接着开场的花瓣流出洞口，出洞以后散开淡出（豁然开朗）
				amount = ( 1 - smoothStep( guideConfig.gardenIntroUntil - 4, guideConfig.gardenIntroUntil, time ) ) * ( caveWidthAt( guideViewer ) < 1 ? 0.12 : 1 );
				scatter = smoothStep( route.exitTime, route.exitTime + guideConfig.scatterSeconds, time );
				pathLength = pathFromRoute( route, entry.key, time, 2 );
				flowSpeed = guideConfig.stayFlowSpeed * 1.5;
				moteScale = 0.4;

			} else if ( next >= 0 && entries[ next ].config.arrival !== 'cave' && time > duration - guideConfig.gatherSeconds ) {

				// 停留最后几秒：聚到身边打旋，然后朝下一段航线的第一个航点飘
				const since = time - ( duration - guideConfig.gatherSeconds );
				amount = smoothStep( 0, 2.5, since );
				gather = since < 4 ? 1 : 1 - 0.65 * smoothStep( 4, guideConfig.gatherSeconds, since );
				gatherRadius = guideConfig.gatherRadius * ( 1.6 - 0.6 * smoothStep( 0, 3, since ) );
				const leg = findLeg( entry.key, entries[ next ].key );
				const firstWaypoint = leg && leg.waypoints && leg.waypoints.length ? leg.waypoints[ 0 ] : world.locations[ entries[ next ].key ].origin;
				pathLength = pathToward( guideTarget.fromArray( firstWaypoint ), guideConfig.staySpacing );
				flowSpeed = guideConfig.stayFlowSpeed * smoothStep( 3, 6, since );

			}

		} else if ( state.phase === 'jump' && state.jump ) {

			// 跳转：已经出来的跟着薄雾收起（再走一遍的风暴起完以后也是这里，离镜头近的还看得见）
			amount = guideState.amount * Math.exp( - dt * 2.5 );
			gather = uniforms.gather.value;
			gatherRadius = uniforms.gatherRadius.value;
			swirl = uniforms.swirl.value;
			keep = 1;
			forcePetals = uniforms.petalAmount.value > 0.5;
			pathLength = 0;

		}

		if ( pathLength > 0 ) guide.setPath( guidePoints );
		if ( pathLength > 0 && dt > 0 ) guideState.phase = ( guideState.phase + dt * flowSpeed / pathLength ) % 1;
		guideState.amount = amount;

		uniforms.time.value = state.worldTime;
		uniforms.flowPhase.value = guideState.phase;
		uniforms.amount.value = amount;
		uniforms.gather.value = gather;
		uniforms.gatherRadius.value = gatherRadius;
		uniforms.swirl.value = swirl;
		uniforms.scatter.value = scatter;
		ctx.camera.getWorldDirection( guideForward );
		uniforms.gatherCenter.value.copy( guideViewer ).addScaledVector( guideForward.transformDirection( backdrop.getSceneToWorld().value ), 1.2 );
		uniforms.gatherCenter.value.y -= 0.2;

		// 颜色：白天暖白的花瓣和光点；入夜花瓣收起来，光点换萤火虫；雪原附近（海拔高）换蓝白的雪光
		const day = smoothStep( 0.12, 0.45, world.uniforms.skyIntensity.value );
		const snow = smoothStep( guideConfig.snowAltitude[ 0 ], guideConfig.snowAltitude[ 1 ], guideViewer.y ) * ( 1 - day );
		uniforms.petalAmount.value = forcePetals ? 1 : day;
		// 白天光点少一些（花瓣是主角），夜里光点是主角；聚在身边打旋时光点减半（几百只萤火虫贴脸，满屏都是点）
		uniforms.moteAmount.value = ( 1 - 0.45 * day ) * ( 1 - 0.5 * gather ) * moteScale;
		guideColor.copy( guideNight ).lerp( guideDay, day ).lerp( guideSnow, snow );
		uniforms.moteColor.value.copy( guideColor );
		uniforms.moteIntensity.value = guideConfig.moteIntensity * ( 0.75 + 0.25 * day );
		ctx.pipeline.setGuideKeep( amount > 0 ? keep : 0 );

	}

	// ===== 瞬时跳转（截图脚本、调试面板用）：取消飞行和跳转，直接到某个地点的某个时间，薄雾为 0 =====

	async function jumpTo( index, time = 0 ) {

		if ( ! Number.isInteger( index ) || index < 0 || index >= entries.length ) return false;
		const token = ++ jumpToken;
		const target = entries[ index ];
		if ( target.failed && ! target.inited ) console.warn( `时间线：场景「${ target.config.name }」之前初始化失败，再试一次` );

		state.jump = null;
		state.storm = null;
		jumpTargetHold = index;
		let ok = false;
		try {

			ok = await ensureInit( index );

		} finally {

			if ( jumpTargetHold === index ) jumpTargetHold = - 1;

		}

		if ( token !== jumpToken ) return false;
		if ( ! ok ) {

			console.error( `时间线：跳转失败，场景「${ target.config.name }」无法初始化` );
			return false;

		}

		if ( state.flight ) {

			const flight = state.flight;
			state.flight = null;
			if ( ctx.quality && typeof ctx.quality.onFlightEnd === 'function' ) ctx.quality.onFlightEnd();
			if ( ctx.flightVideo ) ctx.flightVideo.hide();
			if ( ! flight.departed && flight.from !== index ) leaveLocation( flight.from );
			if ( flight.to !== index && entries[ flight.to ].inited ) leaveLocation( flight.to );

		}

		state.jump = null;
		if ( state.index >= 0 && state.index !== index && entries[ state.index ].inited ) leaveLocation( state.index );
		else if ( state.index === index ) {

			try {

				target.module.exit();

			} catch ( error ) {

				console.error( '时间线：exit 出错：', error );

			}

		}

		ctx.pipeline.setVeil( 0 );
		world.uniforms.worldSkyBlend.value = 0;
		world.uniforms.locationVeil.value = 0;
		endFired = false;
		enterLocation( index, Math.max( 0, time ) );
		const last = nextPlayableIndex( index + 1 ) < 0;
		state.phase = 'playing';
		if ( last && time >= target.config.duration ) finish();
		logPhase( 'stay', target.key );

		for ( let i = 0; i < entries.length; i ++ ) {

			if ( i !== index && entries[ i ].inited && ! shouldKeep( i ) ) disposeEntry( i );

		}

		return true;

	}

	// 截图脚本：飞到第 toIndex 个地点那段航线的某个进度（0~1）。先瞬时跳到出发地停留结束、站在出生点，结果确定
	async function flightTo( toIndex, progress ) {

		const from = previousPlayableIndex( toIndex - 1 );
		if ( from < 0 ) throw new Error( `时间线：第 ${ toIndex } 个地点前面没有可以出发的地点` );
		if ( ! await jumpTo( from, entries[ from ].config.duration ) ) return false;
		state.preloadStarted = true;
		state.preloadTarget = toIndex;
		if ( ! await ensureInit( toIndex ) ) return false;
		beginFlight( toIndex );
		state.flight.time = clamp( progress, 0, 1 ) * state.flight.path.duration;
		updateFlight( 0 );
		return true;

	}

	function seek( time ) {

		if ( state.phase !== 'playing' && state.phase !== 'ended' ) return;
		const entry = entries[ state.index ];
		if ( ! entry || ! entry.inited ) return;
		state.sceneTime = clamp( time, 0, entry.config.duration );
		world.setDayTime( hoursAt( entry, state.sceneTime ) );
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

	// 再走一遍：薄雾淡出，回到第一个地点（4b 是花园；阶段 7 改成溪口）
	function restart() {

		const first = nextPlayableIndex( 0 );
		if ( first < 0 ) return false;
		for ( const entry of entries ) entry.failed = false;
		state.paused = false;
		// 先起一阵花瓣风暴（stormSeconds 秒），再接原来的薄雾和黑场淡入；没有远景（全景模式）就直接薄雾
		if ( backdropBuilt() && backdrop.getGuide() && state.phase !== 'jump' && state.phase !== 'flight' ) {

			if ( ! state.storm ) state.storm = { time: 0 };
			ensureInit( first );
			return true;

		}

		return requestJump( first, { seconds: timelineConfig.restartVeilSeconds } );

	}

	// 等所有后台 init 结束（截图脚本取内存快照前用）
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

	// 方向键的基准：停留时是当前地点；飞行中是出发地（往右等于跳过飞行直接到目的地）；跳转中是跳转目标
	function getNavigationIndex() {

		if ( state.jump ) return state.jump.target;
		if ( state.flight ) return state.flight.arrived ? state.flight.to : state.flight.from;
		return state.index;

	}

	function getFlightInfo() {

		const flight = state.flight;
		if ( ! flight ) return null;
		const stage = ! flight.departed ? 'depart' : ( flight.arrived ? 'arrive' : 'cruise' );
		return {
			from: entries[ flight.from ].key,
			to: entries[ flight.to ].key,
			time: flight.time,
			duration: flight.path.duration,
			progress: flight.time / flight.path.duration,
			length: flight.path.length,
			cruiseSpeed: flight.path.cruiseSpeed,
			stage,
			panorama: Boolean( flight.path.panorama ),
			frame: flight.path.frame ? { name: flight.path.frame.settings.name, entryTime: flight.path.frame.entryTime, exitTime: flight.path.frame.exitTime, switchTime: flight.path.frame.switchTime } : null,
		};

	}

	return {
		state,
		prepareWorld,
		prepareFirst,
		start,
		update,
		lateUpdate,
		jumpTo,
		requestJump,
		flightTo,
		seek,
		pause,
		resume,
		togglePause,
		restart,
		waitIdle,
		onEnd,
		// 强制马上开始准备下一个地点（探针用）
		preloadNext: () => {

			const next = nextPlayableIndex( state.index + 1 );
			if ( next < 0 ) return Promise.resolve( false );
			startPreload( next );
			return ensureInit( next );

		},
		getTime: () => state.sceneTime,
		getDuration: () => ( getCurrentEntry() ? getCurrentEntry().config.duration : 0 ),
		isPaused: () => state.paused,
		getSceneIndex: () => state.index,
		getNavigationIndex,
		getPhase: () => state.phase,
		getFlightInfo,
		getPhaseLog: () => phaseLog.slice(),
		isStorming: () => Boolean( state.storm ),
		getSceneKey: () => ( getCurrentEntry() ? getCurrentEntry().config.key : '' ),
		// 飞行巡航时没有当前地点（只画远景）
		getCurrentModule: () => {

			const entry = getCurrentEntry();
			if ( ! entry || ! entry.inited ) return null;
			if ( state.flight && state.flight.departed && ! state.flight.arrived ) return null;
			return entry.module;

		},
		// 每个场景的加载状态：已加载 / 加载中 / 失败 / 空，调试和截图脚本看
		getLoadStates: () => entries.map( ( entry ) => entry.inited ? '已加载' : ( entry.initPromise ? '加载中' : ( entry.failed ? '失败' : '空' ) ) ),
		getSceneList: () => config.scenes.map( ( scene ) => scene.name ),
	};

}
