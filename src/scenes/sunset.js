// 场景 2：黄昏落日与海。规格书第 8 节。
// 人自由漫游（WASD 走、拖动转头），站在礁石岸上看太阳压着海平线、一条金色光路从太阳铺到脚下。
//
// 组成：
//   天空：SkyMesh（Preetham 模型）+ 往配色表拉的调色 + 自己画的 HDR 太阳圆盘 + 抖动去色带；同一片天空生成环境光贴图（PMREM）
//   海面：环形网格（近密远疏）上叠 8 个 Gerstner 波做位移；片元里重新算波的法线并按像素足迹逐个滤掉高频波，
//         再叠两层滚动的细节波纹贴图（自带 mip，记录每级丢掉的斜率方差，LEAN 的做法）
//   光路：Cox–Munk 斜率分布当高光瓣，σ² = 0.003 + 0.00512·风速；被滤掉的波的方差补回 σ²，远近能量连续；
//         再叠 sparkle.js 的闪点，让光路碎成一粒粒（闪点随时间生灭）
//   浪尖透绿、浪峰和礁石边的泡沫、浅水色；反射：高中档用 reflector() 平面反射，低档用环境光贴图
//   礁石岸：CPU 高度场（岸线、脊状噪声、块状起伏），平缓的低处是沙滩；程序化海蚀柱和礁石；湿的部分更暗更光滑
//   海鸥：两只 V 形剪影，翅膀在顶点着色器里扇
//
// 接入秘境（4b）：远处的海岸、山、其他地点都由常驻远景画（原来自己的"远岸"删了）；太阳按世界的时刻走（18:50 → 19:00，
// 和阶段 2 一样从 2.6° 竖直沉到 1.0°）；天空是叠加层，交接时渐变到统一天空；内容按 locationVeil 化进同色薄雾；
// 海雾也盖到远景上（接缝看不出来）；远景的海在海面圆盘里沉下去、海面在世界的陆地底下沉下去，两层水不重面

import * as THREE from 'three/webgpu';
import {
	Fn, If, uniform, float, vec2, vec3, vec4, color, texture, varying, attribute, NodeUpdateType,
	positionGeometry, positionWorld, positionView, normalWorld, normalWorldGeometry, normalViewGeometry, cameraPosition, cameraViewMatrix, screenCoordinate, faceDirection,
	mix, smoothstep, clamp, max, min, abs, pow, exp, sqrt, sin, cos, floor, length, normalize, dot, cross, reflect,
	dFdx, dFdy, fwidth, luminance, pmremTexture, reflector,
} from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash21, fbm2D, fbm3D, voronoi2D, jsFbm2D, jsValueNoise2D, jsHash21 } from '../tsl/noise.js';
import { sparkleLayer } from '../tsl/sparkle.js';
import { heightFog, applyVeil } from '../tsl/fog.js';
import { buildCreekRibbon, createCreekMaterial, flattenModel } from './narrows.js';
import { loadModel, disposeModel } from '../core/assets.js';
import { isMeshInView, prepareMeshView } from '../core/camera.js';
import { groundDetailInScene } from '../tsl/terrain.js';

export const key = 'sunset';

// ===================== 布局（米）=====================
// 太阳在 -z 方向；岸线大致沿 x 轴，陆地在 +z 一侧，往里慢慢抬高；海在 -z 一侧。

const terrainSize = 220;
const terrainCenterZ = 10;
const terrainResolution = 320;
const oceanCenter = new THREE.Vector2( 0, 8 );
const oceanRadius = 1960;          // 海面铺到接近相机远裁剪面（2000）
const gravity = 9.81;

// 岸线：z = shoreZ(x)，z 比它大是陆地。出生点前面（x≈0）有一块伸进海里的礁石岬角
function shoreZ( x ) {

	return - 2 + 5.5 * Math.sin( x * 0.043 + 0.6 ) + 2.5 * Math.sin( x * 0.12 + 2.0 ) - 7 * Math.exp( - ( x / 10 ) * ( x / 10 ) );

}

// ===================== 模块状态 =====================

const state = {
	ctx: null,
	scene: null,
	ready: false,
	disposables: [],
	uniforms: null,
	layers: null,
	heightData: null,          // 地形高度（不含海里的礁石），走路用
	rockSpots: [],             // 礁石和海蚀柱 { x, z, radius, height, seed, kind }
	sky: null,
	environmentScene: null,
	environmentTarget: null,
	environmentReady: false,   // 真正的环境光贴图生成过没有（init 时先画一张空的，天空编好以后再画真的）
	lastEnvironmentElevation: - 99,
	lastEnvironmentDarken: - 1,
	sunLight: null,
	ocean: null,
	oceanMaterials: { reflective: null, plain: null },
	reflectorNode: null,
	reflectorTarget: null,
	seagulls: null,
	waves: null,
	veil: null,                // 交接薄雾的参数（fog.js 的 veil）
	creek: null,               // 小溪（阶段 12 CP3 返工）
	reflectionPass: null,      // 平面反射：每帧画主场景之前在最外层画（见 createOceanMaterial）
	oceanCenterWorld: [ 0, 0 ],
	fogColor: new THREE.Color(),
	fogScatter: new THREE.Color(),
	sunDirection: new THREE.Vector3(),
	sunTint: new THREE.Color(),
	environmentCameraPosition: new THREE.Vector3( 0, 2, 0 ),
	heightTexture: null,
	rippleTexture: null,
	oceanGrid: null,
	duration: 70,
	pendingOceanSwitch: false,
	sunLowColor: new THREE.Color( '#ff8a4a' ),   // 太阳贴着海平线时的颜色
	sunHighColor: new THREE.Color(),             // 太阳高一点时的颜色（config.sunset.sunColor）
	currentTier: '',
	shadowCenter: new THREE.Vector3( NaN, NaN, NaN ),   // 阴影图上一次画的中心（吸附后）
	shadowLightDirection: new THREE.Vector3(),          // 上一次画阴影图时的太阳方向
	shadowFrames: 0,                                    // 离上一次画阴影图过了几帧
};

// ===================== 地形（CPU 高度场）=====================

// edgeHeight：这一点远景地形画出来的高度（本地坐标），半岛岸上那几边落到它下面 0.5 米接进世界的地面；没有就沉到 −4
function terrainHeightRaw( x, z, edgeHeight = NaN ) {

	const distance = z - shoreZ( x );   // 正 = 陆地一侧

	// 陆地：从岸边 0.9 米往里抬高，岸边十几米陡一点（每米约 0.1 米），再往里很缓（每米 0.025 米），一直到身后岩丘脚下都是一片低平的地；
	// 海底：往外越来越深，最深 6 米。（2026-10-02 改：原来 40 米外再抬 3.5 米，内陆是一块高出去的沙台子，镜头要从挖出来的沟里穿过）
	const land = 0.9 + 0.025 * distance + 1.12 * ( 1 - Math.exp( - Math.max( distance, 0 ) / 14 ) );
	const sea = Math.max( - 6, - 0.4 + 0.25 * distance );
	let height = sea + ( land - sea ) * smoothstepJs( - 3, 2, distance );

	// 小溪离这里多远（溪床、沙丘的口子用）
	const creek = creekDistance( x, z );

	// 沙丘：离岸 16~58 米一带，圆鼓鼓的（噪声取 1.5 次方，顶是圆的、丘间是平的）；小溪两边 6~18 米、出生点身后（|x| < 8~22 米）是溪水冲平的低地，没有丘
	const duneBand = smoothstepJs( 16, 26, distance ) * ( 1 - smoothstepJs( 46, 58, distance ) );
	const duneGap = smoothstepJs( 6, 18, creek ) * smoothstepJs( 8, 22, Math.abs( x - 1 ) );
	height += Math.pow( jsFbm2D( x / 26 + 1.3, z / 19 - 4.2, 3 ), 1.5 ) * 2.4 * duneBand * duneGap;

	// 内陆的草甸：很缓的起伏 ±0.6 米
	height += ( jsFbm2D( x / 38 - 2.6, z / 38 + 5.1, 3 ) - 0.5 ) * 1.2 * smoothstepJs( 40, 70, distance );

	// 溪床：中线挖下去 0.45 米，岸是 2.5 米宽的缓坡；进了海就不挖
	height -= 0.45 * ( 1 - smoothstepJs( creekHalfWidth * 0.6, creekHalfWidth + 2.5, creek ) ) * smoothstepJs( 0, 4, distance );

	// 岸边一带的岩石起伏：脊状噪声（1 - |2n - 1|）出棱，立方让棱更窄、谷更宽（只到离岸 30~42 米，再往里是沙丘和草甸）
	const band = smoothstepJs( - 8, - 2, distance ) * ( 1 - smoothstepJs( 28, 42, distance ) );
	const ridge = 1 - Math.abs( 2 * jsFbm2D( x / 14 + 4.2, z / 14 - 1.7, 3 ) - 1 );
	height += ridge * ridge * ridge * 2.6 * band;
	const smallRidge = 1 - Math.abs( 2 * jsFbm2D( x / 5 - 7.7, z / 5 + 3.3, 2 ) - 1 );
	height += smallRidge * smallRidge * 0.6 * band;
	height += ( jsFbm2D( x / 4 - 2.3, z / 4 + 8.1, 3 ) - 0.5 ) * 0.5 * band;

	// 半岛的边：海里那边慢慢沉到 −4（藏在水下），岸上那几边落到远景地形下面 0.5 米，接进世界的地面，不留一圈水沟
	const island = smoothstepJs( 108, 82, Math.abs( x ) ) * smoothstepJs( 118, 92, z );
	const edge = Number.isFinite( edgeHeight ) ? - 4 + ( edgeHeight - 0.5 + 4 ) * smoothstepJs( - 3, 3, distance ) : - 4;
	height = edge + ( height - edge ) * island;

	// 中尺度的块状岩石：值噪声量化成几级再平滑，出平台和陡坎，但不是一圈圈的等高线
	const blocks = jsValueNoise2D( x / 3.2 + 9.1, z / 3.2 - 4.4 );
	const blockLevel = Math.round( blocks * 4 ) / 4;
	height += ( blocks * 0.4 + blockLevel * 0.6 - 0.5 ) * 0.7 * band;

	return height;

}

// 这个场景是在上一个场景播放时后台加载的。CPU 上的大循环要切成小段，每段不超过约 10 毫秒就让出主线程一次，
// 不然上一个场景会卡住半秒（用 setTimeout 而不是 requestAnimationFrame：截图模式下帧是手动推进的）
const sliceBudget = 10;
const yieldToBrowser = () => new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

async function yieldIfBusy( slice ) {

	if ( performance.now() - slice.start > sliceBudget ) {

		await yieldToBrowser();
		slice.start = performance.now();

	}

}

function smoothstepJs( edge0, edge1, value ) {

	const amount = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return amount * amount * ( 3 - 2 * amount );

}

// 海蚀柱（本地坐标 x、z、半径、高，米）：避开正前方的光路，左右各一组，远处一根小的。远景的替身也按这张表摆
export const seaStacks = [
	[ - 30, - 44, 4.5, 12 ], [ - 22, - 68, 3.0, 6.5 ], [ - 44, - 28, 2.4, 4.5 ],
	[ 52, - 82, 6.0, 15 ], [ 62, - 104, 3.4, 6 ], [ 14, - 96, 2.0, 3 ],
];

// 礁石摆放：海里几根海蚀柱 + 沿岸线半泡在水里的礁石 + 岸上几块大石头
function placeRocks() {

	const spots = [];
	seaStacks.forEach( ( item, i ) => spots.push( { x: item[ 0 ], z: item[ 1 ], radius: item[ 2 ], height: item[ 3 ], seed: 3.1 + i * 1.7, kind: 'stack' } ) );

	// 岸边礁石：两块一簇，每 8 米一簇沿岸线排，离岸 -5~+1 米，出生点左右留空
	for ( let i = 0; i < 34; i ++ ) {

		// 两块一簇：每簇中心沿岸线排，簇里再偏一点
		const cluster = Math.floor( i / 2 );
		const x = - 66 + cluster * 8 + ( jsHash21( i, 1.3 ) - 0.5 ) * 6;
		const radius = 0.6 + Math.pow( jsHash21( i, 5.1 ), 2 ) * 2.2;
		// 出生点（x≈0.5）左右留空：石头连同挡人的范围（1.5 倍半径）离它至少 2 米，人不会一出生就被推开
		if ( Math.abs( x - 0.5 ) - ( radius * 1.5 + 0.3 ) < 2 ) continue;
		const offset = - 5 + jsHash21( i, 2.7 ) * 6;
		spots.push( { x, z: shoreZ( x ) + offset, radius, height: 1.0 + jsHash21( i, 6.4 ) * 2.0, seed: 11 + i * 2.3, kind: 'shore' } );

	}

	// 岸上的大石头（人绕着走）
	const landRocks = [ [ - 9, 6, 1.4 ], [ 8, 4, 1.1 ], [ - 18, 14, 1.8 ], [ 15, 18, 1.5 ], [ - 4, 26, 1.2 ], [ 24, 9, 1.0 ], [ - 26, 8, 2.2 ], [ 30, 20, 1.7 ], [ 4, 14, 0.8 ], [ - 12, 22, 0.9 ] ];
	landRocks.forEach( ( item, i ) => spots.push( { x: item[ 0 ], z: item[ 1 ], radius: item[ 2 ], height: item[ 2 ] * 1.1, seed: 41 + i * 1.9, kind: 'land' } ) );

	return spots;

}

// 小溪（阶段 12 CP3 返工）：从身后岩丘的口子里流出来（口子和口子里那段溪在远景里，见 narrows.js），穿过草甸、
// 从沙丘的口子里出来，在出生点左手边流进海里。本地坐标的中线，开头接着远景那段溪的尾巴（本地 z ≈ 104~108 两段交叉淡入淡出）
const creekPath = [ [ 0, 108 ], [ - 1.5, 92 ], [ - 5, 74 ], [ - 11, 54 ], [ - 17, 34 ], [ - 22, 16 ], [ - 26, 0 ], [ - 29, - 14 ] ];
const creekHalfWidth = 1.3;

// 本地 (x, z) 离小溪中线多远（米）
function creekDistance( x, z ) {

	let best = Infinity;
	for ( let i = 1; i < creekPath.length; i ++ ) {

		const [ ax, az ] = creekPath[ i - 1 ];
		const [ bx, bz ] = creekPath[ i ];
		const dx = bx - ax;
		const dz = bz - az;
		const t = Math.min( 1, Math.max( 0, ( ( x - ax ) * dx + ( z - az ) * dz ) / ( dx * dx + dz * dz ) ) );
		best = Math.min( best, Math.hypot( x - ax - dx * t, z - az - dz * t ) );

	}

	return best;

}

// 飞行贴地用：自己地形块里的地面高度（本地），块外面是 NaN（交给远景）
export function ownGroundAt( x, z ) {

	if ( ! state.heightData ) return NaN;
	if ( Math.abs( x ) > terrainSize / 2 || Math.abs( z - terrainCenterZ ) > terrainSize / 2 ) return NaN;
	return heightAt( x, z );

}

// 高度场：R = 地形高度（海面算水深、浅水色用），G = 离礁石多近（1 = 贴着礁石，泡沫用），都存成半精度纹理
async function buildHeightField( spots ) {

	const resolution = terrainResolution;
	const heights = new Float32Array( resolution * resolution );
	const halfData = new Uint16Array( resolution * resolution * 2 );
	const cellSize = terrainSize / ( resolution - 1 );
	const slice = { start: performance.now() };

	for ( let j = 0; j < resolution; j ++ ) {

		await yieldIfBusy( slice );
		const z = terrainCenterZ - terrainSize / 2 + j * cellSize;
		// 这一行附近 2 倍半径内的礁石才可能影响到泡沫圈，先筛一遍
		const nearbySpots = spots.filter( ( spot ) => Math.abs( spot.z - z ) < spot.radius * 2 );
		for ( let i = 0; i < resolution; i ++ ) {

			const x = - terrainSize / 2 + i * cellSize;
			const ground = terrainHeightRaw( x, z, backdropHeightAt( x, z ) );
			// 礁石的网格半径大约在 0.7~1.2 倍 radius 之间，泡沫圈从 0.8 倍铺到 1.9 倍
			let rockProximity = 0;
			for ( const spot of nearbySpots ) {

				const ratio = Math.hypot( x - spot.x, z - spot.z ) / spot.radius;
				rockProximity = Math.max( rockProximity, 1 - smoothstepJs( 0.8, 1.9, ratio ) );

			}

			const index = j * resolution + i;
			heights[ index ] = ground;
			halfData[ index * 2 ] = THREE.DataUtils.toHalfFloat( ground );
			halfData[ index * 2 + 1 ] = THREE.DataUtils.toHalfFloat( rockProximity );

		}

	}

	const heightTexture = new THREE.DataTexture( halfData, resolution, resolution, THREE.RGFormat, THREE.HalfFloatType );
	heightTexture.magFilter = THREE.LinearFilter;
	heightTexture.minFilter = THREE.LinearFilter;
	heightTexture.wrapS = THREE.ClampToEdgeWrapping;
	heightTexture.wrapT = THREE.ClampToEdgeWrapping;
	heightTexture.generateMipmaps = false;
	heightTexture.needsUpdate = true;

	return { heights, heightTexture };

}

// 远景地形在本地 (x, z) 画出来的高度（本地坐标）；只在半岛边上用得到，里面不查（省时间）
const tempWorldPoint = new THREE.Vector3();
function backdropHeightAt( x, z ) {

	if ( Math.abs( x ) < 80 && z < 20 ) return NaN;
	const ctx = state.ctx;
	const location = ctx.world.locations[ key ];
	ctx.world.toWorld( tempWorldPoint.set( x, 0, z ), key, tempWorldPoint );
	return ctx.backdrop.getTerrainHeight( tempWorldPoint.x, tempWorldPoint.z ) - location.origin[ 1 ];

}

// 海面每个顶点下面世界的地面有多高（本地坐标，海里是 0）：远景的陆地上不铺海。半岛范围里本地地形自己挡着，记 0
async function fillLandHeights( geometry ) {

	const ctx = state.ctx;
	const location = ctx.world.locations[ key ];
	const angle = - location.yaw * Math.PI / 180;
	const cosine = Math.cos( angle );
	const sine = Math.sin( angle );
	const positions = geometry.attributes.position.array;
	const count = positions.length / 3;
	const heights = new Float32Array( count );
	const slice = { start: performance.now() };
	for ( let i = 0; i < count; i ++ ) {

		if ( ( i & 4095 ) === 0 ) await yieldIfBusy( slice );
		const x = positions[ i * 3 ];
		const z = positions[ i * 3 + 2 ];
		if ( Math.abs( x ) < terrainSize / 2 && Math.abs( z - terrainCenterZ ) < terrainSize / 2 ) continue;
		const worldX = x * cosine + z * sine + location.origin[ 0 ];
		const worldZ = - x * sine + z * cosine + location.origin[ 2 ];
		heights[ i ] = Math.max( 0, ctx.backdrop.getTerrainHeight( worldX, worldZ ) - location.origin[ 1 ] );

	}

	geometry.setAttribute( 'landHeight', new THREE.BufferAttribute( heights, 1 ) );

}

// JS 版地面高度（双线性，和网格一致），走路贴地用；场景释放后返回 NaN
function heightAt( x, z ) {

	if ( ! state.heightData ) return NaN;
	const resolution = terrainResolution;
	const gridX = ( x + terrainSize / 2 ) / terrainSize * ( resolution - 1 );
	const gridZ = ( z - ( terrainCenterZ - terrainSize / 2 ) ) / terrainSize * ( resolution - 1 );
	const i = Math.min( resolution - 2, Math.max( 0, Math.floor( gridX ) ) );
	const j = Math.min( resolution - 2, Math.max( 0, Math.floor( gridZ ) ) );
	const fractionX = Math.min( 1, Math.max( 0, gridX - i ) );
	const fractionZ = Math.min( 1, Math.max( 0, gridZ - j ) );
	const data = state.heightData;
	const near = data[ j * resolution + i ] * ( 1 - fractionX ) + data[ j * resolution + i + 1 ] * fractionX;
	const far = data[ ( j + 1 ) * resolution + i ] * ( 1 - fractionX ) + data[ ( j + 1 ) * resolution + i + 1 ] * fractionX;
	return near * ( 1 - fractionZ ) + far * fractionZ;

}

// 能不能站：地面高出海面 0.7 米以上（浪打不到脚），而且在地形范围内
function canWalk( x, z ) {

	if ( Math.abs( x ) > terrainSize / 2 - 15 ) return false;
	if ( z < terrainCenterZ - terrainSize / 2 + 15 || z > terrainCenterZ + terrainSize / 2 - 15 ) return false;
	return heightAt( x, z ) > 0.7;

}

function buildTerrainGeometry( segments ) {

	const geometry = new THREE.PlaneGeometry( terrainSize, terrainSize, segments, segments );
	geometry.rotateX( - Math.PI / 2 );
	geometry.translate( 0, 0, terrainCenterZ );
	const positions = geometry.attributes.position;
	for ( let i = 0; i < positions.count; i ++ ) {

		positions.setY( i, heightAt( positions.getX( i ), positions.getZ( i ) ) );

	}

	geometry.computeVertexNormals();
	return geometry;

}

// 世界 XZ → 高度纹理 UV（CPU 格点 i 在纹素中心 (i + 0.5) / res，半个纹素要对齐）
function terrainUV( xz ) {

	const scale = ( terrainResolution - 1 ) / terrainResolution / terrainSize;
	const offset = 0.5 / terrainResolution;
	return vec2(
		xz.x.add( terrainSize / 2 ).mul( scale ).add( offset ),
		xz.y.sub( terrainCenterZ - terrainSize / 2 ).mul( scale ).add( offset ),
	);

}

// ===================== 海浪参数 =====================
// Gerstner 波（Tessendorf《Simulating Ocean Water》、GPU Gems 第 1 章）：
//   水平位移 Σ Q·A·D·cosθ，竖直 Σ A·sinθ，θ = k(D·x) − ωt + φ，色散关系 ω = sqrt(g·k)。
// 8 个波，波长 2.5~54 米，方向都在主风向 ±40° 以内；斜率 k·A 从长波到短波 0.045~0.095，
// 陡度总和 Σ Q·k·A 压到 0.9 以下，浪峰不会打结。

function buildWaveSet( sunsetConfig, slopeScale ) {

	const wavelengths = [ 54, 35, 23, 15, 9.6, 6.2, 4.0, 2.5 ];
	const angleOffsets = [ 0, - 24, 18, - 36, 32, - 14, 38, - 28 ];
	const slopes = [ 0.045, 0.055, 0.065, 0.075, 0.08, 0.085, 0.09, 0.095 ];
	const windAngle = THREE.MathUtils.degToRad( sunsetConfig.windDirection );

	const waves = wavelengths.map( ( wavelength, i ) => {

		const angle = windAngle + THREE.MathUtils.degToRad( angleOffsets[ i ] );
		const wavenumber = Math.PI * 2 / wavelength;
		return {
			wavelength,
			directionX: Math.cos( angle ),
			directionZ: Math.sin( angle ),
			wavenumber,
			angularFrequency: Math.sqrt( gravity * wavenumber ),
			amplitude: slopes[ i ] * sunsetConfig.waveScale * slopeScale / wavenumber,
			phase: i * 2.39 + 0.7,
		};

	} );

	const slopeSum = waves.reduce( ( sum, wave ) => sum + wave.wavenumber * wave.amplitude, 0 );
	const choppiness = Math.min( sunsetConfig.waveChoppiness, 0.9 / slopeSum );
	// 这 8 个波自己贡献的斜率方差 Σ (kA)²/2（近处全部画出来，远处被滤掉的部分要补回 Cox–Munk 的 σ²）
	const resolvedVariance = waves.reduce( ( sum, wave ) => sum + ( wave.wavenumber * wave.amplitude ) ** 2 / 2, 0 );
	const totalAmplitude = waves.reduce( ( sum, wave ) => sum + wave.amplitude, 0 );

	return { waves, choppiness, resolvedVariance, totalAmplitude };

}

// 在 TSL 里叠加 Gerstner 波。footprint：这个像素（或这个顶点间距）在世界里多大，传了就逐个淡出画不下的短波，
// 淡出掉的斜率方差累加到 lostVariance。返回位移、两条切线、竖直位移、主涌浪相位
function gerstnerNodes( baseXZ, time, amplitudeScale, footprint ) {

	const { waves, choppiness } = state.waves;
	const offset = vec3( 0 ).toVar();
	const tangentX = vec3( 1, 0, 0 ).toVar();
	const tangentZ = vec3( 0, 0, 1 ).toVar();
	const lostVariance = float( 0 ).toVar();

	for ( const wave of waves ) {

		const { directionX, directionZ, wavenumber, angularFrequency, phase, wavelength } = wave;
		const theta = baseXZ.x.mul( directionX * wavenumber ).add( baseXZ.y.mul( directionZ * wavenumber ) ).sub( time.mul( angularFrequency ) ).add( phase );
		const sine = sin( theta );
		const cosine = cos( theta );
		// 一个像素（顶点间距）超过波长的 0.15 倍就开始淡，0.4 倍时完全不画（再画就是走样的摩尔纹）
		const keep = footprint ? float( 1 ).sub( smoothstep( wavelength * 0.15, wavelength * 0.4, footprint ) ) : float( 1 );
		const amplitude = amplitudeScale.mul( wave.amplitude ).mul( keep );
		const horizontal = amplitude.mul( choppiness );

		offset.addAssign( vec3( horizontal.mul( directionX ).mul( cosine ), amplitude.mul( sine ), horizontal.mul( directionZ ).mul( cosine ) ) );

		// 位移对 x0、z0 的偏导（两条切线），法线 = ∂P/∂z0 × ∂P/∂x0
		const slope = amplitude.mul( wavenumber );
		const chop = horizontal.mul( wavenumber ).mul( sine );
		tangentX.addAssign( vec3( chop.mul( - directionX * directionX ), slope.mul( directionX ).mul( cosine ), chop.mul( - directionX * directionZ ) ) );
		tangentZ.addAssign( vec3( chop.mul( - directionX * directionZ ), slope.mul( directionZ ).mul( cosine ), chop.mul( - directionZ * directionZ ) ) );

		if ( footprint ) {

			const fullSlope = amplitudeScale.mul( wave.amplitude * wavenumber );
			lostVariance.addAssign( float( 1 ).sub( keep.mul( keep ) ).mul( fullSlope.mul( fullSlope ) ).mul( 0.5 ) );

		}

	}

	// 主涌浪（第一个波）的相位，岸边泡沫按它一涌一涌
	const swell = waves[ 0 ];
	const swellPhase = baseXZ.x.mul( swell.directionX * swell.wavenumber ).add( baseXZ.y.mul( swell.directionZ * swell.wavenumber ) ).sub( time.mul( swell.angularFrequency ) ).add( swell.phase );

	return { offset, tangentX, tangentZ, lostVariance, swellPhase };

}

// ===================== 细节波纹贴图（CPU，启动时生成）=====================
// 256² 可平铺：56 个整数波矢的余弦波叠加（周期正好是贴图边长，所以无缝）。存的不是高度而是斜率：
// R、G = 斜率 (∂h/∂u, ∂h/∂w)，B = 斜率平方和，A = 归一化高度。斜率和平铺尺寸无关，只看波的陡度。
// mip 自己用 2×2 平均生成：平均后的 R、G 是这一块的平均斜率，B 是平均的斜率平方，
// B − (R² + G²) 就是这一级被抹掉的斜率方差（LEAN mapping 的思路，Olano & Baker 2010），补回高光瓣。

async function buildRippleTexture() {

	const size = 256;
	const componentCount = 56;
	const components = [];
	let varianceSum = 0;

	for ( let i = 0; i < componentCount; i ++ ) {

		// |n| 在 2~34 之间（一块贴图里 2~34 个波长），方向在 ±80° 内（贴图 u 轴会对齐风向）
		const radius = 2 + Math.pow( jsHash21( i, 3.1 ), 1.4 ) * 32;
		const angle = ( jsHash21( i, 7.7 ) - 0.5 ) * 2 * 1.4;
		const waveX = Math.round( radius * Math.cos( angle ) );
		const waveZ = Math.round( radius * Math.sin( angle ) );
		if ( waveX === 0 && waveZ === 0 ) continue;
		const length = Math.hypot( waveX, waveZ );
		// 斜率幅度随波数慢慢变小：短波更碎但不能压过长波
		const slopeAmplitude = Math.pow( length, - 0.3 ) * ( 0.6 + jsHash21( i, 9.2 ) * 0.8 );
		const phase = jsHash21( i, 11.3 ) * Math.PI * 2;
		// 预先算好这个分量在 256 个格点相位上的 sin/cos（整数波矢，相位下标就是 (nx·i + nz·j) mod 256）
		const sineTable = new Float32Array( size );
		const cosineTable = new Float32Array( size );
		for ( let k = 0; k < size; k ++ ) {

			sineTable[ k ] = Math.sin( Math.PI * 2 * k / size + phase );
			cosineTable[ k ] = Math.cos( Math.PI * 2 * k / size + phase );

		}

		components.push( { waveX, waveZ, length, slopeAmplitude, sineTable, cosineTable } );
		varianceSum += slopeAmplitude * slopeAmplitude / 2;

	}

	// 归一化：整张贴图的斜率方差 E[sx² + sz²] = 1，着色器里再乘目标幅度
	const normalize = 1 / Math.sqrt( varianceSum );
	const base = new Float32Array( size * size * 4 );
	const slice = { start: performance.now() };
	for ( let j = 0; j < size; j ++ ) {

		await yieldIfBusy( slice );
		for ( let i = 0; i < size; i ++ ) {

			let slopeU = 0;
			let slopeW = 0;
			let height = 0;
			for ( const component of components ) {

				const index = ( ( component.waveX * i + component.waveZ * j ) % size + size ) % size;
				// h = (a/k)·cos(...)，∂h/∂x = −a·(kx/k)·sin(...)
				const amplitude = component.slopeAmplitude * normalize;
				slopeU -= amplitude * component.waveX / component.length * component.sineTable[ index ];
				slopeW -= amplitude * component.waveZ / component.length * component.sineTable[ index ];
				height += amplitude / component.length * component.cosineTable[ index ];

			}

			const offset = ( j * size + i ) * 4;
			base[ offset ] = slopeU;
			base[ offset + 1 ] = slopeW;
			base[ offset + 2 ] = slopeU * slopeU + slopeW * slopeW;
			base[ offset + 3 ] = height;

		}

	}

	// mip 链：2×2 平均，一直到 1×1
	const levels = [ { data: base, width: size, height: size } ];
	let previous = levels[ 0 ];
	while ( previous.width > 1 ) {

		const width = previous.width / 2;
		const data = new Float32Array( width * width * 4 );
		for ( let j = 0; j < width; j ++ ) {

			for ( let i = 0; i < width; i ++ ) {

				for ( let channel = 0; channel < 4; channel ++ ) {

					const read = ( x, y ) => previous.data[ ( y * previous.width + x ) * 4 + channel ];
					data[ ( j * width + i ) * 4 + channel ] = ( read( i * 2, j * 2 ) + read( i * 2 + 1, j * 2 ) + read( i * 2, j * 2 + 1 ) + read( i * 2 + 1, j * 2 + 1 ) ) / 4;

				}

			}

		}

		previous = { data, width, height: width };
		levels.push( previous );

	}

	const mipmaps = levels.map( ( level ) => {

		const half = new Uint16Array( level.data.length );
		for ( let i = 0; i < level.data.length; i ++ ) half[ i ] = THREE.DataUtils.toHalfFloat( level.data[ i ] );
		return { data: half, width: level.width, height: level.height };

	} );

	const rippleTexture = new THREE.DataTexture( mipmaps[ 0 ].data, size, size, THREE.RGBAFormat, THREE.HalfFloatType );
	rippleTexture.mipmaps = mipmaps;
	rippleTexture.generateMipmaps = false;
	rippleTexture.wrapS = THREE.RepeatWrapping;
	rippleTexture.wrapT = THREE.RepeatWrapping;
	rippleTexture.magFilter = THREE.LinearFilter;
	rippleTexture.minFilter = THREE.LinearMipmapLinearFilter;
	rippleTexture.anisotropy = 4;
	rippleTexture.needsUpdate = true;
	return rippleTexture;

}

// 采样一层细节波纹：angle 是这层贴图 u 轴对着的方向，tileSize 是一块贴图的边长（米），speed 是沿 u 漂的速度
// 返回世界空间斜率 vec2(∂h/∂x, ∂h/∂z)、这层被 mip 抹掉的方差、归一化高度
function rippleLayer( rippleTextureNode, worldXZ, time, angle, tileSize, speed ) {

	const cosine = Math.cos( angle );
	const sine = Math.sin( angle );
	const alongU = worldXZ.x.mul( cosine ).add( worldXZ.y.mul( sine ) ).sub( time.mul( speed ) );
	const alongW = worldXZ.x.mul( - sine ).add( worldXZ.y.mul( cosine ) );
	const sample = rippleTextureNode.sample( vec2( alongU, alongW ).div( tileSize ) );
	const slopeWorld = vec2(
		sample.x.mul( cosine ).sub( sample.y.mul( sine ) ),
		sample.x.mul( sine ).add( sample.y.mul( cosine ) ),
	);
	const lost = max( sample.z.sub( sample.x.mul( sample.x ).add( sample.y.mul( sample.y ) ) ), 0 );
	return { slope: slopeWorld, lost, height: sample.w };

}

// ===================== 海面网格 =====================
// 以 oceanCenter 为圆心的环形网格：半径按指数增长 r(i) = a·(e^(g·i) − 1)，径向间距 ≈ 切向间距，
// 屏幕上近处远处的三角形差不多大。人只能在岸上走，网格不跟着人动，所以浪不会"游"。

function buildOceanGeometry( angularSegments ) {

	const growth = Math.PI * 2 / angularSegments;
	const innerSpacing = 0.25;
	const scale = innerSpacing / growth;
	const ringCount = Math.ceil( Math.log( oceanRadius / scale + 1 ) / growth );

	const positions = new Float32Array( ( 1 + ringCount * angularSegments ) * 3 );
	positions[ 0 ] = oceanCenter.x;
	positions[ 2 ] = oceanCenter.y;
	for ( let ring = 0; ring < ringCount; ring ++ ) {

		const radius = scale * ( Math.exp( growth * ( ring + 1 ) ) - 1 );
		for ( let segment = 0; segment < angularSegments; segment ++ ) {

			const angle = segment * growth;
			const index = 1 + ring * angularSegments + segment;
			positions[ index * 3 ] = oceanCenter.x + Math.cos( angle ) * radius;
			positions[ index * 3 + 2 ] = oceanCenter.y + Math.sin( angle ) * radius;

		}

	}

	const indices = [];
	for ( let segment = 0; segment < angularSegments; segment ++ ) {

		const next = ( segment + 1 ) % angularSegments;
		indices.push( 0, 1 + next, 1 + segment );

	}

	for ( let ring = 0; ring < ringCount - 1; ring ++ ) {

		const inner = 1 + ring * angularSegments;
		const outer = inner + angularSegments;
		for ( let segment = 0; segment < angularSegments; segment ++ ) {

			const next = ( segment + 1 ) % angularSegments;
			indices.push( inner + segment, inner + next, outer + segment );
			indices.push( inner + next, outer + next, outer + segment );

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setIndex( positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute( indices, 1 ) : new THREE.Uint16BufferAttribute( indices, 1 ) );
	geometry.boundingSphere = new THREE.Sphere( new THREE.Vector3( oceanCenter.x, 0, oceanCenter.y ), oceanRadius + 10 );
	return { geometry, growth, scale };

}

// ===================== 天空 =====================

// 地平线一圈的雾霭色：朝太阳那边偏暗橙金，背着太阳是灰紫蓝（地球自己的影子投在大气里的那条带）。天空贴地平线的部分用它
function horizonHazeColor( direction ) {

	const uniforms = state.uniforms;
	const towardSun = dot( normalize( vec2( direction.x, direction.z ) ), normalize( vec2( uniforms.sunDirection.x, uniforms.sunDirection.z ) ) ).mul( 0.5 ).add( 0.5 );
	return mix( uniforms.earthShadowColor, uniforms.skyHorizon.mul( 0.5 ), towardSun.pow2() ).mul( uniforms.twilightStrength ).mul( uniforms.skyDarken );

}

function createSky() {

	const sunsetConfig = state.ctx.config.sunset;
	const uniforms = state.uniforms;
	const sky = new SkyMesh();
	sky.name = '天空';
	sky.scale.setScalar( 1500 );
	sky.turbidity.value = sunsetConfig.skyTurbidity;
	sky.rayleigh.value = sunsetConfig.skyRayleigh;
	sky.mieCoefficient.value = sunsetConfig.skyMieCoefficient;
	sky.mieDirectionalG.value = sunsetConfig.skyMieDirectionalG;
	// SkyMesh 自带的云在太阳贴地时是灰的，关掉，下面自己画被夕阳从下面照亮的晚霞
	sky.cloudCoverage.value = 0;
	// 自带的太阳圆盘太小（约 0.5°）而且贴地时被大气消光压得很暗，关掉，自己画
	sky.showSunDisc.value = 0;

	const preethamColor = sky.material.colorNode;
	sky.material.colorNode = Fn( () => {

		const direction = normalize( positionWorld.sub( cameraPosition ) );
		const raw = preethamColor.rgb.mul( uniforms.skyExposure );

		// 往配色表拉：按仰角取 地平线橙金 → 中空粉 → 高空紫，只换色相不换亮度（亮度还是 Preetham 算的）。
		// 太阳附近保留原色，那里本来就该是白金色的光晕
		const elevation = clamp( direction.y, 0, 1 );
		const palette = mix( mix( uniforms.skyHorizon, uniforms.skyMid, smoothstep( 0.0, 0.22, elevation ) ), uniforms.skyHigh, smoothstep( 0.18, 0.7, elevation ) );
		const tinted = palette.mul( luminance( raw ).div( max( luminance( palette ), 1e-4 ) ) );
		const nearSun = smoothstep( 0.93, 0.997, dot( direction, uniforms.sunDirection ) );
		const graded = mix( raw, tinted, uniforms.skyPaletteAmount.mul( nearSun.mul( - 0.7 ).add( 1 ) ) ).toVar();
		// 地平线一圈暖光：Preetham 在背着太阳的地平线上偏暗偏脏，补一条贴着海平线的橙金色光带，朝太阳那边更亮
		const towardSun = max( dot( normalize( vec2( direction.x, direction.z ) ), normalize( vec2( uniforms.sunDirection.x, uniforms.sunDirection.z ) ) ), 0 );
		const glowBand = exp( elevation.div( - 0.07 ) ).mul( towardSun.mul( towardSun ).mul( 0.65 ).add( 0.35 ) );
		graded.addAssign( uniforms.skyHorizon.mul( glowBand ).mul( uniforms.horizonGlow ).mul( uniforms.skyPaletteAmount.div( max( uniforms.skyPaletteBase, 1e-3 ) ) ) );

		// 暮光：Preetham 在背着太阳的半边几乎是黑的，真实的日落那半边天并不黑——
		// 贴地平线是一条灰紫蓝的"地球影子"，上面压着一条粉色的"维纳斯带"（被低太阳照到的高层大气，约 5~15° 高），再往上渐渐变成蓝紫。
		// 背着太阳最明显，朝太阳那边被 Preetham 本身的亮光盖住
		const awayFromSun = float( 1 ).sub( dot( normalize( vec2( direction.x, direction.z ) ), normalize( vec2( uniforms.sunDirection.x, uniforms.sunDirection.z ) ) ).mul( 0.5 ).add( 0.5 ) );
		const earthShadowBand = float( 1 ).sub( smoothstep( 0.0, 0.08, elevation ) );
		const beltOfVenus = exp( elevation.sub( 0.13 ).div( 0.075 ).pow2().negate() ).mul( awayFromSun.mul( 0.75 ).add( 0.25 ) );
		const zenithFloor = smoothstep( 0.04, 0.7, elevation ).mul( awayFromSun.mul( 0.75 ).add( 0.25 ) );
		const twilight = horizonHazeColor( direction ).mul( earthShadowBand )
			.add( uniforms.beltColor.mul( beltOfVenus ).mul( earthShadowBand.mul( - 0.7 ).add( 1 ) ).mul( uniforms.twilightStrength ).mul( uniforms.skyDarken ) )
			.add( uniforms.zenithColor.mul( zenithFloor ).mul( uniforms.twilightStrength ).mul( uniforms.skyDarken ) );
		graded.addAssign( twilight.mul( nearSun.oneMinus() ).mul( uniforms.twilightToggle ) );

		// 晚霞：一层很高的薄云，投影到 2 公里高的平面上取噪声（越靠地平线越扁、越密）；
		// 云底被贴地的太阳从下面照亮：朝太阳那边金色，背着太阳是粉色，云厚的地方暗一点偏紫
		const cloudPlane = direction.xz.div( max( direction.y, 0.015 ) ).mul( 2000 );
		const cloudDrift = vec2( uniforms.sceneTime.mul( 3 ), uniforms.sceneTime.mul( 1.2 ) );
		const cloudPoint = cloudPlane.add( cloudDrift ).mul( vec2( 0.0006, 0.00085 ) );
		const cloudWarp = fbm2D( cloudPoint.mul( 0.7 ).add( 5.1 ), 3 ).sub( 0.5 ).mul( 1.6 );
		const cloudNoise = fbm2D( cloudPoint.add( cloudWarp ), 4 );
		const cloudCover = smoothstep( uniforms.cloudThreshold, uniforms.cloudThreshold.add( 0.16 ), cloudNoise );
		const cloudThickness = smoothstep( uniforms.cloudThreshold.add( 0.05 ), uniforms.cloudThreshold.add( 0.32 ), cloudNoise );
		const sunSide = pow( max( dot( direction, uniforms.sunDirection ), 0 ), 4 );
		const litColor = mix( uniforms.cloudAwayColor, uniforms.sunLightColor.mul( 2.2 ), sunSide );
		const cloudColor = mix( litColor, uniforms.cloudShadowColor, cloudThickness.mul( 0.7 ) ).mul( uniforms.cloudBrightness ).mul( uniforms.skyDarken );
		// 贴近地平线淡掉（远处的云被大气吃掉），头顶也淡一点
		const cloudFade = smoothstep( 0.03, 0.14, direction.y ).mul( float( 1 ).sub( smoothstep( 0.5, 0.9, direction.y ).mul( 0.6 ) ) );
		graded.assign( mix( graded, cloudColor, cloudCover.mul( cloudFade ).mul( uniforms.cloudAmount ).mul( 0.85 ) ) );

		// 太阳圆盘：放大到 1~2°，临边昏暗（边缘暗到 55%），贴着海平线的下缘再偏红一点；
		// 只画在海平线以上；倒影那一趟（虚拟相机在水面下）和生成环境光贴图时不画，海面的太阳反射由光路公式负责
		const chord = length( direction.sub( uniforms.sunDirection ) );
		const pixelAngle = max( length( fwidth( direction ) ), 1e-5 );
		const radius = uniforms.sunAngularRadius;
		const disc = float( 1 ).sub( smoothstep( radius.sub( pixelAngle ), radius.add( pixelAngle ), chord ) );
		const limb = mix( 0.55, 1, sqrt( clamp( float( 1 ).sub( chord.div( radius ).pow( 2 ) ), 0, 1 ) ) );
		const lowerRed = mix( vec3( 1.0, 0.55, 0.32 ), vec3( 1 ), smoothstep( 0.0, 0.035, direction.y ) );
		const aboveSea = smoothstep( - 0.0003, 0.0003, direction.y );
		const notMirrored = cameraPosition.y.greaterThan( 0 ).select( float( 1 ), float( 0 ) );
		const discMask = disc.mul( aboveSea ).mul( notMirrored ).mul( uniforms.sunDiscVisible ).mul( uniforms.sunDiscToggle );
		const sunDisc = uniforms.sunRadiance.mul( lowerRed ).mul( limb ).mul( discMask );
		// 圆盘外一圈很紧的光晕（Preetham 的米氏光晕比较宽，这一圈让圆盘边缘不那么硬）
		const halo = uniforms.sunRadiance.mul( exp( max( chord.sub( radius ), 0 ).mul( - 60 ) ) ).mul( 0.03 ).mul( notMirrored ).mul( uniforms.sunDiscToggle );

		// 抖动：±0.5% 的静态噪声，打散 8 位输出时天空渐变的色带
		const dither = hash21( floor( screenCoordinate.xy ) ).sub( 0.5 ).mul( 0.01 );

		return vec4( graded.mul( uniforms.skyDarken ).mul( dither.add( 1 ) ).add( sunDisc ).add( halo ), 1 );

	} )();
	// 交接：天空是一层叠加在统一天空（远景天空球）上面的透明层，不透明度 = 1 − worldSkyBlend；停留时是 1，和阶段 2 逐像素一样
	sky.material.transparent = true;
	sky.material.opacityNode = uniforms.skyOpacity;

	state.disposables.push( sky.geometry, sky.material );
	return sky;

}

// 阴影替身（4b 修卡顿）：three 画阴影时会把材质的整个 colorNode 拖进阴影着色器（只为了取一个 alpha），
// 重材质第一次画阴影要同步编译 0.2~0.5 秒。投影的网格各挂一个子网格当替身：同一个几何体、材质什么颜色都不算，
// 只放在 1 号层（灯的阴影相机只看 1 号层，主相机看不见），原网格不再投影。阴影只由几何体决定，画面不变
function addShadowProxies( scene, light ) {

	const materials = new Map();
	const proxyMaterialFor = ( source ) => {

		const cacheKey = source.side + ':' + source.shadowSide;
		if ( ! materials.has( cacheKey ) ) {

			const material = new THREE.MeshBasicNodeMaterial();
			material.name = '阴影替身';
			material.side = source.side;
			material.shadowSide = source.shadowSide;
			state.disposables.push( material );
			materials.set( cacheKey, material );

		}

		return materials.get( cacheKey );

	};

	const casters = [];
	scene.traverse( ( object ) => {

		if ( object.isMesh && object.castShadow ) casters.push( object );

	} );
	for ( const mesh of casters ) {

		const proxy = new THREE.Mesh( mesh.geometry, proxyMaterialFor( mesh.material ) );
		proxy.name = mesh.name + '·阴影替身';
		proxy.layers.set( 1 );
		proxy.castShadow = true;
		proxy.frustumCulled = mesh.frustumCulled;
		mesh.add( proxy );
		mesh.castShadow = false;

	}

	light.shadow.camera.layers.set( 1 );

}

// 阴影图按需重画（性能，2026-10-02，perf.scenesB.shadowOnDemand）：原来每帧重画一张 2048 的阴影图，倒影的虚拟相机还要再画一遍
// （ShadowNode 按"相机 + 帧号"去重）。现在 autoUpdate 关掉：阴影中心按 shadowSnap 米吸附，再在光的横、竖方向上对齐到阴影图的纹素
// （中心挪一格时纹素格子不滑，影子边不闪）；中心换了格，或者太阳动了且离上次重画满 sunsetShadowFrames 帧，才 needsUpdate 一次。
// 一帧里先画倒影（预画），倒影那一遍画了阴影图（ShadowNode 画完把 needsUpdate 清掉），主场景那一遍就不再画。
// 太阳贴着海平线，影子拉得很长，方向一变影子尖就挪，所以不能像雪原那样等转够角度。
// 灯每帧按"中心 + 方向 × 距离"摆，照明方向每帧都是准的；阴影图的投影矩阵只在重画时更新（ShadowNode.renderShadow）
const shadowFocus = new THREE.Vector3();
const shadowCandidate = new THREE.Vector3();
const shadowBasis = new THREE.Matrix4();
const shadowRight = new THREE.Vector3();
const shadowUp = new THREE.Vector3();
const shadowBack = new THREE.Vector3();
const shadowOrigin = new THREE.Vector3();

function followShadow( light, focus, direction, distance ) {

	const perf = state.ctx.config.perf.scenesB;
	const shadow = light.shadow;
	if ( ! perf.shadowOnDemand ) {

		// 原来的做法：阴影相机每帧正对着人，每一遍都重画
		shadow.autoUpdate = true;
		light.target.position.copy( focus );
		light.position.copy( focus ).addScaledVector( direction, distance );
		light.target.updateMatrixWorld();
		return;

	}

	const shadowSnap = perf.shadowSnap;
	shadow.autoUpdate = false;
	const shadowCamera = shadow.camera;
	shadowCandidate.set( Math.round( focus.x / shadowSnap ) * shadowSnap, Math.round( focus.y / shadowSnap ) * shadowSnap, Math.round( focus.z / shadowSnap ) * shadowSnap );
	// 阴影相机的横、竖、后三个轴：和 three 给平行光阴影相机 lookAt 的结果一样（相机在中心 + 方向 × 距离，朝中心看，up 是阴影相机的 up）
	shadowBasis.lookAt( direction, shadowOrigin, shadowCamera.up ).extractBasis( shadowRight, shadowUp, shadowBack );
	const texelX = ( shadowCamera.right - shadowCamera.left ) / Math.max( 1, shadow.mapSize.width );
	const texelY = ( shadowCamera.top - shadowCamera.bottom ) / Math.max( 1, shadow.mapSize.height );
	const alongRight = Math.round( shadowCandidate.dot( shadowRight ) / texelX ) * texelX;
	const alongUp = Math.round( shadowCandidate.dot( shadowUp ) / texelY ) * texelY;
	const alongBack = shadowCandidate.dot( shadowBack );
	shadowCandidate.copy( shadowRight ).multiplyScalar( alongRight ).addScaledVector( shadowUp, alongUp ).addScaledVector( shadowBack, alongBack );

	state.shadowFrames ++;
	const moved = ! ( shadowCandidate.distanceToSquared( state.shadowCenter ) < 1e-6 );
	const turned = ! direction.equals( state.shadowLightDirection ) && state.shadowFrames >= perf.sunsetShadowFrames;
	if ( moved || turned ) {

		state.shadowCenter.copy( shadowCandidate );
		state.shadowLightDirection.copy( direction );
		state.shadowFrames = 0;
		shadow.needsUpdate = true;

	}

	light.target.position.copy( state.shadowCenter );
	light.position.copy( state.shadowCenter ).addScaledVector( direction, distance );
	light.target.updateMatrixWorld();

}

// 重新生成环境光贴图（只有天空，不含太阳圆盘），礁石的环境光、低档海面的反射都用它。
// 生成器是整个程序共用的 ctx.pmrem（开场卡阶段热过身，模糊和背景盒的着色器已经编好）
function updateEnvironment() {

	const uniforms = state.uniforms;
	uniforms.sunDiscVisible.value = 0;
	// 环境光贴图里只有这片天，不能是半透明的（交接时天空正在淡出）
	const opacity = uniforms.skyOpacity.value;
	uniforms.skyOpacity.value = 1;
	state.environmentScene.add( state.sky );
	try {

		state.environmentTarget = state.ctx.pmrem.fromScene( state.environmentScene, 0, 0.1, 3000, {
			size: 128,
			position: state.environmentCameraPosition,
			renderTarget: state.environmentTarget,
		} );
		state.scene.environment = state.environmentTarget.texture;

	} finally {

		// 出错也要把天空放回主场景、太阳圆盘打开，不然整场没有天
		state.scene.add( state.sky );
		uniforms.sunDiscVisible.value = 1;
		uniforms.skyOpacity.value = opacity;

	}

}

// ===================== 海面材质 =====================

function createOceanMaterial( tierName, useReflector ) {

	const sunsetConfig = state.ctx.config.sunset;
	const perf = state.ctx.config.perf.scenesB;
	const uniforms = state.uniforms;
	const { growth, scale } = state.oceanGrid;
	const sparkleLevels = tierName === 'lo' ? 1 : 2;

	// 平面反射：反射平面是 mirror.target（本地 +z 为法线），转成朝上放在平均海面；要先建好才能加进场景
	let mirror = null;
	if ( useReflector ) {

		mirror = reflector( { resolutionScale: state.ctx.quality.params.reflectionScale, bounces: false } );
		// 不在画海面时嵌套着画倒影（那样在预编译 compileAsync 里也会同步渲染整场，卡 0.6~2 秒），
		// 改成后期管线每帧画主场景之前在最外层画一次（state.reflectionPass），和主场景是同一个渲染上下文，预编译对得上
		mirror.reflector.updateBeforeType = NodeUpdateType.NONE;
		mirror.target.rotation.x = - Math.PI / 2;
		state.reflectorNode = mirror;
		state.reflectorTarget = mirror.target;

	}

	const material = new THREE.NodeMaterial();
	material.name = useReflector ? '海面（平面反射）' : '海面（环境反射）';
	material.fog = false;   // 远处海面靠菲涅尔反射天空自然溶进地平线，不再叠雾

	// ---------- 顶点：Gerstner 位移 ----------
	const baseXZ = varying( positionGeometry.xz, 'oceanBaseXZ' );
	material.positionNode = Fn( () => {

		const base = positionGeometry;
		const centerDistance = length( base.xz.sub( vec2( oceanCenter.x, oceanCenter.y ) ) );
		// 这一圈顶点的间距（米），按它淡出画不下的短波，免得远处的网格走样
		const spacing = centerDistance.add( scale ).mul( growth );
		const waves = gerstnerNodes( base.xz, uniforms.sceneTime, uniforms.waveAmount, spacing );
		// 最外一圈慢慢抬到相机高度：有限大的海面在地平线下会留一条缝，抬起来正好补到地平线。
		// 只在人站着的高度上这么做：起飞升到 24~40 米以上就不抬了（抬到几十米高会在远处立起一圈水墙）
		const lift = cameraPosition.y.mul( smoothstep( oceanRadius * 0.6, oceanRadius * 0.98, centerDistance ) ).mul( 0.98 )
			.mul( float( 1 ).sub( smoothstep( 24, 40, cameraPosition.y ) ) );
		// 世界的陆地上不铺海：远景地形高出海面 1.2 米以上的地方，海面顶点沉到陆地底下（岸边浪打上来的那一窄条还留着）
		const landHeight = attribute( 'landHeight', 'float' );
		const landSink = smoothstep( 1.2, 2.2, landHeight ).mul( landHeight.add( 4 ) );
		return base.add( waves.offset ).add( vec3( 0, lift.sub( landSink ), 0 ) );

	} )();

	// ---------- 片元 ----------
	material.colorNode = Fn( () => {

		const worldPosition = positionWorld;
		const toCamera = cameraPosition.sub( worldPosition );
		const viewDirection = normalize( toCamera );
		const distance = length( toCamera );
		const sunDirection = uniforms.sunDirection;

		// 像素足迹：这个像素覆盖多大一块海面（取长边），用来逐个滤掉短波
		const footprint = max( length( fwidth( worldPosition ) ), 1e-4 );

		// ① 大浪：8 个 Gerstner 波的法线，按足迹滤波；被滤掉的方差记下来
		const waves = gerstnerNodes( baseXZ, uniforms.sceneTime, uniforms.waveAmount, footprint );
		const waveNormal = normalize( cross( waves.tangentZ, waves.tangentX ) );
		const waveSlope = waveNormal.xz.div( waveNormal.y ).negate();

		// ② 细节波纹：两层贴图，一层顺风大块、一层斜 35° 小块，朝不同方向漂；在斜率空间里直接相加
		const windAngle = THREE.MathUtils.degToRad( sunsetConfig.windDirection );
		const rippleNode = texture( state.rippleTexture );
		const layerA = rippleLayer( rippleNode, baseXZ, uniforms.sceneTime, windAngle, 7.0, 0.55 );
		const layerB = rippleLayer( rippleNode, baseXZ, uniforms.sceneTime, windAngle + 0.62, 2.6, 0.32 );
		const detailA = uniforms.rippleAmplitudeA.mul( uniforms.rippleAmount );
		const detailB = uniforms.rippleAmplitudeB.mul( uniforms.rippleAmount );
		const detailSlope = layerA.slope.mul( detailA ).add( layerB.slope.mul( detailB ) );
		const detailLost = layerA.lost.mul( detailA.mul( detailA ) ).add( layerB.lost.mul( detailB.mul( detailB ) ) );

		const totalSlope = waveSlope.add( detailSlope );
		const normal = normalize( vec3( totalSlope.x.negate(), 1, totalSlope.y.negate() ) ).toVar();
		const normalDotView = max( dot( normal, viewDirection ), 1e-3 );

		// ③ 金色光路：Cox–Munk 斜率分布（Cox & Munk 1954）。σ² = 0.003 + 0.00512·风速 是整片海面的斜率均方值，
		// 画出来的浪和波纹已经占了一部分，剩下的（加上被滤掉的）才放进高光瓣：近处光斑细碎，远处自然连成一条光带
		const variance = max( uniforms.unresolvedVariance, 0.002 ).add( waves.lostVariance ).add( detailLost )
			.add( uniforms.waveAmount.oneMinus().mul( uniforms.resolvedVariance ) ).add( uniforms.rippleAmount.oneMinus().mul( uniforms.rippleVariance ) );
		const halfVector = normalize( sunDirection.add( viewDirection ) );
		const cosHalf = max( dot( normal, halfVector ), 1e-3 );
		const cosHalf2 = cosHalf.mul( cosHalf );
		const tanHalf2 = float( 1 ).sub( cosHalf2 ).div( cosHalf2 );
		// 斜率概率密度 p = exp(−tan²β/σ²) / (π σ² cos⁴β)（各向同性高斯，就是 Beckmann 分布，m² = σ²）
		const slopeDensity = exp( tanHalf2.negate().div( variance ) ).div( variance.mul( Math.PI ).mul( cosHalf2 ).mul( cosHalf2 ) );
		// Smith 遮挡（Walter 2007 对 Beckmann 的有理近似）：掠射角下浪背面互相挡，地平线附近不会亮爆
		const roughness = sqrt( variance );
		const smith = ( cosine ) => {

			const clamped = clamp( cosine, 1e-3, 0.9999 );
			// cotθ / m：越接近掠射角越小，遮挡越多
			const ratio = clamped.div( roughness.mul( sqrt( float( 1 ).sub( clamped.mul( clamped ) ) ) ) );
			const rational = ratio.mul( 3.535 ).add( ratio.mul( ratio ).mul( 2.181 ) ).div( ratio.mul( 2.276 ).add( ratio.mul( ratio ).mul( 2.577 ) ).add( 1 ) );
			return ratio.lessThan( 1.6 ).select( rational, float( 1 ) );

		};

		const normalDotLight = dot( normal, sunDirection );
		const shadowing = smith( normalDotView ).mul( smith( normalDotLight ) );
		const fresnelHalf = float( 0.02 ).add( float( 0.98 ).mul( pow( max( float( 1 ).sub( max( dot( viewDirection, halfVector ), 0 ) ), 0 ), 5 ) ) );
		// 太阳当成有角半径的圆盘：辐照度 = 圆盘亮度 × 立体角 π r²。L = E·F·p·G / (4·cosθv)
		const sunIrradiance = uniforms.sunRadiance.mul( uniforms.sunSolidAngle );
		const glint = sunIrradiance.mul( fresnelHalf.mul( slopeDensity ).mul( shadowing ).div( normalDotView.mul( 4 ) ) )
			.mul( uniforms.pathIntensity ).mul( uniforms.pathToggle ).mul( smoothstep( - 0.02, 0.02, normalDotLight ) )
			// 近处的碎光由闪点负责，高光瓣只给一点底；越远闪点越稀、越小，平均亮度交还给高光瓣，远处连成一条金色光柱。
			// 审查 R17：原来 20~220 米从三成升到满，中距离（40~150 米）一大段暗紫，光路断成两截；底抬到五成五、80 米就满
			.mul( mix( 0.55, 1, smoothstep( 8, 80, distance ) ) );

		// ④ 闪点：sparkle.js，微法线锥约等于近处剩下的斜率标准差；随时间生灭（水面的小晶面一直在换）
		// 锥角 ≈ 2 倍"画不出来的"斜率标准差（近处小、远处大），闪点只在光路附近出现
		const sparkleCone = clamp( sqrt( variance ).mul( 2 * 180 / Math.PI ), 5, 26 );
		// 只在光路附近算单颗闪点（性能，perf.scenesB.glitterPathOnly）：微法线最多偏离海面法线一个锥角，海面法线和半程向量的夹角
		// 比"锥角 + glitterMargin"还大时，微法线和半程向量至少差 glitterMargin（12°），cos12° 的 700 次方以上小于 2e-7，闪点看不出来；那里只留统计补偿
		const nearGlitterPath = perf.glitterPathOnly ? cosHalf.greaterThan( cos( sparkleCone.add( perf.glitterMargin ).mul( Math.PI / 180 ) ) ) : null;
		const sparkleCommon = {
			position: worldPosition, normal, viewDirection, lightDirection: sunDirection, coneDegrees: sparkleCone, active: nearGlitterPath, lean: perf.sparkleSkip,
			// sparkle.js 按"小晶面被照亮"算（乘了 m·L 和 N·L 的朝向项，雪地是对的）；海面的闪点是一小片水面像镜子一样把太阳反射过来，
			// 亮度应该是 F·L_太阳，不该因为太阳贴地就变暗，所以这里把那两项（约 sinθ_太阳 × 0.5）除回去
			lightColor: uniforms.sunRadiance.mul( uniforms.sunVisibleFraction ).mul( fresnelHalf ).div( max( sunDirection.y, 0.03 ).mul( 0.5 ) ),
			time: uniforms.sceneTime, twinkleRate: sunsetConfig.sparkleTwinkleRate,
			levels: sparkleLevels, fadeStart: 300, fadeEnd: 1500, radiusPixels: 1.0, cellPixels: 4, footprintMode: 'mean',
		};
		const sparkleFine = sparkleLayer( { ...sparkleCommon, cellSize: 0.05, existProbability: 0.6, sharpness: 900, intensity: 1, seed: 7 } );
		const sparkleCoarse = sparkleLayer( { ...sparkleCommon, cellSize: 0.22, existProbability: 0.4, sharpness: 700, intensity: 1.6, seed: 19 } );
		let sparkleSum = sparkleFine.add( sparkleCoarse.mul( uniforms.secondSparkleLayer ) );
		if ( tierName === 'hi' ) {

			// 高档第三层：又少又大又亮的"钻石"闪点，靠近光路中心才有
			const sparkleDiamond = sparkleLayer( { ...sparkleCommon, cellSize: 0.7, existProbability: 0.2, sharpness: 1400, intensity: 3, seed: 31 } );
			sparkleSum = sparkleSum.add( sparkleDiamond.mul( uniforms.thirdSparkleLayer ) );

		}

		const sparkles = sparkleSum.mul( uniforms.sparkleIntensity ).mul( uniforms.sparkleToggle );

		// ⑤ 反射：高中档平面反射（按法线扰动 UV，像 WaterMesh 那样），低档用环境光贴图按粗糙度取
		let reflection;
		if ( mirror ) {

			const distortion = normal.xz.mul( float( 0.6 ).div( distance.add( 4 ) ).add( 0.002 ) ).mul( 3 );
			reflection = mirror.sample( mirror.uvNode.add( distortion ) ).rgb;

		} else {

			const reflected = reflect( viewDirection.negate(), normal );
			const mirrored = vec3( reflected.x, abs( reflected.y ), reflected.z );
			reflection = pmremTexture( state.environmentTarget.texture, mirrored, clamp( roughness.mul( 1.5 ), 0.02, 1 ) );

		}

		const fresnel = float( 0.02 ).add( float( 0.98 ).mul( pow( max( float( 1 ).sub( normalDotView ), 0 ), 5 ) ) );

		// ⑥ 水体：暗部海水色 × 天空环境光；礁石边水浅，透出一点青色
		const terrain = texture( state.heightTexture, terrainUV( worldPosition.xz ) );
		const depthToGround = worldPosition.y.sub( terrain.r );
		const rockProximity = terrain.g;
		// 礁石边只透一点青（原来六成，海蚀柱脚一圈青绿的亮环，审查 R34），岩脚主要靠下面的白泡沫
		const shallow = max( exp( depthToGround.max( 0 ).div( - 2.2 ) ), rockProximity.mul( 0.22 ) ).mul( uniforms.shallowToggle );
		const ambient = pmremTexture( state.environmentTarget.texture, vec3( 0, 1, 0 ), float( 1 ) );
		const bodyColor = mix( uniforms.waterColor, uniforms.shallowColor, shallow ).mul( ambient.mul( 1.7 ).add( uniforms.sunLightColor.mul( 0.06 ) ) );

		// ⑦ 浪尖透绿：逆光时浪峰薄的地方透出绿色。sss = pow(sat(V·−L), 4) · sat(浪高归一化) · (1 − N·V) · 透光色
		const heightNormalized = waves.offset.y.div( uniforms.totalAmplitude.mul( uniforms.waveAmount ).max( 1e-3 ) ).clamp( 0, 1 );
		const backLight = pow( max( dot( viewDirection, sunDirection.negate() ), 0 ), 4 );
		const sss = uniforms.sssColor.mul( backLight.mul( heightNormalized ).mul( float( 1 ).sub( normalDotView ) ) )
			.mul( uniforms.sssStrength ).mul( uniforms.sunLightColor ).mul( uniforms.sssToggle );

		const water = mix( bodyColor.add( sss ), reflection.mul( uniforms.reflectionToggle ), fresnel ).add( glint ).add( sparkles );

		// ⑧ 泡沫：浪峰被挤压的地方（Gerstner 位移的雅可比行列式小于 0.85 开始，越挤越多，Tessendorf 的判据）
		// + 礁石边和岸边水浅的地方
		const jacobian = waves.tangentX.x.mul( waves.tangentZ.z ).sub( waves.tangentX.z.mul( waves.tangentZ.x ) );
		const crestFoam = float( 1 ).sub( smoothstep( 0.6, 0.85, jacobian ) ).mul( smoothstep( 0.2, 0.7, heightNormalized ) );
		const surge = sin( waves.swellPhase ).mul( 0.25 ).add( 0.75 );
		// 岸边：水深 1.2 米以内；礁石：离得越近越多。都随主涌浪一涌一涌
		const shoreFoam = max( float( 1 ).sub( smoothstep( 0.0, 1.2, depthToGround ) ), pow( rockProximity, 0.7 ) ).mul( surge ).mul( 0.62 );
		const foamCoverage = max( crestFoam.mul( 0.8 ), shoreFoam ).clamp( 0, 1 );
		// 形状：先扭曲坐标，fbm 出一团团的块，块里再用细 Voronoi 的细胞边（F2 − F1 小）挖出一圈圈花边，
		// 浓淡再用细 fbm 调，半透明。这样是一条条、一团团带孔的泡沫，不是一整片平涂
		// 覆盖度 ≤ 0.02 时下面最后乘的 smoothstep( 0.02, 0.15, 覆盖度 ) 正好是 0（「泡沫」开关关了也是乘 0）：
		// 那里泡沫图案（五个 fbm + Voronoi）整段不算，结果一样（性能，perf.scenesB.foamSkip）
		const foamMask = float( 0 ).toVar();
		const foamPattern = () => {

			const foamPoint = worldPosition.xz.add( vec2( uniforms.sceneTime.mul( 0.06 ), uniforms.sceneTime.mul( - 0.03 ) ) );
			const foamWarp = vec2( fbm2D( foamPoint.mul( 0.35 ), 2 ), fbm2D( foamPoint.mul( 0.35 ).add( 17.3 ), 2 ) ).sub( 0.5 ).mul( 2.2 );
			const clumps = fbm2D( foamPoint.mul( 1.4 ).add( foamWarp ), 3 );
			const laceCells = voronoi2D( foamPoint.mul( 3.2 ).add( foamWarp.mul( 1.5 ) ), float( 1 ), float( 1 ) );
			const lace = pow( smoothstep( 0.02, 0.35, laceCells.y.sub( laceCells.x ) ).oneMinus(), 1.5 );
			const fineShade = fbm2D( foamPoint.mul( 7 ), 2 );
			const threshold = mix( 0.7, 0.4, foamCoverage );
			const foamBody = smoothstep( threshold, threshold.add( 0.22 ), clumps );
			// 团块边缘之外只剩花边，团块中间是花边加一层薄薄的底
			foamMask.assign( foamBody.mul( lace.mul( 0.75 ).add( foamBody.mul( 0.25 ) ) ).mul( fineShade.mul( 0.5 ).add( 0.5 ) )
				.mul( smoothstep( 0.02, 0.15, foamCoverage ) ).mul( uniforms.foamToggle ) );

		};
		if ( perf.foamSkip ) If( foamCoverage.greaterThan( 0.02 ).and( uniforms.foamToggle.greaterThan( 0 ) ), foamPattern );
		else foamPattern();
		// 黄昏里的泡沫：天空环境光 + 一点夕阳，逆光时边缘透亮一点；不能比天空还白
		const foamLit = uniforms.foamColor.mul( ambient.mul( 1.2 ).add( uniforms.sunLightColor.mul( max( normalDotLight, 0 ).mul( 0.5 ).add( backLight.mul( 0.6 ) ) ).mul( uniforms.sunVisibleFraction ) ) );

		// 交接时化进同色薄雾（海面不吃场景雾，自己混）
		return vec4( applyVeil( mix( water, foamLit, foamMask.mul( 0.7 ) ), state.veil ), 1 );

	} )();

	state.disposables.push( material );
	return material;

}

// ===================== 礁石材质 =====================

// 屏幕导数 bump（Mikkelsen 2010《Bump Mapping Unparametrized Surfaces on the GPU》），视图空间
function bumpNormal( surfacePosition, surfaceNormal, height ) {

	const sigmaX = dFdx( surfacePosition );
	const sigmaY = dFdy( surfacePosition );
	const crossY = cross( sigmaY, surfaceNormal );
	const crossX = cross( surfaceNormal, sigmaX );
	const determinant = dot( sigmaX, crossY ).mul( faceDirection );
	const gradient = determinant.sign().mul( crossY.mul( dFdx( height ) ).add( crossX.mul( dFdy( height ) ) ) );
	return normalize( abs( determinant ).mul( surfaceNormal ).sub( gradient ) );

}

// withSand：地形用，平缓的低处是沙滩（干沙偏暖亮，水边湿沙暗而反光），陡坡、凸起和出生点那块岬角是岩石；
// 礁石和海蚀柱的网格不带沙
function createRockMaterial( withSand ) {

	const uniforms = state.uniforms;
	const material = new THREE.MeshPhysicalNodeMaterial();
	material.name = withSand ? '礁石岸' : '礁石';
	material.metalness = 0;

	// 全用世界空间 3D 噪声，不需要 UV 也不需要 triplanar
	const worldPosition = positionWorld;
	const large = fbm3D( worldPosition.mul( 0.3 ), 3 );
	const detail = fbm3D( worldPosition.mul( 2.6 ), 3 );
	// 石缝：脊状噪声 1 − |2n − 1| 的尖顶（不用 Voronoi，Voronoi 会切成一格格的地砖）。坐标先扭一下，缝是弯的。
	// 缝窄一点、淡一点（原来一道道黑缝满石头都是，近看像皮革，2026-10-02 自查）；岸上的岩石形状换成扫描以后，起伏主要靠形状
	const warped = worldPosition.mul( 0.9 ).add( fbm3D( worldPosition.mul( 0.4 ).add( 3.7 ), 2 ).mul( 1.5 ) );
	const ridge = float( 1 ).sub( abs( fbm3D( warped, 3 ).mul( 2 ).sub( 1 ) ) );
	// 岸上的岩石（岬角）明暗主要交给下面的岩面扫描贴图，缝只留很淡的几道（审查 R18：黑缝连成网，像皮革、像大脑）
	const crevice = smoothstep( 0.965, 0.995, ridge ).mul( withSand ? 0.25 : 0.6 );
	// 层理：沿高度的细条纹，被大尺度噪声扭一下；只在陡的岩壁上出现（平地上沿高度画条纹会变成一圈圈等高线）
	const steep = float( 1 ).sub( smoothstep( 0.55, 0.85, normalWorld.y.abs() ) );
	const strata = sin( worldPosition.y.mul( 7 ).add( large.mul( 9 ) ) ).mul( 0.5 ).add( 0.5 ).mul( steep );

	// 偏冷的灰褐（原来 #54473c 在晚霞里被染成红褐色的皮）
	let rockColor = mix( color( '#2a2624' ), color( '#4f4843' ), smoothstep( 0.3, 0.7, large ) );
	rockColor = rockColor.mul( strata.mul( 0.25 ).add( 0.85 ) ).mul( detail.mul( 0.4 ).add( 0.8 ) ).mul( crevice.mul( - 0.6 ).add( 1 ) );
	// 高处朝上的面长一点橙黄色地衣
	const lichen = smoothstep( 0.62, 0.7, fbm3D( worldPosition.mul( 0.9 ).add( 7.3 ), 3 ) )
		.mul( smoothstep( 0.55, 0.9, normalWorld.y ) ).mul( smoothstep( 1.8, 2.6, worldPosition.y ) );
	rockColor = mix( rockColor, color( '#7a6648' ), lichen.mul( 0.35 ) );

	// 细颗粒（约 10 厘米）让湿岩面的高光碎开，不像一层塑料
	const grain = fbm3D( worldPosition.mul( 9 ), 2 );
	// 湿：浪溅得到的高度以下（约 1.3 米，带噪声）更暗、更光滑，能映出一点晚霞
	const wetLine = large.sub( 0.5 ).mul( 0.8 ).add( 1.3 );
	const wet = float( 1 ).sub( smoothstep( 0.25, wetLine, worldPosition.y ) ).mul( uniforms.wetToggle );
	// 中尺度的坑洼（0.5~2 米）让大块岩面不像一整块光滑的泥
	const medium = fbm3D( worldPosition.mul( 0.8 ).add( 1.9 ), 3 );

	// 海里的礁石和海蚀柱比岸上的岩石更黑（常年被浪打湿、长着深色的藻），逆光时是剪影
	if ( ! withSand ) rockColor = rockColor.mul( 0.6 );
	let surfaceColor = mix( rockColor, rockColor.mul( 0.5 ), wet );
	let roughness = mix( mix( float( 0.92 ), float( 0.75 ), detail ), mix( float( 0.5 ), float( 0.3 ), grain ), wet );
	// 中尺度坑洼原来 0.14 米，一团团鼓包像大脑；起伏交给扫描贴图的法线，这里减半
	let bumpHeight = detail.mul( 0.05 ).add( medium.mul( 0.07 ) ).add( grain.mul( 0.01 ) ).add( strata.mul( 0.012 ) );
	// 干的岩石是多孔的，镜面反射很弱：高光强度（也就是掠射角的 F90）压到 0.3，不然朝着太阳看整片岩面泛一层米色；
	// 湿的地方水膜反光，恢复到 1
	let specular = mix( float( 0.3 ), float( 1 ), wet );

	// 草甸、沙的程度（只有地形用，见下面）
	let meadow = float( 0 );
	let sandAmount = float( 0 );
	if ( withSand ) {

		// 沙：平缓（法线朝上）、离出生点那块岬角远的地方；陡坡露出岩石。
		// 不在平地上撒岩石斑块——从高处往回看，平地上一块块深色石斑像污渍
		const headland = exp( worldPosition.x.div( 13 ).pow2().negate() ).mul( float( 1 ).sub( smoothstep( 4, 14, worldPosition.z ) ) );
		const flat = smoothstep( 0.8, 0.92, normalWorld.y );
		// 离岸约 50 米以外是草甸（见下面），那里不画沙纹
		const shoreLine = float( - 2 ).add( sin( worldPosition.x.mul( 0.043 ).add( 0.6 ) ).mul( 5.5 ) ).add( sin( worldPosition.x.mul( 0.12 ).add( 2.0 ) ).mul( 2.5 ) )
			.sub( exp( worldPosition.x.div( 10 ).pow2().negate() ).mul( 7 ) );
		const meadowEdge = fbm2D( worldPosition.xz.mul( 0.035 ).add( 2.7 ), 3 ).sub( 0.5 ).mul( 24 ).add( 50 );
		meadow = smoothstep( meadowEdge.sub( 5 ), meadowEdge.add( 5 ), worldPosition.z.sub( shoreLine ) ).mul( smoothstep( 0.82, 0.93, normalWorld.y ) ).mul( uniforms.meadowToggle ).toVar();
		const sand = flat.mul( float( 1 ).sub( headland ) ).mul( float( 1 ).sub( meadow ) ).toVar();
		sandAmount = sand;
		// 风吹出来的沙纹：沿一个方向的细条纹，被噪声扭弯，只改法线
		const rippleCoordinate = worldPosition.x.mul( 0.6 ).add( worldPosition.z.mul( 0.8 ) ).mul( 14 ).add( fbm2D( worldPosition.xz.mul( 0.5 ), 2 ).mul( 6 ) );
		const sandRipple = sin( rippleCoordinate ).mul( 0.004 );
		const sandColor = mix( color( '#8c735c' ), color( '#a3876b' ), detail );
		const sandSurface = mix( sandColor, color( '#3e3027' ), wet );
		surfaceColor = mix( surfaceColor, sandSurface, sand );
		roughness = mix( roughness, mix( float( 0.95 ), float( 0.35 ), wet ), sand );
		bumpHeight = mix( bumpHeight, sandRipple.add( detail.mul( 0.01 ) ), sand );
		specular = mix( specular, mix( float( 0.4 ), float( 1 ), wet ), sand );

	}

	if ( withSand ) {

		// 草甸（阶段 12 CP3 返工）：离岸约 50 米以外（边界按噪声进退 ±12 米）沙地换成草甸的颜色——只是地面的颜色，不长草叶
		// （2026-10-02 用户："沙滩你长啥草"）。颜色和光照走远景同一套（远景的 worldLighting，放在自发光通道，乘远景这里的亮度倍数），
		// 地形块的边上和远景的草甸接得上；沙丘、陡坡上不长
		const meadowPatch = fbm2D( worldPosition.xz.mul( 0.02 ).add( 9.1 ), 3 );
		const meadowDetail = fbm2D( worldPosition.xz.mul( 0.11 ).sub( 4.4 ), 2 );
		const meadowAlbedo = mix( mix( color( '#73a050' ), color( '#8daf5b' ), smoothstep( 0.35, 0.65, meadowDetail ) ), mix( color( '#7d9d57' ), color( '#6a9259' ), meadowDetail ), smoothstep( 0.4, 0.6, meadowPatch ) )
			.mul( detail.mul( 0.2 ).add( 0.9 ) );
		// 远景的光照函数里有 If（地形阴影），要包在 Fn 里建
		const meadowLit = Fn( () => state.ctx.backdrop.worldLighting( meadowAlbedo, normalWorld, worldPosition ).mul( uniforms.meadowGain ) )();
		surfaceColor = surfaceColor.mul( float( 1 ).sub( meadow ) );
		specular = specular.mul( float( 1 ).sub( meadow ) );
		roughness = mix( roughness, float( 1 ), meadow );
		material.emissiveNode = meadowLit.mul( meadow );

	}

	// 近处的真贴图（和远景、其他地点同一套地表贴图，tsl/terrain.js）：岩石按"岩石"层（岩面扫描），沙按"沙土"，草甸按"草甸"；
	// 贴图只给明暗（按这一层的平均亮度归一）和法线细节，颜色还是上面按调色板算的（审查 R18）。颜色、法线各算一次（两个输出）
	const ground = state.ctx.backdrop.getGround();
	let baseNormal = normalViewGeometry;
	if ( ground ) {

		const rockAmount = float( 1 ).sub( sandAmount ).sub( meadow ).max( 0 );
		const weights = vec4( meadow, 0, rockAmount, sandAmount );
		const detailOf = ( normal ) => groundDetailInScene( ground, state.ctx.backdrop.getSceneToWorld(), {
			point: worldPosition, normal, weights, near: state.ctx.backdrop.getGroundNear(), cameraPoint: cameraPosition,
		} );
		surfaceColor = surfaceColor.mul( Fn( () => detailOf( normalWorld ).shade )() );
		baseNormal = Fn( () => normalize( cameraViewMatrix.mul( vec4( detailOf( normalWorldGeometry ).normal, 0 ) ).xyz ) )();

	}

	material.colorNode = surfaceColor;
	material.roughnessNode = roughness;
	material.specularIntensityNode = specular;
	// 凹下去的地方（中尺度噪声低处）挡掉一部分天空光；原来 0.7~1，从高处看一块块暗斑像带孔的奶酪板，收到 0.85~1
	material.aoNode = mix( float( 0.85 ), float( 1 ), smoothstep( 0.25, 0.65, medium ) );
	material.normalNode = bumpNormal( positionView, baseNormal, bumpHeight );

	state.disposables.push( material );
	return material;

}

// 程序化礁石：二十面体细分后合并顶点，沿径向用噪声推出不规则块面；海蚀柱拉高，底部插进海底。
// 岸边和岸上的石头（阶段 12 CP3 返工）换成 Poly Haven 的两块大石扫描（boulder_01、namaqualand_boulder_02，CC0）的形状，
// 颜色还是这里的程序化材质（世界坐标噪声，不用贴图）；原来是圆滚滚的变形球。hi 档用 1 万三角那一级，其余档用 3 千那一级；没读到用变形球
// 几十块石头变换好以后合成一个网格，一次绘制（主画面、平面反射、阴影各省几十次绘制调用，核显上明显）
async function loadRockShapes( tier ) {

	const shapes = [];
	const suffix = tier === 'hi' ? '' : '-lod1';
	for ( const name of [ 'boulder_01', 'namaqualand_boulder_02' ] ) {

		const model = await loadModel( 'models', name + suffix );
		const shape = model ? flattenModel( model ) : null;
		if ( model ) disposeModel( model );
		if ( ! shape ) {

			console.warn( `落日场景：岩石扫描 ${ name + suffix } 没读到，岸上的石头用程序化的` );
			continue;

		}

		// 只要形状：归一到底面中心在原点、水平最大边长 2、高按比例
		const geometry = shape.geometry;
		if ( shape.map ) shape.map.dispose();
		geometry.deleteAttribute( 'uv' );
		geometry.computeBoundingBox();
		const box = geometry.boundingBox;
		const size = Math.max( box.max.x - box.min.x, box.max.z - box.min.z );
		geometry.translate( - ( box.min.x + box.max.x ) / 2, - box.min.y, - ( box.min.z + box.max.z ) / 2 );
		geometry.scale( 2 / size, 2 / size, 2 / size );
		geometry.computeBoundingBox();
		shapes.push( { geometry, height: geometry.boundingBox.max.y } );

	}

	return shapes;

}

async function createRockMeshes( material, shadows, tier ) {

	const point = new THREE.Vector3();
	const placement = new THREE.Object3D();
	const pieces = [];
	const shapes = await loadRockShapes( tier );

	const slice = { start: performance.now() };
	for ( const spot of state.rockSpots ) {

		await yieldIfBusy( slice );
		if ( spot.kind !== 'stack' && shapes.length ) {

			// 扫描的形状：水平按半径缩放（扫描本身是 2 米宽）、高按 spot.height，埋进去三成（岸边的埋得多一点，浪打得到）
			const shape = shapes[ Math.floor( spot.seed * 7.3 ) % shapes.length ];
			const geometry = shape.geometry.clone();
			const ground = heightAt( spot.x, spot.z );
			const scaleY = spot.height / shape.height * ( spot.kind === 'shore' ? 1.15 : 1 );
			placement.scale.set( spot.radius * 1.1, scaleY, spot.radius * 0.95 );
			placement.position.set( spot.x, ( Number.isFinite( ground ) ? ground : 0 ) - spot.height * ( spot.kind === 'shore' ? 0.38 : 0.28 ), spot.z );
			placement.rotation.set( ( jsHash21( spot.seed, 3.3 ) - 0.5 ) * 0.25, spot.seed * 2.1, ( jsHash21( spot.seed, 8.1 ) - 0.5 ) * 0.25 );
			placement.updateMatrix();
			geometry.applyMatrix4( placement.matrix );
			if ( ! geometry.getAttribute( 'normal' ) ) geometry.computeVertexNormals();
			pieces.push( geometry );
			continue;

		}

		const detailLevel = spot.kind === 'stack' ? 5 : 4;
		const geometry = mergeVertices( new THREE.IcosahedronGeometry( 1, detailLevel ).deleteAttribute( 'normal' ).deleteAttribute( 'uv' ) );
		const positions = geometry.attributes.position;
		for ( let i = 0; i < positions.count; i ++ ) {

			point.fromBufferAttribute( positions, i );
			const bump = jsFbm2D( point.x * 1.6 + spot.seed, point.y * 1.9 + point.z * 1.3, 4 );
			// 块面：把噪声量化成几级，推出平的岩面和棱
			const facet = Math.round( jsValueNoise2D( point.x * 2.6 + spot.seed, point.z * 2.6 + point.y ) * 4 ) / 4;
			point.multiplyScalar( 0.72 + bump * 0.5 + facet * 0.14 );
			if ( spot.kind === 'stack' ) {

				// 海蚀柱：往上收窄，横向再按高度切几道台阶（被浪啃出来的凹槽）
				const taper = 1 - 0.32 * smoothstepJs( - 0.3, 1, point.y );
				const notch = 1 - 0.08 * Math.max( 0, Math.sin( point.y * 9 + spot.seed ) );
				point.x *= taper * notch;
				point.z *= taper * notch;

			}

			positions.setXYZ( i, point.x, point.y, point.z );

		}

		if ( spot.kind === 'stack' ) {

			// 海蚀柱：中心在海平面附近，往下插 0.4 倍高度进海底
			placement.scale.set( spot.radius, spot.height * 0.7, spot.radius * 0.85 );
			placement.position.set( spot.x, spot.height * 0.3, spot.z );

		} else {

			const ground = heightAt( spot.x, spot.z );
			placement.scale.set( spot.radius * 1.1, spot.height * 0.55, spot.radius * 0.9 );
			placement.position.set( spot.x, ( Number.isFinite( ground ) ? ground : 0 ) + spot.height * 0.18, spot.z );

		}

		placement.rotation.set( 0, spot.seed, 0 );
		placement.updateMatrix();
		geometry.applyMatrix4( placement.matrix );
		geometry.computeVertexNormals();
		pieces.push( geometry );

	}

	// 扫描带索引、变形球也带索引（mergeVertices）；属性只留位置和法线，合并时一致
	for ( const piece of pieces ) for ( const name of Object.keys( piece.attributes ) ) if ( name !== 'position' && name !== 'normal' ) piece.deleteAttribute( name );
	const merged = mergeGeometries( pieces );
	for ( const piece of pieces ) piece.dispose();
	for ( const shape of shapes ) shape.geometry.dispose();
	if ( ! merged ) throw new Error( '落日场景：礁石几何体合并失败' );
	state.disposables.push( merged );

	const mesh = new THREE.Mesh( merged, material );
	mesh.name = '礁石';
	mesh.castShadow = shadows;
	mesh.receiveShadow = shadows;
	return mesh;

}

// ===================== 海鸥 =====================
// 几何体在本地空间：+z 是飞行方向，x 是翼展（约 1.4 米）。顶点着色器按 |x|（离身体多远）扇翅膀

function buildSeagullGeometry() {

	// 半边翅膀的点：肩前、肩后、肘前、肘后、翼尖（往后掠）
	const half = [
		[ 0.05, 0, 0.08 ], [ 0.05, 0, - 0.08 ], [ 0.32, 0.03, 0.06 ], [ 0.3, 0.02, - 0.1 ], [ 0.7, - 0.02, - 0.2 ],
	];
	const vertices = [];
	const pushVertex = ( item, side ) => vertices.push( item[ 0 ] * side, item[ 1 ], item[ 2 ] );

	for ( const side of [ - 1, 1 ] ) {

		const triangles = [ [ 0, 2, 3 ], [ 0, 3, 1 ], [ 2, 4, 3 ] ];
		for ( const triangle of triangles ) {

			for ( const index of triangle ) pushVertex( half[ index ], side );

		}

	}

	// 身体：细长的菱形
	const body = [ [ 0, 0, 0.36 ], [ 0.055, 0, 0.02 ], [ 0, 0, - 0.34 ], [ - 0.055, 0, 0.02 ] ];
	for ( const triangle of [ [ 0, 1, 2 ], [ 0, 2, 3 ] ] ) {

		for ( const index of triangle ) vertices.push( ...body[ index ] );

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( vertices, 3 ) );
	return geometry;

}

// 每只海鸥一个普通 Mesh（共用几何体，材质各带一个相位）。
// 不用 InstancedMesh：节点材质先乘实例矩阵再套 positionNode，positionNode 里用原始顶点会把实例变换丢掉
function createSeagulls( count ) {

	const uniforms = state.uniforms;
	const geometry = buildSeagullGeometry();
	state.disposables.push( geometry );
	const group = new THREE.Group();
	group.name = '海鸥';

	for ( let i = 0; i < count; i ++ ) {

		const material = new THREE.MeshBasicNodeMaterial();
		material.name = '海鸥';
		material.side = THREE.DoubleSide;
		const phase = jsHash21( i, 3 ) * 6.28;

		// 扇翅：肩关节转 shoulderAngle，肘以外再往下折一点（海鸥特有的 M 形）；扇几秒、滑翔几秒交替
		material.positionNode = Fn( () => {

			const base = positionGeometry;
			const span = base.x.abs();
			const flapping = smoothstep( - 0.3, 0.3, sin( uniforms.sceneTime.mul( 0.33 ).add( phase ) ) );
			const shoulderAngle = sin( uniforms.sceneTime.mul( 7.5 ).add( phase ) ).mul( 0.6 ).mul( flapping ).add( 0.12 );
			const elbowAngle = shoulderAngle.mul( - 0.5 ).sub( 0.28 );
			const innerSpan = min( span, 0.32 );
			const outerSpan = max( span.sub( 0.32 ), 0 );
			const lift = innerSpan.mul( sin( shoulderAngle ) ).add( outerSpan.mul( sin( shoulderAngle.add( elbowAngle ) ) ) );
			return vec3( base.x, base.y.add( lift ), base.z );

		} )();
		// 逆光剪影：很暗的紫褐色
		material.colorNode = color( '#2a1f2b' );

		const mesh = new THREE.Mesh( geometry, material );
		mesh.name = '海鸥 ' + ( i + 1 );
		// 翼展放大到约 3 米（比真的大一些），五六十米外也看得出是只鸟
		mesh.scale.setScalar( 2.2 );
		mesh.frustumCulled = false;
		group.add( mesh );
		state.disposables.push( material );

	}

	return group;

}

// 海鸥的飞行轨迹：各自绕一个圆慢慢盘旋，上下起伏，转弯时侧倾
const seagullPaths = [
	{ centerX: - 12, centerY: 11, centerZ: - 42, radius: 10, speed: 0.18, phase: 0.3 },
	{ centerX: 18, centerY: 16, centerZ: - 62, radius: 13, speed: - 0.14, phase: 2.1 },
	{ centerX: 4, centerY: 26, centerZ: - 120, radius: 22, speed: 0.09, phase: 4.0 },
];

function updateSeagulls( time ) {

	const birds = state.seagulls.children;
	for ( let i = 0; i < birds.length; i ++ ) {

		const path = seagullPaths[ i ];
		const angle = path.phase + time * path.speed;
		const x = path.centerX + Math.cos( angle ) * path.radius;
		const z = path.centerZ + Math.sin( angle ) * path.radius;
		const y = path.centerY + Math.sin( time * 0.4 + path.phase ) * 1.5;
		// 速度方向 = 圆的切线
		const direction = Math.sign( path.speed );
		const bird = birds[ i ];
		bird.position.set( x, y, z );
		bird.lookAt( x - Math.sin( angle ) * direction, y + Math.cos( time * 0.4 + path.phase ) * 0.02, z + Math.cos( angle ) * direction );
		bird.rotateZ( 0.25 * direction );

	}

}

// ===================== 初始化 =====================

function sunDirectionFrom( azimuthDegrees, elevationDegrees, target ) {

	const azimuth = THREE.MathUtils.degToRad( azimuthDegrees );
	const elevation = THREE.MathUtils.degToRad( elevationDegrees );
	return target.set( Math.sin( azimuth ) * Math.cos( elevation ), Math.sin( elevation ), - Math.cos( azimuth ) * Math.cos( elevation ) ).normalize();

}

function tierOf( ctx ) {

	// 内容参数档（hi / mid / lo）：mid 档用"低"那一列，见 quality.js
	return ctx.quality && ctx.quality.content ? ctx.quality.content : 'mid';

}

export async function init( ctx ) {

	if ( state.scene || state.disposables.length > 0 ) {

		console.warn( '落日场景：init 被重复调用，先释放旧的再重建' );
		dispose();

	}

	try {

		return await buildScene( ctx );

	} catch ( error ) {

		// 建到一半失败：已经建好的 GPU 资源放掉，状态清干净，下次 init 从头来
		releaseResources();
		clearScene();
		resetState();
		throw error;

	}

}

async function buildScene( ctx ) {

	const started = performance.now();
	state.ctx = ctx;
	state.disposables = [];
	state.shadowCenter.set( NaN, NaN, NaN );
	state.shadowFrames = 0;
	const sunsetConfig = ctx.config.sunset;
	state.sunHighColor.set( sunsetConfig.sunColor );
	const sceneConfig = ctx.config.scenes.find( ( item ) => item.key === key );
	state.duration = sceneConfig ? sceneConfig.duration : 70;
	const tier = tierOf( ctx );
	state.currentTier = tier;
	const params = ctx.quality.params;
	const shadows = params.shadowSize > 0;

	// Cox–Munk：整片海面的斜率均方值 σ² = 0.003 + 0.00512·风速（Cox & Munk 1954，各向同性的总和）
	const coxMunkVariance = 0.003 + 0.00512 * sunsetConfig.windSpeed;
	state.waves = buildWaveSet( sunsetConfig, 1 );
	// 细节波纹两层的斜率方差（大块 0.005、小块 0.003）。画出来的浪 + 波纹最多占 σ² 的 85%，
	// 风小的时候（5 米/秒左右）一起按比例缩小——风小浪也小，剩下的才是"画不出来"、放进高光瓣的部分
	let rippleVarianceA = 0.005;
	let rippleVarianceB = 0.003;
	const drawnVariance = state.waves.resolvedVariance + rippleVarianceA + rippleVarianceB;
	const drawnLimit = coxMunkVariance * 0.85;
	if ( drawnVariance > drawnLimit ) {

		const slopeScale = Math.sqrt( drawnLimit / drawnVariance );
		state.waves = buildWaveSet( sunsetConfig, slopeScale );
		rippleVarianceA *= slopeScale * slopeScale;
		rippleVarianceB *= slopeScale * slopeScale;
		console.log( `落日场景：风速 ${ sunsetConfig.windSpeed } 米/秒，浪和波纹的斜率按 ${ slopeScale.toFixed( 2 ) } 倍缩小，配合 Cox–Munk 的 σ²` );

	}

	const unresolvedVariance = coxMunkVariance - state.waves.resolvedVariance - rippleVarianceA - rippleVarianceB;

	// 太阳按世界的时刻走：这个地点在别的地点停留时后台加载，世界此刻是别的时刻，按自己开始的时刻（18:50）先摆好
	const location = ctx.world.locations[ key ];
	const startHours = ctx.world.locationHours( key )[ 0 ];
	const startSun = ctx.world.anglesAt( startHours ).sun;
	state.veil = { amount: ctx.world.uniforms.locationVeil, yawDegrees: location.yaw, sky: ctx.world.uniforms };
	const oceanCenterWorld = ctx.world.toWorld( new THREE.Vector3( oceanCenter.x, 0, oceanCenter.y ), key );
	state.oceanCenterWorld = [ oceanCenterWorld.x, oceanCenterWorld.z ];

	const sunAngularRadius = THREE.MathUtils.degToRad( sunsetConfig.sunAngularRadius );
	state.uniforms = {
		sceneTime: uniform( 0 ),
		sunDirection: uniform( sunDirectionFrom( startSun.azimuth - location.yaw, startSun.elevation, new THREE.Vector3() ) ),
		sunRadiance: uniform( new THREE.Color( sunsetConfig.sunColor ).multiplyScalar( sunsetConfig.sunDiscIntensity ) ),
		sunAngularRadius: uniform( sunAngularRadius ),
		sunSolidAngle: uniform( Math.PI * sunAngularRadius * sunAngularRadius ),
		sunVisibleFraction: uniform( 1 ),
		sunLightColor: uniform( new THREE.Color( sunsetConfig.sunLightColor ) ),
		sunDiscVisible: uniform( 1 ),
		skyExposure: uniform( sunsetConfig.skyExposure ),
		skyDarken: uniform( 1 ),
		skyPaletteAmount: uniform( sunsetConfig.skyPaletteAmount ),
		skyPaletteBase: uniform( sunsetConfig.skyPaletteAmount ),
		horizonGlow: uniform( sunsetConfig.horizonGlow ),
		twilightStrength: uniform( sunsetConfig.twilightStrength ),
		earthShadowColor: uniform( new THREE.Color( sunsetConfig.earthShadowColor ) ),
		beltColor: uniform( new THREE.Color( sunsetConfig.beltColor ) ),
		zenithColor: uniform( new THREE.Color( sunsetConfig.zenithColor ) ),
		cloudAwayColor: uniform( new THREE.Color( sunsetConfig.cloudAwayColor ) ),
		skyOpacity: uniform( 1 ),
		twilightToggle: uniform( 1 ),
		cloudThreshold: uniform( 1 - sunsetConfig.cloudCoverage ),
		cloudBrightness: uniform( sunsetConfig.cloudBrightness ),
		cloudShadowColor: uniform( new THREE.Color( sunsetConfig.cloudShadowColor ) ),
		cloudAmount: uniform( 1 ),
		skyHorizon: uniform( new THREE.Color( sunsetConfig.skyHorizon ) ),
		skyMid: uniform( new THREE.Color( sunsetConfig.skyMid ) ),
		skyHigh: uniform( new THREE.Color( sunsetConfig.skyHigh ) ),
		waterColor: uniform( new THREE.Color( sunsetConfig.waterColor ) ),
		shallowColor: uniform( new THREE.Color( sunsetConfig.shallowColor ) ),
		sssColor: uniform( new THREE.Color( sunsetConfig.sssColor ) ),
		sssStrength: uniform( sunsetConfig.sssStrength ),
		foamColor: uniform( new THREE.Color( sunsetConfig.foamColor ) ),
		pathIntensity: uniform( sunsetConfig.pathIntensity ),
		sparkleIntensity: uniform( sunsetConfig.sparkleIntensity ),
		secondSparkleLayer: uniform( params.sparkleLayers >= 2 ? 1 : 0 ),
		thirdSparkleLayer: uniform( params.sparkleLayers >= 3 ? 1 : 0 ),
		unresolvedVariance: uniform( unresolvedVariance ),
		resolvedVariance: uniform( state.waves.resolvedVariance ),
		rippleVariance: uniform( rippleVarianceA + rippleVarianceB ),
		rippleAmplitudeA: uniform( Math.sqrt( rippleVarianceA ) ),
		rippleAmplitudeB: uniform( Math.sqrt( rippleVarianceB ) ),
		totalAmplitude: uniform( state.waves.totalAmplitude ),
		// 层开关
		sunDiscToggle: uniform( 1 ),
		waveAmount: uniform( 1 ),
		rippleAmount: uniform( 1 ),
		reflectionToggle: uniform( 1 ),
		pathToggle: uniform( 1 ),
		sparkleToggle: uniform( 1 ),
		sssToggle: uniform( 1 ),
		foamToggle: uniform( 1 ),
		shallowToggle: uniform( 1 ),
		wetToggle: uniform( 1 ),
		fogAmount: uniform( 1 ),
		meadowToggle: uniform( 1 ),
		meadowGain: uniform( sunsetConfig.backdropGain ),   // 草甸的亮度倍数，和远景这里的一样（update 里跟着交接的薄雾变）
	};
	const uniforms = state.uniforms;

	const scene = new THREE.Scene();
	scene.name = '落日与海';
	state.scene = scene;

	// ---------- 地形和礁石 ----------
	const stepTimes = [];
	let stepStart = performance.now();
	const markStep = async ( label ) => {

		stepTimes.push( `${ label } ${ ( performance.now() - stepStart ).toFixed( 0 ) }` );
		await yieldToBrowser();
		stepStart = performance.now();

	};

	// 溪床里不放礁石
	state.rockSpots = placeRocks().filter( ( spot ) => spot.kind === 'stack' || creekDistance( spot.x, spot.z ) > creekHalfWidth + spot.radius * 1.3 + 0.5 );
	const heightField = await buildHeightField( state.rockSpots );
	state.heightData = heightField.heights;
	state.heightTexture = heightField.heightTexture;
	state.disposables.push( state.heightTexture );

	const rockMaterial = createRockMaterial( false );
	const shoreMaterial = createRockMaterial( true );
	const terrainGeometry = buildTerrainGeometry( sunsetConfig.terrainSegments[ tier ] );
	state.disposables.push( terrainGeometry );
	const terrain = new THREE.Mesh( terrainGeometry, shoreMaterial );
	terrain.name = '礁石岸';
	terrain.castShadow = shadows;
	terrain.receiveShadow = shadows;
	scene.add( terrain );
	await markStep( '地形' );
	scene.add( await createRockMeshes( rockMaterial, shadows, tier ) );
	await markStep( '礁石' );

	// 小溪：贴着看得见的地面（自己的地形和远景取高的），流到地面低过 0.3 米（进了海）为止
	const creekGround = ( x, z ) => {

		const own = heightAt( x, z );
		const drawn = backdropHeightAt( x, z );
		return Number.isFinite( drawn ) ? Math.max( own, drawn ) : own;

	};
	const creekPoints = [];
	for ( let i = 1; i < creekPath.length; i ++ ) {

		const [ ax, az ] = creekPath[ i - 1 ];
		const [ bx, bz ] = creekPath[ i ];
		const steps = Math.ceil( Math.hypot( bx - ax, bz - az ) / 2 );
		for ( let k = i === 1 ? 0 : 1; k <= steps; k ++ ) creekPoints.push( { x: ax + ( bx - ax ) * k / steps, z: az + ( bz - az ) * k / steps } );

	}

	const mouth = creekPoints.findIndex( ( point ) => heightAt( point.x, point.z ) < 0.3 );
	if ( mouth < 0 ) console.warn( '落日场景：小溪的中线没走到海里，溪口停在中线的尽头' );
	const creekGeometry = buildCreekRibbon( creekPoints.slice( 0, mouth < 0 ? creekPoints.length : mouth + 2 ), creekGround, { halfWidth: creekHalfWidth, fadeIn: 4, fadeOut: 3, lift: 0.08 } );
	const creekMaterial = createCreekMaterial( '小溪', {
		lighting: ctx.backdrop.worldLighting,
		atmosphere: ctx.backdrop.worldAtmosphere,
		sky: ctx.world.uniforms,
		time: uniforms.sceneTime,
		toWorldDirection: ctx.backdrop.sceneDirectionToWorld,
	} );
	state.disposables.push( creekGeometry, creekMaterial );
	const creekMesh = new THREE.Mesh( creekGeometry, creekMaterial );
	creekMesh.name = '小溪';
	creekMesh.renderOrder = 2;
	scene.add( creekMesh );
	state.creek = creekMesh;

	// ---------- 天空和环境光 ----------
	state.sky = createSky();
	scene.add( state.sky );
	state.environmentScene = new THREE.Scene();
	if ( ! ctx.pmrem ) throw new Error( '落日场景：ctx.pmrem（共用的环境光贴图生成器）没建' );
	// 先画一张空的环境光贴图（天空的着色器还没编，现在画会同步编译、卡住上一个地点）：
	// 贴图对象从这里起不再换，场景的预编译按它来；compile() 编好天空以后再画进真正的天空
	state.environmentTarget = ctx.pmrem.fromScene( state.environmentScene, 0, 0.1, 3000, { size: 128, position: state.environmentCameraPosition } );
	state.environmentReady = false;
	// 天空光：黄昏的阴影是被整片天照亮的（偏蓝紫），不是黑的；环境光贴图本身是按天空真实亮度算的，这里再整体提一点
	scene.environmentIntensity = sunsetConfig.environmentIntensity;
	state.lastEnvironmentElevation = startSun.elevation;
	state.lastEnvironmentDarken = 0;
	sunDirectionFrom( startSun.azimuth - location.yaw, startSun.elevation, state.sunDirection );
	state.sky.sunPosition.value.copy( state.sunDirection );
	scene.environment = state.environmentTarget.texture;
	await markStep( '天空' );

	// ---------- 海面 ----------
	state.rippleTexture = await buildRippleTexture();
	state.disposables.push( state.rippleTexture );
	await markStep( '波纹贴图' );
	state.oceanGrid = buildOceanGeometry( sunsetConfig.oceanSegments[ tier ] );
	await fillLandHeights( state.oceanGrid.geometry );
	state.disposables.push( state.oceanGrid.geometry );
	await markStep( '海面网格' );
	const useReflector = params.reflectionScale > 0;
	state.oceanMaterials = { reflective: null, plain: null };
	const oceanMaterial = createOceanMaterial( tier, useReflector );
	state.oceanMaterials[ useReflector ? 'reflective' : 'plain' ] = oceanMaterial;
	const ocean = new THREE.Mesh( state.oceanGrid.geometry, oceanMaterial );
	ocean.name = '海面';
	ocean.frustumCulled = false;
	scene.add( ocean );
	state.ocean = ocean;
	// 倒影跳过用的水面分块（camera.js 的 prepareMeshView），在这里取好点，不放进第一帧
	prepareMeshView( ocean, { groundHeight: heightAt } );
	if ( state.reflectorTarget ) scene.add( state.reflectorTarget );
	state.reflectionPass = () => {

		if ( ! state.ready || ! state.reflectorNode || state.ocean.material !== state.oceanMaterials.reflective ) return;
		// 水面不在视锥里（转身背对水面）这一帧不画倒影（camera.js 的 isMeshInView）
		if ( ! isMeshInView( state.ctx.camera, state.ocean, { margin: 3, groundHeight: heightAt } ) ) return;
		state.reflectorNode.reflector.updateBefore( { scene: state.scene, camera: state.ctx.camera, renderer: state.ctx.renderer, material: state.ocean.material } );

	};

	// ---------- 光 ----------
	const sunLight = new THREE.DirectionalLight( sunsetConfig.sunLightColor, sunsetConfig.sunLightIntensity );
	sunLight.name = '夕阳';
	if ( shadows ) {

		sunLight.castShadow = true;
		sunLight.shadow.mapSize.set( params.shadowSize, params.shadowSize );
		const shadowCamera = sunLight.shadow.camera;
		shadowCamera.left = - 60;
		shadowCamera.right = 60;
		shadowCamera.top = 60;
		shadowCamera.bottom = - 60;
		shadowCamera.near = 1;
		shadowCamera.far = 600;
		shadowCamera.updateProjectionMatrix();
		sunLight.shadow.bias = - 0.0005;
		sunLight.shadow.normalBias = 0.3;
		sunLight.shadow.radius = 4;

	}

	scene.add( sunLight );
	scene.add( sunLight.target );
	state.sunLight = sunLight;
	if ( shadows ) addShadowProxies( scene, sunLight );

	// ---------- 海鸥 ----------
	const seagullCount = Math.min( Math.max( 0, Math.round( sunsetConfig.seagullCount ) ), seagullPaths.length );
	if ( seagullCount !== sunsetConfig.seagullCount ) console.warn( `落日场景：seagullCount 只能是 0~${ seagullPaths.length }，按 ${ seagullCount } 只画` );
	state.seagulls = createSeagulls( seagullCount );
	scene.add( state.seagulls );
	updateSeagulls( 0 );

	// ---------- 雾：海面上一层暖色薄雾，朝太阳方向前向散射更亮（海面自己不叠雾）----------
	scene.fogNode = heightFog( {
		density: uniform( sunsetConfig.fogDensity ),
		falloff: uniform( sunsetConfig.fogFalloff ),
		baseColor: color( sunsetConfig.fogColor ).mul( uniforms.skyDarken ),
		scatterColor: uniforms.sunLightColor.mul( sunsetConfig.fogScatter ).mul( uniforms.sunVisibleFraction ),
		lightDirection: uniforms.sunDirection,
		anisotropy: float( 0.65 ),
		amount: uniforms.fogAmount,
		veil: state.veil,
	} );

	// ---------- 调试开关 ----------
	state.layers = {
		天空配色: ( enabled ) => {

			uniforms.skyPaletteAmount.value = enabled ? sunsetConfig.skyPaletteAmount : 0;

		},
		太阳圆盘: uniforms.sunDiscToggle,
		晚霞: uniforms.cloudAmount,
		大浪: uniforms.waveAmount,
		细节波纹: uniforms.rippleAmount,
		反射: uniforms.reflectionToggle,
		金色光路: uniforms.pathToggle,
		闪点: uniforms.sparkleToggle,
		浪尖透绿: uniforms.sssToggle,
		泡沫: uniforms.foamToggle,
		浅水: uniforms.shallowToggle,
		湿岩石: uniforms.wetToggle,
		暮光天空: uniforms.twilightToggle,
		海鸥: ( enabled ) => {

			state.seagulls.visible = enabled;

		},
		海雾: uniforms.fogAmount,
		草甸: uniforms.meadowToggle,
		小溪: ( enabled ) => {

			state.creek.visible = enabled;

		},
	};

	state.ready = true;
	applySunState( startHours );
	await markStep( '其余' );
	console.log( `落日场景：初始化完成，用时 ${ ( performance.now() - started ).toFixed( 0 ) } ms（${ stepTimes.join( '，' ) }），档位 ${ tier }，Cox–Munk σ² = ${ coxMunkVariance.toFixed( 4 ) }（浪 ${ state.waves.resolvedVariance.toFixed( 4 ) } + 波纹 ${ ( rippleVarianceA + rippleVarianceB ).toFixed( 4 ) } + 高光瓣 ${ Math.max( unresolvedVariance, 0.002 ).toFixed( 4 ) }）` );
	return { scene };

}

// ===================== 每帧 =====================

// 太阳位置、颜色、天色按世界的时刻（小时）走：停留期间 18:50 → 19:00 从 2.6° 竖直沉到 1.0°（config.world.skyKeys），
// 最后 20 秒天变暗。时刻跑出停留范围（起飞时继续往后走）就停在结尾的样子
function applySunState( hours ) {

	const sunsetConfig = state.ctx.config.sunset;
	const world = state.ctx.world;
	const duration = state.duration;
	const uniforms = state.uniforms;
	const location = world.locations[ key ];
	const [ startHours, endHours ] = world.locationHours( key );

	const sinceStart = ( ( hours - startHours + 12 ) % 24 + 24 ) % 24 - 12;
	const progress = Math.min( 1, Math.max( 0, sinceStart / ( endHours - startHours ) ) );
	const sun = world.anglesAt( hours ).sun;
	const elevation = sun.elevation;
	const darken = smoothstepJs( 1 - 20 / duration, 1, progress ) * sunsetConfig.endDarken;

	sunDirectionFrom( sun.azimuth - location.yaw, elevation, state.sunDirection );
	uniforms.sunDirection.value.copy( state.sunDirection );
	state.sky.sunPosition.value.copy( state.sunDirection );

	// 太阳越低越红（穿过的大气越厚），圆盘露出海面的比例决定还剩多少光
	const radiusDegrees = sunsetConfig.sunAngularRadius;
	const visibleFraction = smoothstepJs( - radiusDegrees, radiusDegrees, elevation );
	const warmth = smoothstepJs( 0, 5, elevation );
	state.sunTint.copy( state.sunLowColor ).lerp( state.sunHighColor, warmth );
	uniforms.sunRadiance.value.copy( state.sunTint ).multiplyScalar( sunsetConfig.sunDiscIntensity * ( 1 - darken * 0.4 ) );
	uniforms.sunVisibleFraction.value = visibleFraction;
	uniforms.skyDarken.value = 1 - darken;
	state.sunLight.intensity = sunsetConfig.sunLightIntensity * visibleFraction * ( 1 - darken );

	// 环境光贴图：太阳沉够一定角度、或者天暗了一截才重新生成（生成一次要渲 6 面 + 模糊，不能每帧做）
	if ( state.environmentReady && ( Math.abs( elevation - state.lastEnvironmentElevation ) > sunsetConfig.environmentInterval || Math.abs( darken - state.lastEnvironmentDarken ) > 0.05 ) ) {

		state.lastEnvironmentElevation = elevation;
		state.lastEnvironmentDarken = darken;
		updateEnvironment();

	}

}

export function enter() {

	if ( ! state.ready ) throw new Error( '落日场景：还没 init 就调了 enter' );

	const ctx = state.ctx;
	ctx.pipeline.addPrePass( state.reflectionPass );
	const start = playerStart();
	// 岸上的石头和半泡在水里的礁石都挡人（礁石网格最宽约 1.5 倍 radius）；海蚀柱在水里，本来就走不到
	const obstacles = state.rockSpots.filter( ( spot ) => spot.kind !== 'stack' ).map( ( spot ) => ( { x: spot.x, z: spot.z, radius: spot.radius * 1.5 + 0.3 } ) );
	ctx.director.setWalk( {
		position: start.position,
		lookAt: start.lookAt,
		groundHeight: heightAt,
		obstacles,
		canWalk,
		bounds: {
			minX: - terrainSize / 2 + 15,
			maxX: terrainSize / 2 - 15,
			minZ: terrainCenterZ - terrainSize / 2 + 15,
			maxZ: terrainCenterZ + terrainSize / 2 - 15,
		},
	} );

	for ( const label of Object.keys( state.layers ) ) {

		ctx.debug.addLayerToggle( key, label, state.layers[ label ] );

	}

}

// 预编译（时间线在停留期间调）：平面反射是画到它自己的渲染目标里的（和主场景不是同一个渲染上下文），
// 落日的场景和挂进来的远景都要在反射目标上再编一遍，不然降落后第一帧画倒影时同步编译，卡 0.5 秒。海面自己在倒影里不画
// 倒影目标和环境光贴图目标附件格式一样、色彩空间不同，共用一个渲染上下文，不能同时编（见 pipeline.compileScene 的说明）：
// 先编倒影，编完再编环境光贴图里的天空，最后画真正的环境光贴图
export async function compile() {

	if ( ! state.ready ) return;
	const ctx = state.ctx;

	if ( state.reflectorNode ) {

		const reflector = state.reflectorNode.reflector;
		const virtualCamera = reflector.getVirtualCamera( ctx.camera );
		const target = reflector.getRenderTarget( virtualCamera );
		const oceanMaterial = state.ocean.material;
		let jobs;
		oceanMaterial.visible = false;
		try {

			jobs = [
				ctx.pipeline.compileScene( state.scene, virtualCamera, null, target ),
				ctx.pipeline.compileScene( ctx.backdrop.getRoot(), virtualCamera, state.scene, target ),
			];

		} finally {

			oceanMaterial.visible = true;

		}

		await Promise.all( jobs );
		if ( ! state.ready ) return;

	}

	// 天空在环境光贴图那个渲染目标格式上先异步编好（HalfFloat、线性色彩空间、带深度，同 PMREMGenerator 的立方体目标），再画真正的环境光贴图
	const environmentTarget = new THREE.RenderTarget( 1, 1, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace, depthBuffer: true } );
	const environmentCamera = new THREE.PerspectiveCamera( 90, 1, 0.1, 3000 );
	try {

		await ctx.pipeline.compileScene( state.sky, environmentCamera, state.environmentScene, environmentTarget );

	} finally {

		environmentTarget.dispose();

	}

	if ( ! state.ready ) return;
	updateEnvironment();
	state.environmentReady = true;

}

// 出生点（本地坐标）：飞过来的终点
// 本地 (x, z) 的地面高度（全景烘焙点按它放眼睛）
export function groundHeightAt( x, z ) {

	return heightAt( x, z );

}

export function getSpawn() {

	return state.ready ? playerStart() : null;

}

// 出生点：岬角上离水几米、地面高 1.2 米以上的地方，看向太阳；地平线压在画面下三分之一
function playerStart() {

	const x = 0.5;
	let z = shoreZ( x );
	while ( z < 30 && heightAt( x, z ) < 1.25 ) z += 0.25;
	z += 1.5;
	const ground = heightAt( x, z );
	const eyeHeight = state.ctx.config.camera.eyeHeight;
	return { position: [ x, ground + eyeHeight, z ], lookAt: [ x, ground + eyeHeight + 21, z - 200 ] };

}

export function update( dt, time ) {

	if ( ! state.ready ) return;

	const ctx = state.ctx;
	const uniforms = state.uniforms;
	const camera = ctx.camera;
	uniforms.sceneTime.value = time;

	// ---------- 画质：动态降档时跟着变 ----------
	const params = ctx.quality.params;
	const tier = tierOf( ctx );
	uniforms.secondSparkleLayer.value = params.sparkleLayers >= 2 ? 1 : 0;
	uniforms.thirdSparkleLayer.value = params.sparkleLayers >= 3 ? 1 : 0;
	const wantReflector = params.reflectionScale > 0;
	// 倒影分辨率跟着场景比例走：放大模式下场景按 renderScale 画，倒影的目标是按画布算的，原来比场景本身还清楚
	// （性能，perf.scenesB.sunsetReflectionFollowScale；满分辨率时不变）
	const follow = ctx.config.perf.scenesB.sunsetReflectionFollowScale && ctx.quality.mode === 'upscale';
	const sceneScale = follow ? Math.min( 1, Math.max( 0.25, ctx.quality.renderScale ) ) : 1;
	if ( state.reflectorNode && wantReflector ) state.reflectorNode.reflector.resolutionScale = params.reflectionScale * sceneScale;
	if ( tier !== state.currentTier ) {

		state.currentTier = tier;
		switchOceanMaterial( wantReflector, tier );

	}

	applySunState( ctx.world.getDayTime() );
	applyWorldSettings();

	// ---------- 阴影相机跟着人（按需重画，见 followShadow）----------
	shadowFocus.set( camera.position.x, 0, camera.position.z - 20 );
	followShadow( state.sunLight, shadowFocus, state.sunDirection, 300 );

	updateSeagulls( time );

}

// 和远景的对接，每帧设一遍（只改 uniform 和显隐）：
//   天空：统一天空混进来的程度 worldSkyBlend；完全是自己的天空时不画远景天空球（省一整层云）
//   远景的海在海面圆盘里沉 2 米（大浪的波谷最深约 −1.4 米），两层水不重面
//   海雾也盖到远景上，地形边上看不出接缝；化进薄雾时海雾跟着淡掉（化完以后只画远景，那里没有海雾）
function applyWorldSettings() {

	const ctx = state.ctx;
	const sunsetConfig = ctx.config.sunset;
	const uniforms = state.uniforms;
	const worldUniforms = ctx.world.uniforms;
	const blend = worldUniforms.worldSkyBlend.value;
	uniforms.skyOpacity.value = 1 - blend;
	ctx.backdrop.setSkyVisible( blend > 0.001 );
	// 化进薄雾时增益慢慢回到 1（化完以后只画远景，用的是统一天空本来的亮度）
	ctx.backdrop.setSurfaceGain( 1 + ( sunsetConfig.backdropGain - 1 ) * ( 1 - worldUniforms.locationVeil.value ) );
	uniforms.meadowGain.value = 1 + ( sunsetConfig.backdropGain - 1 ) * ( 1 - worldUniforms.locationVeil.value );
	ctx.backdrop.setSeaCut( { center: state.oceanCenterWorld, radius: oceanRadius, fade: 150, depth: 2 } );
	state.fogColor.set( sunsetConfig.fogColor ).multiplyScalar( uniforms.skyDarken.value );
	state.fogScatter.copy( uniforms.sunLightColor.value ).multiplyScalar( sunsetConfig.fogScatter * uniforms.sunVisibleFraction.value );
	ctx.backdrop.setLocationFog( {
		density: sunsetConfig.fogDensity,
		falloff: sunsetConfig.fogFalloff,
		baseHeight: ctx.world.locations[ key ].origin[ 1 ],
		color: state.fogColor,
		scatterColor: state.fogScatter,
		lightDirection: ctx.world.directionToWorld( state.sunDirection, key, tempWorldPoint ),
		anisotropy: 0.65,
		amount: uniforms.fogAmount.value * ( 1 - worldUniforms.locationVeil.value ),
	} );

}

// 运行中换档：有没有平面反射要换一套海面材质（第一次换会编译一次着色器）
function switchOceanMaterial( wantReflector, tier ) {

	const slot = wantReflector ? 'reflective' : 'plain';
	if ( state.ocean.material === state.oceanMaterials[ slot ] ) return;
	if ( state.oceanMaterials[ slot ] ) {

		state.ocean.material = state.oceanMaterials[ slot ];
		return;

	}

	if ( state.pendingOceanSwitch ) return;

	// 第一次换到这一档：先在后台把新材质编译好，编好了再换上，换档那一刻不会因为编译着色器再卡一下
	console.log( `落日场景：画质换到 ${ tier }，海面改用${ wantReflector ? '平面反射' : '环境反射' }，后台编译新材质` );
	const material = createOceanMaterial( tier, wantReflector );
	state.oceanMaterials[ slot ] = material;
	if ( wantReflector && state.reflectorTarget && ! state.reflectorTarget.parent ) state.scene.add( state.reflectorTarget );
	const probe = new THREE.Mesh( state.oceanGrid.geometry, material );
	probe.frustumCulled = false;
	state.pendingOceanSwitch = true;
	state.ctx.renderer.compileAsync( probe, state.ctx.camera, state.scene ).then( () => {

		state.pendingOceanSwitch = false;
		if ( state.ready && state.oceanMaterials[ slot ] === material ) state.ocean.material = material;

	} ).catch( ( error ) => {

		state.pendingOceanSwitch = false;
		console.error( '落日场景：换档时编译海面材质失败，继续用原来的：', error );

	} );

}

export function exit() {

	if ( ! state.ctx ) return;
	state.ctx.pipeline.removePrePass( state.reflectionPass );
	state.ctx.debug.removeSceneToggles( key );
	state.ctx.director.clearWalk();

}

function releaseResources() {

	for ( const item of state.disposables ) {

		if ( item && typeof item.dispose === 'function' ) item.dispose();

	}

	state.disposables = [];
	if ( state.reflectorNode ) state.reflectorNode.dispose();
	if ( state.environmentTarget ) state.environmentTarget.dispose();
	if ( state.sunLight && state.sunLight.shadow ) state.sunLight.shadow.dispose();
	state.reflectorNode = null;
	state.reflectorTarget = null;
	state.environmentTarget = null;
	state.environmentReady = false;

}

export function dispose() {

	if ( ! state.scene && state.disposables.length === 0 ) return;
	state.ready = false;
	if ( state.ctx ) state.ctx.pipeline.removePrePass( state.reflectionPass );

	releaseResources();
	clearScene();
	resetState();
	console.log( '落日场景：已释放' );

}

function clearScene() {

	if ( state.scene ) {

		state.scene.fogNode = null;
		state.scene.environment = null;
		state.scene.clear();

	}

	if ( state.environmentScene ) state.environmentScene.clear();

}

function resetState() {

	state.ready = false;
	state.scene = null;
	state.environmentScene = null;
	state.sky = null;
	state.heightData = null;
	state.heightTexture = null;
	state.rippleTexture = null;
	state.oceanGrid = null;
	state.ocean = null;
	state.oceanMaterials = { reflective: null, plain: null };
	state.pendingOceanSwitch = false;
	state.seagulls = null;
	state.creek = null;
	state.sunLight = null;
	state.reflectionPass = null;
	state.veil = null;
	state.uniforms = null;
	state.layers = null;
	state.waves = null;
	state.rockSpots = [];
	state.ctx = null;

}

// ===================== 截图和调试用 =====================

// 规格书 8.3：光路细碎闪烁、天空没有色带。五个机位：出生点、高处看长光路、贴水看礁石浪花、低头看海面、转身回望
export function getShotViews() {

	if ( ! state.ready ) return [];
	const eyeHeight = state.ctx.config.camera.eyeHeight;
	const start = playerStart();

	const highX = - 3;
	const highZ = 34;
	const highGround = heightAt( highX, highZ );

	// 出生点左边的岸上，侧着看左边那根大海蚀柱和它脚下的浪，太阳在画面右边
	const sideX = - 9;
	let sideZ = shoreZ( sideX );
	while ( sideZ < 40 && heightAt( sideX, sideZ ) < 1.2 ) sideZ += 0.25;
	sideZ += 0.5;
	const sideGround = heightAt( sideX, sideZ );

	return [
		{ name: '出生点', position: start.position, lookAt: start.lookAt },
		{ name: '高处光路', position: [ highX, highGround + eyeHeight, highZ ], lookAt: [ 0, highGround + eyeHeight + 14, - 200 ] },
		{ name: '礁石浪花', position: [ sideX, sideGround + eyeHeight, sideZ ], lookAt: [ - 27, 2.5, - 44 ] },
		{ name: '低头看海', position: start.position, lookAt: [ start.position[ 0 ] + 1, 0, start.position[ 2 ] - 9 ] },
		// 背对太阳往回看：沙丘、秘境的山（远景）和维纳斯带，检查转身以后世界也是完整的
		{ name: '回望海湾', position: [ highX, highGround + eyeHeight, highZ ], lookAt: [ highX + 87, highGround + eyeHeight + 3, highZ + 50 ] },
	];

}

export function getLayers() {

	return state.layers || {};

}
