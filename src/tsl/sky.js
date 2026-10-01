// 天空共用件：星空、月亮。输入都是"视线方向"（世界空间单位向量），输出 HDR 颜色。

import { float, vec3, floor, normalize, length, fwidth, smoothstep, max, exp, sin, mix, step } from 'three/tsl';
import { hash33 } from './noise.js';

// 星空：把方向放进 3D 网格，每格最多一颗星；亮度分三级（大部分很暗，少数很亮），轻微闪烁
//   direction：视线方向；time：秒（uniform）；density：有星的格子比例；gridScale：网格密度（越大星越多越小）
//   brightness：整体亮度；dimming：0~1，被极光盖住的地方传进来让星星变淡
export function starField( { direction, time, density = 0.35, gridScale = 180, brightness = 1, dimming = float( 0 ) } ) {

	const gridPoint = direction.mul( gridScale );
	const cell = floor( gridPoint );
	const randomA = hash33( cell );
	const randomB = hash33( cell.add( vec3( 71, 13, 29 ) ) );

	// 星在格子里的位置，离格子边留 0.25 免得被切掉
	const starPoint = cell.add( vec3( 0.25 ).add( randomA.mul( 0.5 ) ) );
	const starDirection = normalize( starPoint );
	const angularDistance = length( direction.sub( starDirection ) );
	// 像素对应的角度，星星画成约 1.2 像素的软点，远近一致
	const pixelAngle = max( length( fwidth( direction ) ), 1e-5 );
	const shape = float( 1 ).sub( smoothstep( pixelAngle.mul( 0.2 ), pixelAngle.mul( 1.2 ), angularDistance ) );

	const exists = step( randomB.x, density );
	// 三级亮度：80% 暗星、17% 中等、3% 亮星
	const tier = randomB.y;
	const magnitude = tier.lessThan( 0.8 ).select( float( 0.25 ), tier.lessThan( 0.97 ).select( float( 1.2 ), float( 5.0 ) ) );
	const twinkle = float( 0.85 ).add( sin( time.mul( mix( 1.5, 4.0, randomB.z ) ).add( randomA.x.mul( 40 ) ) ).mul( 0.15 ) );
	// 星色在冷白和暖白之间
	const tint = mix( vec3( 0.75, 0.85, 1.0 ), vec3( 1.0, 0.92, 0.8 ), randomA.y );

	return tint.mul( shape.mul( exists ).mul( magnitude ).mul( twinkle ).mul( brightness ).mul( float( 1 ).sub( dimming ) ) );

}

// 月亮：HDR 圆盘 + 一层紧贴的光晕 + 一层很大很淡的光晕
//   moonDirection：指向月亮；angularRadius：圆盘角半径（弧度）；color：月色；intensity：圆盘 HDR 亮度
export function moonGlow( { direction, moonDirection, angularRadius = 0.012, color, intensity = 18, innerHalo = 0.6, outerHalo = 0.12 } ) {

	const angle = length( direction.sub( moonDirection ) );
	const pixelAngle = max( length( fwidth( direction ) ), 1e-5 );
	const disc = float( 1 ).sub( smoothstep( float( angularRadius ).sub( pixelAngle ), pixelAngle.add( angularRadius ), angle ) );
	// 紧贴圆盘边缘的亮晕 + 大范围的淡晕
	const tight = exp( max( angle.sub( angularRadius ), 0 ).mul( - 60 ) ).mul( innerHalo );
	const wide = exp( angle.mul( - 4.5 ) ).mul( outerHalo );

	return vec3( color ).mul( disc.mul( intensity ).add( tight ).add( wide ) );

}
