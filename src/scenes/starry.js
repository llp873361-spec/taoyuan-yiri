// 场景 4：深夜梵高《星月夜》（规格书第 9 节；阶段 12 CP3 返工重做）。整个画面是一幅活着的油画：天空、山和小镇、柏树都是一笔一笔的笔触，
// 没有一个像素是 3D 渲染直接上屏的。原画早已进入公有领域；这里不贴原画，全是程序化的。
//
// 构图：原画的天空、星、月、柏树按"默认视角"摆——竖直视场 50°、抬头 defaultPitch 时，原画（宽高比 1.26）的高正好撑满画面的高，
// 原画上 (u, v) 那一点在天空里的方向就是 paintingToSky(u, v)。默认画面里两个大涡、两条卷流、十一颗星、月亮、柏树的位置和原画一样，
// 转头看到的是这幅画往两边、往上接出去的部分。默认视角下秘境的山脊线（远景地形，仰角 0.07~0.1）正好落在原画山丘那一带，
// 小镇在画面下沿，和原画的村子一样。
//
// 天空坐标：x = 相对机位朝向的方位角 × cos(仰角)，y = 仰角（弧度）。三张底稿：
//   天空底稿：天空坐标里的一张贴图，按原画画好大色块（两个大涡的螺旋带、两条卷流、星和月的光晕、底色的深浅），不做 LIC；
//     alpha 存"让开"：1 是天空，0.5 是星芯、月盘（天空的笔绕开，由星环那一层画），0 是柏树；
//   流场贴图：每个天空坐标点的流速（大涡、小涡、两条卷流、每颗星的小涡、月的涡、往右的底流、一点 curl 噪声；规格书 9.2 的 Rankine 涡）；
//   地面底稿：镜头一动就重画（不动时隔几帧），用一台和主相机同位置、视场大两成的相机，把常驻远景（山、湖、小镇、城堡窗灯）画进一张小图。
// 笔触：一个实例化网格、一个材质，按层号分 10 层，按实例顺序画（后画的盖前面的）：
//   ① 天空底层大笔触（不动，顺着流向）→ ② 中层流线、③ 高光细笔（沿流线走，到寿命一笔笔"画上去、抹掉"）→ ④ 星环、星芯、月盘 → ⑤ 流光 →
//   ⑥ 地面笔触、⑦ 地面细笔（钉在地形上：从机位往外打到地形的那一点；颜色取地面底稿、换成原画夜里的配色，方向顺着等高线或顺着边，由远到近画）→
//   ⑧ 窗灯（小镇、城堡的窗，底稿里那扇窗亮着才画）→ ⑨ 柏树、⑩ 柏树的赭褐勾线（原画那棵火焰形的柏树，几道火舌的轮廓在天空坐标里定，轻轻摆）。
// 主相机进来以后只看第 2 层（笔触、天空底稿、流星、引路），远景只给地面底稿用；画布从四周蔓延的那几秒远景照画，笔触只在画布盖到的地方出现。
// 镜头：固定机位，推近用视场（50° → 44°），最后抬头看月亮；拖动转头 ±60° / ±25°。
// Kuwahara 油画滤镜在这里默认关掉（config.starry.kuwahara）：画面已经全是笔触，再过一遍只会把笔触的边抹糊。

import * as THREE from 'three/webgpu';
import {
	Fn, If, float, vec2, vec3, vec4, uniform, attribute, texture, color, uv, varyingProperty,
	positionGeometry, positionWorld, cameraPosition,
	normalize, length, dot, max, min, mix, smoothstep, pow, abs, sin, cos, tan, atan, asin, floor, fract, exp, step, sign, Discard, luminance, fwidth,
} from 'three/tsl';
import { daySkyColor } from '../tsl/sky.js';
import { hash21, valueNoise2D, fbm2D, jsValueNoise2D } from '../tsl/noise.js';

export const key = 'starry';

const degree = Math.PI / 180;
// 天空底稿、流场贴图覆盖的范围（天空坐标，弧度）：左右各 1.9（拖动转头 ±60° 再加半个视场），仰角 −0.25 ~ 1.45
const skyDomain = { minX: - 1.9, maxX: 1.9, minY: - 0.25, maxY: 1.45 };
const domainWidth = skyDomain.maxX - skyDomain.minX;
const domainHeight = skyDomain.maxY - skyDomain.minY;
// 笔触、天空底稿、流星走的那一层：主相机进来以后只看这一层，远景（第 0 层）只画进地面底稿
const paintLayer = 2;

// ===================== 构图：原画 → 天空坐标 =====================
// 原画按这个视角摆（抬头 0.22 弧度、竖直视场 50°）：这时原画的山丘正好落在秘境的山脊线上（见文件头）
const defaultPitch = 0.22;
// 镜头真正的默认视角：抬头 0.19、视场 56°（config.starry.fov）——原画的构图整个在画面里，上下各留一点，下面多露出小镇
const viewPitch = 0.19;
const paintingAspect = 1.26;
const halfFovTangent = Math.tan( 25 * degree );
// 原画上量位置用的那张图（1598 × 1268 像素）
const paintingWidth = 1598;
const paintingHeight = 1268;

// 原画上 (u, v)（u 从左到右、v 从上到下，0~1）在默认视角里的方向 → 天空坐标。原画的高撑满竖直视场，宽按 1.26 倍
function paintingToSky( u, v ) {

	const right = ( u - 0.5 ) * 2 * halfFovTangent * paintingAspect;
	const up = ( 0.5 - v ) * 2 * halfFovTangent;
	const x = right;
	const y = Math.sin( defaultPitch ) + up * Math.cos( defaultPitch );
	const z = - Math.cos( defaultPitch ) + up * Math.sin( defaultPitch );
	const norm = Math.hypot( x, y, z );
	const elevation = Math.asin( y / norm );
	const azimuth = Math.atan2( x / norm, - z / norm );
	return [ azimuth * Math.cos( elevation ), elevation ];

}

// 原画像素 → 天空坐标；半径（像素）换成天空里的弧度（左右各量一点取一半）
function paintingPoint( px, py ) {

	return paintingToSky( px / paintingWidth, py / paintingHeight );

}

function paintingRadius( px, py, radius ) {

	const [ x0, y0 ] = paintingPoint( px - radius, py );
	const [ x1, y1 ] = paintingPoint( px + radius, py );
	return Math.hypot( x1 - x0, y1 - y0 ) / 2;

}

// 原画的十一颗星：像素 x、y、光晕半径、亮度（右下那颗大的最亮）
const paintingStars = [
	[ 175, 55, 70, 0.95 ], [ 370, 45, 35, 0.7 ], [ 550, 45, 45, 0.8 ], [ 655, 85, 40, 0.8 ], [ 375, 222, 55, 0.9 ], [ 975, 100, 65, 0.9 ],
	[ 1130, 295, 55, 0.9 ], [ 520, 415, 40, 0.8 ], [ 75, 575, 35, 0.7 ], [ 210, 605, 55, 0.9 ], [ 565, 665, 110, 1.15 ],
];
// 原画框外的星（天空坐标 x、y、光晕半径、亮度）：转头才看得到的两侧，和最后抬头看月亮、往上拖时画面上方的
const extraStars = [
	[ - 0.66, 0.42, 0.03, 0.8 ], [ 0.66, 0.37, 0.032, 0.85 ], [ - 0.98, 0.38, 0.03, 0.8 ], [ 0.98, 0.33, 0.03, 0.75 ], [ - 1.36, 0.27, 0.026, 0.6 ], [ 1.38, 0.30, 0.026, 0.6 ],
	[ 0.2, 0.83, 0.032, 0.85 ], [ 0.66, 0.76, 0.03, 0.8 ], [ 0.42, 0.96, 0.028, 0.7 ], [ - 0.24, 0.82, 0.03, 0.75 ], [ - 0.62, 0.93, 0.026, 0.65 ], [ 0.02, 1.12, 0.028, 0.6 ],
];
// 每颗：天空坐标 x、y、光晕半径（弧度）、亮度
const stars = [
	...paintingStars.map( ( [ px, py, radius, brightness ] ) => [ ...paintingPoint( px, py ), paintingRadius( px, py, radius ), brightness ] ),
	...extraStars,
];
// 星芯半径是光晕的几成
const starCoreFraction = 0.3;

// 月亮：原画右上那个；disc 月盘半径、halo 光晕半径（弧度）
const moon = ( () => {

	const [ x, y ] = paintingPoint( 1455, 220 );
	return { x, y, disc: paintingRadius( 1455, 220, 80 ), halo: paintingRadius( 1455, 220, 170 ) };

} )();
// 月牙：月盘减去一个往左上偏的圆（按月盘半径：往西偏 0.375、往上偏 0.19，半径 0.94），右边厚、尖朝左上和左下；
// 原画月牙是饱和的橙黄，月牙里面那块（"暗"的部分）也是亮的淡黄
const crescent = { east: - 0.375, north: 0.19, radius: 0.94 };

// 两个大涡（原画最认得出来的那对，2026-10-02 用户："梵高你最明显的大漩涡没弄出来"）：一大一小咬在一起像横躺的 S——
// 卷流 A 从左边过来翻过大涡的顶，从两个涡中间落下去，再从小涡底下钻出来接进卷流 B 往右走。所以大涡顺时针、小涡逆时针。
// radius 涡画到多大；core 流场里的 Rankine 核半径；strength 环流强度（负的顺时针）；
// strands 从外缘到涡心有几缕细的亮暗缕（缕是一条盘得很密的螺旋，几乎同心；流场往里收的螺距也按它，笔绕着圈走、不横穿缕）；
// armTurns 那条宽的明暗螺旋从外缘盘到涡心几圈（原画远看亮缕连成的那一大条，原来只有这一条、两圈，像个问号）；
// joinAngle 宽螺旋的亮处在外缘哪个方位接上卷流（从 +x 逆时针量）
const bigSwirl = ( () => {

	const [ x, y ] = paintingPoint( 840, 440 );
	return { x, y, radius: paintingRadius( 840, 440, 210 ), core: 0.045, strength: - 1.4, strands: 3, armTurns: 1.0, joinAngle: 105 * degree, seed: 3.1 };

} )();
const smallSwirl = ( () => {

	const [ x, y ] = paintingPoint( 1095, 600 );
	return { x, y, radius: paintingRadius( 1095, 600, 118 ), core: 0.026, strength: 0.85, strands: 2.2, armTurns: 0.9, joinAngle: 200 * degree, seed: 7.7 };

} )();
const greatSwirls = [ bigSwirl, smallSwirl ];

// 卷流 A（上面那条）：原画左边从柏树尖左下方起，往右上斜着翻到大涡顶上，接进大涡最外一圈。
// 换到天空坐标是一条往右越来越高的弧（原画上是平的，抬头 0.22 的透视把它弯了）；原画框外慢慢放平，往左接出去。
// width 高斯半宽，strength 流速（流场单位）
const bandA = { width: 0.03, strength: 0.55 };

function bandACenterJs( x, phase = 0 ) {

	const distance = Math.max( 0.04 - x, 1e-5 );
	const lead = distance / Math.pow( 1 + Math.pow( distance / 0.68, 4 ), 0.25 );
	return 0.548 - 0.42 * Math.pow( lead, 1.7 ) + 0.012 * Math.sin( x * 3.3 + 1.0 + phase );

}

function bandACenterNode( x, phase ) {

	const distance = max( float( 0.04 ).sub( x ), 1e-5 );
	const lead = distance.div( pow( float( 1 ).add( pow( distance.div( 0.68 ), 4 ) ), 0.25 ) );
	return float( 0.548 ).sub( pow( lead, 1.7 ).mul( 0.42 ) ).add( sin( x.mul( 3.3 ).add( 1.0 ).add( phase ) ).mul( 0.012 ) );

}

// 卷流 B（下面那条）：贴着山脊线从左往右，过了大涡底下开始抬高，从小涡底下钻过去，右边又宽又亮（原画月亮下面那一大片淡黄绿）。
// 柏树左边那段比原画抬高 0.07：秘境左边（东边）的山比原画的山丘高，仰角到 0.15~0.18，不抬就整段藏在山后面
const bandB = { strength: 0.5 };

function bandBCenterJs( x, phase = 0 ) {

	return 0.109 + 0.16 * smoothJs( 0.05, 0.47, x ) + 0.04 * Math.max( - x, 0 ) + 0.07 * ( 1 - smoothJs( - 0.4, - 0.05, x ) ) + 0.035 * smoothJs( 0.55, 1.4, x ) + 0.006 * Math.sin( x * 5.1 + 0.4 + phase );

}

function bandBCenterNode( x, phase ) {

	return float( 0.109 ).add( smoothstep( 0.05, 0.47, x ).mul( 0.16 ) ).add( max( x.negate(), 0 ).mul( 0.04 ) ).add( float( 1 ).sub( smoothstep( - 0.4, - 0.05, x ) ).mul( 0.07 ) )
		.add( smoothstep( 0.55, 1.4, x ).mul( 0.035 ) ).add( sin( x.mul( 5.1 ).add( 0.4 ).add( phase ) ).mul( 0.006 ) );

}

function bandBWidthJs( x ) {

	return 0.022 + 0.023 * smoothJs( 0.1, 0.45, x );

}

function bandBWidthNode( x ) {

	return float( 0.022 ).add( smoothstep( 0.1, 0.45, x ).mul( 0.023 ) );

}

// 两条卷流和两个涡连成一整条 S（原画：上面那条卷流翻过大涡顶、顺着大涡外圈盘下来，从两个涡中间落下去，
// 再绕着小涡外圈从底下钻出来，接上下面那条）。两段接缝弧都是往里收的螺旋弧，端点对着两条卷流：
//   大涡那段从卷流 A 的末端（x = −0.03）起，顺时针绕到大涡右下（−40°），半径从末端那里收到 0.9 倍涡半径；
//   小涡那段从大涡出口起，逆时针绕过小涡底下到 −20°，半径收到 0.95 倍，再接一小段到卷流 B 上。
// 每段是一串天空坐标的点（JS 算好），底稿里按到折线的距离画亮带，布点的权重也算它
function spiralArc( swirl, from, toAngle, toRadius, clockwise ) {

	const startAngle = Math.atan2( from[ 1 ] - swirl.y, from[ 0 ] - swirl.x );
	const startRadius = Math.hypot( from[ 0 ] - swirl.x, from[ 1 ] - swirl.y );
	let endAngle = toAngle;
	// 顺时针：角度一路减小；逆时针：一路增大
	if ( clockwise ) while ( endAngle > startAngle ) endAngle -= 2 * Math.PI;
	else while ( endAngle < startAngle ) endAngle += 2 * Math.PI;
	const points = [];
	const steps = Math.max( 4, Math.ceil( Math.abs( endAngle - startAngle ) * startRadius / 0.018 ) );
	for ( let k = 0; k <= steps; k ++ ) {

		const t = k / steps;
		const angle = startAngle + ( endAngle - startAngle ) * t;
		const radius = startRadius + ( toRadius - startRadius ) * ( t * t * ( 3 - 2 * t ) );
		points.push( [ swirl.x + Math.cos( angle ) * radius, swirl.y + Math.sin( angle ) * radius ] );

	}

	return points;

}

const connectorArcs = ( () => {

	const bandAEnd = [ - 0.03, bandACenterJs( - 0.03 ) ];
	const bigArc = spiralArc( bigSwirl, bandAEnd, - 40 * degree, bigSwirl.radius * 0.9, true );
	const smallArc = spiralArc( smallSwirl, bigArc[ bigArc.length - 1 ], - 20 * degree, smallSwirl.radius * 0.95, false );
	const last = smallArc[ smallArc.length - 1 ];
	smallArc.push( [ last[ 0 ] + 0.03, bandBCenterJs( last[ 0 ] + 0.03 ) ] );
	return [ { points: bigArc, width: 0.032 }, { points: smallArc, width: 0.026 } ];

} )();

function connectorDistanceJs( x, y ) {

	let best = { distance: Infinity, width: 1 };
	for ( const arc of connectorArcs ) {

		for ( let k = 0; k + 1 < arc.points.length; k ++ ) {

			const [ ax, ay ] = arc.points[ k ];
			const [ bx, by ] = arc.points[ k + 1 ];
			const sx = bx - ax;
			const sy = by - ay;
			const t = Math.min( 1, Math.max( 0, ( ( x - ax ) * sx + ( y - ay ) * sy ) / ( sx * sx + sy * sy || 1e-9 ) ) );
			const distance = Math.hypot( x - ax - sx * t, y - ay - sy * t );
			if ( distance / arc.width < best.distance / best.width ) best = { distance, width: arc.width };

		}

	}

	return best;

}

// TSL 版：离接缝弧多远（按弧宽归一化，0 在弧上、1 在弧边上）
function connectorAcrossNode( point ) {

	let across = float( 1e3 );
	for ( const arc of connectorArcs ) {

		for ( let k = 0; k + 1 < arc.points.length; k ++ ) {

			const [ ax, ay ] = arc.points[ k ];
			const [ bx, by ] = arc.points[ k + 1 ];
			const segment = vec2( bx - ax, by - ay );
			const lengthSquared = Math.max( ( bx - ax ) ** 2 + ( by - ay ) ** 2, 1e-10 );
			const t = dot( point.sub( vec2( ax, ay ) ), segment ).div( lengthSquared ).clamp( 0, 1 );
			across = min( across, length( point.sub( vec2( ax, ay ).add( segment.mul( t ) ) ) ).div( arc.width ) );

		}

	}

	return across;

}

// 原画框外的陪衬小涡（x、y、核半径、强度）：比大涡弱得多，转头、抬头时天空不是一片平的
const sideVortices = [
	[ - 0.8, 0.30, 0.07, 0.3 ], [ 0.84, 0.44, 0.07, - 0.3 ], [ - 1.3, 0.36, 0.08, - 0.28 ], [ 1.3, 0.26, 0.08, 0.28 ], [ - 0.5, 0.86, 0.09, 0.25 ], [ 0.8, 0.98, 0.09, - 0.25 ],
];
// 往右的底流（流场单位）：涡和卷流以外的地方笔触横着慢慢走（弱一点，背景的笔主要跟着低频的 curl 噪声大弯大弯地流）
const baseDrift = 0.05;

// 柏树：原画上量的几道火舌（像素 x、y、半宽），每道从根到尖。主干最高，尖快到画的上沿；左边一道细的；右边三道矮的；右下角一团。
// 画框下沿（y = 1268）以下接着往下画（低头 25° 也看得到柏树根部那一大团）
const cypressTongues = [
	// 根部那一整团（原画柏树下半截是实心的，到这道的尖以上才分成几道火舌）
	[ [ 465, 3500, 330 ], [ 460, 2100, 300 ], [ 452, 1268, 262 ], [ 440, 1120, 225 ], [ 420, 990, 160 ], [ 395, 900, 100 ], [ 370, 830, 0 ] ],
	[ [ 345, 3500, 170 ], [ 335, 2100, 150 ], [ 330, 1268, 130 ], [ 325, 1000, 100 ], [ 320, 800, 78 ], [ 316, 600, 50 ], [ 316, 420, 32 ], [ 316, 260, 17 ], [ 313, 150, 9 ], [ 310, 78, 0 ] ],
	[ [ 272, 900, 32 ], [ 270, 820, 30 ], [ 256, 640, 20 ], [ 248, 500, 11 ], [ 243, 412, 0 ] ],
	[ [ 392, 1100, 46 ], [ 395, 1020, 42 ], [ 408, 860, 26 ], [ 419, 731, 0 ] ],
	[ [ 466, 1140, 52 ], [ 468, 1060, 48 ], [ 474, 900, 28 ], [ 470, 743, 0 ] ],
	[ [ 552, 1240, 60 ], [ 556, 1160, 56 ], [ 566, 990, 30 ], [ 559, 871, 0 ] ],
	[ [ 660, 2600, 120 ], [ 652, 1700, 100 ], [ 650, 1268, 85 ], [ 655, 1120, 45 ], [ 644, 995, 0 ] ],
];
// 换成天空坐标的折线：每点 [x, y, 半宽]。再把折线加密（每 0.02 一点），中线按高度左右扭、半宽一鼓一收：
// 原画的火舌边是 S 形的波浪（火苗往上舔），直的边像一棵棵冷杉
// 粗的折线（原画上量的那几个点）：天空底稿的 alpha 用它（着色器里每段算一次，加密以后几百段编不动）
const cypressCoarse = cypressTongues.map( ( tongue ) => tongue.map( ( [ px, py, halfWidth ] ) => [ ...paintingPoint( px, py ), halfWidth > 0 ? paintingRadius( px, py, halfWidth ) : 0 ] ) );
const cypressShape = cypressCoarse.map( ( coarse, tongueIndex ) => {

	const dense = [];
	for ( let k = 0; k + 1 < coarse.length; k ++ ) {

		const [ ax, ay, aw ] = coarse[ k ];
		const [ bx, by, bw ] = coarse[ k + 1 ];
		const steps = Math.max( 1, Math.ceil( Math.hypot( bx - ax, by - ay ) / 0.02 ) );
		for ( let s = 0; s < steps; s ++ ) {

			const t = s / steps;
			dense.push( [ ax + ( bx - ax ) * t, ay + ( by - ay ) * t, aw + ( bw - aw ) * t ] );

		}

	}

	dense.push( coarse[ coarse.length - 1 ] );
	return dense.map( ( [ x, y, width ] ) => {

		const wave = Math.sin( y * 26 + tongueIndex * 1.7 );
		return [ x + wave * width * 0.22, y, width * ( 1 + 0.16 * Math.sin( y * 41 + tongueIndex * 2.3 ) ) ];

	} );

} );

// 笔触层号（实例属性里存的就是这个数）和调试开关的对应
const layerIndex = { base: 0, middle: 1, highlight: 2, ring: 3, particle: 4, ground: 5, groundDetail: 6, window: 7, cypress: 8, cypressLine: 9 };
const layerToggleNames = [ 'base', 'middle', 'highlight', 'ring', 'particle', 'ground', 'ground', 'window', 'cypress', 'cypress' ];
const toggleKeys = [ 'base', 'middle', 'highlight', 'ring', 'particle', 'ground', 'window', 'cypress' ];

const state = {
	ctx: null,
	scene: null,
	ready: false,
	disposables: [],
	uniforms: null,
	layers: {},
	flowPass: null,
	skyPass: null,
	groundGuide: null,
	guidePrePass: null,
	paintObjects: [],
	meteors: [],
	nextMeteor: 6,
	frame: 0,
	skyRedrawn: - 1,
	skyInputs: [],          // 上一次画天空底稿时那几个开关（大漩涡、星、月）和颜料亮度的值（变了才重画）
	bounceColor: new THREE.Color(),
};

const tempVector = new THREE.Vector3();
const tempPosition = new THREE.Vector3();
const tempQuaternion = new THREE.Quaternion();
const tempScale = new THREE.Vector3();
const tempDirection = new THREE.Vector3();
const cullDirection = new THREE.Vector3();
const drawingSize = new THREE.Vector2();
const clearColor = new THREE.Color();

function createRandom( seed ) {

	let value = ( seed >>> 0 ) || 1;
	return function next() {

		value = ( value + 0x6D2B79F5 ) >>> 0;
		let mixed = Math.imul( value ^ ( value >>> 15 ), 1 | value );
		mixed = ( mixed + Math.imul( mixed ^ ( mixed >>> 7 ), 61 | mixed ) ) ^ mixed;
		return ( ( mixed ^ ( mixed >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

function between( random, range ) {

	return range[ 0 ] + random() * ( range[ 1 ] - range[ 0 ] );

}

function smoothJs( edge0, edge1, value ) {

	const amount = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return amount * amount * ( 3 - 2 * amount );

}

// 布点分块做，块和块之间让一下主线程（预加载在上一个地点停留时跑，一整块几百毫秒会卡一下画面）
function nextTask() {

	return new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

}

// ===================== 天空坐标 ↔ 方向 =====================

// 天空坐标 → 贴图坐标（0~1）
function domainCoordinate( point ) {

	return point.sub( vec2( skyDomain.minX, skyDomain.minY ) ).div( vec2( domainWidth, domainHeight ) );

}

// 天空坐标 → 单位方向（局部坐标，−z 是机位朝向）。天空坐标是"方位 × cos(仰角)"的正弦投影，离中线远的地方是斜切的，
// 所以星、月的圆盘、光环都按球面上的距离（弦长，小角度时就是弧度）画，不按天空坐标里的距离
function skyDirectionNode( point ) {

	const azimuth = point.x.div( max( cos( point.y ), 0.2 ) );
	return vec3( sin( azimuth ).mul( cos( point.y ) ), sin( point.y ), cos( azimuth ).mul( cos( point.y ) ).negate() );

}

// 单位方向 → 天空坐标
function directionToSky( direction ) {

	const elevation = asin( direction.y.clamp( - 1, 1 ) );
	return vec2( atan( direction.x, direction.z.negate() ).mul( cos( elevation ) ), elevation );

}

function skyDirectionJs( x, y ) {

	const azimuth = x / Math.max( 0.2, Math.cos( y ) );
	return [ Math.sin( azimuth ) * Math.cos( y ), Math.sin( y ), - Math.cos( azimuth ) * Math.cos( y ) ];

}

function directionToSkyJs( x, y, z ) {

	const length = Math.hypot( x, y, z ) || 1;
	const elevation = Math.asin( Math.min( 1, Math.max( - 1, y / length ) ) );
	return [ Math.atan2( x / length, - z / length ) * Math.cos( elevation ), elevation ];

}

// 两个天空坐标点在球面上隔多远（弦长）
function sphereDistanceJs( x0, y0, x1, y1 ) {

	const first = skyDirectionJs( x0, y0 );
	const second = skyDirectionJs( x1, y1 );
	return Math.hypot( first[ 0 ] - second[ 0 ], first[ 1 ] - second[ 1 ], first[ 2 ] - second[ 2 ] );

}

// 某个天空坐标点的切平面：东（方位增大）、北（仰角增大）两个单位向量
function tangentBasisJs( x, y ) {

	const azimuth = x / Math.max( 0.2, Math.cos( y ) );
	return {
		east: [ Math.cos( azimuth ), 0, Math.sin( azimuth ) ],
		north: [ - Math.sin( azimuth ) * Math.sin( y ), Math.cos( y ), Math.cos( azimuth ) * Math.sin( y ) ],
	};

}

// 天空坐标 → 局部方向（THREE.Vector3）
function localSkyDirection( x, y, target ) {

	const [ dx, dy, dz ] = skyDirectionJs( x, y );
	return target.set( dx, dy, dz );

}

// ===================== 流场（TSL 和 JS 两份，同一套公式；JS 版不带 curl 噪声）=====================

// 大涡的流场：Rankine 环流 + 往涡心收的一点，收的比例正好是细缕的螺距（径向 / 切向 = 半径 / (2π × 缕数 × 距离)），
// 流线就是细缕本身：笔触顺着缕一圈圈绕，不横穿亮暗缕。涡心 0.25 倍半径以内封顶，不往里猛冲。
// 远场按 exp(−(距离 / (1.6 · 螺旋半径))²) 收掉
function spiralInflow( swirl ) {

	return swirl.radius / ( 2 * Math.PI * swirl.strands );

}

function spiralVortex( point, swirl ) {

	const offset = point.sub( vec2( swirl.x, swirl.y ) );
	const offsetSquared = dot( offset, offset );
	const distance = offsetSquared.sqrt();
	const distanceSquared = max( offsetSquared, swirl.core * swirl.core );
	const falloff = exp( offsetSquared.div( ( 1.6 * swirl.radius ) ** 2 ).negate() );
	const tangential = vec2( offset.y.negate(), offset.x ).mul( swirl.strength );
	const inward = offset.negate().mul( float( Math.abs( swirl.strength ) * spiralInflow( swirl ) ).div( max( distance, swirl.radius * 0.25 ) ) );
	return tangential.add( inward ).mul( float( 1 / ( 2 * Math.PI ) ).div( distanceSquared ) ).mul( falloff );

}

function spiralVortexJs( x, y, swirl ) {

	const ox = x - swirl.x;
	const oy = y - swirl.y;
	const offsetSquared = ox * ox + oy * oy;
	const scale = 1 / ( 2 * Math.PI ) / Math.max( offsetSquared, swirl.core * swirl.core ) * Math.exp( - offsetSquared / ( 1.6 * swirl.radius ) ** 2 );
	const inward = Math.abs( swirl.strength ) * spiralInflow( swirl ) / Math.max( Math.sqrt( offsetSquared ), swirl.radius * 0.25 );
	return [ ( - oy * swirl.strength - ox * inward ) * scale, ( ox * swirl.strength - oy * inward ) * scale ];

}

// 在大涡螺旋带里的程度（0~1）：螺旋半径的 0.85 以内是 1，到 1.2 倍淡掉
function swirlInsideNode( point, swirl ) {

	return float( 1 ).sub( smoothstep( swirl.radius * 0.85, swirl.radius * 1.2, length( point.sub( vec2( swirl.x, swirl.y ) ) ) ) );

}

function swirlInsideJs( x, y, swirl ) {

	return 1 - smoothJs( swirl.radius * 0.85, swirl.radius * 1.2, Math.hypot( x - swirl.x, y - swirl.y ) );

}

function swirlMaskJs( x, y ) {

	return Math.max( swirlInsideJs( x, y, bigSwirl ), swirlInsideJs( x, y, smallSwirl ) );

}

// Rankine 涡：速度 = 强度 / 2π × 切向 / max(距离², 半径²)。远场按 exp(−(距离 / (reach · 半径))²) 收掉：
// 纯 Rankine 的 1/距离 拖得太远，几个涡的远场叠在一起，卷流下面整片变成竖着流（像下雨）
const vortexReach = 2.8;
function rankine( point, center, radius, strength, reach = vortexReach ) {

	const offset = point.sub( center );
	const offsetSquared = dot( offset, offset );
	const distanceSquared = max( offsetSquared, radius * radius );
	const falloff = exp( offsetSquared.div( ( reach * radius ) ** 2 ).negate() );
	return vec2( offset.y.negate(), offset.x ).mul( float( strength / ( 2 * Math.PI ) ).div( distanceSquared ) ).mul( falloff );

}

function rankineJs( x, y, cx, cy, radius, strength ) {

	const ox = x - cx;
	const oy = y - cy;
	const offsetSquared = ox * ox + oy * oy;
	const scale = strength / ( 2 * Math.PI ) / Math.max( offsetSquared, radius * radius ) * Math.exp( - offsetSquared / ( ( vortexReach * radius ) ** 2 ) );
	return [ - oy * scale, ox * scale ];

}

// 星的小涡：核半径是光晕的 0.6，单双号反着转，强度跟亮度走
function starVortex( index, halo, brightness ) {

	return { radius: halo * 0.6, strength: ( index % 2 ? - 0.2 : 0.2 ) * brightness };

}

// 流场（天空坐标）：大涡 + 陪衬小涡 + 星的小涡 + 月的涡 + 两条卷流 + 往右的底流 + curl 噪声。
// phase 让卷流的波形、curl 噪声慢慢变（涡的位置不动：动的是颜料，不是整片天往一边平移）
function createFlowFunction( flowConfig ) {

	return Fn( ( [ point, phase ] ) => {

		// 大涡里压掉底流和 curl 噪声：流线要和螺旋带重合，笔才顺着带子盘进去、不横穿亮暗带
		const swirlInside = max( swirlInsideNode( point, bigSwirl ), swirlInsideNode( point, smallSwirl ) );
		const velocity = vec2( float( baseDrift ).mul( float( 1 ).sub( swirlInside.mul( 0.9 ) ) ), 0 ).toVar();
		for ( const swirl of greatSwirls ) velocity.addAssign( spiralVortex( point, swirl ) );
		for ( const [ x, y, radius, strength ] of sideVortices ) velocity.addAssign( rankine( point, vec2( x, y ), radius, strength ) );
		stars.forEach( ( [ x, y, halo, brightness ], index ) => {

			const vortex = starVortex( index, halo, brightness );
			velocity.addAssign( rankine( point, vec2( x, y ), vortex.radius, vortex.strength ) );

		} );
		velocity.addAssign( rankine( point, vec2( moon.x, moon.y ), moon.disc * 1.3, - 0.14 ) );
		// 卷流 A：往右，顺着中线的切线（切线用中线左右各 0.01 的差分）；进到大涡外圈以内、过了大涡顶（x > 0）让给涡自己的环流
		const centerA = bandACenterNode( point.x, phase );
		const slopeA = bandACenterNode( point.x.add( 0.01 ), phase ).sub( bandACenterNode( point.x.sub( 0.01 ), phase ) ).div( 0.02 );
		const weightA = exp( point.y.sub( centerA ).div( bandA.width * 1.4 ).pow2().negate() )
			.mul( float( 1 ).sub( swirlInsideNode( point, bigSwirl ).mul( 0.85 ) ) ).mul( float( 1 ).sub( smoothstep( 0.0, 0.1, point.x ) ) );
		velocity.addAssign( normalize( vec2( 1, slopeA ) ).mul( weightA.mul( bandA.strength ) ) );
		// 卷流 B：往右；在小涡底下让一半给涡（小涡底下本来就往右流，接得上）
		const centerB = bandBCenterNode( point.x, phase );
		const slopeB = bandBCenterNode( point.x.add( 0.01 ), phase ).sub( bandBCenterNode( point.x.sub( 0.01 ), phase ) ).div( 0.02 );
		const weightB = exp( point.y.sub( centerB ).div( bandBWidthNode( point.x ).mul( 1.4 ) ).pow2().negate() )
			.mul( float( 1 ).sub( swirlInsideNode( point, smallSwirl ).mul( 0.6 ) ) );
		velocity.addAssign( normalize( vec2( 1, slopeB ) ).mul( weightB.mul( bandB.strength ) ) );
		// curl 噪声：二维噪声的梯度转 90°（无散度，不会在天空里聚出一团一团），一格约 0.6 弧度（低频，大弯、不出小折角），漂移 phase × curlDrift；涡里压掉
		const epsilon = 0.01;
		const noisePoint = point.mul( 1.6 ).add( vec2( phase.mul( flowConfig.curlDrift ), 0 ) );
		const gradientX = valueNoise2D( noisePoint.add( vec2( epsilon, 0 ) ) ).sub( valueNoise2D( noisePoint.sub( vec2( epsilon, 0 ) ) ) );
		const gradientY = valueNoise2D( noisePoint.add( vec2( 0, epsilon ) ) ).sub( valueNoise2D( noisePoint.sub( vec2( 0, epsilon ) ) ) );
		velocity.addAssign( vec2( gradientY, gradientX.negate() ).div( 2 * epsilon ).mul( flowConfig.curlAmplitude ).mul( float( 1 ).sub( swirlInside.mul( 0.85 ) ) ) );
		return velocity;

	} );

}

function flowAtJs( x, y, phase = 0 ) {

	let vx = baseDrift * ( 1 - swirlMaskJs( x, y ) * 0.9 );
	let vy = 0;
	const add = ( [ dx, dy ] ) => {

		vx += dx;
		vy += dy;

	};

	for ( const swirl of greatSwirls ) add( spiralVortexJs( x, y, swirl ) );
	for ( const [ cx, cy, radius, strength ] of sideVortices ) add( rankineJs( x, y, cx, cy, radius, strength ) );
	stars.forEach( ( [ cx, cy, halo, brightness ], index ) => {

		// 0.4 以外的星贡献不到 1e-6，跳过
		if ( Math.abs( x - cx ) > 0.4 || Math.abs( y - cy ) > 0.4 ) return;
		const vortex = starVortex( index, halo, brightness );
		add( rankineJs( x, y, cx, cy, vortex.radius, vortex.strength ) );

	} );
	add( rankineJs( x, y, moon.x, moon.y, moon.disc * 1.3, - 0.14 ) );
	const centerA = bandACenterJs( x, phase );
	const slopeA = ( bandACenterJs( x + 0.01, phase ) - bandACenterJs( x - 0.01, phase ) ) / 0.02;
	const weightA = Math.exp( - Math.pow( ( y - centerA ) / ( bandA.width * 1.4 ), 2 ) ) * ( 1 - swirlInsideJs( x, y, bigSwirl ) * 0.85 ) * ( 1 - smoothJs( 0, 0.1, x ) );
	const lengthA = Math.hypot( 1, slopeA );
	vx += weightA * bandA.strength / lengthA;
	vy += weightA * bandA.strength * slopeA / lengthA;
	const centerB = bandBCenterJs( x, phase );
	const slopeB = ( bandBCenterJs( x + 0.01, phase ) - bandBCenterJs( x - 0.01, phase ) ) / 0.02;
	const weightB = Math.exp( - Math.pow( ( y - centerB ) / ( bandBWidthJs( x ) * 1.4 ), 2 ) ) * ( 1 - swirlInsideJs( x, y, smallSwirl ) * 0.6 );
	const lengthB = Math.hypot( 1, slopeB );
	vx += weightB * bandB.strength / lengthB;
	vy += weightB * bandB.strength * slopeB / lengthB;
	return [ vx, vy ];

}

// 笔触的前进速度（弧度/秒）：clamp(|v| · scale, min, max)。1080p 上约 10~55 像素/秒
function paintSpeedJs( vx, vy, strokeSpeed ) {

	return Math.min( strokeSpeed.max, Math.max( strokeSpeed.min, Math.hypot( vx, vy ) * strokeSpeed.scale ) );

}

function paintSpeed( velocity, strokeSpeed ) {

	return length( velocity ).mul( strokeSpeed.scale ).clamp( strokeSpeed.min, strokeSpeed.max );

}

// ===================== 柏树的轮廓 =====================

// 某点在柏树里的程度：对每道火舌的每一段，量到中线的距离 ÷ 那里的半宽，取最里面的那道。
// 返回 inside（1 − 距离/半宽，> 0 在里面）、那道火舌在这里的切向（从根指向尖）、横向偏移（−1~1，左负右正）、在火舌上走到哪（0 根 ~ 1 尖）
const cypressLengths = cypressShape.map( ( tongue ) => {

	let total = 0;
	for ( let k = 0; k + 1 < tongue.length; k ++ ) total += Math.hypot( tongue[ k + 1 ][ 0 ] - tongue[ k ][ 0 ], tongue[ k + 1 ][ 1 ] - tongue[ k ][ 1 ] );
	return total;

} );

// 每道火舌的包围盒（外扩最大半宽）：点不在盒子里就不用一段段量
const cypressBounds = cypressShape.map( ( tongue ) => {

	const widest = Math.max( ...tongue.map( ( point ) => point[ 2 ] ) );
	return {
		minX: Math.min( ...tongue.map( ( point ) => point[ 0 ] ) ) - widest, maxX: Math.max( ...tongue.map( ( point ) => point[ 0 ] ) ) + widest,
		minY: Math.min( ...tongue.map( ( point ) => point[ 1 ] ) ) - widest, maxY: Math.max( ...tongue.map( ( point ) => point[ 1 ] ) ) + widest,
	};

} );

function cypressAtJs( x, y ) {

	const best = { inside: - Infinity, tangentX: 0, tangentY: 1, offset: 0, along: 0, tongue: - 1 };
	cypressShape.forEach( ( tongue, index ) => {

		const bounds = cypressBounds[ index ];
		if ( x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY ) return;
		let travelled = 0;
		for ( let k = 0; k + 1 < tongue.length; k ++ ) {

			const [ ax, ay, aw ] = tongue[ k ];
			const [ bx, by, bw ] = tongue[ k + 1 ];
			const sx = bx - ax;
			const sy = by - ay;
			const segment = Math.hypot( sx, sy ) || 1e-6;
			const t = Math.min( 1, Math.max( 0, ( ( x - ax ) * sx + ( y - ay ) * sy ) / ( segment * segment ) ) );
			const width = Math.max( aw + ( bw - aw ) * t, 1e-4 );
			const dx = x - ( ax + sx * t );
			const dy = y - ( ay + sy * t );
			const inside = 1 - Math.hypot( dx, dy ) / width;
			if ( inside > best.inside ) {

				best.inside = inside;
				best.tangentX = sx / segment;
				best.tangentY = sy / segment;
				// 横向偏移：在切向右手边是正
				best.offset = ( dx * sy - dy * sx ) / segment / width;
				best.along = ( travelled + segment * t ) / cypressLengths[ index ];
				best.tongue = index;

			}

			travelled += segment;

		}

	} );
	return best;

}

// TSL 版：只要"在不在柏树里"（0~1，边上软一点），天空底稿的 alpha 用；按粗折线算，半宽收一成（波浪的边由柏树的笔自己盖）
function cypressMaskNode( point ) {

	let mask = float( 0 );
	for ( const tongue of cypressCoarse ) {

		for ( let k = 0; k + 1 < tongue.length; k ++ ) {

			const [ ax, ay, aw ] = tongue[ k ];
			const [ bx, by, bw ] = tongue[ k + 1 ];
			const segment = vec2( bx - ax, by - ay );
			const lengthSquared = Math.max( ( bx - ax ) ** 2 + ( by - ay ) ** 2, 1e-10 );
			const t = dot( point.sub( vec2( ax, ay ) ), segment ).div( lengthSquared ).clamp( 0, 1 );
			const width = max( mix( float( aw ), float( bw ), t ).mul( 0.9 ), 1e-4 );
			const distance = length( point.sub( vec2( ax, ay ).add( segment.mul( t ) ) ) );
			mask = max( mask, float( 1 ).sub( smoothstep( 0.86, 1.0, distance.div( width ) ) ) );

		}

	}

	return mask;

}

// ===================== 全屏的几遍（流场贴图、天空底稿）=====================
// 全屏三角形：uv 的 y = 0 在屏幕上沿（three 读渲染目标按这个约定）。固定的顶点节点：预编译和真画是同一个着色器（见 4b 的坑）
function createFullscreenPass( ctx, name, width, height, targetOptions, colorNode ) {

	const renderer = ctx.renderer;
	const target = new THREE.RenderTarget( width, height, { depthBuffer: false, ...targetOptions } );
	target.texture.name = name;
	target.texture.minFilter = THREE.LinearFilter;
	target.texture.magFilter = THREE.LinearFilter;
	state.disposables.push( target );
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = name;
	material.depthTest = false;
	material.depthWrite = false;
	// 不混合：不透明的普通混合 three 会把 alpha 强制写成 1，天空底稿的 alpha 里存着"让开"的遮罩
	material.blending = THREE.NoBlending;
	material.vertexNode = vec4( positionGeometry.xy, 0, 1 );
	// 直接当输出节点（outputNode），不走 colorNode：NodeMaterial 把普通输出截成 ≥ 0（NodeMaterial.js:537 的 max(0)），
	// 流场的负分量（往左、往下的流）全变成 0，流线只剩往右、往上，横平竖直像电路板，涡根本转不起来
	material.outputNode = colorNode;
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( [ - 1, - 1, 0, 3, - 1, 0, - 1, 3, 0 ], 3 ) );
	geometry.setAttribute( 'uv', new THREE.Float32BufferAttribute( [ 0, 1, 2, 1, 0, - 1 ], 2 ) );
	const mesh = new THREE.Mesh( geometry, material );
	mesh.frustumCulled = false;
	const scene = new THREE.Scene();
	scene.add( mesh );
	const camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
	state.disposables.push( geometry, material );
	return {
		target,
		map: texture( target.texture ),
		render() {

			const previous = renderer.getRenderTarget();
			renderer.setRenderTarget( target );
			renderer.render( scene, camera );
			renderer.setRenderTarget( previous );

		},
		compile: () => ctx.pipeline.compileScene( scene, camera, scene, target ),
	};

}

// 流场贴图：RG16F，存每个天空坐标点的流速（流场单位，没乘笔触速度）。笔触每个顶点都查它，不用每次现算二十几个涡
function createFlowPass( ctx, width, height, flowConfig ) {

	const uniforms = state.uniforms;
	const flowAt = createFlowFunction( flowConfig );
	const colorNode = Fn( () => {

		const coordinate = uv();
		const point = vec2( mix( float( skyDomain.minX ), float( skyDomain.maxX ), coordinate.x ), mix( float( skyDomain.minY ), float( skyDomain.maxY ), coordinate.y ) );
		const phase = uniforms.time.mul( flowConfig.phaseRate ).mul( uniforms.speedScale );
		return vec4( flowAt( point, phase ), 0, 1 );

	} )();
	return createFullscreenPass( ctx, '星月夜·流场', width, height, { type: THREE.HalfFloatType, format: THREE.RGFormat }, colorNode );

}

// 流场贴图在某个天空坐标点的速度（顶点、片元都能用：显式取第 0 级）
function sampleFlow( flowMap, point ) {

	return flowMap.sample( domainCoordinate( point ) ).level( 0 ).xy;

}

// 几个颜色按 t（0~1）分三段线性过渡
function ramp4( t, first, second, third, fourth ) {

	const low = mix( color( first ), color( second ), smoothstep( 0, 1 / 3, t ) );
	const middle = mix( low, color( third ), smoothstep( 1 / 3, 2 / 3, t ) );
	return mix( middle, color( fourth ), smoothstep( 2 / 3, 1, t ) );

}

// 天空底稿：一张天空坐标里的贴图，按原画画大色块，天空的笔按锚点取它的颜色；不在笔触后面的地方（笔缝里）天空球也显示它。
// 层次（从下往上盖）：底色（地平线淡、往上钴蓝、群青、深蓝 + 深浅斑块）→ 卷流 A、B（亮的一缕缕）→ 两个大涡的螺旋带 → 星的光晕 → 月的光晕、月盘。
// 颜色都是原画上取的（规格书 9.1 的配色 + CP3 返工加的三个）；最后乘颜料亮度 paintLevel
function createSkyPass( ctx, width, height ) {

	const uniforms = state.uniforms;
	const colorNode = Fn( () => {

		const coordinate = uv();
		const point = vec2( mix( float( skyDomain.minX ), float( skyDomain.maxX ), coordinate.x ), mix( float( skyDomain.minY ), float( skyDomain.maxY ), coordinate.y ) ).toVar();
		const x = point.x;
		const y = point.y;
		const ultramarine = color( '#1b3a8c' );
		const cobalt = color( '#2c5aa0' );
		const deepBlue = color( '#122a70' );

		// ① 底色：地平线附近淡蓝，往上钴蓝、群青，天顶深蓝
		const base = mix( color( '#4f86c6' ), cobalt, smoothstep( 0.04, 0.3, y ) ).toVar();
		base.assign( mix( base, ultramarine, smoothstep( 0.42, 0.8, y ) ) );
		base.assign( mix( base, deepBlue, smoothstep( 0.85, 1.3, y ).mul( 0.7 ) ) );
		// 深浅斑块：原画大涡左下、柏树右边、左上角那几块很深的群青，也有几块偏亮的钴蓝；横着拉长一点（底流是横的）
		const patch = fbm2D( point.mul( vec2( 2.6, 4.2 ) ).add( vec2( 7.3, 1.9 ) ), 3 );
		base.assign( mix( base, deepBlue.mul( 0.78 ), smoothstep( 0.56, 0.74, patch ).mul( 0.75 ) ) );
		base.assign( mix( base, color( '#3a6db5' ), smoothstep( 0.42, 0.26, patch ).mul( 0.55 ) ) );
		// 一缕一缕的横纹（很淡，笔缝里露出来的底色也不是一片平的）
		const streak = valueNoise2D( point.mul( vec2( 9, 70 ) ) );
		base.mulAssign( streak.sub( 0.5 ).mul( 0.16 ).add( 1 ) );

		// ② 卷流 A：带子里横向 5~6 缕亮暗相间（缕的位置按拉长的噪声抖一抖）；过了大涡顶、进了大涡外圈就淡掉（让给螺旋带）
		const phaseZero = float( 0 );
		const acrossA = y.sub( bandACenterNode( x, phaseZero ) ).div( bandA.width );
		const strandsA = sin( acrossA.mul( 5.5 ).add( valueNoise2D( point.mul( vec2( 6, 30 ) ) ).mul( 3 ) ) ).mul( 0.5 ).add( 0.5 );
		const profileA = float( 1 ).sub( smoothstep( 0.55, 1.05, abs( acrossA ) ) ).mul( float( 1 ).sub( swirlInsideNode( point, bigSwirl ) ) ).mul( float( 1 ).sub( smoothstep( 0.02, 0.12, x ) ) );
		const colorA = mix( color( '#6f9fd2' ), color( '#d5e3ee' ), strandsA );
		base.assign( mix( base, colorA, profileA.mul( 0.9 ) ) );

		// ③ 卷流 B：贴着山脊线那条；小涡右边那段最亮、偏淡黄绿（原画月亮下面那一大片）
		const acrossB = y.sub( bandBCenterNode( x, phaseZero ) ).div( bandBWidthNode( x ) );
		const strandsB = sin( acrossB.mul( 6.5 ).add( valueNoise2D( point.mul( vec2( 5, 26 ) ).add( 3.1 ) ).mul( 3 ) ) ).mul( 0.5 ).add( 0.5 );
		const profileB = float( 1 ).sub( smoothstep( 0.5, 1.05, abs( acrossB ) ) ).mul( float( 1 ).sub( swirlInsideNode( point, smallSwirl ).mul( 0.7 ) ) );
		const warmB = smoothstep( 0.12, 0.45, x );
		const colorB = mix( mix( color( '#86b0da' ), color( '#d9e6ee' ), strandsB ), mix( color( '#c4d6b0' ), color( '#f1ecc6' ), strandsB ), warmB );
		base.assign( mix( base, colorB, profileB.mul( 0.92 ) ) );

		// ④ 两个大涡：细缕 + 宽螺旋。细缕的相位 = 2π × 缕数 × 距离 / 半径 + 手性 × 角度（顺时针手性 −1），沿着流线不变（流场的螺距按它），
		// 所以笔绕着圈走、颜色不跳；宽螺旋的相位一样算、只是圈数少，cos 出一条慢慢盘进去的亮处，φ0 让它在 joinAngle 那里接上卷流。
		// 亮不亮 = 细缕和宽螺旋按 0.55 / 0.45 加起来再加一点噪声（原画的涡近看是细缕、远看亮缕连成一大条）；涡心一团偏亮的淡蓝
		for ( const swirl of greatSwirls ) {

			const offset = point.sub( vec2( swirl.x, swirl.y ) );
			const distance = max( length( offset ), 1e-4 );
			const handedness = Math.sign( swirl.strength );
			const angle = atan( offset.y, offset.x ).mul( handedness );
			const wobble = valueNoise2D( point.mul( 9 ).add( swirl.seed ) ).sub( 0.5 ).mul( 1.1 );
			const strandPhase = distance.div( swirl.radius ).mul( 2 * Math.PI * swirl.strands ).add( angle ).add( wobble );
			const joinPhase = 2 * Math.PI * swirl.armTurns + handedness * swirl.joinAngle;
			const armPhase = distance.div( swirl.radius ).mul( 2 * Math.PI * swirl.armTurns ).add( angle ).sub( joinPhase );
			const strand = valueNoise2D( point.mul( 26 ).add( swirl.seed * 3 ) ).sub( 0.5 ).mul( 0.42 );
			const strandLight = cos( strandPhase ).mul( 0.5 ).add( 0.5 );
			const armLight = cos( armPhase ).mul( 0.5 ).add( 0.5 );
			const lightArm = smoothstep( 0.4, 0.72, strandLight.mul( 0.58 ).add( armLight.mul( 0.42 ) ).add( strand ) );
			const tint = valueNoise2D( point.mul( 7 ).add( swirl.seed ) );
			const lightColor = mix( color( '#a6c8e4' ), color( '#e6eef2' ), tint );
			const darkColor = mix( ultramarine, color( '#2a59a2' ), tint );
			const core = exp( distance.div( swirl.radius * 0.16 ).pow2().negate() );
			const swirlColor = mix( mix( darkColor, lightColor, lightArm ), color( '#c8dcea' ), core.mul( 0.5 ) );
			const inside = float( 1 ).sub( smoothstep( swirl.radius * 0.72, swirl.radius * 1.15, distance ) );
			base.assign( mix( base, swirlColor, inside.mul( uniforms.swirlAmount ) ) );

		}

		// ⑤ S 的接缝弧：卷流 A 顺着大涡外圈盘下来、绕过小涡底下接上卷流 B；和卷流一样是淡蓝白的一缕缕，盖在涡上面
		const arcAcross = connectorAcrossNode( point );
		const arcStrands = sin( arcAcross.mul( 5.5 ).add( valueNoise2D( point.mul( 14 ).add( 5.3 ) ).mul( 3 ) ) ).mul( 0.5 ).add( 0.5 );
		const arcProfile = float( 1 ).sub( smoothstep( 0.55, 1.05, arcAcross ) );
		const arcColor = mix( mix( color( '#78a8d8' ), color( '#dce8ef' ), arcStrands ), mix( color( '#c4d6b0' ), color( '#ece8c4' ), arcStrands ), smoothstep( 0.12, 0.3, x ) );
		base.assign( mix( base, arcColor, arcProfile.mul( 0.92 ).mul( uniforms.swirlAmount ) ) );

		const result = base.mul( uniforms.paintLevel ).toVar();
		const keep = float( 1 ).toVar();
		const pointDirection = skyDirectionNode( point ).toVar();

		// ⑤ 星：星芯（中间橙、外圈柠檬黄，HDR）+ 光晕（一圈圈白黄、淡黄绿相间，往外淡）。星芯一圈天空的笔绕开（alpha 0.5）
		for ( const [ x, y, halo, brightness ] of stars ) {

			const distance = length( pointDirection.sub( vec3( ...skyDirectionJs( x, y ) ) ) );
			const coreRadius = halo * starCoreFraction;
			const rings = cos( distance.div( halo * 0.3 ).mul( 2 * Math.PI ) ).mul( 0.5 ).add( 0.5 );
			const haloColor = mix( color( '#f2ecbe' ), color( '#a9cbd0' ), rings.mul( smoothstep( 0.2, 0.9, distance.div( halo ) ) ) ).mul( float( 1 ).add( float( 1 ).sub( distance.div( halo ) ).clamp( 0, 1 ).mul( 0.35 * brightness ) ) );
			const coreColor = mix( color( '#e99a2c' ), color( '#f7e27a' ), smoothstep( 0, coreRadius, distance ) ).mul( 1.3 + 1.2 * brightness );
			const starColor = mix( haloColor, coreColor, float( 1 ).sub( smoothstep( coreRadius * 0.8, coreRadius * 1.1, distance ) ) );
			const weight = float( 1 ).sub( smoothstep( halo * 0.7, halo * 1.05, distance ) ).mul( uniforms.starAmount );
			result.assign( mix( result, starColor.mul( uniforms.paintLevel ), weight ) );
			keep.assign( min( keep, mix( float( 1 ), float( 0.5 ), float( 1 ).sub( smoothstep( coreRadius * 1.1, coreRadius * 1.5, distance ) ).mul( uniforms.starAmount ) ) ) );

		}

		// ⑥ 月：光晕（淡黄 → 黄白 → 外圈淡蓝白的一圈圈）+ 月盘（淡黄）+ 月牙（饱和橙黄，HDR）。月牙在月亮的切平面里量（东、北），是正圆
		const moonBasis = tangentBasisJs( moon.x, moon.y );
		const moonDelta = pointDirection.sub( vec3( ...skyDirectionJs( moon.x, moon.y ) ) );
		const moonOffset = vec2( dot( moonDelta, vec3( ...moonBasis.east ) ), dot( moonDelta, vec3( ...moonBasis.north ) ) );
		const moonDistance = length( moonOffset );
		const moonRings = cos( moonDistance.div( moon.halo * 0.22 ).mul( 2 * Math.PI ) ).mul( 0.5 ).add( 0.5 );
		const haloOuter = smoothstep( moon.disc, moon.halo, moonDistance );
		const moonHalo = mix( mix( color( '#ecd67e' ), color( '#f2e6a8' ), moonRings ), mix( color( '#dfe0a8' ), color( '#a9c6cc' ), moonRings ), haloOuter ).mul( 1.1 );
		const shadow = length( moonOffset.sub( vec2( crescent.east * moon.disc, crescent.north * moon.disc ) ) );
		const inCrescent = smoothstep( crescent.radius * moon.disc * 0.97, crescent.radius * moon.disc * 1.03, shadow );
		const moonDisc = mix( color( '#efe2a0' ).mul( 1.5 ), color( '#eda52e' ).mul( 2.2 ), inCrescent );
		const moonColor = mix( moonHalo, moonDisc, float( 1 ).sub( smoothstep( moon.disc * 0.97, moon.disc * 1.03, moonDistance ) ) );
		const moonWeight = float( 1 ).sub( smoothstep( moon.halo * 0.85, moon.halo * 1.25, moonDistance ) ).mul( uniforms.moonAmount );
		result.assign( mix( result, moonColor.mul( uniforms.paintLevel ), moonWeight ) );
		keep.assign( min( keep, mix( float( 1 ), float( 0.5 ), float( 1 ).sub( smoothstep( moon.disc * 1.05, moon.disc * 1.25, moonDistance ) ).mul( uniforms.moonAmount ) ) ) );

		// alpha："让开"的码：1 天空、0.5 星芯月盘、0 柏树
		const cypress = cypressMaskNode( point );
		return vec4( result, min( keep, float( 1 ).sub( cypress ) ) );

	} )();
	return createFullscreenPass( ctx, '星月夜·天空底稿', width, height, { type: THREE.HalfFloatType }, colorNode );

}

// ===================== 地面底稿 =====================
// 一台和主相机同位置、同朝向、视场大 guideMargin 倍（正切）的相机，只看第 0 层（远景），画进一张 scale 倍画布大小的图：
// 颜色是远景自己的光照（夜里的月光 + 地点给的补光），alpha 是有没有东西（背景清成 0）。地面的笔按自己在这张图上的位置取颜色、
// 判断是不是地面（alpha > 0.5）；窗灯的笔看那里是不是亮着的暖色。笔触比画面宽一点也取得到颜色（边上那一圈）
const guideMargin = 1.25;

function createGroundGuide( scale ) {

	const target = new THREE.RenderTarget( 4, 4, { type: THREE.HalfFloatType, depthBuffer: true } );
	target.texture.name = '星月夜·地面底稿';
	target.texture.minFilter = THREE.LinearFilter;
	target.texture.magFilter = THREE.LinearFilter;
	target.texture.generateMipmaps = false;
	state.disposables.push( target );
	const camera = new THREE.PerspectiveCamera( 50, 1, 0.1, 2000 );
	camera.layers.set( 0 );
	return {
		target,
		camera,
		scale,
		map: texture( target.texture ),
		viewProjection: uniform( new THREE.Matrix4() ),
		texel: uniform( new THREE.Vector2( 0.25, 0.25 ) ),
		lastPosition: new THREE.Vector3( Infinity, 0, 0 ),
		lastQuaternion: new THREE.Quaternion(),
		lastFov: 0,
		framesSince: 999,
	};

}

// 每帧画主场景之前（pipeline 的 prePass）：镜头动了就重画地面底稿；没动隔 12 帧画一次（窗灯会一闪一闪）
function renderGroundGuide( force = false ) {

	const ctx = state.ctx;
	const guide = state.groundGuide;
	if ( ! ctx || ! guide || ! state.ready ) return;
	const renderer = ctx.renderer;
	const main = ctx.camera;
	main.updateMatrixWorld();
	main.matrixWorld.decompose( tempPosition, tempQuaternion, tempScale );
	guide.framesSince ++;
	// 转了 0.0015 弧度以上（1080p 上约 2 像素）、挪了 5 厘米以上、视场变了才算动
	const turned = 1 - Math.abs( tempQuaternion.dot( guide.lastQuaternion ) ) > 2.8e-7;
	const moved = tempPosition.distanceToSquared( guide.lastPosition ) > 0.0025;
	if ( ! force && ! turned && ! moved && Math.abs( main.fov - guide.lastFov ) < 0.02 && guide.framesSince < 12 ) return;
	guide.framesSince = 0;
	guide.lastPosition.copy( tempPosition );
	guide.lastQuaternion.copy( tempQuaternion );
	guide.lastFov = main.fov;

	renderer.getDrawingBufferSize( drawingSize );
	const width = Math.max( 64, Math.round( drawingSize.x * guide.scale ) );
	const height = Math.max( 36, Math.round( drawingSize.y * guide.scale ) );
	if ( guide.target.width !== width || guide.target.height !== height ) guide.target.setSize( width, height );
	const camera = guide.camera;
	camera.position.copy( tempPosition );
	camera.quaternion.copy( tempQuaternion );
	camera.fov = 2 * Math.atan( Math.tan( main.fov * degree / 2 ) * guideMargin ) / degree;
	camera.aspect = main.aspect;
	camera.near = main.near;
	camera.far = main.far;
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld();
	guide.viewProjection.value.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
	guide.texel.value.set( 1 / width, 1 / height );

	// 自己的笔触、天空球、流星（在第 0 层也挂着，画布蔓延时主相机要看）和引路的花瓣光点先藏起来，背景清成透明
	const hidden = [];
	const guideParticles = ctx.backdrop.getGuide();
	for ( const object of [ ...state.paintObjects, guideParticles ? guideParticles.group : null ] ) {

		if ( object && object.visible ) {

			object.visible = false;
			hidden.push( object );

		}

	}

	const scene = state.scene;
	const background = scene.background;
	scene.background = null;
	renderer.getClearColor( clearColor );
	const clearAlpha = renderer.getClearAlpha();
	renderer.setClearColor( 0x000000, 0 );
	const previous = renderer.getRenderTarget();
	try {

		renderer.setRenderTarget( guide.target );
		renderer.render( scene, camera );

	} finally {

		renderer.setRenderTarget( previous );
		renderer.setClearColor( clearColor, clearAlpha );
		scene.background = background;
		for ( const object of hidden ) object.visible = true;

	}

}

// 方向（局部）→ 地面底稿的贴图坐标；在底稿相机背后的方向 behind = 1
function groundGuideCoordinate( direction ) {

	const clip = state.groundGuide.viewProjection.mul( vec4( direction, 0 ) );
	const ndc = clip.xy.div( max( clip.w, 1e-4 ) );
	return { coordinate: vec2( ndc.x.mul( 0.5 ).add( 0.5 ), float( 0.5 ).sub( ndc.y.mul( 0.5 ) ) ), behind: step( clip.w, 0 ) };

}

// 地面底稿的颜色 → 原画夜里的配色。底稿是远景自己的夜景光照（很暗，地面的亮度大多在 0.004~0.07），按这个范围拉到 0~1；
// 色相看相对颜色（颜色 ÷ 亮度，去掉明暗）：偏绿的（草地、林子）走深蓝绿 → 灰绿；偏暖的（墙、屋顶）暗的是红褐的屋顶、亮的是月光下淡蓝灰的墙
// （原画村子的墙是亮的）；其余（山、湖、阴影）走深群青 → 灰蓝。越远越偏紫蓝、越淡（原画远处的山是一层层的蓝紫）。
// 窗那种又亮又暖的点不走这里（窗灯另有一层笔）
function paintGround( source, distance ) {

	const level = luminance( source ).clamp( 0, 0.2 );
	const tone = smoothstep( 0.003, 0.06, level );
	const relative = source.div( max( level, 1e-4 ) );
	const green = relative.g.sub( max( relative.r, relative.b ) ).mul( 4 ).clamp( 0, 1 );
	const warm = relative.r.sub( relative.b ).mul( 2.5 ).clamp( 0, 1 );
	const night = ramp4( tone, '#15204c', '#2c4688', '#4565b2', '#8aa0d6' );
	const meadow = ramp4( tone, '#12302e', '#235450', '#357a68', '#76a088' );
	const wall = ramp4( tone, '#2a2a4a', '#5a3a3a', '#9aa6c4', '#d6dde8' );
	const painted = mix( night, meadow, green ).toVar();
	painted.assign( mix( painted, wall, warm ) );
	const far = smoothstep( 800, 3000, distance );
	painted.assign( mix( painted, ramp4( tone, '#1c2a64', '#2c3f84', '#4a5ea8', '#8090cc' ), far.mul( 0.8 ) ) );
	const near = float( 1 ).sub( smoothstep( 40, 160, distance ) );
	painted.assign( mix( painted, mix( color( '#0c1c2a' ), color( '#1f4248' ), tone ), near.mul( 0.85 ) ) );
	return painted.mul( state.uniforms.paintLevel );

}

// ===================== 笔触布点（CPU，init 里做）=====================

// Floyd–Steinberg 抖动：weights 是网格上每格的权重（会被改写），误差扩散成 0/1，1 的格子放一笔（权重大的地方密）。
// region 是网格覆盖的天空坐标范围
function ditherPoints( count, weights, columns, rows, random, region ) {

	let total = 0;
	for ( let k = 0; k < weights.length; k ++ ) {

		weights[ k ] = Math.max( 0, weights[ k ] );
		total += weights[ k ];

	}

	if ( total <= 0 ) return [];
	// 按目标笔数缩放（误差扩散后 1 的个数约等于权重总和；单格最多 1 笔）
	const scale = count / total;
	for ( let k = 0; k < weights.length; k ++ ) weights[ k ] = Math.min( 1, weights[ k ] * scale );
	const width = region.maxX - region.minX;
	const height = region.maxY - region.minY;
	const points = [];
	for ( let j = 0; j < rows; j ++ ) {

		for ( let i = 0; i < columns; i ++ ) {

			const index = j * columns + i;
			const old = weights[ index ];
			const chosen = old >= 0.5 ? 1 : 0;
			const error = old - chosen;
			if ( chosen ) points.push( [ region.minX + ( i + random() ) / columns * width, region.minY + ( j + random() ) / rows * height ] );
			// 误差按 7/16、3/16、5/16、1/16 分给右、左下、下、右下
			if ( i + 1 < columns ) weights[ index + 1 ] += error * 7 / 16;
			if ( j + 1 < rows ) {

				if ( i > 0 ) weights[ index + columns - 1 ] += error * 3 / 16;
				weights[ index + columns ] += error * 5 / 16;
				if ( i + 1 < columns ) weights[ index + columns + 1 ] += error / 16;

			}

		}

	}

	return points.slice( 0, count );

}

// 在网格上按 weightAt(x, y) 求权重，分块算（每 32 行让一下主线程）
async function sampleWeights( columns, rows, region, weightAt ) {

	const weights = new Float32Array( columns * rows );
	for ( let j = 0; j < rows; j ++ ) {

		const y = region.minY + ( j + 0.5 ) / rows * ( region.maxY - region.minY );
		for ( let i = 0; i < columns; i ++ ) weights[ j * columns + i ] = weightAt( region.minX + ( i + 0.5 ) / columns * ( region.maxX - region.minX ), y );
		if ( j % 32 === 31 ) await nextTask();

	}

	return weights;

}

// 主画面（默认视角那一块，加上最后抬头看月亮那一块）笔密一些，转头、往上拖才看得到的地方疏一点
function viewDensityJs( x, y ) {

	const main = ( 1 - smoothJs( 0.7, 0.95, Math.abs( x ) ) ) * ( 1 - smoothJs( 0.72, 0.95, y ) );
	const moonView = ( 1 - smoothJs( 0.45, 0.7, Math.hypot( x - moon.x, ( y - moon.y - 0.15 ) * 0.8 ) ) );
	return 0.55 + 0.45 * Math.max( main, moonView );

}

// 地面笔的画面权重：默认画面（左右 ±0.75、仰角 −0.3~0.25）是 1，低头才看得到的近处（仰角 −0.6 以上）0.7，左右再往外、更低 0.3
function groundViewDensityJs( x, y ) {

	const main = ( 1 - smoothJs( 0.7, 1.0, Math.abs( x ) ) ) * smoothJs( - 0.45, - 0.28, y );
	const reachable = ( 1 - smoothJs( 1.1, 1.5, Math.abs( x ) ) ) * smoothJs( - 0.8, - 0.6, y );
	return 0.3 + 0.4 * reachable + 0.3 * main;

}

// 卷流的程度（0~1）
function bandWeightJs( x, y ) {

	const a = Math.exp( - Math.pow( ( y - bandACenterJs( x ) ) / bandA.width, 2 ) ) * ( 1 - swirlInsideJs( x, y, bigSwirl ) ) * ( 1 - smoothJs( 0.02, 0.12, x ) );
	const b = Math.exp( - Math.pow( ( y - bandBCenterJs( x ) ) / bandBWidthJs( x ), 2 ) );
	const arc = x > - 0.2 && x < 0.45 && y > 0.05 && y < 0.62 ? connectorDistanceJs( x, y ) : null;
	const s = arc ? Math.exp( - Math.pow( arc.distance / arc.width, 2 ) ) : 0;
	return Math.max( a, b, s );

}

// 大涡亮带的程度（0~1，和天空底稿同一个相位公式，不带噪声）
function swirlLightArmJs( x, y ) {

	let light = 0;
	for ( const swirl of greatSwirls ) {

		const ox = x - swirl.x;
		const oy = y - swirl.y;
		const distance = Math.hypot( ox, oy );
		if ( distance > swirl.radius * 1.1 ) continue;
		const handedness = Math.sign( swirl.strength );
		const angle = handedness * Math.atan2( oy, ox );
		const strandLight = 0.5 + 0.5 * Math.cos( distance / swirl.radius * 2 * Math.PI * swirl.strands + angle );
		const armLight = 0.5 + 0.5 * Math.cos( distance / swirl.radius * 2 * Math.PI * swirl.armTurns + angle - ( 2 * Math.PI * swirl.armTurns + handedness * swirl.joinAngle ) );
		light = Math.max( light, smoothJs( 0.4, 0.72, strandLight * 0.58 + armLight * 0.42 ) * ( 1 - smoothJs( swirl.radius * 0.72, swirl.radius * 1.15, distance ) ) );

	}

	return light;

}

// 星、月的光晕程度（0~1）和离星芯、月盘多远（"星芯月盘那一圈天空的笔让开"用）
function haloWeightJs( x, y ) {

	let weight = 0;
	for ( const [ cx, cy, halo ] of stars ) {

		if ( Math.abs( x - cx ) > halo * 1.6 || Math.abs( y - cy ) > halo * 1.6 ) continue;
		const distance = sphereDistanceJs( x, y, cx, cy );
		weight = Math.max( weight, 1 - smoothJs( halo * 0.6, halo * 1.15, distance ) );

	}

	if ( Math.abs( x - moon.x ) < moon.halo * 1.5 && Math.abs( y - moon.y ) < moon.halo * 1.5 ) weight = Math.max( weight, 1 - smoothJs( moon.halo * 0.7, moon.halo * 1.2, sphereDistanceJs( x, y, moon.x, moon.y ) ) );
	return weight;

}

function clearanceJs( x, y ) {

	let clearance = 1;
	for ( const [ cx, cy, halo ] of stars ) {

		if ( Math.abs( x - cx ) > halo || Math.abs( y - cy ) > halo ) continue;
		clearance = Math.min( clearance, smoothJs( halo * starCoreFraction * 1.1, halo * starCoreFraction * 1.6, sphereDistanceJs( x, y, cx, cy ) ) );

	}

	if ( Math.abs( x - moon.x ) < moon.halo && Math.abs( y - moon.y ) < moon.halo ) clearance = Math.min( clearance, smoothJs( moon.disc * 1.05, moon.disc * 1.3, sphereDistanceJs( x, y, moon.x, moon.y ) ) );
	return clearance;

}

// 带随机明度的颜色（线性空间）：palette 里按权重挑一个，明度乘 1 ± lightness
function pickColor( random, palette, weights, lightness, target ) {

	let total = 0;
	for ( const weight of weights ) total += weight;
	let pick = random() * total;
	let index = 0;
	for ( ; index < weights.length - 1; index ++ ) {

		pick -= weights[ index ];
		if ( pick <= 0 ) break;

	}

	target.copy( palette[ index ] ).multiplyScalar( 1 + ( random() * 2 - 1 ) * lightness );
	return target;

}

const palette = ( ...hexes ) => hexes.map( ( hex ) => new THREE.Color( hex ) );

// 每笔一条记录：[x, y, 层号, 种子, 宽, 长, 不透明度, 寿命, r, g, b, 取底稿（1 取、0 用 rgb）, 额外 ×4, 排序键]。
// 额外的意思按层分：天空的笔 = (出生点抖动半径, 0, 0, 0)；星环 = (0, 环半径, 初始角, 角速度)；
// 地面的笔 = (锚点局部 x, y, z, 方向角)；柏树 = (摆动幅度, 曲率, 0, 方向角)。宽、长是弧度（1080p 上 1 像素约 0.0008）
function strokeRecord( x, y, layer, seed, width, length, opacity, lifetime, tint, mode, extra, sortKey = 0 ) {

	return [ x, y, layer, seed, width, length, opacity, lifetime, tint.r, tint.g, tint.b, mode, extra[ 0 ], extra[ 1 ], extra[ 2 ], extra[ 3 ], sortKey ];

}

// ① ② ③ 天空的笔（底层、中层、高光）
async function buildSkyStrokes( instances, counts, starryConfig ) {

	const shapes = starryConfig.strokeShapes;
	const life = starryConfig.strokeLife;
	const white = new THREE.Color( 1, 1, 1 );
	const tint = new THREE.Color();

	// ① 底层大笔触：抖动网格铺满天空（地平线下面一点也铺，山脊线上的缝里不露底），不动，顺着流向，颜色取底稿
	{

		const random = createRandom( 4101 );
		const shape = shapes.base;
		const region = { minX: skyDomain.minX, maxX: skyDomain.maxX, minY: - 0.12, maxY: skyDomain.maxY };
		const columns = Math.max( 1, Math.round( Math.sqrt( counts.base * domainWidth / ( region.maxY - region.minY ) ) ) );
		const rows = Math.max( 1, Math.round( counts.base / columns ) );
		for ( let j = 0; j < rows; j ++ ) {

			for ( let i = 0; i < columns; i ++ ) {

				const x = region.minX + ( i + random() ) / columns * domainWidth;
				const y = region.minY + ( j + random() ) / rows * ( region.maxY - region.minY );
				if ( clearanceJs( x, y ) < 0.5 ) continue;
				// 柏树正中（整笔都被柏树盖住）不放
				if ( y < 0.62 && x < - 0.02 && x > - 0.55 && cypressAtJs( x, y ).inside > 0.35 ) continue;
				instances.push( strokeRecord( x, y, layerIndex.base, random(), between( random, shape.width ), between( random, shape.length ), between( random, shape.opacity ), 1, white, 1, [ 0, 0, 0, 0 ] ) );

			}

		}

	}

	await nextTask();
	// 中层流线、高光共用的布点网格（天空坐标，0.006 一格）
	const region = { minX: skyDomain.minX, maxX: skyDomain.maxX, minY: - 0.08, maxY: skyDomain.maxY };
	const columns = 640;
	const rows = 300;
	const cell = domainWidth / columns;

	// ② 中层流线：Floyd–Steinberg，主画面密、两侧疏；涡、卷流、光晕里再密一些；星芯月盘、柏树正中不放
	{

		const random = createRandom( 4202 );
		const shape = shapes.middle;
		const weights = await sampleWeights( columns, rows, region, ( x, y ) => {

			const important = Math.max( swirlMaskJs( x, y ), bandWeightJs( x, y ), haloWeightJs( x, y ) );
			const covered = y < 0.62 && x < - 0.02 && x > - 0.55 ? smoothJs( 0.1, 0.4, cypressAtJs( x, y ).inside ) : 0;
			return viewDensityJs( x, y ) * ( 0.7 + 0.6 * important ) * clearanceJs( x, y ) * ( 1 - covered );

		} );
		for ( const [ x, y ] of ditherPoints( counts.middle, weights, columns, rows, random, region ) ) {

			instances.push( strokeRecord( x, y, layerIndex.middle, random(), between( random, shape.width ), between( random, shape.length ), between( random, shape.opacity ), between( random, life ), white, 1, [ cell * 1.5, 0, 0, 0 ] ) );

		}

	}

	await nextTask();
	// ③ 高光细笔：卷流的亮缕、大涡的亮带、星和月的光晕里；颜色是底稿颜色再提亮（HDR），星月旁边偏暖黄
	{

		const random = createRandom( 4303 );
		const shape = shapes.highlight;
		const weights = await sampleWeights( columns, rows, region, ( x, y ) => {

			const covered = y < 0.62 && x < - 0.02 && x > - 0.55 ? smoothJs( 0.1, 0.4, cypressAtJs( x, y ).inside ) : 0;
			return ( 0.08 + 0.7 * bandWeightJs( x, y ) + 0.8 * swirlLightArmJs( x, y ) + 0.9 * haloWeightJs( x, y ) ) * viewDensityJs( x, y ) * clearanceJs( x, y ) * ( 1 - covered );

		} );
		for ( const [ x, y ] of ditherPoints( counts.highlight, weights, columns, rows, random, region ) ) {

			const warm = haloWeightJs( x, y );
			const intensity = between( random, shape.intensity );
			tint.setRGB( intensity * ( 1 + 0.1 * warm ), intensity * ( 1 + 0.04 * warm ), intensity * ( 1 - 0.25 * warm ) );
			instances.push( strokeRecord( x, y, layerIndex.highlight, random(), between( random, shape.width ), between( random, shape.length ), between( random, shape.opacity ), between( random, life ), tint, 1, [ cell * 1.5, 0, 0, 0 ] ) );

		}

	}

}

// ④ 星环、星芯、月盘、月的光晕：一圈圈切向的短笔。星芯两圈（橙、柠檬黄），光晕由内到外白黄 → 淡黄绿 → 淡蓝白，隔圈正反转；
// 月盘不转，每笔按自己在不在月牙里上色（月牙饱和橙黄、月牙里面那块淡黄）；月的光晕慢慢转
function buildRingStrokes( instances, starryConfig ) {

	const random = createRandom( 4404 );
	const shapes = starryConfig.strokeShapes;
	const shape = shapes.ring;
	const spinRange = starryConfig.flow.ringSpin;
	const paintLevel = starryConfig.paintLevel;
	const tint = new THREE.Color();
	const orange = new THREE.Color( '#e99a2c' );
	const lemon = new THREE.Color( '#f7d84a' );
	const haloColors = palette( '#f6eebb', '#e4ead0', '#a9cbd0' );
	const addRing = ( cx, cy, radius, strokeLength, width, colorAt, intensity, spin ) => {

		// 一圈放多少笔：周长 / (笔长 × 0.45)，前后搭着叠一半多
		const strokeCount = Math.max( 4, Math.ceil( 2 * Math.PI * radius / ( strokeLength * 0.45 ) ) );
		for ( let k = 0; k < strokeCount; k ++ ) {

			const angle = ( k + random() * 0.4 ) / strokeCount * Math.PI * 2;
			const shade = intensity * ( 1 + ( random() * 2 - 1 ) * 0.1 ) * paintLevel;
			colorAt( angle, tint ).multiplyScalar( shade );
			instances.push( strokeRecord( cx, cy, layerIndex.ring, random(), width * ( 0.85 + random() * 0.3 ), strokeLength * ( 0.85 + random() * 0.3 ), between( random, shape.opacity ), 1, tint, 0,
				[ 0, radius * ( 1 + ( random() - 0.5 ) * 0.08 ), angle, spin ] ) );

		}

	};

	for ( const [ x, y, halo, brightness ] of stars ) {

		const core = halo * starCoreFraction;
		// 星芯：里圈橙、外圈柠檬黄，很亮，不转
		addRing( x, y, core * 0.35, Math.max( core * 0.9, 0.006 ), Math.min( shape.width[ 1 ], core * 0.8 ), ( angle, target ) => target.copy( orange ), 1.8 + 1.4 * brightness, 0 );
		addRing( x, y, core * 0.78, Math.max( core * 1.1, 0.008 ), Math.min( shape.width[ 1 ], core * 0.7 ), ( angle, target ) => target.copy( lemon ), 1.5 + 1.0 * brightness, 0 );
		// 光晕：从星芯外一点到光晕边，圈距按光晕大小
		const spacing = Math.max( 0.0058, halo * 0.15 );
		let ring = 0;
		for ( let radius = core * 1.25; radius < halo * 0.98; radius += spacing, ring ++ ) {

			const fraction = ( radius - core ) / Math.max( halo - core, 1e-4 );
			const colorIndex = ring % 2 === 1 && fraction > 0.3 ? 2 : fraction < 0.5 ? 0 : 1;
			const strokeLength = shape.length[ 0 ] + ( shape.length[ 1 ] - shape.length[ 0 ] ) * fraction;
			const spin = between( random, spinRange ) * ( ring % 2 === 0 ? 1 : - 1 );
			addRing( x, y, radius, strokeLength, between( random, shape.width ), ( angle, target ) => target.copy( haloColors[ colorIndex ] ).lerp( haloColors[ Math.min( 2, colorIndex + 1 ) ], random() * 0.4 ),
				( shape.intensity[ 1 ] + ( shape.intensity[ 0 ] - shape.intensity[ 1 ] ) * fraction ) * ( 0.75 + 0.35 * brightness ), spin );

		}

	}

	// 月盘：不转；每笔的中点在不在月牙里（月盘减去往左上偏的圆，在月亮的切平面里量，和天空底稿一致）决定颜色
	const crescentColor = new THREE.Color( '#eda52e' );
	const discColor = new THREE.Color( '#efe2a0' );
	for ( let radius = moon.disc * 0.14; radius < moon.disc * 0.97; radius += 0.0058 ) {

		addRing( moon.x, moon.y, radius, Math.min( 0.02, Math.max( 0.008, radius * 0.9 ) ), shape.width[ 1 ], ( angle, target ) => {

			// 这一笔在月亮切平面里的位置（东、北）
			const east = Math.cos( angle ) * radius;
			const north = Math.sin( angle ) * radius;
			const inside = Math.hypot( east - crescent.east * moon.disc, north - crescent.north * moon.disc ) > crescent.radius * moon.disc;
			return target.copy( inside ? crescentColor : discColor );

		}, 2.0, 0 );

	}

	// 月的光晕：一圈圈淡黄 → 黄白 → 淡蓝白，慢慢转
	const moonHalo = palette( '#ecd67e', '#f2e6a8', '#a9c6cc' );
	let ring = 0;
	for ( let radius = moon.disc * 1.1; radius < moon.halo * 1.05; radius += 0.0075, ring ++ ) {

		const fraction = ( radius - moon.disc ) / ( moon.halo - moon.disc );
		const colorIndex = fraction > 0.75 && ring % 2 === 1 ? 2 : fraction < 0.5 ? 0 : 1;
		const spin = between( random, spinRange ) * 0.6 * ( ring % 2 === 0 ? 1 : - 1 );
		addRing( moon.x, moon.y, radius, shape.length[ 1 ], shape.width[ 1 ] * 1.1, ( angle, target ) => target.copy( moonHalo[ colorIndex ] ), 1.6 - 0.6 * fraction, spin );

	}


}

// ⑤ 流光：卷流和星晕里的小亮点，带拖影，加法混合；比笔触快 particleSpeed 倍
function buildParticleStrokes( instances, counts, starryConfig ) {

	const random = createRandom( 4505 );
	const shape = starryConfig.strokeShapes.particle;
	const life = starryConfig.strokeLife;
	const colors = palette( '#f7e27a', '#ffffff', '#cfeff0' );
	const tint = new THREE.Color();
	let placed = 0;
	let attempts = 0;
	while ( placed < counts.particle && attempts < counts.particle * 400 ) {

		attempts ++;
		const x = skyDomain.minX + random() * domainWidth;
		const y = 0.04 + random() * 1.0;
		const weight = Math.min( 1, bandWeightJs( x, y ) * 0.9 + haloWeightJs( x, y ) * 0.8 + swirlLightArmJs( x, y ) * 0.3 ) * clearanceJs( x, y );
		if ( random() > weight ) continue;
		placed ++;
		pickColor( random, colors, [ 1, 0.6, 0.5 ], 0.1, tint );
		tint.multiplyScalar( between( random, shape.intensity ) * starryConfig.paintLevel );
		const width = between( random, shape.width );
		instances.push( strokeRecord( x, y, layerIndex.particle, random(), width, width * ( 1 + between( random, shape.trail ) ), 1, between( random, life ), tint, 0, [ 0.02, 0, 0, 0 ] ) );

	}

}

// 从眼睛沿 direction（世界坐标，单位向量）往外走，找第一次钻到远景地形下面的地方：步长随距离变大（2%），找到后二分细化。
// 往上走、已经高过所有山（1600 米）就算打到天上；maxDistance 以内没打到返回 null
function marchTerrain( backdrop, eye, direction, maxDistance ) {

	let previous = 0;
	let distance = 0.5;
	while ( distance <= maxDistance ) {

		const height = eye.y + direction.y * distance;
		if ( direction.y > 0 && height > 1600 ) return null;
		const ground = backdrop.getTerrainHeight( eye.x + direction.x * distance, eye.z + direction.z * distance );
		if ( height <= ground ) {

			let low = previous;
			let high = distance;
			for ( let k = 0; k < 10; k ++ ) {

				const middle = ( low + high ) / 2;
				const middleGround = backdrop.getTerrainHeight( eye.x + direction.x * middle, eye.z + direction.z * middle );
				if ( eye.y + direction.y * middle <= middleGround ) high = middle;
				else low = middle;

			}

			return high;

		}

		previous = distance;
		distance += Math.max( 0.75, distance * 0.02 );

	}

	return null;

}

// ⑥ ⑦ ⑧ 地面的笔、细笔、窗灯：钉在地形上（锚点 = 从出生点的眼睛沿这个方向打到远景地形的那一点，局部坐标），
// 镜头不动时就在这个方向上，镜头动了（画布蔓延时还在往出生点滑）按透视跟着地形走，大小按离锚点的远近缩放。
// 颜色、是不是地面每帧看地面底稿。方向：打到的地方顺着等高线（地形梯度转 90°），陡坡上三成顺着坡往下；
// 太远（没打到）的平着、微微起伏。由远到近排好（近的后画，盖住远的）
async function buildGroundStrokes( instances, counts, starryConfig ) {

	const ctx = state.ctx;
	const world = ctx.world;
	const backdrop = ctx.backdrop;
	const shapes = starryConfig.strokeShapes;
	const spawn = getSpawn();
	const eyeLocal = new THREE.Vector3().fromArray( spawn.position );
	const eyeWorld = world.toWorld( eyeLocal.clone(), key, new THREE.Vector3() );
	const localDirection = new THREE.Vector3();
	const worldDirection = new THREE.Vector3();
	const hitWorld = new THREE.Vector3();
	const hitLocal = new THREE.Vector3();
	const tangentWorld = new THREE.Vector3();
	const tangentLocal = new THREE.Vector3();
	const white = new THREE.Color( 1, 1, 1 );
	const region = { minX: skyDomain.minX, maxX: skyDomain.maxX, minY: - 0.95, maxY: 0.32 };
	const maxDistance = 7000;
	const farDistance = 6000;
	let rays = 0;

	const placeStroke = ( x, y, layer, shape, random, sizeScale, lengthScale = sizeScale ) => {

		localSkyDirection( x, y, localDirection );
		world.directionToWorld( localDirection, key, worldDirection ).normalize();
		const hit = marchTerrain( backdrop, eyeWorld, worldDirection, maxDistance );
		rays ++;
		// 天上（没打到，又在高处）：不放
		if ( hit === null && y > 0.02 ) {

			// 没打到也可能是很远的山（7 千米外），留一部分，底稿说那里是地面才画
			if ( random() > 0.35 ) return;

		}

		const distance = hit === null ? farDistance : hit;
		hitWorld.copy( eyeWorld ).addScaledVector( worldDirection, distance );
		world.toLocal( hitWorld, key, hitLocal );
		let angle = 0;
		if ( hit !== null && distance < 4500 ) {

			// 地形梯度（世界坐标，中心差分 2 米）：等高线方向 = 梯度转 90°（水平），顺坡方向 = 往下坡
			const step = Math.max( 2, distance * 0.004 );
			const gradientX = ( backdrop.getTerrainHeight( hitWorld.x + step, hitWorld.z ) - backdrop.getTerrainHeight( hitWorld.x - step, hitWorld.z ) ) / ( 2 * step );
			const gradientZ = ( backdrop.getTerrainHeight( hitWorld.x, hitWorld.z + step ) - backdrop.getTerrainHeight( hitWorld.x, hitWorld.z - step ) ) / ( 2 * step );
			const steepness = Math.hypot( gradientX, gradientZ );
			const downhill = random() < 0.3 * smoothJs( 0.25, 0.9, steepness );
			if ( downhill && steepness > 1e-4 ) tangentWorld.set( - gradientX, - steepness * steepness, - gradientZ ).normalize();
			else if ( steepness > 1e-4 ) tangentWorld.set( - gradientZ, 0, gradientX ).normalize();
			else tangentWorld.set( worldDirection.z, 0, - worldDirection.x ).normalize();
			world.directionToLocal( tangentWorld, key, tangentLocal );
			// 投到天空坐标：锚点和沿切向挪一点的点各自的天空坐标，连起来的方向
			const ahead = distance * 0.02;
			const [ x0, y0 ] = directionToSkyJs( hitLocal.x - eyeLocal.x, hitLocal.y - eyeLocal.y, hitLocal.z - eyeLocal.z );
			const [ x1, y1 ] = directionToSkyJs( hitLocal.x + tangentLocal.x * ahead - eyeLocal.x, hitLocal.y + tangentLocal.y * ahead - eyeLocal.y, hitLocal.z + tangentLocal.z * ahead - eyeLocal.z );
			angle = Math.atan2( y1 - y0, x1 - x0 );

		} else {

			angle = 0.18 * Math.sin( x * 9 + jsValueNoise2D( x * 6, y * 6 ) * 4 );

		}

		// 笔的方向不分正反：统一成朝右的那一半，再抖 ±0.25
		if ( Math.cos( angle ) < 0 ) angle += Math.PI;
		angle += ( random() - 0.5 ) * 0.5;
		instances.push( strokeRecord( x, y, layer, random(), between( random, shape.width ) * sizeScale, between( random, shape.length ) * lengthScale, between( random, shape.opacity ), 1, white, 1,
			[ hitLocal.x, hitLocal.y, hitLocal.z, angle ], distance - ( layer === layerIndex.groundDetail ? 25 : 0 ) ) );

	};

	// 底层的地面笔：Floyd–Steinberg 按画面权重布点（默认画面那一块最密，转头、低头才看得到的地方疏），柏树正中不放；
	// 画面下沿（近处）的笔大一些（原画前景的笔比远处的大）
	{

		const random = createRandom( 6101 );
		const shape = shapes.ground;
		const columns = 520;
		const rows = 180;
		const weights = await sampleWeights( columns, rows, region, ( x, y ) => {

			const covered = x < - 0.02 && x > - 0.6 ? smoothJs( 0.3, 0.6, cypressAtJs( x, y ).inside ) : 0;
			return groundViewDensityJs( x, y ) * ( 1 - covered );

		} );
		const points = ditherPoints( counts.ground, weights, columns, rows, random, region );
		for ( let k = 0; k < points.length; k ++ ) {

			const [ x, y ] = points[ k ];
			// 近处（低头才看得到）笔宽 1.35 倍、长再翻到 2.2 倍左右：原画前景的山坡是顺坡势拉开的长笔，短笔铺满会像迷彩
			const near = smoothJs( - 0.1, - 0.5, y );
			placeStroke( x, y, layerIndex.ground, shape, random, 1 + 0.35 * near, ( 1 + 0.35 * near ) * ( 1 + 0.65 * smoothJs( - 0.3, - 0.6, y ) ) );
			if ( k % 500 === 499 ) await nextTask();

		}

	}

	// 细笔：小镇、湖、城堡那一片（默认画面下半）密，别处疏
	{

		const random = createRandom( 6202 );
		const shape = shapes.groundDetail;
		const columns = 480;
		const rows = 160;
		const weights = await sampleWeights( columns, rows, region, ( x, y ) => {

			const town = ( 1 - smoothJs( 0.5, 0.85, Math.abs( x ) ) ) * ( 1 - smoothJs( 0.08, 0.16, y ) ) * smoothJs( - 0.5, - 0.3, y );
			const covered = x < - 0.02 && x > - 0.6 ? smoothJs( 0.2, 0.5, cypressAtJs( x, y ).inside ) : 0;
			return ( 0.15 + 0.85 * town ) * groundViewDensityJs( x, y ) * ( 1 - covered );

		} );
		const points = ditherPoints( counts.groundDetail, weights, columns, rows, random, region );
		for ( let k = 0; k < points.length; k ++ ) {

			placeStroke( points[ k ][ 0 ], points[ k ][ 1 ], layerIndex.groundDetail, shape, random, 1 );
			if ( k % 400 === 399 ) await nextTask();

		}

	}

	buildHouseStrokes( instances, starryConfig, eyeWorld, eyeLocal );

	// 窗灯：小镇、城堡替身的窗（远景窗灯那一份），朝着出生点的才放；底稿里那扇窗亮着才画
	{

		const random = createRandom( 6303 );
		const shape = shapes.window;
		const warmColors = palette( '#ffc061', '#ffd88a', '#ff9c4a' );
		const tint = new THREE.Color();
		for ( const locationKey of [ key, 'gothic' ] ) {

			for ( const item of backdrop.getWindows( locationKey ) ) {

				const toEyeX = eyeWorld.x - item.x;
				const toEyeZ = eyeWorld.z - item.z;
				const toEyeLength = Math.hypot( toEyeX, toEyeZ ) || 1;
				if ( ( toEyeX * item.normalX + toEyeZ * item.normalZ ) / toEyeLength < 0.12 ) continue;
				hitWorld.set( item.x + item.normalX * 0.3, item.y, item.z + item.normalZ * 0.3 );
				world.toLocal( hitWorld, key, hitLocal );
				const [ x, y ] = directionToSkyJs( hitLocal.x - eyeLocal.x, hitLocal.y - eyeLocal.y, hitLocal.z - eyeLocal.z );
				pickColor( random, warmColors, [ 1, 0.5, 0.4 ], 0.1, tint );
				tint.multiplyScalar( shape.intensity * starryConfig.paintLevel );
				instances.push( strokeRecord( x, y, layerIndex.window, random(), shape.width * ( 0.8 + random() * 0.4 ), shape.length * ( 0.8 + random() * 0.4 ), 1, 1, tint, 0,
					[ hitLocal.x, hitLocal.y, hitLocal.z, Math.PI / 2 + ( random() - 0.5 ) * 0.3 ], 0 ) );

			}

		}

	}

	return rays;

}

// 小镇的房子按面画（远景 getTownHouses 的尺寸表）：每栋房子朝着机位的墙、屋顶坡面上一行行顺着屋檐的横笔（墙是月光下的淡蓝灰，
// 屋顶按原来的瓦色换成原画的红褐 / 深蓝），钟楼的墙是竖笔，尖顶从底边往尖上画；再沿每个看得到的面的边勾一圈深蓝的细线。
// 笔都钉在房子的面上（局部坐标），归在地面细笔那一层（tint.w = 0，用自己的颜色），按离机位的远近和地面的笔一起排
function buildHouseStrokes( instances, starryConfig, eyeWorld, eyeLocal ) {

	const ctx = state.ctx;
	const world = ctx.world;
	const backdrop = ctx.backdrop;
	if ( typeof backdrop.getTownHouses !== 'function' ) {

		console.warn( '星空场景：远景没有 getTownHouses，小镇的房子不单独画' );
		return;

	}

	const random = createRandom( 6404 );
	const paintLevel = starryConfig.paintLevel;
	const moonWorld = ctx.world.uniforms.moonDirection.value;
	const tint = new THREE.Color();
	const local = new THREE.Vector3();
	const outline = new THREE.Color( '#0b1430' );
	const wallLight = new THREE.Color( '#c8d2e2' );
	// 原来的瓦色 → 原画里的屋顶色
	const roofColors = { '#6e3b2e': '#4a3a48', '#5a3a30': '#2e3560', '#4a4f63': '#253260', '#7a4a35': '#584650', '#3c4256': '#232c4c' };
	// 世界坐标的点 → [天空坐标 x, y, 离眼睛多远, 局部坐标的点]
	const skyOf = ( point ) => {

		world.toLocal( point, key, local );
		const [ x, y ] = directionToSkyJs( local.x - eyeLocal.x, local.y - eyeLocal.y, local.z - eyeLocal.z );
		return { x, y, distance: Math.hypot( point.x - eyeWorld.x, point.y - eyeWorld.y, point.z - eyeWorld.z ), local: local.clone() };

	};
	const push = ( point, angle, width, length, color, sortBias ) => {

		const at = skyOf( point );
		tint.copy( color ).multiplyScalar( paintLevel );
		instances.push( strokeRecord( at.x, at.y, layerIndex.groundDetail, random(), width, length, 0.95 + random() * 0.05, 1, tint, 0,
			[ at.local.x, at.local.y, at.local.z, angle ], at.distance - sortBias ) );

	};
	const lerp3 = ( a, b, t ) => a.clone().lerp( b, t );
	// 一个四边形面（a 左下、b 右下、c 右上、d 左上，世界坐标）：笔顺着 a→b（vertical 时顺着 a→d），一行行排满；color 是这个面的颜色
	const fillQuad = ( a, b, c, d, color, vertical ) => {

		const skyA = skyOf( a );
		const skyB = skyOf( b );
		const skyD = skyOf( d );
		const acrossRad = Math.hypot( skyB.x - skyA.x, skyB.y - skyA.y );
		const upRad = Math.hypot( skyD.x - skyA.x, skyD.y - skyA.y );
		const alongRad = vertical ? upRad : acrossRad;
		const stackRad = vertical ? acrossRad : upRad;
		if ( alongRad < 0.002 || stackRad < 0.0015 ) return;
		const rows = Math.min( 6, Math.max( 1, Math.round( stackRad / 0.0045 ) ) );
		const columns = Math.min( 5, Math.max( 1, Math.round( alongRad / 0.018 ) ) );
		const angle = vertical ? Math.atan2( skyD.y - skyA.y, skyD.x - skyA.x ) : Math.atan2( skyB.y - skyA.y, skyB.x - skyA.x );
		for ( let row = 0; row < rows; row ++ ) {

			for ( let column = 0; column < columns; column ++ ) {

				const along = ( column + 0.5 + ( random() - 0.5 ) * 0.3 ) / columns;
				const stack = ( row + 0.5 ) / rows;
				const s = vertical ? stack : along;
				const t = vertical ? along : stack;
				const point = lerp3( lerp3( a, b, s ), lerp3( d, c, s ), t );
				const shade = 1 + ( random() - 0.5 ) * 0.18;
				push( point, angle + ( random() - 0.5 ) * 0.08, Math.min( 0.009, Math.max( 0.0025, stackRad / rows * 1.35 ) ), alongRad / columns * 1.25, tint.copy( color ).multiplyScalar( shade ).clone(), 1 );

			}

		}

	};
	// 沿一条边（世界坐标 a → b）勾深蓝的细线，每段不超过 0.02 弧度
	const outlineEdge = ( a, b ) => {

		const skyA = skyOf( a );
		const skyB = skyOf( b );
		const lengthRad = Math.hypot( skyB.x - skyA.x, skyB.y - skyA.y );
		if ( lengthRad < 0.002 ) return;
		const pieces = Math.max( 1, Math.ceil( lengthRad / 0.02 ) );
		const angle = Math.atan2( skyB.y - skyA.y, skyB.x - skyA.x );
		for ( let k = 0; k < pieces; k ++ ) push( lerp3( a, b, ( k + 0.5 ) / pieces ), angle, 0.0018 + random() * 0.0006, lengthRad / pieces * 1.15, outline, 0.5 );

	};
	// 面朝着眼睛（法线点乘"面中心 → 眼睛"大于 0）才画
	const facing = ( normal, center ) => normal.dot( eyeWorld.clone().sub( center ) ) > 0;
	// 面的亮度：朝月亮的亮（原画村子的墙在月光里是亮的），背着的暗一些
	const lightOf = ( normal ) => 0.62 + 0.38 * Math.max( 0, normal.dot( moonWorld ) ) + 0.12 * Math.max( 0, normal.y );

	for ( const house of backdrop.getTownHouses() ) {

		const cosine = Math.cos( house.yaw );
		const sine = Math.sin( house.yaw );
		const axisX = new THREE.Vector3( cosine, 0, - sine );
		const axisZ = new THREE.Vector3( sine, 0, cosine );
		const at = ( localX, height, localZ ) => new THREE.Vector3( house.x, house.base + height, house.z ).addScaledVector( axisX, localX ).addScaledVector( axisZ, localZ );
		const halfWidth = house.width / 2;
		const halfDepth = house.depth / 2;
		const top = house.wallHeight;
		const wallColor = new THREE.Color( house.wall ).lerp( wallLight, 0.6 );
		const roofColor = new THREE.Color( roofColors[ house.roof ] || house.roof );
		// 四面墙：[左下, 右下, 法线]（从外面看，左下 → 右下）
		const walls = [
			[ at( halfWidth, 0, halfDepth ), at( halfWidth, 0, - halfDepth ), axisX ],
			[ at( - halfWidth, 0, - halfDepth ), at( - halfWidth, 0, halfDepth ), axisX.clone().negate() ],
			[ at( - halfWidth, 0, halfDepth ), at( halfWidth, 0, halfDepth ), axisZ ],
			[ at( halfWidth, 0, - halfDepth ), at( - halfWidth, 0, - halfDepth ), axisZ.clone().negate() ],
		];
		for ( const [ bottomLeft, bottomRight, normal ] of walls ) {

			const center = bottomLeft.clone().add( bottomRight ).multiplyScalar( 0.5 ).setY( house.base + top / 2 );
			if ( ! facing( normal, center ) ) continue;
			const topLeft = bottomLeft.clone().setY( house.base + top );
			const topRight = bottomRight.clone().setY( house.base + top );
			fillQuad( bottomLeft, bottomRight, topRight, topLeft, wallColor.clone().multiplyScalar( lightOf( normal ) ), house.kind === 'tower' );
			outlineEdge( bottomLeft, topLeft );
			outlineEdge( bottomRight, topRight );
			outlineEdge( topLeft, topRight );

		}

		if ( house.kind === 'house' ) {

			// 两个屋顶坡面：屋檐在 ±(进深 + 0.8)/2，屋脊在正中高 roofHeight；屋脊沿本地 x
			const halfLength = house.roofLength / 2;
			const halfSpan = house.roofWidth / 2;
			for ( const side of [ - 1, 1 ] ) {

				const eaveLeft = at( - halfLength * side, top, halfSpan * side );
				const eaveRight = at( halfLength * side, top, halfSpan * side );
				const ridgeRight = at( halfLength * side, top + house.roofHeight, 0 );
				const ridgeLeft = at( - halfLength * side, top + house.roofHeight, 0 );
				const normal = axisZ.clone().multiplyScalar( side * house.roofHeight ).add( new THREE.Vector3( 0, halfSpan, 0 ) ).normalize();
				const center = eaveLeft.clone().add( eaveRight ).add( ridgeLeft ).add( ridgeRight ).multiplyScalar( 0.25 );
				if ( ! facing( normal, center ) ) continue;
				fillQuad( eaveLeft, eaveRight, ridgeRight, ridgeLeft, roofColor.clone().multiplyScalar( 0.6 + 0.3 * lightOf( normal ) ), false );
				outlineEdge( eaveLeft, eaveRight );
				outlineEdge( ridgeLeft, ridgeRight );

			}

			// 两头的山墙三角（和屋顶一个颜色）：只勾两条斜边
			for ( const side of [ - 1, 1 ] ) {

				const normal = axisX.clone().multiplyScalar( side );
				const apex = at( halfLength * side, top + house.roofHeight, 0 );
				if ( ! facing( normal, apex ) ) continue;
				outlineEdge( at( halfLength * side, top, - halfSpan ), apex );
				outlineEdge( at( halfLength * side, top, halfSpan ), apex );

			}

		} else if ( house.kind === 'tower' ) {

			// 尖顶：四棱锥，底的四个角在塔的四个角的方向上（外接圆半径 spireRadius），尖在塔顶上 spireHeight；每个面从底边往尖上画竖笔
			const apex = at( 0, top + house.spireHeight, 0 );
			const radius = house.spireRadius / Math.SQRT2;
			const corners = [ at( radius, top, radius ), at( radius, top, - radius ), at( - radius, top, - radius ), at( - radius, top, radius ) ];
			for ( let k = 0; k < 4; k ++ ) {

				const left = corners[ k ];
				const right = corners[ ( k + 1 ) % 4 ];
				const middle = left.clone().add( right ).multiplyScalar( 0.5 );
				const outward = middle.clone().sub( at( 0, top, 0 ) ).setY( 0 ).normalize();
				const normal = outward.multiplyScalar( house.spireHeight ).add( new THREE.Vector3( 0, radius, 0 ) ).normalize();
				const center = middle.clone().lerp( apex, 0.33 );
				if ( ! facing( normal, center ) ) continue;
				const strokes = 3;
				for ( let s = 0; s < strokes; s ++ ) {

					const foot = left.clone().lerp( right, ( s + 0.5 ) / strokes );
					const skyFoot = skyOf( foot );
					const skyApex = skyOf( apex );
					const lengthRad = Math.hypot( skyApex.x - skyFoot.x, skyApex.y - skyFoot.y );
					push( foot.clone().lerp( apex, 0.42 ), Math.atan2( skyApex.y - skyFoot.y, skyApex.x - skyFoot.x ), 0.004, lengthRad * 0.85, roofColor.clone().multiplyScalar( 0.7 + 0.5 * lightOf( normal ) ), 1 );

				}

				outlineEdge( left, apex );
				outlineEdge( right, apex );

			}

		}

	}

}

// ⑨ ⑩ 柏树：在柏树的包围盒里撒抖动网格，留下在火舌里的；方向顺着所在火舌的中线往上，按横向偏移往两边张一点（火苗往上舔的样子），
// 再带一点弯。颜色墨绿、暗绿为主，少量暗蓝绿、橄榄绿，越靠边越暗。勾线：沿每道火舌的两条边、中间几条火苗线，赭褐的细长笔
function buildCypressStrokes( instances, counts, starryConfig ) {

	const shapes = starryConfig.strokeShapes;
	const sway = starryConfig.cypressSway;
	const tint = new THREE.Color();
	let minX = Infinity;
	let maxX = - Infinity;
	let minY = Infinity;
	let maxY = - Infinity;
	for ( const tongue of cypressShape ) {

		for ( const [ x, y, width ] of tongue ) {

			minX = Math.min( minX, x - width );
			maxX = Math.max( maxX, x + width );
			minY = Math.min( minY, y );
			maxY = Math.max( maxY, y );

		}

	}

	minY = Math.max( minY, - 1.0 );
	{

		const random = createRandom( 8801 );
		const shape = shapes.cypress;
		const greens = palette( '#0f1a14', '#142318', '#1a2d1f', '#213a27', '#1b2f2a', '#2a4430', '#3d5c34', '#283d4a' );
		// 包围盒里大约四成在柏树里：按这个估格子大小
		const cell = Math.sqrt( ( maxX - minX ) * ( maxY - minY ) * 0.4 / counts.cypress );
		for ( let y = minY; y < maxY; y += cell ) {

			for ( let x = minX; x < maxX; x += cell ) {

				const px = x + random() * cell;
				const py = y + random() * cell;
				const at = cypressAtJs( px, py );
				if ( at.inside < 0.15 ) continue;
				const angle = Math.atan2( at.tangentY, at.tangentX ) + at.offset * 0.12 + ( random() - 0.5 ) * 0.22;
				const curvature = ( random() - 0.5 ) * 8 - at.offset * 3;
				// 亮一点的墨绿、橄榄、暗蓝绿多一些（审查 R47：原来几乎是纯黑的剪影，看不出火焰一样的笔触层次）
				pickColor( random, greens, [ 0.6, 0.9, 1.1, 1.1, 0.9, 0.9, 0.45, 0.5 ], 0.15, tint );
				tint.multiplyScalar( ( 0.85 + 0.45 * Math.min( 1, at.inside * 2 ) ) * starryConfig.paintLevel );
				const edgeShorten = 0.45 + 0.55 * smoothJs( 0.15, 0.5, at.inside );
				instances.push( strokeRecord( px, py, layerIndex.cypress, random(), between( random, shape.width ), between( random, shape.length ) * edgeShorten, between( random, shape.opacity ), 1, tint, 0,
					[ sway * smoothJs( - 0.2, 0.6, py ), curvature, 0, angle ] ) );

			}

		}

	}

	{

		const random = createRandom( 8902 );
		const shape = shapes.cypressLine;
		const browns = palette( '#3a2a14', '#50391a', '#6b4c22', '#7d5e2c' );
		const lines = [];
		cypressShape.forEach( ( tongue ) => {

			for ( let k = 0; k + 1 < tongue.length; k ++ ) {

				const [ ax, ay, aw ] = tongue[ k ];
				const [ bx, by, bw ] = tongue[ k + 1 ];
				const segment = Math.hypot( bx - ax, by - ay );
				const steps = Math.max( 1, Math.round( segment / 0.035 ) );
				for ( let s = 0; s < steps; s ++ ) {

					const t = ( s + random() ) / steps;
					const x = ax + ( bx - ax ) * t;
					const y = ay + ( by - ay ) * t;
					const width = aw + ( bw - aw ) * t;
					const tangentX = ( bx - ax ) / segment;
					const tangentY = ( by - ay ) / segment;
					// 两条边（往里收一点，线不支到外面）+ 偶尔一条中间的火苗线
					for ( const offset of [ - 0.8, 0.8, ( random() - 0.5 ) * 0.8 ] ) {

						if ( Math.abs( offset ) < 0.5 && random() < 0.75 ) continue;
						lines.push( [ x + tangentY * offset * width, y - tangentX * offset * width, Math.atan2( tangentY, tangentX ) - offset * 0.06 ] );

					}

				}

			}

		} );
		// 线太多就随机挑
		for ( let k = lines.length - 1; k > 0; k -- ) {

			const pick = Math.floor( random() * ( k + 1 ) );
			[ lines[ k ], lines[ pick ] ] = [ lines[ pick ], lines[ k ] ];

		}

		for ( const [ x, y, angle ] of lines.slice( 0, counts.cypressLine ) ) {

			pickColor( random, browns, [ 1.4, 1.2, 0.6, 0.25 ], 0.12, tint );
			tint.multiplyScalar( 0.45 * starryConfig.paintLevel );
			instances.push( strokeRecord( x, y, layerIndex.cypressLine, random(), between( random, shape.width ), between( random, shape.length ), between( random, shape.opacity ), 1, tint, 0,
				[ sway * smoothJs( - 0.2, 0.6, y ), ( random() - 0.5 ) * 8, 0, angle + ( random() - 0.5 ) * 0.15 ] ) );

		}

	}

}

async function buildStrokeInstances( counts, starryConfig ) {

	const instances = [];
	await buildSkyStrokes( instances, counts, starryConfig );
	await nextTask();
	buildRingStrokes( instances, starryConfig );
	buildParticleStrokes( instances, counts, starryConfig );
	await nextTask();
	const rays = await buildGroundStrokes( instances, counts, starryConfig );
	await nextTask();
	buildCypressStrokes( instances, counts, starryConfig );
	await nextTask();

	// 先按层号排（天空 → 星环 → 流光 → 地面 → 窗灯 → 柏树 → 勾线）；地面的两层（底层、细笔）合在一起由远到近排
	const groupOf = ( layer ) => ( layer === layerIndex.groundDetail ? layerIndex.ground : layer );
	instances.sort( ( first, second ) => {

		const group = groupOf( first[ 2 ] ) - groupOf( second[ 2 ] );
		if ( group !== 0 ) return group;
		return groupOf( first[ 2 ] ) === layerIndex.ground ? second[ 16 ] - first[ 16 ] : 0;

	} );
	await nextTask();
	const total = instances.length;
	const place = new Float32Array( total * 4 );
	const shape = new Float32Array( total * 4 );
	const tint = new Float32Array( total * 4 );
	const extra = new Float32Array( total * 4 );
	const placed = new Array( 10 ).fill( 0 );
	// 拆成四个实例属性；每 15000 笔让一下主线程（七万多笔一口气拆完约 50 毫秒，预加载时会卡一下画面）
	for ( let index = 0; index < total; index ++ ) {

		const item = instances[ index ];
		for ( let k = 0; k < 4; k ++ ) {

			place[ index * 4 + k ] = item[ k ];
			shape[ index * 4 + k ] = item[ 4 + k ];
			tint[ index * 4 + k ] = item[ 8 + k ];
			extra[ index * 4 + k ] = item[ 12 + k ];

		}

		placed[ item[ 2 ] ] ++;
		if ( index % 15000 === 14999 ) await nextTask();

	}
	return { total, place, shape, tint, extra, placed, rays };

}

// ===================== 笔触实例层（一个 InstancedMesh、一个材质，10 层）=====================
// 顶点里按层分四路算这一笔的中心、方向、曲率、大小、颜色、透明度（If 分支，实例按层排好，同一批顶点走同一路）：
//   天空的笔（底层、中层、高光、流光）：沿流线 RK2 积分（底层不动），方向取流向，曲率取流线的弯；颜色取天空底稿在锚点的颜色（每笔一种颜色），
//     再按种子分深、亮两种变体（两成深、两成亮，原画相邻的笔深浅跳得很开）；锚点在地面底稿里是地面就不画（山后面不留天空的笔）；
//   星环：绕着星转；地面的笔：从镜头看锚点的方向，取地面底稿的颜色换配色，不是地面就不画；细笔在底稿亮度变化大的地方顺着边走，三成勾成深蓝的轮廓线；
//   窗灯：底稿那里是亮的暖色才画；柏树：天空坐标里的点，按高度左右轻轻摆。
// 然后按曲率把笔弯成一段圆弧，转成方向，放在镜头外 skyDistance 远（远平面的八成，所有东西都在它前面，不写深度、不做深度测试，按实例顺序盖）
async function createStrokeField( starryConfig, counts ) {

	const uniforms = state.uniforms;
	const flowConfig = starryConfig.flow;
	const strokeSpeed = flowConfig.strokeSpeed;
	const flowMap = state.flowPass.map;
	const skyMap = state.skyPass.map;
	const groundGuide = state.groundGuide;
	const data = await buildStrokeInstances( counts, starryConfig );

	// 底下的方片：x 沿笔触长度 0~1（分 6 段，弯成圆弧才顺），y 横向 0~1
	const geometry = new THREE.BufferGeometry();
	const lengthSegments = 6;
	const quadPositions = [];
	const quadIndices = [];
	for ( let k = 0; k <= lengthSegments; k ++ ) quadPositions.push( k / lengthSegments, 0, 0, k / lengthSegments, 1, 0 );
	for ( let k = 0; k < lengthSegments; k ++ ) quadIndices.push( k * 2, k * 2 + 2, k * 2 + 3, k * 2, k * 2 + 3, k * 2 + 1 );
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( quadPositions, 3 ) );
	geometry.setIndex( quadIndices );
	geometry.setAttribute( 'strokePlace', new THREE.InstancedBufferAttribute( data.place, 4 ) );
	geometry.setAttribute( 'strokeShape', new THREE.InstancedBufferAttribute( data.shape, 4 ) );
	geometry.setAttribute( 'strokeTint', new THREE.InstancedBufferAttribute( data.tint, 4 ) );
	geometry.setAttribute( 'strokeExtra', new THREE.InstancedBufferAttribute( data.extra, 4 ) );
	geometry.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e6 );

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '星月夜·笔触';
	// 不进透明队列：画在不透明队列里（renderOrder 5，远景之后、引路花瓣之前），不做深度测试，按实例顺序一笔盖一笔
	material.transparent = false;
	material.depthTest = false;
	material.depthWrite = false;
	material.fog = false;
	material.lights = false;
	// 预乘混合：颜料笔输出 (颜色 × a, a) 盖在下面；流光输出 (颜色, 0)，等于加法 —— 一个材质两种混法。
	// 目标的 alpha 不动（薄雾让引路花瓣用的是场景 alpha）
	material.blending = THREE.CustomBlending;
	material.blendEquation = THREE.AddEquation;
	material.blendSrc = THREE.OneFactor;
	material.blendDst = THREE.OneMinusSrcAlphaFactor;
	material.blendEquationAlpha = THREE.AddEquation;
	material.blendSrcAlpha = THREE.ZeroFactor;
	material.blendDstAlpha = THREE.OneFactor;

	const place = attribute( 'strokePlace', 'vec4' );
	const shape = attribute( 'strokeShape', 'vec4' );
	const tint = attribute( 'strokeTint', 'vec4' );
	const extra = attribute( 'strokeExtra', 'vec4' );

	// 视野锥（性能，perf.scenesB）：xyz 画这一遍的相机的前向（场景坐标），w 半对角视场 + starryViewMargin（弧度）。
	// 每次画（主画面、倒影、预编译以外的任何一遍）之前按那一台相机现算，拖得再快也是这一帧的朝向
	const perf = state.ctx.config.perf.scenesB;
	const viewCull = perf.starryViewCull;
	const baseStill = perf.starryBaseStill;
	const viewCone = uniform( new THREE.Vector4( 0, 0, - 1, 10 ) ).onRenderUpdate( ( { camera } ) => {

		const cone = viewCone.value;
		if ( ! camera || ! camera.isPerspectiveCamera ) {

			cone.w = 10;
			return;

		}

		camera.getWorldDirection( cullDirection );
		const halfHeight = Math.tan( camera.fov * degree / 2 ) / ( camera.zoom || 1 );
		cone.set( cullDirection.x, cullDirection.y, cullDirection.z, Math.atan( halfHeight * Math.hypot( 1, camera.aspect ) ) + perf.starryViewMargin );

	} );

	material.positionNode = Fn( () => {

		const layer = place.z;
		const seed = place.w;
		const near = ( index ) => float( 1 ).sub( step( 0.5, abs( layer.sub( index ) ) ) );
		// 这一层的调试开关
		let toggle = float( 0 );
		layerToggleNames.forEach( ( name, index ) => {

			toggle = toggle.add( uniforms.layerAmounts[ name ].mul( near( index ) ) );

		} );

		const center = vec2( 0 ).toVar();
		const direction = vec2( 1, 0 ).toVar();
		const curvature = float( 0 ).toVar();
		const sizeScale = float( 1 ).toVar();
		const paint = vec3( 0 ).toVar();
		const visible = float( 1 ).toVar();
		const head = float( 1 ).toVar();
		const tail = float( 0 ).toVar();
		const glow = float( 0 ).toVar();

		// 视野剔除（性能，perf.scenesB.starryViewCull）：这一笔的参考方向（天空的笔、星环、柏树取锚点 place.xy，地面的笔、窗灯取锚点 extra.xyz 的方向）
		// 和镜头前向的夹角超过 半对角视场 + 余量（viewCone.w）+ 这一笔能跑出去多远（半个笔长以内、沿流线走的行程、星环半径、柏树摆幅），
		// 整笔不画（长、宽乘 0 退化成一个点），下面按层分的四路都不算。天空坐标是正弦投影，离中线远、仰角高的地方，
		// 天空坐标里的一段距离在球面上会拉长，按 1 + |x · tan(y)| 放大（只会偏大）
		const inView = float( 1 ).toVar();
		if ( viewCull ) {

			const groundLayer = layer.greaterThan( 4.5 ).and( layer.lessThan( 7.5 ) );
			const groundDirection = normalize( extra.xyz.sub( cameraPosition ) );
			const referenceDirection = groundLayer.select( groundDirection, skyDirectionNode( place.xy ) );
			const referenceSky = groundLayer.select( directionToSky( groundDirection ), place.xy );
			const isParticle = near( layerIndex.particle );
			const flowLayer = near( layerIndex.middle ).add( near( layerIndex.highlight ) ).add( isParticle );
			// 沿流线最多走 半个寿命 × 总倍率 × 最快的笔速（流光再乘它的倍数），出生点还要抖 extra.x
			const travel = max( shape.w, 0.1 ).mul( 0.5 ).mul( uniforms.speedScale ).mul( uniforms.flowAmount ).mul( strokeSpeed.max )
				.mul( mix( float( 1 ), float( flowConfig.particleSpeed ), isParticle ) );
			const reach = shape.y
				.add( flowLayer.mul( travel.add( extra.x ) ) )
				.add( near( layerIndex.ring ).mul( extra.y ) )
				.add( near( layerIndex.cypress ).add( near( layerIndex.cypressLine ) ).mul( extra.x ) );
			const stretch = float( 1 ).add( abs( referenceSky.x ).mul( abs( tan( referenceSky.y.clamp( - 1.37, 1.37 ) ) ) ) );
			const limit = min( viewCone.w.add( reach.mul( stretch ) ), Math.PI );
			inView.assign( step( cos( limit ), dot( referenceDirection, viewCone.xyz ) ) );

		}

		If( inView.lessThan( 0.5 ), () => {

			// 视野外：四路都不算，长宽在下面乘 0

		} ).ElseIf( layer.lessThan( 2.5 ).or( near( layerIndex.particle ).greaterThan( 0.5 ) ), () => {

			// ---- 天空的笔：底层不动（寿命、行程都乘 0），中层、高光、流光沿流线走 ----
			const flowing = float( 1 ).sub( near( layerIndex.base ) );
			const isParticle = near( layerIndex.particle );
			const lifetime = max( shape.w, 0.1 );
			const cycleValue = uniforms.time.div( lifetime ).add( seed.mul( 7.31 ) );
			const life = fract( cycleValue );
			const cycle = floor( cycleValue );
			// 每轮的出生点在自己的格子里抖一下（不会一直在同一个地方生灭）
			const jitter = vec2( hash21( vec2( cycle, seed.mul( 911 ) ) ), hash21( vec2( cycle.add( 17 ), seed.mul( 613 ) ) ) ).sub( 0.5 ).mul( extra.x ).mul( flowing );
			const anchor = place.xy.add( jitter ).toVar();
			// 寿命中间那一刻正好在锚点（布点的疏密就是画面上的疏密），之前往上游倒推、之后往下游走；RK2（中点法）积分 4 步
			const travelStep = life.sub( 0.5 ).mul( lifetime ).mul( uniforms.speedScale ).mul( uniforms.flowAmount )
				.mul( mix( float( 1 ), float( flowConfig.particleSpeed ), isParticle ) ).div( 4 ).mul( flowing );
			const point = anchor.toVar();
			const integrate = () => {

				for ( let k = 0; k < 4; k ++ ) {

					const firstVelocity = sampleFlow( flowMap, point );
					const first = normalize( firstVelocity.add( vec2( 1e-5, 0 ) ) ).mul( paintSpeed( firstVelocity, strokeSpeed ) );
					const middleVelocity = sampleFlow( flowMap, point.add( first.mul( travelStep.mul( 0.5 ) ) ) );
					const second = normalize( middleVelocity.add( vec2( 1e-5, 0 ) ) ).mul( paintSpeed( middleVelocity, strokeSpeed ) );
					point.addAssign( second.mul( travelStep ) );

				}

			};
			// 底层的笔行程乘 0（point 一直是锚点）：8 次流场采样都省掉（perf.scenesB.starryBaseStill）
			if ( baseStill ) If( flowing.greaterThan( 0.5 ), integrate );
			else integrate();

			const endVelocity = sampleFlow( flowMap, point );
			const flowDirection = normalize( endVelocity.add( vec2( 1e-5, 0 ) ) );
			// 笔弯成一段圆弧：曲率 = 中心往前 0.01 弧度处的流向和中心流向的叉积 / 0.01（顺着流线拐的方向）
			const aheadDirection = normalize( sampleFlow( flowMap, point.add( flowDirection.mul( 0.01 ) ) ).add( vec2( 1e-5, 0 ) ) );
			center.assign( point );
			direction.assign( flowDirection );
			curvature.assign( flowDirection.x.mul( aheadDirection.y ).sub( flowDirection.y.mul( aheadDirection.x ) ).div( 0.01 ) );
			// 流得快的地方笔拉长一些；大涡里短一些、窄一些（螺旋带窄，长笔会横跨亮暗两条带）
			const speedNow = paintSpeed( endVelocity, strokeSpeed );
			const inSwirl = max( swirlInsideNode( anchor, bigSwirl ), swirlInsideNode( anchor, smallSwirl ) ).mul( uniforms.swirlAmount );
			sizeScale.assign( mix( float( 1 ), mix( float( 0.82 ), float( 1.15 ), smoothstep( strokeSpeed.min, strokeSpeed.max, speedNow ) ), flowing ).mul( mix( float( 1 ), mix( float( 0.62 ), float( 0.85 ), flowing ), inSwirl ) ) );
			// 颜色：天空底稿在锚点的颜色，按种子分深、亮两种变体，再抖一点明度；高光层乘 tint（HDR 提亮）
			const guide = skyMap.sample( domainCoordinate( anchor ) ).level( 0 );
			const variant = hash21( vec2( seed.mul( 91.7 ), 3.1 ) );
			const shade = hash21( vec2( seed.mul( 37.3 ), 7.7 ) ).sub( 0.5 ).mul( 0.26 ).add( 1 );
			const darker = guide.rgb.mul( 0.52 );
			const lighter = guide.rgb.mul( 1.38 ).add( vec3( 0.012, 0.016, 0.024 ).mul( uniforms.paintLevel ) );
			const variantColor = mix( mix( guide.rgb, darker, step( variant, mix( float( 0.26 ), float( 0.1 ), inSwirl ) ) ), lighter, step( mix( float( 0.8 ), float( 0.92 ), inSwirl ), variant ) ).mul( shade );
			paint.assign( mix( tint.rgb, variantColor.mul( tint.rgb ), tint.w ) );
			// 让开：星芯、月盘（底稿 alpha 0.5）、柏树（0）不画天空的笔（流光不让）；锚点在地面底稿里是地面（山后面）也不画
			const keep = mix( smoothstep( 0.62, 0.9, guide.a ), float( 1 ), isParticle );
			const anchorGuide = groundGuideCoordinate( skyDirectionNode( anchor ) );
			const groundThere = groundGuide.map.sample( anchorGuide.coordinate ).level( 0 ).a;
			visible.assign( keep.mul( float( 1 ).sub( step( 0.5, groundThere ).mul( float( 1 ).sub( anchorGuide.behind ) ) ) ) );
			// 一生：画上去（头从尾往前长出来）、抹掉（尾巴往前收）；流光按透明度淡入淡出
			head.assign( mix( float( 1 ), smoothstep( 0, 0.2, life ), flowing.mul( float( 1 ).sub( isParticle ) ) ) );
			tail.assign( mix( float( 0 ), smoothstep( 0.8, 1, life ), flowing.mul( float( 1 ).sub( isParticle ) ) ) );
			glow.assign( isParticle );
			visible.mulAssign( mix( float( 1 ), smoothstep( 0, 0.12, life ).mul( float( 1 ).sub( smoothstep( 0.88, 1, life ) ) ), isParticle ) );

		} ).ElseIf( layer.lessThan( 3.5 ), () => {

			// ---- 星环：绕着星（place.xy）转，角速度 extra.w（隔圈正反），笔沿切线。圆在球面上画（星的切平面里转一圈再换回天空坐标），
			// 离中线远的星、月的环才是正圆，和天空底稿里的光环对得上 ----
			const ringAngle = extra.z.add( uniforms.time.mul( extra.w ).mul( uniforms.speedScale ) );
			const ringCenter = skyDirectionNode( place.xy );
			const ringAzimuth = place.x.div( max( cos( place.y ), 0.2 ) );
			const ringEast = vec3( cos( ringAzimuth ), 0, sin( ringAzimuth ) );
			const ringNorth = vec3( sin( ringAzimuth ).mul( sin( place.y ) ).negate(), cos( place.y ), cos( ringAzimuth ).mul( sin( place.y ) ) );
			const ringAt = ( angle ) => directionToSky( normalize( ringCenter.add( ringEast.mul( cos( angle ) ).add( ringNorth.mul( sin( angle ) ) ).mul( extra.y ) ) ) );
			const ringPoint = ringAt( ringAngle ).toVar();
			center.assign( ringPoint );
			// 逆时针的切向（角度增大的方向）；正反转都一样画（笔不分头尾）
			direction.assign( normalize( ringAt( ringAngle.add( 0.02 ) ).sub( ringPoint ).add( vec2( 1e-6, 0 ) ) ) );
			curvature.assign( float( 1 ).div( max( extra.y, 0.004 ) ) );
			paint.assign( tint.rgb );
			// 星环归"星"、月盘月晕归"月"的开关管
			const isMoon = step( length( place.xy.sub( vec2( moon.x, moon.y ) ) ), 0.001 );
			visible.assign( mix( uniforms.starAmount, uniforms.moonAmount, isMoon ) );

		} ).ElseIf( layer.lessThan( 7.5 ), () => {

			// ---- 地面的笔、细笔、窗灯：锚点 extra.xyz（局部坐标）----
			const anchor = extra.xyz;
			const toAnchor = anchor.sub( cameraPosition );
			const anchorDistance = max( length( toAnchor ), 0.5 );
			const anchorDirection = toAnchor.div( anchorDistance ).toVar();
			center.assign( directionToSky( anchorDirection ) );
			// 镜头离锚点近了笔就大（按出生点那里的大小换算）
			sizeScale.assign( length( anchor.sub( uniforms.spawnPosition ) ).div( anchorDistance ).clamp( 0.5, 2 ) );
			const stored = vec2( cos( extra.w ), sin( extra.w ) );
			const guidePlace = groundGuideCoordinate( anchorDirection );
			const sample = groundGuide.map.sample( guidePlace.coordinate ).level( 0 ).toVar();
			// tint.w：1 取地面底稿的颜色（地面的笔）；0 用自己的颜色（窗灯、房子的笔，方向也是自己的，不顺着底稿的边转）
			const usesGuide = step( 0.5, tint.w );
			const isDetail = near( layerIndex.groundDetail ).mul( usesGuide );
			const isWindow = near( layerIndex.window );
			// 顺着边：底稿亮度在 ±1.5 像素的梯度，强的地方（房子、尖塔、山脊的边）笔顺着边走（细笔才这样）
			const texel = groundGuide.texel.mul( 1.5 );
			const lumaAt = ( dx, dy ) => luminance( groundGuide.map.sample( guidePlace.coordinate.add( vec2( dx, dy ).mul( texel ) ) ).level( 0 ).rgb );
			const gradientX = lumaAt( 1, 0 ).sub( lumaAt( - 1, 0 ) );
			const gradientY = lumaAt( 0, 1 ).sub( lumaAt( 0, - 1 ) );
			// 贴图的 v 朝下：天空里的梯度是 (gx, −gy)，边的方向是它转 90°：(gy, gx)
			const edge = vec2( gradientY, gradientX );
			const edgeStrength = length( edge ).div( luminance( sample.rgb ).add( 0.004 ) );
			const edgeWeight = smoothstep( 0.25, 0.8, edgeStrength ).mul( isDetail );
			sizeScale.mulAssign( mix( float( 1 ), float( 0.75 ), smoothstep( 0.2, 0.7, edgeStrength ).mul( usesGuide ) ) );
			const alignedEdge = normalize( edge.mul( sign( dot( edge, stored ).add( 1e-6 ) ) ).add( vec2( 1e-6, 0 ) ) );
			direction.assign( normalize( mix( stored, alignedEdge, edgeWeight ) ) );
			curvature.assign( hash21( vec2( seed.mul( 51.3 ), 2.7 ) ).sub( 0.5 ).mul( 6 ) );
			// 颜色：底稿换配色；细笔里三成在边上勾成深蓝的轮廓（原画房子、山都有深色勾边），轮廓线细一点
			const distanceFromSpawn = length( anchor.sub( uniforms.spawnPosition ) );
			const groundColor = paintGround( sample.rgb, distanceFromSpawn );
			const liner = step( hash21( vec2( seed.mul( 13.1 ), 5.3 ) ), 0.3 ).mul( edgeWeight );
			const shade = hash21( vec2( seed.mul( 37.3 ), 7.7 ) ).sub( 0.5 ).mul( 0.4 ).add( 1 );
			const groundVariant = hash21( vec2( seed.mul( 71.9 ), 4.4 ) );
			const variedGround = groundColor.mul( shade ).mul( mix( mix( float( 1 ), float( 0.6 ), step( groundVariant, 0.16 ) ), float( 1.3 ), step( 0.88, groundVariant ) ) );
			const groundPaint = mix( variedGround, color( '#0b1430' ).mul( uniforms.paintLevel ), liner.mul( 0.85 ) );
			sizeScale.mulAssign( mix( float( 1 ), float( 0.65 ), liner ) );
			paint.assign( mix( tint.rgb, groundPaint, usesGuide ) );
			// 是不是地面：底稿 alpha > 0.5；窗灯：底稿那里亮而暖（窗灯亮着、没被房子挡住）才画
			const isGround = step( 0.5, sample.a ).mul( float( 1 ).sub( guidePlace.behind ) );
			const warmLight = smoothstep( 0.015, 0.06, sample.r.sub( sample.b ) ).mul( smoothstep( 0.02, 0.08, luminance( sample.rgb ) ) );
			visible.assign( mix( isGround, warmLight.mul( float( 1 ).sub( guidePlace.behind ) ), isWindow ) );
			// 房子的笔（细笔那层里用自己颜色的）是按出生点的视角一行行排的，镜头离出生点远了（飞进来往出生点滑的那几秒）换个角度看成一道道条纹：
			// 镜头离出生点 4~20 米之间淡入，滑行时由取底稿颜色的地面笔和远景的 3D 房子顶着
			visible.mulAssign( mix( float( 1 ), uniforms.spawnNearness, near( layerIndex.groundDetail ).mul( float( 1 ).sub( usesGuide ) ) ) );

		} ).Else( () => {

			// ---- 柏树、勾线：天空坐标里的点，按高度左右轻轻摆（尖上摆得多，extra.x 是幅度）----
			const swayPhase = uniforms.time.mul( 0.33 ).mul( uniforms.speedScale ).add( place.y.mul( 4.0 ) );
			const swayOffset = sin( swayPhase ).mul( extra.x );
			center.assign( place.xy.add( vec2( swayOffset, 0 ) ) );
			const angle = extra.w.add( cos( swayPhase ).mul( extra.x ).mul( 8 ) );
			direction.assign( vec2( cos( angle ), sin( angle ) ) );
			curvature.assign( extra.y );
			paint.assign( tint.rgb );

		} );

		// 长、宽（弧度）；开关关了宽度为 0；视野外长宽都是 0
		const strokeLength = shape.y.mul( sizeScale ).mul( inView );
		const strokeWidth = shape.x.mul( sizeScale ).mul( step( 0.001, toggle ) ).mul( inView );
		const corner = positionGeometry.xy;
		const across = vec2( direction.y.negate(), direction.x );
		// 曲率封顶 1/0.012（太弯的笔像个钩）。圆弧上离中心 s 的点 = 中心 + 方向 × sin(κs)/κ + 横向 × (1 − cos(κs))/κ；
		// κ 很小时按泰勒展开接上（不除以 0）
		const kappa = curvature.clamp( - 1 / 0.012, 1 / 0.012 );
		const alongDistance = corner.x.sub( 0.5 ).mul( strokeLength );
		const bendAngle = kappa.mul( alongDistance );
		const nearlyStraight = step( abs( kappa ), 0.05 );
		const safeKappa = mix( kappa, float( 1 ), nearlyStraight );
		const arcForward = mix( sin( bendAngle ).div( safeKappa ), alongDistance, nearlyStraight );
		const arcSideways = mix( float( 1 ).sub( cos( bendAngle ) ).div( safeKappa ), kappa.mul( alongDistance ).mul( alongDistance ).mul( 0.5 ), nearlyStraight );
		const bentDirection = direction.mul( cos( bendAngle ) ).add( across.mul( sin( bendAngle ) ) );
		const bentAcross = vec2( bentDirection.y.negate(), bentDirection.x );
		const skyPoint = center.add( direction.mul( arcForward ) ).add( across.mul( arcSideways ) ).add( bentAcross.mul( corner.y.sub( 0.5 ).mul( strokeWidth ) ) );

		// 传给片元：颜色、透明度、头尾、是不是流光、种子、长宽比、受光朝向
		varyingProperty( 'vec3', 'vStrokeColor' ).assign( paint );
		varyingProperty( 'float', 'vStrokeAlpha' ).assign( shape.z.mul( visible ).mul( toggle.clamp( 0, 1 ) ) );
		varyingProperty( 'float', 'vStrokeHead' ).assign( head );
		varyingProperty( 'float', 'vStrokeTail' ).assign( tail );
		varyingProperty( 'float', 'vStrokeGlow' ).assign( glow );
		varyingProperty( 'float', 'vStrokeSeed' ).assign( seed );
		varyingProperty( 'float', 'vStrokeAspect' ).assign( strokeLength.div( max( shape.x.mul( sizeScale ), 1e-5 ) ) );
		// 厚涂的受光：光从左上方来，笔的横向朝哪边
		varyingProperty( 'float', 'vStrokeFacing' ).assign( dot( across, vec2( - 0.6, 0.8 ) ) );

		// 天空坐标 → 方向 → 镜头外 skyDistance 远的点（场景坐标就是地点局部坐标，−z 是机位朝向）
		return cameraPosition.add( skyDirectionNode( skyPoint ).mul( uniforms.skyDistance ) );

	} )();

	const canvasMask = state.ctx.pipeline.canvasMaskNode;
	material.colorNode = Fn( () => {

		const strokeColor = varyingProperty( 'vec3', 'vStrokeColor' );
		const strokeAlpha = varyingProperty( 'float', 'vStrokeAlpha' );
		const strokeHead = varyingProperty( 'float', 'vStrokeHead' );
		const strokeTail = varyingProperty( 'float', 'vStrokeTail' );
		const strokeGlow = varyingProperty( 'float', 'vStrokeGlow' );
		const strokeSeed = varyingProperty( 'float', 'vStrokeSeed' );
		const strokeAspect = varyingProperty( 'float', 'vStrokeAspect' );
		const strokeFacing = varyingProperty( 'float', 'vStrokeFacing' );
		const along = positionGeometry.x;
		const sideways = positionGeometry.y.mul( 2 ).sub( 1 );
		// 画布从四周蔓延时，笔触只在画布盖到的地方
		const reveal = canvasMask();

		// --- 颜料笔：鬃毛（横向 5~8 条细条纹，两组正弦叠起来，粗细不一）只调明暗，不调透明度——颜料是实的 ---
		const bristleCount = floor( strokeSeed.mul( 3.99 ) ).add( 5 );
		const bristlePhase = sideways.mul( bristleCount ).mul( Math.PI ).add( strokeSeed.mul( 40 ) );
		const secondPhase = bristlePhase.mul( 2.3 ).add( strokeSeed.mul( 13 ) );
		const height = sin( bristlePhase ).mul( 0.6 ).add( sin( secondPhase ).mul( 0.4 ) ).mul( 0.5 ).add( 0.5 );
		const slope = cos( bristlePhase ).mul( 0.6 ).add( cos( secondPhase ).mul( 0.4 * 2.3 ) ).mul( 0.5 / 1.25 );
		// 笔的轮廓（叶形）：起笔是半个圆（半径半个笔宽），笔身过半以后往笔尾收窄到四分之一，收笔每根鬃毛断的地方不一样长（边上的毛先断）。
		// 原来两头平、边是直的，一块块方砖拼出来的涡和卷流有棱有角
		const tailEnd = float( 0.78 ).add( sin( bristlePhase.mul( 0.5 ).add( strokeSeed.mul( 7 ) ) ).mul( 0.1 ) ).sub( abs( sideways ).mul( 0.12 ) );
		const startCap = float( 1 ).sub( smoothstep( 0.42, 0.5, length( vec2( max( float( 0.5 ).sub( along.mul( strokeAspect ) ), 0 ), sideways.mul( 0.5 ) ) ) ) );
		const ends = startCap.mul( float( 1 ).sub( smoothstep( tailEnd, 1, along ) ) );
		const halfWidth = mix( float( 1 ), float( 0.25 ), smoothstep( 0.45, 1, along ) );
		// 两侧：按屏幕导数抗锯齿（约 1.5 像素），再往里软 15%（颜料边上薄），鬃毛起伏咬进去一点
		const antiAlias = max( fwidth( sideways ).mul( 1.5 ), 0.02 );
		const edge = float( 1 ).sub( smoothstep( halfWidth.mul( 0.85 ).sub( height.mul( 0.06 ) ).sub( antiAlias ), halfWidth, abs( sideways ) ) );
		// 一生的头尾：头之后、尾之前的不画（软边 0.06）
		const life = float( 1 ).sub( smoothstep( strokeHead.sub( 0.06 ), strokeHead, along ) ).mul( smoothstep( strokeTail, strokeTail.add( 0.06 ), along ) );
		const coverage = edge.mul( ends ).mul( life ).mul( strokeAlpha ).mul( reveal );
		// 厚涂：鬃毛的起伏 ±12%，鬃毛的斜坡朝光那面亮、背光那面暗
		const shade = float( 0.88 ).add( height.mul( 0.24 ) ).add( slope.clamp( - 1, 1 ).mul( strokeFacing ).mul( 0.12 ) );
		const brushColor = strokeColor.mul( shade );

		// --- 流光：头在 along = 1 那头的软圆点，后面拖一条渐淡的尾巴（以宽度为单位量长度）---
		const alongWidths = along.mul( strokeAspect );
		const headCenter = strokeAspect.sub( 0.5 );
		const headGlow = exp( alongWidths.sub( headCenter ).pow2().add( sideways.mul( 0.5 ).pow2() ).mul( - 14 ) );
		const tailGlow = exp( sideways.mul( 0.5 ).pow2().mul( - 22 ) ).mul( smoothstep( 0, headCenter, alongWidths ).pow2() ).mul( step( alongWidths, headCenter ) ).mul( 0.45 );
		const glowAmount = max( headGlow, tailGlow ).mul( strokeAlpha ).mul( reveal );

		const isGlow = step( 0.5, strokeGlow );
		const finalCoverage = mix( coverage, glowAmount, isGlow );
		Discard( finalCoverage.lessThan( 0.004 ) );
		return mix( vec4( brushColor.mul( coverage ), coverage ), vec4( strokeColor.mul( glowAmount ), 0 ), isGlow );

	} )();

	const mesh = new THREE.InstancedMesh( geometry, material, data.total );
	mesh.name = '星月夜·笔触';
	mesh.frustumCulled = false;
	mesh.renderOrder = 5;
	state.disposables.push( geometry, material, mesh );
	return { mesh, placed: data.placed, total: data.total, rays: data.rays };

}

// ===================== 天空球（底稿）=====================
// 笔缝里露出来的东西：天上是天空底稿，地面是地面底稿换过配色的颜色，柏树是墨绿；底稿范围外是深群青
function createSkyDome() {

	const uniforms = state.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '星月夜·底稿球';
	material.side = THREE.BackSide;
	material.depthWrite = false;
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const direction = normalize( positionWorld.sub( cameraPosition ) );
		const point = directionToSky( direction );
		const coordinate = domainCoordinate( point );
		const inside = step( 0, coordinate.x ).mul( step( coordinate.x, 1 ) ).mul( step( 0, coordinate.y ) ).mul( step( coordinate.y, 1 ) );
		const sky = state.skyPass.map.sample( coordinate.clamp( 0.001, 0.999 ) );
		const skyColor = mix( color( '#1b3a8c' ).mul( uniforms.paintLevel.mul( 0.5 ) ), sky.rgb, inside );
		const cypress = float( 1 ).sub( smoothstep( 0.05, 0.3, sky.a ) ).mul( inside );
		const guidePlace = groundGuideCoordinate( direction );
		const ground = state.groundGuide.map.sample( guidePlace.coordinate );
		const isGround = step( 0.5, ground.a ).mul( float( 1 ).sub( guidePlace.behind ) );
		const result = mix( skyColor, paintGround( ground.rgb, float( 1500 ) ), isGround ).toVar();
		result.assign( mix( result, color( '#142318' ).mul( uniforms.paintLevel ), cypress ) );
		// 画布还没盖到的地方（飞进来、飞走那几秒）：统一的夜空，不露底稿
		const unifiedSky = daySkyColor( state.ctx.backdrop.sceneDirectionToWorld( direction ), state.ctx.world.uniforms, uniforms.time );
		return vec4( mix( unifiedSky, result.mul( uniforms.skyAmount ), state.ctx.pipeline.canvasMaskNode() ), 1 );

	} )();
	const mesh = new THREE.Mesh( new THREE.SphereGeometry( 1, 64, 32 ), material );
	mesh.name = '星月夜·底稿球';
	mesh.frustumCulled = false;
	mesh.renderOrder = - 10;
	state.disposables.push( mesh.geometry, material );
	return mesh;

}

// ===================== 流星 =====================
// 每颗一条 24 段的带子：头沿一条直线（天空坐标）划过，尾巴是头走过的历史位置，再按流场偏移（被旋涡带弯）；JS 每帧更新这几十个点
const meteorSegments = 24;

function createMeteor() {

	const count = ( meteorSegments + 1 ) * 2;
	const geometry = new THREE.BufferGeometry();
	const positions = new Float32Array( count * 3 );
	const along = new Float32Array( count );
	const sides = new Float32Array( count );
	for ( let i = 0; i <= meteorSegments; i ++ ) {

		for ( let s = 0; s < 2; s ++ ) {

			along[ i * 2 + s ] = i / meteorSegments;
			sides[ i * 2 + s ] = s === 0 ? - 1 : 1;

		}

	}

	const indices = [];
	for ( let i = 0; i < meteorSegments; i ++ ) indices.push( i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2 );
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ).setUsage( THREE.DynamicDrawUsage ) );
	geometry.setAttribute( 'meteorAlong', new THREE.BufferAttribute( along, 1 ) );
	geometry.setAttribute( 'meteorSide', new THREE.BufferAttribute( sides, 1 ) );
	geometry.setIndex( indices );
	geometry.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e6 );
	const brightness = uniform( 0 );
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '流星';
	material.transparent = true;
	material.depthWrite = false;
	material.blending = THREE.AdditiveBlending;
	material.side = THREE.DoubleSide;
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const alongTail = attribute( 'meteorAlong', 'float' );
		const across = attribute( 'meteorSide', 'float' );
		// 头（along = 0）HDR，尾巴往后淡；刷痕：横向几条细纹（和天空的笔一样是一缕缕的颜料，不是一条光棒）；带子两边软
		const head = exp( alongTail.mul( - 14 ) ).mul( 24 );
		const tail = pow( float( 1 ).sub( alongTail ), 1.4 ).mul( 5.5 );
		const bristles = sin( across.mul( 9 ).add( alongTail.mul( 30 ) ) ).mul( 0.3 ).add( 0.7 ).mul( float( 1 ).sub( smoothstep( 0.55, 1, abs( across ) ) ) );
		const tint = mix( color( '#fff6d6' ), color( '#f7e27a' ), alongTail );
		return vec4( tint.mul( head.add( tail ) ).mul( bristles ).mul( brightness ).mul( state.uniforms.meteorAmount ).mul( state.ctx.pipeline.canvasMaskNode() ), 1 );

	} )();
	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = '流星';
	mesh.frustumCulled = false;
	mesh.renderOrder = 1003;
	mesh.visible = false;
	state.disposables.push( geometry, material );
	return { mesh, brightness, active: false, start: 0, duration: 1.5, from: [ 0, 0 ], to: [ 0, 0 ] };

}

// 流星（"几个星星流下来"）从画面上半（仰角 0.36~0.6）斜着往下划（和水平夹 30°~55°），终点不低于仰角 0.15（不钻进山里）
// 划过月盘的那条会像月亮上一道白杠（2026-10-02 自查截图），离月晕太近就重抽，最多 12 次
function launchMeteor( meteor, time, random ) {

	for ( let attempt = 0; attempt < 12; attempt ++ ) {

		const startX = - 0.55 + random() * 1.1;
		const startY = 0.36 + random() * 0.24;
		const angle = ( 0.52 + random() * 0.44 ) * ( random() < 0.5 ? 1 : - 1 );
		const length = 0.4 + random() * 0.25;
		meteor.from = [ startX, startY ];
		meteor.to = [ startX + Math.cos( angle ) * length * Math.sign( angle ), Math.max( 0.15, startY - Math.abs( Math.sin( angle ) ) * length - 0.06 ) ];
		if ( meteorMoonClearance( meteor.from, meteor.to ) > moon.halo * 1.4 ) break;

	}

	meteor.start = time;
	meteor.duration = 1.6 + random() * 0.8;
	meteor.active = true;
	meteor.mesh.visible = true;

}

// 流星头走过的线段（加上尾巴被流场带弯的余量）离月亮最近有多远：沿线段取 16 个点量球面距离
function meteorMoonClearance( from, to ) {

	let nearest = Infinity;
	for ( let i = 0; i <= 16; i ++ ) {

		const t = i / 16;
		nearest = Math.min( nearest, sphereDistanceJs( from[ 0 ] + ( to[ 0 ] - from[ 0 ] ) * t, from[ 1 ] + ( to[ 1 ] - from[ 1 ] ) * t, moon.x, moon.y ) );

	}

	return nearest;

}

const meteorPoint = new THREE.Vector3();
const meteorSide = new THREE.Vector3();
const meteorDirection = new THREE.Vector3();

function updateMeteor( meteor, time, cameraLocal ) {

	if ( ! meteor.active ) return;
	const progress = ( time - meteor.start ) / meteor.duration;
	if ( progress > 1.6 || progress < 0 ) {

		meteor.active = false;
		meteor.mesh.visible = false;
		return;

	}

	// 亮度：快速亮起，走完以后尾巴慢慢淡
	meteor.brightness.value = Math.min( 1, progress * 6 ) * ( 1 - smoothJs( 0.9, 1.6, progress ) );
	const distance = state.uniforms.skyDistance.value;
	const positions = meteor.mesh.geometry.attributes.position;
	const phase = time * state.ctx.config.starry.flow.phaseRate * state.uniforms.speedScale.value;
	for ( let i = 0; i <= meteorSegments; i ++ ) {

		const age = i / meteorSegments * 0.55;
		const t = Math.max( 0, Math.min( 1, progress - age ) );
		let x = meteor.from[ 0 ] + ( meteor.to[ 0 ] - meteor.from[ 0 ] ) * t;
		let y = meteor.from[ 1 ] + ( meteor.to[ 1 ] - meteor.from[ 1 ] ) * t;
		// 尾巴被流场带弯：越老的点沿流场漂得越远
		const [ vx, vy ] = flowAtJs( x, y, phase );
		x += vx * age * 0.15;
		y += vy * age * 0.15;
		localSkyDirection( x, y, meteorPoint );
		localSkyDirection( x + 0.001, y, meteorDirection );
		meteorDirection.sub( meteorPoint ).normalize();
		meteorSide.crossVectors( meteorPoint, meteorDirection ).normalize();
		// 头宽约 7 像素（1080p），往尾巴收窄到三成
		const width = 0.0085 * ( 1 - i / meteorSegments * 0.7 ) * distance;
		for ( let s = 0; s < 2; s ++ ) {

			const side = s === 0 ? - 1 : 1;
			positions.setXYZ( i * 2 + s, cameraLocal.x + meteorPoint.x * distance + meteorSide.x * width * side, cameraLocal.y + meteorPoint.y * distance + meteorSide.y * width * side, cameraLocal.z + meteorPoint.z * distance + meteorSide.z * width * side );

		}

	}

	positions.needsUpdate = true;

}

// ===================== init =====================

export async function init( ctx ) {

	if ( state.scene ) {

		console.warn( '星空场景：init 被重复调用，先释放旧的再重建' );
		dispose();

	}

	if ( ! ctx.backdrop || ! ctx.world || ! ctx.backdrop.getRoot() ) throw new Error( '星空场景：要先建好秘境（ctx.world、ctx.backdrop）' );
	if ( typeof ctx.backdrop.getWindows !== 'function' || typeof ctx.pipeline.canvasMaskNode !== 'function' ) throw new Error( '星空场景：远景要有 getWindows、后期要有 canvasMaskNode' );
	try {

		return await build( ctx );

	} catch ( error ) {

		releaseResources();
		throw error;

	}

}

// 按档位取参数：config 里没有这一档（比如 mid）就按 lo 取
function byContent( table, content ) {

	if ( table[ content ] !== undefined ) return table[ content ];
	if ( table.lo !== undefined ) return table.lo;
	throw new Error( `星空场景：参数表里既没有「${ content }」也没有 lo 列` );

}

async function build( ctx ) {

	const started = performance.now();
	state.ctx = ctx;
	state.disposables = [];
	state.paintObjects = [];
	state.frame = 0;
	state.skyRedrawn = - 1;
	const starryConfig = ctx.config.starry;
	const flowConfig = starryConfig.flow;
	const content = ctx.quality.content;
	const scene = new THREE.Scene();
	scene.name = '星月夜';
	scene.background = new THREE.Color( 0x000000 );
	state.scene = scene;
	const speedValid = Number.isFinite( flowConfig.speed ) && flowConfig.speed > 0;
	if ( ! speedValid ) console.warn( `星空场景：config.starry.flow.speed = ${ flowConfig.speed } 不是正数，按 1 算` );
	state.uniforms = {
		time: uniform( 0 ),
		speedScale: uniform( speedValid ? flowConfig.speed : 1 ),
		flowAmount: uniform( 1 ),
		starAmount: uniform( 1 ),
		moonAmount: uniform( 1 ),
		swirlAmount: uniform( 1 ),          // 调试开关：大漩涡（螺旋带、涡里的笔变短）
		skyAmount: uniform( 1 ),
		meteorAmount: uniform( 1 ),
		paintLevel: uniform( starryConfig.paintLevel ),
		skyDistance: uniform( ctx.camera.far * 0.8 ),
		spawnPosition: uniform( new THREE.Vector3() ),
		spawnNearness: uniform( 1 ),        // 镜头离出生点多近（1 = 在出生点 4 米以内，0 = 20 米以外）：房子的笔按它淡入
		layerAmounts: Object.fromEntries( toggleKeys.map( ( name ) => [ name, uniform( 1 ) ] ) ),
	};

	const flowSize = byContent( starryConfig.flowResolution, content );
	state.flowPass = createFlowPass( ctx, flowSize[ 0 ], flowSize[ 1 ], flowConfig );
	const skySize = byContent( starryConfig.skyResolution, content );
	state.skyPass = createSkyPass( ctx, skySize[ 0 ], skySize[ 1 ] );
	state.groundGuide = createGroundGuide( byContent( starryConfig.groundGuideScale, content ) );
	state.guidePrePass = () => renderGroundGuide();
	const spawn = getSpawn();
	state.uniforms.spawnPosition.value.fromArray( spawn.position );

	const dome = createSkyDome();
	scene.add( dome );
	state.dome = dome;
	const counts = Object.fromEntries( Object.keys( starryConfig.strokeLayers ).map( ( name ) => [ name, byContent( starryConfig.strokeLayers[ name ], content ) ] ) );
	const strokes = await createStrokeField( starryConfig, counts );
	scene.add( strokes.mesh );

	state.meteors = [];
	for ( let i = 0; i < 3; i ++ ) {

		const meteor = createMeteor();
		scene.add( meteor.mesh );
		state.meteors.push( meteor );

	}

	state.meteorRandom = createRandom( 1889 );
	state.nextMeteor = 4;
	// 自己的东西挂第 0 层（预编译、画布蔓延时主相机看得到）和第 2 层（画布盖满以后主相机只看这一层）
	state.paintObjects = [ dome, strokes.mesh, ...state.meteors.map( ( meteor ) => meteor.mesh ) ];
	for ( const object of state.paintObjects ) object.layers.enable( paintLayer );

	const layerAmounts = state.uniforms.layerAmounts;
	state.layers = {
		流场流动: state.uniforms.flowAmount,
		天空: state.uniforms.skyAmount,
		星: state.uniforms.starAmount,
		月: state.uniforms.moonAmount,
		底层笔触: layerAmounts.base,
		中层笔触: layerAmounts.middle,
		高光笔触: layerAmounts.highlight,
		大漩涡: state.uniforms.swirlAmount,
		星环: layerAmounts.ring,
		流光: layerAmounts.particle,
		地面笔触: layerAmounts.ground,
		窗灯: layerAmounts.window,
		柏树: layerAmounts.cypress,
		流星: state.uniforms.meteorAmount,
	};

	state.ready = true;
	const placed = strokes.placed;
	console.log( `星月夜：建好了，用时 ${ ( performance.now() - started ).toFixed( 0 ) } ms；流场贴图 ${ flowSize[ 0 ] }×${ flowSize[ 1 ] }、天空底稿 ${ skySize[ 0 ] }×${ skySize[ 1 ] }；` +
		`笔触 ${ strokes.total } 笔（天空底层 ${ placed[ 0 ] }、中层 ${ placed[ 1 ] }、高光 ${ placed[ 2 ] }、星环月盘 ${ placed[ 3 ] }、流光 ${ placed[ 4 ] }、` +
		`地面 ${ placed[ 5 ] }、地面细笔 ${ placed[ 6 ] }、窗灯 ${ placed[ 7 ] }、柏树 ${ placed[ 8 ] }、勾线 ${ placed[ 9 ] }；地面打了 ${ strokes.rays } 条射线）` );
	return { scene };

}

// 预编译：流场、天空底稿那两遍（画进自己的渲染目标），地面底稿（远景画进底稿的目标，格式和主场景的不一样，要单独编）
export async function compile( warmCamera ) {

	if ( ! state.ready ) return;
	await state.flowPass.compile();
	await state.skyPass.compile();
	state.flowPass.render();
	state.skyPass.render();
	state.skyRedrawn = 0;
	const camera = warmCamera || state.groundGuide.camera;
	await state.ctx.pipeline.compileScene( state.ctx.backdrop.getRoot(), camera, state.scene, state.groundGuide.target );

}

// ===================== 进出、每帧 =====================

// 出生点：机位地面上眼睛高；默认视角正对机位朝向、抬头 viewPitch
export function getSpawn() {

	const ctx = state.ctx;
	const location = ctx.world.locations[ key ];
	const ground = ctx.backdrop.getTerrainHeight( location.origin[ 0 ], location.origin[ 2 ] );
	const eye = Math.max( 0, ground + ctx.config.camera.eyeHeight - location.origin[ 1 ] );
	return { position: [ 0, eye, 0 ], lookAt: [ 0, eye + Math.sin( viewPitch ) * 300, - Math.cos( viewPitch ) * 300 ] };

}

// 本地 (x, z) 的地面高度（全景烘焙点按它放）
export function groundHeightAt( x, z ) {

	const ctx = state.ctx;
	ctx.world.toWorld( tempVector.set( x, 0, z ), key, tempVector );
	return ctx.backdrop.getTerrainHeight( tempVector.x, tempVector.z ) - ctx.world.locations[ key ].origin[ 1 ];

}

export function enter() {

	if ( ! state.ready ) throw new Error( '星空场景：还没 init 就调了 enter' );
	const ctx = state.ctx;
	const starryConfig = ctx.config.starry;
	// 2026-10-02 用户："星月夜我动不了"——原来是固定机位（只能拖动转头 ±60° / ±25°，最后十几秒自己推近、抬头看月亮）。
	// 改成和别的地点一样能走（WASD、Shift 跑、拖动随意转头），只是圈在出生点 walkRadius 米以内：天空的画在无穷远，
	// 柏树是天空坐标里的二维火舌，走远了地上的细笔会淡掉、柏树也不跟着近大远小，再远就不像一幅画了。视场用原画构图的那个
	const spawn = getSpawn();
	state.uniforms.spawnPosition.value.fromArray( spawn.position );
	const walkRadius = starryConfig.walkRadius;
	ctx.director.setWalk( {
		position: spawn.position,
		lookAt: spawn.lookAt,
		groundHeight: ( x, z ) => groundHeightAt( x, z ),
		bounds: { minX: - walkRadius, maxX: walkRadius, minZ: - walkRadius, maxZ: walkRadius },
		canWalk: ( x, z ) => Math.hypot( x, z ) <= walkRadius,
		fov: starryConfig.fov,
	} );
	for ( const label of Object.keys( state.layers ) ) ctx.debug.addLayerToggle( key, label, state.layers[ label ] );
	ctx.pipeline.setPainterly( ctx.quality.content === 'hi' ? starryConfig.kuwahara : 0, 1 );
	ctx.pipeline.addPrePass( state.guidePrePass );
	// 引路的花瓣、光点也挂到第 2 层（画布盖满以后主相机只看这一层）
	const guide = ctx.backdrop.getGuide();
	if ( guide ) guide.group.traverse( ( object ) => object.layers.enable( paintLayer ) );
	state.groundGuide.framesSince = 999;
	state.skyRedrawn = - 1;
	update( 0, 0 );

}

export function update( dt, time ) {

	if ( ! state.ready ) return;
	const ctx = state.ctx;
	const starryConfig = ctx.config.starry;
	state.uniforms.time.value = time;
	state.uniforms.skyDistance.value = ctx.camera.far * 0.8;
	// 用自己画的天空，远景的天空球藏起来
	ctx.backdrop.setSkyVisible( false );
	// 远景的补光（只影响地面底稿和画布蔓延那几秒）：月光补光抬高，再从镜头身后打一道淡光，朝着镜头的墙、坡看得清（原画村子的墙是亮的）
	const sky = ctx.world.uniforms;
	ctx.backdrop.setNightFill( starryConfig.guideLight.nightFill );
	ctx.camera.updateMatrixWorld();
	ctx.camera.getWorldDirection( tempDirection );
	ctx.world.directionToWorld( tempDirection, key, tempDirection );
	state.bounceColor.copy( sky.moonLightColor.value ).multiplyScalar( starryConfig.guideLight.bounce );
	ctx.backdrop.setBounceLight( { direction: tempDirection.set( - tempDirection.x, 0.05, - tempDirection.z ), color: state.bounceColor } );
	// 主相机看哪几层：画布盖满以后只看笔触这一层（远景不画，只给地面底稿用）；画布还在蔓延、或者调试关了地面笔触时远景照画
	const steady = ctx.pipeline.getCanvasReveal() >= 0.999 && state.uniforms.layerAmounts.ground.value > 0.5;
	ctx.camera.layers.mask = steady ? ( 1 << paintLayer ) : ( 1 | ( 1 << paintLayer ) );
	tempVector.setFromMatrixPosition( ctx.camera.matrixWorld );
	state.uniforms.spawnNearness.value = 1 - smoothJs( 4, 20, tempVector.distanceTo( state.uniforms.spawnPosition.value ) );
	state.dome.position.copy( tempVector );
	state.dome.scale.setScalar( ctx.camera.far * 0.85 );
	// 流场贴图：隔帧画（perf.scenesB.starryFlowEveryOther 关掉时 hi 每帧画）；流场的相位每秒只走 0.06 弧度，晚一帧的流场让笔差零点一二个像素。
	// 天空底稿不随时间变，只有调试开关（大漩涡、星、月）和颜料亮度会改它：进地点时画一次，之后这几个值变了才重画
	// （perf.scenesB.starrySkyOnChange 关掉时按原来每 30 帧重画一次）
	const perf = ctx.config.perf.scenesB;
	state.frame ++;
	const everyFrameFlow = ctx.quality.content === 'hi' && ! perf.starryFlowEveryOther;
	if ( everyFrameFlow || dt === 0 || state.frame % 2 === 1 ) state.flowPass.render();
	const skyInputs = [ state.uniforms.swirlAmount.value, state.uniforms.starAmount.value, state.uniforms.moonAmount.value, state.uniforms.paintLevel.value ];
	const skyChanged = skyInputs.some( ( value, index ) => value !== state.skyInputs[ index ] );
	const skyStale = perf.starrySkyOnChange ? skyChanged : state.frame - state.skyRedrawn >= 30;
	if ( state.skyRedrawn < 0 || skyStale ) {

		state.skyPass.render();
		state.skyRedrawn = state.frame;
		state.skyInputs = skyInputs;

	}

	// 流星：每隔 interval 秒一颗，偶尔两三颗连着来
	const meteorConfig = starryConfig.meteor;
	if ( time >= state.nextMeteor ) {

		const idle = state.meteors.find( ( meteor ) => ! meteor.active );
		if ( idle ) launchMeteor( idle, time, state.meteorRandom );
		const burst = state.meteorRandom() < meteorConfig.burst;
		state.nextMeteor = time + ( burst ? 0.6 + state.meteorRandom() * 0.8 : between( state.meteorRandom, meteorConfig.interval ) );

	}

	for ( const meteor of state.meteors ) updateMeteor( meteor, time, tempVector );

}

export function exit() {

	if ( ! state.ctx ) return;
	const ctx = state.ctx;
	ctx.backdrop.setSkyVisible( true );
	ctx.pipeline.setPainterly( 0 );
	if ( state.guidePrePass ) ctx.pipeline.removePrePass( state.guidePrePass );
	ctx.camera.layers.mask = 1;
	const guide = ctx.backdrop.getGuide();
	if ( guide ) guide.group.traverse( ( object ) => object.layers.disable( paintLayer ) );
	ctx.debug.removeSceneToggles( key );
	// 场景释放后 groundHeightAt 就没数据了，镜头不能再拿它贴地
	ctx.director.clearWalk();

}

function releaseResources() {

	if ( state.ctx && state.guidePrePass ) state.ctx.pipeline.removePrePass( state.guidePrePass );
	for ( const item of state.disposables ) if ( item && typeof item.dispose === 'function' ) item.dispose();
	state.disposables = [];
	state.flowPass = null;
	state.skyPass = null;
	state.groundGuide = null;
	state.guidePrePass = null;
	state.paintObjects = [];
	state.meteors = [];

}

export function dispose() {

	if ( ! state.scene && state.disposables.length === 0 ) return;
	state.ready = false;
	releaseResources();
	if ( state.scene ) state.scene.clear();
	state.scene = null;
	state.layers = {};
	state.ctx = null;
	console.log( '星空场景：已释放' );

}

export function getLayers() {

	return state.layers;

}

// 调试用：把地面底稿读回来，乘 gain 后按 c / (1 + c) 压到 0~255 画成一张图（data URL），顺便给亮度的分位数，看底稿到底什么样
export async function debugGroundGuide( gain = 20 ) {

	if ( ! state.ready ) return null;
	const target = state.groundGuide.target;
	const raw = await state.ctx.renderer.readRenderTargetPixelsAsync( target, 0, 0, target.width, target.height );
	const values = raw instanceof Uint16Array ? Array.from( raw, ( half ) => THREE.DataUtils.fromHalfFloat( half ) ) : Array.from( raw );
	const canvas = document.createElement( 'canvas' );
	canvas.width = target.width;
	canvas.height = target.height;
	const context = canvas.getContext( '2d' );
	const image = context.createImageData( target.width, target.height );
	const luminances = [];
	for ( let i = 0; i < target.width * target.height; i ++ ) {

		const [ r, g, b, a ] = values.slice( i * 4, i * 4 + 4 );
		if ( a > 0.5 ) luminances.push( 0.2126 * r + 0.7152 * g + 0.0722 * b );
		for ( let k = 0; k < 3; k ++ ) image.data[ i * 4 + k ] = Math.round( 255 * Math.pow( values[ i * 4 + k ] * gain / ( 1 + values[ i * 4 + k ] * gain ), 1 / 2.2 ) );
		image.data[ i * 4 + 3 ] = 255;

	}

	context.putImageData( image, 0, 0 );
	luminances.sort( ( first, second ) => first - second );
	const quantile = ( q ) => luminances.length ? luminances[ Math.floor( q * ( luminances.length - 1 ) ) ] : 0;
	return { url: canvas.toDataURL( 'image/png' ), width: target.width, height: target.height, quantiles: [ 0.05, 0.25, 0.5, 0.75, 0.95, 0.99 ].map( quantile ) };

}

// 调试用：把流场贴图读回来（天空坐标范围、宽高、每格 vx、vy），在外面画流线看笔会怎么走
export async function debugFlowField() {

	if ( ! state.ready ) return null;
	const target = state.flowPass.target;
	const raw = await state.ctx.renderer.readRenderTargetPixelsAsync( target, 0, 0, target.width, target.height );
	const values = raw instanceof Uint16Array ? Array.from( raw, ( half ) => THREE.DataUtils.fromHalfFloat( half ) ) : Array.from( raw );
	return { domain: skyDomain, width: target.width, height: target.height, channels: values.length / ( target.width * target.height ), values };

}

// 调试、录速度预览视频用：临时改流动的总速度倍率（不改 config 里的默认值）
export function setFlowSpeed( value ) {

	if ( state.uniforms && Number.isFinite( value ) && value > 0 ) state.uniforms.speedScale.value = value;

}
