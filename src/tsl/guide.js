// 引路的花瓣和光点（规格书 5.3，阶段 12）：一股花瓣和光点领着走，像渔人"缘溪行"时顺水漂来的落英。
//
// 路径：时间线每帧往 pathPoints 里写最多 40 个点（世界坐标，w 是这一处的宽窄倍数，窄处小），从镜头开始往前排；
// 粒子在顶点着色器里按"沿路径的进度 + 横截面上的位置"算出来，进度随 flowPhase 往前流，JS 不逐帧动粒子。
// 三种队形按 uniform 混：沿路径流（起飞、巡航、钻进窄处）、围着镜头打旋（停留最后几秒聚起来，gather）、
// 散开淡出（穿出窄处以后，scatter）。粒子按自己的门槛依次出现（amount 从 0 到 1 时一片一片冒出来，不是整团一下子出现）。
// 花瓣：不透明、按形状丢弃像素、写深度，绕自己的随机轴翻转；光点：对着镜头的小方片，加法混进 HDR（交给泛光），
// 远处至少画 2 个像素，不然一条光带到远处就断成噪点。
// 离镜头 keepDistance 米以内的粒子往场景目标的 alpha 里写"别被薄雾吞掉"：后期的同色薄雾按 1 − alpha 让开（见 pipeline.js），
// 起飞时整屏进雾，身边的几片花瓣还在，领着人出去。

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, uniform, uniformArray, attribute, varying, Discard,
	positionWorld, cameraPosition, cameraViewMatrix, cameraProjectionMatrix, modelWorldMatrix, screenSize,
	normalize, length, dot, cross, max, min, mix, smoothstep, sin, cos, abs, fract, pow, exp, select,
} from 'three/tsl';

export const pathPointCount = 40;

// 确定性随机数（mulberry32）：每次建出来的粒子一样，截图、烘焙能复现
function createRandom( seed ) {

	let value = ( seed >>> 0 ) || 1;
	return function next() {

		value = ( value + 0x6D2B79F5 ) | 0;
		let mixed = Math.imul( value ^ ( value >>> 15 ), 1 | value );
		mixed = ( mixed + Math.imul( mixed ^ ( mixed >>> 7 ), 61 | mixed ) ) ^ mixed;
		return ( ( mixed ^ ( mixed >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// count 个方片合成一个几何体：四个角共用同一组随机数（不然四个角各自乱飘，方片被拉成长条）
function buildQuads( count, seed ) {

	const random = createRandom( seed );
	const positions = new Float32Array( count * 4 * 3 );
	const corners = new Float32Array( count * 4 * 2 );
	const seedsA = new Float32Array( count * 4 * 4 );
	const seedsB = new Float32Array( count * 4 * 4 );
	const indices = new Uint32Array( count * 6 );
	const cornerList = [ [ - 0.5, - 0.5 ], [ 0.5, - 0.5 ], [ 0.5, 0.5 ], [ - 0.5, 0.5 ] ];
	for ( let i = 0; i < count; i ++ ) {

		const a = [ random(), random(), random(), random() ];
		const b = [ random(), random(), random(), random() ];
		for ( let k = 0; k < 4; k ++ ) {

			const vertex = i * 4 + k;
			corners.set( cornerList[ k ], vertex * 2 );
			seedsA.set( a, vertex * 4 );
			seedsB.set( b, vertex * 4 );

		}

		indices.set( [ i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3 ], i * 6 );

	}

	const geometry = new THREE.BufferGeometry();
	// position 只是占个数（顶点数要从它来），真正的位置在着色器里算
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'guideCorner', new THREE.BufferAttribute( corners, 2 ) );
	geometry.setAttribute( 'guideSeedA', new THREE.BufferAttribute( seedsA, 4 ) );
	geometry.setAttribute( 'guideSeedB', new THREE.BufferAttribute( seedsB, 4 ) );
	geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );
	geometry.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e5 );
	return geometry;

}

// options：
//   petalCount、moteCount：花瓣、光点个数；settings：config.guide；
//   shadePetal( albedo, normal, point ) → 花瓣着色后的颜色（normal、point 是场景坐标；用远景的世界光照和大气）
export function createGuide( { petalCount, moteCount, settings, shadePetal } ) {

	const uniforms = {
		time: uniform( 0 ),
		pathPoints: uniformArray( Array.from( { length: pathPointCount }, () => new THREE.Vector4( 0, 0, 0, 1 ) ), 'vec4' ),
		flowPhase: uniform( 0 ),              // 沿路径流过了几圈（整条路径算 1）
		amount: uniform( 0 ),                 // 0 全收起，1 全部出来
		petalAmount: uniform( 1 ),            // 夜里花瓣收起来，换萤火虫
		moteAmount: uniform( 1 ),
		nearSpread: uniform( settings.nearSpread ),
		farSpread: uniform( settings.farSpread ),
		gather: uniform( 0 ),
		gatherCenter: uniform( new THREE.Vector3() ),
		gatherRadius: uniform( settings.gatherRadius ),
		swirl: uniform( 1 ),                  // 打旋快慢倍数（花瓣风暴时调大）
		scatter: uniform( 0 ),
		petalColorA: uniform( new THREE.Color( settings.petalColors[ 0 ] ) ),
		petalColorB: uniform( new THREE.Color( settings.petalColors[ 1 ] ) ),
		moteColor: uniform( new THREE.Color( settings.dayMoteColor ) ),
		moteIntensity: uniform( settings.moteIntensity ),
		keepDistance: uniform( settings.keepDistance ),
		petalSizeMin: uniform( settings.petalSize[ 0 ] ),
		petalSizeMax: uniform( settings.petalSize[ 1 ] ),
		moteSize: uniform( settings.moteSize ),
	};

	// 沿路径取点：progress 0~1 → 折线上的位置（xyz）和宽窄倍数（w），以及这一段的方向
	const pathSample = ( progress ) => {

		const scaled = progress.clamp( 0, 0.9999 ).mul( pathPointCount - 1 );
		const index = scaled.floor().toInt();
		const fraction = fract( scaled );
		const from = uniforms.pathPoints.element( index );
		const to = uniforms.pathPoints.element( index.add( 1 ) );
		return { point: mix( from, to, fraction ), direction: to.xyz.sub( from.xyz ) };

	};

	// 一个粒子的位置（世界坐标）和可见程度。seedA = (起始进度, 半径, 角度, 出现门槛)，seedB = (打旋, 速度, 高低, 散开门槛)
	// concentration：横截面上往里圈聚的程度（1 均匀，越大越聚）
	const particle = ( seedA, seedB, concentration = 0.5 ) => {

		const time = uniforms.time;
		// 每个粒子流速差 ±25%，前后拉开，不是一排排整齐地走；进度按 1.6 次方排，镜头附近密、远处稀
		const travel = fract( seedA.x.add( uniforms.flowPhase.mul( seedB.y.mul( 0.5 ).add( 0.75 ) ) ) );
		const progress = pow( travel, 1.6 );
		const sample = pathSample( progress );
		const forward = normalize( sample.direction.add( vec3( 1e-4, 0, 1e-4 ) ) );
		const side = normalize( cross( forward, vec3( 0, 1, 0 ) ).add( vec3( 1e-4, 0, 0 ) ) );
		const up = cross( side, forward );

		// 横截面：一个环（中间空出来，粒子不挡视线正中），近处窄远处宽，窄处按 w 收拢，散开时往外推 3.5 倍
		const spread = mix( uniforms.nearSpread, uniforms.farSpread, progress ).mul( sample.point.w ).mul( uniforms.scatter.mul( 2.5 ).add( 1 ) );
		// 近处中间空出来（不挡视线正中），远处不空（远处一个空心环在屏幕上会缩成一个圆圈）
		const hollow = mix( float( 0.35 ), float( 0 ), smoothstep( 0.05, 0.4, progress ) );
		const radius = spread.mul( mix( hollow, float( 1 ), pow( seedA.y, concentration ) ) );
		const angle = seedA.z.mul( Math.PI * 2 ).add( time.mul( seedB.x.sub( 0.5 ) ).mul( 1.2 ).mul( uniforms.swirl ) );
		const flowPosition = sample.point.xyz.add( side.mul( cos( angle ).mul( radius ) ) ).add( up.mul( sin( angle ).mul( radius ).mul( 0.65 ) ) );

		// 围着镜头打旋：绕竖直轴慢慢转，高低错开，半径 0.35~1 倍
		const orbitAngle = seedA.z.mul( Math.PI * 2 ).add( time.mul( seedB.y.mul( 0.5 ).add( 0.35 ) ).mul( uniforms.swirl ) );
		const orbitRadius = uniforms.gatherRadius.mul( seedA.y.mul( 0.65 ).add( 0.35 ) );
		const orbitHeight = seedB.z.sub( 0.5 ).mul( 2.4 ).add( sin( time.mul( 0.7 ).add( seedA.w.mul( 6.283 ) ) ).mul( 0.3 ) );
		const orbit = uniforms.gatherCenter.add( vec3( cos( orbitAngle ).mul( orbitRadius ), orbitHeight, sin( orbitAngle ).mul( orbitRadius ) ) );
		// 每个粒子松开的时刻错开（gather 从 1 落到 0 时一片一片被路径带走）
		const gatherWeight = smoothstep( seedB.x.mul( 0.4 ), seedB.x.mul( 0.4 ).add( 0.6 ), uniforms.gather );
		const center = mix( flowPosition, orbit, gatherWeight );

		// 可见：自己的门槛 < amount 才出来；路径两头淡（镜头跟前取模换位、远处尽头都看不出来）；散开时按门槛依次淡掉
		const appear = smoothstep( seedA.w.mul( 0.9 ), seedA.w.mul( 0.9 ).add( 0.1 ), uniforms.amount );
		// 进度很小的那几个在镜头身后（路径从身后开始），换位时看不见；只在尽头淡掉
		const alongFade = smoothstep( 0, 0.008, progress ).mul( float( 1 ).sub( smoothstep( 0.45, 1, progress ) ) );
		const fade = mix( alongFade, float( 1 ), gatherWeight );
		const scatterFade = float( 1 ).sub( smoothstep( seedB.w.mul( 0.6 ), seedB.w.mul( 0.6 ).add( 0.4 ), uniforms.scatter ) );
		return { center, visible: appear.mul( fade ).mul( scatterFade ) };

	};

	// "别被薄雾吞掉"的程度：keepDistance 以内 1，往外 0.6 倍的距离里淡到 0
	const keepAt = ( distance ) => float( 1 ).sub( smoothstep( uniforms.keepDistance.mul( 0.7 ), uniforms.keepDistance.mul( 1.3 ), distance ) );

	// ===================== 花瓣 =====================
	const petalGeometry = buildQuads( petalCount, 71 );
	const petalMaterial = new THREE.MeshBasicNodeMaterial();
	petalMaterial.name = '引路花瓣';
	petalMaterial.side = THREE.DoubleSide;
	petalMaterial.fog = false;
	petalMaterial.lights = false;
	// 颜色直接覆盖（等同不透明），alpha 通道乘 (1 − keep)：后期按它让开薄雾
	petalMaterial.blending = THREE.CustomBlending;
	petalMaterial.blendSrc = THREE.OneFactor;
	petalMaterial.blendDst = THREE.ZeroFactor;
	petalMaterial.blendSrcAlpha = THREE.ZeroFactor;
	petalMaterial.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
	{

		const corner = attribute( 'guideCorner', 'vec2' );
		const seedA = attribute( 'guideSeedA', 'vec4' );
		const seedB = attribute( 'guideSeedB', 'vec4' );
		const { center, visible } = particle( seedA, seedB );
		const centerVar = center.toVar( 'guidePetalCenter' );
		// 翻转：绕随机轴转，转速 1.5~4 弧度/秒（Rodrigues 公式，同 tsl/petals.js）
		const axis = normalize( vec3( seedB.z, seedA.y, seedB.x ).sub( 0.5 ).add( vec3( 0.001, 0.002, 0.003 ) ) );
		const angle = uniforms.time.mul( seedA.z.mul( 2.5 ).add( 1.5 ) ).add( seedB.w.mul( 6.28 ) );
		const rotate = ( vector ) => vector.mul( cos( angle ) ).add( cross( axis, vector ).mul( sin( angle ) ) ).add( axis.mul( dot( axis, vector ) ).mul( float( 1 ).sub( cos( angle ) ) ) );
		// 贴脸的（0.4 米以内）缩掉，不会一大片糊在镜头上
		const viewer = modelWorldMatrix.mul( vec4( centerVar, 1 ) ).xyz.sub( cameraPosition );
		const nearCamera = smoothstep( 0.3, 0.7, length( viewer ) );
		const size = mix( uniforms.petalSizeMin, uniforms.petalSizeMax, seedB.z ).mul( visible ).mul( nearCamera ).mul( uniforms.petalAmount );
		const local = vec3( corner.x.mul( 0.62 ), corner.y, 0 ).mul( size );
		petalMaterial.positionNode = centerVar.add( rotate( local ) );
		const petalNormal = varying( rotate( vec3( 0, 0, 1 ) ), 'guidePetalNormal' );
		const petalMix = varying( seedB.x, 'guidePetalMix' );

		petalMaterial.colorNode = Fn( () => {

			// 花瓣形状：一头圆一头尖，圆头一个小缺口（桃花瓣），同 tsl/petals.js
			const uv = corner.mul( 2 );
			const along = uv.y.mul( 0.5 ).add( 0.5 );
			const halfWidth = sin( along.mul( Math.PI ) ).mul( mix( float( 0.65 ), float( 1 ), along ) );
			const inside = float( 1 ).sub( smoothstep( halfWidth.mul( 0.85 ), halfWidth, abs( uv.x ) ) );
			const notch = smoothstep( 0.08, 0.16, length( vec2( uv.x, uv.y.sub( 1 ) ) ) );
			Discard( inside.mul( notch ).lessThan( 0.5 ) );

			const normal = normalize( modelWorldMatrix.mul( vec4( petalNormal, 0 ) ).xyz );
			const toViewer = normalize( cameraPosition.sub( positionWorld ) );
			const facing = select( dot( normal, toViewer ).greaterThan( 0 ), normal, normal.negate() );
			const albedo = mix( uniforms.petalColorA, uniforms.petalColorB, petalMix ).mul( mix( float( 0.82 ), float( 1 ), along ) );
			const shaded = shadePetal( albedo, facing, positionWorld );
			return vec4( shaded, keepAt( length( positionWorld.sub( cameraPosition ) ) ) );

		} )();

	}

	const petals = new THREE.Mesh( petalGeometry, petalMaterial );
	petals.name = '引路花瓣';
	petals.frustumCulled = false;
	// 不透明队列里排在后面：星月夜的笔触（不做深度测试，renderOrder 5）画完再画花瓣，花瓣在画上面
	petals.renderOrder = 30;

	// ===================== 光点 =====================
	const moteGeometry = buildQuads( moteCount, 113 );
	const moteMaterial = new THREE.MeshBasicNodeMaterial();
	moteMaterial.name = '引路光点';
	moteMaterial.transparent = true;
	moteMaterial.depthWrite = false;
	moteMaterial.fog = false;
	moteMaterial.lights = false;
	// 颜色加法（HDR 里叠上去），alpha 通道同花瓣
	moteMaterial.blending = THREE.CustomBlending;
	moteMaterial.blendSrc = THREE.OneFactor;
	moteMaterial.blendDst = THREE.OneFactor;
	moteMaterial.blendSrcAlpha = THREE.ZeroFactor;
	moteMaterial.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
	{

		const corner = attribute( 'guideCorner', 'vec2' );
		const seedA = attribute( 'guideSeedA', 'vec4' );
		const seedB = attribute( 'guideSeedB', 'vec4' );
		const { center, visible } = particle( seedA, seedB, 1.8 );
		// 对着镜头的小方片，在视图空间里搭；屏幕上至少 minPixels 个像素，放大时按面积降亮度的一半（远处不会一片光斑，也不会断）
		const sceneCenter = modelWorldMatrix.mul( vec4( center, 1 ) ).xyz;
		const viewCenter = cameraViewMatrix.mul( vec4( sceneCenter, 1 ) ).xyz.toVar( 'guideMoteView' );
		const pixelAngle = float( 2 ).div( cameraProjectionMatrix[ 1 ][ 1 ].mul( screenSize.y ) );
		const baseSize = uniforms.moteSize.mul( seedB.z.mul( 0.8 ).add( 0.6 ) );
		const minimumSize = pixelAngle.mul( length( viewCenter ) ).mul( settings.moteMinPixels );
		// 贴脸的光点：3 厘米的光点在 0.2 米外有上百像素，泛光一扩就是一大团光斑（开场洞里 2026-10-02 自查）。
		// 屏幕上最大 9 像素（原来 14，哥特停留末尾聚起来时又大又糊、盖满城堡，审查 R37），离镜头 0.9 米以内慢慢淡掉
		const maximumSize = pixelAngle.mul( length( viewCenter ) ).mul( 9 );
		const size = min( max( baseSize, minimumSize ), max( maximumSize, minimumSize ) );
		const energy = mix( float( 1 ), pow( min( baseSize.div( size ), 1 ), 2 ), 0.5 );
		const shown = visible.mul( uniforms.moteAmount ).mul( smoothstep( 0.35, 0.9, length( viewCenter ) ) );
		moteMaterial.vertexNode = cameraProjectionMatrix.mul( vec4( viewCenter.add( vec3( corner.mul( size ).mul( select( shown.greaterThan( 0.001 ), float( 1 ), float( 0 ) ) ), 0 ) ), 1 ) );
		const moteBrightness = varying( shown.mul( energy ), 'guideMoteBrightness' );
		const moteDistance = varying( length( viewCenter ), 'guideMoteDistance' );
		const motePhase = varying( seedA.w.mul( 6.283 ).add( seedB.y.mul( 40 ) ), 'guideMotePhase' );
		const moteRate = varying( seedB.x.mul( 3 ).add( 1.5 ), 'guideMoteRate' );

		moteMaterial.colorNode = Fn( () => {

			const offset = corner.mul( 2 );
			const glow = exp( dot( offset, offset ).mul( - 4.5 ) );
			// 轻轻一闪一闪（萤火虫那种呼吸，不是频闪）
			const twinkle = sin( uniforms.time.mul( moteRate ).add( motePhase ) ).mul( 0.35 ).add( 0.65 );
			const light = uniforms.moteColor.mul( glow.mul( twinkle ).mul( moteBrightness ).mul( uniforms.moteIntensity ) );
			return vec4( light, keepAt( moteDistance ).mul( min( glow.mul( 2 ), 1 ) ).mul( min( moteBrightness.mul( 4 ), 1 ) ) );

		} )();

	}

	const motes = new THREE.Mesh( moteGeometry, moteMaterial );
	motes.name = '引路光点';
	motes.frustumCulled = false;
	motes.renderOrder = 20;

	const group = new THREE.Group();
	group.name = '引路';
	group.add( petals, motes );

	// 写路径：points 是 [{ x, y, z, width }]（世界坐标），不够 40 个时最后一个点重复
	function setPath( points ) {

		const array = uniforms.pathPoints.array;
		for ( let i = 0; i < pathPointCount; i ++ ) {

			const point = points[ Math.min( i, points.length - 1 ) ];
			array[ i ].set( point.x, point.y, point.z, point.width === undefined ? 1 : point.width );

		}

	}

	return {
		group,
		petals,
		motes,
		uniforms,
		setPath,
		dispose() {

			petalGeometry.dispose();
			petalMaterial.dispose();
			moteGeometry.dispose();
			moteMaterial.dispose();

		},
	};

}
