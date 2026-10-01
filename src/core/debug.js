// 调试面板，只在 ?debug 时出现。契约见 design-stage0.md 第 7 节，要求见 CLAUDE.md 6.3。
// 用 three 自带的 lil-gui（MIT）。enabled 为 false 时所有方法都是空函数，场景代码可以放心调。

import GUI from 'three/addons/libs/lil-gui.module.min.js';

export function createDebug( ctx, enabled ) {

	if ( ! enabled ) {

		const noop = () => {};
		return {
			enabled: false,
			addLayerToggle: noop,
			removeSceneToggles: noop,
			onFrame: noop,
			setTimelineHooks: noop,
			addWorldControls: noop,
			setVisible: noop,
			dispose: noop,
		};

	}

	const gui = new GUI( { title: '调试面板', width: 300 } );
	gui.domElement.style.zIndex = '50';

	// ===== 状态 =====
	const stats = {
		帧率: 0,
		帧时间ms: 0,
		后端: ctx.backend === 'webgpu' ? 'WebGPU' : 'WebGL2',
		显卡: ctx.gpuName,
		档位: '',
		渲染比例: 1,
		场景: '',
		场景时间: 0,
		几何体: 0,
		贴图: 0,
		渲染目标: 0,
		绘制调用: 0,
		程序: 0,
		显卡ms: 0,
	};

	const statsFolder = gui.addFolder( '状态' );
	for ( const key of Object.keys( stats ) ) {

		statsFolder.add( stats, key ).listen().disable();

	}

	// ===== 时间线 =====
	let hooks = null;
	const timelineState = { 时间: 0, 场景: '' };
	let timelineFolder = null;
	let timeController = null;
	let sceneController = null;
	let pauseController = null;

	function setTimelineHooks( timelineHooks ) {

		hooks = timelineHooks;
		if ( timelineFolder ) timelineFolder.destroy();

		timelineFolder = gui.addFolder( '时间线' );
		const actions = {
			暂停或继续: () => hooks.togglePause(),
			上一个场景: () => hooks.jumpTo( hooks.getSceneIndex() - 1, 0 ),
			下一个场景: () => hooks.jumpTo( hooks.getSceneIndex() + 1, 0 ),
		};
		pauseController = timelineFolder.add( actions, '暂停或继续' );
		timelineFolder.add( actions, '上一个场景' );
		timelineFolder.add( actions, '下一个场景' );

		timeController = timelineFolder.add( timelineState, '时间', 0, Math.max( 1, hooks.getDuration() ), 0.1 ).listen().onChange( ( value ) => {

			hooks.seek( value );

		} );

		const names = hooks.getSceneList();
		sceneController = timelineFolder.add( timelineState, '场景', names ).listen().onChange( ( name ) => {

			const index = names.indexOf( name );
			if ( index >= 0 && index !== hooks.getSceneIndex() ) hooks.jumpTo( index, 0 );

		} );

	}

	// ===== 秘境俯瞰（?world=1）=====
	let worldRefresh = null;

	function addWorldControls( worldHooks ) {

		const folder = gui.addFolder( '秘境俯瞰' );
		const locations = worldHooks.getLocations();
		const worldState = { 时刻: worldHooks.getDayTime(), 流速: 0 };
		folder.add( worldState, '时刻', 0, 24, 0.05 ).name( '时刻（小时）' ).listen().onChange( ( value ) => worldHooks.setDayTime( value ) );
		folder.add( worldState, '流速', 0, 2, 0.05 ).name( '流速（小时/秒）' ).onChange( ( value ) => worldHooks.setDaySpeed( value ) );
		// 每个地点一个按钮（下拉框选同一项不会触发，跳走以后想回来就不灵）
		for ( const location of locations ) {

			const action = { [ '跳到' + location.name ]: () => worldHooks.jumpToLocation( location.key ) };
			folder.add( action, '跳到' + location.name );

		}
		const actions = {
			高空俯瞰: () => worldHooks.showAerial(),
			正上方地图: () => worldHooks.showMap(),
		};
		folder.add( actions, '高空俯瞰' );
		folder.add( actions, '正上方地图' );
		worldRefresh = () => {

			worldState.时刻 = Math.round( worldHooks.getDayTime() * 100 ) / 100;

		};

		// 俯瞰模式全程是自由相机，没有导演路线可以回去，关掉会掉到地底下：把开关锁住
		cameraState.自由相机 = true;
		freeCameraController.disable();

	}

	// ===== 画质 =====
	const qualityState = { 档位: ctx.quality.tier };
	const qualityFolder = gui.addFolder( '画质' );
	qualityFolder.add( qualityState, '档位', [ 'hi', 'mid', 'lo' ] ).onChange( ( tier ) => {

		ctx.quality.setTier( tier );

	} );

	// ===== 相机 =====
	const cameraState = { 自由相机: false };
	const cameraFolder = gui.addFolder( '相机' );
	const freeCameraController = cameraFolder.add( cameraState, '自由相机' ).onChange( ( value ) => {

		ctx.director.freeMode = value;

	} );

	// ===== 场景层开关 =====
	const sceneFolders = new Map();   // sceneKey → { folder, state }

	function addLayerToggle( sceneKey, label, uniformOrSetter ) {

		let record = sceneFolders.get( sceneKey );
		if ( ! record ) {

			record = { folder: gui.addFolder( `层开关 · ${ sceneKey }` ), state: {} };
			sceneFolders.set( sceneKey, record );

		}

		if ( label in record.state ) {

			console.warn( `调试面板：${ sceneKey } 已经有「${ label }」开关，重复注册忽略` );
			return;

		}

		record.state[ label ] = true;
		record.folder.add( record.state, label ).onChange( ( value ) => {

			if ( typeof uniformOrSetter === 'function' ) {

				uniformOrSetter( value );

			} else if ( uniformOrSetter && 'value' in uniformOrSetter ) {

				uniformOrSetter.value = value ? 1 : 0;

			} else {

				console.warn( `调试面板：「${ label }」既不是 uniform 也不是函数，切换无效` );

			}

		} );

	}

	function removeSceneToggles( sceneKey ) {

		const record = sceneFolders.get( sceneKey );
		if ( ! record ) return;
		record.folder.destroy();
		sceneFolders.delete( sceneKey );

	}

	// ===== 每帧刷新 =====
	let frameCount = 0;
	let windowStart = performance.now();
	let lastFrameTime = performance.now();

	function onFrame() {

		const now = performance.now();
		stats.帧时间ms = Math.round( ( now - lastFrameTime ) * 10 ) / 10;
		lastFrameTime = now;
		frameCount ++;

		if ( now - windowStart >= 1000 ) {

			stats.帧率 = Math.round( frameCount * 1000 / ( now - windowStart ) );
			frameCount = 0;
			windowStart = now;

		}

		stats.档位 = ctx.quality.tier;
		stats.渲染比例 = Math.round( ctx.quality.renderScale * 100 ) / 100;
		qualityState.档位 = ctx.quality.tier;

		const info = ctx.renderer.info;
		stats.几何体 = info.memory.geometries;
		stats.贴图 = info.memory.textures;
		stats.渲染目标 = info.memory.renderTargets;
		stats.程序 = info.memory.programs;
		stats.绘制调用 = info.render.drawCalls;

		if ( hooks ) {

			const names = hooks.getSceneList();
			const index = hooks.getSceneIndex();
			stats.场景 = index >= 0 ? names[ index ] : '';
			stats.场景时间 = Math.round( hooks.getTime() * 10 ) / 10;
			timelineState.时间 = hooks.getTime();
			timelineState.场景 = stats.场景;
			if ( timeController ) timeController.max( Math.max( 1, hooks.getDuration() ) );
			if ( pauseController ) pauseController.name( hooks.isPaused() ? '继续' : '暂停' );

		}

		cameraState.自由相机 = ctx.director.freeMode;
		if ( worldRefresh ) worldRefresh();
		stats.显卡ms = Math.round( ( ctx.quality.gpuMs || 0 ) * 100 ) / 100;

	}

	function setVisible( visible ) {

		if ( visible ) gui.show();
		else gui.hide();

	}

	function dispose() {

		gui.destroy();
		sceneFolders.clear();

	}

	console.log( '调试面板已打开' );

	return {
		enabled: true,
		addLayerToggle,
		removeSceneToggles,
		onFrame,
		setTimelineHooks,
		addWorldControls,
		setVisible,
		dispose,
	};

}
