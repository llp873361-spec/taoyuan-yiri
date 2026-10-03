// 导演镜头 + 拖动转头 + 自由相机 + 步行漫游（setWalk，WASD 贴地走、拖动随意转头）+ 呼吸感和行走感（CLAUDE.md 5.5）。契约见 reference/notes/design-stage0.md 第 6 节，交互规则见 CLAUDE.md 5.5。
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

// 一个网格在不在相机的视锥里。
// 地点的倒影用它：转身背对水面时水面不在画面里，这一帧不画倒影（原来照画，哥特背对湖时倒影里还把整片地形和树画一遍）。
// 转回来那一帧水面一进视锥就先画倒影再画主画面，不会露出旧的倒影。
// 整块包围盒太粗（哥特的湖是转过的椭圆，包围盒把站在岸上的镜头也框进去，怎么转都算看得见）；按三角形分块也粗
// （湖外圈的三角形二十来米宽，一半在水里一半伸进岸下）。所以在三角形上每隔 spacing 米取一个点，
// 传了 groundHeight（地点坐标的地面高度）时只留水面露在地面以上的点，再把点按 xz 分成 viewChunkCells × viewChunkCells 块，
// 每块是块里点的包围盒，任何一块进视锥才算看得见。点在地点 init 时取好（prepareMeshView），不放在第一帧里
const viewChunkCells = 16;
const viewFrustum = new THREE.Frustum();
const viewProjection = new THREE.Matrix4();
const viewBox = new THREE.Box3();
const cornerA = new THREE.Vector3();
const cornerB = new THREE.Vector3();
const cornerC = new THREE.Vector3();
const samplePoint = new THREE.Vector3();

export function prepareMeshView( mesh, { groundHeight = null, samples = 40000 } = {} ) {

	const geometry = mesh && mesh.geometry;
	if ( ! geometry || ! geometry.attributes.position ) return [];
	if ( geometry.userData.viewChunks ) return geometry.userData.viewChunks;
	const position = geometry.attributes.position;
	const index = geometry.index;
	const triangleCount = Math.floor( ( index ? index.count : position.count ) / 3 );
	const corner = ( i, k, target ) => target.fromBufferAttribute( position, index ? index.getX( i * 3 + k ) : i * 3 + k );
	// 取点间距：按总面积摊到约 samples 个点，最细 1.5 米（落日的海面好几平方公里，间距会放大到十几米）
	let area = 0;
	for ( let i = 0; i < triangleCount; i ++ ) {

		corner( i, 0, cornerA );
		corner( i, 1, cornerB );
		corner( i, 2, cornerC );
		area += cornerB.sub( cornerA ).cross( cornerC.sub( cornerA ) ).length() / 2;

	}

	const spacing = Math.max( 1.5, Math.sqrt( area / samples ) );
	const points = [];
	for ( let i = 0; i < triangleCount; i ++ ) {

		corner( i, 0, cornerA );
		corner( i, 1, cornerB );
		corner( i, 2, cornerC );
		const longest = Math.max( cornerA.distanceTo( cornerB ), cornerB.distanceTo( cornerC ), cornerC.distanceTo( cornerA ) );
		const steps = Math.max( 1, Math.ceil( longest / spacing ) );
		for ( let u = 0; u <= steps; u ++ ) {

			for ( let v = 0; u + v <= steps; v ++ ) {

				const weightB = u / steps;
				const weightC = v / steps;
				samplePoint.copy( cornerA ).multiplyScalar( 1 - weightB - weightC ).addScaledVector( cornerB, weightB ).addScaledVector( cornerC, weightC );
				// 埋在地面以下的水面看不见（湖面网格伸进岸下）
				if ( groundHeight && groundHeight( samplePoint.x, samplePoint.z ) > samplePoint.y + 0.3 ) continue;
				points.push( samplePoint.x, samplePoint.y, samplePoint.z );

			}

		}

	}

	const boxes = new Map();
	if ( points.length > 0 ) {

		let minX = Infinity;
		let maxX = - Infinity;
		let minZ = Infinity;
		let maxZ = - Infinity;
		for ( let i = 0; i < points.length; i += 3 ) {

			minX = Math.min( minX, points[ i ] );
			maxX = Math.max( maxX, points[ i ] );
			minZ = Math.min( minZ, points[ i + 2 ] );
			maxZ = Math.max( maxZ, points[ i + 2 ] );

		}

		const sizeX = Math.max( maxX - minX, 1e-3 );
		const sizeZ = Math.max( maxZ - minZ, 1e-3 );
		for ( let i = 0; i < points.length; i += 3 ) {

			const cellX = Math.min( viewChunkCells - 1, Math.floor( ( points[ i ] - minX ) / sizeX * viewChunkCells ) );
			const cellZ = Math.min( viewChunkCells - 1, Math.floor( ( points[ i + 2 ] - minZ ) / sizeZ * viewChunkCells ) );
			const cell = cellX * viewChunkCells + cellZ;
			let box = boxes.get( cell );
			if ( ! box ) boxes.set( cell, box = new THREE.Box3() );
			box.expandByPoint( samplePoint.set( points[ i ], points[ i + 1 ], points[ i + 2 ] ) );

		}

	}

	// 块之间留了半个取点间距的缝，往外补上
	geometry.userData.viewChunks = [ ...boxes.values() ].map( ( box ) => box.expandByScalar( spacing * 0.5 ) );
	return geometry.userData.viewChunks;

}

export function isMeshInView( camera, mesh, { margin = 0.5, groundHeight = null } = {} ) {

	const geometry = mesh && mesh.geometry;
	if ( ! geometry || ! geometry.attributes.position ) return true;
	const chunks = prepareMeshView( mesh, { groundHeight } );
	// 一点露出来的水面都没有（整片埋在地下）：倒影画了也看不见，但为了稳妥照画
	if ( chunks.length === 0 ) return true;
	mesh.updateMatrixWorld();
	camera.updateMatrixWorld();
	viewProjection.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
	viewFrustum.setFromProjectionMatrix( viewProjection, camera.coordinateSystem, camera.reversedDepth );
	// 每块往外放 margin 米：水面在顶点里上下起伏，包围盒是平的（湖、池、溪起伏很小，默认 0.5 米；海浪大，落日传 3 米）。
	// 别放太大：哥特的出生点就站在水边，放 5 米会把镜头自己框进去，怎么转都算看得见
	for ( const chunk of chunks ) if ( viewFrustum.intersectsBox( viewBox.copy( chunk ).applyMatrix4( mesh.matrixWorld ).expandByScalar( margin ) ) ) return true;
	return false;

}

export function createDirector( ctx ) {

	const camera = ctx.camera;
	const cameraConfig = ctx.config.camera;
	const domElement = ctx.renderer.domElement;
	const flightConfig = ctx.config.world.flight;
	const flightDrag = { yawMax: flightConfig.dragYawMax, pitchMax: flightConfig.dragPitchMax, returnDamping: flightConfig.dragReturnDamping };
	// 到达窄处前最后几秒（规格书 5.3 阶段 12）拖动转头收紧：时间线给 [偏航, 俯仰] 上限（度），null 恢复默认
	let flightDragLimit = null;

	// 路线关键帧（预处理成 Vector3 / Quaternion）
	let keyframes = [];
	let sceneTime = 0;

	// 拖动转头的偏移（度）
	let yawOffset = 0;
	let pitchOffset = 0;
	let dragging = false;
	let lastDragTime = - Infinity;
	// 路线 / 固定机位模式的拖动选项（全景模式用）：{ yawMax, pitchMax, returnDelay（秒）, returnDamping }；null 用 config.camera 的
	let dragOptions = null;
	let lastPointerX = 0;
	let lastPointerY = 0;

	// 自由相机状态
	const freeState = {
		position: new THREE.Vector3(),
		yaw: 0,     // 弧度
		pitch: 0,   // 弧度
	};
	const pressedKeys = new Set();
	let freeSpeed = null;   // 自由相机速度（米/秒），null 用 config 里的 freeMoveSpeed

	// 呼吸感和行走感：只改最终写进相机的位置和朝向，不动 walkState（贴地、碰撞都按没晃的位置算）
	const swayState = {
		enabled: true,     // 全景烘焙时关掉
		stepPhase: 0,      // 按走过的距离推进，一步 = π
		walkBlend: 0,      // 0 站着，1 正常走，>1 跑
		floatWeight: 0,    // 0 步行的晃法，1 漂浮（飞行、固定机位）；切换时慢慢过渡，不跳
		clock: null,       // 时间线给的连续时钟（换地点不归零）；没给就用场景时间
	};

	// 飞行时由时间线每帧给的位姿（当前渲染场景的坐标）：优先级在自由相机之后、步行和路线之前
	const externalState = {
		active: false,
		position: new THREE.Vector3(),
		quaternion: new THREE.Quaternion(),
		fov: cameraConfig.fov,
	};

	// 她有没有在动：按着走路键、拖着转头、或者还在走（停步的缓动没走完）都算动
	const activity = { idleSeconds: 0 };

	// 最近一帧没加晃动的基础位姿（起飞时从这里接手）
	const lastBase = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: cameraConfig.fov };
	const swayRight = new THREE.Vector3();
	const swayEuler = new THREE.Euler( 0, 0, 0, 'YXZ' );
	const swayQuaternion = new THREE.Quaternion();

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
		fov: null,            // 这个地点步行时的视场（星月夜按原画构图用 56°），null 用默认
		speedScale: null,     // ( x, z ) => 这里的步速倍数，可选
		snap: null,           // ( x, z ) => 走出能站的地方时挪回去的点 [x, z] 或 null，可选（哥特的石桥：顺着弯的桥面走，不卡在胸墙上）
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
		// 飞行中（外部位姿）只登记路线，不接管相机；飞行结束 clearExternal 以后才生效
		if ( ! externalState.active ) {

			yawOffset = 0;
			pitchOffset = 0;

		}

	}

	// 由位置和看向点算出偏航/俯仰（弧度）
	function anglesFromLookAt( fromPosition, lookAtTarget ) {

		tempMatrix.lookAt( fromPosition, lookAtTarget, worldUp );
		baseQuaternion.setFromRotationMatrix( tempMatrix );
		walkEuler.setFromQuaternion( baseQuaternion, 'YXZ' );
		return { yaw: walkEuler.y, pitch: walkEuler.x };

	}

	// 步行漫游：options = { position:[x,y,z], lookAt:[x,y,z], groundHeight:( x, z ) => y, bounds?, obstacles?, canWalk?, fov?（度，默认 config.camera.fov）, speedScale?( x, z ) }
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
		walkState.fov = Number.isFinite( options.fov ) ? options.fov : null;
		walkState.speedScale = typeof options.speedScale === 'function' ? options.speedScale : null;
		walkState.snap = typeof options.snap === 'function' ? options.snap : null;
		walkState.groundErrorReported = false;
		walkState.canWalkErrorReported = false;
		keyframes = [];
		setPose( options.position, options.lookAt );

	}

	// 直接把人放到某处看向某处（出生点、截图机位）；只在步行模式下有意义。
	// 飞行中（外部位姿）只把人放好，不写相机，降落交还时才接上
	function setPose( position, lookAt ) {

		walkState.position.fromArray( position );
		const angles = anglesFromLookAt( walkState.position, tempTarget.fromArray( lookAt ) );
		walkState.yaw = angles.yaw;
		walkState.pitch = angles.pitch;
		walkState.velocity.set( 0, 0, 0 );
		if ( externalState.active ) return;
		yawOffset = 0;
		pitchOffset = 0;
		writeWalkCamera();

	}

	function writeWalkCamera() {

		walkEuler.set( walkState.pitch, walkState.yaw, 0, 'YXZ' );
		camera.quaternion.setFromEuler( walkEuler );
		camera.position.copy( walkState.position );
		applyFov( walkState.fov || cameraConfig.fov );

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

		// 有的地方走得快一点（哥特的石桥长，speedScale 给倍数）
		const placeScale = walkState.speedScale ? walkState.speedScale( walkState.position.x, walkState.position.z ) : 1;
		const speed = cameraConfig.walkSpeed * ( pressedKeys.has( 'shift' ) ? cameraConfig.runMultiplier : 1 ) * ( Number.isFinite( placeScale ) ? placeScale : 1 );

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
		const snapped = walkState.canWalk && walkState.snap && ! safeCanWalk( walkState.position.x, walkState.position.z ) ? walkState.snap( walkState.position.x, walkState.position.z ) : null;
		if ( snapped && safeCanWalk( snapped[ 0 ], snapped[ 1 ] ) ) {

			walkState.position.x = snapped[ 0 ];
			walkState.position.z = snapped[ 1 ];

		} else if ( walkState.canWalk && ! safeCanWalk( walkState.position.x, walkState.position.z ) ) {

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

		const speedBase = ( freeSpeed !== null ? freeSpeed : cameraConfig.freeMoveSpeed ) * ( pressedKeys.has( 'shift' ) ? 4 : 1 );
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

	// 呼吸感和行走感。时间用场景时间（暂停时不晃，截图可复现），步伐相位按走过的距离推进（停下就不颠）
	//   walk：站着时约 4 秒一次的呼吸起伏；走路时每一步上下颠一次（脚落地最低）、两步左右晃一个来回，起停平滑
	//   float：坐船、飞行、导演路线时很慢的漂浮
	// 两种晃法都算出来，按 floatWeight 混合：从步行起飞、降落交还步行时晃动慢慢换过去，不会突然跳 2~3 厘米
	function applySway( dt, horizontalSpeed, mode ) {

		const sway = cameraConfig.sway;
		if ( ! sway || ! sway.enabled || ! swayState.enabled ) return;

		const time = swayState.clock !== null ? swayState.clock : sceneTime;
		const degree = Math.PI / 180;
		const targetFloat = mode === 'walk' ? 0 : 1;
		swayState.floatWeight += ( targetFloat - swayState.floatWeight ) * ( 1 - Math.exp( - 2 * dt ) );
		const floatWeight = swayState.floatWeight;
		const walkWeight = 1 - floatWeight;
		let up = 0;
		let side = 0;
		let pitch = 0;
		let roll = 0;

		// 步行：站着呼吸，走起来按步伐颠和晃（不在步行时速度当 0，只剩呼吸）
		const walkSpeed = mode === 'walk' ? horizontalSpeed : 0;
		const targetBlend = Math.min( 1 + sway.runExtra, walkSpeed / cameraConfig.walkSpeed );
		swayState.walkBlend += ( targetBlend - swayState.walkBlend ) * ( 1 - Math.exp( - sway.blendSpeed * dt ) );
		swayState.stepPhase += walkSpeed * dt / sway.stepLength * Math.PI;
		const walking = Math.min( 1, swayState.walkBlend );
		const running = Math.max( 0, swayState.walkBlend - 1 );

		// 呼吸：走起来以后呼吸被步伐盖住，只留三成
		const breathAngle = time * Math.PI * 2 / sway.breathPeriod;
		const breathWeight = ( 1 - walking * 0.7 ) * walkWeight;
		up += Math.sin( breathAngle ) * sway.breathHeight * breathWeight;
		pitch += Math.sin( breathAngle - 0.6 ) * sway.breathPitch * degree * breathWeight;
		roll += Math.sin( breathAngle * 0.53 ) * sway.breathRoll * degree * breathWeight;

		// 步伐：|sin| 每步一个起伏，减去平均值 2/π 让眼睛高度平均不变；sin 两步一个来回，左右晃和横滚
		const stepAmount = walking * ( 1 + running * 0.8 ) * walkWeight;
		const bounce = Math.abs( Math.sin( swayState.stepPhase ) ) - 2 / Math.PI;
		const swing = Math.sin( swayState.stepPhase );
		up += bounce * sway.bobHeight * stepAmount;
		side += swing * sway.bobSide * stepAmount;
		roll += swing * sway.bobRoll * degree * stepAmount;
		pitch += bounce * sway.bobPitch * degree * stepAmount;

		// 漂浮：坐船、飞行、固定机位
		const floatAngle = time * Math.PI * 2 / sway.floatPeriod;
		up += Math.sin( floatAngle ) * sway.floatHeight * floatWeight;
		side += Math.sin( floatAngle * 0.73 + 1.3 ) * sway.floatHeight * 0.6 * floatWeight;
		roll += Math.sin( floatAngle * 0.59 + 0.4 ) * sway.floatRoll * degree * floatWeight;
		pitch += Math.sin( floatAngle * 0.81 + 2.1 ) * sway.floatRoll * 0.5 * degree * floatWeight;

		swayRight.set( 1, 0, 0 ).applyQuaternion( camera.quaternion );
		camera.position.y += up;
		camera.position.addScaledVector( swayRight, side );
		swayEuler.set( pitch, 0, roll, 'YXZ' );
		swayQuaternion.setFromEuler( swayEuler );
		camera.quaternion.multiply( swayQuaternion );

	}

	// 松手后指数阻尼回正（路线、固定机位、飞行时的拖动）
	function returnDragOffsets( dt, damping ) {

		if ( dragging ) return;
		if ( dragOptions && ! externalState.active ) {

			// 全景：松手后等 returnDelay 秒再慢慢回正（看一圈不会被马上拽回去）
			if ( performance.now() - lastDragTime < dragOptions.returnDelay * 1000 ) return;
			damping = dragOptions.returnDamping;

		}

		const decay = Math.exp( - damping * dt );
		yawOffset *= decay;
		pitchOffset *= decay;
		if ( Math.abs( yawOffset ) < 0.01 ) yawOffset = 0;
		if ( Math.abs( pitchOffset ) < 0.01 ) pitchOffset = 0;

	}

	// 基础位姿加上拖动偏移写进相机：偏航绕世界 Y，俯仰绕相机自己的 X
	function writeWithDrag( position, quaternion, fov ) {

		lastBase.position.copy( position );
		lastBase.quaternion.copy( quaternion );
		lastBase.fov = fov;
		yawQuaternion.setFromAxisAngle( axisY, THREE.MathUtils.degToRad( yawOffset ) );
		pitchQuaternion.setFromAxisAngle( axisX, THREE.MathUtils.degToRad( pitchOffset ) );
		finalQuaternion.copy( yawQuaternion ).multiply( quaternion ).multiply( pitchQuaternion );
		camera.position.copy( position );
		camera.quaternion.copy( finalQuaternion );
		applyFov( fov );

	}

	function updateActivity( dt ) {

		const pressingMove = pressedKeys.has( 'w' ) || pressedKeys.has( 'a' ) || pressedKeys.has( 's' ) || pressedKeys.has( 'd' );
		const stillWalking = walkState.enabled && Math.hypot( walkState.velocity.x, walkState.velocity.z ) > 0.05;
		if ( pressingMove || dragging || stillWalking ) {

			activity.idleSeconds = 0;
			activity.interacted = true;

		} else activity.idleSeconds += dt;

	}

	function update( dt ) {

		updateActivity( dt );

		if ( director.freeMode ) {

			updateFree( dt );
			return;

		}

		if ( externalState.active ) {

			returnDragOffsets( dt, flightDrag.returnDamping );
			// 限制收紧时，已经拖出去的部分在半秒左右里拉回限制以内（不跳）
			if ( flightDragLimit ) {

				const pull = 1 - Math.exp( - 5 * dt );
				const clampedYaw = Math.max( - flightDragLimit[ 0 ], Math.min( flightDragLimit[ 0 ], yawOffset ) );
				const clampedPitch = Math.max( - flightDragLimit[ 1 ], Math.min( flightDragLimit[ 1 ], pitchOffset ) );
				yawOffset += ( clampedYaw - yawOffset ) * pull;
				pitchOffset += ( clampedPitch - pitchOffset ) * pull;

			}

			writeWithDrag( externalState.position, externalState.quaternion, externalState.fov );
			applySway( dt, 0, 'float' );
			return;

		}

		if ( walkState.enabled ) {

			// 步伐按真实走过的距离推进：顶着岩石、边界走不动时速度还在，但人没动，不能还在颠
			const previousX = walkState.position.x;
			const previousZ = walkState.position.z;
			updateWalk( dt );
			lastBase.position.copy( camera.position );
			lastBase.quaternion.copy( camera.quaternion );
			lastBase.fov = cameraConfig.fov;
			const travelled = Math.hypot( walkState.position.x - previousX, walkState.position.z - previousZ );
			applySway( dt, dt > 0 ? travelled / dt : 0, 'walk' );
			return;

		}

		returnDragOffsets( dt, cameraConfig.dragReturnDamping );
		evaluateRoute();
		writeWithDrag( tempPosition, baseQuaternion, currentFov );
		applySway( dt, 0, 'float' );

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

		// 飞行时最多 ±30°（规格书 5.3），固定机位（星月夜）按 config.camera 的 ±60° / ±25°，全景模式按 dragOptions（转一整圈）
		const options = dragOptions && ! externalState.active ? dragOptions : null;
		const yawMax = externalState.active ? ( flightDragLimit ? flightDragLimit[ 0 ] : flightDrag.yawMax ) : ( options ? options.yawMax : cameraConfig.dragYawMax );
		const pitchMax = externalState.active ? ( flightDragLimit ? flightDragLimit[ 1 ] : flightDrag.pitchMax ) : ( options ? options.pitchMax : cameraConfig.dragPitchMax );
		lastDragTime = performance.now();
		yawOffset -= deltaX * cameraConfig.dragSensitivity;
		pitchOffset -= deltaY * cameraConfig.dragSensitivity;
		// 能转一整圈时把偏航包到 ±180°（回正走近的那一边）
		if ( yawMax >= 180 ) yawOffset = ( ( yawOffset + 180 ) % 360 + 360 ) % 360 - 180;
		else yawOffset = Math.max( - yawMax, Math.min( yawMax, yawOffset ) );
		pitchOffset = Math.max( - pitchMax, Math.min( pitchMax, pitchOffset ) );

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

	// 飞行：时间线每帧给位姿（当前渲染场景的坐标系）。第一次进来时把拖动偏移清零（起点位姿已经带着她拖过的朝向）
	function setExternalPose( position, quaternion, fov = cameraConfig.fov ) {

		if ( ! externalState.active ) {

			externalState.active = true;
			yawOffset = 0;
			pitchOffset = 0;

		}

		externalState.position.copy( position );
		externalState.quaternion.copy( quaternion );
		externalState.fov = fov;

	}

	// 飞行结束交还：步行时把还没回正的拖动偏移并进朝向（不跳），路线、固定机位保留偏移让它自己回正
	function clearExternal() {

		if ( ! externalState.active ) return;
		externalState.active = false;
		if ( walkState.enabled ) {

			walkState.yaw += THREE.MathUtils.degToRad( yawOffset );
			walkState.pitch += THREE.MathUtils.degToRad( pitchOffset );
			yawOffset = 0;
			pitchOffset = 0;

		}

	}

	// 现在的位姿（没加晃动，当前渲染场景的坐标，带着她拖过的朝向）；返回视场角。
	// 按当前模式现算，不等下一帧（刚进地点就起飞时 lastBase 还是旧的）
	function getBasePose( targetPosition, targetQuaternion ) {

		if ( externalState.active ) {

			targetPosition.copy( externalState.position );
			targetQuaternion.copy( externalState.quaternion );
			return externalState.fov;

		}

		if ( walkState.enabled ) {

			walkEuler.set( walkState.pitch, walkState.yaw, 0, 'YXZ' );
			targetPosition.copy( walkState.position );
			targetQuaternion.setFromEuler( walkEuler );
			return cameraConfig.fov;

		}

		if ( keyframes.length > 0 ) {

			evaluateRoute();
			yawQuaternion.setFromAxisAngle( axisY, THREE.MathUtils.degToRad( yawOffset ) );
			pitchQuaternion.setFromAxisAngle( axisX, THREE.MathUtils.degToRad( pitchOffset ) );
			targetPosition.copy( tempPosition );
			targetQuaternion.copy( yawQuaternion ).multiply( baseQuaternion ).multiply( pitchQuaternion );
			return currentFov;

		}

		targetPosition.copy( lastBase.position );
		targetQuaternion.copy( lastBase.quaternion );
		return lastBase.fov;

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
		// 自由相机：直接摆到某处看向某处（秘境俯瞰、截图机位用）；要先打开 freeMode
		setFreePose: ( position, lookAt ) => {

			freeState.position.fromArray( position );
			const angles = anglesFromLookAt( freeState.position, tempTarget.fromArray( lookAt ) );
			freeState.yaw = angles.yaw;
			freeState.pitch = angles.pitch;

		},
		setFreeSpeed: ( metersPerSecond ) => {

			freeSpeed = Number.isFinite( metersPerSecond ) && metersPerSecond > 0 ? metersPerSecond : null;

		},
		// 全景烘焙时关掉呼吸和步伐晃动
		setSwayEnabled: ( enabled ) => {

			swayState.enabled = Boolean( enabled );

		},
		// 场景退出时调：不再步行，也不再引用那个场景的地面函数
		clearWalk: () => {

			walkState.enabled = false;
			walkState.groundHeight = null;
			walkState.obstacles = [];
			walkState.canWalk = null;

		},
		update,
		// 全景模式的拖动选项（null 恢复默认）
		setDragOptions: ( options ) => {

			dragOptions = options || null;

		},
		setExternalPose,
		clearExternal,
		setFlightDragLimit: ( limit ) => {

			flightDragLimit = Array.isArray( limit ) ? limit : null;

		},
		isExternal: () => externalState.active,
		getBasePose,
		// 她多久没动了（秒）：预加载、起飞前等她停下用
		getIdleSeconds: () => activity.idleSeconds,
		isMoving: () => activity.idleSeconds === 0,
		// 换地点时清零；这个地点里她拖过、走过没有（小提示用）
		hasInteracted: () => Boolean( activity.interacted ),
		resetInteracted: () => {

			activity.interacted = false;

		},
		// 时间线的连续时钟（换地点不归零），晃动按它走；传 null 回到按场景时间
		setSwayClock: ( time ) => {

			swayState.clock = Number.isFinite( time ) ? time : null;

		},
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
