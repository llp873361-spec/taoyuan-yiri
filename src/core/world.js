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

// 多项式平滑取小（Inigo Quilez 的 smin）：两个值相差超过 softness 时就是普通的取小，只在交线附近 softness 范围里做圆角；
// 不像上面那个开方版本会把离得很远的地方也压低几米（花园离河 100 米的地面会被压低 2~3 米）
function smoothMinLocal( first, second, softness ) {

	const blend = Math.min( 1, Math.max( 0, 0.5 + 0.5 * ( second - first ) / softness ) );
	return second + ( first - second ) * blend - softness * blend * ( 1 - blend );

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

	// 湖岸往外的坡：离岸的米数 × 坡度（lakeShoreSlope）。城堡那一段是 72° 的崖（哥特岩台朝湖的那一面就是它削出来的），
	// 那一段不能是一整块光滑的斜板（2026-10-02 自查：从机位看岩台像个梯形台子）：沿岸 35 米上下一个的岩嘴 / 冲沟（±10 米）、
	// 14 米一道的竖岩柱（往湖里伸 0~9 米）、5 米一道的细肋，崖高按 10 米一级带一点岩层台阶，再叠 4 米的凹凸。缓的岸上这些都不加
	function lakeShoreHeight( x, z, radius ) {

		const angle = Math.atan2( ( z - lake.center[ 1 ] ) / lake.radiusZ, ( x - lake.center[ 0 ] ) / lake.radiusX );
		const difference = Math.atan2( Math.sin( angle - castleAngle ), Math.cos( angle - castleAngle ) );
		const steep = gaussian( difference, 0.45 );
		const shoreX = lake.center[ 0 ] + Math.cos( angle ) * lake.radiusX;
		const shoreZ = lake.center[ 1 ] + Math.sin( angle ) * lake.radiusZ;
		const lobes = ( jsFbm2D( shoreX / 35 + 2.9, shoreZ / 35 - 7.4, 2 ) - 0.5 ) * 2 * 10;
		const ridged = 1 - Math.abs( 2 * jsFbm2D( shoreX / 14 - 6.1, shoreZ / 14 + 3.3, 2 ) - 1 );
		const fineRidged = 1 - Math.abs( 2 * jsFbm2D( shoreX / 5 + 4.4, shoreZ / 5 - 1.6, 2 ) - 1 );
		const outward = Math.max( 0, ( radius - 1 ) * lake.radiusX + ( lobes + ridged * ridged * 9 + fineRidged * fineRidged * 2.5 ) * steep );
		let rise = outward * lakeShoreSlope( x, z );
		rise += ( Math.round( rise / 10 ) * 10 - rise ) * 0.3 * steep;
		rise += ( jsFbm2D( x / 4 + 1.7, z / 4 - 6.6, 3 ) - 0.5 ) * 1.6 * steep * smooth( 2, 8, rise );
		return lake.level + 0.6 + rise;

	}

	// ===================== 世界高度 =====================

	// 阶段 12 的地形形状参数（压平盘、山脚台地、岬角、外圈远山、哥特的崖、烘焙保护区）
	const terrainShape = worldConfig.terrainShape || {};

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
	// 离冰瀑远的那几段崖（审查 R16：从哥特看过去，台地南缘是一道笔直的崖沿挂着一排一样宽的竖褶，像窗帘）：
	// 崖沿按 420 米上下的噪声进退 ±120 米（一个个湾和岬），冲沟的深浅也按噪声一段深一段浅。
	// 冰瀑左右 500 米以内不动（雪原、冰槽、冰碛岗、星月夜都在这一段），500~800 米慢慢放开
	function plateauRimFreedom( x ) {

		return smooth( 500, 800, Math.abs( x - iceFallX ) );

	}

	// 冰瀑两边（审查 R6：从冰瀑底下飞上来，台地南缘是一道笔直的水平切边加一个 V 形切口，像盒子上切了一刀）：
	// 崖沿再按 85 米上下的噪声进退 ±18 米；雪原出生点和冰槽那一段（x 在 100~160 之间）不动，60~200 之间慢慢放开，雪原朝南看的崖边、冰槽口都不变
	function plateauNearFreedom( x ) {

		return smooth( 30, 70, Math.abs( x - 130 ) );

	}

	function plateauEdges( x, warpedZ ) {

		const steep = gaussian( x - iceFallX, 380 );
		const rimShift = ( jsFbm2D( x / 420 + 3.3, 0.7, 3 ) - 0.5 ) * 240 * plateauRimFreedom( x )
			+ ( jsFbm2D( x / 85 - 6.1, 2.9, 3 ) - 0.5 ) * 36 * plateauNearFreedom( x );
		return { start: - 1650 + 80 * ( 1 - steep ) + rimShift, end: - 1760 - 110 * ( 1 - steep ) + rimShift };

	}

	function plateauAmountAt( x, warpedZ ) {

		const edges = plateauEdges( x, warpedZ );
		return smooth( edges.start, edges.end, warpedZ );

	}

	// 崖沿上风堆的雪檐：崖沿往台地里 40 米以内一个个高低不一的雪包（0~6 米，23 米上下一个），天际线不是一条直线；
	// 只在雪原出生点朝南的那一段（x 约 90~110）和冰槽口（x 约 154~170）压到很低（出生点朝南看不能被挡、槽口不变）
	function plateauRimLumps( x, z, warpedZ ) {

		const edges = plateauEdges( x, warpedZ );
		const inside = edges.end - warpedZ;
		const band = smooth( - 30, 0, inside ) * smooth( 40, 8, inside );
		if ( band <= 0 ) return 0;
		const lump = Math.pow( jsFbm2D( x / 23 + 1.3, z / 23 - 4.4, 3 ), 2 ) * 6;
		const keep = Math.min( smooth( 10, 30, Math.abs( x - 100 ) ), smooth( 8, 22, Math.abs( x - 162 ) ) );
		return lump * band * ( 0.15 + 0.85 * keep );

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

		// 东岭：350~650 米，日出山口那段低一截；往东 2.6~3.3 千米落下去，再往外交给外圈的层叠远山
		const sunrisePass = 1 - 0.55 * gaussian( warpedZ - 810, 230 );
		const eastRidgeEnd = terrainShape.eastRidgeEnd || [ 1e7, 1e7 + 1 ];
		const eastRidge = smooth( 1150, 1850, warpedX ) * smooth( eastRidgeEnd[ 1 ], eastRidgeEnd[ 0 ], warpedX ) * ( 330 + 300 * jsFbm2D( x / 650 + 3.3, z / 650 - 1.2, 5 ) ) * sunrisePass;

		// 南岭：250~450 米，洞口所在的鞍部（x ≈ −520）低一截；岭的南边是山外的桃花溪谷。
		// 北麓（花园那边）先是一级缓缓的山脚台地（升到岭高的约四分之一，带一个个小丘），再接主坡，不是从平地一下子立起来
		const foothills = terrainShape.southFoothills;
		const hummocks = 0.55 + 0.9 * jsFbm2D( x / 170 + 2.4, z / 170 - 7.3, 3 );
		// 洞所在的鞍部（x ≈ −520）两边 170 米左右保持原来的北坡：洞从这道坡底下穿过去，山得把洞盖住
		const originalRise = smooth( 1330, 1720, warpedZ );
		const terracedRise = foothills
			? foothills.terraceHeight * smooth( foothills.start, foothills.terraceEnd, warpedZ ) * hummocks + ( 1 - foothills.terraceHeight ) * smooth( foothills.mainStart, foothills.mainEnd, warpedZ )
			: originalRise;
		const northRise = terracedRise + ( originalRise - terracedRise ) * gaussian( x + 520, 170 );
		const southBand = northRise * smooth( 2260, 1880, warpedZ );
		const saddle = 1 - 0.62 * gaussian( x + 520, 220 );
		const southRidge = southBand * ( 260 + 190 * jsFbm2D( x / 560 - 5.1, z / 560 + 2.7, 5 ) ) * saddle;

		// 两条伸进海里的长条岬角：脊线从陆上伸到海里，横截面像屋脊，陆上那头高、往海里那头低下去，最外头是海崖
		const headlands = headlandHeight( warpedX, warpedZ );

		// 山外：南边桃花溪谷两侧的山，溪谷（x ≈ −450）留出来；往南 3.3~4.1 千米落下去，交给外圈的层叠远山
		const outerSouthEnd = terrainShape.outerSouthEnd || [ 1e7, 1e7 + 1 ];
		const outerSouth = smooth( 2050, 2350, warpedZ ) * smooth( outerSouthEnd[ 1 ], outerSouthEnd[ 0 ], warpedZ ) * ( 80 + 200 * jsFbm2D( x / 700 + 9.2, z / 700 - 3.3, 4 ) ) * ( 1 - 0.85 * gaussian( x + 450, 320 ) );

		// 外圈的层叠远山（3.6 / 6.2 / 9.3 千米三道），隔着大气透视一层比一层淡
		const outerRange = outerRangeHeight( x, z );

		// 山的细节：脊状噪声，越高的地方越粗糙
		const mountainBase = Math.max( eastRidge, southRidge, headlands, outerSouth, outerRange );
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
		const gullyStrength = 1 + ( 0.25 + 1.2 * smooth( 0.35, 0.65, jsFbm2D( x / 300 - 5.1, z / 300 + 2.2, 2 ) ) - 1 ) * plateauRimFreedom( x );
		const gully = ( 1 - Math.abs( 2 * jsFbm2D( x / 140 + 4.4, z / 140 - 7.7, 3 ) - 1 ) ) * 55 * 4 * plateauAmount * ( 1 - plateauAmount ) * gullyStrength;
		height = height + ( plateauHeight * plateauToCoast + height * ( 1 - plateauToCoast ) - height ) * plateauAmount + gully * plateauToCoast
			+ plateauRimLumps( x, z, warpedZ ) * plateauToCoast;

		// 湖东岸的崖：哥特城堡站在上面。平顶的岩台，边缘按噪声进退（不是正圆），往外 60 米内陡下去；朝湖那面再被湖岸的陡坡切成崖
		height = Math.max( height, gothicMesaHeight( x, z, height ) );

		// 小丘（原来星月夜身后的两座，阶段 12 CP3 返工换成冰碛岗，列表现在是空的）
		height += hillsHeight( x, z );
		// 冰碛岗（星月夜出生点身后、冰瀑崖脚那一道弧形的岗，中间一个鞍部：哥特 → 星月夜到达前从鞍部翻过来）
		height += moraineHeight( x, z );

		// 海边的长条岩丘，再被一道 U 形口子切开（花园 → 落日到达前从口子里穿过来，阶段 12 CP3 返工）
		height += knollHeight( x, z );
		height = carveNotches( x, z, height, false );

		return height;

	}

	// 长条岩丘（见 config.world.terrainShape.knolls）。海边常见的那种岩丘：顶上平缓、长草，两侧有的地方圆缓、有的地方陡、露岩。
	//   轮廓：离脊线的距离按"那一段的半宽"归一，半宽沿脊线按噪声在 0.7~1.25 倍之间进退（有鼓出去的岩嘴、凹进来的湾），不是胶囊；
	//   横截面：圆顶 (1 − 横向²) 和"肩"（离脊线 shoulder 倍半宽以内平缓、往外陡下去）按低频噪声换着来，两头 18% 收成 0；
	//   顶：几个高低不一的小顶（低频噪声 ±40%）；坡上叠一层脊状噪声出岩棱（顶上和脚下不加）
	// 2026-10-02 用户："你自己看像不像"——原来是一个光滑的圆包上切一刀；后来加的一级级岩台从远处看是一圈圈等高线，也去掉
	//   两头的台地（审查 R19：口子两边像平地上孤零零两座对称的圆丘，还是"门"）：tails [from 那头, to 那头] 米，岩丘两头不落到 0，
	//   落到 terrace 倍的高度，再顺着脊线方向在 tails 米里慢慢低下去，像一道连续的海岸台地；两头长短不一样，不对称。
	//   to 那头（南）短：再长就挡住 135° 的花园城堡。rise [from 端, to 端]：最高沿脊线从 from 到 to 线性变（两半一高一低，不是一对）
	function knollHeight( x, z ) {

		let result = 0;
		for ( const knoll of terrainShape.knolls || [] ) {

			const spineX = knoll.to[ 0 ] - knoll.from[ 0 ];
			const spineZ = knoll.to[ 1 ] - knoll.from[ 1 ];
			const spineLengthSquared = spineX * spineX + spineZ * spineZ;
			const spineLength = Math.sqrt( spineLengthSquared );
			const along = ( ( x - knoll.from[ 0 ] ) * spineX + ( z - knoll.from[ 1 ] ) * spineZ ) / spineLengthSquared;
			const tailBefore = ( knoll.tails ? knoll.tails[ 0 ] : 0 ) / spineLength;
			const tailAfter = ( knoll.tails ? knoll.tails[ 1 ] : 0 ) / spineLength;
			if ( along <= - tailBefore || along >= 1 + tailAfter ) continue;
			const distance = Math.hypot( x - knoll.from[ 0 ] - spineX * along, z - knoll.from[ 1 ] - spineZ * along );
			const side = ( x - knoll.from[ 0 ] ) * spineZ - ( z - knoll.from[ 1 ] ) * spineX > 0 ? 1 : - 1;
			const halfWidth = knoll.width * ( 0.7 + 0.55 * jsFbm2D( along * 5.1 + ( side > 0 ? 7.7 : - 3.1 ), 1.9, 3 ) );
			const across = distance / halfWidth;
			if ( across >= 1 ) continue;
			const shoulder = knoll.shoulder || 0.4;
			const steepness = smooth( 0.45, 0.75, jsFbm2D( x / 45 - 8.2, z / 45 + 3.6, 2 ) );
			const dome = 1 - across * across;
			const cliffy = Math.pow( smooth( 1, shoulder, across ), 0.85 );
			const core = smooth( 0, 0.18, along ) * smooth( 1, 0.82, along );
			const terrace = ( knoll.terrace || 0 ) * smooth( - tailBefore, 0, along ) * smooth( 1 + tailAfter, 1, along );
			const profile = ( dome + ( cliffy - dome ) * steepness ) * Math.max( core, terrace );
			const crest = 0.6 + 0.8 * jsFbm2D( x / 26 + 3.3, z / 26 - 6.1, 3 );
			const rise = knoll.rise ? knoll.rise[ 0 ] + ( knoll.rise[ 1 ] - knoll.rise[ 0 ] ) * Math.min( 1, Math.max( 0, along ) ) : 1;
			let height = knoll.height * rise * profile * crest;
			const slopeBand = smooth( shoulder * 0.7, shoulder + 0.15, across ) * smooth( 1, 0.8, across );
			const ridged = 1 - Math.abs( 2 * jsFbm2D( x / 9 - 1.4, z / 9 + 2.2, 3 ) - 1 );
			height += ridged * ridged * 1.6 * slopeBand + ( jsFbm2D( x / 5 + 4.1, z / 5 - 2.9, 2 ) - 0.5 ) * 0.6 * slopeBand;
			result = Math.max( result, height );

		}

		return result;

	}

	// 点到口子中线（折线）的水平距离、那里口子底的海拔
	function notchDistance( notch, x, z ) {

		const points = notch.points;
		let best = Infinity;
		let floor = 0;
		for ( let i = 1; i < points.length; i ++ ) {

			const a = points[ i - 1 ];
			const b = points[ i ];
			const segmentX = b[ 0 ] - a[ 0 ];
			const segmentZ = b[ 2 ] - a[ 2 ];
			const t = Math.min( 1, Math.max( 0, ( ( x - a[ 0 ] ) * segmentX + ( z - a[ 2 ] ) * segmentZ ) / ( segmentX * segmentX + segmentZ * segmentZ ) ) );
			const distance = Math.hypot( x - a[ 0 ] - segmentX * t, z - a[ 2 ] - segmentZ * t );
			if ( distance < best ) {

				best = distance;
				floor = a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t;

			}

		}

		return { distance: best, floor };

	}

	// 点到冰槽（notches 里 ice: true 的那些）中线的最近水平距离；没有冰槽返回 Infinity
	function iceNotchDistance( x, z ) {

		let best = Infinity;
		for ( const notch of terrainShape.notches || [] ) if ( notch.ice ) best = Math.min( best, notchDistance( notch, x, z ).distance );
		return best;

	}

	// U 形口子（见 config.world.terrainShape.notches）：沿折线（世界 x、口子底的海拔、z）挖，底宽 2 × halfBottom 米，
	// 两壁按 wallSlope（米 / 米）往上；只往下挖、不填高。底面再沿中线压出一道浅浅的溪槽（creekDepth 米，宽 creekHalfWidth × 2）。
	// 壁不是两道平行的直坡（阶段 12 CP3 返工）：
	//   离中线的距离按噪声进退 ±wallWander / 2 米（壁上有凸出来的岩嘴、凹进去的岩龛，两壁各不相同）；
	//   壁高按 ledgeStep 米（±30%）量化成一级级岩坎：每级前 40% 是平台、后 60% 是陡坎，再和不量化的斜坡 6:4 混合（全量化就成了楼梯）
	// 这些细节 8 米一格的远景网格画不出来，窄处的地形补丁（backdrop.js）按 0.6 米一格取这个函数
	// ice：只挖冰槽（true）还是只挖普通口子（false）：冰槽在台地上，要等雪原脚下压平以后再挖（baseHeight 里），不然被压平填回去
	function carveNotches( x, z, height, ice ) {

		let result = height;
		for ( const notch of terrainShape.notches || [] ) {

			if ( Boolean( notch.ice ) !== ice ) continue;
			const { distance, floor } = notchDistance( notch, x, z );
			if ( distance > notch.halfBottom + 60 ) continue;
			const wander = ( jsFbm2D( x / 11 + 5.1, z / 11 - 2.3, 3 ) - 0.5 ) * ( notch.wallWander || 0 );
			const rise = Math.max( 0, distance + wander - notch.halfBottom ) * notch.wallSlope;
			let wall = rise;
			if ( notch.ledgeStep ) {

				const step = notch.ledgeStep * ( 0.7 + 0.6 * jsFbm2D( x / 23 - 3.7, z / 23 + 1.9, 2 ) );
				const level = rise / step;
				const terraced = ( Math.floor( level ) + smooth( 0.4, 1, level - Math.floor( level ) ) ) * step;
				wall = terraced * 0.6 + rise * 0.4;

			}

			const creek = notch.creekDepth * ( 1 - smooth( 0, notch.creekHalfWidth, distance ) );
			result = Math.min( result, floor - creek + wall );

		}

		return result;

	}

	// 冰碛岗（见 config.world.terrainShape.moraines）：冰川退下去以后留在前面的一道弧形土石岗。
	//   points 是岗脊的折线（世界 x, z），岗顶比两边高 height 米，半宽 width 米（沿岗按噪声 0.75~1.2 倍进退）；
	//   横截面：朝冰川那面（proximalSide 一侧）陡、背面缓；岗顶不是一条平线，一个个高低不一的土丘（冰碛丘），坡上有乱石的小鼓包；
	//   saddle：鞍部在折线上离 saddle.point 最近的地方，按 saddle.width 米的高斯往下压 saddle.depth（岗高的比例）；两头 15% 收成 0
	function moraineHeight( x, z ) {

		let result = 0;
		for ( const moraine of terrainShape.moraines || [] ) {

			const lines = moraineLines( moraine );
			if ( x < lines.minX - moraine.width || x > lines.maxX + moraine.width || z < lines.minZ - moraine.width || z > lines.maxZ + moraine.width ) continue;
			const nearest = nearestOnPolyline( lines, x, z );
			const along = nearest.along / lines.length;
			const halfWidth = moraine.width * ( 0.75 + 0.45 * jsFbm2D( along * 7.3 + ( nearest.side > 0 ? 4.1 : - 2.7 ), 0.6, 2 ) );
			const across = nearest.distance / halfWidth;
			if ( across >= 1 ) continue;
			// 朝冰川那面（proximal）陡：横向距离按 0.7 倍算宽，坡更陡；背面缓
			const steepSide = nearest.side === ( moraine.proximalSide || 1 );
			const crossProfile = steepSide ? Math.pow( 1 - Math.pow( across, 1.6 ), 1.4 ) : Math.pow( 1 - across, 1.8 ) * ( 1 + 0.8 * across );
			const ends = smooth( 0, 0.15, along ) * smooth( 1, 0.85, along );
			const saddle = moraine.saddle ? 1 - moraine.saddle.depth * Math.exp( - Math.pow( ( nearest.along - lines.saddleAlong ) / moraine.saddle.width, 2 ) ) : 1;
			// 冰碛丘：岗顶一个个土丘（26 米一个左右）
			const hummocks = 0.72 + 0.56 * jsFbm2D( x / 26 + 9.1, z / 26 - 4.4, 3 );
			let height = moraine.height * crossProfile * ends * saddle * hummocks;
			// 坡上乱石的小鼓包（4 米左右，最多 1.2 米）
			const slopeBand = smooth( 0.2, 0.5, across ) * smooth( 1, 0.85, across );
			height += ( jsFbm2D( x / 4.2 - 6.6, z / 4.2 + 1.3, 2 ) - 0.45 ) * 1.2 * slopeBand * ends;
			result = Math.max( result, height );

		}

		return result;

	}

	// 冰碛岗的折线（第一次用到时算好缓存起来）：各段、累计长度、包围盒、鞍部在折线上的位置
	const moraineCache = new Map();
	function moraineLines( moraine ) {

		if ( moraineCache.has( moraine ) ) return moraineCache.get( moraine );
		const points = moraine.points;
		const segments = [];
		let length = 0;
		let minX = Infinity, maxX = - Infinity, minZ = Infinity, maxZ = - Infinity;
		for ( let i = 1; i < points.length; i ++ ) {

			const [ ax, az ] = points[ i - 1 ];
			const [ bx, bz ] = points[ i ];
			const segmentLength = Math.hypot( bx - ax, bz - az );
			segments.push( { ax, az, dx: bx - ax, dz: bz - az, length: segmentLength, start: length } );
			length += segmentLength;

		}

		for ( const [ px, pz ] of points ) {

			minX = Math.min( minX, px ); maxX = Math.max( maxX, px );
			minZ = Math.min( minZ, pz ); maxZ = Math.max( maxZ, pz );

		}

		const lines = { segments, length, minX, maxX, minZ, maxZ, saddleAlong: 0 };
		if ( moraine.saddle ) lines.saddleAlong = nearestOnPolyline( lines, moraine.saddle.point[ 0 ], moraine.saddle.point[ 1 ] ).along;
		moraineCache.set( moraine, lines );
		return lines;

	}

	// 点到折线的最近距离、最近点沿折线的累计长度、在折线哪一侧（右手 1、左手 −1）
	function nearestOnPolyline( lines, x, z ) {

		let best = { distance: Infinity, along: 0, side: 1 };
		for ( const segment of lines.segments ) {

			const t = Math.min( 1, Math.max( 0, ( ( x - segment.ax ) * segment.dx + ( z - segment.az ) * segment.dz ) / ( segment.length * segment.length ) ) );
			const distance = Math.hypot( x - segment.ax - segment.dx * t, z - segment.az - segment.dz * t );
			if ( distance < best.distance ) best = { distance, along: segment.start + segment.length * t, side: ( x - segment.ax ) * segment.dz - ( z - segment.az ) * segment.dx > 0 ? 1 : - 1 };

		}

		return best;

	}

	// 小丘（见 config.world.terrainShape.hills）：圆顶的小山包，(1 − d²)² 的截面，坡上一点噪声起伏
	function hillsHeight( x, z ) {

		let result = 0;
		for ( const hill of terrainShape.hills || [] ) {

			const distance = Math.hypot( x - hill.center[ 0 ], z - hill.center[ 1 ] ) / hill.radius;
			if ( distance >= 1 ) continue;
			const profile = ( 1 - distance * distance ) * ( 1 - distance * distance );
			result += hill.height * profile * ( 0.85 + 0.3 * jsFbm2D( x / 60 + hill.center[ 0 ] * 0.01, z / 60 - hill.center[ 1 ] * 0.01, 3 ) );

		}

		return result;

	}

	// 长条岬角（见 config.world.terrainShape.headlands）：点到脊线段的距离（胶囊形）→ 屋脊形横截面；沿脊线陆上那头高、
	// 海里那头降到 40%；脊上加一层脊状噪声，坡上有冲沟（烘焙时再被侵蚀细化）
	function headlandHeight( warpedX, warpedZ ) {

		let result = 0;
		for ( const headland of terrainShape.headlands || [] ) {

			const spineX = headland.to[ 0 ] - headland.from[ 0 ];
			const spineZ = headland.to[ 1 ] - headland.from[ 1 ];
			const spineLengthSquared = spineX * spineX + spineZ * spineZ;
			const projection = ( ( warpedX - headland.from[ 0 ] ) * spineX + ( warpedZ - headland.from[ 1 ] ) * spineZ ) / spineLengthSquared;
			const along = Math.min( 1, Math.max( 0, projection ) );
			const distance = Math.hypot( warpedX - headland.from[ 0 ] - spineX * along, warpedZ - headland.from[ 1 ] - spineZ * along );
			const across = distance / headland.width;
			if ( across >= 1 ) continue;
			const profile = Math.pow( 1 - across * across, 1.6 );
			const taper = 1 - 0.6 * along * along;
			const ridges = 0.72 + 0.28 * ( 1 - Math.abs( 2 * jsFbm2D( warpedX / 150 + 5.5, warpedZ / 150 - 2.2, 3 ) - 1 ) );
			result = Math.max( result, headland.height * profile * taper * ridges );

		}

		return result;

	}

	// 外圈层叠远山（见 config.world.terrainShape.outerRanges）：以盆地中心为圆心的几道环形山脉，横截面是高斯形，
	// 脊线高度按世界坐标的脊状噪声起伏（有峰有坳），再乘方位角上的高度比例（日出、月出、落月、极光的方向压低，西边是海）
	function outerRangeHeight( x, z ) {

		const shape = terrainShape.outerRanges;
		if ( ! shape ) return 0;
		const offsetX = x - shape.center[ 0 ];
		const offsetZ = z - shape.center[ 1 ];
		const distance = Math.hypot( offsetX, offsetZ );
		const first = shape.ranges[ 0 ];
		if ( distance < first.distance - 2.5 * first.width ) return 0;
		const azimuth = ( ( Math.atan2( offsetX, - offsetZ ) / degree ) % 360 + 360 ) % 360;
		const scale = interpolateAzimuthKeys( shape.azimuthScale, azimuth );
		if ( scale <= 0 ) return 0;
		let result = 0;
		shape.ranges.forEach( ( range, index ) => {

			const across = ( distance - range.distance ) / range.width;
			if ( Math.abs( across ) > 2.5 ) return;
			const profile = Math.exp( - across * across * 2 );
			const crest = 1 - Math.abs( 2 * jsFbm2D( x / ( 700 + index * 350 ) + index * 13.7, z / ( 700 + index * 350 ) - index * 5.3, 4 ) - 1 );
			result = Math.max( result, range.height * scale * profile * ( 0.35 + 0.65 * crest * crest ) );

		} );
		return result;

	}

	// 方位角关键帧（[度, 值]，首尾接起来）插值
	function interpolateAzimuthKeys( keys, azimuth ) {

		for ( let i = 0; i < keys.length - 1; i ++ ) {

			const [ from, fromValue ] = keys[ i ];
			const [ to, toValue ] = keys[ i + 1 ];
			if ( azimuth >= from && azimuth <= to ) return fromValue + ( toValue - fromValue ) * smooth( from, to, azimuth );

		}

		return keys[ keys.length - 1 ][ 1 ];

	}

	// 哥特城堡的岩台（见 config.world.terrainShape.gothicMesa）：平顶高度 top，边缘按方位角的噪声进退 ±edgeWander 米，
	// 往外 falloff 米里落回原地形；崖面上的冲沟和岩层交给烘焙的侵蚀
	function gothicMesaHeight( x, z, baseHeight ) {

		const mesa = terrainShape.gothicMesa;
		if ( ! mesa ) return baseHeight + 48 * smooth( 150, 90, Math.hypot( x - 545, z + 230 ) );
		const offsetX = x - mesa.center[ 0 ];
		const offsetZ = z - mesa.center[ 1 ];
		const angle = Math.atan2( offsetZ, offsetX );
		const distance = Math.hypot( offsetX, offsetZ );
		// 崖沿：按方位角大尺度进退 ±edgeWander；再加崖沿上 35 米上下一个的岩嘴和冲沟（±14 米，按崖沿上的位置取噪声）。
		// 要在 500 米外的机位上看得出（一个像素约 0.3 米），岩嘴、石肋都得是十几米的尺度
		const rimX = Math.cos( angle ) * mesa.radius;
		const rimZ = Math.sin( angle ) * mesa.radius;
		const lobes = ( jsFbm2D( rimX / 35 + 7.3, rimZ / 35 - 2.1, 2 ) - 0.5 ) * 2 * 14;
		const edge = mesa.radius + ( jsFbm2D( Math.cos( angle ) * 2.1 + 4.4, Math.sin( angle ) * 2.1 - 1.3, 3 ) - 0.5 ) * 2 * mesa.edgeWander + lobes;
		// 竖向的石柱和冲沟：沿崖沿 14 米上下一道的脊状噪声（只看崖沿上的位置，不看高度，所以是一道道竖的），把崖面往外推 0~9 米；
		// 再叠一层 5 米一道、2.5 米深的细肋
		const ridged = 1 - Math.abs( 2 * jsFbm2D( rimX / 14 - 3.9, rimZ / 14 + 5.2, 2 ) - 1 );
		const fineRidged = 1 - Math.abs( 2 * jsFbm2D( rimX / 5 + 2.2, rimZ / 5 - 8.4, 2 ) - 1 );
		const reach = distance - ridged * ridged * 9 - fineRidged * fineRidged * 2.5;
		// 剖面：t 从坡脚（崖沿往外 falloff 米）的 0 到崖沿的 1。阶段 12 CP4：原来是"碎石坡 + 一整面陡崖"，远看像一张桌子（用户）；
		// 改成两级：碎石坡升到台高的 22% → 一面下崖升到 shelf（台高的比例）→ 一层平台（长树）→ 上崖到崖沿。平台宽窄按方位角起伏，有的地方断掉
		const t = Math.min( 1, Math.max( 0, ( edge + mesa.falloff - reach ) / mesa.falloff ) );
		const shelf = mesa.shelf || 0;
		const shelfWidth = shelf ? 0.1 + 0.12 * jsFbm2D( Math.cos( angle ) * 3.3 - 2.2, Math.sin( angle ) * 3.3 + 6.1, 2 ) : 0;
		let profile = shelf
			? 0.22 * smooth( 0, 0.3, t ) + ( shelf - 0.22 ) * smooth( 0.25, 0.48, t ) + ( 1 - shelf ) * smooth( 0.48 + shelfWidth, 0.9, t )
			: 0.28 * smooth( 0, 0.45, t ) + 0.72 * smooth( 0.3, 0.85, t );
		// 岩层：陡崖那一段按 1/9 台高量化成几级小台阶（35%，不是楼梯），再叠一层 4 米的凹凸
		const cliffBand = smooth( 0.25, 0.4, t ) * smooth( 0.95, 0.8, t );
		profile += ( Math.round( profile * 9 ) / 9 - profile ) * 0.35 * cliffBand;
		const roughness = ( jsFbm2D( x / 4 + 1.7, z / 4 - 6.6, 3 ) - 0.5 ) * 1.6 * cliffBand;
		// 崖顶的边：参差的岩头（±4 米），台顶往里 12 米就平了（城堡的地基不动）
		const crown = ( jsFbm2D( x / 9 - 5.5, z / 9 + 1.1, 2 ) - 0.5 ) * 8 * smooth( 0.8, 0.97, t ) * smooth( edge - 12, edge - 2, reach );
		return baseHeight + ( mesa.top - baseHeight ) * profile + roughness + crown;

	}

	// 点到山洞轴线（外口 → 内口的线段）的水平距离
	function distanceToCaveAxis( x, z ) {

		const from = worldConfig.cave.outer;
		const to = worldConfig.cave.inner;
		const axisX = to[ 0 ] - from[ 0 ];
		const axisZ = to[ 2 ] - from[ 2 ];
		const along = Math.min( 1, Math.max( 0, ( ( x - from[ 0 ] ) * axisX + ( z - from[ 2 ] ) * axisZ ) / ( axisX * axisX + axisZ * axisZ ) ) );
		return Math.hypot( x - from[ 0 ] - axisX * along, z - from[ 2 ] - axisZ * along );

	}

	// 点在内口前面（出了洞往花园那边）多远：沿洞轴线方向超过内口的米数，没超过是 0
	function beyondCaveInner( x, z ) {

		const from = worldConfig.cave.outer;
		const to = worldConfig.cave.inner;
		const axisX = to[ 0 ] - from[ 0 ];
		const axisZ = to[ 2 ] - from[ 2 ];
		const length = Math.hypot( axisX, axisZ );
		return Math.max( 0, ( ( x - to[ 0 ] ) * axisX + ( z - to[ 2 ] ) * axisZ ) / length );

	}

	// 世界点 (x, z) 到地点本地圆角矩形（rect 往外扩 margin 米、四角圆角半径 corner 米）的距离：里面是 0，外面是到边的米数
	function roundedRectDistance( key, rect, margin, corner, x, z ) {

		const location = locationOf( key );
		const offsetX = x - location.origin[ 0 ];
		const offsetZ = z - location.origin[ 2 ];
		const angle = location.yaw * degree;
		const localX = offsetX * Math.cos( angle ) + offsetZ * Math.sin( angle );
		const localZ = - offsetX * Math.sin( angle ) + offsetZ * Math.cos( angle );
		const centerX = ( rect.minX + rect.maxX ) / 2;
		const centerZ = ( rect.minZ + rect.maxZ ) / 2;
		const halfX = ( rect.maxX - rect.minX ) / 2 + margin - corner;
		const halfZ = ( rect.maxZ - rect.minZ ) / 2 + margin - corner;
		const outsideX = Math.max( 0, Math.abs( localX - centerX ) - halfX );
		const outsideZ = Math.max( 0, Math.abs( localZ - centerZ ) - halfZ );
		return Math.max( 0, Math.hypot( outsideX, outsideZ ) - corner );

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
	// 花园（阶段 12）：按花园朝向的圆角矩形压平，盖住花园自己的地形块和城堡，外面 320 米缓缓回到原地形（见 locationPlates）
	const gardenPlate = terrainShape.locationPlates && terrainShape.locationPlates.garden;
	const flattenSpots = [
		...( gardenPlate
			? [ { location: 'garden', plate: gardenPlate, height: locations.garden.origin[ 1 ] } ]
			: [ { position: locations.garden.origin, radius: 260, height: locations.garden.origin[ 1 ] }, { position: locations.garden.landmark, radius: 220, height: locations.garden.landmark[ 1 ] } ] ),
		// 落日：陆侧压到 0.3 米（落日自己的沙滩、礁石都比它高，不会穿出来）；海侧挖到 −3 米，世界的陆地不伸进落日自己的海里
		// 2026-10-02：压平的高度不是一块平的 0.3 米，而是和落日自己的陆地一样往里抬（rise：从 start 米起每米抬 slope，再加一段 shoulder 米、
		// 按 length 米收住的肩），始终比落日的地面低 0.6 米左右；落日地形块外面不再是一圈低洼，块边上也不鼓出一道坎
		{ position: locations.sunset.origin, radius: 130, height: 0.3, facing: facingOf( locations.sunset.yaw + 180 ), rise: { start: - 5, slope: 0.025, shoulder: 1.12, length: 14 } },
		{ position: locations.sunset.origin, radius: 360, height: - 3, facing: facingOf( locations.sunset.yaw ), edgeWidth: 8 },
		{ position: locations.gothic.origin, radius: 60, height: locations.gothic.origin[ 1 ] - 1.5 },
		{ position: locations.gothic.landmark, radius: 90, height: locations.gothic.landmark[ 1 ] - 1 },
		// 星月夜机位：只压平身后，前面顺着山坡在 90 米里缓缓降下去，站在坡上往下看得见小镇和湖（不能是一块平台挡住视线）
		{ position: locations.starry.origin, radius: 80, height: locations.starry.origin[ 1 ] - 1.5, facing: facingOf( locations.starry.yaw + 180 ), edgeWidth: 90 },
		{ position: locations.starry.landmark, radius: 160, height: locations.starry.landmark[ 1 ] },
		// 雪原：原点在台地南缘崖边 20 米内（2026-10-01 定：先朝南看整个秘境的夜景，再转身往北沿脚印走）；
		// 只压平北边（脚印那一侧），南边保留天然的崖缘，站在原点往南看得见下面的盆地
		// rimWander：半圆分界线按噪声往前后进退（米；离原点越远进退越大，原点附近只有两成），原来是穿过原点的一条东西向直线，
		// 站在原点朝南看，雪面和下面的盆地之间一道笔直的水平线（2026-10-02 审查 R2 "像沙盘"）
		{ position: locations.aurora.origin, radius: 450, height: locations.aurora.origin[ 1 ], facing: facingOf( 0 ), edgeWidth: 8, frontSlope: 0.3, frontReach: 70, rimWander: 26 },
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

	// 解析的地形高度（还没挖湖、河、海）：大地形 + 地点脚下压平 + 视线低谷。烘焙脚本先取这个，加细节和侵蚀，再套 applyWater
	function baseHeight( x, z, warped = warpedPosition( x, z ) ) {

		let height = terrainBeforeWater( x, z, warped );

		for ( const spot of flattenSpots ) {

			if ( spot.plate ) {

				// 圆角矩形压平：矩形里（含 margin）完全压平，外面按 smoothstep 的平方缓降，山脚是一道长长的缓坡
				const outside = roundedRectDistance( spot.location, spot.plate.rect, spot.plate.margin, spot.plate.corner, x, z );
				const fade = smooth( spot.plate.falloff, 0, outside );
				// 山洞那道山梁不压：离洞的中线 50 米以内一点不压，170 米以外照常（洞从花园南边的山坡底下穿过去，山得把洞盖住）；
				// 但内口前面（往花园那边出了洞）照常压平，出洞那段路是下到花园的缓坡
				const keepCave = Math.max( smooth( 50, 170, distanceToCaveAxis( x, z ) ), smooth( 0, 45, beyondCaveInner( x, z ) ) );
				height += ( spot.height - height ) * fade * fade * keepCave;
				continue;

			}

			const offsetX = x - spot.position[ 0 ];
			const offsetZ = z - spot.position[ 2 ];
			let weight = smooth( spot.radius, spot.radius * 0.55, Math.hypot( offsetX, offsetZ ) );
			// 分界线的进退（见 rimWander）：沿分界线方向（facing 转 90°）取两层噪声，原点附近收小
			let rimShift = 0;
			if ( spot.rimWander && spot.facing ) {

				const sideways = offsetX * spot.facing[ 1 ] - offsetZ * spot.facing[ 0 ];
				const wander = ( jsFbm2D( sideways / 55 + 3.7, 1.9, 3 ) - 0.5 ) * 2 + ( jsFbm2D( sideways / 14 - 6.1, 4.4, 2 ) - 0.5 ) * 0.5;
				rimShift = wander * spot.rimWander * ( 0.35 + 0.65 * smooth( 15, 90, Math.abs( sideways ) ) );

			}

			// 半圆：只压 facing 那一侧；另一侧在 edgeWidth 米（默认 8 米，洞口那种陡壁）以内过渡回原地形
			if ( spot.facing ) weight *= smooth( - ( spot.edgeWidth || 8 ), 2, offsetX * spot.facing[ 0 ] + offsetZ * spot.facing[ 1 ] + rimShift );
			let target = spot.height;
			if ( spot.rise ) {

				const inward = Math.max( 0, offsetX * spot.facing[ 0 ] + offsetZ * spot.facing[ 1 ] - spot.rise.start );
				target += inward * spot.rise.slope + spot.rise.shoulder * ( 1 - Math.exp( - inward / spot.rise.length ) );

			}

			height += ( target - height ) * weight;

			// 看台：不压平的那一侧（前方）地面不许高过"原点高度 − 前方距离 × frontSlope"，缓缓往下，站在原点能越过前面的边看到下面
			if ( spot.frontSlope ) {

				const front = - ( offsetX * spot.facing[ 0 ] + offsetZ * spot.facing[ 1 ] + rimShift );
				const cap = spot.height - Math.max( 0, front ) * spot.frontSlope;
				if ( front > 0 && height > cap ) height += ( cap - height ) * smooth( spot.frontReach, spot.frontReach * 0.6, front );

			}

		}

		// 冰槽在雪原脚下压平以后挖（见 carveNotches）
		height = carveNotches( x, z, height, true );
		return applySightlines( x, z, height );

	}

	// 湖、河、海。carve 为真：按水系挖河床、湖底、改岸坡（解析世界、烘焙的最后一步）；
	// 为假：高度已经是烘焙好的，只判断这里有没有水、水位多少、什么水
	function applyWater( x, z, startHeight, carve ) {

		let height = startHeight;
		let waterLevel = - Infinity;
		let waterKind = '';

		// 湖：岸线以内挖到湖底，水位 55 米
		const radius = lakeRadius( x, z );
		if ( radius < 1.35 ) {

			const bed = lake.level - 9 * ( 1 - Math.min( 1, radius * radius ) );
			const shore = lakeShoreHeight( x, z, radius );
			if ( carve ) height = Math.min( height, radius < 1 ? bed : shore );
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
				if ( carve ) height = Math.min( height, nearest.level - 2.2 * ( 1 - ratio * ratio ) + headWall );
				if ( nearest.level > waterLevel && waterKind !== 'lake' && waterKind !== 'sea' ) {

					waterLevel = nearest.level;
					waterKind = 'river';

				}

			} else if ( carve ) {

				// 岸：离水边每米抬 bankSlope 米（默认 0.32），再加一个二次项让河谷越往外越陡；桃花溪的河谷宽而平（两岸是桃林）
				const excess = Math.max( 0, nearest.distance - river.halfWidth );
				const bankSlope = river.bankSlope !== undefined ? river.bankSlope : 0.32;
				const bankCurve = river.bankCurve !== undefined ? river.bankCurve : 0.004;
				const bank = nearest.level + 0.4 + excess * bankSlope + excess * excess * bankCurve + headWall;
				// 挖出来的谷坡和原来的山坡交成圆角（平滑取小），不是一道硬折痕（阶段 12：原来只有桃花溪这样，别的河是硬取小，
				// 把一个岬角削成了圆锥）；桃花溪用自己的圆角
				let carved = Math.min( height, bank );
				if ( river.headWallShape ) carved = smoothMin( height, bank, river.headWallShape.creaseSoftness );
				else if ( terrainShape.riverCrease ) carved = smoothMinLocal( height, bank, terrainShape.riverCrease );
				height += ( carved - height ) * smooth( 300, 200, nearest.distance );

			}

		}

		// 海：低于 0 的地方都是海（湖、河已经有自己的水位；河口处水位不到 0.5 米的河段也算海，河水和海面接平）
		if ( height < 0 && ( waterLevel === - Infinity || ( waterKind === 'river' && waterLevel <= 0.5 ) ) ) {

			waterLevel = 0;
			waterKind = 'sea';

		}

		return { height, waterLevel, waterKind };

	}

	// 只用解析公式算（烘焙脚本、没有烘焙数据时用）
	function sampleAnalytic( x, z ) {

		const warped = warpedPosition( x, z );
		const result = applyWater( x, z, baseHeight( x, z, warped ), true );
		result.plateau = plateauAmountAt( x, warped[ 1 ] );
		return result;

	}

	// ===================== 烘焙的地形（scripts/bake-terrain.mjs）=====================
	// 有烘焙数据时，高度直接按网格双线性插值（已经含侵蚀、湖底、河床），水只判断不再挖；网格外面退回解析公式
	let terrainBake = null;

	// bake：{ core: { minX, minZ, spacing, width, height, heights }, outer: { 同上 } }，heights 是 Float32Array（米，行优先，z 方向是行）
	function attachTerrainBake( bake ) {

		if ( ! bake || ! bake.core || ! bake.core.heights ) throw new Error( '秘境：烘焙的地形数据不完整（缺 core.heights）' );
		terrainBake = bake;

	}

	function gridHeight( grid, x, z ) {

		const gridX = ( x - grid.minX ) / grid.spacing;
		const gridZ = ( z - grid.minZ ) / grid.spacing;
		if ( gridX < 0 || gridZ < 0 || gridX > grid.width - 1 || gridZ > grid.height - 1 ) return null;
		const column = Math.min( grid.width - 2, Math.floor( gridX ) );
		const row = Math.min( grid.height - 2, Math.floor( gridZ ) );
		const fractionX = gridX - column;
		const fractionZ = gridZ - row;
		const heights = grid.heights;
		const index = row * grid.width + column;
		const top = heights[ index ] + ( heights[ index + 1 ] - heights[ index ] ) * fractionX;
		const bottom = heights[ index + grid.width ] + ( heights[ index + grid.width + 1 ] - heights[ index + grid.width ] ) * fractionX;
		return top + ( bottom - top ) * fractionZ;

	}

	function bakedHeightAt( x, z ) {

		if ( ! terrainBake ) return null;
		const core = gridHeight( terrainBake.core, x, z );
		if ( core !== null ) return core;
		return terrainBake.outer ? gridHeight( terrainBake.outer, x, z ) : null;

	}

	// 世界高度（米）、水位（没有水是 -Infinity）、水的种类（'sea' / 'lake' / 'river' / ''）、在雪原台地上的程度（0~1）。
	// 远景网格、地点替身摆放、飞行航线离地检查都用它
	function sample( x, z ) {

		const baked = bakedHeightAt( x, z );
		if ( baked === null ) return sampleAnalytic( x, z );
		const result = applyWater( x, z, baked, false );
		result.plateau = plateauAmountAt( x, warpedPosition( x, z )[ 1 ] );
		return result;

	}

	// 烘焙时不许侵蚀动的程度（0~1，1 完全不动）：地点自己的地形块（再往外 margin 米慢慢放开）、两个洞口、河床两边、湖、
	// 哥特城堡的地基、星月夜的机位和小镇
	function protectionAt( x, z ) {

		let protection = 0;
		for ( const item of terrainShape.protect || [] ) {

			const outside = roundedRectDistance( item.location, item.rect, 0, 0, x, z );
			protection = Math.max( protection, smooth( item.margin, 0, outside ) );

		}

		// 洞口：只护洞口外那一小块（洞顶的山梁可以侵蚀，烘焙最后会保证洞顶上至少还盖着几米石头）
		for ( const mouth of [ worldConfig.cave.outer, worldConfig.cave.inner ] ) protection = Math.max( protection, smooth( 45, 20, Math.hypot( x - mouth[ 0 ], z - mouth[ 2 ] ) ) );
		// 哥特城堡的整块岩台（平顶 + 崖面）：崖面要是陡的，不能被热力侵蚀磨成一座圆锥
		const mesa = terrainShape.gothicMesa;
		if ( mesa ) {

			const outerEdge = mesa.radius + mesa.edgeWander + mesa.falloff;
			protection = Math.max( protection, smooth( outerEdge + 30, outerEdge, Math.hypot( x - mesa.center[ 0 ], z - mesa.center[ 1 ] ) ) );

		}
		for ( const river of rivers ) {

			const bounds = river.bounds;
			if ( x < bounds.minX - 80 || x > bounds.maxX + 80 || z < bounds.minZ - 80 || z > bounds.maxZ + 80 ) continue;
			const nearest = nearestOnRiver( river, x, z );
			protection = Math.max( protection, smooth( river.halfWidth + 40, river.halfWidth + 15, nearest.distance ) );

		}

		protection = Math.max( protection, smooth( 1.25, 1.08, lakeRadius( x, z ) ) );
		// 海边岩丘和它的口子（阶段 12 CP3 返工）：口子的壁要陡、岩坎要在，热力侵蚀会把它磨成一道软 V；岩丘本身也不加脊状细节（形状由解析公式定）
		for ( const knoll of terrainShape.knolls || [] ) {

			const spineX = knoll.to[ 0 ] - knoll.from[ 0 ];
			const spineZ = knoll.to[ 1 ] - knoll.from[ 1 ];
			const along = Math.min( 1, Math.max( 0, ( ( x - knoll.from[ 0 ] ) * spineX + ( z - knoll.from[ 1 ] ) * spineZ ) / ( spineX * spineX + spineZ * spineZ ) ) );
			const distance = Math.hypot( x - knoll.from[ 0 ] - spineX * along, z - knoll.from[ 1 ] - spineZ * along );
			protection = Math.max( protection, smooth( knoll.width + 30, knoll.width + 5, distance ) );

		}

		for ( const notch of terrainShape.notches || [] ) protection = Math.max( protection, smooth( notch.halfBottom + 40, notch.halfBottom + 15, notchDistance( notch, x, z ).distance ) );
		for ( const moraine of terrainShape.moraines || [] ) {

			if ( ! moraine.saddle ) continue;
			const [ saddleX, saddleZ ] = moraine.saddle.point;
			protection = Math.max( protection, smooth( moraine.saddle.width * 2.5, moraine.saddle.width * 1.2, Math.hypot( x - saddleX, z - saddleZ ) ) );

		}
		const fixedSpots = [ [ locations.gothic.landmark, 70, 110 ], [ locations.starry.origin, 90, 140 ], [ locations.starry.landmark, 170, 240 ] ];
		for ( const [ position, inner, outer ] of fixedSpots ) protection = Math.max( protection, smooth( outer, inner, Math.hypot( x - position[ 0 ], z - position[ 2 ] ) ) );
		return protection;

	}

	// 和地形有关的配置的指纹：烘焙时写进清单，页面加载时对一下，配置改了而没重新烘焙就警告、退回解析公式
	function terrainConfigHash() {

		const relevant = JSON.stringify( {
			terrainShape: worldConfig.terrainShape, lake: worldConfig.lake, rivers: worldConfig.rivers, cave: worldConfig.cave,
			terrain: worldConfig.terrain, locations: Object.fromEntries( Object.entries( locations ).map( ( [ key, location ] ) => [ key, [ location.origin, location.yaw, location.landmark ] ] ) ),
		} );
		let hash = 2166136261;
		for ( let i = 0; i < relevant.length; i ++ ) {

			hash ^= relevant.charCodeAt( i );
			hash = Math.imul( hash, 16777619 );

		}

		return ( hash >>> 0 ).toString( 16 );

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
		sampleAnalytic,
		baseHeight,
		applyWater,
		attachTerrainBake,
		hasTerrainBake: () => terrainBake !== null,
		getTerrainBake: () => terrainBake,
		protectionAt,
		terrainConfigHash,
		iceNotchDistance,
		worldHeight,
		lakeRadius,
		nearestOnRiver,
		headWallRise,
		getRiver,
		cave,
	};

}
