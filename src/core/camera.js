// 导演镜头 + 拖动转头 + 自由相机 + 步行漫游（setWalk，WASD 贴地走、拖动随意转头）。契约见 reference/notes/design-stage0.md 第 6 节，交互规则见 CLAUDE.md 5.5。
// 路线是关键帧数组 [{ time, position:[x,y,z], lookAt:[x,y,z], fov? }]，位置用 Catmull-Rom、朝向用四元数球面插值。

import * as THREE from 'three/webgpu';

const worldUp = new THREE.Vector3( 0, 1, 0 );

// 标量 Catmull-Rom（均匀参数化），四个控制点，u 在 0..1
function catmullRom( u, p0, p1, p2, p3 ) {

	const u2 = u * u;
	const u3 = u2 * u;
	return 0.5 * ( ( 2 * p1 ) + ( - p0 + p2 ) * u + ( 2 * p0 - 5 * p1 + 4 * p2 - p3 ) * u2 + ( - p0 + 3 * p1 - 3 * p2 + p3 ) * u3 );

}

function smoothStep01( u ) {

	const clamped = Math.min( 1, Math.max( 0, u ) );
	return clamped * clamped * ( 3 - 2 * clamped );

}

export function createDirector( ctx ) {

	const camera = ctx.camera;
	const cameraConfig = ctx.config.camera;
	const domElement = ctx.renderer.domElement;

	// 路线关键帧（预处理成 Vector3 / Quaternion）
	let keyframes = [];
	let sceneTime = 0;

	// 拖动转头的偏移（度）
	let yawOffset = 0;
	let pitchOffset = 0;
	let dragging = false;
	let lastPointerX = 0;
	let lastPointerY = 0;

	// 自由相机状态
	const freeState = {
		position: new THREE.Vector3(),
		yaw: 0,     // 弧度
		pitch: 0,   // 弧度
	};
	const pressedKeys = new Set();

	// 步行漫游状态：场景调 setWalk 后启用，setRoute 会关掉它
	const walkState = {
		enabled: false,
		position: new THREE.Vector3(),
		velocity: new THREE.Vector3(),
		yaw: 0,
		pitch: 0,
		groundHeight: null,   // ( x, z ) => 地面高度
		bounds: null,         // { minX, maxX, minZ, maxZ }
		obstacles: [],        // [ { x, z, radius } ]，走不进去的圆（岩石、树干）
		canWalk: null,        // ( x, z ) => 能不能站，可选（海边不能走进水里）
		groundErrorReported: false,
		canWalkErrorReported: false,
	};
	const walkTarget = new THREE.Vector3();
	const walkForward = new THREE.Vector3();
	const walkRight = new THREE.Vector3();
	const walkEuler = new THREE.Euler( 0, 0, 0, 'YXZ' );
	const trackedKeys = new Set( [ 'w', 'a', 's', 'd', 'q', 'e', 'shift' ] );

	// 复用的临时对象，避免每帧 new
	const tempMatrix = new THREE.Matrix4();
	const tempPosition = new THREE.Vector3();
	const tempTarget = new THREE.Vector3();
	const baseQuaternion = new THREE.Quaternion();
	const yawQuaternion = new THREE.Quaternion();
	const pitchQuaternion = new THREE.Quaternion();
	const finalQuaternion = new THREE.Quaternion();
	const moveDirection = new THREE.Vector3();
	const axisX = new THREE.Vector3( 1, 0, 0 );
	const axisY = new THREE.Vector3( 0, 1, 0 );
	const axisZ = new THREE.Vector3( 0, 0, 1 );

	let currentFov = cameraConfig.fov;
	camera.fov = currentFov;
	camera.near = cameraConfig.near;
	camera.far = cameraConfig.far;
	camera.updateProjectionMatrix();

	function setRoute( route ) {

		if ( ! Array.isArray( route ) || route.length === 0 ) {

			console.error( '镜头：setRoute 收到空路线，忽略' );
			return;

		}

		const prepared = [];

		for ( let i = 0; i < route.length; i ++ ) {

			const keyframe = route[ i ];
			if ( ! keyframe || ! Array.isArray( keyframe.position ) || ! Array.isArray( keyframe.lookAt ) || typeof keyframe.time !== 'number' ) {

				console.error( `镜头：第 ${ i } 个关键帧格式不对，需要 { time, position:[x,y,z], lookAt:[x,y,z] }，整条路线忽略` );
				return;

			}

			if ( i > 0 && keyframe.time <= route[ i - 1 ].time ) {

				console.error( `镜头：第 ${ i } 个关键帧 time=${ keyframe.time } 没有比前一个大，整条路线忽略` );
				return;

			}

			const position = new THREE.Vector3().fromArray( keyframe.position );
			const target = new THREE.Vector3().fromArray( keyframe.lookAt );
			tempMatrix.lookAt( position, target, worldUp );
			const quaternion = new THREE.Quaternion().setFromRotationMatrix( tempMatrix );

			prepared.push( {
				time: keyframe.time,
				position,
				quaternion,
				fov: typeof keyframe.fov === 'number' ? keyframe.fov : cameraConfig.fov,
			} );

		}

		keyframes = prepared;
		walkState.enabled = false;

	}

	// 由位置和看向点算出偏航/俯仰（弧度）
	function anglesFromLookAt( fromPosition, lookAtTarget ) {

		tempMatrix.lookAt( fromPosition, lookAtTarget, worldUp );
		baseQuaternion.setFromRotationMatrix( tempMatrix );
		walkEuler.setFromQuaternion( baseQuaternion, 'YXZ' );
		return { yaw: walkEuler.y, pitch: walkEuler.x };

	}

	// 步行漫游：options = { position:[x,y,z], lookAt:[x,y,z], groundHeight:( x, z ) => y, bounds?, obstacles?, canWalk? }
	function setWalk( options ) {

		if ( ! options || ! Array.isArray( options.position ) || ! Array.isArray( options.lookAt ) || typeof options.groundHeight !== 'function' ) {

			console.error( '镜头：setWalk 需要 { position, lookAt, groundHeight }，忽略' );
			return;

		}

		walkState.enabled = true;
		walkState.groundHeight = options.groundHeight;
		walkState.bounds = options.bounds || null;
		walkState.obstacles = Array.isArray( options.obstacles ) ? options.obstacles : [];
		walkState.canWalk = typeof options.canWalk === 'function' ? options.canWalk : null;
		walkState.groundErrorReported = false;
		walkState.canWalkErrorReported = false;
		keyframes = [];
		setPose( options.position, options.lookAt );

	}

	// 直接把人放到某处看向某处（出生点、截图机位）；只在步行模式下有意义
	function setPose( position, lookAt ) {

		walkState.position.fromArray( position );
		const angles = anglesFromLookAt( walkState.position, tempTarget.fromArray( lookAt ) );
		walkState.yaw = angles.yaw;
		walkState.pitch = angles.pitch;
		walkState.velocity.set( 0, 0, 0 );
		yawOffset = 0;
		pitchOffset = 0;
		writeWalkCamera();

	}

	function writeWalkCamera() {

		walkEuler.set( walkState.pitch, walkState.yaw, 0, 'YXZ' );
		camera.quaternion.setFromEuler( walkEuler );
		camera.position.copy( walkState.position );
		applyFov( cameraConfig.fov );

	}

	// canWalk 出错就当能走（不把人卡死），报一次错
	function safeCanWalk( x, z ) {

		try {

			return walkState.canWalk( x, z ) !== false;

		} catch ( error ) {

			if ( ! walkState.canWalkErrorReported ) {

				walkState.canWalkErrorReported = true;
				console.error( '镜头：canWalk 出错，暂时不限制：', error );

			}

			return true;

		}

	}

	function updateWalk( dt ) {

		const speed = cameraConfig.walkSpeed * ( pressedKeys.has( 'shift' ) ? cameraConfig.runMultiplier : 1 );

		walkForward.set( - Math.sin( walkState.yaw ), 0, - Math.cos( walkState.yaw ) );
		walkRight.set( Math.cos( walkState.yaw ), 0, - Math.sin( walkState.yaw ) );

		walkTarget.set( 0, 0, 0 );
		if ( pressedKeys.has( 'w' ) ) walkTarget.add( walkForward );
		if ( pressedKeys.has( 's' ) ) walkTarget.sub( walkForward );
		if ( pressedKeys.has( 'd' ) ) walkTarget.add( walkRight );
		if ( pressedKeys.has( 'a' ) ) walkTarget.sub( walkRight );
		if ( walkTarget.lengthSq() > 0 ) walkTarget.normalize().multiplyScalar( speed );

		// 速度缓动，起步停步不生硬
		const blend = 1 - Math.exp( - cameraConfig.walkSmoothing * dt );
		walkState.velocity.lerp( walkTarget, blend );
		const previousX = walkState.position.x;
		const previousZ = walkState.position.z;
		walkState.position.addScaledVector( walkState.velocity, dt );

		const bounds = walkState.bounds;
		if ( bounds ) {

			walkState.position.x = Math.min( bounds.maxX, Math.max( bounds.minX, walkState.position.x ) );
			walkState.position.z = Math.min( bounds.maxZ, Math.max( bounds.minZ, walkState.position.z ) );

		}

		// 碰到岩石、树干就沿圆周推出去（只在水平面上算）
		for ( const obstacle of walkState.obstacles ) {

			const offsetX = walkState.position.x - obstacle.x;
			const offsetZ = walkState.position.z - obstacle.z;
			const distance = Math.hypot( offsetX, offsetZ );
			if ( distance < obstacle.radius && distance > 1e-6 ) {

				walkState.position.x = obstacle.x + offsetX / distance * obstacle.radius;
				walkState.position.z = obstacle.z + offsetZ / distance * obstacle.radius;

			}

		}

		// 走到不能站的地方（水里）：先试只沿 x 或只沿 z 走（贴着岸边滑），都不行就停在原地
		if ( walkState.canWalk && ! safeCanWalk( walkState.position.x, walkState.position.z ) ) {

			if ( safeCanWalk( walkState.position.x, previousZ ) ) {

				walkState.position.z = previousZ;

			} else if ( safeCanWalk( previousX, walkState.position.z ) ) {

				walkState.position.x = previousX;

			} else {

				walkState.position.x = previousX;
				walkState.position.z = previousZ;

			}

			walkState.velocity.multiplyScalar( 0.5 );

		}

		// 眼睛贴着地面走；地面函数出错或没有数据（场景已释放）就保持原高度，报一次错
		let ground = NaN;
		try {

			ground = walkState.groundHeight( walkState.position.x, walkState.position.z );

		} catch ( error ) {

			if ( ! walkState.groundErrorReported ) {

				walkState.groundErrorReported = true;
				console.error( '镜头：地面高度函数出错，暂时保持当前高度：', error );

			}

		}

		if ( Number.isFinite( ground ) ) walkState.position.y = ground + cameraConfig.eyeHeight;

		writeWalkCamera();

	}

	function setTime( time ) {

		sceneTime = Number.isFinite( time ) ? Math.max( 0, time ) : 0;

	}

	// 按路线算出基础位姿，写进 tempPosition / baseQuaternion / currentFov
	function evaluateRoute() {

		const count = keyframes.length;

		if ( count === 0 ) {

			// 没路线就站在原点看向 -z，不让画面空着
			tempPosition.set( 0, 1.6, 0 );
			baseQuaternion.identity();
			currentFov = cameraConfig.fov;
			return;

		}

		if ( count === 1 || sceneTime <= keyframes[ 0 ].time ) {

			tempPosition.copy( keyframes[ 0 ].position );
			baseQuaternion.copy( keyframes[ 0 ].quaternion );
			currentFov = keyframes[ 0 ].fov;
			return;

		}

		const last = keyframes[ count - 1 ];
		if ( sceneTime >= last.time ) {

			tempPosition.copy( last.position );
			baseQuaternion.copy( last.quaternion );
			currentFov = last.fov;
			return;

		}

		let segment = 0;
		while ( segment < count - 2 && sceneTime >= keyframes[ segment + 1 ].time ) segment ++;

		const from = keyframes[ segment ];
		const to = keyframes[ segment + 1 ];
		const rawU = ( sceneTime - from.time ) / ( to.time - from.time );
		// 每段进出都缓一下，镜头不会在关键帧处突然变速
		const u = smoothStep01( rawU );

		const previous = keyframes[ Math.max( 0, segment - 1 ) ].position;
		const next = keyframes[ Math.min( count - 1, segment + 2 ) ].position;

		tempPosition.set(
			catmullRom( u, previous.x, from.position.x, to.position.x, next.x ),
			catmullRom( u, previous.y, from.position.y, to.position.y, next.y ),
			catmullRom( u, previous.z, from.position.z, to.position.z, next.z ),
		);
		baseQuaternion.copy( from.quaternion ).slerp( to.quaternion, u );
		currentFov = from.fov + ( to.fov - from.fov ) * u;

	}

	function applyFov( fov ) {

		if ( Math.abs( camera.fov - fov ) > 1e-4 ) {

			camera.fov = fov;
			camera.updateProjectionMatrix();

		}

	}

	function updateFree( dt ) {

		const speedBase = cameraConfig.freeMoveSpeed * ( pressedKeys.has( 'shift' ) ? 4 : 1 );
		const step = speedBase * dt;

		// 先算朝向，再沿相机轴移动
		yawQuaternion.setFromAxisAngle( axisY, freeState.yaw );
		pitchQuaternion.setFromAxisAngle( axisX, freeState.pitch );
		finalQuaternion.copy( yawQuaternion ).multiply( pitchQuaternion );

		moveDirection.set( 0, 0, 0 );
		if ( pressedKeys.has( 'w' ) ) moveDirection.z -= 1;
		if ( pressedKeys.has( 's' ) ) moveDirection.z += 1;
		if ( pressedKeys.has( 'a' ) ) moveDirection.x -= 1;
		if ( pressedKeys.has( 'd' ) ) moveDirection.x += 1;
		if ( pressedKeys.has( 'e' ) ) moveDirection.y += 1;
		if ( pressedKeys.has( 'q' ) ) moveDirection.y -= 1;

		if ( moveDirection.lengthSq() > 0 ) {

			moveDirection.normalize().applyQuaternion( finalQuaternion ).multiplyScalar( step );
			freeState.position.add( moveDirection );

		}

		camera.position.copy( freeState.position );
		camera.quaternion.copy( finalQuaternion );
		applyFov( cameraConfig.fov );

	}

	function update( dt ) {

		if ( director.freeMode ) {

			updateFree( dt );
			return;

		}

		if ( walkState.enabled ) {

			updateWalk( dt );
			return;

		}

		// 松手后指数阻尼回正
		if ( ! dragging ) {

			const decay = Math.exp( - cameraConfig.dragReturnDamping * dt );
			yawOffset *= decay;
			pitchOffset *= decay;
			if ( Math.abs( yawOffset ) < 0.01 ) yawOffset = 0;
			if ( Math.abs( pitchOffset ) < 0.01 ) pitchOffset = 0;

		}

		evaluateRoute();

		// 偏航绕世界 Y，俯仰绕相机自己的 X
		yawQuaternion.setFromAxisAngle( axisY, THREE.MathUtils.degToRad( yawOffset ) );
		pitchQuaternion.setFromAxisAngle( axisX, THREE.MathUtils.degToRad( pitchOffset ) );
		finalQuaternion.copy( yawQuaternion ).multiply( baseQuaternion ).multiply( pitchQuaternion );

		camera.position.copy( tempPosition );
		camera.quaternion.copy( finalQuaternion );
		applyFov( currentFov );

	}

	// ===== 鼠标拖动 =====

	function onPointerDown( event ) {

		if ( event.button !== 0 ) return;
		dragging = true;
		lastPointerX = event.clientX;
		lastPointerY = event.clientY;
		if ( domElement.setPointerCapture ) {

			try {

				domElement.setPointerCapture( event.pointerId );

			} catch ( error ) {

				// 有些环境（比如合成事件）不支持捕获，不影响拖动
			}

		}

	}

	function onPointerMove( event ) {

		if ( ! dragging ) return;

		const deltaX = event.clientX - lastPointerX;
		const deltaY = event.clientY - lastPointerY;
		lastPointerX = event.clientX;
		lastPointerY = event.clientY;

		if ( director.freeMode ) {

			freeState.yaw -= THREE.MathUtils.degToRad( deltaX * cameraConfig.dragSensitivity );
			freeState.pitch -= THREE.MathUtils.degToRad( deltaY * cameraConfig.dragSensitivity );
			freeState.pitch = Math.max( - Math.PI * 0.49, Math.min( Math.PI * 0.49, freeState.pitch ) );
			return;

		}

		if ( walkState.enabled ) {

			// 步行时随意转头，不回正
			walkState.yaw -= THREE.MathUtils.degToRad( deltaX * cameraConfig.dragSensitivity );
			walkState.pitch -= THREE.MathUtils.degToRad( deltaY * cameraConfig.dragSensitivity );
			const pitchLimit = THREE.MathUtils.degToRad( cameraConfig.walkPitchMax );
			walkState.pitch = Math.max( - pitchLimit, Math.min( pitchLimit, walkState.pitch ) );
			return;

		}

		yawOffset -= deltaX * cameraConfig.dragSensitivity;
		pitchOffset -= deltaY * cameraConfig.dragSensitivity;
		yawOffset = Math.max( - cameraConfig.dragYawMax, Math.min( cameraConfig.dragYawMax, yawOffset ) );
		pitchOffset = Math.max( - cameraConfig.dragPitchMax, Math.min( cameraConfig.dragPitchMax, pitchOffset ) );

	}

	function onPointerUp() {

		dragging = false;

	}

	// ===== 自由相机按键（只记录 WASDQE 和 Shift，其余键归 main.js）=====

	function onKeyDown( event ) {

		const keyName = event.key.toLowerCase();
		if ( trackedKeys.has( keyName ) ) pressedKeys.add( keyName );

	}

	function onKeyUp( event ) {

		const keyName = event.key.toLowerCase();
		if ( trackedKeys.has( keyName ) ) pressedKeys.delete( keyName );

	}

	function onBlur() {

		pressedKeys.clear();
		dragging = false;

	}

	domElement.addEventListener( 'pointerdown', onPointerDown );
	window.addEventListener( 'pointermove', onPointerMove );
	window.addEventListener( 'pointerup', onPointerUp );
	window.addEventListener( 'pointercancel', onPointerUp );
	window.addEventListener( 'keydown', onKeyDown );
	window.addEventListener( 'keyup', onKeyUp );
	window.addEventListener( 'blur', onBlur );

	function getBaseState() {

		evaluateRoute();
		const forward = new THREE.Vector3( 0, 0, - 1 ).applyQuaternion( baseQuaternion );
		return { position: tempPosition.clone(), forward };

	}

	function dispose() {

		domElement.removeEventListener( 'pointerdown', onPointerDown );
		window.removeEventListener( 'pointermove', onPointerMove );
		window.removeEventListener( 'pointerup', onPointerUp );
		window.removeEventListener( 'pointercancel', onPointerUp );
		window.removeEventListener( 'keydown', onKeyDown );
		window.removeEventListener( 'keyup', onKeyUp );
		window.removeEventListener( 'blur', onBlur );
		keyframes = [];

	}

	const director = {
		setRoute,
		setTime,
		setWalk,
		setPose,
		isWalking: () => walkState.enabled,
		// 场景退出时调：不再步行，也不再引用那个场景的地面函数
		clearWalk: () => {

			walkState.enabled = false;
			walkState.groundHeight = null;
			walkState.obstacles = [];
			walkState.canWalk = null;

		},
		update,
		getBaseState,
		dispose,
		// 自由相机开关：打开时从当前镜头位姿接手
		get freeMode() {

			return freeEnabled;

		},
		set freeMode( enabled ) {

			const next = Boolean( enabled );
			if ( next === freeEnabled ) return;
			freeEnabled = next;

			if ( next ) {

				freeState.position.copy( camera.position );
				// 从当前四元数反推偏航/俯仰（只取绕 Y 和绕 X 的分量）
				const euler = new THREE.Euler().setFromQuaternion( camera.quaternion, 'YXZ' );
				freeState.yaw = euler.y;
				freeState.pitch = euler.x;
				console.log( '镜头：自由相机已打开，WASD 移动、QE 升降、按住左键转头、Shift 加速' );

			} else {

				yawOffset = 0;
				pitchOffset = 0;
				console.log( walkState.enabled ? '镜头：回到步行' : '镜头：回到导演路线' );

			}

		},
	};

	let freeEnabled = false;

	return director;

}
