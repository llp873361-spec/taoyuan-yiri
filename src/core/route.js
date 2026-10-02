// 镜头路线的小工具（开场、花园的出洞共用）：单调三次插值的时间 → 距离曲线、折线按弧长重采样。
// 开场和花园在洞里交接时位置、朝向、速度都要接得上，两边用同一套算法和同一条洞的中线（world.cave.at）。

import * as THREE from 'three/webgpu';

// 单调三次插值（Fritsch–Carlson）：关键帧 [[时间, 值], …] 之间不过冲，一阶导连续。
// fixedSlopes：{ 关键帧序号: 斜率 }，强制某一帧的速度（交接处两边的速度要一样）
export function monotoneCurve( keys, fixedSlopes = {} ) {

	const count = keys.length;
	if ( count < 2 ) throw new Error( '路线：时间曲线至少要两个关键帧' );
	const slopes = [];
	for ( let i = 0; i < count - 1; i ++ ) {

		const span = keys[ i + 1 ][ 0 ] - keys[ i ][ 0 ];
		if ( ! ( span > 0 ) ) throw new Error( `路线：第 ${ i + 1 } 个关键帧的时间没有比前一个大` );
		slopes.push( ( keys[ i + 1 ][ 1 ] - keys[ i ][ 1 ] ) / span );

	}

	const tangents = [ slopes[ 0 ] ];
	for ( let i = 1; i < count - 1; i ++ ) tangents.push( slopes[ i - 1 ] * slopes[ i ] <= 0 ? 0 : ( slopes[ i - 1 ] + slopes[ i ] ) / 2 );
	tangents.push( slopes[ count - 2 ] );
	for ( let i = 0; i < count - 1; i ++ ) {

		if ( slopes[ i ] === 0 ) {

			tangents[ i ] = 0;
			tangents[ i + 1 ] = 0;
			continue;

		}

		const a = tangents[ i ] / slopes[ i ];
		const b = tangents[ i + 1 ] / slopes[ i ];
		const length = Math.hypot( a, b );
		if ( length > 3 ) {

			tangents[ i ] = 3 / length * a * slopes[ i ];
			tangents[ i + 1 ] = 3 / length * b * slopes[ i ];

		}

	}

	for ( const [ index, slope ] of Object.entries( fixedSlopes ) ) tangents[ Number( index ) ] = slope;

	return ( time ) => {

		if ( time <= keys[ 0 ][ 0 ] ) return keys[ 0 ][ 1 ] + tangents[ 0 ] * ( time - keys[ 0 ][ 0 ] );
		if ( time >= keys[ count - 1 ][ 0 ] ) return keys[ count - 1 ][ 1 ] + tangents[ count - 1 ] * ( time - keys[ count - 1 ][ 0 ] );
		let i = 0;
		while ( i < count - 2 && time > keys[ i + 1 ][ 0 ] ) i ++;
		const span = keys[ i + 1 ][ 0 ] - keys[ i ][ 0 ];
		const t = ( time - keys[ i ][ 0 ] ) / span;
		const t2 = t * t;
		const t3 = t2 * t;
		return ( 2 * t3 - 3 * t2 + 1 ) * keys[ i ][ 1 ] + ( t3 - 2 * t2 + t ) * span * tangents[ i ] + ( - 2 * t3 + 3 * t2 ) * keys[ i + 1 ][ 1 ] + ( t3 - t2 ) * span * tangents[ i + 1 ];

	};

}

// 控制点 → 向心 Catmull-Rom → 按弧长每 spacing 米一个点。返回 { points, length, spacing }
// （不用 getPointAt：弧长参数浮点超过 1 一点会返回 NaN）
export function resampleCurve( controls, spacing = 0.5 ) {

	const curve = new THREE.CatmullRomCurve3( controls, false, 'centripetal' );
	const dense = [];
	const samples = Math.max( 200, controls.length * 120 );
	for ( let i = 0; i < samples; i ++ ) dense.push( curve.getPoint( i / ( samples - 1 ) ) );
	const along = [ 0 ];
	for ( let i = 1; i < dense.length; i ++ ) along.push( along[ i - 1 ] + dense[ i ].distanceTo( dense[ i - 1 ] ) );
	const total = along[ along.length - 1 ];
	const count = Math.max( 2, Math.round( total / spacing ) + 1 );
	const step = total / ( count - 1 );
	const points = [];
	let cursor = 0;
	for ( let i = 0; i < count; i ++ ) {

		const distance = Math.min( total, i * step );
		while ( cursor < dense.length - 2 && along[ cursor + 1 ] < distance ) cursor ++;
		const span = along[ cursor + 1 ] - along[ cursor ] || 1;
		points.push( new THREE.Vector3().lerpVectors( dense[ cursor ], dense[ cursor + 1 ], ( distance - along[ cursor ] ) / span ) );

	}

	return { points, length: total, spacing: step };

}

// 重采样后的折线上 distance 米处的点
export function pointOnCurve( resampled, distance, target ) {

	const clamped = Math.min( resampled.length, Math.max( 0, distance ) );
	const index = Math.min( resampled.points.length - 2, Math.floor( clamped / resampled.spacing ) );
	return target.lerpVectors( resampled.points[ index ], resampled.points[ index + 1 ], ( clamped - index * resampled.spacing ) / resampled.spacing );

}
