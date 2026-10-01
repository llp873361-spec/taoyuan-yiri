// 高度指数雾：密度随高度指数衰减 density(y) = d0 · exp(-y / H)，沿视线解析积分（不用步进）。
// 用法：scene.fogNode = heightFog( { ... } )，所有节点材质自动带上；不想要雾的材质设 material.fog = false。

import { Fn, float, vec3, exp, abs, max, dot, normalize, length, pow, mix, fog, positionWorld, cameraPosition } from 'three/tsl';

// 沿相机到片元的线段积分光学厚度，返回雾的不透明度 0~1
//   density：海拔 0 处的密度（每米）；falloff：衰减高度 H（米）
export const heightFogFactor = Fn( ( [ density, falloff, worldPosition, eyePosition ] ) => {

	const delta = worldPosition.sub( eyePosition );
	const distance = length( delta );
	const deltaY = delta.y;
	const eyeDensity = density.mul( exp( eyePosition.y.negate().div( falloff ) ) );

	// ∫0^L d0·exp(-(y0 + t·dy/L)/H) dt = d0·exp(-y0/H)·L·(1 - exp(-dy/H)) / (dy/H)；dy 接近 0 时退化成 d0·exp(-y0/H)·L
	const ratio = deltaY.div( falloff );
	const slanted = float( 1 ).sub( exp( ratio.negate() ) ).div( ratio );
	const integralFactor = abs( ratio ).greaterThan( 1e-4 ).select( slanted, float( 1 ) );
	const opticalDepth = eyeDensity.mul( distance ).mul( integralFactor );

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

// 组装成 scene.fogNode。参数都是节点（uniform）：
//   density、falloff：见上；baseColor：雾本身的颜色；scatterColor：朝光源看时额外的散射颜色
//   lightDirection：世界空间，指向光源；anisotropy：HG 的 g（0.6 左右）；amount：总开关 0~1
export function heightFog( { density, falloff, baseColor, scatterColor, lightDirection, anisotropy, amount } ) {

	const factor = heightFogFactor( density, falloff, positionWorld, cameraPosition ).mul( amount );
	const viewRay = normalize( positionWorld.sub( cameraPosition ) );
	const phase = henyeyGreenstein( dot( viewRay, lightDirection ), anisotropy );
	// 散射色按相函数加权，phase 在背光方向很小，雾就只剩底色
	const fogColor = vec3( baseColor ).add( vec3( scatterColor ).mul( phase.mul( 0.25 ) ) );

	return fog( fogColor, factor );

}

// 给天空自己用的"地平线雾"：天空没有距离，按视线仰角给一个等效厚度
export function horizonHaze( direction, color, strength ) {

	const elevation = max( direction.y, 0 );
	return mix( vec3( color ), vec3( 0 ), float( 1 ).sub( exp( elevation.mul( - 18 ) ) ) ).mul( strength );

}
