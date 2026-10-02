// 场景 4：深夜梵高《星月夜》（规格书第 9 节）。整个画面像一幅活着的油画：天空是流动的旋涡，星星和月亮带着一圈圈的光晕，
// 左边前景一棵火焰形的黑绿柏树，下面是安静的小镇和山丘，窗户亮着暖黄的灯；几颗流星拖着笔触形状的尾巴划过，尾巴被旋涡带弯。
// 原画早已进入公有领域；这里不贴原画，全是程序化的。
//
// 天空：在"天空坐标"（相对机位朝向的方位角 × cos(仰角)、仰角，弧度）里定义流场——几个 Rankine 涡（规格书的公式：
// 速度 = 强度 / 2π × 切向 / max(距离², 半径²)）+ 一条横贯天空的大卷流 + 每颗星周围的小涡 + 一点 curl 噪声；
// 每帧在一张天空贴图上做线积分卷积（LIC，正反各积分若干步累加一张噪声，得到沿流线的笔触条纹），核函数的相位随时间推移，
// 条纹沿流线慢慢流动（涡的位置不动，看起来像颜料在流，不是一整块液体平移）；条纹值去调配色。天空球按方向取这张贴图。
// 笔触实例层：Floyd–Steinberg 抖动在天空上布点（亮的地方密），每笔沿流场方向、长度随流速，颜色取天空贴图，沿流线漂、到寿命淡出重生。
// 星和月：HDR 亮点 + 多圈正弦光环（交给泛光）；流星：头是 HDR 亮点，尾巴一条 24 段的带子，按流场偏移被旋涡带弯。
// 前景：柏树（扭曲的火焰形，2~3 级卡通色阶 + 描边 + 沿竖直方向螺旋的刷痕）；小镇、山丘、湖、城堡窗灯是常驻远景画的。
// 整个画面在后期过结构张量 + 各向异性 Kuwahara（只在 hi 档），最后的亚麻画布纹理是后期的画布层。
// 镜头几乎不动：固定机位，极慢地推近、极小的晃动，结束前慢慢抬向月亮。

import * as THREE from 'three/webgpu';
import {
	Fn, Loop, float, vec2, vec3, vec4, uniform, attribute, texture, color, select, uv,
	positionWorld, positionGeometry, normalWorld, cameraPosition,
	normalize, length, dot, max, min, mix, smoothstep, pow, abs, sin, cos, atan, asin, floor, fract, exp, step, Discard,
} from 'three/tsl';
import { hash21, valueNoise2D, createNoiseTextureData } from '../tsl/noise.js';

export const key = 'starry';

const degree = Math.PI / 180;
// 天空贴图覆盖的范围（天空坐标，弧度）：左右各 1.9（拖动转头 ±60° 再加半个视场）、仰角 −0.2 ~ 1.45
const skyDomain = { minX: - 1.9, maxX: 1.9, minY: - 0.2, maxY: 1.45 };

// 天空里的星（天空坐标 x、仰角 y、亮度、小涡的强度）：仿原画的布局，一轮新月在右上
const stars = [
	[ - 1.18, 0.62, 0.9, 0.3 ], [ - 0.92, 0.86, 1.0, - 0.28 ], [ - 0.62, 1.02, 0.8, 0.26 ], [ - 0.38, 0.74, 1.1, - 0.3 ],
	[ - 0.05, 1.12, 0.7, 0.24 ], [ 0.22, 0.86, 1.0, - 0.27 ], [ 0.48, 0.66, 0.85, 0.3 ], [ 0.66, 1.05, 0.75, - 0.25 ],
	[ 1.28, 0.62, 0.8, 0.28 ], [ - 1.45, 0.92, 0.6, - 0.22 ], [ 1.55, 0.95, 0.55, 0.22 ],
];
const moon = [ 1.02, 0.92 ];
// 大涡：中间那一对卷起来的大旋涡，和左右两个小一点的
const vortices = [
	[ - 0.28, 0.46, 0.13, 1.1 ], [ 0.06, 0.40, 0.1, - 0.9 ], [ - 0.75, 0.42, 0.09, 0.5 ], [ 0.42, 0.43, 0.09, - 0.45 ],
];

const state = {
	ctx: null,
	scene: null,
	ready: false,
	disposables: [],
	uniforms: null,
	layers: {},
	skyPass: null,
	meteors: [],
	nextMeteor: 6,
	route: null,
};

const tempVector = new THREE.Vector3();

function createRandom( seed ) {

	let value = ( seed >>> 0 ) || 1;
	return function next() {

		value = ( value + 0x6D2B79F5 ) >>> 0;
		let mixed = Math.imul( value ^ ( value >>> 15 ), 1 | value );
		mixed = ( mixed + Math.imul( mixed ^ ( mixed >>> 7 ), 61 | mixed ) ) ^ mixed;
		return ( ( mixed ^ ( mixed >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// ===================== 流场（TSL 和 JS 两份，同一套公式）=====================

// Rankine 涡：速度 = 强度 / 2π × 切向 / max(距离², 半径²)
function rankine( point, center, radius, strength ) {

	const offset = point.sub( center );
	const distanceSquared = max( dot( offset, offset ), radius * radius );
	return vec2( offset.y.negate(), offset.x ).mul( float( strength / ( 2 * Math.PI ) ).div( distanceSquared ) );

}

// 流场（天空坐标）：大涡 + 星的小涡 + 横贯天空的卷流 + 整体往右的漂 + curl 噪声。phase 让卷流的波形慢慢变（涡的位置不动）
const flowAt = Fn( ( [ point, phase ] ) => {

	const velocity = vec2( 0.05, 0 ).toVar();
	for ( const [ x, y, radius, strength ] of vortices ) velocity.addAssign( rankine( point, vec2( x, y ), radius, strength ) );
	for ( const [ x, y, , strength ] of stars ) velocity.addAssign( rankine( point, vec2( x, y ), 0.045, strength * 0.25 ) );
	velocity.addAssign( rankine( point, vec2( moon[ 0 ], moon[ 1 ] ), 0.07, - 0.12 ) );
	// 卷流：沿一条起伏的带子从左往右流，带子中心 y = 0.42 + 0.07·sin(3.1x + 0.6 + phase)
	const bandCenter = float( 0.42 ).add( sin( point.x.mul( 3.1 ).add( 0.6 ).add( phase ) ).mul( 0.07 ) );
	const bandSlope = cos( point.x.mul( 3.1 ).add( 0.6 ).add( phase ) ).mul( 0.07 * 3.1 );
	const band = exp( point.y.sub( bandCenter ).div( 0.09 ).pow2().negate() );
	velocity.addAssign( normalize( vec2( 1, bandSlope ) ).mul( band.mul( 0.55 ) ) );
	// curl 噪声：二维噪声的梯度转 90°，小振幅
	const epsilon = 0.01;
	const noisePoint = point.mul( 4 ).add( vec2( phase.mul( 0.3 ), 0 ) );
	const gradientX = valueNoise2D( noisePoint.add( vec2( epsilon, 0 ) ) ).sub( valueNoise2D( noisePoint.sub( vec2( epsilon, 0 ) ) ) );
	const gradientY = valueNoise2D( noisePoint.add( vec2( 0, epsilon ) ) ).sub( valueNoise2D( noisePoint.sub( vec2( 0, epsilon ) ) ) );
	velocity.addAssign( vec2( gradientY, gradientX.negate() ).div( 2 * epsilon ).mul( 0.012 ) );
	return velocity;

} );

function flowAtJs( x, y, phase ) {

	let vx = 0.05;
	let vy = 0;
	const add = ( cx, cy, radius, strength ) => {

		const ox = x - cx;
		const oy = y - cy;
		const distanceSquared = Math.max( ox * ox + oy * oy, radius * radius );
		vx += - oy * strength / ( 2 * Math.PI ) / distanceSquared;
		vy += ox * strength / ( 2 * Math.PI ) / distanceSquared;

	};

	for ( const [ cx, cy, radius, strength ] of vortices ) add( cx, cy, radius, strength );
	for ( const [ cx, cy, , strength ] of stars ) add( cx, cy, 0.045, strength * 0.25 );
	add( moon[ 0 ], moon[ 1 ], 0.07, - 0.12 );
	const bandCenter = 0.42 + Math.sin( x * 3.1 + 0.6 + phase ) * 0.07;
	const bandSlope = Math.cos( x * 3.1 + 0.6 + phase ) * 0.07 * 3.1;
	const band = Math.exp( - Math.pow( ( y - bandCenter ) / 0.09, 2 ) );
	const slopeLength = Math.hypot( 1, bandSlope );
	vx += band * 0.55 / slopeLength;
	vy += band * 0.55 * bandSlope / slopeLength;
	return [ vx, vy ];

}

// 天空坐标的亮度（JS 版，笔触布点用）：星和月的光晕最亮，卷流带亮一些，其余暗
function skyBrightnessJs( x, y ) {

	let value = 0.18 + 0.25 * Math.exp( - Math.pow( ( y - 0.42 ) / 0.12, 2 ) );
	for ( const [ cx, cy, brightness ] of stars ) value += brightness * 0.9 * Math.exp( - ( ( x - cx ) ** 2 + ( y - cy ) ** 2 ) / ( 0.07 ** 2 ) );
	value += 1.2 * Math.exp( - ( ( x - moon[ 0 ] ) ** 2 + ( y - moon[ 1 ] ) ** 2 ) / ( 0.12 ** 2 ) );
	return Math.min( 1, value );

}

// ===================== 天空贴图（LIC + 配色）=====================
// 一张天空坐标里的贴图（hi 1536×640），全屏片元算：流场 → 正反各积分 steps 步累加噪声（核函数相位随时间推移）→ 条纹值 → 配色 →
// 星、月、光环叠上去（HDR）
function createSkyPass( ctx, width, height, steps ) {

	const renderer = ctx.renderer;
	const uniforms = state.uniforms;
	const noiseData = createNoiseTextureData( 256, 128, 61 );
	const noiseTexture = new THREE.DataTexture( noiseData.data, noiseData.size, noiseData.size, THREE.RGBAFormat, THREE.UnsignedByteType );
	noiseTexture.wrapS = THREE.RepeatWrapping;
	noiseTexture.wrapT = THREE.RepeatWrapping;
	noiseTexture.magFilter = THREE.LinearFilter;
	noiseTexture.minFilter = THREE.LinearFilter;
	noiseTexture.needsUpdate = true;
	state.disposables.push( noiseTexture );
	const target = new THREE.RenderTarget( width, height, { type: THREE.HalfFloatType, depthBuffer: false } );
	target.texture.name = '星月夜的天空';
	target.texture.minFilter = THREE.LinearFilter;
	target.texture.magFilter = THREE.LinearFilter;
	state.disposables.push( target );

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '星月夜天空贴图';
	material.depthTest = false;
	material.depthWrite = false;
	// 全屏三角形（固定的顶点节点：预编译和真画是同一个着色器，见 4b 的坑）
	material.vertexNode = vec4( positionGeometry.xy, 0, 1 );
	material.colorNode = Fn( () => {

		const coordinate = uv();
		const point = vec2( mix( float( skyDomain.minX ), float( skyDomain.maxX ), coordinate.x ), mix( float( skyDomain.minY ), float( skyDomain.maxY ), coordinate.y ) ).toVar();
		const phase = uniforms.time.mul( 0.035 );
		const stepLength = float( 0.0045 );
		// LIC：正反各 steps 步，沿流线累加高频噪声；核函数是一个随时间往前推的正弦（条纹沿流线慢慢流）
		const sum = float( 0 ).toVar();
		const weightSum = float( 0 ).toVar();
		const forward = point.toVar();
		const backward = point.toVar();
		const flow = uniforms.flowAmount;
		Loop( steps, ( { i } ) => {

			const index = i.toFloat().add( 1 );
			forward.addAssign( normalize( flowAt( forward, phase ).add( vec2( 1e-5, 0 ) ) ).mul( stepLength ).mul( flow ) );
			backward.subAssign( normalize( flowAt( backward, phase ).add( vec2( 1e-5, 0 ) ) ).mul( stepLength ).mul( flow ) );
			const kernelForward = sin( index.div( steps ).sub( uniforms.time.mul( 0.12 ) ).mul( Math.PI * 2 ) ).mul( 0.5 ).add( 0.5 );
			const kernelBackward = sin( index.negate().div( steps ).sub( uniforms.time.mul( 0.12 ) ).mul( Math.PI * 2 ) ).mul( 0.5 ).add( 0.5 );
			// 噪声的一个格子在天空贴图上约 3~4 个像素宽（太细了沿流线一平均就成了一片灰，看不出笔触）
			sum.addAssign( texture( noiseTexture, forward.mul( 0.95 ) ).level( 0 ).r.mul( kernelForward ) );
			sum.addAssign( texture( noiseTexture, backward.mul( 0.95 ) ).level( 0 ).r.mul( kernelBackward ) );
			weightSum.addAssign( kernelForward.add( kernelBackward ) );

		} );
		const streak = sum.div( max( weightSum, 1e-3 ) ).sub( 0.5 ).mul( 3.4 ).add( 0.5 ).clamp( 0, 1 ).toVar();

		// 配色（取自原画）：群青 → 钴蓝 → 天蓝；卷流带和大涡里亮、偏蓝绿；条纹值调深浅，再加一点色相抖动
		const centerFlow = flowAt( point, phase );
		const swirl = smoothstep( 0.15, 0.9, length( centerFlow ) ).toVar();
		for ( const [ x, y, radius ] of vortices ) swirl.assign( max( swirl, exp( length( point.sub( vec2( x, y ) ) ).div( radius * 1.1 ).pow2().negate() ) ) );
		const ultramarine = color( '#1b3a8c' );
		const cobalt = color( '#2c5aa0' );
		const skyBlue = color( '#6fa3d6' );
		const lowSky = mix( cobalt, color( '#3f6fb3' ), smoothstep( 0.35, - 0.1, point.y ) );
		const base = mix( lowSky, ultramarine, smoothstep( 0.2, 1.2, point.y ) ).toVar();
		base.assign( mix( base, skyBlue, swirl.mul( 0.55 ) ) );
		base.assign( mix( base.mul( 0.7 ), mix( base, color( '#a9cbe6' ), swirl.mul( 0.35 ) ).mul( 1.15 ), streak ) );
		const hueJitter = texture( noiseTexture, point.mul( 2.3 ) ).g.sub( 0.5 );
		base.addAssign( vec3( hueJitter.mul( - 0.03 ), hueJitter.mul( 0.02 ), hueJitter.mul( 0.05 ) ) );
		const result = base.mul( 0.55 ).toVar();

		// 星：HDR 小亮点 + 一圈圈的光环（正弦的环，越往外越淡），光环的颜色柠檬黄 / 铬黄 / 月白
		for ( const [ x, y, brightness ] of stars ) {

			const distance = length( point.sub( vec2( x, y ) ) );
			// 光晕收紧（原来 0.035 / 0.05 弧度的衰减，一颗星糊成画面六分之一大的一团米色）；光环更分明，一圈黄一圈淡蓝白交替
			const core = exp( distance.div( 0.006 ).pow2().negate() ).mul( 14 * brightness );
			const glow = exp( distance.div( 0.016 ).negate() ).mul( 1.8 * brightness );
			const ringWave = sin( distance.mul( 190 ).sub( streak.mul( 2 ) ) ).mul( 0.5 ).add( 0.5 );
			const rings = ringWave.mul( ringWave ).mul( exp( distance.div( 0.034 ).negate() ) ).mul( 1.5 * brightness );
			const ringTint = mix( color( '#f2c94c' ), color( '#cfe3f0' ), step( 0.5, fract( distance.mul( 190 / ( 2 * Math.PI ) ).mul( 0.5 ) ) ) );
			const tint = mix( color( '#f7e27a' ), color( '#fff6d6' ), exp( distance.div( 0.02 ).negate() ) );
			result.addAssign( tint.mul( core.add( glow ) ).add( ringTint.mul( rings.mul( streak.mul( 0.6 ).add( 0.4 ) ) ) ).mul( uniforms.starAmount ) );

		}

		// 月：新月（一个圆减去一个偏开的圆），月白的芯 + 铬黄的大光晕和光环
		const moonOffset = point.sub( vec2( moon[ 0 ], moon[ 1 ] ) );
		const moonDistance = length( moonOffset );
		const crescent = smoothstep( 0.034, 0.03, moonDistance ).mul( smoothstep( 0.024, 0.03, length( moonOffset.sub( vec2( - 0.016, 0.01 ) ) ) ) );
		const moonGlow = exp( moonDistance.div( 0.07 ).negate() ).mul( 2.2 );
		const moonRings = sin( moonDistance.mul( 120 ).sub( streak.mul( 2.5 ) ) ).mul( 0.5 ).add( 0.5 ).mul( exp( moonDistance.div( 0.11 ).negate() ) ).mul( 1.6 );
		result.addAssign( color( '#fff6d6' ).mul( crescent.mul( 20 ) ).add( color( '#f2c94c' ).mul( moonGlow.add( moonRings.mul( streak.mul( 0.6 ).add( 0.4 ) ) ) ) ).mul( uniforms.moonAmount ) );
		// 地平线附近溶进山后的暗色（山是远景画的，天空贴图的下沿不会露出来）
		result.mulAssign( smoothstep( - 0.2, 0.05, point.y ).mul( 0.6 ).add( 0.4 ) );
		return vec4( result, 1 );

	} )();

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( [ - 1, - 1, 0, 3, - 1, 0, - 1, 3, 0 ], 3 ) );
	geometry.setAttribute( 'uv', new THREE.Float32BufferAttribute( [ 0, 0, 2, 0, 0, 2 ], 2 ) );
	const mesh = new THREE.Mesh( geometry, material );
	mesh.frustumCulled = false;
	const scene = new THREE.Scene();
	scene.add( mesh );
	const camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
	state.disposables.push( geometry, material );
	return {
		target,
		readNode: texture( target.texture ),
		render() {

			const previous = renderer.getRenderTarget();
			renderer.setRenderTarget( target );
			renderer.render( scene, camera );
			renderer.setRenderTarget( previous );

		},
		compile: () => ctx.pipeline.compileScene( scene, camera, scene, target ),
	};

}

// 天空球：按方向换成天空坐标取天空贴图；贴图外面（背后）是群青
function createSkyDome( skyPass ) {

	const uniforms = state.uniforms;
	const yaw = state.ctx.world.locations[ key ].yaw * degree;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '星月夜天空';
	material.side = THREE.BackSide;
	material.depthWrite = false;
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const direction = normalize( positionWorld.sub( cameraPosition ) );
		const worldDirection = state.ctx.backdrop.sceneDirectionToWorld( direction );
		const elevation = asin( worldDirection.y.clamp( - 1, 1 ) );
		const azimuth = atan( worldDirection.x, worldDirection.z.negate() );
		const relative = azimuth.sub( yaw );
		const wrapped = atan( sin( relative ), cos( relative ) );
		const point = vec2( wrapped.mul( cos( elevation ) ), elevation );
		const coordinate = point.sub( vec2( skyDomain.minX, skyDomain.minY ) ).div( vec2( skyDomain.maxX - skyDomain.minX, skyDomain.maxY - skyDomain.minY ) );
		const inside = coordinate.x.greaterThan( 0 ).and( coordinate.x.lessThan( 1 ) ).and( coordinate.y.greaterThan( 0 ) ).and( coordinate.y.lessThan( 1 ) );
		const painted = skyPass.readNode.sample( coordinate.clamp( 0.001, 0.999 ) ).rgb;
		return vec4( select( inside, painted, color( '#1b3a8c' ).mul( 0.45 ) ).mul( uniforms.skyAmount ), 1 );

	} )();
	const mesh = new THREE.Mesh( new THREE.SphereGeometry( 1, 64, 32 ), material );
	mesh.name = '星月夜天空';
	mesh.frustumCulled = false;
	mesh.renderOrder = 1001;
	state.disposables.push( mesh.geometry, material );
	return mesh;

}

// ===================== 笔触实例层 =====================
// Floyd–Steinberg 抖动布点：天空坐标按网格算亮度（skyBrightnessJs），误差扩散成 0/1，1 的格子放一笔（亮处密、暗处疏）
function placeStrokes( count ) {

	const columns = 360;
	const rows = 160;
	const values = new Float32Array( columns * rows );
	const width = skyDomain.maxX - skyDomain.minX;
	const height = skyDomain.maxY - skyDomain.minY;
	let total = 0;
	for ( let j = 0; j < rows; j ++ ) {

		for ( let i = 0; i < columns; i ++ ) {

			const x = skyDomain.minX + ( i + 0.5 ) / columns * width;
			const y = skyDomain.minY + ( j + 0.5 ) / rows * height;
			const value = y < 0.02 ? 0 : skyBrightnessJs( x, y );
			values[ j * columns + i ] = value;
			total += value;

		}

	}

	// 按目标笔数缩放亮度（误差扩散后 1 的个数约等于亮度总和）
	const scale = count / total;
	for ( let k = 0; k < values.length; k ++ ) values[ k ] = Math.min( 1, values[ k ] * scale );
	const random = createRandom( 2203 );
	const points = [];
	for ( let j = 0; j < rows; j ++ ) {

		for ( let i = 0; i < columns; i ++ ) {

			const index = j * columns + i;
			const old = values[ index ];
			const chosen = old >= 0.5 ? 1 : 0;
			const error = old - chosen;
			if ( chosen ) points.push( [ skyDomain.minX + ( i + random() ) / columns * width, skyDomain.minY + ( j + random() ) / rows * height ] );
			// 误差按 7/16、3/16、5/16、1/16 分给右、左下、下、右下
			if ( i + 1 < columns ) values[ index + 1 ] += error * 7 / 16;
			if ( j + 1 < rows ) {

				if ( i > 0 ) values[ index + columns - 1 ] += error * 3 / 16;
				values[ index + columns ] += error * 5 / 16;
				if ( i + 1 < columns ) values[ index + columns + 1 ] += error / 16;

			}

		}

	}

	return points;

}

function createStrokes( skyPass, count ) {

	const uniforms = state.uniforms;
	const points = placeStrokes( count );
	const random = createRandom( 991 );
	const positions = [];
	const strokeData = [];      // 天空坐标（xy）、种子（z）、长度比例（w）
	const corners = [];
	const indices = [];
	points.forEach( ( [ x, y ], index ) => {

		const seed = random();
		const lengthScale = 0.7 + random() * 0.6;
		for ( const [ u, v ] of [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ] ) {

			positions.push( 0, 0, 0 );
			strokeData.push( x, y, seed, lengthScale );
			corners.push( u, v );

		}

		indices.push( index * 4, index * 4 + 1, index * 4 + 2, index * 4, index * 4 + 2, index * 4 + 3 );

	} );

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'strokeData', new THREE.Float32BufferAttribute( strokeData, 4 ) );
	geometry.setAttribute( 'strokeCorner', new THREE.Float32BufferAttribute( corners, 2 ) );
	geometry.setIndex( positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute( indices, 1 ) : new THREE.Uint16BufferAttribute( indices, 1 ) );
	geometry.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e6 );

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '天空的笔触';
	material.transparent = true;
	material.depthWrite = false;
	material.fog = false;
	material.lights = false;
	const data = attribute( 'strokeData', 'vec4' );
	const corner = attribute( 'strokeCorner', 'vec2' );
	const phase = uniforms.time.mul( 0.035 );
	// 寿命：每笔 6~11 秒一轮，中间沿流线漂一小段，开头结尾淡入淡出
	const life = fract( uniforms.time.div( data.z.mul( 5 ).add( 6 ) ).add( data.z ) );
	const flow = flowAt( data.xy, phase );
	const direction = normalize( flow.add( vec2( 1e-5, 0 ) ) );
	const center = data.xy.add( direction.mul( life.sub( 0.5 ).mul( 0.04 ) ) );
	const strokeLength = min( length( flow ).mul( 0.05 ).add( 0.012 ), 0.045 ).mul( data.w );
	const strokeWidth = float( 0.0055 ).mul( data.w.mul( 0.5 ).add( 0.6 ) );
	const skyPoint = center.add( direction.mul( corner.x.sub( 0.5 ).mul( strokeLength ) ) ).add( vec2( direction.y.negate(), direction.x ).mul( corner.y.sub( 0.5 ).mul( strokeWidth ) ) );
	// 天空坐标 → 方向 → 远处的点（远平面的八成，比最远的山还远：山挡得住笔触，原来放在 1500 米，笔触画到了远山上面）。
	// 场景坐标就是地点局部坐标（−z 是机位朝向 yaw0），所以相对方位直接用
	const elevation = skyPoint.y;
	const relativeAzimuth = skyPoint.x.div( max( cos( elevation ), 0.2 ) );
	const localDirection = vec3( sin( relativeAzimuth ).mul( cos( elevation ) ), sin( elevation ), cos( relativeAzimuth ).mul( cos( elevation ) ).negate() );
	material.positionNode = cameraPosition.add( localDirection.mul( skyDistance() ) );
	const fade = sin( life.mul( Math.PI ) );
	material.colorNode = Fn( () => {

		// 刷痕：沿长度方向几条平行的细条纹（鬃毛）+ 两头渐隐
		const across = corner.y.sub( 0.5 ).mul( 2 );
		const along = corner.x;
		const bristles = sin( corner.y.mul( 23 ).add( data.z.mul( 40 ) ) ).mul( 0.5 ).add( 0.5 );
		const ends = smoothstep( 0, 0.18, along ).mul( smoothstep( 1, 0.7, along ) );
		const alpha = smoothstep( 1, 0.6, abs( across ) ).mul( ends ).mul( bristles.mul( 0.45 ).add( 0.55 ) ).mul( fade ).mul( uniforms.strokeAmount );
		Discard( alpha.lessThan( 0.02 ) );
		const coordinate = data.xy.sub( vec2( skyDomain.minX, skyDomain.minY ) ).div( vec2( skyDomain.maxX - skyDomain.minX, skyDomain.maxY - skyDomain.minY ) );
		const base = skyPass.readNode.sample( coordinate ).rgb;
		// 颜色：取天空贴图在这一笔中心的颜色，亮一点或暗一点（颜料的厚薄），偶尔带一点黄（星光附近）
		const pick = hash21( vec2( data.z.mul( 977 ), 3 ) );
		const shade = mix( float( 0.7 ), float( 1.45 ), pick );
		const accent = mix( color( '#6fa3d6' ), color( '#a9cbe6' ), pick ).mul( 0.6 );
		const strokeColor = mix( min( base, vec3( 3 ) ).mul( shade ), accent, select( pick.greaterThan( 0.8 ), float( 0.45 ), float( 0 ) ) );
		return vec4( strokeColor, alpha.mul( 0.9 ) );

	} )();
	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = '天空的笔触';
	mesh.frustumCulled = false;
	mesh.renderOrder = 1002;
	state.disposables.push( geometry, material );
	return { mesh, count: points.length };

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
		// 头（along = 0）HDR，尾巴往后淡；刷痕：横向几条细纹
		const head = exp( alongTail.mul( - 18 ) ).mul( 22 );
		const tail = pow( float( 1 ).sub( alongTail ), 2 ).mul( 2.2 );
		const bristles = sin( across.mul( 9 ).add( alongTail.mul( 30 ) ) ).mul( 0.25 ).add( 0.75 );
		const tint = mix( color( '#fff6d6' ), color( '#f7e27a' ), alongTail );
		return vec4( tint.mul( head.add( tail ) ).mul( bristles ).mul( brightness ).mul( state.uniforms.meteorAmount ), 1 );

	} )();
	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = '流星';
	mesh.frustumCulled = false;
	mesh.renderOrder = 1003;
	mesh.visible = false;
	state.disposables.push( geometry, material );
	return { mesh, brightness, active: false, start: 0, duration: 1.5, from: [ 0, 0 ], to: [ 0, 0 ] };

}

function launchMeteor( meteor, time, random ) {

	const startX = - 1.1 + random() * 2.2;
	const startY = 0.75 + random() * 0.45;
	const angle = - ( 0.25 + random() * 0.5 ) * ( random() < 0.5 ? 1 : - 1 );
	const length = 0.35 + random() * 0.3;
	meteor.from = [ startX, startY ];
	meteor.to = [ startX + Math.cos( angle ) * length * Math.sign( Math.cos( angle ) ), startY - Math.abs( Math.sin( angle ) ) * length - 0.12 ];
	meteor.start = time;
	meteor.duration = 1.2 + random() * 0.8;
	meteor.active = true;
	meteor.mesh.visible = true;

}

const meteorPoint = new THREE.Vector3();
const meteorSide = new THREE.Vector3();
const meteorDirection = new THREE.Vector3();

function updateMeteor( meteor, time, cameraLocal ) {

	if ( ! meteor.active ) return;
	const progress = ( time - meteor.start ) / meteor.duration;
	if ( progress > 1.6 ) {

		meteor.active = false;
		meteor.mesh.visible = false;
		return;

	}

	// 亮度：快速亮起，走完以后尾巴慢慢淡
	meteor.brightness.value = Math.min( 1, progress * 6 ) * ( 1 - smoothJs( 0.9, 1.6, progress ) );
	const distance = skyDistance();
	const positions = meteor.mesh.geometry.attributes.position;
	const phase = time * 0.035;
	for ( let i = 0; i <= meteorSegments; i ++ ) {

		const age = i / meteorSegments * 0.35;
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
		const width = 0.0035 * ( 1 - i / meteorSegments * 0.7 ) * distance;
		for ( let s = 0; s < 2; s ++ ) {

			const sign = s === 0 ? - 1 : 1;
			positions.setXYZ( i * 2 + s, cameraLocal.x + meteorPoint.x * distance + meteorSide.x * width * sign, cameraLocal.y + meteorPoint.y * distance + meteorSide.y * width * sign, cameraLocal.z + meteorPoint.z * distance + meteorSide.z * width * sign );

		}

	}

	positions.needsUpdate = true;

}

// 天空坐标 → 局部方向（地点局部坐标的 −z 是 yaw0 方位，所以相对方位直接用）
function localSkyDirection( x, y, target ) {

	const azimuth = x / Math.max( 0.2, Math.cos( y ) );
	return target.set( Math.sin( azimuth ) * Math.cos( y ), Math.sin( y ), - Math.cos( azimuth ) * Math.cos( y ) );

}

// 笔触、流星画在离镜头多远（米）：远平面的八成，在所有远山后面、天空球（0.85）里面
function skyDistance() {

	return state.ctx.camera.far * 0.8;

}

function smoothJs( edge0, edge1, value ) {

	const amount = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return amount * amount * ( 3 - 2 * amount );

}

// ===================== 柏树 =====================
// 火焰形：一圈轮廓（下宽上尖、腰部鼓一点）沿高度扭转，再叠几道往上卷的"火舌"（按高度和角度的正弦把半径推出去），
// 黑绿色，2~3 级卡通色阶 + 描边（背面朝外放大一点的黑壳）+ 沿竖直方向螺旋的刷痕
function buildCypress( height, radius ) {

	const around = 28;
	const rows = 60;
	const positions = [];
	const indices = [];
	for ( let row = 0; row <= rows; row ++ ) {

		const along = row / rows;
		const profile = Math.pow( Math.sin( Math.PI * Math.min( 1, along * 1.05 + 0.04 ) ), 0.7 ) * ( 1 - along * 0.55 );
		const twist = along * 2.2;
		for ( let k = 0; k <= around; k ++ ) {

			const angle = k / around * Math.PI * 2 + twist;
			// 火舌：三道螺旋的鼓包往上卷
			const tongue = 1 + 0.75 * Math.pow( Math.max( 0, Math.sin( angle * 3 - along * 11 ) ), 1.3 ) * Math.sin( Math.PI * Math.min( 1, along * 1.1 ) ) + 0.15 * Math.sin( angle * 2 + along * 6 );
			// 上面三成分成三道螺旋上卷的火舌（原画柏树顶上是几个舔上去的尖），中间凹进去
			const tips = 0.3 + 0.7 * Math.pow( Math.max( 0, Math.cos( angle * 3 - along * 9 ) ), 0.6 );
			const r = radius * profile * tongue * ( 1 + ( tips - 1 ) * smoothJs( 0.6, 0.95, along ) );
			// 轴线 S 形摆（像火苗被风吹着）
			const swayX = radius * 0.9 * Math.sin( along * 4.2 ) * along;
			const swayZ = radius * 0.5 * Math.cos( along * 3.1 ) * along;
			positions.push( Math.cos( angle ) * r + swayX, along * height, Math.sin( angle ) * r + swayZ );

		}

	}

	for ( let row = 0; row < rows; row ++ ) {

		for ( let k = 0; k < around; k ++ ) {

			const a = row * ( around + 1 ) + k;
			const b = a + around + 1;
			indices.push( a, b, a + 1, a + 1, b, b + 1 );

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setIndex( indices );
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	return geometry;

}

function createCypressMaterial( noiseTexture ) {

	const sky = state.ctx.world.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '柏树（星月夜）';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const local = positionGeometry;
		const normal = normalize( normalWorld );
		// 光：月光（天空右上）+ 天光；分成三级色阶
		const light = max( dot( state.ctx.backdrop.sceneDirectionToWorld( normal ), sky.moonDirection ), 0 ).mul( 0.7 ).add( normal.y.mul( 0.2 ) ).add( 0.25 );
		const band = floor( light.clamp( 0, 0.99 ).mul( 3 ) ).div( 2 );
		// 刷痕：沿竖直方向螺旋（角度随高度转），一道道深浅
		const angle = atan( local.z, local.x );
		const strokes = texture( noiseTexture, vec2( angle.mul( 2.2 ).add( local.y.mul( 0.25 ) ), local.y.mul( 0.035 ) ) ).r;
		// 原画柏树的颜色：墨绿 → 暗绿 → 一点暗蓝和土黄的笔触
		// 刷痕再明显一些（原来混 0.45、颜色又暗，整棵树是一块平的黑剪影）：亮的那几道是橄榄绿、土黄
		const albedo = mix( mix( color( '#1d2e1f' ), color( '#3d5c34' ), band ), mix( color( '#2a3a5a' ), color( '#8a8442' ), strokes ), smoothstep( 0.5, 0.8, strokes ).mul( 0.7 ) );
		// 柏树是画里最暗的东西：大气透视只算一半（全算会被夜雾抬成灰的）
		const surface = albedo.mul( mix( float( 0.55 ), float( 1.15 ), band ) ).mul( 0.85 );
		return mix( state.ctx.backdrop.worldAtmosphere( surface, positionWorld ), surface, 0.5 );

	} )();
	return material;

}

// 描边：同一个几何体沿法线放大一点、只画背面、纯黑
function createOutlineMaterial() {

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '柏树描边';
	material.side = THREE.BackSide;
	material.fog = false;
	material.lights = false;
	material.positionNode = positionGeometry.add( attribute( 'normal', 'vec3' ).mul( 0.18 ) );
	material.colorNode = vec4( color( '#05070a' ), 1 );
	return material;

}

// ===================== init =====================

export async function init( ctx ) {

	if ( state.scene ) {

		console.warn( '星空场景：init 被重复调用，先释放旧的再重建' );
		dispose();

	}

	if ( ! ctx.backdrop || ! ctx.world || ! ctx.backdrop.getRoot() ) throw new Error( '星空场景：要先建好秘境（ctx.world、ctx.backdrop）' );
	try {

		return await build( ctx );

	} catch ( error ) {

		releaseResources();
		throw error;

	}

}

async function build( ctx ) {

	const started = performance.now();
	state.ctx = ctx;
	state.disposables = [];
	const starryConfig = ctx.config.starry;
	const content = ctx.quality.content;
	const scene = new THREE.Scene();
	scene.name = '星月夜';
	scene.background = new THREE.Color( 0x000000 );
	state.scene = scene;
	state.uniforms = {
		time: uniform( 0 ),
		flowAmount: uniform( 1 ),
		starAmount: uniform( 1 ),
		moonAmount: uniform( 1 ),
		skyAmount: uniform( 1 ),
		strokeAmount: uniform( 1 ),
		meteorAmount: uniform( 1 ),
	};

	const skySize = starryConfig.skyResolution[ content ] || starryConfig.skyResolution.mid;
	state.skyPass = createSkyPass( ctx, skySize[ 0 ], skySize[ 1 ], starryConfig.licSteps[ content ] || starryConfig.licSteps.mid );
	const dome = createSkyDome( state.skyPass );
	scene.add( dome );
	state.dome = dome;
	const strokes = createStrokes( state.skyPass, starryConfig.strokes[ content ] || starryConfig.strokes.mid );
	scene.add( strokes.mesh );

	state.meteors = [];
	for ( let i = 0; i < 3; i ++ ) {

		const meteor = createMeteor();
		scene.add( meteor.mesh );
		state.meteors.push( meteor );

	}

	state.meteorRandom = createRandom( 1889 );
	state.nextMeteor = 4;

	// 柏树：机位左前方，高 26 米，画面左边从地面一直伸进天空
	const noiseData = createNoiseTextureData( 256, 32, 13 );
	const noiseTexture = new THREE.DataTexture( noiseData.data, noiseData.size, noiseData.size, THREE.RGBAFormat, THREE.UnsignedByteType );
	noiseTexture.wrapS = THREE.RepeatWrapping;
	noiseTexture.wrapT = THREE.RepeatWrapping;
	noiseTexture.magFilter = THREE.LinearFilter;
	noiseTexture.minFilter = THREE.LinearMipmapLinearFilter;
	noiseTexture.generateMipmaps = true;
	noiseTexture.needsUpdate = true;
	state.disposables.push( noiseTexture );
	const cypressGeometry = buildCypress( starryConfig.cypress.height, starryConfig.cypress.radius );
	const cypressMaterial = createCypressMaterial( noiseTexture );
	const outlineMaterial = createOutlineMaterial();
	const cypress = new THREE.Mesh( cypressGeometry, cypressMaterial );
	const outline = new THREE.Mesh( cypressGeometry, outlineMaterial );
	const [ cypressX, cypressZ ] = starryConfig.cypress.position;
	const ground = groundHeightAt( cypressX, cypressZ );
	for ( const mesh of [ cypress, outline ] ) {

		mesh.position.set( cypressX, ground - 1, cypressZ );
		mesh.name = '柏树';
		scene.add( mesh );

	}

	state.disposables.push( cypressGeometry, cypressMaterial, outlineMaterial );

	const visibility = ( ...objects ) => ( enabled ) => {

		for ( const object of objects ) object.visible = enabled;

	};
	state.layers = {
		流场流动: state.uniforms.flowAmount,
		天空: state.uniforms.skyAmount,
		星: state.uniforms.starAmount,
		月: state.uniforms.moonAmount,
		笔触: state.uniforms.strokeAmount,
		流星: state.uniforms.meteorAmount,
		柏树: visibility( cypress, outline ),
	};

	state.ready = true;
	console.log( `星月夜：建好了，用时 ${ ( performance.now() - started ).toFixed( 0 ) } ms；天空贴图 ${ skySize[ 0 ] }×${ skySize[ 1 ] }、LIC ${ starryConfig.licSteps[ content ] || starryConfig.licSteps.mid } 步、笔触 ${ strokes.count } 笔` );
	return { scene };

}

// 预编译：天空贴图那一遍（它画进自己的渲染目标）
export async function compile() {

	if ( ! state.ready ) return;
	await state.skyPass.compile();

}

// ===================== 进出、每帧 =====================

export function getSpawn() {

	const ctx = state.ctx;
	const location = ctx.world.locations[ key ];
	const ground = ctx.backdrop.getTerrainHeight( location.origin[ 0 ], location.origin[ 2 ] );
	const eye = Math.max( 0, ground + ctx.config.camera.eyeHeight - location.origin[ 1 ] );
	const town = ctx.world.toLocal( tempVector.fromArray( location.landmark ), key, new THREE.Vector3() );
	return { position: [ 0, eye, 0 ], lookAt: [ town.x, town.y + 72, town.z ] };

}

// 本地 (x, z) 的地面高度（全景烘焙点、柏树按它放）
export function groundHeightAt( x, z ) {

	const ctx = state.ctx;
	ctx.world.toWorld( tempVector.set( x, 0, z ), key, tempVector );
	return ctx.backdrop.getTerrainHeight( tempVector.x, tempVector.z ) - ctx.world.locations[ key ].origin[ 1 ];

}

export function enter() {

	if ( ! state.ready ) throw new Error( '星空场景：还没 init 就调了 enter' );
	const ctx = state.ctx;
	// 固定机位，极慢地推近；最后十几秒慢慢抬头看月亮（拖动转头 ±60° / ±25°，松手阻尼回正）
	const spawn = getSpawn();
	const duration = ctx.config.scenes.find( ( item ) => item.key === key ).duration;
	const start = new THREE.Vector3().fromArray( spawn.position );
	const look = new THREE.Vector3().fromArray( spawn.lookAt );
	const forward = look.clone().sub( start ).setY( 0 ).normalize();
	const moonDirection = localSkyDirection( moon[ 0 ], moon[ 1 ], new THREE.Vector3() );
	const moonLook = start.clone().addScaledVector( moonDirection, 400 );
	ctx.director.setRoute( [
		{ time: 0, position: spawn.position, lookAt: spawn.lookAt },
		{ time: duration - 16, position: start.clone().addScaledVector( forward, 4 ).toArray(), lookAt: spawn.lookAt },
		{ time: duration, position: start.clone().addScaledVector( forward, 5 ).toArray(), lookAt: look.clone().lerp( moonLook, 0.55 ).toArray() },
	] );
	for ( const label of Object.keys( state.layers ) ) ctx.debug.addLayerToggle( key, label, state.layers[ label ] );
	ctx.pipeline.setPainterly( ctx.quality.content === 'hi' ? ctx.config.starry.kuwahara : 0 );
	update( 0, 0 );

}

export function update( dt, time ) {

	if ( ! state.ready ) return;
	const ctx = state.ctx;
	state.uniforms.time.value = time;
	// 用自己画的天空，远景的天空球藏起来（远景的山、小镇、湖、城堡窗灯照常）
	ctx.backdrop.setSkyVisible( false );
	ctx.camera.updateMatrixWorld();
	tempVector.setFromMatrixPosition( ctx.camera.matrixWorld );
	state.dome.position.copy( tempVector );
	state.dome.scale.setScalar( ctx.camera.far * 0.85 );
	// 天空贴图：hi 每帧画，其余档隔一帧
	state.frame = ( state.frame || 0 ) + 1;
	if ( ctx.quality.content === 'hi' || state.frame % 2 === 0 || dt === 0 ) state.skyPass.render();

	// 流星：每隔 6~15 秒一颗，偶尔两三颗连着来
	if ( time >= state.nextMeteor ) {

		const idle = state.meteors.find( ( meteor ) => ! meteor.active );
		if ( idle ) launchMeteor( idle, time, state.meteorRandom );
		const burst = state.meteorRandom() < 0.25;
		state.nextMeteor = time + ( burst ? 0.6 + state.meteorRandom() * 0.8 : 6 + state.meteorRandom() * 9 );

	}

	for ( const meteor of state.meteors ) updateMeteor( meteor, time, tempVector );

}

export function exit() {

	if ( ! state.ctx ) return;
	const ctx = state.ctx;
	ctx.backdrop.setSkyVisible( true );
	ctx.pipeline.setPainterly( 0 );
	ctx.debug.removeSceneToggles( key );

}

function releaseResources() {

	for ( const item of state.disposables ) if ( item && typeof item.dispose === 'function' ) item.dispose();
	state.disposables = [];
	state.skyPass = null;
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

