// 全景模式（pano 档，规格书 6.5）：老核显、没有显卡加速的电脑不画实时场景，播放开发机上用最高画质烘焙的 360° 全景和飞行视频，
// 再叠一层实时的轻量动态。
//
// 素材（scripts/bake-pano.mjs 烘焙，清单 assets/opt/pano/manifest.json）：每个文件是 HTML 末尾一个 <script type="application/octet-stream">
// 数据块（base64，id 是 data-pano-<编号>，见 vite.config.js；读取、解码在 src/core/assets.js），用到时才读、才解码；只解当前和下一个地点的。
//   每个烘焙点：全景图（等距柱状，sRGB，宽 8192）、遮罩（R 天空、G 闪光密度、B 窗户编号、A 水面）、夜空高精度渐变（半精度，消色带）
//   每段飞行：1080p 视频，飞行时盖在画布上面播放，首尾和全景交叉淡化
//
// 每个地点的替身模块接口和普通场景一样（init / enter / update / exit / dispose / getSpawn / compile）。
// 镜头固定在烘焙点，按 config.panorama 的视角关键帧慢慢转向、推近，相邻烘焙点之间交叉淡化，看起来像慢慢往前走；拖动能转一整圈。
// 等距柱状的约定：u = 0.5 是本地 −z（地点的 yaw 方向），往右（+x）u 变大；v = 0.5 + 仰角 / π（下面是 0）。烘焙脚本按同一个约定拼。

import * as THREE from 'three/webgpu';
import {
	Fn, If, uniform, texture, float, vec2, vec3, uv, color,
	positionWorld, cameraPosition, instanceIndex,
	normalize, atan, asin, clamp, fract, floor, mix, smoothstep, max, abs, dot, length, exp, sin, cos, pow, luminance, step, cross,
} from 'three/tsl';
import manifest from '../../assets/opt/pano/manifest.json';
import { blobOf as dataBlobOf, hasData, gunzipToArrayBuffer } from '../core/assets.js';
import { hash33 } from '../tsl/noise.js';
import { createAuroraPass, hemisphereUV } from './aurora.js';

const degree = Math.PI / 180;
// 全景档的实时极光贴图（整个上半球）：老核显给 1024 × 384、12 步；软件渲染下要守住 20 帧，只给 400 × 150、8 步，
// 采样时再柔化（贴图一个纹素在屏幕上约十几个像素，太小了帘幕下缘会出台阶）
const auroraSizes = { gpu: { width: 1024, height: 384, steps: 12 }, software: { width: 400, height: 150, steps: 8 } };

// ===================== 素材 =====================

export function panoramaAvailable() {

	return Object.keys( manifest.locations || {} ).length > 0;

}

export function hasPanorama( key ) {

	const location = manifest.locations && manifest.locations[ key ];
	return Boolean( location && location.points && location.points.length > 0 );

}

export function flightVideoOf( fromKey, toKey ) {

	return ( manifest.flights && manifest.flights[ fromKey + '-' + toKey ] ) || null;

}

// HTML 数据块 → Blob（读数据块、解 base64 在 src/core/assets.js）。全景缺素材照旧直接抛错，由调用方切兜底
export async function blobOf( id ) {

	if ( ! hasData( 'pano', id ) ) throw new Error( `全景：页面里没有素材「${ id }」（重新构建，或重跑 scripts/bake-pano.mjs）` );
	return dataBlobOf( 'pano', id );

}

// 图片 → 纹理：图片的第一行在上（仰角 +90°），翻成第一行在下，v = 0 就是正下方
async function imageTextureOf( id, colorSpace ) {

	const bitmap = await createImageBitmap( await blobOf( id ), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' } );
	const result = new THREE.Texture( bitmap );
	result.colorSpace = colorSpace;
	result.flipY = false;
	result.generateMipmaps = false;   // 8192 宽的全景在屏幕上只会放大，不会缩小，不要 mipmap（省三分之一显存）
	result.minFilter = THREE.LinearFilter;
	result.magFilter = THREE.LinearFilter;
	result.wrapS = THREE.RepeatWrapping;
	result.wrapT = THREE.ClampToEdgeWrapping;
	result.needsUpdate = true;
	return result;

}

// 夜空高精度渐变：半精度 RGB，每行按通道和左边一格做了差，再 gzip（scripts/bake-pano.mjs 的 packSky）；
// 宽、高写在清单里，第一行在下。这里解压、逐行累加回原值、补上 alpha = 1
async function halfTextureOf( id, width, height ) {

	const delta = new Uint16Array( await gunzipToArrayBuffer( await blobOf( id ) ) );
	if ( delta.length !== width * height * 3 ) throw new Error( `全景：夜空渐变「${ id }」长度不对（${ delta.length }，应为 ${ width * height * 3 }），重跑 scripts/bake-pano.mjs` );
	const data = new Uint16Array( width * height * 4 );
	const halfOne = 0x3c00;
	for ( let row = 0; row < height; row ++ ) {

		const running = [ 0, 0, 0 ];
		for ( let column = 0; column < width; column ++ ) {

			const source = ( row * width + column ) * 3;
			const target = ( row * width + column ) * 4;
			for ( let channel = 0; channel < 3; channel ++ ) {

				running[ channel ] = ( running[ channel ] + delta[ source + channel ] ) & 0xffff;
				data[ target + channel ] = running[ channel ];

			}

			data[ target + 3 ] = halfOne;

		}

	}

	const result = new THREE.DataTexture( data, width, height, THREE.RGBAFormat, THREE.HalfFloatType );
	result.colorSpace = THREE.NoColorSpace;
	result.magFilter = THREE.LinearFilter;
	result.minFilter = THREE.LinearFilter;
	result.wrapS = THREE.RepeatWrapping;
	result.wrapT = THREE.ClampToEdgeWrapping;
	result.generateMipmaps = false;
	result.needsUpdate = true;
	return result;

}

async function loadPoint( point ) {

	const [ image, mask, sky ] = await Promise.all( [
		imageTextureOf( point.image, THREE.SRGBColorSpace ),
		imageTextureOf( point.mask, THREE.NoColorSpace ),
		halfTextureOf( point.sky, point.skyWidth, point.skyHeight ),
	] );
	return { image, mask, sky, dispose() {

		image.dispose();
		mask.dispose();
		sky.dispose();
		if ( image.image && typeof image.image.close === 'function' ) image.image.close();
		if ( mask.image && typeof mask.image.close === 'function' ) mask.image.close();

	} };

}

// 等距柱状 UV（约定见文件头）
function panoramaUV( direction ) {

	const azimuth = atan( direction.x, direction.z.negate() );
	const mapU = fract( azimuth.div( Math.PI * 2 ).add( 0.5 ) );
	const mapV = asin( clamp( direction.y, - 1, 1 ) ).div( Math.PI ).add( 0.5 );
	return vec2( mapU, mapV );

}

// 偏航、俯仰（度）→ 本地方向
function directionOf( yawDegrees, pitchDegrees ) {

	const yaw = yawDegrees * degree;
	const pitch = pitchDegrees * degree;
	return [ Math.sin( yaw ) * Math.cos( pitch ), Math.sin( pitch ), - Math.cos( yaw ) * Math.cos( pitch ) ];

}

// ===================== 叠加：飘雪（雪原）=====================
// 相机周围 30 米的盒子里几百片雪，位置全在顶点着色器里算（同雪原的飘雪，但数量少、横向飘动用正弦代替 curl 噪声：
// pano 档常常是软件渲染，curl 噪声在顶点里很贵）
function createSnow( uniforms, count ) {

	const material = new THREE.SpriteNodeMaterial();
	material.name = '全景·飘雪';
	material.transparent = true;
	material.depthWrite = false;
	const index = instanceIndex.toFloat();
	const seed = hash33( vec3( index, 11, 3 ) );
	const seedB = hash33( vec3( index, 11, 4 ) );
	const box = float( 30 );
	const velocity = vec3( 0.8, mix( - 0.5, - 1.1, seedB.x ), 0.45 );
	const base = seed.mul( box ).add( velocity.mul( uniforms.time ) );
	const sway = uniforms.time.mul( mix( 0.4, 0.9, seedB.y ) ).add( seed.x.mul( 6.2832 ) );
	const drifted = base.add( vec3( sin( sway ), 0, cos( sway.mul( 0.8 ) ) ).mul( 0.6 ) );
	const relative = drifted.add( box.mul( 0.5 ) );
	const wrapped = relative.sub( box.mul( floor( relative.div( box ) ) ) ).sub( box.mul( 0.5 ) );
	material.positionNode = wrapped;
	material.scaleNode = vec2( mix( 0.012, 0.03, seedB.z ) );
	const centered = uv().sub( 0.5 ).mul( 2 );
	const distance = length( wrapped );
	const fade = smoothstep( 0.6, 1.6, distance ).mul( float( 1 ).sub( smoothstep( 11, 15, distance ) ) );
	material.colorNode = uniforms.snowColor;
	material.opacityNode = float( 1 ).sub( smoothstep( 0, 1, length( centered ) ) ).mul( fade ).mul( 0.6 ).mul( uniforms.overlayAmount );
	const mesh = new THREE.Mesh( new THREE.PlaneGeometry( 1, 1 ), material );
	mesh.count = count;
	mesh.frustumCulled = false;
	mesh.name = '全景·飘雪';
	return mesh;

}

// ===================== 叠加：花瓣（开场、花园）、萤火虫（哥特）=====================
// 和飘雪一样：相机周围一个盒子里几百个小精灵，位置全在顶点着色器里算。
// 花瓣：粉白，慢慢往下飘、横向晃；萤火虫：贴着地面那一层（眼睛以下 1.5 米到以上 1 米），慢慢绕，一闪一闪（HDR，加法混合）
function createDrifters( uniforms, kind, count ) {

	const fireflies = kind === 'fireflies';
	const material = new THREE.SpriteNodeMaterial();
	material.name = fireflies ? '全景·萤火虫' : '全景·花瓣';
	material.transparent = true;
	material.depthWrite = false;
	if ( fireflies ) material.blending = THREE.AdditiveBlending;
	const index = instanceIndex.toFloat();
	const seed = hash33( vec3( index, 23, 7 ) );
	const seedB = hash33( vec3( index, 23, 8 ) );
	const box = float( fireflies ? 36 : 26 );
	const time = uniforms.time;
	let position;
	if ( fireflies ) {

		const wander = vec3(
			sin( time.mul( mix( 0.2, 0.45, seedB.x ) ).add( seed.z.mul( 30 ) ) ).mul( 1.6 ),
			sin( time.mul( mix( 0.3, 0.6, seedB.y ) ).add( seed.x.mul( 20 ) ) ).mul( 0.4 ),
			cos( time.mul( mix( 0.2, 0.4, seedB.z ) ).add( seed.y.mul( 11 ) ) ).mul( 1.6 ),
		);
		position = vec3( seed.x.sub( 0.5 ).mul( box ), mix( - 1.5, 1, seed.y ), seed.z.sub( 0.5 ).mul( box ) ).add( wander );

	} else {

		const velocity = vec3( 0.3, mix( - 0.3, - 0.6, seedB.x ), 0.5 );
		const base = seed.mul( box ).add( velocity.mul( time ) );
		const sway = time.mul( mix( 0.5, 1.1, seedB.y ) ).add( seed.x.mul( 6.2832 ) );
		const drifted = base.add( vec3( sin( sway ), 0, cos( sway.mul( 0.7 ) ) ).mul( 0.7 ) );
		const relative = drifted.add( box.mul( 0.5 ) );
		position = relative.sub( box.mul( floor( relative.div( box ) ) ) ).sub( box.mul( 0.5 ) );

	}

	material.positionNode = position;
	material.scaleNode = vec2( fireflies ? 0.07 : mix( 0.03, 0.05, seedB.z ) );
	const centered = uv().sub( 0.5 ).mul( 2 );
	const distance = length( position );
	const fade = smoothstep( 0.6, 1.6, distance ).mul( float( 1 ).sub( smoothstep( box.mul( 0.38 ), box.mul( 0.5 ), distance ) ) );
	if ( fireflies ) {

		const phase = fract( time.mul( mix( 0.2, 0.5, seed.z ) ).add( seedB.x ) );
		const pulse = smoothstep( 0, 0.15, phase ).mul( float( 1 ).sub( smoothstep( 0.25, 0.6, phase ) ) );
		material.colorNode = color( '#d8ff7a' ).mul( pulse.mul( 4 ) );
		material.opacityNode = float( 1 ).sub( smoothstep( 0, 1, length( centered ) ) ).mul( fade ).mul( uniforms.overlayAmount );

	} else {

		material.colorNode = mix( color( '#f6cfdb' ), color( '#fff1f4' ), seedB.y ).mul( 0.85 );
		// 花瓣的形状：一头圆一头尖的椭圆
		const petal = float( 1 ).sub( smoothstep( 0.7, 1, length( centered.mul( vec2( 1.6, 1 ) ).add( vec2( 0, centered.x.mul( centered.x ).mul( 0.3 ) ) ) ) ) );
		material.opacityNode = petal.mul( fade ).mul( 0.9 ).mul( uniforms.overlayAmount );

	}

	const mesh = new THREE.Mesh( new THREE.PlaneGeometry( 1, 1 ), material );
	mesh.count = count;
	mesh.frustumCulled = false;
	mesh.name = material.name;
	return mesh;

}

// ===================== 地点替身模块 =====================

export function createPanoramaModule( key ) {

	const state = {
		ctx: null,
		scene: null,
		ready: false,
		location: null,          // config.panorama.locations[ key ]
		points: [],              // 清单里的烘焙点
		loaded: new Map(),       // 烘焙点序号 → { image, mask, sky, dispose }
		loading: new Map(),
		slots: [ - 1, - 1 ],     // 现在 A、B 两个槽里放的是哪个烘焙点
		uniforms: null,
		nodes: null,
		auroraPass: null,
		frameIndex: 0,
		auroraUpdates: 0,        // 进场以后极光贴图更新了几次（前几次按次数平均，收敛得快）
		disposables: [],
		gulls: [],
	};

	const emptyTexture = new THREE.DataTexture( new Uint8Array( [ 0, 0, 0, 255 ] ), 1, 1 );
	emptyTexture.needsUpdate = true;
	const emptyHalfTexture = new THREE.DataTexture( new Uint16Array( [ 0, 0, 0, 15360 ] ), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType );
	emptyHalfTexture.needsUpdate = true;

	function ensurePoint( index ) {

		if ( state.loaded.has( index ) ) return Promise.resolve( state.loaded.get( index ) );
		if ( state.loading.has( index ) ) return state.loading.get( index );
		const promise = loadPoint( state.points[ index ] ).then( ( textures ) => {

			state.loading.delete( index );
			if ( ! state.ready && ! state.scene ) {

				textures.dispose();
				return null;

			}

			state.loaded.set( index, textures );
			return textures;

		} );
		state.loading.set( index, promise );
		return promise;

	}

	// 这一刻在哪两个烘焙点之间、淡到哪了
	function scheduleAt( time ) {

		const points = state.location.points;
		let current = 0;
		for ( let i = 1; i < points.length; i ++ ) if ( time >= points[ i ].switchAt - state.ctx.config.panorama.crossfade ) current = i - 1;
		const next = Math.min( points.length - 1, current + 1 );
		if ( next === current ) return { first: current, second: current, blend: 0 };
		const end = points[ next ].switchAt;
		const start = end - state.ctx.config.panorama.crossfade;
		const amount = Math.min( 1, Math.max( 0, ( time - start ) / ( end - start ) ) );
		return { first: current, second: next, blend: amount * amount * ( 3 - 2 * amount ) };

	}

	// 把烘焙点放进槽里（纹理节点换 value，不重新编译）；没解码完就先放一张 1×1 的黑图，解完下一帧换上
	function assignSlot( slot, index ) {

		const textures = state.loaded.get( index );
		const nodes = state.nodes[ slot ];
		if ( ! textures ) {

			ensurePoint( index );
			return false;

		}

		if ( state.slots[ slot ] === index ) return true;
		nodes.image.value = textures.image;
		nodes.mask.value = textures.mask;
		nodes.sky.value = textures.sky;
		state.slots[ slot ] = index;
		return true;

	}

	function buildMaterial() {

		const uniforms = state.uniforms;
		const overlays = state.location.overlays || [];
		const material = new THREE.MeshBasicNodeMaterial();
		material.name = '全景·' + key;
		material.side = THREE.BackSide;
		material.depthWrite = false;
		material.fog = false;
		material.lights = false;

		material.colorNode = Fn( () => {

			const direction = normalize( positionWorld.sub( cameraPosition ) ).toVar();
			const mapUV = panoramaUV( direction ).toVar();
			const nodesA = state.nodes[ 0 ];
			const nodesB = state.nodes[ 1 ];
			const color = mix( nodesA.image.sample( mapUV ).rgb, nodesB.image.sample( mapUV ).rgb, uniforms.blend ).toVar();
			const mask = mix( nodesA.mask.sample( mapUV ), nodesB.mask.sample( mapUV ), uniforms.blend ).toVar();
			const smoothSky = mix( nodesA.sky.sample( mapUV ).rgb, nodesB.sky.sample( mapUV ).rgb, uniforms.blend ).toVar();

			// 天空里平滑的地方换成高精度渐变（8 位全景图在暗的大片渐变里会出色带）；星星、月亮、云边这些和渐变差得多的地方留着原图
			const difference = abs( luminance( color ).sub( luminance( smoothSky ) ) );
			const smoothness = float( 1 ).sub( smoothstep( 0.003, 0.025, difference ) );
			color.assign( mix( color, smoothSky, mask.r.mul( smoothness ).mul( uniforms.skySmoothing ) ) );

			// 实时极光（雪原）：低分辨率、少步数的同一套极光，只画在天空里（烘焙时把极光那一层关了）
			if ( overlays.includes( 'aurora' ) && state.auroraPass ) {

				// 低分辨率、少步数的极光每个纹素自带抖动噪声：在对角两个半纹素上各取一次平均（双线性一次等于摸到 4 个纹素），
				// 再加上贴图的时间累积，看起来是柔和的帘幕而不是一块块的。软件渲染下每多一次采样都很贵，所以只取两次
				const center = hemisphereUV( direction );
				const texel = vec2( 0.5 ).div( uniforms.auroraResolution );
				const aurora = state.auroraPass.readNode.sample( center.add( texel ) ).rgb
					.add( state.auroraPass.readNode.sample( center.sub( texel ) ).rgb ).mul( 0.5 );
				color.addAssign( aurora.mul( mask.r ).mul( step( 0, direction.y ) ).mul( uniforms.overlayAmount ) );

			}

			// 闪点：遮罩 G 是烘焙时量出来的闪光密度。按全景上 2048 × 1024 的格子，每格最多一个，随时间生灭；
			// 没有泛光，星芒用一个十字形的软光代替（规格书 6.2：pano 下闪点星芒用预模糊的精灵代替）
			if ( overlays.includes( 'sparkles' ) ) {

				// 遮罩里很弱的值（开关闪点层时泛光的差异）不算：密度低于 0.04 的地方不出闪点
				const density = smoothstep( 0.04, 0.5, mask.g );
				If( density.greaterThan( 0.001 ), () => {

					const grid = mapUV.mul( vec2( 2048, 1024 ) );
					const cell = floor( grid );
					const local = fract( grid ).sub( 0.5 );
					const random = hash33( vec3( cell, 7 ) );
					const present = step( random.x, density.mul( uniforms.sparkleRate ) );
					const offset = local.sub( random.yz.sub( 0.5 ).mul( 0.5 ) );
					const twinkle = pow( max( sin( uniforms.time.mul( random.y.mul( 2 ).add( 1.5 ) ).add( random.z.mul( 6.2832 ) ) ), 0 ), 6 );
					const core = exp( dot( offset, offset ).mul( - 45 ) );
					const streak = exp( offset.x.mul( offset.x ).mul( - 250 ) ).mul( exp( abs( offset.y ).mul( - 7 ) ) )
						.add( exp( offset.y.mul( offset.y ).mul( - 250 ) ).mul( exp( abs( offset.x ).mul( - 7 ) ) ) );
					color.addAssign( uniforms.sparkleColor.mul( present.mul( twinkle ).mul( core.add( streak.mul( 0.45 ) ) ) ).mul( uniforms.sparkleIntensity ).mul( uniforms.overlayAmount ) );

				} );

			}

			// 海鸥（落日）：天上两个 V 形剪影，翅膀扇（位置每帧在 CPU 上算好）
			if ( overlays.includes( 'seagulls' ) ) {

				for ( const gull of state.gulls ) {

					const forward = gull.direction;
					const right = normalize( cross( forward, vec3( 0, 1, 0 ) ) );
					const up = cross( right, forward );
					const local = vec2( dot( direction, right ), dot( direction, up ) ).div( gull.size );
					const facing = step( 0.9, dot( direction, forward ) );
					const wingLine = local.y.add( abs( local.x ).mul( gull.flap ) );
					const wing = float( 1 ).sub( smoothstep( 0.06, 0.16, abs( wingLine ) ) ).mul( step( abs( local.x ), 1 ) );
					color.assign( mix( color, vec3( 0.05, 0.04, 0.06 ), wing.mul( facing ).mul( 0.85 ).mul( uniforms.overlayAmount ) ) );

				}

			}

			return color;

		} )();

		return material;

	}

	async function init( ctx ) {

		if ( state.scene ) dispose();
		const location = ctx.config.panorama.locations[ key ];
		const entry = manifest.locations[ key ];
		if ( ! location || ! entry ) throw new Error( `全景：地点「${ key }」没有烘焙数据` );
		state.ctx = ctx;
		state.location = location;
		state.points = entry.points;

		const overlays = location.overlays || [];
		const auroraSize = ctx.quality.software ? auroraSizes.software : auroraSizes.gpu;
		state.uniforms = {
			time: uniform( 0 ),
			blend: uniform( 0 ),
			skySmoothing: uniform( 1 ),
			overlayAmount: uniform( 1 ),
			sparkleRate: uniform( key === 'sunset' ? 0.9 : 0.6 ),
			sparkleIntensity: uniform( 1.6 ),
			sparkleColor: uniform( new THREE.Color( key === 'sunset' ? '#ffe2b0' : '#dfeaff' ) ),
			snowColor: uniform( new THREE.Color( '#9fb4e0' ) ),
			// 极光 pass 要的几个
			sceneTime: uniform( 0 ),
			frameIndex: uniform( 0 ),
			auroraSteps: uniform( auroraSize.steps, 'int' ),
			auroraResolution: uniform( new THREE.Vector2( auroraSize.width, auroraSize.height ) ),
			auroraRayScale: uniform( 12 ),
			auroraBlend: uniform( 1 ),
			auroraBrightness: uniform( ctx.config.aurora.auroraBrightness ),
		};
		state.nodes = [ 0, 1 ].map( () => ( { image: texture( emptyTexture ), mask: texture( emptyTexture ), sky: texture( emptyHalfTexture ) } ) );

		if ( overlays.includes( 'seagulls' ) ) {

			state.gulls = [ 0, 1 ].map( () => ( { direction: uniform( new THREE.Vector3( 0, 0.1, - 1 ) ), flap: uniform( 0.5 ), size: uniform( 0.012 ) } ) );

		}

		if ( overlays.includes( 'aurora' ) ) {

			state.auroraPass = createAuroraPass( ctx.renderer, state.uniforms, ctx.config.aurora );
			state.auroraPass.setResolution( auroraSize.width, auroraSize.height );

		}

		const scene = new THREE.Scene();
		scene.name = '全景·' + key;
		scene.background = new THREE.Color( 0x000000 );
		const material = buildMaterial();
		const sphere = new THREE.Mesh( new THREE.SphereGeometry( 50, 96, 48 ), material );
		sphere.frustumCulled = false;
		sphere.name = '全景球';
		scene.add( sphere );
		state.disposables.push( sphere.geometry, material );
		for ( const kind of [ 'petals', 'fireflies' ] ) {

			if ( ! overlays.includes( kind ) ) continue;
			const drifters = createDrifters( state.uniforms, kind, kind === 'petals' ? 520 : 240 );
			scene.add( drifters );
			state.disposables.push( drifters.geometry, drifters.material );

		}

		if ( overlays.includes( 'snow' ) ) {

			const snow = createSnow( state.uniforms, 700 );
			scene.add( snow );
			state.disposables.push( snow.geometry, snow.material );

		}

		state.scene = scene;
		state.ready = true;

		// 先解开头两个烘焙点（规格书：只解当前和下一个），第三个停留中途再解
		await ensurePoint( 0 );
		if ( state.points.length > 1 ) await ensurePoint( 1 );
		assignSlot( 0, 0 );
		assignSlot( 1, Math.min( 1, state.points.length - 1 ) );
		return { scene };

	}

	// 预编译（时间线调；全景场景画进不带 MSAA 的目标，和实时场景不是同一个上下文）。编完在同格式的小目标上真画一帧：
	// 两张 8192 宽的全景图在这里传上显卡（软件渲染下要几百毫秒，放在停留期间做，不放到到达那一帧）
	async function compile( warmCamera ) {

		if ( ! state.ready ) return;
		const ctx = state.ctx;
		const jobs = [ ctx.pipeline.compileScene( state.scene, warmCamera, null, ctx.pipeline.panoTarget ) ];
		if ( state.auroraPass ) jobs.push( state.auroraPass.compile( ctx.pipeline ) );
		await Promise.all( jobs );
		if ( ! state.ready ) return;
		const target = new THREE.RenderTarget( 4, 4, { type: THREE.HalfFloatType, samples: 0 } );
		const previous = ctx.renderer.getRenderTarget();
		ctx.renderer.setRenderTarget( target );
		ctx.renderer.render( state.scene, warmCamera );
		ctx.renderer.setRenderTarget( previous );
		target.dispose();

	}

	function viewKeyframes() {

		return state.location.views.map( ( view ) => ( { time: view.time, position: [ 0, 0, 0 ], lookAt: directionOf( view.yaw, view.pitch ).map( ( value ) => value * 100 ), fov: view.fov } ) );

	}

	function enter() {

		if ( ! state.ready ) throw new Error( `全景「${ key }」：还没 init 就调了 enter` );
		const ctx = state.ctx;
		const panoramaConfig = ctx.config.panorama;
		ctx.director.setRoute( viewKeyframes() );
		state.auroraUpdates = 0;
		ctx.director.setDragOptions( { yawMax: panoramaConfig.dragYawMax, pitchMax: panoramaConfig.dragPitchMax, returnDelay: panoramaConfig.dragReturnDelay, returnDamping: panoramaConfig.dragReturnDamping } );

	}

	function update( dt, time ) {

		if ( ! state.ready ) return;
		const uniforms = state.uniforms;
		uniforms.time.value = time;
		uniforms.sceneTime.value = time;

		const schedule = scheduleAt( time );
		const firstReady = assignSlot( 0, schedule.first );
		const secondReady = assignSlot( 1, schedule.second );
		uniforms.blend.value = firstReady && secondReady ? schedule.blend : 0;
		// 后面的烘焙点提前解码；用过的放掉（只留当前两个和下一个）
		const upcoming = Math.min( state.points.length - 1, schedule.second + 1 );
		if ( ! state.loaded.has( upcoming ) ) ensurePoint( upcoming );
		for ( const [ index, textures ] of state.loaded ) {

			if ( index < schedule.first && state.slots[ 0 ] !== index && state.slots[ 1 ] !== index ) {

				textures.dispose();
				state.loaded.delete( index );

			}

		}

		// 极光：每 4 帧更新一次贴图（8 步，光线放宽），时间累积补上
		if ( state.auroraPass ) {

			state.frameIndex ++;
			uniforms.frameIndex.value = state.frameIndex % 1024;
			if ( state.frameIndex % 4 === 1 ) {

				// 前几次是逐次平均（1、1/2、1/3……），很快就把每次不同的抖动噪声抹平；之后是 0.2 的指数平均，跟得上帘幕慢慢流动
				state.auroraUpdates ++;
				state.auroraPass.render( Math.max( 0.2, 1 / state.auroraUpdates ) );

			}

		}

		// 海鸥：在太阳那边慢慢盘旋，翅膀扇
		state.gulls.forEach( ( gull, index ) => {

			const angle = time * ( index === 0 ? 0.035 : - 0.028 ) + index * 2.3;
			const yaw = Math.sin( angle ) * 14 + ( index === 0 ? - 8 : 10 );
			const pitch = 9 + Math.sin( time * 0.3 + index ) * 1.5 + index * 4;
			gull.direction.value.fromArray( directionOf( yaw, pitch ) );
			gull.flap.value = 0.35 + Math.sin( time * ( 5 + index ) ) * 0.35;
			gull.size.value = index === 0 ? 0.014 : 0.009;

		} );

	}

	function exit() {

		if ( ! state.ctx ) return;
		state.ctx.director.setDragOptions( null );

	}

	function dispose() {

		state.ready = false;
		for ( const textures of state.loaded.values() ) textures.dispose();
		state.loaded.clear();
		for ( const item of state.disposables ) item.dispose();
		state.disposables = [];
		if ( state.auroraPass ) state.auroraPass.dispose();
		state.auroraPass = null;
		if ( state.scene ) state.scene.clear();
		state.scene = null;
		state.slots = [ - 1, - 1 ];
		state.gulls = [];
		state.ctx = null;

	}

	return {
		key,
		isPanorama: true,
		customCompile: true,
		init,
		compile,
		enter,
		update,
		exit,
		dispose,
		// 出生点：全景的镜头就在原点，朝第一个视角
		getSpawn: () => {

			const view = state.location ? state.location.views[ 0 ] : { yaw: 0, pitch: 0 };
			return { position: [ 0, 0, 0 ], lookAt: directionOf( view.yaw, view.pitch ).map( ( value ) => value * 100 ) };

		},
		getLayers: () => ( state.uniforms ? { 叠加动态: state.uniforms.overlayAmount, 天空渐变: state.uniforms.skySmoothing } : {} ),
	};

}

// ===================== 飞行视频 =====================
// 一个盖在画布上面的 <video>（不进 WebGL：软件渲染下用浏览器自己的视频解码最省），按飞行时间同步播放，首尾交叉淡化

export function createFlightVideo( host ) {

	const video = document.createElement( 'video' );
	video.className = 'panoramaFlight';
	video.muted = true;
	video.playsInline = true;
	video.preload = 'auto';
	video.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;opacity:0;z-index:1;background:transparent;';
	host.appendChild( video );
	const urls = new Map();
	let currentKey = '';

	return {
		// 先把这一段的视频准备好（解 base64 成 Blob，交给 <video>）
		async prepare( fromKey, toKey ) {

			const flight = flightVideoOf( fromKey, toKey );
			if ( ! flight ) return null;
			const key = fromKey + '-' + toKey;
			if ( ! urls.has( key ) ) urls.set( key, URL.createObjectURL( await blobOf( flight.video ) ) );
			if ( currentKey !== key ) {

				currentKey = key;
				video.src = urls.get( key );
				video.load();

			}

			return flight;

		},
		// 每帧：按飞行时间同步（差得多才跳，平时让它自己播）、设不透明度；paused 时停住
		sync( time, opacity, paused ) {

			// 视频还没解出这一帧（刚换源、跳转中，软件渲染下几十兆的视频要等一会儿）时先不盖上去，下面的画面照常显示；
			// 原来 <video> 底色是黑的，跳到飞行 25% 那一下整屏黑（软件渲染回归里的"可疑纯色"）
			const decoded = video.readyState >= 2 && ! video.seeking;
			video.style.opacity = String( decoded ? Math.max( 0, Math.min( 1, opacity ) ) : 0 );
			if ( opacity <= 0 ) {

				if ( ! video.paused ) video.pause();
				return;

			}

			if ( Math.abs( video.currentTime - time ) > 0.25 ) video.currentTime = time;
			if ( paused && ! video.paused ) video.pause();
			if ( ! paused && video.paused ) video.play().catch( () => {} );

		},
		hide() {

			video.style.opacity = '0';
			if ( ! video.paused ) video.pause();

		},
		dispose() {

			video.remove();
			for ( const url of urls.values() ) URL.revokeObjectURL( url );
			urls.clear();

		},
	};

}
