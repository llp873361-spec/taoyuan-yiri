// 共用素材加载：读 HTML 末尾的数据块（vite.config.js 写进去的），解成 Blob / ArrayBuffer / 模型 / 贴图。
//
// 每套素材（pano / terrain / models / textures）有一份清单 assets/opt/<套>/manifest.json：
//   { version: 1, files: [ { id, file, mime, bytes } ], ... }
// 构建时每个文件变成一个 <script type="application/octet-stream" id="data-<套>-<编号>" data-mime="..."> 数据块（base64）。
// 全程不发网络请求：data: 地址交给 fetch 解 base64（data: 不是网络请求，比 atob 快得多）；glb 里的贴图 GLTFLoader 走 blob: 地址。
// 缺清单、缺数据块、解码失败都打印中文警告并返回 null，调用方换程序化兜底；不吞错。
//
// 这里不引用 backdrop.js：模型换成"世界材质"时的光照、大气函数由调用方传进来（convertToWorldMaterial 的 shade）。

import * as THREE from 'three/webgpu';
import {
	vec2, vec4, color, texture, vertexColor, normalMap, normalWorld, positionWorld,
	cameraViewMatrix, transformNormalByInverseViewMatrix,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// ===================== 清单 =====================

// 用 glob 读清单：某一套还没生成（目录里没有 manifest.json）时这里只是少一项，不会构建失败
const manifestModules = import.meta.glob( '../../assets/opt/*/manifest.json', { eager: true, import: 'default' } );
const manifests = {};
for ( const [ modulePath, content ] of Object.entries( manifestModules ) ) {

	const match = modulePath.match( /\/opt\/([^/]+)\/manifest\.json$/ );
	if ( match ) manifests[ match[ 1 ] ] = content;

}

// 某一套素材的清单；没生成过返回 null
export function getManifest( set ) {

	return manifests[ set ] || null;

}

// ===================== 数据块 =====================

function dataElementOf( set, id ) {

	return document.getElementById( `data-${ set }-${ id }` );

}

// 页面里有没有这个数据块（不打印任何东西，用来先探一下）
export function hasData( set, id ) {

	return Boolean( dataElementOf( set, id ) );

}

// 数据块 → Blob（类型取数据块上的 data-mime）。没有这个数据块返回 null
export async function blobOf( set, id ) {

	const element = dataElementOf( set, id );
	if ( ! element ) {

		const inManifest = Boolean( getManifest( set ) && ( getManifest( set ).files || [] ).some( ( item ) => item.id === id ) );
		console.warn( inManifest
			? `素材：清单里有「${ set }/${ id }」，但页面里没有它的数据块（文件缺失，构建时跳过了；重跑生成脚本再构建）`
			: `素材：没有素材「${ set }/${ id }」（${ set } 的清单里没有这一项）` );
		return null;

	}

	const mime = element.dataset.mime || 'application/octet-stream';
	const response = await fetch( 'data:' + mime + ';base64,' + element.textContent.trim() );
	return response.blob();

}

export async function arrayBufferOf( set, id ) {

	const blob = await blobOf( set, id );
	return blob ? blob.arrayBuffer() : null;

}

// gzip 解压（浏览器自带的 DecompressionStream，不引第三方库）；收 Blob、ArrayBuffer 或 TypedArray
export async function gunzipToArrayBuffer( blobOrBuffer ) {

	if ( ! blobOrBuffer ) {

		console.warn( '素材：gunzipToArrayBuffer 收到的是空数据' );
		return null;

	}

	if ( typeof DecompressionStream === 'undefined' ) throw new Error( '素材：这个浏览器没有 DecompressionStream，解不了 gzip 数据' );
	const blob = blobOrBuffer instanceof Blob ? blobOrBuffer : new Blob( [ blobOrBuffer ] );
	const stream = blob.stream().pipeThrough( new DecompressionStream( 'gzip' ) );
	return new Response( stream ).arrayBuffer();

}

// ===================== 模型 =====================

let gltfLoader = null;

function getGltfLoader() {

	if ( gltfLoader === null ) {

		gltfLoader = new GLTFLoader();
		// meshopt 解码器的 wasm 以字符串内嵌在模块里，不需要外部文件；不调 useWorkers（file:// 下不碰 Worker，主线程解够快）
		gltfLoader.setMeshoptDecoder( MeshoptDecoder );

	}

	return gltfLoader;

}

// 数据块里的 glb → three 的场景节点（gltf.scene）；缺失或解析失败返回 null
export async function loadModel( set, id ) {

	const buffer = await arrayBufferOf( set, id );
	if ( ! buffer ) return null;

	try {

		await MeshoptDecoder.ready;
		const gltf = await getGltfLoader().parseAsync( buffer, '' );
		const scene = gltf.scene || ( gltf.scenes && gltf.scenes[ 0 ] ) || null;
		if ( ! scene ) {

			console.warn( `素材：模型「${ set }/${ id }」里没有场景节点` );
			return null;

		}

		if ( ! scene.name ) scene.name = id;
		return scene;

	} catch ( error ) {

		console.warn( `素材：模型「${ set }/${ id }」解析失败：${ error && error.message ? error.message : error }` );
		return null;

	}

}

// ===================== 贴图 =====================

// WebP 数据块 → ImageBitmap。翻转在解码时做（ImageBitmap 在 WebGL 下不认 UNPACK_FLIP_Y，three 的惯例是 flipY 交给 createImageBitmap）；
// premultiplyAlpha 'none'：不预乘，带透明的叶子贴图边缘颜色不变暗；colorSpaceConversion 'none'：按原值解码，法线图不被色彩管理改掉
async function bitmapOf( set, id, flipY ) {

	const blob = await blobOf( set, id );
	if ( ! blob ) return null;
	const options = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
	if ( flipY ) options.imageOrientation = 'flipY';

	try {

		return await createImageBitmap( blob, options );

	} catch ( error ) {

		console.warn( `素材：贴图「${ set }/${ id }」解码失败：${ error && error.message ? error.message : error }` );
		return null;

	}

}

// 单张贴图（平铺、带 mipmap）。colorSpace：颜色图用 SRGBColorSpace，法线 / ARM 这类数据图用 NoColorSpace。
// flipY 默认 true，和 TextureLoader 的朝向一致（图片的上边在 v = 1）
export async function loadTexture( set, id, { colorSpace = THREE.SRGBColorSpace, flipY = true, anisotropy = 1 } = {} ) {

	const bitmap = await bitmapOf( set, id, flipY );
	if ( ! bitmap ) return null;

	const result = new THREE.Texture( bitmap );
	result.name = set + '/' + id;
	result.colorSpace = colorSpace;
	result.flipY = false;   // 已经在 createImageBitmap 里翻过了
	result.wrapS = THREE.RepeatWrapping;
	result.wrapT = THREE.RepeatWrapping;
	result.magFilter = THREE.LinearFilter;
	result.minFilter = THREE.LinearMipmapLinearFilter;
	result.generateMipmaps = true;
	result.anisotropy = anisotropy;
	result.needsUpdate = true;
	return result;

}

function createDrawingSurface( size ) {

	if ( typeof OffscreenCanvas !== 'undefined' ) return new OffscreenCanvas( size, size );
	const canvas = document.createElement( 'canvas' );
	canvas.width = size;
	canvas.height = size;
	return canvas;

}

// 一组同尺寸的贴图 → 一张 DataArrayTexture（每张一层，着色器里 texture( 数组, uv ).depth( 层号 ) 取）。
// 每张 WebP 画到 size × size 的画布上读回 RGBA8（尺寸不一样的会被缩放到 size）。
// mipmap 交给渲染器生成：r186 的 WebGPU 后端逐层逐级跑 mipmap 管线（WebGPUTexturePassUtils.generateMipmaps 按 depthOrArrayLayers 循环），
// WebGL2 兜底对 TEXTURE_2D_ARRAY 调 gl.generateMipmap，两个后端都不用在 CPU 上算。
// 只要有一张缺失或解码失败就整组返回 null（半组贴图画出来是错的，调用方直接换兜底）。
// 画布读回的是去预乘后的值：完全不透明的地表贴图没有影响，带透明的贴图别走这里
export async function loadTextureArray( set, ids, size, { colorSpace = THREE.SRGBColorSpace, anisotropy = 1, flipY = true } = {} ) {

	if ( ! Array.isArray( ids ) || ids.length === 0 ) {

		console.warn( `素材：loadTextureArray 没给贴图编号（套：${ set }）` );
		return null;

	}

	if ( ! ( Number.isInteger( size ) && size > 0 ) ) {

		console.warn( `素材：loadTextureArray 的尺寸不对：${ size }（要正整数，比如 1024）` );
		return null;

	}

	const layerBytes = size * size * 4;
	const data = new Uint8Array( layerBytes * ids.length );
	const surface = createDrawingSurface( size );
	const context = surface.getContext( '2d', { willReadFrequently: true } );
	if ( ! context ) {

		console.warn( '素材：拿不到 2D 画布，贴图数组建不了' );
		return null;

	}

	for ( let i = 0; i < ids.length; i ++ ) {

		const bitmap = await bitmapOf( set, ids[ i ], flipY );
		if ( ! bitmap ) {

			console.warn( `素材：贴图数组缺第 ${ i } 层「${ set }/${ ids[ i ] }」，整组不建` );
			return null;

		}

		context.clearRect( 0, 0, size, size );
		context.drawImage( bitmap, 0, 0, size, size );
		bitmap.close();
		data.set( context.getImageData( 0, 0, size, size ).data, i * layerBytes );

	}

	const result = new THREE.DataArrayTexture( data, size, size, ids.length );
	result.name = set + '/' + ids.join( '+' );
	result.format = THREE.RGBAFormat;
	result.type = THREE.UnsignedByteType;
	result.colorSpace = colorSpace;
	result.wrapS = THREE.RepeatWrapping;
	result.wrapT = THREE.RepeatWrapping;
	result.magFilter = THREE.LinearFilter;
	result.minFilter = THREE.LinearMipmapLinearFilter;
	result.generateMipmaps = true;   // DataArrayTexture 默认是 false，要手动打开
	result.anisotropy = anisotropy;
	result.unpackAlignment = 4;
	result.needsUpdate = true;
	return result;

}

// ===================== 世界材质 =====================

// 把模型里的 glTF 材质换成"世界材质"：MeshBasicNodeMaterial，不吃场景灯光和场景雾，颜色 = shade( 反照率, 世界法线, 世界位置 )，
// 和远景、地点自己的东西用同一套光照、大气（shade 由调用方给，一般是 backdrop 的 worldLighting 再套 worldAtmosphere）。
//   反照率 = 底色贴图 × 材质颜色 × 顶点色（几何体有 color 属性时；以后烘的 AO 也放这里）× tint
//   法线：有法线贴图时用 TSL 的 normalMap 节点。r186 里几何体没有 tangent 属性时它自动改用屏幕导数求切线框架
//   （TangentUtils 的 tangentViewFrame），GLTFLoader 这时已经把 normalScale.y 取反配合这种算法，所以不用补切线；
//   没有法线贴图就用几何法线。注意 MeshBasicNodeMaterial 的 setupNormal 只认几何法线、不认 normalNode，
//   所以法线贴图的结果在这里直接换到世界空间传给 shade，不走 material.normalNode。
// alphaTest / side / transparent / opacity / depthWrite 照抄原材质（叶子、花的镂空靠 alphaTest）。
// 自发光、金属度、粗糙度、AO 贴图不用（光照全在 shade 里算），用不到的贴图在这里释放。
// 被替换的旧材质 dispose 掉；同一个旧材质只换一次，共用它的网格也共用新材质
export function convertToWorldMaterial( object3d, { shade, tint = null, name = '' } = {} ) {

	if ( ! object3d ) {

		console.warn( '素材：convertToWorldMaterial 收到空对象' );
		return object3d;

	}

	if ( typeof shade !== 'function' ) throw new Error( '素材：convertToWorldMaterial 需要 shade( albedo, normal, point ) 函数（一般是远景的光照 + 大气）' );

	const tintNode = tint === null || tint === undefined ? null : ( tint.isNode ? tint : color( new THREE.Color( tint ) ) );
	const converted = new Map();
	const oldMaterials = new Set();
	const usedTextures = new Set();

	const convertOne = ( oldMaterial, geometry ) => {

		if ( ! oldMaterial ) return oldMaterial;
		const hasVertexColor = Boolean( geometry && geometry.hasAttribute( 'color' ) );
		const cacheKey = oldMaterial.uuid + ( hasVertexColor ? ':顶点色' : '' );
		if ( converted.has( cacheKey ) ) return converted.get( cacheKey );

		oldMaterials.add( oldMaterial );
		const material = new THREE.MeshBasicNodeMaterial();
		material.name = name ? name + '·' + ( oldMaterial.name || '材质' ) : ( oldMaterial.name || '世界材质' );
		material.fog = false;
		material.lights = false;   // 不吃场景灯光：光照全由 shade 算，挂到哪个地点的场景里生成的着色器都一样
		material.side = oldMaterial.side;
		material.transparent = oldMaterial.transparent;
		material.opacity = oldMaterial.opacity;
		material.alphaTest = oldMaterial.alphaTest;
		material.depthWrite = oldMaterial.depthWrite;

		const map = oldMaterial.map || null;
		const normalTexture = oldMaterial.normalMap || null;
		const sampled = map ? texture( map ) : vec4( 1 );
		let albedo = sampled.rgb.mul( color( oldMaterial.color ? oldMaterial.color.clone() : new THREE.Color( 1, 1, 1 ) ) );
		if ( hasVertexColor ) albedo = albedo.mul( vertexColor().rgb );
		if ( tintNode ) albedo = albedo.mul( tintNode );

		let normal = normalWorld;
		if ( normalTexture ) {

			const normalScale = oldMaterial.normalScale || new THREE.Vector2( 1, 1 );
			const normalView = normalMap( texture( normalTexture ), vec2( normalScale.x, normalScale.y ) );
			// 视空间 → 世界空间：乘视矩阵的逆（视矩阵是刚体变换，逆转置就是逆）
			normal = transformNormalByInverseViewMatrix( normalView, cameraViewMatrix );

		}

		material.colorNode = vec4( shade( albedo, normal, positionWorld ), map ? sampled.a : 1 );
		material.userData.worldTextures = [ map, normalTexture ].filter( Boolean );
		for ( const used of material.userData.worldTextures ) usedTextures.add( used );
		converted.set( cacheKey, material );
		return material;

	};

	object3d.traverse( ( child ) => {

		if ( ! child.isMesh ) return;
		if ( Array.isArray( child.material ) ) {

			child.material = child.material.map( ( item ) => convertOne( item, child.geometry ) );

		} else {

			child.material = convertOne( child.material, child.geometry );

		}

	} );

	// 旧材质上新材质用不到的贴图（粗糙度、AO、自发光……）一起释放，ImageBitmap 也关掉
	for ( const oldMaterial of oldMaterials ) {

		for ( const value of Object.values( oldMaterial ) ) {

			if ( value && value.isTexture && ! usedTextures.has( value ) ) releaseTexture( value );

		}

		oldMaterial.dispose();

	}

	return object3d;

}

function releaseTexture( target ) {

	target.dispose();
	if ( target.image && typeof target.image.close === 'function' ) target.image.close();

}

// 释放一个模型（loadModel 的结果，换没换过世界材质都行）的几何体、材质、贴图。
// 换过世界材质的贴图在节点里，材质属性上找不到，靠 userData.worldTextures 找回来。克隆出来共用几何体的副本要等都不用了再调
export function disposeModel( object3d ) {

	if ( ! object3d ) return;
	const geometries = new Set();
	const materials = new Set();
	const textures = new Set();
	object3d.traverse( ( child ) => {

		if ( child.geometry ) geometries.add( child.geometry );
		if ( ! child.material ) return;
		for ( const material of Array.isArray( child.material ) ? child.material : [ child.material ] ) {

			materials.add( material );
			for ( const value of Object.values( material ) ) {

				if ( value && value.isTexture ) textures.add( value );

			}

			for ( const value of material.userData.worldTextures || [] ) textures.add( value );

		}

	} );

	for ( const geometry of geometries ) geometry.dispose();
	for ( const material of materials ) material.dispose();
	for ( const value of textures ) releaseTexture( value );

}
