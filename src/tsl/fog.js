// 高度指数雾：密度随高度指数衰减 density(y) = d0 · exp(-y / H)，沿视线解析积分（不用步进）。
// 用法：scene.fogNode = heightFog( { ... } )，所有节点材质自动带上；不想要雾的材质设 material.fog = false。

import { Fn, float, vec3, exp, abs, max, dot, normalize, length, pow, mix, smoothstep, fog, positionWorld, cameraPosition } from 'three/tsl';
import { dayAerialColor } from './sky.js';

// 沿相机到片元的线段积分光学厚度，返回雾的不透明度 0~1
//   density：海拔 0 处的密度（每米）；falloff：衰减高度 H（米）
export const heightFogFactor = Fn( ( [ density, falloff, worldPosition, eyePosition ] ) => {

	const delta = worldPosition.sub( eyePosition );
	const distance = length( delta );
	const deltaY = delta.y;
	const eyeDensity = density.mul( exp( eyePosition.y.negate().div( falloff ) ) );

	// ∫0^L d0·exp(-(y0 + t·dy/L)/H) dt = d0·L·H·(exp(-y0/H) - exp(-y1/H)) / dy；dy 接近 0 时退化成 d0·exp(-y0/H)·L。
	// 写成两个 exp 相减，不写成 exp(-y0/H)·(1 - exp(-dy/H))/(dy/H)：相机很高（几公里）、衰减高度很小时 exp(dy/H) 会溢出成无穷，乘 0 得 NaN
	const ratio = deltaY.div( falloff );
	const pointDensity = density.mul( exp( worldPosition.y.negate().div( falloff ) ) );
	const slanted = distance.mul( eyeDensity.sub( pointDensity ) ).div( ratio );
	const opticalDepth = abs( ratio ).greaterThan( 1e-4 ).select( slanted, eyeDensity.mul( distance ) );

	return float( 1 ).sub( exp( opticalDepth.negate() ) );

} ).setLayout( {
	name: 'heightFogFactor',
	type: 'float',
	inputs: [
		{ name: 'density', type: 'float' },
		{ name: 'falloff', type: 'float' },
		{ name: 'worldPosition', type: 'vec3' },
		{ name: 'eyePosition', type: 'vec3' },
	],
} );

// Henyey–Greenstein 相函数，乘了 4π，各向同性时等于 1；g > 0 时朝光源方向看更亮（前向散射）
export const henyeyGreenstein = Fn( ( [ cosTheta, anisotropy ] ) => {

	const g2 = anisotropy.mul( anisotropy );
	const denominator = pow( max( float( 1 ).add( g2 ).sub( anisotropy.mul( cosTheta ).mul( 2 ) ), 1e-4 ), 1.5 );
	return float( 1 ).sub( g2 ).div( denominator );

} ).setLayout( {
	name: 'henyeyGreenstein',
	type: 'float',
	inputs: [ { name: 'cosTheta', type: 'float' }, { name: 'anisotropy', type: 'float' } ],
} );

// 交接用的同色薄雾（规格书 5.3"A 的内容化进同色薄雾"）：veil = { amount, yawDegrees, sky }
//   amount：world.uniforms.locationVeil；yawDegrees：地点的 yaw（场景坐标是地点局部坐标，视线要转回世界方向才能取统一天空的颜色）；
//   sky：world.uniforms。远处先进雾：每个像素的雾量 1 − (1 − amount)^(1 + 3·远近)，和后期的整屏薄雾同一个形状，amount = 1 时全是雾。
//   雾的颜色是统一天空的大气透视色（远景远山溶进去的那个颜色），所以化进去以后和远景、后期的薄雾是同一种颜色
export function veilAmountAt( veil, worldPosition, eyePosition ) {

	const distance = length( worldPosition.sub( eyePosition ) );
	const depth = smoothstep( 5, 400, distance );
	return float( 1 ).sub( pow( max( float( 1 ).sub( veil.amount ), 0 ), depth.mul( 3 ).add( 1 ) ) );

}

export function veilColorAt( veil, worldPosition, eyePosition ) {

	const local = normalize( worldPosition.sub( eyePosition ) );
	const angle = - veil.yawDegrees * Math.PI / 180;
	const cosine = Math.cos( angle );
	const sine = Math.sin( angle );
	const worldDirection = vec3( local.x.mul( cosine ).add( local.z.mul( sine ) ), local.y, local.x.mul( - sine ).add( local.z.mul( cosine ) ) );
	return dayAerialColor( worldDirection, veil.sky );

}

// 不吃场景雾的材质（海面）自己混薄雾
export function applyVeil( surfaceColor, veil, worldPosition = positionWorld, eyePosition = cameraPosition ) {

	return mix( surfaceColor, veilColorAt( veil, worldPosition, eyePosition ), veilAmountAt( veil, worldPosition, eyePosition ) );

}

// 组装成 scene.fogNode。参数都是节点（uniform）：
//   density、falloff：见上；baseColor：雾本身的颜色；scatterColor：朝光源看时额外的散射颜色
//   lightDirection：世界空间，指向光源；anisotropy：HG 的 g（0.6 左右）；amount：总开关 0~1
//   veil：可选，交接时的同色薄雾（见 veilAmountAt），和高度雾叠起来：透过率相乘，颜色按各自的量混
export function heightFog( { density, falloff, baseColor, scatterColor, lightDirection, anisotropy, amount, veil = null } ) {

	const factor = heightFogFactor( density, falloff, positionWorld, cameraPosition ).mul( amount );
	const viewRay = normalize( positionWorld.sub( cameraPosition ) );
	const phase = henyeyGreenstein( dot( viewRay, lightDirection ), anisotropy );
	// 散射色按相函数加权，phase 在背光方向很小，雾就只剩底色
	const fogColor = vec3( baseColor ).add( vec3( scatterColor ).mul( phase.mul( 0.25 ) ) );

	if ( ! veil ) return fog( fogColor, factor );

	const veilFactor = veilAmountAt( veil, positionWorld, cameraPosition );
	const combined = float( 1 ).sub( float( 1 ).sub( factor ).mul( float( 1 ).sub( veilFactor ) ) );
	const combinedColor = mix( fogColor, veilColorAt( veil, positionWorld, cameraPosition ), veilFactor.div( max( combined, 1e-4 ) ).clamp( 0, 1 ) );
	return fog( combinedColor, combined );

}

// 给天空自己用的"地平线雾"：天空没有距离，按视线仰角给一个等效厚度
export function horizonHaze( direction, color, strength ) {

	const elevation = max( direction.y, 0 );
	return mix( vec3( color ), vec3( 0 ), float( 1 ).sub( exp( elevation.mul( - 18 ) ) ) ).mul( strength );

}
