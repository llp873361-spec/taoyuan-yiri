// 渲染器初始化、后端检测、显卡名、兜底。契约见 reference/notes/design-stage0.md 第 1、2 节。
// API 依据 reference/notes/renderer-core.md（行号以 three 0.186.0 为准）。

import * as THREE from 'three/webgpu';

// 读显卡名字。WebGL 下走 WEBGL_debug_renderer_info；WebGPU 下只有 device.adapterInfo（用户机器上一般只有 vendor/architecture）。
function readGpuName( renderer, backend ) {

	try {

		if ( backend === 'webgl2' ) {

			const gl = renderer.backend.gl;
			if ( ! gl ) return '未知';

			// 新版 Chrome/Edge 里这个扩展可能是 null，此时 gl.RENDERER 已直接返回 ANGLE 字符串
			const debugInfo = gl.getExtension( 'WEBGL_debug_renderer_info' );
			const name = debugInfo
				? gl.getParameter( debugInfo.UNMASKED_RENDERER_WEBGL )
				: gl.getParameter( gl.RENDERER );

			return ( typeof name === 'string' && name.trim() !== '' ) ? name.trim() : '未知';

		}

		// WebGPU：three 不保存 adapter，只能读 device.adapterInfo（浏览器 API，老版本是 undefined）
		const device = renderer.backend.device;
		const adapterInfo = device ? device.adapterInfo : undefined;
		if ( ! adapterInfo ) return '未知';

		const parts = [ adapterInfo.vendor, adapterInfo.architecture, adapterInfo.description, adapterInfo.device ]
			.filter( ( part ) => typeof part === 'string' && part.trim() !== '' )
			.map( ( part ) => part.trim() );

		// description 和 device 常常是空串（Chrome 故意遮的），去重后拼起来
		const unique = parts.filter( ( part, index ) => parts.indexOf( part ) === index );

		return unique.length > 0 ? unique.join( ' / ' ) : '未知';

	} catch ( error ) {

		console.warn( '读取显卡名字失败，按未知处理：', error );
		return '未知';

	}

}

// 建渲染器。canvas 不挂到 DOM，由 main.js 挂。
export async function createRenderer( { forceWebGL = false } = {} ) {

	if ( typeof document === 'undefined' ) {

		throw new Error( '渲染器初始化失败：没有 document，不是浏览器环境' );

	}

	const canvas = document.createElement( 'canvas' );

	// antialias: true → MSAA 4x（Renderer.js:275）。不传 powerPreference：Windows 的 Chrome 会忽略它并打一条警告
	const renderer = new THREE.WebGPURenderer( {
		canvas,
		antialias: true,
		forceWebGL: forceWebGL === true,
	} );

	// r186 必须先 init 再 render；WebGPU 失败时 init 内部自动退回 WebGL2，两个都失败才会抛
	try {

		await renderer.init();

	} catch ( error ) {

		const reason = ( error && error.message ) ? error.message : String( error );
		const message = forceWebGL === true
			? `渲染器初始化失败：WebGL2 不可用（${ reason }）`
			: `渲染器初始化失败：WebGPU 和 WebGL2 都不可用（${ reason }）`;
		throw new Error( message );

	}

	// 回退发生在 init 里，所以只能在 init 之后看真实后端
	let backend;
	if ( renderer.backend.isWebGPUBackend === true ) {

		backend = 'webgpu';

	} else if ( renderer.backend.isWebGLBackend === true ) {

		backend = 'webgl2';

	} else {

		throw new Error( '渲染器初始化失败：init 之后后端类型无法识别' );

	}

	if ( backend === 'webgl2' && forceWebGL !== true ) {

		console.warn( 'WebGPU 不可用，已退回 WebGL2' );

	}

	// WebGPU 兼容模式会把 MSAA 关掉（WebGPUBackend.js:258-264），记一下方便排查画面锯齿
	if ( backend === 'webgpu' && renderer.backend.compatibilityMode === true ) {

		console.warn( 'WebGPU 落入兼容模式，MSAA 已被关闭' );

	}

	const gpuName = readGpuName( renderer, backend );

	// toneMapping 由 pipeline 决定，这里不设；outputColorSpace 保持默认 SRGB
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFShadowMap;

	// 计时用 Timer（Clock 已废弃）；connect 后切回标签页 delta 不会爆
	const timer = new THREE.Timer();
	timer.connect( document );

	console.log( `渲染器就绪：后端 ${ backend === 'webgpu' ? 'WebGPU' : 'WebGL2' }，显卡 ${ gpuName }` );

	return { renderer, backend, gpuName, timer };

}

// setSize(0, 0) 和 NaN 没有任何保护（CanvasTarget.js:185-205），这里拦一道。
// updateStyle 固定 false：canvas 的显示尺寸由 CSS 管，动态分辨率只改像素比。
export function safeSetSize( renderer, width, height ) {

	const widthOk = Number.isFinite( width ) && width > 0;
	const heightOk = Number.isFinite( height ) && height > 0;

	if ( ! widthOk || ! heightOk ) {

		console.warn( `窗口尺寸无效（${ width } × ${ height }），本次不改渲染尺寸` );
		return false;

	}

	renderer.setSize( width, height, false );
	return true;

}
