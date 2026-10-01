// 共用噪声库（TSL 版 + 少量 JS 版）。所有场景共用，不要在场景里复制一份。
// 哈希用 PCG 整数哈希（Jarzynski & Olano《Hash Functions for GPU Rendering》，JCGT 2020），
// 整数运算在 WebGPU 和 WebGL2 上结果一致，大坐标也不会像 fract(sin()) 那样丢精度。

import { Fn, float, vec2, vec3, uint, floor, fract, mix, dot, sqrt, max, cos, sin } from 'three/tsl';

// ===================== TSL：哈希 =====================

// PCG 一轮：uint → uint
export const pcgHash = Fn( ( [ value ] ) => {

	const state = value.mul( 747796405 ).add( uint( 2891336453 ) );
	const word = state.shiftRight( state.shiftRight( 28 ).add( 4 ) ).bitXor( state ).mul( 277803737 );
	return word.shiftRight( 22 ).bitXor( word );

} ).setLayout( { name: 'pcgHash', type: 'uint', inputs: [ { name: 'value', type: 'uint' } ] } );

const toUnitFloat = ( hashed ) => hashed.toFloat().mul( 1 / 4294967296 );

// 2D 格点 → [0,1)。cell 必须是整数值（floor 过的）
export const hash21 = Fn( ( [ cell ] ) => {

	const bitsX = cell.x.toInt().toUint();
	const bitsY = cell.y.toInt().toUint();
	return toUnitFloat( pcgHash( bitsX.add( pcgHash( bitsY ) ) ) );

} ).setLayout( { name: 'hash21', type: 'float', inputs: [ { name: 'cell', type: 'vec2' } ] } );

// 2D 格点 → 两个独立的 [0,1)
export const hash22 = Fn( ( [ cell ] ) => {

	const first = pcgHash( cell.x.toInt().toUint().add( pcgHash( cell.y.toInt().toUint() ) ) );
	const second = pcgHash( first );
	return vec2( toUnitFloat( first ), toUnitFloat( second ) );

} ).setLayout( { name: 'hash22', type: 'vec2', inputs: [ { name: 'cell', type: 'vec2' } ] } );

// 3D 格点 → 三个独立的 [0,1)
export const hash33 = Fn( ( [ cell ] ) => {

	const first = pcgHash( cell.x.toInt().toUint().add( pcgHash( cell.y.toInt().toUint().add( pcgHash( cell.z.toInt().toUint() ) ) ) ) );
	const second = pcgHash( first );
	const third = pcgHash( second );
	return vec3( toUnitFloat( first ), toUnitFloat( second ), toUnitFloat( third ) );

} ).setLayout( { name: 'hash33', type: 'vec3', inputs: [ { name: 'cell', type: 'vec3' } ] } );

// ===================== TSL：value noise =====================

// 五次插值曲线 6t^5-15t^4+10t^3，导数在格点处为 0，接缝看不出来
const quintic = ( fraction ) => fraction.mul( fraction ).mul( fraction ).mul( fraction.mul( fraction.mul( 6 ).sub( 15 ) ).add( 10 ) );

// 2D value noise，输出 [0,1]
export const valueNoise2D = Fn( ( [ position ] ) => {

	const cell = floor( position );
	const local = fract( position );
	const weight = quintic( local );

	const corner00 = hash21( cell );
	const corner10 = hash21( cell.add( vec2( 1, 0 ) ) );
	const corner01 = hash21( cell.add( vec2( 0, 1 ) ) );
	const corner11 = hash21( cell.add( vec2( 1, 1 ) ) );

	return mix( mix( corner00, corner10, weight.x ), mix( corner01, corner11, weight.x ), weight.y );

} ).setLayout( { name: 'valueNoise2D', type: 'float', inputs: [ { name: 'position', type: 'vec2' } ] } );

// 3D value noise，输出 [0,1]
export const valueNoise3D = Fn( ( [ position ] ) => {

	const cell = floor( position );
	const local = fract( position );
	const weight = quintic( local );

	const corner = ( x, y, z ) => hash33( cell.add( vec3( x, y, z ) ) ).x;

	const bottom = mix(
		mix( corner( 0, 0, 0 ), corner( 1, 0, 0 ), weight.x ),
		mix( corner( 0, 1, 0 ), corner( 1, 1, 0 ), weight.x ),
		weight.y,
	);
	const top = mix(
		mix( corner( 0, 0, 1 ), corner( 1, 0, 1 ), weight.x ),
		mix( corner( 0, 1, 1 ), corner( 1, 1, 1 ), weight.x ),
		weight.y,
	);
	return mix( bottom, top, weight.z );

} ).setLayout( { name: 'valueNoise3D', type: 'float', inputs: [ { name: 'position', type: 'vec3' } ] } );

// ===================== TSL：simplex noise =====================

// 2D simplex noise（Perlin 2001 的单纯形网格思路，自己按算法写），输出约 [-1,1]
// 斜切系数 F2=(√3-1)/2、G2=(3-√3)/6 把正方形网格切成三角形，每个点只看 3 个角
export const simplexNoise2D = Fn( ( [ position ] ) => {

	const skewFactor = 0.3660254037844386;
	const unskewFactor = 0.21132486540518713;

	const cell = floor( position.add( dot( position, vec2( skewFactor ) ) ) );
	const corner0 = position.sub( cell ).add( dot( cell, vec2( unskewFactor ) ) );

	// 落在上三角还是下三角
	const step = corner0.x.greaterThan( corner0.y ).select( vec2( 1, 0 ), vec2( 0, 1 ) );
	const corner1 = corner0.sub( step ).add( unskewFactor );
	const corner2 = corner0.sub( 1 ).add( unskewFactor * 2 );

	// 每个角随机一个单位梯度方向
	const gradient = ( offset ) => {

		const angle = hash21( cell.add( offset ) ).mul( 6.283185307 );
		return vec2( cos( angle ), sin( angle ) );

	};

	const contribution = ( local, offset ) => {

		const falloff = max( float( 0.5 ).sub( dot( local, local ) ), 0 );
		const falloff2 = falloff.mul( falloff );
		return falloff2.mul( falloff2 ).mul( dot( gradient( offset ), local ) );

	};

	const total = contribution( corner0, vec2( 0, 0 ) )
		.add( contribution( corner1, step ) )
		.add( contribution( corner2, vec2( 1, 1 ) ) );

	// 70 是让输出大致落在 [-1,1] 的经验缩放
	return total.mul( 70 );

} ).setLayout( { name: 'simplexNoise2D', type: 'float', inputs: [ { name: 'position', type: 'vec2' } ] } );

// ===================== TSL：fbm =====================

// 每个八度之间转一下坐标（旋转矩阵 [0.8,-0.6;0.6,0.8]，约 36.87°），打破网格对齐的周期感
const rotateOctave = ( position ) => vec2(
	position.x.mul( 0.8 ).sub( position.y.mul( 0.6 ) ),
	position.x.mul( 0.6 ).add( position.y.mul( 0.8 ) ),
);

// 2D fbm（value noise 叠加），八度数是 JS 常量，构建时展开。输出 [0,1]，均值约 0.5
export function fbm2D( position, octaves = 4, lacunarity = 2.0, gain = 0.5 ) {

	let sum = float( 0 );
	let amplitude = 1;
	let amplitudeSum = 0;
	let point = position;

	for ( let i = 0; i < octaves; i ++ ) {

		sum = sum.add( valueNoise2D( point ).mul( amplitude ) );
		amplitudeSum += amplitude;
		amplitude *= gain;
		point = rotateOctave( point ).mul( lacunarity ).add( vec2( 17.3 * ( i + 1 ), 9.1 * ( i + 1 ) ) );

	}

	return sum.div( amplitudeSum );

}

// 3D fbm，输出 [0,1]
export function fbm3D( position, octaves = 4, lacunarity = 2.0, gain = 0.5 ) {

	let sum = float( 0 );
	let amplitude = 1;
	let amplitudeSum = 0;
	let point = position;

	for ( let i = 0; i < octaves; i ++ ) {

		sum = sum.add( valueNoise3D( point ).mul( amplitude ) );
		amplitudeSum += amplitude;
		amplitude *= gain;
		point = point.mul( lacunarity ).add( vec3( 11.7 * ( i + 1 ), 5.3 * ( i + 1 ), 23.9 * ( i + 1 ) ) );

	}

	return sum.div( amplitudeSum );

}

// ===================== TSL：voronoi =====================

// 2D Worley/voronoi：返回 vec3( F1, F2, 最近细胞的哈希 )，距离单位是格子
// jitter：细胞点在格子里的抖动幅度（1 = 满抖动）；keepProbability：用第二个哈希随机删掉一部分细胞，让密度不均匀
export const voronoi2D = Fn( ( [ position, jitter, keepProbability ] ) => {

	const cell = floor( position );
	const local = fract( position );
	const nearest = float( 8 ).toVar();
	const second = float( 8 ).toVar();
	const nearestHash = float( 0 ).toVar();

	for ( let j = - 1; j <= 1; j ++ ) {

		for ( let i = - 1; i <= 1; i ++ ) {

			const offset = vec2( i, j );
			const random = hash22( cell.add( offset ) );
			const keepRandom = hash21( cell.add( offset ).add( vec2( 113, 71 ) ) );
			const point = offset.add( vec2( 0.5 ).add( random.sub( 0.5 ).mul( jitter ) ) );
			const delta = point.sub( local );
			// 被删掉的细胞当作无穷远
			const distance = keepRandom.lessThan( keepProbability ).select( sqrt( dot( delta, delta ) ), float( 8 ) );

			second.assign( distance.lessThan( nearest ).select( nearest, distance.lessThan( second ).select( distance, second ) ) );
			nearestHash.assign( distance.lessThan( nearest ).select( random.x, nearestHash ) );
			nearest.assign( distance.lessThan( nearest ).select( distance, nearest ) );

		}

	}

	return vec3( nearest, second, nearestHash );

} ).setLayout( { name: 'voronoi2D', type: 'vec3', inputs: [ { name: 'position', type: 'vec2' }, { name: 'jitter', type: 'float' }, { name: 'keepProbability', type: 'float' } ] } );

// ===================== TSL：curl noise / domain warp =====================

// 3D curl noise：三个错开的标量势场，有限差分求旋度，结果无散度，适合推粒子（Bridson 2007 的思路）
export const curlNoise3D = Fn( ( [ position ] ) => {

	const epsilon = 0.1;
	const potentialX = ( point ) => valueNoise3D( point );
	const potentialY = ( point ) => valueNoise3D( point.add( vec3( 31.4, 7.7, 19.1 ) ) );
	const potentialZ = ( point ) => valueNoise3D( point.add( vec3( 5.9, 43.2, 13.6 ) ) );

	const stepX = vec3( epsilon, 0, 0 );
	const stepY = vec3( 0, epsilon, 0 );
	const stepZ = vec3( 0, 0, epsilon );
	const twoEpsilon = 2 * epsilon;

	const dZdy = potentialZ( position.add( stepY ) ).sub( potentialZ( position.sub( stepY ) ) ).div( twoEpsilon );
	const dYdz = potentialY( position.add( stepZ ) ).sub( potentialY( position.sub( stepZ ) ) ).div( twoEpsilon );
	const dXdz = potentialX( position.add( stepZ ) ).sub( potentialX( position.sub( stepZ ) ) ).div( twoEpsilon );
	const dZdx = potentialZ( position.add( stepX ) ).sub( potentialZ( position.sub( stepX ) ) ).div( twoEpsilon );
	const dYdx = potentialY( position.add( stepX ) ).sub( potentialY( position.sub( stepX ) ) ).div( twoEpsilon );
	const dXdy = potentialX( position.add( stepY ) ).sub( potentialX( position.sub( stepY ) ) ).div( twoEpsilon );

	return vec3( dZdy.sub( dYdz ), dXdz.sub( dZdx ), dYdx.sub( dXdy ) );

} ).setLayout( { name: 'curlNoise3D', type: 'vec3', inputs: [ { name: 'position', type: 'vec3' } ] } );

// 2D domain warp：用两路 fbm 把坐标推开，p += amount * (fbm - 0.5) * 2
export function domainWarp2D( position, amount, scale = 0.5, octaves = 3 ) {

	const warpPoint = position.mul( scale );
	const offsetX = fbm2D( warpPoint, octaves ).sub( 0.5 ).mul( 2 );
	const offsetY = fbm2D( warpPoint.add( vec2( 5.2, 1.3 ) ), octaves ).sub( 0.5 ).mul( 2 );
	return position.add( vec2( offsetX, offsetY ).mul( amount ) );

}

// ===================== JS 版（地形高度场、相机贴地用）=====================

function jsPcg( value ) {

	const state = ( Math.imul( value >>> 0, 747796405 ) + 2891336453 ) >>> 0;
	const word = Math.imul( ( ( state >>> ( ( state >>> 28 ) + 4 ) ) ^ state ) >>> 0, 277803737 ) >>> 0;
	return ( ( word >>> 22 ) ^ word ) >>> 0;

}

// 和 TSL 版 hash21 同一算法
export function jsHash21( cellX, cellY ) {

	return jsPcg( ( ( cellX | 0 ) + jsPcg( cellY | 0 ) ) >>> 0 ) / 4294967296;

}

function jsQuintic( fraction ) {

	return fraction * fraction * fraction * ( fraction * ( fraction * 6 - 15 ) + 10 );

}

export function jsValueNoise2D( x, y ) {

	const cellX = Math.floor( x );
	const cellY = Math.floor( y );
	const weightX = jsQuintic( x - cellX );
	const weightY = jsQuintic( y - cellY );
	const corner00 = jsHash21( cellX, cellY );
	const corner10 = jsHash21( cellX + 1, cellY );
	const corner01 = jsHash21( cellX, cellY + 1 );
	const corner11 = jsHash21( cellX + 1, cellY + 1 );
	const bottom = corner00 + ( corner10 - corner00 ) * weightX;
	const top = corner01 + ( corner11 - corner01 ) * weightX;
	return bottom + ( top - bottom ) * weightY;

}

// JS fbm，和 TSL 版同样的旋转和偏移，输出 [0,1]
export function jsFbm2D( x, y, octaves = 4, lacunarity = 2.0, gain = 0.5 ) {

	let sum = 0;
	let amplitude = 1;
	let amplitudeSum = 0;
	let pointX = x;
	let pointY = y;

	for ( let i = 0; i < octaves; i ++ ) {

		sum += jsValueNoise2D( pointX, pointY ) * amplitude;
		amplitudeSum += amplitude;
		amplitude *= gain;
		const rotatedX = pointX * 0.8 - pointY * 0.6;
		const rotatedY = pointX * 0.6 + pointY * 0.8;
		pointX = rotatedX * lacunarity + 17.3 * ( i + 1 );
		pointY = rotatedY * lacunarity + 9.1 * ( i + 1 );

	}

	return sum / amplitudeSum;

}
