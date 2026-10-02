// 秘境：世界坐标、地点、一天的日月和天色、世界高度、锚点。规格书 5.0。
// 坐标：+x 东、−z 北、y 海拔（米）；方位角从北顺时针量。
// 每个地点仍在自己的局部坐标里渲染，用"原点 + yaw"和世界互相换算：本地 −z 指向世界方位角 yaw，本地 (0,0,0) 在世界的 origin。

import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { jsFbm2D } from '../tsl/noise.js';

const degree = Math.PI / 180;

function smooth( edge0, edge1, value ) {

	// edge0 > edge1 时是递减的 smoothstep（JS 里没有 GPU 那种未定义行为）
	const amount = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return amount * amount * ( 3 - 2 * amount );

}

function gaussian( distance, width ) {

	const ratio = distance / width;
	return Math.exp( - ratio * ratio );

}

// 平滑取小：同上，取小的那个
function smoothMin( first, second, softness ) {

	return 0.5 * ( first + second - Math.sqrt( ( first - second ) * ( first - second ) + softness * softness ) );

}

// 平滑取大：两座山交界处是圆的，不是一道折痕
function smoothMax( first, second, softness ) {

	return 0.5 * ( first + second + Math.sqrt( ( first - second ) * ( first - second ) + softness * softness ) );

}

// 方位角、仰角（度）→ 单位方向
export function directionFromAngles( azimuthDegrees, elevationDegrees, target ) {

	const azimuth = azimuthDegrees * degree;
	const elevation = elevationDegrees * degree;
	return target.set( Math.sin( azimuth ) * Math.cos( elevation ), Math.sin( elevation ), - Math.cos( azimuth ) * Math.cos( elevation ) );

}

// 山洞中线和截面（见 createWorld 里的说明）
function buildCave( caveConfig ) {

	if ( ! caveConfig || ! Array.isArray( caveConfig.path ) || caveConfig.path.length < 2 ) throw new Error( '秘境：config.world.cave.path 至少要两个点' );
	const curve = new THREE.CatmullRomCurve3( caveConfig.path.map( ( point ) => new THREE.Vector3( point[ 0 ], point[ 1 ], point[ 2 ] ) ), false, 'centripetal' );
	// 先密采样（按参数），再按累计弧长重采样成等距点；getPointAt 的弧长参数浮点超过 1 一点会返回 NaN，这里不用它
	const dense = [];
	const denseCount = 800;
	for ( let i = 0; i < denseCount; i ++ ) dense.push( curve.getPoint( i / ( denseCount - 1 ) ) );
	const denseAlong = [ 0 ];
	for ( let i = 1; i < dense.length; i ++ ) denseAlong.push( denseAlong[ i - 1 ] + dense[ i ].distanceTo( dense[ i - 1 ] ) );
	const length = denseAlong[ denseAlong.length - 1 ];
	const spacing = 0.5;
	const count = Math.ceil( length / spacing ) + 1;
	const points = [];
	let cursor = 0;
	for ( let i = 0; i < count; i ++ ) {

		const target = Math.min( length, i * length / ( count - 1 ) );
		while ( cursor < dense.length - 2 && denseAlong[ cursor + 1 ] < target ) cursor ++;
		const span = denseAlong[ cursor + 1 ] - denseAlong[ cursor ] || 1;
		points.push( new THREE.Vector3().lerpVectors( dense[ cursor ], dense[ cursor + 1 ], ( target - denseAlong[ cursor ] ) / span ) );

	}

	const step = length / ( count - 1 );
	function table( rows, fraction ) {

		if ( fraction <= rows[ 0 ][ 0 ] ) return rows[ 0 ][ 1 ];
		for ( let i = 1; i < rows.length; i ++ ) {

			if ( fraction <= rows[ i ][ 0 ] ) {

				const t = ( fraction - rows[ i - 1 ][ 0 ] ) / ( rows[ i ][ 0 ] - rows[ i - 1 ][ 0 ] );
				return rows[ i - 1 ][ 1 ] + ( rows[ i ][ 1 ] - rows[ i - 1 ][ 1 ] ) * t;

			}

		}

		return rows[ rows.length - 1 ][ 1 ];

	}

	// 沿洞 distance 米处：地面中心、水平切向（外 → 内）、宽、高
	function at( distance, target = {} ) {

		const clamped = Math.min( length, Math.max( 0, distance ) );
		const index = Math.min( count - 2, Math.floor( clamped / step ) );
		const t = ( clamped - index * step ) / step;
		target.position = ( target.position || new THREE.Vector3() ).lerpVectors( points[ index ], points[ index + 1 ], t );
		const before = points[ Math.max( 0, index - 1 ) ];
		const after = points[ Math.min( count - 1, index + 2 ) ];
		target.tangent = ( target.tangent || new THREE.Vector3() ).set( after.x - before.x, 0, after.z - before.z ).normalize();
		const fraction = clamped / length;
		target.width = table( caveConfig.widths, fraction );
		target.height = table( caveConfig.heights, fraction );
		target.fraction = fraction;
		return target;

	}

	return { points, length, spacing: step, at, handoffDistance: length * caveConfig.handoff, config: caveConfig };

}

export function createWorld( config ) {

	const worldConfig = config.world;
	const locations = worldConfig.locations;

	// ===================== 一天的天空关键帧 =====================

	const skyKeys = worldConfig.skyKeys.map( ( key ) => ( {
		...key,
		zenithColor: new THREE.Color( key.zenith ),
		horizonColor: new THREE.Color( key.horizon ),
		sunHorizonColor: new THREE.Color( key.sunHorizon ),
		earthShadowColor: new THREE.Color( key.earthShadow ),
		beltColor: new THREE.Color( key.belt ),
		glowColor: new THREE.Color( key.glow ),
	} ) ).sort( ( first, second ) => first.time - second.time );

	if ( skyKeys.length < 2 ) throw new Error( '秘境：config.world.skyKeys 至少要两个关键帧' );

	const uniforms = {
		dayTime: uniform( 5 ),
		sunDirection: uniform( new THREE.Vector3( 0, - 1, 0 ) ),    // 世界空间，指向太阳
		moonDirection: uniform( new THREE.Vector3( 0, 1, 0 ) ),
		skyIntensity: uniform( 1 ),
		zenithColor: uniform( new THREE.Color() ),
		horizonColor: uniform( new THREE.Color() ),
		sunHorizonColor: uniform( new THREE.Color() ),
		earthShadowColor: uniform( new THREE.Color() ),
		beltColor: uniform( new THREE.Color() ),
		beltAmount: uniform( 0 ),
		glowColor: uniform( new THREE.Color() ),
		glowAmount: uniform( 0 ),
		starAmount: uniform( 0 ),
		moonAmount: uniform( 0 ),
		sunLightColor: uniform( new THREE.Color() ),     // 照在地上的阳光（已乘强度）
		moonLightColor: uniform( new THREE.Color() ),
		sunDiscRadius: uniform( worldConfig.sunDiscRadius * degree ),
		sunDiscIntensity: uniform( worldConfig.sunDiscIntensity ),
		moonDiscRadius: uniform( worldConfig.moonDiscRadius * degree ),
		windowLights: uniform( 0 ),                      // 窗灯亮的程度：入夜亮，天亮熄
		hazeDistance: uniform( worldConfig.hazeDistance ),
		mistAmount: uniform( 0 ),                        // 贴地薄雾：清晨、入夜在低处的盆地和湖上
		sunElevation: uniform( 0 ),                      // 太阳、月亮仰角（度），远景的地形阴影要用
		moonElevation: uniform( 0 ),
		// 4b 交接用：地点天空渐变到统一天空、地点内容化进薄雾
		worldSkyBlend: uniform( 0 ),
		locationVeil: uniform( 0 ),
	};

	const state = { dayTime: 5, anchorKey: null };
	const sunWarm = new THREE.Color( '#ff9a5a' );
	const sunWhite = new THREE.Color( '#fff4e6' );
	const moonTint = new THREE.Color( '#aabbe0' );
	const sunAngles = { azimuth: 0, elevation: 0 };
	const moonAngles = { azimuth: 0, elevation: 0 };

	// 方位角走最短的那一边插值
	function lerpAzimuth( from, to, amount ) {

		const delta = ( ( to - from ) % 360 + 540 ) % 360 - 180;
		return from + delta * amount;

	}

	// 时刻 → 前后两个关键帧和插值比例（首尾相接，24 小时循环）。linear 给日月角度用（匀速走），amount 给颜色用（两头缓）
	function keysAt( hours ) {

		const time = ( ( hours % 24 ) + 24 ) % 24;
		let previous = skyKeys[ skyKeys.length - 1 ];
		let next = skyKeys[ 0 ];
		for ( let i = 0; i < skyKeys.length; i ++ ) {

			if ( skyKeys[ i ].time <= time ) {

				previous = skyKeys[ i ];
				next = skyKeys[ ( i + 1 ) % skyKeys.length ];

			}

		}

		const span = ( ( next.time - previous.time ) % 24 + 24 ) % 24 || 24;
		const elapsed = ( ( time - previous.time ) % 24 + 24 ) % 24;
		const linear = Math.min( 1, elapsed / span );
		return { time, previous, next, linear, amount: linear * linear * ( 3 - 2 * linear ) };

	}

	// 某个时刻的日月角度（度），不改当前时刻：地点在别的时刻后台加载时，按自己的时刻先把环境光贴图做好
	function anglesAt( hours ) {

		const { previous, next, linear } = keysAt( hours );
		return {
			sun: { azimuth: lerpAzimuth( previous.sun[ 0 ], next.sun[ 0 ], linear ), elevation: previous.sun[ 1 ] + ( next.sun[ 1 ] - previous.sun[ 1 ] ) * linear },
			moon: { azimuth: lerpAzimuth( previous.moon[ 0 ], next.moon[ 0 ], linear ), elevation: previous.moon[ 1 ] + ( next.moon[ 1 ] - previous.moon[ 1 ] ) * linear },
		};

	}

	function setDayTime( hours ) {

		if ( ! Number.isFinite( hours ) ) {

			console.error( '秘境：setDayTime 收到的时刻不是数字，忽略：', hours );
			return;

		}

		const { time, previous, next, amount } = keysAt( hours );
		state.dayTime = time;
		uniforms.dayTime.value = time;

		const angles = anglesAt( time );
		sunAngles.azimuth = angles.sun.azimuth;
		sunAngles.elevation = angles.sun.elevation;
		moonAngles.azimuth = angles.moon.azimuth;
		moonAngles.elevation = angles.moon.elevation;
		directionFromAngles( sunAngles.azimuth, sunAngles.elevation, uniforms.sunDirection.value );
		directionFromAngles( moonAngles.azimuth, moonAngles.elevation, uniforms.moonDirection.value );

		uniforms.skyIntensity.value = previous.intensity + ( next.intensity - previous.intensity ) * amount;
		uniforms.zenithColor.value.copy( previous.zenithColor ).lerp( next.zenithColor, amount );
		uniforms.horizonColor.value.copy( previous.horizonColor ).lerp( next.horizonColor, amount );
		uniforms.sunHorizonColor.value.copy( previous.sunHorizonColor ).lerp( next.sunHorizonColor, amount );
		uniforms.earthShadowColor.value.copy( previous.earthShadowColor ).lerp( next.earthShadowColor, amount );
		uniforms.beltColor.value.copy( previous.beltColor ).lerp( next.beltColor, amount );
		uniforms.glowColor.value.copy( previous.glowColor ).lerp( next.glowColor, amount );
		uniforms.beltAmount.value = previous.beltAmount + ( next.beltAmount - previous.beltAmount ) * amount;
		uniforms.glowAmount.value = previous.glowAmount + ( next.glowAmount - previous.glowAmount ) * amount;
		uniforms.starAmount.value = previous.stars + ( next.stars - previous.stars ) * amount;
		uniforms.mistAmount.value = ( previous.mist || 0 ) + ( ( next.mist || 0 ) - ( previous.mist || 0 ) ) * amount;
		uniforms.sunElevation.value = sunAngles.elevation;
		uniforms.moonElevation.value = moonAngles.elevation;
		uniforms.moonAmount.value = ( previous.moonLight + ( next.moonLight - previous.moonLight ) * amount ) * smooth( - 3, 3, moonAngles.elevation );

		// 阳光：贴地时偏橙、高了偏白；太阳沉到地平线以下就没了
		const sunElevation = sunAngles.elevation;
		uniforms.sunLightColor.value.copy( sunWarm ).lerp( sunWhite, smooth( 0, 25, sunElevation ) ).multiplyScalar( 2.4 * smooth( - 1.5, 5, sunElevation ) );
		uniforms.moonLightColor.value.copy( moonTint ).multiplyScalar( 0.35 * uniforms.moonAmount.value * smooth( 0, 10, moonAngles.elevation ) );
		// 窗灯：太阳低于 −2° 以后慢慢亮起，−9° 全亮；天亮前按同样的规律熄
		uniforms.windowLights.value = smooth( - 2, - 9, sunElevation );

	}

	// ===================== 坐标换算 =====================

	function locationOf( key ) {

		const location = locations[ key ];
		if ( ! location ) throw new Error( '秘境：没有叫「' + key + '」的地点' );
		return location;

	}

	// 下面几个换算的 key 传 null 表示"世界本身"（飞行时渲染的就是世界坐标），原样拷贝

	// 本地 → 世界：先绕 y 转（本地 −z 转到方位角 yaw），再平移到原点
	function toWorld( localPoint, key, target = new THREE.Vector3() ) {

		if ( key === null ) return target.copy( localPoint );
		const location = locationOf( key );
		const angle = - location.yaw * degree;
		const cosine = Math.cos( angle );
		const sine = Math.sin( angle );
		const x = localPoint.x * cosine + localPoint.z * sine;
		const z = - localPoint.x * sine + localPoint.z * cosine;
		return target.set( x + location.origin[ 0 ], localPoint.y + location.origin[ 1 ], z + location.origin[ 2 ] );

	}

	function toLocal( worldPoint, key, target = new THREE.Vector3() ) {

		if ( key === null ) return target.copy( worldPoint );
		const location = locationOf( key );
		const x = worldPoint.x - location.origin[ 0 ];
		const y = worldPoint.y - location.origin[ 1 ];
		const z = worldPoint.z - location.origin[ 2 ];
		const angle = location.yaw * degree;
		const cosine = Math.cos( angle );
		const sine = Math.sin( angle );
		return target.set( x * cosine + z * sine, y, - x * sine + z * cosine );

	}

	function directionToLocal( worldDirection, key, target = new THREE.Vector3() ) {

		if ( key === null ) return target.copy( worldDirection );
		const location = locationOf( key );
		const angle = location.yaw * degree;
		const cosine = Math.cos( angle );
		const sine = Math.sin( angle );
		return target.set( worldDirection.x * cosine + worldDirection.z * sine, worldDirection.y, - worldDirection.x * sine + worldDirection.z * cosine );

	}

	function directionToWorld( localDirection, key, target = new THREE.Vector3() ) {

		if ( key === null ) return target.copy( localDirection );
		const angle = - locationOf( key ).yaw * degree;
		const cosine = Math.cos( angle );
		const sine = Math.sin( angle );
		return target.set( localDirection.x * cosine + localDirection.z * sine, localDirection.y, - localDirection.x * sine + localDirection.z * cosine );

	}

	// 朝向换算：本地 → 世界是先绕 y 转 −yaw（three 的偏航角 = −方位角），世界 → 本地反过来
	const yawQuaternion = new THREE.Quaternion();
	const axisY = new THREE.Vector3( 0, 1, 0 );
	function quaternionToWorld( localQuaternion, key, target = new THREE.Quaternion() ) {

		if ( key === null ) return target.copy( localQuaternion );
		yawQuaternion.setFromAxisAngle( axisY, - locationOf( key ).yaw * degree );
		return target.multiplyQuaternions( yawQuaternion, localQuaternion );

	}

	function quaternionToLocal( worldQuaternion, key, target = new THREE.Quaternion() ) {

		if ( key === null ) return target.copy( worldQuaternion );
		yawQuaternion.setFromAxisAngle( axisY, locationOf( key ).yaw * degree );
		return target.multiplyQuaternions( yawQuaternion, worldQuaternion );

	}

	// 世界 → 当前锚点局部系的矩阵（远景根节点用它挂进地点的场景里）；锚点为空就是单位矩阵
	const anchorRotation = new THREE.Matrix4();
	const anchorTranslation = new THREE.Matrix4();
	function worldToLocationMatrix( key, target = new THREE.Matrix4() ) {

		if ( ! key ) return target.identity();
		const location = locationOf( key );
		anchorRotation.makeRotationY( location.yaw * degree );
		anchorTranslation.makeTranslation( - location.origin[ 0 ], - location.origin[ 1 ], - location.origin[ 2 ] );
		return target.multiplyMatrices( anchorRotation, anchorTranslation );

	}

	function worldToAnchorMatrix( target = new THREE.Matrix4() ) {

		return worldToLocationMatrix( state.anchorKey, target );

	}

	function setAnchor( key ) {

		if ( key !== null ) locationOf( key );
		state.anchorKey = key;

	}

	// 地点停留的时刻范围 [开始, 结束]（小时）；结束可以超过 24（星月夜 23:40 → 00:30）
	function locationHours( key ) {

		const hours = locationOf( key ).time;
		if ( ! Array.isArray( hours ) || hours.length !== 2 ) throw new Error( `秘境：地点「${ key }」没写 time: [开始, 结束]` );
		return hours;

	}

	// 地点停留时的相机远近、远景深度压缩、替身要不要藏（没写的用默认值）。
	// 默认 far 30000、不压缩：24 位深度的精度几乎只由 near 决定，far 从 2000 改成 30000 远处不会多闪（4b 实测两帧差分一样），
	// 地点自己的海面、天空也就不用跟着压缩。压缩（compressStart → compressEnd，end 不超过 0.85 × far）留着给要小 far 的地点用
	const defaultView = { near: 0.1, far: 30000, compressStart: null, compressEnd: null, hideProxy: true };
	function locationView( key ) {

		return { ...defaultView, ...( locationOf( key ).view || {} ) };

	}

	// ===================== 水系 =====================

	// 控制点之间用 Catmull-Rom 曲线重采样成约 25 米一段，再沿法线方向加 ±14 米的蜿蜒（fbm 沿河长变化）；
	// 两头 60 米以内和地点原点 160 米以内不蜿蜒：源头、入湖入海口、渔人的船都要在规定的位置
	function resampleRiver( river, seed ) {

		const controls = river.points.map( ( point ) => new THREE.Vector3( point[ 0 ], point[ 1 ], point[ 2 ] ) );
		const curve = [];
		for ( let i = 0; i < controls.length - 1; i ++ ) {

			const before = controls[ Math.max( 0, i - 1 ) ];
			const start = controls[ i ];
			const end = controls[ i + 1 ];
			const after = controls[ Math.min( controls.length - 1, i + 2 ) ];
			const steps = Math.max( 1, Math.ceil( start.distanceTo( end ) / 25 ) );
			for ( let step = 0; step < steps; step ++ ) {

				const amount = step / steps;
				const amountSquared = amount * amount;
				const amountCubed = amountSquared * amount;
				const point = new THREE.Vector3();
				for ( const axis of [ 'x', 'z' ] ) {

					point[ axis ] = 0.5 * ( 2 * start[ axis ] + ( end[ axis ] - before[ axis ] ) * amount
						+ ( 2 * before[ axis ] - 5 * start[ axis ] + 4 * end[ axis ] - after[ axis ] ) * amountSquared
						+ ( 3 * start[ axis ] - before[ axis ] - 3 * end[ axis ] + after[ axis ] ) * amountCubed );

				}

				// 水位沿控制点线性变化（不跟曲线过冲）
				point.y = start.y + ( end.y - start.y ) * amount;
				curve.push( point );

			}

		}

		curve.push( controls[ controls.length - 1 ].clone() );

		// 沿河长累计距离，按它取蜿蜒量
		let total = 0;
		const along = [ 0 ];
		for ( let i = 1; i < curve.length; i ++ ) {

			total += Math.hypot( curve[ i ].x - curve[ i - 1 ].x, curve[ i ].z - curve[ i - 1 ].z );
			along.push( total );

		}

		return curve.map( ( point, index ) => {

			const previous = curve[ Math.max( 0, index - 1 ) ];
			const next = curve[ Math.min( curve.length - 1, index + 1 ) ];
			const tangentX = next.x - previous.x;
			const tangentZ = next.z - previous.z;
			const tangentLength = Math.hypot( tangentX, tangentZ ) || 1;
			let keep = smooth( 0, 60, along[ index ] ) * smooth( total, total - 60, along[ index ] );
			for ( const location of Object.values( locations ) ) keep *= 1 - gaussian( Math.hypot( point.x - location.origin[ 0 ], point.z - location.origin[ 2 ] ), 160 );
			const meander = ( jsFbm2D( along[ index ] / 220 + seed, seed * 0.7, 3 ) - 0.5 ) * 2 * 14 * keep;
			return new THREE.Vector3( point.x - tangentZ / tangentLength * meander, point.y, point.z + tangentX / tangentLength * meander );

		} );

	}

	const rivers = worldConfig.rivers.map( ( river, index ) => {

		if ( typeof river.key !== 'string' || ! river.key ) throw new Error( '秘境：config.world.rivers 第 ' + index + ' 条河没有 key' );
		const points = resampleRiver( river, 3.1 + index * 7.3 );
		const segments = [];
		for ( let i = 0; i < points.length - 1; i ++ ) {

			const start = points[ i ];
			const end = points[ i + 1 ];
			segments.push( {
				start, end,
				minX: Math.min( start.x, end.x ), maxX: Math.max( start.x, end.x ),
				minZ: Math.min( start.z, end.z ), maxZ: Math.max( start.z, end.z ),
			} );

		}

		const xs = points.map( ( point ) => point.x );
		const zs = points.map( ( point ) => point.z );
		return {
			...river,
			halfWidth: river.width / 2,
			points,
			segments,
			bounds: { minX: Math.min( ...xs ), maxX: Math.max( ...xs ), minZ: Math.min( ...zs ), maxZ: Math.max( ...zs ) },
		};

	} );

	// 按 key 找河；找不到直接报错（不悄悄跳过：河没了，地形、冰瀑、桃林、小镇都会不对）
	function getRiver( key ) {

		const river = rivers.find( ( item ) => item.key === key );
		if ( ! river ) throw new Error( '秘境：config.world.rivers 里没有 key 为「' + key + '」的河' );
		return river;

	}

	// 点到河中线的水平距离、最近点处的水位（沿线性插值），以及在源头上游多远（不在上游是 0）
	function nearestOnRiver( river, x, z ) {

		let bestDistance = Infinity;
		let bestLevel = 0;
		let upstream = 0;
		for ( let i = 0; i < river.segments.length; i ++ ) {

			const segment = river.segments[ i ];
			// 包围盒到点的距离已经比目前最近的远，这一段不用算
			const boxDistanceX = Math.max( segment.minX - x, 0, x - segment.maxX );
			const boxDistanceZ = Math.max( segment.minZ - z, 0, z - segment.maxZ );
			if ( boxDistanceX * boxDistanceX + boxDistanceZ * boxDistanceZ > bestDistance * bestDistance ) continue;
			const start = segment.start;
			const end = segment.end;
			const segmentX = end.x - start.x;
			const segmentZ = end.z - start.z;
			const lengthSquared = segmentX * segmentX + segmentZ * segmentZ;
			const projection = ( ( x - start.x ) * segmentX + ( z - start.z ) * segmentZ ) / lengthSquared;
			const along = Math.min( 1, Math.max( 0, projection ) );
			const closestX = start.x + segmentX * along;
			const closestZ = start.z + segmentZ * along;
			const distance = Math.hypot( x - closestX, z - closestZ );
			if ( distance < bestDistance ) {

				bestDistance = distance;
				bestLevel = start.y + ( end.y - start.y ) * along;
				upstream = i === 0 && projection < 0 ? - projection * Math.sqrt( lengthSquared ) : 0;

			}

		}

		return { distance: bestDistance, level: bestLevel, upstream };

	}

	// 源头头墙抬起多少（米）。默认是"源头往上游每米抬 headWallSlope 米"的一面平墙；
	// 河配了 headWallShape（桃花溪）时，墙脚、墙面按离溪轴线的横向距离加两层起伏：墙脚前后进退几米（大的扶壁、凹进去的湾），
	// 墙面上一道道几米宽的竖棱；溪轴线两边 innerCalm 米以内不动（泉眼、洞口在那里），往外慢慢加满。
	// 墙脚再加一段圆角（坡脚的碎石坡），不是从平地直角折上去
	function headWallRise( river, x, z ) {

		const slope = river.headWallSlope !== undefined ? river.headWallSlope : 6;
		const segment = river.segments[ 0 ];
		const axisX = segment.end.x - segment.start.x;
		const axisZ = segment.end.z - segment.start.z;
		const axisLength = Math.hypot( axisX, axisZ ) || 1;
		const directionX = axisX / axisLength;
		const directionZ = axisZ / axisLength;
		const offsetX = x - segment.start.x;
		const offsetZ = z - segment.start.z;
		// 往源头上游多远（下游是负的）、离溪轴线横向多远
		const behind = - ( offsetX * directionX + offsetZ * directionZ );
		const shape = river.headWallShape;
		if ( ! shape ) return Math.max( 0, behind ) * slope;
		if ( behind < - shape.footRadius - shape.footWander ) return 0;
		const lateral = offsetX * - directionZ + offsetZ * directionX;
		const shaping = smooth( shape.innerCalm, shape.innerCalm + 9, Math.abs( lateral ) );
		const ribs = smooth( 120, 80, Math.abs( lateral ) );   // 细棱只在开场的细地形那一块里，远景 12.5 米一格画不出
		const wander = ( ( jsFbm2D( lateral / 13 + 7.3, behind / 22 + 1.9, 2 ) - 0.5 ) * 2 * shape.footWander
			+ ( jsFbm2D( lateral / 3.6 - 2.2, behind / 9 + 4.4, 2 ) - 0.5 ) * 2 * shape.ribDepth * ribs ) * shaping;
		// 墙脚圆角的大小也按横向变（碎石坡有的地方高、有的地方矮），从正面看墙脚不是一条水平线
		const radius = shape.footRadius * ( 0.45 + 1.1 * jsFbm2D( lateral / 17 - 4.1, 2.6, 2 ) ) * shaping;
		const reach = behind + wander;
		if ( reach <= - radius ) return 0;
		if ( reach >= radius ) return reach * slope;
		return ( reach + radius ) * ( reach + radius ) / ( 4 * radius ) * slope;

	}

	const lake = worldConfig.lake;

	function lakeRadius( x, z ) {

		const offsetX = ( x - lake.center[ 0 ] ) / lake.radiusX;
		const offsetZ = ( z - lake.center[ 1 ] ) / lake.radiusZ;
		// 湖岸带一点起伏，不是正椭圆
		const angle = Math.atan2( offsetZ, offsetX );
		const wobble = 1 + 0.08 * Math.sin( angle * 3 + 0.7 ) + 0.05 * Math.sin( angle * 7 );
		return Math.hypot( offsetX, offsetZ ) / wobble;

	}

	// 湖岸的坡度（每米抬多少）：大部分是缓坡，东岸朝城堡那一段是陡崖
	const castleAngle = Math.atan2( ( locations.gothic.landmark[ 2 ] - lake.center[ 1 ] ) / lake.radiusZ, ( locations.gothic.landmark[ 0 ] - lake.center[ 0 ] ) / lake.radiusX );
	function lakeShoreSlope( x, z ) {

		const angle = Math.atan2( ( z - lake.center[ 1 ] ) / lake.radiusZ, ( x - lake.center[ 0 ] ) / lake.radiusX );
		const difference = Math.atan2( Math.sin( angle - castleAngle ), Math.cos( angle - castleAngle ) );
		return 0.25 + 2.8 * gaussian( difference, 0.45 );

	}

	// ===================== 世界高度 =====================

	// 大尺度的坐标扭曲：海岸线、山脚、山脊、台地崖都不是直线。关键位置附近不扭（各地点脚下、洞口、冰瀑、城堡崖），
	// 这些地方的地形要在规格书规定的坐标上
	const warpAnchors = [
		[ worldConfig.cave.inner[ 0 ], ( worldConfig.cave.inner[ 2 ] + worldConfig.cave.outer[ 2 ] ) / 2, 260 ],
		[ getRiver( 'townStream' ).points[ 0 ].x, getRiver( 'townStream' ).points[ 0 ].z, 280 ],
		...Object.values( locations ).map( ( location ) => [ location.origin[ 0 ], location.origin[ 2 ], 260 ] ),
		...Object.values( locations ).filter( ( location ) => location.landmark ).map( ( location ) => [ location.landmark[ 0 ], location.landmark[ 2 ], 200 ] ),
	];

	function warpStrength( x, z ) {

		let keep = 1;
		for ( const [ anchorX, anchorZ, radius ] of warpAnchors ) keep *= 1 - gaussian( Math.hypot( x - anchorX, z - anchorZ ), radius );
		return keep;

	}

	// 返回 [扭过的 x, 扭过的 z, 扭的强度 0~1]：幅度约 ±150 米，最大 ±300 米
	function warpedPosition( x, z ) {

		const strength = warpStrength( x, z );
		return [
			x + ( jsFbm2D( x / 1100 + 3.7, z / 1100 - 1.9, 3 ) - 0.5 ) * strength * 1000,
			z + ( jsFbm2D( x / 1100 - 6.2, z / 1100 + 4.4, 3 ) - 0.5 ) * strength * 1000,
			strength,
		];

	}

	// 台地有多"在台地上"：0 在盆地，1 在雪原台地。冰瀑那一段（x ≈ 150）是 110 米宽的陡崖（z -1650 ~ -1760），
	// 往两边慢慢放缓成 300 米宽的坡，崖线跟着扭，不是一整面直墙
	const iceFallX = getRiver( 'townStream' ).points[ 0 ].x;
	function plateauAmountAt( x, warpedZ ) {

		const steep = gaussian( x - iceFallX, 380 );
		return smooth( - 1650 + 80 * ( 1 - steep ), - 1760 - 110 * ( 1 - steep ), warpedZ );

	}

	function terrainBeforeWater( x, z, warped ) {

		const [ warpedX, warpedZ, warpAmount ] = warped;

		// 西海岸线大致在 x = −1290，两个岬角往西伸进海里
		const coastX = - 1290 - 230 * gaussian( warpedZ + 700, 260 ) - 210 * gaussian( warpedZ - 950, 240 ) + 35 * Math.sin( warpedZ * 0.0042 + 1.3 );

		// 盆地底：南边花园一带 24 米，往北到湖边 55 米，再顺北坡升到台地脚下约 215 米；小丘起伏 ±12 米，再叠一层平缓的大丘
		let valley = 24 + 31 * smooth( 1150, 150, z ) + 160 * Math.pow( smooth( - 330, - 1690, z ), 0.7 );
		valley += ( jsFbm2D( x / 260 + 11.3, z / 260 - 4.1, 4 ) - 0.5 ) * 24;
		valley += ( jsFbm2D( x / 700 - 2.9, z / 700 + 8.3, 3 ) - 0.5 ) * 40 * warpAmount;

		// 往西到海边降到 1.5 米的沙滩，再往外是海底（越往外越深，最深 40 米）
		let height = 1.5 + ( valley - 1.5 ) * smooth( coastX + 40, coastX + 650, warpedX );
		const seaFloor = - 3 - Math.min( 37, Math.max( 0, coastX - warpedX ) * 0.05 );
		height = height + ( seaFloor - height ) * smooth( coastX + 30, coastX - 120, warpedX );

		// 东岭：350~650 米，日出山口那段低一截
		const sunrisePass = 1 - 0.55 * gaussian( warpedZ - 810, 230 );
		const eastRidge = smooth( 1150, 1850, warpedX ) * ( 330 + 300 * jsFbm2D( x / 650 + 3.3, z / 650 - 1.2, 5 ) ) * sunrisePass;

		// 南岭：250~450 米，洞口所在的鞍部（x ≈ −520）低一截；岭的南边是山外的桃花溪谷。两侧的坡约 400 米宽
		const southBand = smooth( 1330, 1720, warpedZ ) * smooth( 2260, 1880, warpedZ );
		const saddle = 1 - 0.62 * gaussian( x + 520, 220 );
		const southRidge = southBand * ( 260 + 190 * jsFbm2D( x / 560 - 5.1, z / 560 + 2.7, 5 ) ) * saddle;

		// 两个伸进海里的岬角
		const headlands = 270 * gaussian( warpedZ + 700, 230 ) * gaussian( warpedX + 1300, 270 ) + 240 * gaussian( warpedZ - 950, 220 ) * gaussian( warpedX + 1270, 250 );

		// 山外：南边桃花溪谷两侧的山，溪谷（x ≈ −450）留出来
		const outerSouth = smooth( 2050, 2350, warpedZ ) * ( 80 + 200 * jsFbm2D( x / 700 + 9.2, z / 700 - 3.3, 4 ) ) * ( 1 - 0.85 * gaussian( x + 450, 320 ) );

		// 山的细节：脊状噪声，越高的地方越粗糙
		const mountainBase = Math.max( eastRidge, southRidge, headlands, outerSouth );
		const ridged = 1 - Math.abs( 2 * jsFbm2D( x / 180 - 2.2, z / 180 + 6.6, 4 ) - 1 );
		const mountain = mountainBase + ridged * ridged * 60 * smooth( 60, 300, mountainBase );

		// 平滑取大让山脚圆润；没有山的地方（海、盆地中间）不取，免得把海底抬起来
		height += ( smoothMax( height, mountain, 45 ) - height ) * smooth( 0, 30, mountainBase );

		// 北面雪原台地：南缘是冰瀑崖（约 110 米宽的坡升到 560 米），台地以北是更高的雪丘
		const plateauHeight = 560 + ( jsFbm2D( x / 300 + 1.7, z / 300 - 8.8, 3 ) - 0.5 ) * 40 + 140 * smooth( - 2250, - 2800, warpedZ ) * jsFbm2D( x / 500 + 7.1, z / 500, 3 );
		// 台地往西到海边慢慢降下去（像一条伸进海里的雪岬），不是从海里直接立起一面墙
		const plateauToCoast = smooth( coastX - 150, coastX + 500, warpedX );
		const plateauAmount = plateauAmountAt( x, warpedZ );
		// 台地边上的坡带冲沟：脊状噪声只加在过渡带上，陡的地方露出岩石，不是一整块圆润的雪坡
		const gully = ( 1 - Math.abs( 2 * jsFbm2D( x / 140 + 4.4, z / 140 - 7.7, 3 ) - 1 ) ) * 55 * 4 * plateauAmount * ( 1 - plateauAmount );
		height = height + ( plateauHeight * plateauToCoast + height * ( 1 - plateauToCoast ) - height ) * plateauAmount + gully * plateauToCoast;

		// 湖东岸的崖：哥特城堡站在上面（约 95 米）。平顶、四周 60 米内陡下去的岩台；朝湖那面再被湖岸的陡坡切成崖
		height += 48 * smooth( 150, 90, Math.hypot( x - 545, z + 230 ) );

		return height;

	}

	// 方位角（度）→ 水平单位方向 [x, z]
	function facingOf( azimuthDegrees ) {

		return [ Math.sin( azimuthDegrees * degree ), - Math.cos( azimuthDegrees * degree ) ];

	}

	// 洞口朝外的水平单位方向：从洞的另一头指向这一头
	function caveFacing( from, to ) {

		const length = Math.hypot( to[ 0 ] - from[ 0 ], to[ 2 ] - from[ 2 ] );
		return [ ( to[ 0 ] - from[ 0 ] ) / length, ( to[ 2 ] - from[ 2 ] ) / length ];

	}

	// 地点脚下压平：这些地方之后会被地点自己的细节地形盖住，世界地形要先在对的高度上
	const flattenSpots = [
		{ position: locations.garden.origin, radius: 260, height: locations.garden.origin[ 1 ] },
		{ position: locations.garden.landmark, radius: 220, height: locations.garden.landmark[ 1 ] },
		// 落日：陆侧压到 0.3 米（落日自己的沙滩、礁石都比它高，不会穿出来）；海侧挖到 −3 米，世界的陆地不伸进落日自己的海里
		{ position: locations.sunset.origin, radius: 130, height: 0.3, facing: facingOf( locations.sunset.yaw + 180 ) },
		{ position: locations.sunset.origin, radius: 360, height: - 3, facing: facingOf( locations.sunset.yaw ), edgeWidth: 8 },
		{ position: locations.gothic.origin, radius: 60, height: locations.gothic.origin[ 1 ] - 1.5 },
		{ position: locations.gothic.landmark, radius: 90, height: locations.gothic.landmark[ 1 ] - 1 },
		// 星月夜机位：只压平身后，前面顺着山坡在 90 米里缓缓降下去，站在坡上往下看得见小镇和湖（不能是一块平台挡住视线）
		{ position: locations.starry.origin, radius: 80, height: locations.starry.origin[ 1 ] - 1.5, facing: facingOf( locations.starry.yaw + 180 ), edgeWidth: 90 },
		{ position: locations.starry.landmark, radius: 160, height: locations.starry.landmark[ 1 ] },
		// 雪原：原点在台地南缘崖边 20 米内（2026-10-01 定：先朝南看整个秘境的夜景，再转身往北沿脚印走）；
		// 只压平北边（脚印那一侧），南边保留天然的崖缘，站在原点往南看得见下面的盆地
		{ position: locations.aurora.origin, radius: 450, height: locations.aurora.origin[ 1 ], facing: facingOf( 0 ), edgeWidth: 8, frontSlope: 0.3, frontReach: 70 },
		// 洞口只压平洞口外面的半边（facing 是洞口朝外的方向），洞顶上的山梁要留着
		{ position: worldConfig.cave.outer, radius: 45, height: worldConfig.cave.outer[ 1 ], facing: caveFacing( worldConfig.cave.inner, worldConfig.cave.outer ) },
		{ position: worldConfig.cave.inner, radius: 45, height: worldConfig.cave.inner[ 1 ], facing: caveFacing( worldConfig.cave.outer, worldConfig.cave.inner ) },
	];

	// 要留出来的视线：从地点的眼睛看到另一个地点的地标（规格书 5.0"互相看得见"）。
	// 视线下方两侧各约 150 米的地面压到视线以下 8 米（缓缓的一道低谷，看不出是故意的）；两头各留 12% 不压
	const lakeCenter = [ lake.center[ 0 ], lake.level, lake.center[ 1 ] ];
	const sightlines = [
		[ locations.sunset.origin, locations.gothic.landmark ],
		[ locations.starry.origin, locations.gothic.landmark ],
		[ locations.starry.origin, lakeCenter ],
	].map( ( [ from, to ] ) => ( {
		fromX: from[ 0 ], fromY: from[ 1 ] + 1.7, fromZ: from[ 2 ],
		toX: to[ 0 ], toY: to[ 1 ], toZ: to[ 2 ],
		length: Math.hypot( to[ 0 ] - from[ 0 ], to[ 2 ] - from[ 2 ] ),
	} ) );

	function applySightlines( x, z, height ) {

		let result = height;
		for ( const line of sightlines ) {

			const directionX = ( line.toX - line.fromX ) / line.length;
			const directionZ = ( line.toZ - line.fromZ ) / line.length;
			const along = ( ( x - line.fromX ) * directionX + ( z - line.fromZ ) * directionZ ) / line.length;
			if ( along < 0.05 || along > 0.95 ) continue;
			const lateral = Math.abs( - ( x - line.fromX ) * directionZ + ( z - line.fromZ ) * directionX );
			const weight = gaussian( lateral, 150 ) * smooth( 0.05, 0.12, along ) * smooth( 0.95, 0.88, along );
			const cap = line.fromY + ( line.toY - line.fromY ) * along - 8;
			if ( result > cap ) result -= ( result - cap ) * weight;

		}

		return result;

	}

	// 世界高度（米）、水位（没有水是 -Infinity）、水的种类（'sea' / 'lake' / 'river' / ''）、在雪原台地上的程度（0~1）。
	// 远景网格、地点替身摆放、飞行航线离地检查都用它
	function sample( x, z ) {

		const warped = warpedPosition( x, z );
		let height = terrainBeforeWater( x, z, warped );

		for ( const spot of flattenSpots ) {

			const offsetX = x - spot.position[ 0 ];
			const offsetZ = z - spot.position[ 2 ];
			let weight = smooth( spot.radius, spot.radius * 0.55, Math.hypot( offsetX, offsetZ ) );
			// 半圆：只压 facing 那一侧；另一侧在 edgeWidth 米（默认 8 米，洞口那种陡壁）以内过渡回原地形
			if ( spot.facing ) weight *= smooth( - ( spot.edgeWidth || 8 ), 2, offsetX * spot.facing[ 0 ] + offsetZ * spot.facing[ 1 ] );
			height += ( spot.height - height ) * weight;

			// 看台：不压平的那一侧（前方）地面不许高过"原点高度 − 前方距离 × frontSlope"，缓缓往下，站在原点能越过前面的边看到下面
			if ( spot.frontSlope ) {

				const front = - ( offsetX * spot.facing[ 0 ] + offsetZ * spot.facing[ 1 ] );
				const cap = spot.height - Math.max( 0, front ) * spot.frontSlope;
				if ( front > 0 && height > cap ) height += ( cap - height ) * smooth( spot.frontReach, spot.frontReach * 0.6, front );

			}

		}

		height = applySightlines( x, z, height );

		let waterLevel = - Infinity;
		let waterKind = '';

		// 湖：岸线以内挖到湖底，水位 55 米
		const radius = lakeRadius( x, z );
		if ( radius < 1.35 ) {

			const bed = lake.level - 9 * ( 1 - Math.min( 1, radius * radius ) );
			const shore = lake.level + 0.6 + Math.max( 0, radius - 1 ) * lake.radiusX * lakeShoreSlope( x, z );
			height = Math.min( height, radius < 1 ? bed : shore );
			if ( radius < 1 ) {

				waterLevel = lake.level;
				waterKind = 'lake';

			}

		}

		// 河和溪：沿中线挖出河床，两岸往外慢慢抬起来（V 形的河谷）。
		// 源头往上游不挖河谷：水从山壁的石缝里流出来，上游方向每米抬 2.4 米，是一面陡的头墙
		for ( const river of rivers ) {

			const bounds = river.bounds;
			if ( x < bounds.minX - 300 || x > bounds.maxX + 300 || z < bounds.minZ - 300 || z > bounds.maxZ + 300 ) continue;
			const nearest = nearestOnRiver( river, x, z );
			if ( nearest.distance > 300 ) continue;
			// 源头往上游每米抬 headWallSlope 米（默认 6，一面陡墙；桃花溪 1.8："便得一山"是一面陡坡，洞口在坡脚）
			const headWall = headWallRise( river, x, z );
			if ( nearest.distance < river.halfWidth && nearest.upstream < river.halfWidth * 0.5 ) {

				const ratio = nearest.distance / river.halfWidth;
				height = Math.min( height, nearest.level - 2.2 * ( 1 - ratio * ratio ) + headWall );
				if ( nearest.level > waterLevel && waterKind !== 'lake' && waterKind !== 'sea' ) {

					waterLevel = nearest.level;
					waterKind = 'river';

				}

			} else {

				// 岸：离水边每米抬 bankSlope 米（默认 0.32），再加一个二次项让河谷越往外越陡；桃花溪的河谷宽而平（两岸是桃林）
				const excess = Math.max( 0, nearest.distance - river.halfWidth );
				const bankSlope = river.bankSlope !== undefined ? river.bankSlope : 0.32;
				const bankCurve = river.bankCurve !== undefined ? river.bankCurve : 0.004;
				const bank = nearest.level + 0.4 + excess * bankSlope + excess * excess * bankCurve + headWall;
				// 配了头墙起伏的溪（桃花溪）：挖出来的谷坡和原来的山坡交成圆角（平滑取小），头墙的两头不是一刀切出来的竖棱
				const carved = river.headWallShape ? smoothMin( height, bank, river.headWallShape.creaseSoftness ) : Math.min( height, bank );
				height += ( carved - height ) * smooth( 300, 200, nearest.distance );

			}

		}

		// 海：低于 0 的地方都是海（湖、河已经有自己的水位；河口处水位不到 0.5 米的河段也算海，河水和海面接平）
		if ( height < 0 && ( waterLevel === - Infinity || ( waterKind === 'river' && waterLevel <= 0.5 ) ) ) {

			waterLevel = 0;
			waterKind = 'sea';

		}

		return { height, waterLevel, waterKind, plateau: plateauAmountAt( x, warped[ 1 ] ) };

	}

	function worldHeight( x, z ) {

		return sample( x, z ).height;

	}

	// ===================== 山洞 =====================
	// 洞地面的中线：config.world.cave.path 的控制点（外口 → 内口）用 Catmull-Rom 重采样成每 0.5 米一个点（按弧长）；
	// 截面的宽、高按沿洞的比例从 widths / heights 表里线性插值。远景的洞壁、开场和花园的镜头都用它，交接时位置对得上
	const cave = buildCave( worldConfig.cave );

	setDayTime( 5 );

	return {
		config: worldConfig,
		locations,
		uniforms,
		rivers,
		setDayTime,
		getDayTime: () => state.dayTime,
		getSunAngles: () => ( { ...sunAngles } ),
		getMoonAngles: () => ( { ...moonAngles } ),
		anglesAt,
		toWorld,
		toLocal,
		directionToLocal,
		directionToWorld,
		quaternionToWorld,
		quaternionToLocal,
		worldToAnchorMatrix,
		worldToLocationMatrix,
		setAnchor,
		getAnchor: () => state.anchorKey,
		locationHours,
		locationView,
		sample,
		worldHeight,
		lakeRadius,
		nearestOnRiver,
		headWallRise,
		getRiver,
		cave,
	};

}
