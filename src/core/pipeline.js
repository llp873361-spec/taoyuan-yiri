// 后期管线（规格书 6.2），两条实时输出链共用同一套 uniform：
//   原生链（hi）：场景 → 泛光 → 薄雾 → 调色 → 暗角 → 画布蔓延 → 颗粒 → 色调映射 + sRGB → FXAA
//   放大链（mid、hi 加放大）：场景（低分辨率）→ 泛光 → 薄雾 → 调色 → 暗角 → 画布蔓延 → 色调映射 + sRGB
//            → 低分辨率目标 → fsr1（EASU 放大 + RCAS 锐化）→ 颗粒（原生分辨率），不跑 FXAA
//   全景链（pano 档）：全景场景（不带 MSAA，可以按比例缩小画）→ 薄雾 → 暗角 → 画布蔓延 → 颗粒 → 转 sRGB（不做色调映射：
//            全景图本身就是烘焙时调好色、色调映射过的成品），不跑泛光和 FXAA（规格书 6.2）
//   遮罩链（只给烘焙用）：按深度输出"这个像素是不是天空"
// 每条链各是一个 RenderPipeline，开场卡阶段编好，运行时只是选画哪一条（换 outputNode 会重新编译着色器，不换）。
// 所有可变量都是 uniform，运行时只改 .value。
// API 依据 reference/notes/post-pipeline.md 与 tsl-basics.md，行号见笔记。
//
// 场景不用 pass() 画，而是在最外层自己画到 sceneTarget（HalfFloat + 深度纹理），后期链读它的贴图。
// 原因（4b 实测）：three 的渲染上下文按"附件格式 + 嵌套深度"缓存，pass() 套在 FXAA 的 RTT 里是第 2 层，
// 而 compileAsync 永远按第 0 层编——预编译的结果全部对不上，进地点第一帧又同步编一遍（WebGPU 0.6~1.9 秒、WebGL 最多 6 秒卡顿）。
// 现在主场景在第 0 层画进 sceneTarget，compileScene() 也设好同一个目标再编，两边是同一个上下文。

import * as THREE from 'three/webgpu';
import {
	uniform, Fn, If, float, int, vec2, vec3, vec4, texture, rtt,
	screenUV, screenSize, mix, smoothstep, luminance, hash, step, exp, dot, select,
	length, max, min, abs, fract, floor, pow, normalize, renderOutput, perspectiveDepthToViewZ, color, sin, cos,
} from 'three/tsl';
import { radialBlur } from 'three/addons/tsl/display/radialBlur.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';
import { dayAerialColor } from '../tsl/sky.js';
import { valueNoise2D, createNoiseTextureData } from '../tsl/noise.js';

// config 里的字符串 → three 的色调映射常量（constants.js:455/473/483）
const toneMappingTable = {
	agx: THREE.AgXToneMapping,
	aces: THREE.ACESFilmicToneMapping,
	neutral: THREE.NeutralToneMapping,
};

function toneMappingFromName( name ) {

	const constant = toneMappingTable[ name ];
	if ( constant === undefined ) {

		console.warn( `后期：未知的色调映射名字 "${ name }"，改用 AgX` );
		return THREE.AgXToneMapping;

	}

	return constant;

}

// 场景画进去的目标：和 pass() 原来的目标同一种格式（HalfFloat 颜色 + 深度纹理），画面和以前一样
function createSceneTarget( renderer, width, height ) {

	const target = new THREE.RenderTarget( width, height, { type: THREE.HalfFloatType, samples: renderer.samples } );
	target.texture.name = '场景';
	const depthTexture = new THREE.DepthTexture();
	depthTexture.isRenderTargetTexture = true;
	depthTexture.name = '场景深度';
	target.depthTexture = depthTexture;
	return target;

}

export function createPipeline( ctx ) {

	const renderer = ctx.renderer;
	const config = ctx.config;
	const camera = ctx.camera;

	if ( ! renderer ) throw new Error( '后期：ctx.renderer 为空，渲染器必须先建好并 await init()' );
	if ( ! camera ) throw new Error( '后期：ctx.camera 为空，相机必须先建好' );
	if ( ! ctx.world ) throw new Error( '后期：ctx.world 为空，薄雾的颜色要用统一天空' );

	// ===== 色调映射：RenderPipeline._update 会自己检测 renderer.toneMapping 变化 =====
	const defaultGrading = ( config.scenes && config.scenes[ 0 ] && config.scenes[ 0 ].grading ) || {};
	let currentToneMappingName = defaultGrading.toneMapping || 'agx';
	renderer.toneMapping = toneMappingFromName( currentToneMappingName );
	renderer.toneMappingExposure = 1;

	// 自己接 renderOutput，否则 FXAA 会排在 sRGB 之前（笔记 §4、§13 第 8 条）
	const renderPipeline = new THREE.RenderPipeline( renderer );
	renderPipeline.outputColorTransform = false;
	const upscalePipeline = new THREE.RenderPipeline( renderer );
	upscalePipeline.outputColorTransform = false;
	const panoPipeline = new THREE.RenderPipeline( renderer );
	panoPipeline.outputColorTransform = false;
	const maskPipeline = new THREE.RenderPipeline( renderer );
	maskPipeline.outputColorTransform = false;

	// ===== 空场景：setScene 之前先画个空场景 =====
	const blankScene = new THREE.Scene();
	blankScene.background = new THREE.Color( 0x000000 );
	let currentScene = blankScene;

	const sceneTarget = createSceneTarget( renderer, 1, 1 );
	// 热身用的小目标：附件格式和 sceneTarget 一样（上下文的缓存键只看格式、不看尺寸），阴影、反射这些
	// compileAsync 编不到的变体在这里真画一帧建好，不打扰正在画的主目标
	const warmTarget = createSceneTarget( renderer, 4, 4 );
	const sceneColor = texture( sceneTarget.texture );
	const sceneDepth = texture( sceneTarget.depthTexture );
	// 全景场景画进的目标：不带 MSAA（全景球上没有几何边，软件渲染下 4 倍采样白白多花三倍）
	const panoTarget = new THREE.RenderTarget( 1, 1, { type: THREE.HalfFloatType, samples: 0 } );
	panoTarget.texture.name = '全景场景';
	const panoColor = texture( panoTarget.texture );
	const drawingSize = new THREE.Vector2();

	// 每帧画主场景之前要先画的东西（平面反射等），由场景自己登记
	const prePasses = new Set();

	// ===== 每个后期层的开关（1 开 0 关），给调试面板用 =====
	const layerToggles = {
		泛光: uniform( 1 ),
		薄雾: uniform( 1 ),
		调色: uniform( 1 ),
		暗角: uniform( 1 ),
		画布: uniform( 1 ),
		颗粒: uniform( 1 ),
		明暗适应: uniform( 1 ),
		光束: uniform( 1 ),
		油画: uniform( 1 ),
		前景笔触: uniform( 1 ),
	};

	// ===== 泛光 =====
	// bloom() 参数传数字会被包成 uniform，运行时改 bloomNode.strength.value（BloomNode.js:86-100）。
	// 两条链各一个：泛光自己的渲染目标按画布尺寸 × resolutionScale 定，放大链要按场景比例缩，放一起会来回改尺寸
	const bloomConfig = config.post.bloom;
	const bloomNode = bloom( sceneColor, bloomConfig.strength, bloomConfig.radius, bloomConfig.threshold );
	const upscaleBloomNode = bloom( sceneColor, bloomNode.strength, bloomNode.radius, bloomNode.threshold );
	// ===== 光束（规格书 10.2：晨雾里的体积光；屏幕空间径向模糊，GPU Gems 3 第 13 章）=====
	// 光源：只取天空里（深度是远平面）太阳附近的亮处，按到太阳的屏幕距离衰减，半分辨率画进一张图；
	// 再朝太阳在屏幕上的位置径向模糊 48 次（three 自带的 radialBlur），也是半分辨率；加回 HDR，再一起泛光、调色。
	// 太阳在相机背后、或者地点不要光束时（amount = 0）两张图都不更新，不花时间
	const shaftAmount = uniform( 0 );
	const shaftSun = uniform( new THREE.Vector2( 0.5, 0.5 ) );   // 太阳在屏幕上的位置（screenUV，左上角是 0）
	const shaftColor = uniform( new THREE.Color( 1, 1, 1 ) );
	const shaftDirection = new THREE.Vector3( 0, 1, 0 );           // 太阳方向（当前渲染场景的坐标）
	let shaftActive = false;
	const shaftSource = rtt( Fn( () => {

		const depth = sceneDepth.sample( screenUV ).r;
		const sky = step( 0.99999, depth );
		const aspect = screenSize.x.div( screenSize.y );
		const offset = screenUV.sub( shaftSun ).mul( vec2( aspect, 1 ) );
		const near = exp( dot( offset, offset ).mul( - 9 ) );
		return vec4( sceneColor.sample( screenUV ).rgb.mul( sky ).mul( near ), 1 );

	} )(), null, null, { resolutionScale: 0.5 } );
	const shaftBlur = rtt( radialBlur( shaftSource, { center: shaftSun, weight: float( 0.9 ), decay: float( 0.965 ), count: int( 48 ), exposure: float( 2.2 ) } ), null, null, { resolutionScale: 0.5 } );
	const shaftVisible = uniform( 0 );
	const shafts = shaftBlur.rgb.mul( shaftColor ).mul( shaftAmount ).mul( shaftVisible ).mul( layerToggles.光束 );

	// ===== 油画（规格书 9.2：结构张量 + 各向异性 Kuwahara，Kyprianidis 等 2009 的做法，自己重写）=====
	// 先把 HDR 压到 0~1（c / (1 + c)，星星这种 10 倍亮的点不会把一个扇区的平均拉爆），全分辨率存一张；
	// 结构张量：亮度的 Sobel 梯度 (gx², gy², gx·gy)，半分辨率存（双线性取回来就是一次模糊）；
	// Kuwahara：按张量的主方向把采样圆拉成椭圆、转到边的方向，分 8 个扇区，每个扇区 3 圈 × 3 个角度取 9 个点，
	// 算平均和方差，方差小的扇区权重大（权重 1 / (1 + σ)^8），加权平均 —— 笔触顺着边走，平的地方抹成一块块颜料。
	// 只在地点要的时候（星月夜、hi 档）画这三张图
	const painterlyAmount = uniform( 0 );
	let painterlyActive = false;
	// 笔触多大按视角算，不按像素：视场 50° 时 1080 像素高的那个大小是 1。烘全景时一面 120°，不换算的话笔触、Kuwahara 半径
	// 在角度上大了 2.4 倍，全景里的星月夜糊成一块块的
	const paintScale = uniform( 1 );
	const painterSource = rtt( Fn( () => {

		const value = min( sceneColor.sample( screenUV ).rgb, vec3( 64 ) );
		return vec4( value.div( value.add( 1 ) ), 1 );

	} )() );
	const tensorTarget = rtt( Fn( () => {

		const texel = vec2( 1 ).div( screenSize );
		const lumaAt = ( dx, dy ) => luminance( painterSource.sample( screenUV.add( texel.mul( vec2( dx, dy ) ) ) ).rgb );
		const gx = lumaAt( 1, - 1 ).add( lumaAt( 1, 0 ).mul( 2 ) ).add( lumaAt( 1, 1 ) ).sub( lumaAt( - 1, - 1 ).add( lumaAt( - 1, 0 ).mul( 2 ) ).add( lumaAt( - 1, 1 ) ) );
		const gy = lumaAt( - 1, 1 ).add( lumaAt( 0, 1 ).mul( 2 ) ).add( lumaAt( 1, 1 ) ).sub( lumaAt( - 1, - 1 ).add( lumaAt( 0, - 1 ).mul( 2 ) ).add( lumaAt( 1, - 1 ) ) );
		return vec4( gx.mul( gx ), gy.mul( gy ), gx.mul( gy ), 1 );

	} )(), null, null, { resolutionScale: 0.5 } );
	const kuwaharaTarget = rtt( Fn( () => {

		const tensor = tensorTarget.sample( screenUV ).rgb;
		const e = tensor.x;
		const f = tensor.z;
		const g = tensor.y;
		const root = pow( max( e.sub( g ).pow2().add( f.pow2().mul( 4 ) ), 0 ), 0.5 );
		const lambda1 = e.add( g ).add( root ).mul( 0.5 );
		const lambda2 = e.add( g ).sub( root ).mul( 0.5 );
		const direction = vec2( lambda1.sub( e ), f.negate() );
		const directionLength = length( direction );
		const edgeDirection = select( directionLength.greaterThan( 1e-6 ), direction.div( max( directionLength, 1e-6 ) ), vec2( 1, 0 ) );
		const anisotropy = select( lambda1.add( lambda2 ).greaterThan( 1e-6 ), lambda1.sub( lambda2 ).div( lambda1.add( lambda2 ) ), float( 0 ) );
		// 椭圆：沿边方向拉长（a），垂直方向压扁（b）；半径按 1080 像素高 6 像素换算
		const radius = screenSize.y.div( 1080 ).mul( 6 ).mul( paintScale );
		const stretchA = radius.mul( float( 1 ).add( anisotropy ) );
		const stretchB = radius.div( float( 1 ).add( anisotropy ) );
		const texel = vec2( 1 ).div( screenSize );
		const weightedSum = vec3( 0 ).toVar();
		const weightTotal = float( 0 ).toVar();
		for ( let sector = 0; sector < 8; sector ++ ) {

			const mean = vec3( 0 ).toVar();
			const squares = vec3( 0 ).toVar();
			for ( const ring of [ 0.34, 0.67, 1 ] ) {

				for ( const spread of [ - 0.33, 0, 0.33 ] ) {

					const angle = ( sector + 0.5 + spread ) * Math.PI / 4;
					const local = vec2( stretchA.mul( Math.cos( angle ) * ring ), stretchB.mul( Math.sin( angle ) * ring ) );
					const rotated = vec2( local.x.mul( edgeDirection.x ).sub( local.y.mul( edgeDirection.y ) ), local.x.mul( edgeDirection.y ).add( local.y.mul( edgeDirection.x ) ) );
					const value = painterSource.sample( screenUV.add( rotated.mul( texel ) ) ).rgb;
					mean.addAssign( value );
					squares.addAssign( value.mul( value ) );

				}

			}

			mean.divAssign( 9 );
			const variance = max( squares.div( 9 ).sub( mean.mul( mean ) ), vec3( 0 ) );
			const sigma = variance.x.add( variance.y ).add( variance.z ).mul( 255 ).pow( 0.5 );
			const weight = float( 1 ).div( pow( float( 1 ).add( sigma ), 8 ) );
			weightedSum.addAssign( mean.mul( weight ) );
			weightTotal.addAssign( weight );

		}

		return vec4( weightedSum.div( max( weightTotal, 1e-8 ) ), 1 );

	} )() );
	painterSource.autoUpdate = false;
	tensorTarget.autoUpdate = false;
	kuwaharaTarget.autoUpdate = false;
	const painted = kuwaharaTarget.rgb.div( max( float( 1 ).sub( kuwaharaTarget.rgb ), 1e-3 ) );
	const paintedScene = mix( sceneColor, vec4( painted, sceneColor.a ), painterlyAmount.mul( layerToggles.油画 ) );


	// ===== 调色 uniform =====
	const grading = {
		exposure: uniform( 1 ),
		contrast: uniform( 1 ),
		saturation: uniform( 1 ),
		tintColor: uniform( new THREE.Color( 0xffffff ) ),
		tintAmount: uniform( 0 ),
	};

	// ===== 同色薄雾（交接用，取代白光）=====
	// 颜色就是统一天空的大气透视色（dayAerialColor）：朝太阳暖、夜里深蓝，和远景远山溶进去的颜色一样，所以是"同色"的雾。
	// 远处先进雾：按深度把 amount 变成每个像素的雾量 1 − (1 − amount)^(1 + 3·远近)，amount = 1 时整屏都是雾
	const veilAmount = uniform( 0 );
	const veilDrift = uniform( 0 );
	const veilViewToWorld = uniform( new THREE.Matrix4() );       // 相机空间方向 → 世界方向（只用旋转）
	const veilTanHalf = uniform( new THREE.Vector2( 1, 1 ) );      // 视场半角的正切（x 乘了宽高比）
	const cameraNear = uniform( camera.near );
	const cameraFar = uniform( camera.far );
	const veilConfig = config.world.flight.veil;
	const veilNear = uniform( veilConfig.near );
	const veilFar = uniform( veilConfig.far );

	// ===== 暗角 uniform =====
	const vignetteAmount = uniform( config.post.vignette.amount );
	const vignetteSoftness = uniform( config.post.vignette.softness );

	// ===== 画布蔓延 uniform =====
	const canvasReveal = uniform( 0 );
	const canvasTiles = uniform( config.post.canvasRevealTiles );
	// 明暗适应的曝光倍数（1 = 不适应）
	const adaptation = uniform( 1 );

	// ===== 颗粒 uniform =====
	const grainAmount = uniform( config.post.grain );
	// 每帧递增的种子；不用 time 节点，shot 模式下手动推进也能换颗粒
	const frameSeed = uniform( 0 );

	// 颗粒：按像素 + 帧种子做哈希。amount 在线性 HDR 里加（原生链）或在 sRGB 里加（放大链，放大之后）
	const grainAt = ( amount ) => {

		const pixel = floor( screenUV.mul( screenSize ) );
		const pixelIndex = pixel.y.mul( screenSize.x ).add( pixel.x );
		// 两级哈希：先把像素序号打散到 0..1，再和帧种子混，避免大数超过 float 精度
		const pixelHash = hash( pixelIndex );
		const grainSeed = fract( pixelHash.add( frameSeed.mul( 0.6180339887 ) ) ).mul( 16777216.0 );
		return hash( grainSeed ).sub( 0.5 ).mul( amount ).mul( layerToggles.颗粒 );

	};

	// 画布蔓延的遮罩：reveal 0 时全不覆盖，1 时全覆盖；中间从边缘向中心蔓延，边宽 0.35
	const canvasMaskAt = () => {

		// 到最近屏幕边的归一化距离：边 0、中心 1
		const edgeDistance = min( min( screenUV.x, float( 1 ).sub( screenUV.x ) ), min( screenUV.y, float( 1 ).sub( screenUV.y ) ) ).mul( 2.0 );
		return smoothstep( 0.0, 0.35, canvasReveal.mul( 1.35 ).sub( edgeDistance ) );

	};

	// 画布蔓延：程序化亚麻布，从屏幕边缘向中心覆盖（三条链共用）
	const canvasLayer = ( color ) => {

		// 经纱沿 x、纬纱沿 y，各是三角波，线宽按屏幕比例修正成正方格
		const aspect = screenSize.x.div( screenSize.y );
		const threadCoord = screenUV.mul( vec2( canvasTiles, canvasTiles.div( aspect ) ) );
		const warpCell = floor( threadCoord.x );
		const weftCell = floor( threadCoord.y );
		// 每根纱线一点粗细抖动，打破规则感
		const warpJitter = hash( warpCell.add( 17.0 ) ).sub( 0.5 ).mul( 0.3 );
		const weftJitter = hash( weftCell.add( 91.0 ) ).sub( 0.5 ).mul( 0.3 );
		const warpWave = abs( fract( threadCoord.x ).sub( 0.5 ) ).mul( 2.0 ).add( warpJitter );
		const weftWave = abs( fract( threadCoord.y ).sub( 0.5 ) ).mul( 2.0 ).add( weftJitter );
		// 交织处再加一点随机斑点，像布的结
		const knot = hash( warpCell.mul( 311.0 ).add( weftCell.mul( 7.0 ) ).add( 3.0 ) ).sub( 0.5 ).mul( 0.2 );
		const linen = warpWave.add( weftWave ).mul( 0.5 ).add( knot ); // 大致 0..1
		const linenShade = linen.mul( 0.12 ).add( 0.94 );             // 明暗 0.94..1.06（再强就成了一张规则的点阵网）
		// 米白画布底色（线性空间，很淡；0.06 时暗处整片被抬成灰，像蒙了一层雾）
		const creamColor = vec3( 0.92, 0.88, 0.80 ).mul( 0.012 );
		const canvasLook = color.mul( linenShade ).add( creamColor );
		return mix( color, canvasLook, canvasMaskAt().mul( layerToggles.画布 ) );

	};

	// ===== 前景笔触（规格书 9.2"统一油画感"）=====
	// 天空有自己的 LIC 笔触；3D 的前景（远景画的山丘、小镇、湖、柏树）只过 Kuwahara 还是"3D 渲染加滤镜"，而且 mid 档没有 Kuwahara。
	// 这里对非天空的像素（深度不在远平面）做三件事，范围就是画布蔓延到的地方（进星月夜时和画布一起从边缘往中间蔓延）：
	// ① 换成原画夜里的配色：按亮度在 深群青 → 普蓝 → 蓝绿 → 灰绿 → 淡黄绿 几个色标里取，暖色的灯窗保留原色；
	// ② 笔触：每个像素沿"顺着边"的方向（亮度梯度转 90°；平的地方按慢慢变的噪声给一个偏水平的方向）取 9 个点的噪声平均
	//    （直线上的线积分卷积），得到一道道约 5 像素宽、30 像素长的条纹（按 1080 像素高换算，各档一样大），调深浅和蓝绿的色相；
	// ③ 深度不连续的地方描一道深蓝的轮廓（原画里房子、山丘、柏树都有深色勾边）
	const brushNoiseData = createNoiseTextureData( 256, 64, 41 );
	const brushNoise = new THREE.DataTexture( brushNoiseData.data, brushNoiseData.size, brushNoiseData.size, THREE.RGBAFormat, THREE.UnsignedByteType );
	brushNoise.wrapS = THREE.RepeatWrapping;
	brushNoise.wrapT = THREE.RepeatWrapping;
	brushNoise.magFilter = THREE.LinearFilter;
	brushNoise.minFilter = THREE.LinearFilter;
	brushNoise.needsUpdate = true;
	brushNoise.name = '前景笔触噪声';
	const brushNoiseMap = texture( brushNoise );
	const paintForeground = ( input ) => Fn( () => {

		const source = input.toVar();
		const result = source.rgb.toVar();
		const depth = sceneDepth.sample( screenUV ).r;
		const amount = canvasMaskAt().mul( float( 1 ).sub( step( 0.99999, depth ) ) ).mul( layerToggles.前景笔触 ).toVar();
		If( amount.greaterThan( 0.001 ), () => {

			const aspect = screenSize.x.div( screenSize.y );
			const pixel = vec2( float( 1 ).div( aspect ), 1 ).div( 1080 ).mul( paintScale );     // 视场 50°、1080 像素高时一个像素在 screenUV 里多大
			const lumaAt = ( dx, dy ) => luminance( sceneColor.sample( screenUV.add( pixel.mul( vec2( dx, dy ) ) ) ).rgb );
			const luma = luminance( source.rgb );
			// 顺着边的方向：梯度转 90°，符号对齐到平地的方向（d 和 −d 是同一笔，混之前要先对齐，不然互相抵消）
			const gradientX = lumaAt( 3, 0 ).sub( lumaAt( - 3, 0 ) );
			const gradientY = lumaAt( 0, 3 ).sub( lumaAt( 0, - 3 ) );
			const flatAngle = brushNoiseMap.sample( screenUV.mul( vec2( aspect, 1 ) ).mul( 0.9 ).div( paintScale ) ).g.sub( 0.5 ).mul( 1.3 );
			const flatDirection = vec2( cos( flatAngle ), sin( flatAngle ) );
			const along = vec2( gradientY.negate(), gradientX ).toVar();
			along.assign( select( dot( along, flatDirection ).lessThan( 0 ), along.negate(), along ) );
			const edgeWeight = smoothstep( 0.08, 0.4, length( along ).div( luma.add( 0.01 ) ) );
			const direction = normalize( mix( flatDirection, normalize( along.add( vec2( 1e-6, 0 ) ) ), edgeWeight ) );
			// 笔触坐标：按 1080 像素高换算的像素，噪声一格 5 像素（贴图一圈 64 格）
			const base = screenUV.mul( vec2( aspect, 1 ) ).mul( 1080 ).div( paintScale ).div( 5 * 64 );
			const step3 = direction.mul( 3.4 / ( 5 * 64 ) );
			const streak = float( 0 ).toVar();
			const tint = float( 0 ).toVar();
			for ( let k = - 4; k <= 4; k ++ ) {

				const sample = brushNoiseMap.sample( base.add( step3.mul( k ) ) );
				streak.addAssign( sample.r );
				tint.addAssign( sample.g );

			}

			const stroke = streak.div( 9 ).sub( 0.5 ).mul( 3.2 ).add( 0.5 ).clamp( 0, 1 );
			const hue = tint.div( 9 ).sub( 0.5 ).mul( 3 ).add( 0.5 ).clamp( 0, 1 );
			// 配色：亮度先压到 0~1（l / (l + 0.04)），再取色标；整体亮度按原来的亮度走（大约保持明暗关系）
			const tone = luma.div( luma.add( 0.03 ) );
			const palette = mix( color( '#0a1328' ), color( '#1b3157' ), smoothstep( 0, 0.3, tone ) ).toVar();
			palette.assign( mix( palette, mix( color( '#24506a' ), color( '#2f5d4f' ), hue ), smoothstep( 0.22, 0.55, tone ) ) );
			palette.assign( mix( palette, mix( color( '#5f8f9a' ), color( '#7aa082' ), hue ), smoothstep( 0.5, 0.82, tone ) ) );
			palette.assign( mix( palette, color( '#d6dcae' ), smoothstep( 0.8, 1, tone ) ) );
			// 勾边、配色都要视线距离：近处（柏树）留它自己的颜色（墨绿），只加笔触；远处的山、小镇换成原画的配色
			const viewDistanceAt = ( dx, dy ) => perspectiveDepthToViewZ( sceneDepth.sample( screenUV.add( pixel.mul( vec2( dx, dy ) ) ) ).r, cameraNear, cameraFar ).negate();
			const center = viewDistanceAt( 0, 0 );
			const strokeShade = mix( float( 0.7 ), float( 1.35 ), stroke );
			const remapWeight = smoothstep( 60, 160, center ).mul( 0.85 ).add( 0.15 );
			const painted = mix( source.rgb.mul( strokeShade ), palette.mul( 0.5 ).mul( strokeShade ), remapWeight ).toVar();
			// 暖色的灯窗（明显偏红黄、又亮的）保留原色
			const warmth = smoothstep( 0.2, 0.6, source.r.sub( source.b ).div( luma.add( 1e-4 ) ) ).mul( smoothstep( 0.05, 0.3, luma ) );
			painted.assign( mix( painted, source.rgb, warmth ) );
			// 勾边：上下左右 1.5 像素的视线距离和中心差得多（相对）就是轮廓
			const jump = max( max( abs( viewDistanceAt( 1.5, 0 ).sub( center ) ), abs( viewDistanceAt( - 1.5, 0 ).sub( center ) ) ), max( abs( viewDistanceAt( 0, 1.5 ).sub( center ) ), abs( viewDistanceAt( 0, - 1.5 ).sub( center ) ) ) );
			const outline = smoothstep( 0.04, 0.16, jump.div( max( center, 0.1 ) ) ).mul( float( 1 ).sub( warmth ) );
			painted.assign( mix( painted, color( '#0b1430' ).mul( 0.05 ), outline.mul( 0.75 ) ) );
			result.assign( mix( result, painted, amount ) );

		} );
		return vec4( result, source.a );

	} )();

	// bloom 返回的是纯泛光层，要加回原图（笔记 §3）；原生链在加泛光之前先过油画（星月夜），两条链都过前景笔触
	const hdrColor = paintForeground( paintedScene ).add( bloomNode.mul( layerToggles.泛光 ) ).add( shafts );
	const upscaleHdrColor = paintForeground( sceneColor ).add( upscaleBloomNode.mul( layerToggles.泛光 ) ).add( shafts );

	// ===== 节点链（两条链共用，withGrain = false 时颗粒留到放大以后再加）=====
	const postChain = ( hdrInput, withGrain ) => Fn( () => {

		const input = hdrInput.toVar();
		const alpha = input.a;
		let color = input.rgb.toVar();

		// --- 薄雾：在调色之前（雾和场景一起被调色，调色插值时雾的亮度跟着走），在泛光之后（泛光也被雾盖住）---
		// 深度在分支外面先取好（TSL 按第一次用到的位置生成代码）
		const viewDistance = perspectiveDepthToViewZ( sceneDepth.r, cameraNear, cameraFar ).negate().toVar();
		If( veilAmount.greaterThan( 0.0005 ), () => {

			const depthFactor = smoothstep( veilNear, veilFar, viewDistance );
			const pixelVeil = float( 1 ).sub( pow( max( float( 1 ).sub( veilAmount ), 0 ), depthFactor.mul( 3 ).add( 1 ) ) );
			const ndc = vec2( screenUV.x.mul( 2 ).sub( 1 ), float( 1 ).sub( screenUV.y.mul( 2 ) ) );
			const viewDirection = normalize( vec3( ndc.mul( veilTanHalf ), - 1 ) );
			const worldDirection = normalize( veilViewToWorld.mul( vec4( viewDirection, 0 ) ).xyz );
			// 一点很淡的云絮起伏（±2.5%），不是一块平的颜色
			const cloudiness = valueNoise2D( screenUV.mul( vec2( 3, 2 ) ).add( vec2( veilDrift, veilDrift.mul( 0.37 ) ) ) ).sub( 0.5 ).mul( 0.05 ).add( 1 );
			const mist = dayAerialColor( worldDirection, ctx.world.uniforms ).mul( cloudiness );
			color.assign( mix( color, mist, pixelVeil.mul( layerToggles.薄雾 ) ) );

		} );

		// --- 调色，全部在 HDR 线性空间里做 ---
		// 明暗适应（规格书 6.2）：洞里眼睛适应了暗处，曝光抬高；出洞那一下过亮，再慢慢落回来（开场、花园按镜头在洞里的位置给）
		const graded = color.mul( grading.exposure ).mul( mix( float( 1 ), adaptation, layerToggles.明暗适应 ) ).toVar();
		// 对比度绕中灰 0.18，负值要 clamp 掉，否则 bloom 后会出黑点
		graded.assign( max( graded.sub( 0.18 ).mul( grading.contrast ).add( 0.18 ), 0 ) );
		// 饱和度绕亮度
		const gray = vec3( luminance( graded ) );
		graded.assign( mix( gray, graded, grading.saturation ) );
		// 色温偏色：乘 2 让中性色（0.5 灰）不变亮度
		graded.assign( mix( graded, graded.mul( grading.tintColor ).mul( 2 ), grading.tintAmount ) );
		color.assign( mix( color, graded, layerToggles.调色 ) );

		// --- 暗角：screenUV 到中心的距离，中心 0、角落 1 ---
		const centered = screenUV.sub( 0.5 );
		const cornerDistance = length( centered ).mul( 1.4142 );
		const vignette = float( 1 ).sub( vignetteAmount.mul( smoothstep( vignetteSoftness, 1.0, cornerDistance ) ) );
		color.assign( mix( color, color.mul( vignette ), layerToggles.暗角 ) );

		color.assign( canvasLayer( color ) );

		// --- 颗粒：线性空间加性噪声（放大链在放大以后加）---
		if ( withGrain ) color.assign( color.add( grainAt( grainAmount ) ) );

		return vec4( color, alpha );

	} )();

	// 色调映射 + 转 sRGB 不传参，取 renderer 上的设置（RenderOutputNode.js:119-121），
	// 这样改 renderer.toneMapping 时 RenderPipeline 自己 needsUpdate 重建
	const outputNode = renderOutput( postChain( hdrColor, true ), null, THREE.SRGBColorSpace );
	// FXAA 必须吃 sRGB，放链尾
	renderPipeline.outputNode = fxaa( outputNode );
	renderPipeline.needsUpdate = true;

	// 放大链：低分辨率上做到色调映射，画进显式按场景比例缩小的目标（rtt 的 resolutionScale，每帧跟着场景比例改），
	// 再 fsr1 放大回原生；颗粒在原生分辨率上加（sRGB 里，幅度按中灰附近线性 → sRGB 的斜率折一下）。
	// 规格书：fsr1 必须用 rtt 显式指定低分辨率，convertToTexture 会按满分辨率建目标，低分辨率就白做了
	const lowResolution = rtt( renderOutput( postChain( upscaleHdrColor, false ), null, THREE.SRGBColorSpace ) );
	const upscaled = fsr1( lowResolution, config.post.fsrSharpness );
	upscalePipeline.outputNode = Fn( () => {

		const color = upscaled.toVar();
		return vec4( color.rgb.add( grainAt( grainAmount.mul( 0.8 ) ) ), 1 );

	} )();
	upscalePipeline.needsUpdate = true;

	// 全景链：薄雾不看深度（全景没有深度），整屏按 amount 混；颗粒在显示空间里加，幅度减半
	panoPipeline.outputNode = renderOutput( Fn( () => {

		const color = panoColor.rgb.toVar();
		If( veilAmount.greaterThan( 0.0005 ), () => {

			const ndc = vec2( screenUV.x.mul( 2 ).sub( 1 ), float( 1 ).sub( screenUV.y.mul( 2 ) ) );
			const worldDirection = normalize( veilViewToWorld.mul( vec4( normalize( vec3( ndc.mul( veilTanHalf ), - 1 ) ), 0 ) ).xyz );
			color.assign( mix( color, dayAerialColor( worldDirection, ctx.world.uniforms ), veilAmount.mul( layerToggles.薄雾 ) ) );

		} );
		const centered = screenUV.sub( 0.5 );
		const vignette = float( 1 ).sub( vignetteAmount.mul( smoothstep( vignetteSoftness, 1.0, length( centered ).mul( 1.4142 ) ) ) );
		color.assign( mix( color, color.mul( vignette ), layerToggles.暗角 ) );
		// 画布：进出星月夜时从边缘蔓延（规格书 5.3），全景模式也要有；没在蔓延时跳过，省软件渲染的时间
		If( canvasReveal.greaterThan( 0.0005 ), () => {

			color.assign( canvasLayer( color ) );

		} );
		color.assign( color.add( grainAt( grainAmount.mul( 0.5 ) ) ) );
		return vec4( max( color, 0 ), 1 );

	} )(), THREE.NoToneMapping, THREE.SRGBColorSpace );
	panoPipeline.needsUpdate = true;

	// 遮罩链（烘焙）：R = 天空（视线 20 公里内没碰到东西：远景天空球在 0.9 × far，最远的山在 14 公里以内）
	maskPipeline.outputNode = renderOutput( Fn( () => {

		const distance = perspectiveDepthToViewZ( sceneDepth.r, cameraNear, cameraFar ).negate();
		const sky = smoothstep( 19000, 21000, distance );
		return vec4( sky, sky, sky, 1 );

	} )(), THREE.NoToneMapping, THREE.SRGBColorSpace );
	maskPipeline.needsUpdate = true;

	// ===== 对外函数 =====

	function setScene( scene ) {

		if ( ! scene || ! scene.isScene ) {

			console.error( '后期：setScene 收到的不是 THREE.Scene，忽略' );
			return;

		}

		currentScene = scene;

	}

	function getScene() {

		return currentScene;

	}

	// 两套调色按 amount 插值（飞行途中从出发地过渡到目的地）；exposureScale 是夜里飞行时的曝光补偿。
	// 色调映射两套不一样时不在中途换（换了要重编后期链），保持当前的，到下一次 setGrading 再换
	const tintFrom = new THREE.Color();
	const tintTo = new THREE.Color();
	let toneMappingWarned = false;
	function setGradingBlend( from, to, amount = 0, exposureScale = 1 ) {

		if ( ! from || ! to ) {

			console.warn( '后期：setGradingBlend 收到空参数，忽略' );
			return;

		}

		const t = Math.min( 1, Math.max( 0, amount ) );
		const lerp = ( name, fallback ) => {

			const first = from[ name ] !== undefined ? from[ name ] : fallback;
			const second = to[ name ] !== undefined ? to[ name ] : fallback;
			return first + ( second - first ) * t;

		};

		grading.exposure.value = lerp( 'exposure', 1 ) * exposureScale;
		grading.contrast.value = lerp( 'contrast', 1 );
		grading.saturation.value = lerp( 'saturation', 1 );
		grading.tintAmount.value = lerp( 'tintAmount', 0 );
		tintFrom.set( from.tint || '#ffffff' );
		tintTo.set( to.tint || '#ffffff' );
		grading.tintColor.value.lerpColors( tintFrom, tintTo, t );
		// 颗粒是线性空间的加性噪声，暗而平的大片渐变（黄昏天空）上会很显，场景可以自己压低；没写就用全局值
		grainAmount.value = lerp( 'grain', config.post.grain );

		const fromName = from.toneMapping || 'agx';
		const toName = to.toneMapping || 'agx';
		if ( fromName !== toName ) {

			if ( ! toneMappingWarned ) {

				toneMappingWarned = true;
				console.warn( `后期：两套调色的色调映射不一样（${ fromName } / ${ toName }），途中不换，到停留时再换` );

			}

			return;

		}

		if ( fromName !== currentToneMappingName ) {

			currentToneMappingName = fromName;
			// RenderPipeline._update 检测到 toneMapping 变化会自己重建（RenderPipeline.js:218-223）
			renderer.toneMapping = toneMappingFromName( fromName );
			console.log( `后期：色调映射切换为 ${ fromName }` );

		}

	}

	function setGrading( gradingConfig ) {

		if ( ! gradingConfig ) {

			console.warn( '后期：setGrading 收到空参数，忽略' );
			return;

		}

		toneMappingWarned = false;
		setGradingBlend( gradingConfig, gradingConfig, 0, 1 );

	}

	// 同色薄雾：amount 0~1；drift 让雾里很淡的起伏慢慢飘（传时间线的连续时钟）
	function setVeil( amount, drift ) {

		veilAmount.value = Math.min( 1, Math.max( 0, Number( amount ) || 0 ) );
		if ( Number.isFinite( drift ) ) veilDrift.value = drift * 0.05;

	}

	function setCanvasReveal( amount ) {

		canvasReveal.value = Math.min( 1, Math.max( 0, Number( amount ) || 0 ) );

	}

	// 光束：settings = { amount, direction（太阳方向，当前渲染场景的坐标）, color }；null 或 amount 0 关掉
	// 油画：amount 0~1（0 关掉，三张图都不更新）
	function setPainterly( amount ) {

		painterlyAmount.value = Number.isFinite( amount ) ? Math.min( 1, Math.max( 0, amount ) ) : 0;
		const active = painterlyAmount.value > 0;
		painterSource.autoUpdate = active;
		tensorTarget.autoUpdate = active;
		kuwaharaTarget.autoUpdate = active;
		if ( active && ! painterlyActive ) {

			painterSource.textureNeedsUpdate = true;
			tensorTarget.textureNeedsUpdate = true;
			kuwaharaTarget.textureNeedsUpdate = true;

		}

		painterlyActive = active;

	}

	function setLightShafts( settings ) {

		shaftAmount.value = settings && settings.amount > 0 ? settings.amount : 0;
		if ( settings && settings.direction ) shaftDirection.copy( settings.direction ).normalize();
		if ( settings && settings.color ) shaftColor.value.copy( settings.color );

	}

	// 每帧：太阳方向换到屏幕上；太阳在背后或者亮度是 0 就不更新那两张图
	const shaftView = new THREE.Vector4();
	function updateShafts() {

		let visible = 0;
		if ( shaftAmount.value > 0 ) {

			shaftView.set( shaftDirection.x, shaftDirection.y, shaftDirection.z, 0 ).applyMatrix4( camera.matrixWorldInverse );
			if ( shaftView.z < - 1e-3 ) {

				shaftView.w = 0;
				shaftView.applyMatrix4( camera.projectionMatrix );
				const ndcX = shaftView.x / shaftView.w;
				const ndcY = shaftView.y / shaftView.w;
				shaftSun.value.set( ndcX * 0.5 + 0.5, 0.5 - ndcY * 0.5 );
				// 太阳出了画面一大截就不画（径向模糊的中心离画面太远，光束只剩平行的条纹）
				visible = Math.max( 0, 1 - Math.max( 0, Math.max( Math.abs( ndcX ), Math.abs( ndcY ) ) - 1.2 ) / 0.8 );

			}

		}

		const active = visible > 0;
		shaftSource.autoUpdate = active;
		shaftBlur.autoUpdate = active;
		if ( active !== shaftActive ) {

			shaftActive = active;
			if ( active ) {

				shaftSource.textureNeedsUpdate = true;
				shaftBlur.textureNeedsUpdate = true;

			}

		}

		shaftVisible.value = visible;

	}

	function setAdaptation( amount ) {

		adaptation.value = Number.isFinite( amount ) && amount > 0 ? amount : 1;

	}

	function addPrePass( callback ) {

		if ( typeof callback === 'function' ) prePasses.add( callback );

	}

	function removePrePass( callback ) {

		prePasses.delete( callback );

	}

	// 薄雾的相机：当前渲染场景的坐标 → 世界坐标（远景挂在地点里时，场景坐标是地点的局部坐标）
	const sceneToWorld = new THREE.Matrix4();
	function updateVeilCamera() {

		camera.updateMatrixWorld();
		sceneToWorld.copy( ctx.world.worldToAnchorMatrix() ).invert();
		veilViewToWorld.value.multiplyMatrices( sceneToWorld, camera.matrixWorld );
		const tanHalf = Math.tan( camera.fov * Math.PI / 360 );
		veilTanHalf.value.set( tanHalf * camera.aspect, tanHalf );
		cameraNear.value = camera.near;
		cameraFar.value = camera.far;

	}

	// 这一帧走哪条链、场景按多少倍画（画质模块决定；它还没建好时按原生）
	let forcedChain = null;   // 开场卡预编译、烘焙遮罩时临时指定
	function currentChain() {

		if ( forcedChain ) return forcedChain;
		const mode = ctx.quality ? ctx.quality.mode : 'native';
		if ( mode === 'pano' ) return 'pano';
		return mode === 'native' ? 'native' : 'upscale';

	}

	function setForcedChain( chain ) {

		forcedChain = chain || null;

	}

	function render() {

		// 颗粒种子每帧推进，到 4096 回绕（只用在 fract 里，大小无所谓）
		frameSeed.value = ( frameSeed.value + 1 ) % 4096;

		const chain = currentChain();
		const scale = ( chain === 'upscale' || chain === 'pano' ) && ctx.quality ? Math.min( 1, Math.max( 0.25, ctx.quality.renderScale ) ) : 1;
		renderer.getDrawingBufferSize( drawingSize );
		const width = Math.max( 1, Math.floor( drawingSize.x * scale ) );
		const height = Math.max( 1, Math.floor( drawingSize.y * scale ) );
		const target = chain === 'pano' ? panoTarget : sceneTarget;
		if ( target.width !== width || target.height !== height ) target.setSize( width, height );

		camera.updateMatrixWorld();
		paintScale.value = Math.tan( 25 * Math.PI / 180 ) / Math.tan( Math.min( 170, Math.max( 1, camera.fov ) ) * Math.PI / 360 );
		for ( const prePass of prePasses ) prePass();
		updateVeilCamera();
		updateShafts();

		const previousTarget = renderer.getRenderTarget();
		renderer.setRenderTarget( target );
		renderer.render( currentScene, camera );
		renderer.setRenderTarget( previousTarget );

		if ( chain === 'pano' ) {

			panoPipeline.render();

		} else if ( chain === 'mask' ) {

			maskPipeline.render();

		} else if ( chain === 'upscale' ) {

			lowResolution.setResolutionScale( scale );
			upscaleBloomNode.setResolutionScale( 0.5 * scale );
			upscalePipeline.render();

		} else {

			renderPipeline.render();

		}

	}

	// 开场卡阶段：每条链各画一帧，把它们的着色器编掉（同步的，开场卡上有进度粒子），运行中切换不卡
	function prepareChains( chains = [ 'pano', 'upscale', 'native' ] ) {

		// 光束、油画的几张图平时不更新：这里各画一次，把它们的着色器也编掉
		shaftSource.textureNeedsUpdate = true;
		shaftBlur.textureNeedsUpdate = true;
		painterSource.textureNeedsUpdate = true;
		tensorTarget.textureNeedsUpdate = true;
		kuwaharaTarget.textureNeedsUpdate = true;
		for ( const chain of chains ) {

			forcedChain = chain;
			try {

				render();

			} finally {

				forcedChain = null;

			}

		}

	}

	// 预编译：按主场景真正画的那个上下文（sceneTarget、第 0 层）异步编译 object。
	// 编译期间临时把所有物体设成可见、不做视锥剔除（藏着的替身、开关层、她走过去才看得到的东西都要编）。
	// compileAsync 在第一个 await 之前就把要编的对象和上下文收集好了，所以这些临时改动只包住这一次调用。
	// targetScene：用哪个场景的灯光、雾、环境来编（远景挂进某个地点之前，用那个地点的场景编）。
	// three r186 的两个坑（4b 实测）：
	//   compileAsync 把渲染上下文的 depth / stencil 设成渲染器自己的，真画时用的是目标的 depthBuffer / stencilBuffer，
	//   没有深度缓冲的目标（极光贴图）编出来的管线深度格式不一样——这里临时把渲染器的设成和目标一致；
	//   附件格式一样的目标共用一个渲染上下文，管线是异步建的，建的时候读上下文里"当前贴图"的色彩空间，
	//   所以同一种格式、不同色彩空间的目标（倒影和环境光贴图）不能同时编，要一个编完再编下一个（见落日的 compile）
	function compileScene( object, compileCamera, targetScene = null, renderTarget = sceneTarget ) {

		const saved = [];
		object.traverse( ( child ) => {

			saved.push( child, child.visible, child.frustumCulled );
			child.visible = true;
			child.frustumCulled = false;

		} );

		const previousTarget = renderer.getRenderTarget();
		const previousDepth = renderer.depth;
		const previousStencil = renderer.stencil;
		renderer.setRenderTarget( renderTarget );
		if ( renderTarget ) {

			renderer.depth = renderTarget.depthBuffer;
			renderer.stencil = renderTarget.stencilBuffer;

		}

		try {

			return renderer.compileAsync( object, compileCamera, targetScene );

		} finally {

			renderer.depth = previousDepth;
			renderer.stencil = previousStencil;
			renderer.setRenderTarget( previousTarget );
			for ( let i = 0; i < saved.length; i += 3 ) {

				saved[ i ].visible = saved[ i + 1 ];
				saved[ i ].frustumCulled = saved[ i + 2 ];

			}

		}

	}

	// 热身：在同格式的 4×4 小目标上真画一帧（阴影 pass、反射等 compileAsync 编不到的变体在这里建好）。
	// 只在停留期间调；画之前同样把物体都设成可见、不剔除
	function warmUp( scene, warmCamera ) {

		const saved = [];
		scene.traverse( ( child ) => {

			saved.push( child, child.visible, child.frustumCulled );
			child.visible = true;
			child.frustumCulled = false;

		} );

		const previousTarget = renderer.getRenderTarget();
		renderer.setRenderTarget( warmTarget );
		try {

			renderer.render( scene, warmCamera );

		} finally {

			renderer.setRenderTarget( previousTarget );
			for ( let i = 0; i < saved.length; i += 3 ) {

				saved[ i ].visible = saved[ i + 1 ];
				saved[ i ].frustumCulled = saved[ i + 2 ];

			}

		}

	}

	function resize() {

		const width = window.innerWidth;
		const height = window.innerHeight;

		if ( width <= 0 || height <= 0 ) {

			console.warn( `后期：窗口尺寸为 ${ width }×${ height }，跳过这次 resize` );
			return;

		}

		camera.aspect = width / height;
		camera.updateProjectionMatrix();

		if ( ctx.quality && typeof ctx.quality.applyResolution === 'function' ) {

			ctx.quality.applyResolution();

		} else {

			// quality 还没建好时先按 1 倍像素比铺满，等 quality 建好会再调 applyResolution
			renderer.setSize( width, height, false );

		}

	}

	function registerDebug() {

		if ( ! ctx.debug || typeof ctx.debug.addLayerToggle !== 'function' ) return;

		for ( const label of Object.keys( layerToggles ) ) {

			ctx.debug.addLayerToggle( '后期', label, layerToggles[ label ] );

		}

	}

	function dispose() {

		renderPipeline.dispose();
		upscalePipeline.dispose();
		panoPipeline.dispose();
		maskPipeline.dispose();
		panoTarget.dispose();
		if ( typeof upscaleBloomNode.dispose === 'function' ) upscaleBloomNode.dispose();
		sceneTarget.dispose();
		warmTarget.dispose();
		if ( typeof bloomNode.dispose === 'function' ) bloomNode.dispose();

	}

	// debug 可能还没建，判空；main 建好 debug 后会再调 registerDebug()
	registerDebug();

	const pipeline = {
		renderPipeline,
		upscalePipeline,
		sceneTarget,
		prepareChains,
		getChain: currentChain,
		setForcedChain,
		panoTarget,
		bloomNode,
		layerToggles,
		grading,
		setScene,
		getScene,
		setGrading,
		setGradingBlend,
		setVeil,
		getVeil: () => veilAmount.value,
		setCanvasReveal,
		setAdaptation,
		getAdaptation: () => adaptation.value,
		setLightShafts,
		setPainterly,
		getLightShafts: () => ( { amount: shaftAmount.value, visible: shaftVisible.value, sun: shaftSun.value.toArray() } ),
		getCanvasReveal: () => canvasReveal.value,
		addPrePass,
		removePrePass,
		compileScene,
		warmUp,
		render,
		resize,
		registerDebug,
		dispose,
	};

	return pipeline;

}
