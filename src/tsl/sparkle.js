// 闪光层（雪、海面共用）。算法照 Bowles & Wang《Sparkly but not too sparkly!》（SIGGRAPH 2015）
// 和《A Robust and Flexible Real-Time Sparkle Effect》（EGSR 2016）的思路自己实现：
// 世界空间抖动网格放闪点，网格大小跟着像素足迹走（相当于闪光的 mipmap），闪点半径始终约 1 个像素，
// 所以远近都不会糊成噪点。雪地不传 time，闪点静止，闪烁只来自镜头移动；
// 海面传 time，每个格子按自己的节奏生灭（水面的小晶面一直在换），输出 HDR 颜色，交给 bloom 出星芒。

import { Fn, If, float, vec2, vec3, floor, fract, length, dFdx, dFdy, log2, exp2, max, min, mix, smoothstep, dot, normalize, cross, cos, sin, sqrt, pow, cameraPosition } from 'three/tsl';
import { hash33 } from './noise.js';

// 一层闪光在某一级网格上的结果
// pixelDx / pixelDy：相邻像素之间世界坐标的差（dFdx / dFdy），用来把世界里的距离换算成屏幕像素
// marginFootprint：选网格用的那个像素足迹（'max' 模式是长边，'mean' 模式是几何平均），闪点离格子边留这么多
function evaluateLevel( settings, level, marginFootprint, pixelDx, pixelDy ) {

	const { position, normal, viewDirection, lightDirection, cellSize, existProbability, density, coneRadians, sharpness, radiusPixels, seed, time, twinkleRate } = settings;

	const levelCellSize = exp2( level ).mul( cellSize );
	// 网格放在世界 XZ 平面上（雪地、海面都近似水平）
	const gridPoint = position.xz.div( levelCellSize ).add( vec2( seed * 13.7, seed * 7.3 ) );
	const cell = floor( gridPoint );
	const local = fract( gridPoint );

	// 闪烁：每个格子一个随机相位，每过一个周期换一套随机数（换位置、换微法线），周期内 sin 包络淡入淡出不跳变
	let epoch = float( 0 );
	let twinkle = float( 1 );
	if ( time ) {

		const phase = hash33( vec3( cell, level.add( seed * 31 + 1031 ) ) ).x;
		const cycle = time.mul( twinkleRate ).add( phase );
		epoch = floor( cycle ).mul( 4096 );
		twinkle = sin( fract( cycle ).mul( Math.PI ) );

	}

	const randomA = hash33( vec3( cell, level.add( seed * 31 ).add( epoch ) ) );
	const randomB = hash33( vec3( cell, level.add( seed * 31 + 517 ).add( epoch ) ) );

	// 闪点离格子边至少留一个像素半径，单格就能查全（'mean' 模式下掠射角的纵深方向会超出一点，那个方向本来只占零点几个像素，看不出）
	const marginCell = min( marginFootprint.mul( radiusPixels ).div( levelCellSize ), 0.4 );
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

	return shape.mul( exists ).mul( glint ).mul( brightness ).mul( twinkle );

}

// 一层闪光（单光源）。参数：
//   position / normal：世界空间；viewDirection：表面指向相机；lightDirection：表面指向光源（都要单位向量）
//   lightColor：vec3，光源颜色 × 强度；density：0~1 的密度调制（斑驳、脚印里为 0）
//   cellSize：最细一级网格的边长（米）；existProbability：格子里有闪点的概率（0.1~0.3）
//   coneDegrees：微法线锥角（15~25°，也可以传节点：海面按每个像素剩下的斜率方差给）；sharpness：高光指数（200~800）；intensity：HDR 亮度倍数
//   cellPixels：希望一个格子大约占多少像素；radiusPixels：闪点半径（像素）；levels：1 或 2（核显只用 1 级）
//   seed：每层不同的种子；fadeStart / fadeEnd：距离淡出范围（米）
//   time / twinkleRate：可选，传了就让闪点随时间生灭（每秒换几轮），海面用
//   footprintMode：'max'（默认，按像素足迹的长边选网格，雪地用，最稳）或 'mean'（长短边的几何平均）。
//     掠射角下像素在纵深方向拉得很长，按长边选格子会大到横向几十个像素才一个闪点；海面几乎全是掠射角，用 'mean'
//   active：可选的布尔节点，false 的像素不算单颗闪点、只留远处的统计补偿（调用方保证那里的闪点本来就看不出来，比如海面光路外）
//   lean：省算（默认开，config.perf.scenesB.sparkleSkip）。2026-10-02 加，结果逐像素不变：超过 fadeEnd 的像素 fade 正好是 0，
//     单颗闪点乘 0，只算统计补偿；两级网格混合时小数部分正好是 0（近处 levelFloat 被夹在 0）就不算第二级（mix( a, b, 0 ) 就是 a）。
//     关掉时 active 也不起作用，和原来一样每个像素都算两级
export function sparkleLayer( settings ) {

	const {
		position, normal, viewDirection, lightDirection, lightColor,
		density = float( 1 ), cellSize = 0.05, existProbability = 0.2, coneDegrees = 20, sharpness = 400,
		intensity = 10, cellPixels = 6, radiusPixels = 0.8, levels = 2, seed = 1, fadeStart = 60, fadeEnd = 250,
		time = null, twinkleRate = 2, footprintMode = 'max', active = null, lean = true,
	} = settings;

	// 包一层 Fn：里面要用 If（调用方在不在 Fn 里都行）
	return Fn( () => {

		// 像素足迹：这个像素在世界里覆盖多大。'max' 取长边（最稳，不走样）；'mean' 取长短边的几何平均（掠射角下格子不会大到横向几十个像素）。
		// 屏幕导数在分支外先存成变量（分支里求导结果未定义）
		const pixelDx = dFdx( position ).toVar();
		const pixelDy = dFdy( position ).toVar();
		const footprint = max( max( length( pixelDx ), length( pixelDy ) ), 1e-5 );
		const levelFootprint = ( footprintMode === 'mean' ? max( sqrt( length( pixelDx ).mul( length( pixelDy ) ) ), 1e-5 ) : footprint ).toVar();
		// 希望格子 ≈ cellPixels 个像素；近处不小于最细一级
		const levelFloat = max( log2( levelFootprint.mul( cellPixels ).div( cellSize ) ), 0 ).toVar();

		const prepared = {
			position, normal, viewDirection, lightDirection, density, existProbability, sharpness, radiusPixels, seed, time, twinkleRate,
			cellSize: float( cellSize ),
			coneRadians: typeof coneDegrees === 'number' ? coneDegrees * Math.PI / 180 : coneDegrees.mul( Math.PI / 180 ),
		};

		// 60~250 米淡出；远处用"存在概率 × 密度 × 平均高光"的统计值补上，能量连续
		const distance = length( position.sub( cameraPosition ) ).toVar();
		const fade = float( 1 ).sub( smoothstep( fadeStart, fadeEnd, distance ) );

		const sparkle = float( 0 ).toVar();
		const evaluate = () => {

			if ( levels >= 2 ) {

				// 两级网格按小数部分混合，过渡时不会整片跳变
				const levelLow = floor( levelFloat );
				const blend = fract( levelFloat );
				const levelHigh = () => evaluateLevel( prepared, levelLow.add( 1 ), levelFootprint, pixelDx, pixelDy );
				sparkle.assign( evaluateLevel( prepared, levelLow, levelFootprint, pixelDx, pixelDy ) );
				const addHigh = () => {

					sparkle.assign( mix( sparkle, levelHigh(), blend ) );

				};
				if ( lean ) If( blend.greaterThan( 0 ), addHigh );
				else addHigh();

			} else {

				sparkle.assign( evaluateLevel( prepared, floor( levelFloat.add( 0.5 ) ), levelFootprint, pixelDx, pixelDy ) );

			}

		};

		if ( lean ) If( active ? distance.lessThan( fadeEnd ).and( active ) : distance.lessThan( fadeEnd ), evaluate );
		else evaluate();

		const halfVector = normalize( lightDirection.add( viewDirection ) );
		// 统计补偿：宽一点的高光瓣（指数 12）× 存在概率 × 密度；0.03 是"一格里闪点面积占比 × 平均闪亮程度"的经验值，
		// 让 250 米处淡出后整片雪的平均亮度和近处闪点平均下来差不多
		const averageGlint = pow( max( dot( normal, halfVector ), 0 ), 12 ).mul( max( dot( normal, lightDirection ), 0 ) )
			.mul( density ).mul( existProbability ).mul( 0.03 );

		return vec3( lightColor ).mul( sparkle.mul( fade ).add( averageGlint.mul( fade.oneMinus() ) ) ).mul( intensity );

	} )();

}
