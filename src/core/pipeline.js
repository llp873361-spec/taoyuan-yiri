// 后期管线：场景 pass → 泛光 → 调色 → 闪光 → 暗角 → 画布蔓延 → 颗粒 → 色调映射 + sRGB → FXAA
// 所有可变量都是 uniform，运行时只改 .value，不重建节点（换 outputNode 会重新编译着色器）。
// API 依据 reference/notes/post-pipeline.md 与 tsl-basics.md，行号见笔记。

import * as THREE from 'three/webgpu';
import {
	pass, uniform, Fn, float, vec2, vec3, vec4,
	screenUV, screenSize, mix, smoothstep, luminance, hash,
	length, max, min, abs, fract, floor, renderOutput,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

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

export function createPipeline( ctx ) {

	const renderer = ctx.renderer;
	const config = ctx.config;

	if ( ! renderer ) throw new Error( '后期：ctx.renderer 为空，渲染器必须先建好并 await init()' );
	if ( ! ctx.camera ) throw new Error( '后期：ctx.camera 为空，相机必须先建好' );

	// ===== 色调映射：RenderPipeline._update 会自己检测 renderer.toneMapping 变化 =====
	const defaultGrading = ( config.scenes && config.scenes[ 0 ] && config.scenes[ 0 ].grading ) || {};
	let currentToneMappingName = defaultGrading.toneMapping || 'agx';
	renderer.toneMapping = toneMappingFromName( currentToneMappingName );
	renderer.toneMappingExposure = 1;

	const renderPipeline = new THREE.RenderPipeline( renderer );
	// 自己接 renderOutput，否则 FXAA 会排在 sRGB 之前（笔记 §4、§13 第 8 条）
	renderPipeline.outputColorTransform = false;

	// ===== 空场景：setScene 之前先画个空场景，避免 pass 拿到 null =====
	const placeholderScene = new THREE.Scene();
	placeholderScene.background = new THREE.Color( 0x000000 );

	// pass 默认 HalfFloat（PassNode.js:246），HDR 不截断
	const scenePass = pass( placeholderScene, ctx.camera );
	const sceneColor = scenePass.getTextureNode( 'output' );

	// ===== 每个后期层的开关（1 开 0 关），给调试面板用 =====
	const layerToggles = {
		泛光: uniform( 1 ),
		调色: uniform( 1 ),
		闪光: uniform( 1 ),
		暗角: uniform( 1 ),
		画布: uniform( 1 ),
		颗粒: uniform( 1 ),
	};

	// ===== 泛光 =====
	// bloom() 参数传数字会被包成 uniform，运行时改 bloomNode.strength.value（BloomNode.js:86-100）
	const bloomConfig = config.post.bloom;
	const bloomNode = bloom( sceneColor, bloomConfig.strength, bloomConfig.radius, bloomConfig.threshold );
	// bloom 返回的是纯泛光层，要加回原图（笔记 §3）
	const hdrColor = sceneColor.add( bloomNode.mul( layerToggles.泛光 ) );

	// ===== 调色 uniform =====
	const grading = {
		exposure: uniform( 1 ),
		contrast: uniform( 1 ),
		saturation: uniform( 1 ),
		tintColor: uniform( new THREE.Color( 0xffffff ) ),
		tintAmount: uniform( 0 ),
	};

	// ===== 闪光 uniform =====
	const flashAmount = uniform( 0 );
	const flashColor = uniform( new THREE.Color( 0xffffff ) );
	// 闪光颜色在 HDR 里乘 3，让 AgX 自然压成白；配合 setFlash 里抬 bloom.strength 产生"被光吞没"
	const flashHdrGain = 3;

	// ===== 暗角 uniform =====
	const vignetteAmount = uniform( config.post.vignette.amount );
	const vignetteSoftness = uniform( config.post.vignette.softness );

	// ===== 画布蔓延 uniform =====
	const canvasReveal = uniform( 0 );
	const canvasTiles = uniform( config.post.canvasRevealTiles );

	// ===== 颗粒 uniform =====
	const grainAmount = uniform( config.post.grain );
	// 每帧递增的种子；不用 time 节点，shot 模式下手动推进也能换颗粒
	const frameSeed = uniform( 0 );

	// ===== 节点链 =====
	const postChain = Fn( () => {

		const input = hdrColor.toVar();
		const alpha = input.a;
		let color = input.rgb.toVar();

		// --- 调色，全部在 HDR 线性空间里做 ---
		const graded = color.mul( grading.exposure ).toVar();
		// 对比度绕中灰 0.18，负值要 clamp 掉，否则 bloom 后会出黑点
		graded.assign( max( graded.sub( 0.18 ).mul( grading.contrast ).add( 0.18 ), 0 ) );
		// 饱和度绕亮度
		const gray = vec3( luminance( graded ) );
		graded.assign( mix( gray, graded, grading.saturation ) );
		// 色温偏色：乘 2 让中性色（0.5 灰）不变亮度
		graded.assign( mix( graded, graded.mul( grading.tintColor ).mul( 2 ), grading.tintAmount ) );
		color = mix( color, graded, layerToggles.调色 ).toVar();

		// --- 闪光（转场白光）---
		const flashTarget = vec3( flashColor ).mul( flashHdrGain );
		color.assign( mix( color, flashTarget, flashAmount.mul( layerToggles.闪光 ) ) );

		// --- 暗角：screenUV 到中心的距离，中心 0、角落 1 ---
		const centered = screenUV.sub( 0.5 );
		const cornerDistance = length( centered ).mul( 1.4142 );
		const vignette = float( 1 ).sub( vignetteAmount.mul( smoothstep( vignetteSoftness, 1.0, cornerDistance ) ) );
		color.assign( mix( color, color.mul( vignette ), layerToggles.暗角 ) );

		// --- 画布蔓延：程序化亚麻布，从屏幕边缘向中心覆盖 ---
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
		const linenShade = linen.mul( 0.35 ).add( 0.8 );              // 明暗 0.8..1.15
		// 米白画布底色（线性空间，很淡）
		const creamColor = vec3( 0.92, 0.88, 0.80 ).mul( 0.06 );
		const canvasLook = color.mul( linenShade ).add( creamColor );
		// 到最近屏幕边的归一化距离：边 0、中心 1
		const edgeDistance = min( min( screenUV.x, float( 1 ).sub( screenUV.x ) ), min( screenUV.y, float( 1 ).sub( screenUV.y ) ) ).mul( 2.0 );
		// reveal 0 时全不覆盖，1 时全覆盖；中间从边缘向中心蔓延，边宽 0.35
		const revealEdge = canvasReveal.mul( 1.35 );
		const canvasMask = smoothstep( 0.0, 0.35, revealEdge.sub( edgeDistance ) );
		color.assign( mix( color, canvasLook, canvasMask.mul( layerToggles.画布 ) ) );

		// --- 颗粒：按像素 + 帧种子做哈希，线性空间加性噪声 ---
		const pixel = floor( screenUV.mul( screenSize ) );
		const pixelIndex = pixel.y.mul( screenSize.x ).add( pixel.x );
		// 两级哈希：先把像素序号打散到 0..1，再和帧种子混，避免大数超过 float 精度
		const pixelHash = hash( pixelIndex );
		const grainSeed = fract( pixelHash.add( frameSeed.mul( 0.6180339887 ) ) ).mul( 16777216.0 );
		const grainNoise = hash( grainSeed ).sub( 0.5 ).mul( grainAmount ).mul( layerToggles.颗粒 );
		color.assign( color.add( grainNoise ) );

		return vec4( color, alpha );

	} );

	// 色调映射 + 转 sRGB 不传参，取 renderer 上的设置（RenderOutputNode.js:119-121），
	// 这样改 renderer.toneMapping 时 RenderPipeline 自己 needsUpdate 重建
	const outputNode = renderOutput( postChain(), null, THREE.SRGBColorSpace );
	// FXAA 必须吃 sRGB，放链尾
	renderPipeline.outputNode = fxaa( outputNode );
	renderPipeline.needsUpdate = true;

	// ===== 对外函数 =====

	function setScene( scene ) {

		if ( ! scene || ! scene.isScene ) {

			console.error( '后期：setScene 收到的不是 THREE.Scene，忽略' );
			return;

		}

		// updateBefore 每帧读 this.scene（PassNode.js:817），直接赋值即可
		scenePass.scene = scene;

	}

	function setGrading( gradingConfig ) {

		if ( ! gradingConfig ) {

			console.warn( '后期：setGrading 收到空参数，忽略' );
			return;

		}

		if ( gradingConfig.exposure !== undefined ) grading.exposure.value = gradingConfig.exposure;
		if ( gradingConfig.contrast !== undefined ) grading.contrast.value = gradingConfig.contrast;
		if ( gradingConfig.saturation !== undefined ) grading.saturation.value = gradingConfig.saturation;
		if ( gradingConfig.tint !== undefined ) grading.tintColor.value.set( gradingConfig.tint );
		if ( gradingConfig.tintAmount !== undefined ) grading.tintAmount.value = gradingConfig.tintAmount;
		// 颗粒是线性空间的加性噪声，暗而平的大片渐变（黄昏天空）上会很显，场景可以自己压低；没写就用全局值
		grainAmount.value = gradingConfig.grain !== undefined ? gradingConfig.grain : config.post.grain;

		const nextName = gradingConfig.toneMapping || 'agx';
		if ( nextName !== currentToneMappingName ) {

			currentToneMappingName = nextName;
			// RenderPipeline._update 检测到 toneMapping 变化会自己重建（RenderPipeline.js:218-223）
			renderer.toneMapping = toneMappingFromName( nextName );
			console.log( `后期：色调映射切换为 ${ nextName }` );

		}

	}

	function setFlash( amount, color ) {

		const clamped = Math.min( 1, Math.max( 0, Number( amount ) || 0 ) );
		flashAmount.value = clamped;

		if ( color !== undefined && color !== null ) {

			flashColor.value.set( color );

		}

		// 同时抬 bloom 强度，让画面像被光吞没
		bloomNode.strength.value = bloomConfig.strength + clamped * config.transition.bloomBoost;

	}

	function setCanvasReveal( amount ) {

		canvasReveal.value = Math.min( 1, Math.max( 0, Number( amount ) || 0 ) );

	}

	function render() {

		// 颗粒种子每帧推进，到 4096 回绕（只用在 fract 里，大小无所谓）
		frameSeed.value = ( frameSeed.value + 1 ) % 4096;
		renderPipeline.render();

	}

	function resize() {

		const width = window.innerWidth;
		const height = window.innerHeight;

		if ( width <= 0 || height <= 0 ) {

			console.warn( `后期：窗口尺寸为 ${ width }×${ height }，跳过这次 resize` );
			return;

		}

		ctx.camera.aspect = width / height;
		ctx.camera.updateProjectionMatrix();

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
		scenePass.dispose();
		if ( typeof bloomNode.dispose === 'function' ) bloomNode.dispose();

	}

	// debug 可能还没建，判空；main 建好 debug 后会再调 registerDebug()
	registerDebug();

	const pipeline = {
		renderPipeline,
		scenePass,
		bloomNode,
		layerToggles,
		grading,
		setScene,
		setGrading,
		setFlash,
		setCanvasReveal,
		render,
		resize,
		registerDebug,
		dispose,
	};

	return pipeline;

}
