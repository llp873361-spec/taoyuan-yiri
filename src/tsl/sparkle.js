// 闪光层（雪、海面共用）。算法照 Bowles & Wang《Sparkly but not too sparkly!》（SIGGRAPH 2015）
// 和《A Robust and Flexible Real-Time Sparkle Effect》（EGSR 2016）的思路自己实现：
// 世界空间抖动网格放闪点，网格大小跟着像素足迹走（相当于闪光的 mipmap），闪点半径始终约 1 个像素，
// 所以远近都不会糊成噪点，闪烁只来自镜头移动。输出 HDR 颜色，交给 bloom 出星芒。

import { float, vec2, vec3, floor, fract, length, dFdx, dFdy, log2, exp2, max, min, mix, smoothstep, dot, normalize, cross, cos, sin, sqrt, pow, cameraPosition } from 'three/tsl';
import { hash33 } from './noise.js';

// 一层闪光在某一级网格上的结果
// pixelDx / pixelDy：相邻像素之间世界坐标的差（dFdx / dFdy），用来把世界里的距离换算成屏幕像素
function evaluateLevel( settings, level, footprintMax, pixelDx, pixelDy ) {

	const { position, normal, viewDirection, lightDirection, cellSize, existProbability, density, coneRadians, sharpness, radiusPixels, seed } = settings;

	const levelCellSize = exp2( level ).mul( cellSize );
	// 网格放在世界 XZ 平面上（雪地、海面都近似水平）
	const gridPoint = position.xz.div( levelCellSize ).add( vec2( seed * 13.7, seed * 7.3 ) );
	const cell = floor( gridPoint );
	const local = fract( gridPoint );

	const randomA = hash33( vec3( cell, level.add( seed * 31 ) ) );
	const randomB = hash33( vec3( cell, level.add( seed * 31 + 517 ) ) );

	// 闪点离格子边至少留一个"最长方向"的像素半径，单格就能查全
	const marginCell = min( footprintMax.mul( radiusPixels ).div( levelCellSize ), 0.4 );
	const sparklePoint = vec2( marginCell ).add( randomA.xy.mul( float( 1 ).sub( marginCell.mul( 2 ) ) ) );
	const offsetWorld = sparklePoint.sub( local ).mul( levelCellSize );

	// 世界 XZ 偏移 → 屏幕像素偏移：解 offset = dx·u + dy·v（2×2 逆矩阵）。
	// 掠射角下像素在纵深方向被拉得很长，按屏幕像素量距离，闪点在任何角度都是约 radiusPixels 的圆点，不会画成短线、也不会漏采
	const stepX = pixelDx.xz;
	const stepY = pixelDy.xz;
	const determinant = stepX.x.mul( stepY.y ).sub( stepX.y.mul( stepY.x ) );
	const safeDeterminant = determinant.abs().max( 1e-12 ).mul( determinant.sign().add( 0.5 ).sign() );
	const pixelU = offsetWorld.x.mul( stepY.y ).sub( offsetWorld.y.mul( stepY.x ) ).div( safeDeterminant );
	const pixelV = stepX.x.mul( offsetWorld.y ).sub( stepX.y.mul( offsetWorld.x ) ).div( safeDeterminant );
	const pixelDistance = length( vec2( pixelU, pixelV ) );
	const shape = float( 1 ).sub( smoothstep( radiusPixels * 0.3, radiusPixels, pixelDistance ) );

	// 存在概率乘密度：密度只决定"有没有"，不改闪点位置，所以调密度不会让闪点乱跳
	const exists = randomA.z.lessThan( density.mul( existProbability ) ).select( float( 1 ), float( 0 ) );

	// 随机微法线：在表面法线周围 coneRadians 的锥里
	const tangent = normalize( cross( normal, vec3( 0, 0, 1 ) ) );
	const bitangent = cross( normal, tangent );
	const azimuth = randomB.x.mul( 6.283185307 );
	const tilt = sqrt( randomB.y ).mul( coneRadians );
	const tiltTangent = sin( tilt ).div( cos( tilt ) );
	const microNormal = normalize( normal.add( tangent.mul( cos( azimuth ) ).add( bitangent.mul( sin( azimuth ) ) ).mul( tiltTangent ) ) );

	const halfVector = normalize( lightDirection.add( viewDirection ) );
	// 小晶面自己朝向光源的程度用 m·L；表面背光（N·L<0，在自己的影子面里）时不闪
	const facing = smoothstep( - 0.05, 0.1, dot( normal, lightDirection ) );
	const glint = pow( max( dot( microNormal, halfVector ), 0 ), sharpness ).mul( max( dot( microNormal, lightDirection ), 0 ) ).mul( facing );
	const brightness = mix( 0.4, 1.6, randomB.z );

	return shape.mul( exists ).mul( glint ).mul( brightness );

}

// 一层闪光（单光源）。参数：
//   position / normal：世界空间；viewDirection：表面指向相机；lightDirection：表面指向光源（都要单位向量）
//   lightColor：vec3，光源颜色 × 强度；density：0~1 的密度调制（斑驳、脚印里为 0）
//   cellSize：最细一级网格的边长（米）；existProbability：格子里有闪点的概率（0.1~0.3）
//   coneDegrees：微法线锥角（15~25°）；sharpness：高光指数（200~800）；intensity：HDR 亮度倍数
//   cellPixels：希望一个格子大约占多少像素；radiusPixels：闪点半径（像素）；levels：1 或 2（核显只用 1 级）
//   seed：每层不同的种子；fadeStart / fadeEnd：距离淡出范围（米）
export function sparkleLayer( settings ) {

	const {
		position, normal, viewDirection, lightDirection, lightColor,
		density = float( 1 ), cellSize = 0.05, existProbability = 0.2, coneDegrees = 20, sharpness = 400,
		intensity = 10, cellPixels = 6, radiusPixels = 0.8, levels = 2, seed = 1, fadeStart = 60, fadeEnd = 250,
	} = settings;

	const prepared = {
		position, normal, viewDirection, lightDirection, density, existProbability, sharpness, radiusPixels, seed,
		cellSize: float( cellSize ),
		coneRadians: coneDegrees * Math.PI / 180,
	};

	// 像素足迹：这个像素在世界里覆盖多大（选网格级别用，取长边防走样）
	const pixelDx = dFdx( position );
	const pixelDy = dFdy( position );
	const footprint = max( max( length( pixelDx ), length( pixelDy ) ), 1e-5 );
	// 希望格子 ≈ cellPixels 个像素；近处不小于最细一级
	const levelFloat = max( log2( footprint.mul( cellPixels ).div( cellSize ) ), 0 );

	let sparkle;
	if ( levels >= 2 ) {

		// 两级网格按小数部分混合，过渡时不会整片跳变
		const levelLow = floor( levelFloat );
		const blend = fract( levelFloat );
		sparkle = mix( evaluateLevel( prepared, levelLow, footprint, pixelDx, pixelDy ), evaluateLevel( prepared, levelLow.add( 1 ), footprint, pixelDx, pixelDy ), blend );

	} else {

		sparkle = evaluateLevel( prepared, floor( levelFloat.add( 0.5 ) ), footprint, pixelDx, pixelDy );

	}

	// 60~250 米淡出；远处用"存在概率 × 密度 × 平均高光"的统计值补上，能量连续
	const distance = length( position.sub( cameraPosition ) );
	const fade = float( 1 ).sub( smoothstep( fadeStart, fadeEnd, distance ) );
	const halfVector = normalize( lightDirection.add( viewDirection ) );
	// 统计补偿：宽一点的高光瓣（指数 12）× 存在概率 × 密度；0.03 是"一格里闪点面积占比 × 平均闪亮程度"的经验值，
	// 让 250 米处淡出后整片雪的平均亮度和近处闪点平均下来差不多
	const averageGlint = pow( max( dot( normal, halfVector ), 0 ), 12 ).mul( max( dot( normal, lightDirection ), 0 ) )
		.mul( density ).mul( existProbability ).mul( 0.03 );

	return vec3( lightColor ).mul( sparkle.mul( fade ).add( averageGlint.mul( fade.oneMinus() ) ) ).mul( intensity );

}
