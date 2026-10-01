// 天空共用件：星空、月亮、一天的统一天空。输入都是"视线方向"（世界空间单位向量），输出 HDR 颜色。

import { If, float, vec2, vec3, floor, normalize, length, fwidth, smoothstep, max, exp, sin, mix, step, dot, pow, clamp } from 'three/tsl';
import { hash33 } from './noise.js';

// 星空：把方向放进 3D 网格，每格最多一颗星；亮度分三级（大部分很暗，少数很亮），轻微闪烁
//   direction：视线方向；time：秒（uniform）；density：有星的格子比例；gridScale：网格密度（越大星越多越小）
//   brightness：整体亮度；dimming：0~1，被极光盖住的地方传进来让星星变淡
export function starField( { direction, time, density = 0.35, gridScale = 180, brightness = 1, dimming = float( 0 ), pixelAngle = null, dimMagnitude = 0.25 } ) {

	const gridPoint = direction.mul( gridScale );
	const cell = floor( gridPoint );
	const randomA = hash33( cell );
	const randomB = hash33( cell.add( vec3( 71, 13, 29 ) ) );

	// 星在格子里的位置，离格子边留 0.25 免得被切掉
	const starPoint = cell.add( vec3( 0.25 ).add( randomA.mul( 0.5 ) ) );
	const starDirection = normalize( starPoint );
	const angularDistance = length( direction.sub( starDirection ) );
	// 像素对应的角度，星星画成约 1.2 像素的软点，远近一致
	const pixelAngularSize = pixelAngle || max( length( fwidth( direction ) ), 1e-5 );
	const shape = float( 1 ).sub( smoothstep( pixelAngularSize.mul( 0.2 ), pixelAngularSize.mul( 1.2 ), angularDistance ) );

	const exists = step( randomB.x, density );
	// 三级亮度：80% 暗星、17% 中等、3% 亮星
	const tier = randomB.y;
	const magnitude = tier.lessThan( 0.8 ).select( float( dimMagnitude ), tier.lessThan( 0.97 ).select( float( 1.2 ), float( 5.0 ) ) );
	const twinkle = float( 0.85 ).add( sin( time.mul( mix( 1.5, 4.0, randomB.z ) ).add( randomA.x.mul( 40 ) ) ).mul( 0.15 ) );
	// 星色在冷白和暖白之间
	const tint = mix( vec3( 0.75, 0.85, 1.0 ), vec3( 1.0, 0.92, 0.8 ), randomA.y );

	return tint.mul( shape.mul( exists ).mul( magnitude ).mul( twinkle ).mul( brightness ).mul( float( 1 ).sub( dimming ) ) );

}

// 月亮：HDR 圆盘 + 一层紧贴的光晕 + 一层很大很淡的光晕
//   moonDirection：指向月亮；angularRadius：圆盘角半径（弧度）；color：月色；intensity：圆盘 HDR 亮度
export function moonGlow( { direction, moonDirection, angularRadius = 0.012, color, intensity = 18, innerHalo = 0.6, outerHalo = 0.12, pixelAngle = null } ) {

	const angle = length( direction.sub( moonDirection ) );
	const pixelAngularSize = pixelAngle || max( length( fwidth( direction ) ), 1e-5 );
	const disc = float( 1 ).sub( smoothstep( float( angularRadius ).sub( pixelAngularSize ), pixelAngularSize.add( angularRadius ), angle ) );
	// 紧贴圆盘边缘的亮晕 + 大范围的淡晕
	const tight = exp( max( angle.sub( angularRadius ), 0 ).mul( - 60 ) ).mul( innerHalo );
	const wide = exp( angle.mul( - 4.5 ) ).mul( outerHalo );

	return vec3( color ).mul( disc.mul( intensity ).add( tight ).add( wide ) );

}

// ===================== 一天的统一天空（秘境：所有地点、飞行途中共用，规格书 5.0）=====================
// sky 是 world.js 的 uniforms：太阳 / 月亮方向、各处天色、维纳斯带、光晕、星星、月光的强度，都按时刻插值好了

// 朝着太阳的程度：水平面上的方位夹角，1 = 正对太阳方位，0 = 正背着
function towardSunAmount( direction, sky ) {

	const flat = normalize( vec2( direction.x, direction.z ).add( vec2( 1e-5, 0 ) ) );
	const sunFlat = normalize( vec2( sky.sunDirection.x, sky.sunDirection.z ).add( vec2( 1e-5, 0 ) ) );
	// 夹到 [0,1]：两个单位向量的点积舍入后可能略超出，后面要开 pow，负底数在 Metal / Vulkan 上是 NaN
	return dot( flat, sunFlat ).mul( 0.5 ).add( 0.5 ).clamp( 0, 1 );

}

// 地平线一圈的雾霭色（已乘天空亮度）：背着太阳是地球影子那条灰紫蓝，侧面是普通地平线色，朝太阳那边是太阳侧的暖色。
// 远处的山、海面在大气透视里都往这个颜色溶，和天空贴地平线的那一圈接得上
export function dayHazeColor( direction, sky ) {

	const towardSun = towardSunAmount( direction, sky );
	const side = mix( sky.earthShadowColor, sky.horizonColor, smoothstep( 0.0, 0.55, towardSun ) );
	return mix( side, sky.sunHorizonColor, pow( towardSun, 3 ) ).mul( sky.skyIntensity );

}

// 太阳周围的光晕：两层指数衰减（宽的一层是大气里的米氏散射，窄的一层贴着圆盘）
function sunGlowColor( direction, sky ) {

	const cosineToSun = dot( direction, sky.sunDirection ).clamp( 0, 1 );
	const glow = pow( cosineToSun, 6 ).mul( 0.35 ).add( pow( cosineToSun, 48 ).mul( 0.9 ) ).mul( sky.glowAmount ).mul( sky.skyIntensity );
	return sky.glowColor.mul( glow );

}

// 大气透视的目标色：远处的山、海、薄雾在这个方向上溶进去的颜色（地平线雾霭 + 太阳光晕，不含圆盘和星星）。
// 视线朝下（从高处往下看）时和天空贴地平线以下的那一圈一致：越往下越暗一点
export function dayAerialColor( direction, sky ) {

	const below = float( 1 ).sub( smoothstep( - 0.15, 0.0, direction.y ) );
	return dayHazeColor( direction, sky ).add( sunGlowColor( direction, sky ) ).mul( mix( float( 1 ), float( 0.75 ), below ) );

}

// 统一天空（HDR）。time：秒，用来让星星闪烁
//   地平线 → 天顶：仰角开 0.45 次方再 smoothstep，地平线附近过渡快、头顶大片是天顶色
//   维纳斯带：背着太阳、仰角 5~15° 的一条粉带，只在太阳贴着地平线时出现（beltAmount）
//   太阳光晕：见 sunGlowColor
//   太阳圆盘：放大到约 1.2°，HDR，只画在地平线以上；月亮、星星用上面的 moonGlow / starField
//   options.sunDisc = false：不画太阳圆盘（水面倒影用，太阳的高光另外按粗糙度算，免得重复）
//   options.stars = false：不画星星
//   星星、月亮各自的强度是 0 的时候（白天）整段跳过：条件只看 uniform，整帧一致，不分叉。要在 Fn 里调用
export function daySkyColor( direction, sky, time, { sunDisc = true, stars = true } = {} ) {

	const elevation = clamp( direction.y, - 1, 1 );
	const up = max( elevation, 0 );
	const intensity = sky.skyIntensity;
	const towardSun = towardSunAmount( direction, sky );

	const haze = dayHazeColor( direction, sky );
	const gradient = smoothstep( 0.0, 1.0, pow( up, 0.45 ) );
	const base = mix( haze, sky.zenithColor.mul( intensity ), gradient );

	const belt = exp( up.sub( 0.12 ).div( 0.07 ).pow2().negate() ).mul( max( float( 1 ).sub( towardSun ), 0 ).pow( 1.5 ) ).mul( sky.beltAmount );
	const beltColor = sky.beltColor.mul( belt ).mul( intensity );

	let skyWithSun = base.add( beltColor ).add( sunGlowColor( direction, sky ) );

	if ( sunDisc ) {

		// 太阳圆盘：贴地平线时偏橙、高了偏白；圆盘只在地平线以上
		const chord = length( direction.sub( sky.sunDirection ) );
		const pixelAngle = max( length( fwidth( direction ) ), 1e-5 );
		const disc = float( 1 ).sub( smoothstep( sky.sunDiscRadius.sub( pixelAngle ), sky.sunDiscRadius.add( pixelAngle ), chord ) )
			.mul( smoothstep( - 0.0004, 0.0004, elevation ) );
		const discTint = mix( vec3( 1.0, 0.54, 0.3 ), vec3( 1.0, 0.95, 0.82 ), smoothstep( 0.0, 0.09, sky.sunDirection.y ) );
		skyWithSun = skyWithSun.add( discTint.mul( disc ).mul( sky.sunDiscIntensity ).mul( smoothstep( - 0.03, 0.0, sky.sunDirection.y ) ) );

	}

	const result = skyWithSun.toVar();
	// 屏幕导数在分支外面先算好并落地成变量（月亮圆盘、星星的抗锯齿要用）：TSL 按第一次用到的位置生成代码，不 toVar 就会生成进 If 里面
	const pixelAngleOutside = max( length( fwidth( direction ) ), 1e-5 ).toVar();

	If( sky.moonAmount.greaterThan( 0.001 ), () => {

		const moon = moonGlow( {
			direction, moonDirection: sky.moonDirection, angularRadius: sky.moonDiscRadius,
			color: vec3( 0.86, 0.9, 1.0 ), intensity: 7, innerHalo: 0.35, outerHalo: 0.06, pixelAngle: pixelAngleOutside,
		} ).mul( sky.moonAmount ).mul( smoothstep( - 0.02, 0.01, elevation ) );
		result.addAssign( moon );

	} );

	if ( stars ) {

		If( sky.starAmount.greaterThan( 0.001 ), () => {

			// 星星不能多：大部分是很暗的星，偶尔几颗亮的（一格一颗，3.5% 的格子有星）
			result.addAssign( starField( { direction, time, density: 0.035, gridScale: 220, brightness: 0.7, dimMagnitude: 0.08, pixelAngle: pixelAngleOutside } )
				.mul( sky.starAmount ).mul( smoothstep( 0.0, 0.12, up ) ) );

		} );

	}

	// 地平线以下（海面、山遮不住的缝）：地平线雾霭色，越往下越暗一点
	return mix( result, haze.mul( 0.75 ), float( 1 ).sub( smoothstep( - 0.15, 0.0, elevation ) ) );

}
