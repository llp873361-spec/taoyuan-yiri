// 常驻远景（秘境）：世界地形（海画在地形顶点里，湖、河和花园水池画在地表图里）、统一天空和薄云、树林、各地点的替身、窗灯。
// 规格书 4、5.0、5.3、6.4。
//
// 所有东西都在世界坐标里建，挂在 root 下：秘境俯瞰模式 root 是单位变换；4b 起挂进各地点的场景时，root 用 world.worldToAnchorMatrix() 换到地点的局部坐标。
// 着色全在世界坐标里算：几何体坐标就是世界坐标，相机的世界坐标 = sceneToWorld × cameraPosition（换了相机的反射 pass 也对）。
// 远处的顶点做"径向深度压缩"：compressStart 以外沿视线拉近，屏幕位置不变、只改深度，给 4b 里 far = 2000 的地点相机用；俯瞰模式不压。
// 做法参照 three r186 自带的 TerrainGenerator（大气透视、岩层）和 ForestGenerator（一次实例化画完所有树、按距离随机稀疏）。
// 山洞（阶段 7）：洞壁、洞口的石头在这里，所有地点和飞行都看得到；地形穿过洞的那一截挖掉（caveCutout）。
//
// 着色器里的几条规矩（Metal / Vulkan 上的坑）：pow 的底数一律先夹到 ≥ 0（平方用 pow2）；
// 要在分支里用的贴图取样和屏幕导数，先在分支外 toVar 落地（TSL 按第一次用到的位置生成代码）。

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Discard, float, vec2, vec3, vec4, uniform, uniformArray, attribute, texture, color, varying, select, frontFacing,
	positionLocal, positionWorld, positionGeometry, normalGeometry, normalWorld, modelWorldMatrix,
	cameraPosition, cameraViewMatrix, cameraProjectionMatrix, screenSize,
	normalize, length, dot, max, min, mix, smoothstep, exp, pow, abs, sin, atan, fwidth, reflect, step,
	floor, clamp, sqrt, ivec2, textureLoad,
} from 'three/tsl';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { jsFbm2D, createNoiseTextureData, sampleNoiseTexture } from '../tsl/noise.js';
import { daySkyColor, dayAerialColor } from '../tsl/sky.js';
import { heightFogFactor, henyeyGreenstein } from '../tsl/fog.js';
import { seaStacks } from './sunset.js';
import { buildNarrows } from './narrows.js';
import { createGuide } from '../tsl/guide.js';
import { loadGroundTextures, groundDetail } from '../tsl/terrain.js';
import { buildSpeciesTemplates, createLeafMaterial, createBarkMaterial, createTreeField, createUnderstoryLayer, treeSpeciesHash, buildFocalTemplate, loadBlossomModel, buildModelBlossomTemplates, viewFromCamera } from '../tsl/trees.js';
import { createImpostorForest } from '../tsl/impostors.js';
import { planForest } from '../core/forest.js';
import { gardenLayout, gardenGroundLocal } from './garden.js';
import { loadTexture, loadModel, disposeModel, getManifest, blobOf, gunzipToArrayBuffer } from '../core/assets.js';
import { grassUnderlayShape } from '../tsl/grass.js';

export const key = 'backdrop';

const degree = Math.PI / 180;
const lumaWeights = [ 0.2126, 0.7152, 0.0722 ];

// ===================== 分片构建：每干 10 ms 让出一次主线程 =====================
// 用 setTimeout 而不是 requestAnimationFrame：截图模式下帧是手动推进的
const sliceBudget = 10;
const yieldToBrowser = () => new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

async function yieldIfBusy( slice ) {

	if ( performance.now() - slice.start > sliceBudget ) {

		await yieldToBrowser();
		slice.start = performance.now();

	}

}

// JS 里的 smoothstep，edge0 > edge1 时是递减的
function smoothJs( edge0, edge1, value ) {

	const amount = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return amount * amount * ( 3 - 2 * amount );

}

// 确定性随机数（mulberry32），同一个种子每次摆出来一样
function createRandom( seed ) {

	let value = ( seed >>> 0 ) || 1;
	return function next() {

		value = ( value + 0x6D2B79F5 ) | 0;
		let mixed = Math.imul( value ^ ( value >>> 15 ), 1 | value );
		mixed = ( mixed + Math.imul( mixed ^ ( mixed >>> 7 ), 61 | mixed ) ) ^ mixed;
		return ( ( mixed ^ ( mixed >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

function tierOf( ctx ) {

	// 内容参数档（hi / mid / lo）：mid 档用"低"那一列，见 quality.js
	return ctx.quality && ctx.quality.content ? ctx.quality.content : 'mid';

}

// 着色器里的递减 smoothstep：1 - smoothstep(low, high, x)，不写 edge0 > edge1 的 smoothstep
function fadeOut( low, high, value ) {

	return float( 1 ).sub( smoothstep( low, high, value ) );

}

// ===================== 模块状态 =====================

const state = {
	patches: [],              // 窄处的地形补丁（阶段 12 CP3 返工，见 patchFootprints）
	ctx: null,
	world: null,
	scene: null,
	root: null,
	locationTrees: new Set(),   // 地点自己的花树（createLocationBlossoms），每帧跟着镜头重挑
	mistLayers: [],             // 谷雾每层的网格和高度（镜头在雾层以下时整层不画）
	cloudClusterMesh: null,     // 云团（入夜整片不画）
	treeUniforms: null,
	treeShade: null,
	ready: false,
	building: null,       // init 进行中的 Promise：重复调用时直接等同一个，不会两份互相覆盖
	disposables: [],
	uniforms: null,
	toggles: null,
	textures: null,
	skyDome: null,
	terrainMeshes: [],
	forest: [],
	proxyGroups: {},      // 地点 key → 替身 Group（4b 交接时单独显隐）
	houseFootprints: [],  // 小镇房子的 [x, z, 半径]：树不种在房子里
	townHouses: [],       // 小镇每栋房子的尺寸（世界坐标），星月夜按面画笔触用：见 buildTown
	caveUniforms: null,   // 山洞的中线折线、截面、包围盒（地形挖洞和洞里的光用）
	caveMeshes: [],
	core: null,
	outer: null,
	horizon: null,
	windDirection: new THREE.Vector2( 1, 0 ),
	narrows: [],          // 先窄后豁然开朗的窄处网格（narrows.js）
	corridors: [],        // 窄处和进场低空航线的走廊 [x, z, 半径]：树林让开
	guide: null,          // 引路的花瓣和光点（tsl/guide.js）
	ground: null,         // 地表贴图（tsl/terrain.js）；没读到是 null，地面用原来的程序化细节
	forestItems: [],      // 每棵树（远景树团和近处 3D 树共用）
	treeField: null,      // 近处的 3D 树（tsl/trees.js）
	treeView: { x: 0, z: - 1, halfAngle: Math.PI },   // 镜头视锥的水平投影（世界坐标），每帧算一次，近处的树按它挑
	windowAmounts: {},    // 地点 key → 那个地点替身窗灯的亮度倍数 uniform
	windowLists: {},      // 地点 key → 替身窗灯的窗户表（世界坐标，星月夜的窗灯笔触用）
};

const tempVector = new THREE.Vector3();
const tempMatrix = new THREE.Matrix4();
const cloudSunWarm = new THREE.Color( '#ff8a5c' );
const cloudSunWhite = new THREE.Color( '#fff2e0' );

// ===================== 山洞（规格书 5.1.1）=====================
// 洞壁：沿 world.cave 的中线每 0.5 米一圈截面（超椭圆，底是平的），岩块往洞里凸；两头洞口外围一圈半埋的石头。
// 高度场做不出山洞：地形穿过洞的那一截直接不画（caveCutout，地点自己的地形也调它），从外面看就是山上的一个口子。
// 洞里的光只从两头的口子进来：按离洞口的距离衰减，朝着洞口的壁亮一些；内口那头是秘境的晨光，略暖、略亮（"仿佛若有光"）

const caveRingSegments = 40;
const caveCutoutSegments = 16;
const caveLightFalloff = 7;      // 洞里的光每 7 米弱 e 倍：洞中间（35 米）只剩洞口的 0.7%，比外面暗两个多数量级
// 出口那头的光衰减得慢一些（16 米），再加一点洞里的底光：原来洞中段整屏是黑的，只剩引路的光点（2026-10-02 自查开场 57~62 秒）；
// 规格书 5.1.1 要"镜头擦着两壁前进，出口越来越亮"，洞壁要隐约看得见，往前越走越亮
const caveExitFalloff = 16;
const caveFloorLight = 0.012;

// 截面：angle 绕洞一圈；返回 [横向, 离地高度]（米）。超椭圆（指数 2.5）比椭圆方一点，像人工凿过又被水磨圆的洞；
// 中心在 0.45 × 高，下半截压平成地面
function caveSection( angle, width, height ) {

	const cosine = Math.cos( angle );
	const sine = Math.sin( angle );
	const lateral = width / 2 * Math.sign( cosine ) * Math.pow( Math.abs( cosine ), 0.8 );
	const up = Math.max( 0, height * 0.45 + height * 0.55 * Math.sign( sine ) * Math.pow( Math.abs( sine ), 0.8 ) );
	return [ lateral, up ];

}

function buildCaveGeometry( cave ) {

	const rings = cave.points.length;
	const count = rings * ( caveRingSegments + 1 );
	const positions = new Float32Array( count * 3 );
	const along = new Float32Array( count );
	const sample = {};
	const side = new THREE.Vector3();
	for ( let i = 0; i < rings; i ++ ) {

		const distance = i * cave.spacing;
		cave.at( distance, sample );
		side.set( - sample.tangent.z, 0, sample.tangent.x );
		for ( let j = 0; j <= caveRingSegments; j ++ ) {

			const angle = j / caveRingSegments * Math.PI * 2;
			const [ lateral, up ] = caveSection( angle, sample.width, sample.height );
			// 岩块往洞里凸：噪声坐标用 (cos, sin) 绕一圈是连续的；凸出量不超过宽的 11%（窄的地方镜头还要过得去），地面几乎不凸
			const ring = [ Math.cos( angle ) * 1.6, Math.sin( angle ) * 1.6 ];
			const bump = jsFbm2D( distance * 0.45 + ring[ 0 ], ring[ 1 ] + distance * 0.17, 4 );
			const floorAmount = up < 0.02 ? 0.15 : 1;
			const inward = Math.min( 0.3, sample.width * 0.11 ) * Math.max( 0, bump - 0.3 ) / 0.7 * floorAmount;
			const centerUp = sample.height * 0.45;
			const toCenterLateral = - lateral;
			const toCenterUp = centerUp - up;
			const toCenterLength = Math.hypot( toCenterLateral, toCenterUp ) || 1;
			const finalLateral = lateral + toCenterLateral / toCenterLength * inward;
			const finalUp = up < 0.02 ? up + inward * 0.3 : up + toCenterUp / toCenterLength * inward;
			const index = i * ( caveRingSegments + 1 ) + j;
			positions[ index * 3 ] = sample.position.x + side.x * finalLateral;
			positions[ index * 3 + 1 ] = sample.position.y + finalUp;
			positions[ index * 3 + 2 ] = sample.position.z + side.z * finalLateral;
			along[ index ] = distance;

		}

	}

	const indices = [];
	for ( let i = 0; i < rings - 1; i ++ ) {

		for ( let j = 0; j < caveRingSegments; j ++ ) {

			const a = i * ( caveRingSegments + 1 ) + j;
			const b = a + caveRingSegments + 1;
			indices.push( a, b, a + 1, a + 1, b, b + 1 );

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'caveAlong', new THREE.BufferAttribute( along, 1 ) );
	geometry.setIndex( indices );
	geometry.computeVertexNormals();
	// 正面朝洞里：拿中间一圈顶上那个点检查法线方向，朝外就把三角形绕序整个翻过来
	const probe = Math.floor( rings / 2 ) * ( caveRingSegments + 1 ) + Math.round( caveRingSegments / 4 );
	cave.at( Math.floor( rings / 2 ) * cave.spacing, sample );
	const normal = geometry.attributes.normal;
	const towardCenter = ( sample.position.y + sample.height * 0.45 ) - positions[ probe * 3 + 1 ];
	if ( normal.getY( probe ) * towardCenter < 0 ) {

		for ( let i = 0; i < indices.length; i += 3 ) {

			const swap = indices[ i + 1 ];
			indices[ i + 1 ] = indices[ i + 2 ];
			indices[ i + 2 ] = swap;

		}

		geometry.setIndex( indices );
		geometry.computeVertexNormals();

	}

	geometry.computeBoundingSphere();
	return geometry;

}

// 洞口外围的石头：一圈半埋的块石，盖住洞壁和山坡相接的地方
function buildCavePortalRocks( cave ) {

	const random = createRandom( 5170 );
	const parts = [];
	const sample = {};
	const side = new THREE.Vector3();
	for ( const end of [ 0, cave.length ] ) {

		cave.at( end, sample );
		side.set( - sample.tangent.z, 0, sample.tangent.x );
		const outward = end === 0 ? - 1 : 1;   // 沿切向往洞外的方向
		const rockCount = 9;
		for ( let k = 0; k < rockCount; k ++ ) {

			// 从一侧地面经过洞顶到另一侧地面（−15° ~ 195°），两侧贴地的石头大一些
			const angle = ( - 15 + 210 * ( k + 0.2 + random() * 0.6 ) / rockCount ) * degree;
			const [ lateral, up ] = caveSection( angle, sample.width, sample.height );
			const nearGround = 1 - Math.min( 1, up / sample.height );
			const radius = ( 0.35 + random() * 0.45 + nearGround * ( 0.5 + random() * 0.6 ) ) * 0.72;
			// 石头中心离洞口截面至少 0.85 个半径，不挡口子
			const centerUp = sample.height * 0.45;
			const offsetLateral = lateral;
			const offsetUp = up - centerUp;
			const offsetLength = Math.hypot( offsetLateral, offsetUp ) || 1;
			const push = radius * ( 0.85 + random() * 0.3 );
			const rockLateral = lateral + offsetLateral / offsetLength * push;
			const rockUp = up + offsetUp / offsetLength * push - nearGround * radius * 0.35;
			// 沿洞的方向：大半埋进崖里（往洞里那边），只露出口子边上的一截
			const rockAlong = - outward * ( 0.45 + random() * 0.5 ) * radius;
			const center = new THREE.Vector3(
				sample.position.x + side.x * rockLateral + sample.tangent.x * rockAlong,
				sample.position.y + rockUp,
				sample.position.z + side.z * rockLateral + sample.tangent.z * rockAlong,
			);
			parts.push( lumpyRock( center, radius, random ) );

		}

	}

	return mergeRockParts( parts );

}

// 一块不规则的石头：二十面体细分两次，按低频噪声压扁、鼓包
function lumpyRock( center, radius, random ) {

	// 细分一次、不合并顶点：每个三角形自己的法线，是一块块平的碎面
	const geometry = new THREE.IcosahedronGeometry( 1, 2 );
	geometry.deleteAttribute( 'uv' );
	const position = geometry.attributes.position;
	const seed = random() * 100;
	const squash = 0.6 + random() * 0.3;
	const yaw = random() * Math.PI * 2;
	const cosine = Math.cos( yaw );
	const sine = Math.sin( yaw );
	for ( let i = 0; i < position.count; i ++ ) {

		const x = position.getX( i );
		const y = position.getY( i );
		const z = position.getZ( i );
		const lump = 0.72 + 0.56 * jsFbm2D( x * 1.1 + seed, z * 1.1 + y * 0.8, 2 );
		const scaledX = x * lump * radius * 1.15;
		const scaledY = y * lump * radius * squash;
		const scaledZ = z * lump * radius;
		position.setXYZ( i, center.x + scaledX * cosine - scaledZ * sine, center.y + scaledY, center.z + scaledX * sine + scaledZ * cosine );

	}

	geometry.computeVertexNormals();
	geometry.setIndex( Array.from( { length: position.count }, ( value, index ) => index ) );
	return geometry;

}

function mergeRockParts( parts ) {

	let vertexCount = 0;
	let indexCount = 0;
	for ( const part of parts ) {

		vertexCount += part.attributes.position.count;
		indexCount += part.index.count;

	}

	const positions = new Float32Array( vertexCount * 3 );
	const normals = new Float32Array( vertexCount * 3 );
	const indices = new Uint32Array( indexCount );
	let vertexOffset = 0;
	let indexOffset = 0;
	for ( const part of parts ) {

		positions.set( part.attributes.position.array, vertexOffset * 3 );
		normals.set( part.attributes.normal.array, vertexOffset * 3 );
		for ( let i = 0; i < part.index.count; i ++ ) indices[ indexOffset + i ] = part.index.array[ i ] + vertexOffset;
		vertexOffset += part.attributes.position.count;
		indexOffset += part.index.count;
		part.dispose();

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
	geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );
	geometry.computeBoundingSphere();
	return geometry;

}

// 洞的体积：点在洞里返回 1（地形在这里挖掉）。中线按 16 段折线近似，截面和洞壁同一个超椭圆，外扩 6 厘米；
// 只在洞的包围盒里才逐段算（包围盒外一条比较就返回）
export function caveCutout( point ) {

	const uniforms = state.caveUniforms;
	if ( ! uniforms ) return float( 0 );
	return Fn( () => {

		const inside = float( 0 ).toVar();
		const inBox = point.x.greaterThan( uniforms.boxMin.x ).and( point.x.lessThan( uniforms.boxMax.x ) )
			.and( point.y.greaterThan( uniforms.boxMin.y ) ).and( point.y.lessThan( uniforms.boxMax.y ) )
			.and( point.z.greaterThan( uniforms.boxMin.z ) ).and( point.z.lessThan( uniforms.boxMax.z ) );
		If( inBox, () => {

			Loop( caveCutoutSegments, ( { i } ) => {

				const start = uniforms.points.element( i );
				const end = uniforms.points.element( i.add( 1 ) );
				const startSize = uniforms.sizes.element( i );
				const endSize = uniforms.sizes.element( i.add( 1 ) );
				const span = end.xz.sub( start.xz );
				const amount = dot( point.xz.sub( start.xz ), span ).div( max( dot( span, span ), 1e-4 ) );
				const within = amount.greaterThanEqual( - 0.02 ).and( amount.lessThanEqual( 1.02 ) );
				const t = amount.clamp( 0, 1 );
				const lateral = length( point.xz.sub( start.xz.add( span.mul( t ) ) ) );
				const floorY = mix( start.y, end.y, t );
				const size = mix( startSize, endSize, t );
				const halfWidth = size.x.mul( 0.5 ).add( 0.06 );
				const centerY = floorY.add( size.y.mul( 0.45 ) );
				const radiusY = size.y.mul( 0.55 ).add( 0.06 );
				const shape = pow( lateral.div( halfWidth ).clamp( 0, 4 ), 2.5 ).add( pow( abs( point.y.sub( centerY ) ).div( radiusY ).clamp( 0, 4 ), 2.5 ) );
				If( within.and( shape.lessThan( 1 ) ).and( point.y.greaterThan( floorY.sub( 0.05 ) ) ), () => {

					inside.assign( 1 );

				} );

			} );

		} );
		return inside;

	} )();

}

function createCaveUniforms( cave ) {

	const points = [];
	const sizes = [];
	const sample = {};
	const boxMin = new THREE.Vector3( Infinity, Infinity, Infinity );
	const boxMax = new THREE.Vector3( - Infinity, - Infinity, - Infinity );
	for ( let i = 0; i <= caveCutoutSegments; i ++ ) {

		cave.at( cave.length * i / caveCutoutSegments, sample );
		points.push( new THREE.Vector4( sample.position.x, sample.position.y, sample.position.z, 0 ) );
		sizes.push( new THREE.Vector2( sample.width, sample.height ) );
		const reach = sample.width / 2 + 0.5;
		boxMin.min( tempVector.set( sample.position.x - reach, sample.position.y - 0.5, sample.position.z - reach ) );
		boxMax.max( tempVector.set( sample.position.x + reach, sample.position.y + sample.height + 0.5, sample.position.z + reach ) );

	}

	// 两个洞口截面的中心（洞里的光从这两个点进来）
	const outerMouth = cave.at( 0, {} );
	const innerMouth = cave.at( cave.length, {} );
	return {
		points: uniformArray( points, 'vec4' ),
		sizes: uniformArray( sizes, 'vec2' ),
		boxMin: uniform( boxMin ),
		boxMax: uniform( boxMax ),
		outerMouth: uniform( outerMouth.position.clone().add( new THREE.Vector3( 0, outerMouth.height * 0.5, 0 ) ) ),
		innerMouth: uniform( innerMouth.position.clone().add( new THREE.Vector3( 0, innerMouth.height * 0.5, 0 ) ) ),
		length: uniform( cave.length ),
		innerWarmth: uniform( new THREE.Color( '#ffe2c8' ) ),
	};

}

// 岩石反照率：灰褐，按两层噪声起伏；洞口附近长一点青苔
function caveRockAlbedo( point, normal, mossAmount ) {

	// 三向投影：按法线三个轴向加权，石头的侧面、洞壁不会拉成条
	const weights = pow( abs( normal ), vec3( 4 ) );
	const weightSum = weights.x.add( weights.y ).add( weights.z );
	const triplanar = ( layerName, scale, channel ) => noiseAt( layerName, point.zy.mul( scale ) )[ channel ].mul( weights.x )
		.add( noiseAt( layerName, point.xz.mul( scale ) )[ channel ].mul( weights.y ) )
		.add( noiseAt( layerName, point.xy.mul( scale ) )[ channel ].mul( weights.z ) ).div( weightSum );
	const patch = triplanar( 'small', 6, 'r' );
	const grain = triplanar( 'rippleFine', 5, 'g' );
	// 石缝：噪声 0.5 那条等值线，再按另一层噪声断成一截一截（审查 R27：原来是连着的细黑线，洞壁像带卡通描线的光滑管子）
	const crackBreak = smoothstep( 0.5, 0.7, triplanar( 'small', 2.7, 'g' ) );
	const crack = float( 1 ).sub( smoothstep( 0, 0.03, abs( triplanar( 'rippleFine', 2.2, 'r' ).sub( 0.5 ) ) ) ).mul( crackBreak ).mul( 0.22 );
	// 明暗斑块对比加大一点（湿的地方暗、干的地方浅），岩面不是一整片均匀的米色
	const rock = mix( color( '#4a4743' ), color( '#8a847c' ), smoothstep( 0.2, 0.8, patch ) ).mul( grain.mul( 0.4 ).add( 0.78 ) ).mul( float( 1 ).sub( crack ) );
	const moss = mix( color( '#3f4a33' ), color( '#56603f' ), grain );
	const mossCover = smoothstep( 0.55, 0.9, normal.y.add( patch.mul( 0.3 ) ) ).mul( mossAmount ).mul( 0.7 );
	return mix( rock, moss, mossCover );

}

function createCaveWallMaterial() {

	const sky = state.world.uniforms;
	const caveUniforms = state.caveUniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '山洞洞壁';
	material.fog = false;
	material.lights = false;
	material.side = THREE.DoubleSide;
	material.positionNode = compressedPosition( positionLocal );

	material.colorNode = Fn( () => {

		const point = positionGeometry;
		const along = attribute( 'caveAlong', 'float' );
		const normal = normalize( normalGeometry ).toVar();
		const fromInner = caveUniforms.length.sub( along );
		const albedo = nightAlbedo( caveRockAlbedo( point, normal, max( fadeOut( 1, 5, along ), fadeOut( 1, 6, fromInner ) ) ) );

		// 洞口外的天光（天空半球平均色）+ 太阳出来以后的直射散进来的一点
		const skyAmbient = mix( sky.horizonColor, sky.zenithColor, 0.5 ).mul( sky.skyIntensity ).add( sky.sunLightColor.mul( max( sky.sunDirection.y, 0 ).mul( 0.25 ) ) );
		const towardOuter = normalize( caveUniforms.outerMouth.sub( point ) );
		const towardInner = normalize( caveUniforms.innerMouth.sub( point ) );
		const outerLight = exp( along.div( - caveLightFalloff ) ).mul( max( dot( normal, towardOuter ), 0 ).mul( 0.6 ).add( 0.4 ) );
		const innerLight = exp( fromInner.div( - caveExitFalloff ) ).mul( max( dot( normal, towardInner ), 0 ).mul( 0.6 ).add( 0.4 ) ).mul( 1.3 );
		// 外口里那团暖光（见 buildCaveGlows）照亮口子里头几米的洞壁，从溪上看洞口里是暖的
		const mouthWarm = color( '#ffc98f' ).mul( state.ctx.config.overture.mouthGlow * 0.4 ).mul( exp( abs( along.sub( 4 ) ).div( - 2.5 ) ) );
		const light = skyAmbient.mul( outerLight.add( innerLight.mul( caveUniforms.innerWarmth ) ).add( caveFloorLight ) ).add( mouthWarm ).mul( state.toggles.山洞.mul( 0.98 ).add( 0.02 ) );
		const surface = albedo.mul( light );
		// 洞壁外面那一面（从洞口和山坡的缝里偶尔看得到）：暗岩
		const outside = albedo.mul( skyAmbient ).mul( 0.05 );
		return applyAtmosphere( select( frontFacing, surface, outside ), point, viewerPosition() );

	} )();

	return material;

}

function createCaveRockMaterial() {

	const sky = state.world.uniforms;
	const uniforms = state.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '山洞口石头';
	material.fog = false;
	material.lights = false;
	material.positionNode = compressedPosition( positionLocal );

	material.colorNode = Fn( () => {

		const point = positionGeometry;
		const normal = normalize( normalGeometry );
		// 比洞壁暗一些、苔多一些，和开场崖面的深色岩石接得上（不像几块浅色卵石粘在洞口）
		const albedo = nightAlbedo( caveRockAlbedo( point, normal, float( 1.3 ) ).mul( 0.62 ) );
		const sunShadow = terrainShadow( point, uniforms.sunHorizon, sky.sunElevation, 1.3 );
		const moonShadow = terrainShadow( point, uniforms.moonHorizon, sky.moonElevation, 3 );
		const surface = albedo.mul( lightAt( normal, sunShadow, moonShadow, float( 0.8 ), 0.3 ) );
		return applyAtmosphere( surface, point, viewerPosition() );

	} )();

	return material;

}

// 洞口的光（"仿佛若有光"）：外口往里 4 米一张朝外的发光片，从溪上看，黑黑的洞口里透出一点暖光；
// 内口往外 1 米一张朝里的发光片，在洞里往前看，出口一圈有空气里散开的光晕（单面，从外面看不到）。
// 亮度跟着天光走，加法混合、不写深度
function buildCaveGlows( cave ) {

	const sky = state.world.uniforms;
	const parts = [];
	for ( const [ distance, facingOut, size ] of [ [ 4, true, 2.4 ], [ cave.length + 1, false, 12 ] ] ) {

		const sample = cave.at( Math.min( cave.length, distance ), {} );
		const geometry = new THREE.PlaneGeometry( size, size );
		const material = new THREE.MeshBasicNodeMaterial();
		material.name = facingOut ? '洞口的光（外）' : '洞口的光（内）';
		material.transparent = true;
		material.depthWrite = false;
		material.blending = THREE.AdditiveBlending;
		material.fog = false;
		material.lights = false;
		material.positionNode = compressedPosition( positionLocal );
		const strength = facingOut ? 0.16 : 1.2;
		// 外口（只在开场从溪上看得到）：天光之外再加一团不跟天色走的暖光，黎明前天还暗，洞里那点光要看得出来，靠泛光晕开
		const warmth = facingOut ? state.ctx.config.overture.mouthGlow : 0;
		material.colorNode = Fn( () => {

			const uv = attribute( 'uv', 'vec2' ).sub( 0.5 ).mul( 2 );
			const falloff = pow( max( float( 1 ).sub( length( uv ) ), 0 ), 2.2 );
			const skyLight = mix( sky.horizonColor, sky.zenithColor, 0.4 ).mul( sky.skyIntensity ).add( sky.sunLightColor.mul( max( sky.sunDirection.y, 0 ).mul( 0.3 ) ) );
			const glow = skyLight.mul( color( '#ffe6cf' ) ).mul( strength ).add( color( '#ffc98f' ).mul( warmth ) );
			return vec4( glow.mul( falloff ).mul( state.toggles.山洞 ), 1 );

		} )();
		const mesh = new THREE.Mesh( geometry, material );
		mesh.name = material.name;
		mesh.frustumCulled = false;
		mesh.renderOrder = 20;
		const center = sample.position.clone().add( new THREE.Vector3( 0, sample.height * 0.48, 0 ) );
		if ( distance > cave.length ) center.addScaledVector( sample.tangent, distance - cave.length );
		mesh.position.copy( center );
		// 平面的正面是 +z，两张都朝 −切向：外口那张朝洞外，内口外面那张朝洞里
		mesh.lookAt( center.clone().addScaledVector( sample.tangent, - 1 ) );
		state.disposables.push( geometry, material );
		parts.push( mesh );

	}

	return parts;

}

function buildCave( world ) {

	const cave = world.cave;
	state.caveUniforms = createCaveUniforms( cave );
	const wallGeometry = buildCaveGeometry( cave );
	const rockGeometry = buildCavePortalRocks( cave );
	const wallMaterial = createCaveWallMaterial();
	const rockMaterial = createCaveRockMaterial();
	const wall = new THREE.Mesh( wallGeometry, wallMaterial );
	wall.name = '山洞';
	wall.frustumCulled = false;
	const rocks = new THREE.Mesh( rockGeometry, rockMaterial );
	rocks.name = '山洞口石头';
	rocks.frustumCulled = false;
	state.disposables.push( wallGeometry, rockGeometry, wallMaterial, rockMaterial );
	return [ wall, rocks, ...buildCaveGlows( cave ) ];

}

// ===================== 世界采样：规则网格 =====================

// 一块规则网格的世界采样：显示高度（湖、海压平到水面）、有符号海水深（海里正、岸上负，插值后 0 那条线就是海岸线）、离海多近、台地程度。
// 湖不按顶点画（12.5 米一段的折线太硬），湖的水边写在 4 米一个像素的地表图里，和河一样
async function sampleGrid( world, minX, minZ, countX, countZ, spacing, slice ) {

	const total = countX * countZ;
	const heights = new Float32Array( total );
	const depths = new Float32Array( total ).fill( - 8 );
	const seaFlags = new Uint8Array( total );
	const plateau = new Float32Array( total );

	for ( let j = 0; j < countZ; j ++ ) {

		const z = minZ + j * spacing;
		for ( let i = 0; i < countX; i ++ ) {

			const index = j * countX + i;
			const sample = world.sample( minX + i * spacing, z );
			plateau[ index ] = sample.plateau;
			if ( sample.waterKind === 'sea' ) {

				heights[ index ] = sample.waterLevel;
				depths[ index ] = Math.max( 0.05, sample.waterLevel - sample.height );
				seaFlags[ index ] = 1;

			} else if ( sample.waterKind === 'lake' ) {

				// 湖面压平到水位；水深记成 -0.05（不算顶点上的水，水边由地表图画）
				heights[ index ] = sample.waterLevel;
				depths[ index ] = - 0.05;

			} else {

				heights[ index ] = sample.height;

			}

		}

		await yieldIfBusy( slice );

	}

	// 岸上挨着海的点：水深 = 0 − 地面高度（负数），插值出来的海岸线落在对的位置
	for ( let j = 0; j < countZ; j ++ ) {

		for ( let i = 0; i < countX; i ++ ) {

			const index = j * countX + i;
			if ( seaFlags[ index ] ) continue;
			let besideSea = false;
			for ( let offsetZ = - 1; offsetZ <= 1; offsetZ ++ ) {

				for ( let offsetX = - 1; offsetX <= 1; offsetX ++ ) {

					const neighborX = i + offsetX;
					const neighborZ = j + offsetZ;
					if ( neighborX < 0 || neighborZ < 0 || neighborX >= countX || neighborZ >= countZ ) continue;
					if ( seaFlags[ neighborZ * countX + neighborX ] ) besideSea = true;

				}

			}

			if ( besideSea ) depths[ index ] = Math.min( - 0.05, - heights[ index ] );

		}

	}

	// 离海多近：从海里的点往外做两遍倒角距离变换（格子数），75 米以内渐变，沙滩用
	const seaDistance = new Float32Array( total );
	for ( let index = 0; index < total; index ++ ) seaDistance[ index ] = seaFlags[ index ] ? 0 : 99;
	for ( let j = 0; j < countZ; j ++ ) {

		for ( let i = 0; i < countX; i ++ ) {

			const index = j * countX + i;
			if ( i > 0 ) seaDistance[ index ] = Math.min( seaDistance[ index ], seaDistance[ index - 1 ] + 1 );
			if ( j > 0 ) seaDistance[ index ] = Math.min( seaDistance[ index ], seaDistance[ index - countX ] + 1 );

		}

	}

	for ( let j = countZ - 1; j >= 0; j -- ) {

		for ( let i = countX - 1; i >= 0; i -- ) {

			const index = j * countX + i;
			if ( i < countX - 1 ) seaDistance[ index ] = Math.min( seaDistance[ index ], seaDistance[ index + 1 ] + 1 );
			if ( j < countZ - 1 ) seaDistance[ index ] = Math.min( seaDistance[ index ], seaDistance[ index + countX ] + 1 );

		}

	}

	const cellsToBeach = Math.max( 1, 75 / spacing );
	const seaProximity = new Float32Array( total );
	for ( let index = 0; index < total; index ++ ) seaProximity[ index ] = Math.max( 0, 1 - seaDistance[ index ] / cellsToBeach );

	return { minX, minZ, countX, countZ, spacing, sizeX: ( countX - 1 ) * spacing, sizeZ: ( countZ - 1 ) * spacing, heights, depths, seaProximity, plateau };

}

// 核心区四条边上的高度改成"外圈那一段直线"上的值：外圈 75 米一段，核心区 12.5 米一段，
// 不改的话两块网格的边一高一低，从里往外看能透过缝看到天。改完两条边完全重合（核心区离各地点都在 1 公里以上，边上粗一点看不出来）
function matchCoreEdges( grid, outerSpacing ) {

	const step = Math.round( outerSpacing / grid.spacing );
	if ( step <= 1 ) return;
	const { countX, countZ, heights } = grid;
	const matchLine = ( count, indexAt ) => {

		for ( let k = 0; k < count; k ++ ) {

			const startStep = Math.floor( k / step ) * step;
			const endStep = Math.min( startStep + step, count - 1 );
			if ( k === startStep || endStep === startStep ) continue;
			const amount = ( k - startStep ) / ( endStep - startStep );
			heights[ indexAt( k ) ] = heights[ indexAt( startStep ) ] + ( heights[ indexAt( endStep ) ] - heights[ indexAt( startStep ) ] ) * amount;

		}

	};

	matchLine( countX, ( k ) => k );
	matchLine( countX, ( k ) => ( countZ - 1 ) * countX + k );
	matchLine( countZ, ( k ) => k * countX );
	matchLine( countZ, ( k ) => k * countX + countX - 1 );

}

// 网格上的高度，按三角形插值（和 buildGridGeometry 的对角线一样：从 (i, j+1) 连到 (i+1, j)），
// 就是网格真正画出来的那个面；地点自己的地形要贴着它接缝，差几厘米都会闪。出了网格返回 NaN
function gridHeight( grid, x, z ) {

	const cellX = ( x - grid.minX ) / grid.spacing;
	const cellZ = ( z - grid.minZ ) / grid.spacing;
	if ( cellX < 0 || cellZ < 0 || cellX > grid.countX - 1 || cellZ > grid.countZ - 1 ) return NaN;
	const i = Math.min( grid.countX - 2, Math.floor( cellX ) );
	const j = Math.min( grid.countZ - 2, Math.floor( cellZ ) );
	const fractionX = cellX - i;
	const fractionZ = cellZ - j;
	const index = j * grid.countX + i;
	const heights = grid.heights;
	const near = heights[ index ];
	const nearRight = heights[ index + 1 ];
	const far = heights[ index + grid.countX ];
	const farRight = heights[ index + grid.countX + 1 ];
	if ( fractionX + fractionZ <= 1 ) return near + ( nearRight - near ) * fractionX + ( far - near ) * fractionZ;
	return farRight + ( far - farRight ) * ( 1 - fractionX ) + ( nearRight - farRight ) * ( 1 - fractionZ );

}

// 网格上别的逐点数据（水深、离海多近、台地），插值方法和 gridHeight 一样
function gridValue( grid, values, x, z ) {

	const cellX = ( x - grid.minX ) / grid.spacing;
	const cellZ = ( z - grid.minZ ) / grid.spacing;
	if ( cellX < 0 || cellZ < 0 || cellX > grid.countX - 1 || cellZ > grid.countZ - 1 ) return NaN;
	const i = Math.min( grid.countX - 2, Math.floor( cellX ) );
	const j = Math.min( grid.countZ - 2, Math.floor( cellZ ) );
	const fractionX = cellX - i;
	const fractionZ = cellZ - j;
	const index = j * grid.countX + i;
	const near = values[ index ];
	const nearRight = values[ index + 1 ];
	const far = values[ index + grid.countX ];
	const farRight = values[ index + grid.countX + 1 ];
	if ( fractionX + fractionZ <= 1 ) return near + ( nearRight - near ) * fractionX + ( far - near ) * fractionZ;
	return farRight + ( far - farRight ) * ( 1 - fractionX ) + ( nearRight - farRight ) * ( 1 - fractionZ );

}

// 远景地形的高度（就是网格画出来的高度）：窄处的地形补丁里按补丁，核心区用细网格，外圈用粗网格，再往外当海平面
function terrainHeightAt( x, z ) {

	for ( const patch of state.patches ) {

		const height = patchHeightAt( patch, x, z );
		if ( height !== null ) return height;

	}

	const fine = gridHeight( state.core, x, z );
	if ( ! Number.isNaN( fine ) ) return fine;
	const coarse = gridHeight( state.outer, x, z );
	return Number.isNaN( coarse ) ? 0 : coarse;

}

// 网格法线：中心差分
function gridNormal( grid, i, j, target ) {

	const left = grid.heights[ j * grid.countX + Math.max( 0, i - 1 ) ];
	const right = grid.heights[ j * grid.countX + Math.min( grid.countX - 1, i + 1 ) ];
	const down = grid.heights[ Math.max( 0, j - 1 ) * grid.countX + i ];
	const up = grid.heights[ Math.min( grid.countZ - 1, j + 1 ) * grid.countX + i ];
	const spanX = ( Math.min( grid.countX - 1, i + 1 ) - Math.max( 0, i - 1 ) ) * grid.spacing;
	const spanZ = ( Math.min( grid.countZ - 1, j + 1 ) - Math.max( 0, j - 1 ) ) * grid.spacing;
	return target.set( ( left - right ) / spanX, 1, ( down - up ) / spanZ ).normalize();

}

// 把网格做成几何体。skirt：四边往下拉一圈裙边（米），挡住和外圈之间可能剩下的细缝；
// hole：外圈网格用，四个角都在这个矩形里的格子不画（外圈的格子线和核心区的边对齐，没有跨在边上的格子）
function buildGridGeometry( grid, { skirt = 0, hole = null } = {} ) {

	const { countX, countZ, minX, minZ, spacing } = grid;
	const positions = [];
	const normals = [];
	const terrainInfo = [];
	const normal = new THREE.Vector3();
	const insideHole = ( x, z ) => hole && x >= hole.minX && x <= hole.maxX && z >= hole.minZ && z <= hole.maxZ;

	for ( let j = 0; j < countZ; j ++ ) {

		for ( let i = 0; i < countX; i ++ ) {

			const index = j * countX + i;
			positions.push( minX + i * spacing, grid.heights[ index ], minZ + j * spacing );
			gridNormal( grid, i, j, normal );
			normals.push( normal.x, normal.y, normal.z );
			terrainInfo.push( grid.depths[ index ], grid.seaProximity[ index ], grid.plateau[ index ] );

		}

	}

	const indices = [];
	for ( let j = 0; j < countZ - 1; j ++ ) {

		for ( let i = 0; i < countX - 1; i ++ ) {

			const cellStartX = minX + i * spacing;
			const cellStartZ = minZ + j * spacing;
			if ( insideHole( cellStartX, cellStartZ ) && insideHole( cellStartX + spacing, cellStartZ ) && insideHole( cellStartX, cellStartZ + spacing ) && insideHole( cellStartX + spacing, cellStartZ + spacing ) ) continue;
			const cornerNear = j * countX + i;
			const cornerNearRight = cornerNear + 1;
			const cornerFar = cornerNear + countX;
			const cornerFarRight = cornerFar + 1;
			indices.push( cornerNear, cornerFar, cornerNearRight, cornerNearRight, cornerFar, cornerFarRight );

		}

	}

	if ( skirt > 0 ) {

		// 沿边界走一圈，每个边界点复制一个往下 skirt 米的点，相邻两对点连成竖直的条带
		const border = [];
		for ( let i = 0; i < countX; i ++ ) border.push( i );
		for ( let j = 1; j < countZ; j ++ ) border.push( j * countX + countX - 1 );
		for ( let i = countX - 2; i >= 0; i -- ) border.push( ( countZ - 1 ) * countX + i );
		for ( let j = countZ - 2; j >= 0; j -- ) border.push( j * countX );

		const firstSkirt = positions.length / 3;
		for ( const index of border ) {

			positions.push( positions[ index * 3 ], positions[ index * 3 + 1 ] - skirt, positions[ index * 3 + 2 ] );
			normals.push( normals[ index * 3 ], normals[ index * 3 + 1 ], normals[ index * 3 + 2 ] );
			terrainInfo.push( terrainInfo[ index * 3 ], terrainInfo[ index * 3 + 1 ], terrainInfo[ index * 3 + 2 ] );

		}

		for ( let k = 0; k < border.length - 1; k ++ ) {

			const topFirst = border[ k ];
			const topSecond = border[ k + 1 ];
			const bottomFirst = firstSkirt + k;
			const bottomSecond = firstSkirt + k + 1;
			// 两面都画：裙边只是挡缝，朝哪边都行
			indices.push( topFirst, bottomFirst, topSecond, topSecond, bottomFirst, bottomSecond );
			indices.push( topFirst, topSecond, bottomFirst, topSecond, bottomSecond, bottomFirst );

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
	// x 有符号海水深，y 离海多近（沙滩），z 在雪原台地上的程度
	geometry.setAttribute( 'terrainInfo', new THREE.Float32BufferAttribute( terrainInfo, 3 ) );
	// −1：远景网格本身（窄处的地形补丁里要丢掉）；补丁的顶点是 0~1（接回远景的程度）
	geometry.setAttribute( 'patchBlend', new THREE.Float32BufferAttribute( new Float32Array( positions.length / 3 ).fill( - 1 ), 1 ) );
	geometry.setIndex( positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute( indices, 1 ) : new THREE.Uint16BufferAttribute( indices, 1 ) );
	geometry.computeBoundingSphere();
	return geometry;

}

// ===================== 窄处的地形补丁（阶段 12 CP3 返工）=====================
// 远景网格 8 米一格，画不出窄处 10 米宽的口子、陡壁和岩坎（会被抹成一道软 V）。窄处的 frame 带 patch 时，沿窄处中线铺一块
// 0.6 米一格（中档 0.9、低档 1.2）的细网格：里面按解析地形（world.sampleAnalytic，岩丘和口子都在里面，烘焙时这一块不侵蚀，
// 解析和烘焙一致）取高度，边上 blend 米内慢慢接回远景网格画出来的高度。远景网格在补丁里逐像素丢掉（用同一个地形材质，
// 补丁的顶点 patchBlend ≥ 0 不丢）；补丁比丢掉的范围每边多出 overlap 米、压低 5 厘米藏在远景网格下面，接缝处不会透出天
function patchFootprints( worldConfig ) {

	const result = [];
	for ( const leg of worldConfig.legs ) {

		const frame = leg.frame;
		if ( ! frame || ! frame.patch || ! Array.isArray( frame.path ) || frame.path.length < 2 ) continue;
		const first = frame.path[ 0 ];
		const last = frame.path[ frame.path.length - 1 ];
		const length = Math.hypot( last[ 0 ] - first[ 0 ], last[ 2 ] - first[ 2 ] );
		if ( length < 1 ) {

			console.warn( `窄处「${ frame.name }」的地形补丁：中线太短，不建补丁` );
			continue;

		}

		const axisX = ( last[ 0 ] - first[ 0 ] ) / length;
		const axisZ = ( last[ 2 ] - first[ 2 ] ) / length;
		const [ before, after ] = frame.patch.extend;
		const centerAlong = ( length + after - before ) / 2;
		result.push( {
			name: frame.name,
			settings: frame.patch,
			centerX: first[ 0 ] + axisX * centerAlong,
			centerZ: first[ 2 ] + axisZ * centerAlong,
			axisX,
			axisZ,
			halfLength: ( length + before + after ) / 2,
			halfWidth: frame.patch.halfWidth,
			overlap: frame.patch.overlap,
		} );

	}

	// 不在窄处的补丁（terrainShape.patches：哥特岩台的崖面……）
	for ( const patch of worldConfig.terrainShape.patches || [] ) {

		const length = Math.hypot( patch.to[ 0 ] - patch.from[ 0 ], patch.to[ 1 ] - patch.from[ 1 ] );
		if ( length < 1 ) {

			console.warn( `地形补丁「${ patch.name }」：长轴太短，不建` );
			continue;

		}

		result.push( {
			name: patch.name,
			settings: patch,
			centerX: ( patch.from[ 0 ] + patch.to[ 0 ] ) / 2,
			centerZ: ( patch.from[ 1 ] + patch.to[ 1 ] ) / 2,
			axisX: ( patch.to[ 0 ] - patch.from[ 0 ] ) / length,
			axisZ: ( patch.to[ 1 ] - patch.from[ 1 ] ) / length,
			halfLength: length / 2,
			halfWidth: patch.halfWidth,
			overlap: patch.overlap,
		} );

	}

	return result;

}

// 世界 (x, z) 在补丁里的坐标：沿轴 along、横向 across（往轴的右手边为正，和补丁网格的 j 方向一致）
function patchCoordinates( patch, x, z ) {

	const offsetX = x - patch.centerX;
	const offsetZ = z - patch.centerZ;
	return [ offsetX * patch.axisX + offsetZ * patch.axisZ, - offsetX * patch.axisZ + offsetZ * patch.axisX ];

}

// 补丁画出来的高度（三角形插值，对角线和几何体一样）；不在丢掉远景的那块范围里返回 null
function patchHeightAt( patch, x, z ) {

	if ( ! patch.heights ) return null;
	const [ along, across ] = patchCoordinates( patch, x, z );
	if ( Math.abs( along ) > patch.halfLength - patch.overlap || Math.abs( across ) > patch.halfWidth - patch.overlap ) return null;
	const cellA = ( along + patch.halfLength ) / patch.spacingA;
	const cellC = ( across + patch.halfWidth ) / patch.spacingC;
	const i = Math.min( patch.countA - 2, Math.max( 0, Math.floor( cellA ) ) );
	const j = Math.min( patch.countC - 2, Math.max( 0, Math.floor( cellC ) ) );
	const fractionA = cellA - i;
	const fractionC = cellC - j;
	const index = j * patch.countA + i;
	const heights = patch.heights;
	const near = heights[ index ];
	const nearRight = heights[ index + 1 ];
	const far = heights[ index + patch.countA ];
	const farRight = heights[ index + patch.countA + 1 ];
	if ( fractionA + fractionC <= 1 ) return near + ( nearRight - near ) * fractionA + ( far - near ) * fractionC;
	return farRight + ( far - farRight ) * ( 1 - fractionA ) + ( nearRight - farRight ) * ( 1 - fractionC );

}

// 建补丁的几何体（世界坐标，属性和远景网格一样：position、normal、terrainInfo、patchBlend）；高度存进 patch 给 terrainHeightAt 用
async function buildTerrainPatch( patch, tier, world, slice ) {

	const settings = patch.settings;
	const spacing = settings.spacing[ tier ] || settings.spacing.mid;
	const countA = Math.ceil( patch.halfLength * 2 / spacing ) + 1;
	const countC = Math.ceil( patch.halfWidth * 2 / spacing ) + 1;
	const spacingA = patch.halfLength * 2 / ( countA - 1 );
	const spacingC = patch.halfWidth * 2 / ( countC - 1 );
	const total = countA * countC;
	const heights = new Float32Array( total );
	const positions = new Float32Array( total * 3 );
	const terrainInfo = new Float32Array( total * 3 );
	const blends = new Float32Array( total );
	const core = state.core;
	const started = performance.now();
	for ( let j = 0; j < countC; j ++ ) {

		const across = - patch.halfWidth + j * spacingC;
		for ( let i = 0; i < countA; i ++ ) {

			const along = - patch.halfLength + i * spacingA;
			const x = patch.centerX + patch.axisX * along - patch.axisZ * across;
			const z = patch.centerZ + patch.axisZ * along + patch.axisX * across;
			const edge = Math.min( patch.halfLength - Math.abs( along ), patch.halfWidth - Math.abs( across ) );
			const blend = smoothJs( patch.overlap, patch.overlap + settings.blend, edge );
			let coarse = gridHeight( core, x, z );
			let fine = coarse;
			if ( blend > 0 || ! Number.isFinite( coarse ) ) {

				const sample = world.sampleAnalytic( x, z );
				fine = sample.waterKind === 'sea' || sample.waterKind === 'lake' ? Math.max( sample.height, sample.waterLevel ) : sample.height;
				if ( ! Number.isFinite( coarse ) ) coarse = fine;

			}

			const index = j * countA + i;
			const height = coarse - 0.05 + ( fine - coarse + 0.05 ) * blend;
			heights[ index ] = height;
			blends[ index ] = blend;
			positions[ index * 3 ] = x;
			positions[ index * 3 + 1 ] = height;
			positions[ index * 3 + 2 ] = z;
			const depth = gridValue( core, core.depths, x, z );
			terrainInfo[ index * 3 ] = Number.isFinite( depth ) ? depth : - 8;
			terrainInfo[ index * 3 + 1 ] = gridValue( core, core.seaProximity, x, z ) || 0;
			terrainInfo[ index * 3 + 2 ] = gridValue( core, core.plateau, x, z ) || 0;

		}

		await yieldIfBusy( slice );

	}

	// 法线：补丁网格上中心差分（沿轴、横向两个斜率），再换到世界的 x、z
	const normals = new Float32Array( total * 3 );
	for ( let j = 0; j < countC; j ++ ) {

		for ( let i = 0; i < countA; i ++ ) {

			const left = heights[ j * countA + Math.max( 0, i - 1 ) ];
			const right = heights[ j * countA + Math.min( countA - 1, i + 1 ) ];
			const down = heights[ Math.max( 0, j - 1 ) * countA + i ];
			const up = heights[ Math.min( countC - 1, j + 1 ) * countA + i ];
			const slopeAlong = ( right - left ) / ( ( Math.min( countA - 1, i + 1 ) - Math.max( 0, i - 1 ) ) * spacingA );
			const slopeAcross = ( up - down ) / ( ( Math.min( countC - 1, j + 1 ) - Math.max( 0, j - 1 ) ) * spacingC );
			const slopeX = slopeAlong * patch.axisX - slopeAcross * patch.axisZ;
			const slopeZ = slopeAlong * patch.axisZ + slopeAcross * patch.axisX;
			const length = Math.hypot( slopeX, 1, slopeZ );
			const index = ( j * countA + i ) * 3;
			normals[ index ] = - slopeX / length;
			normals[ index + 1 ] = 1 / length;
			normals[ index + 2 ] = - slopeZ / length;

		}

	}

	// 三角形：对角线从 (i, j+1) 连到 (i+1, j)，和远景网格一样（沿轴当 x、横向当 z，横向是轴的右手边，三角形朝上）
	const indices = new Uint32Array( ( countA - 1 ) * ( countC - 1 ) * 6 );
	let cursor = 0;
	for ( let j = 0; j < countC - 1; j ++ ) {

		for ( let i = 0; i < countA - 1; i ++ ) {

			const near = j * countA + i;
			const far = near + countA;
			indices[ cursor ++ ] = near;
			indices[ cursor ++ ] = far;
			indices[ cursor ++ ] = near + 1;
			indices[ cursor ++ ] = near + 1;
			indices[ cursor ++ ] = far;
			indices[ cursor ++ ] = far + 1;

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'terrainInfo', new THREE.BufferAttribute( terrainInfo, 3 ) );
	geometry.setAttribute( 'patchBlend', new THREE.BufferAttribute( blends, 1 ) );
	geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );
	geometry.computeBoundingSphere();
	Object.assign( patch, { countA, countC, spacingA, spacingC, heights } );
	console.log( `地形补丁「${ patch.name }」：${ countA }×${ countC } 个点（${ spacing } 米一格），取解析高度用了 ${ ( performance.now() - started ).toFixed( 0 ) } 毫秒` );
	return geometry;

}

// ===================== 地平线图（地形阴影 + 天光遮蔽）=====================
// 每个格点朝 16 个方位各看出去，记下山挡住的最高仰角（Max 1988 的地平线贴图）。
// 着色时按太阳 / 月亮的方位在相邻两个方位之间插值，太阳仰角低于这个角度就在山的影子里；
// 16 个方位平均能看到多少天（cos² 加权），就是山谷里的天光遮蔽。
const horizonDirections = 16;
const horizonMinAngle = - 10;   // 编码范围（度）：-10 ~ 50，8 位精度约 0.24°
const horizonRange = 60;

async function buildHorizonMap( worldConfig, slice ) {

	const core = state.core;
	const spacing = worldConfig.horizonSpacing;
	const countX = Math.floor( core.sizeX / spacing ) + 1;
	const countZ = Math.floor( core.sizeZ / spacing ) + 1;
	const width = countX * ( horizonDirections / 4 );
	const data = new Uint8Array( width * countZ * 4 );
	const visibility = new Float32Array( countX * countZ );

	let maxTerrain = 0;
	for ( const value of core.heights ) maxTerrain = Math.max( maxTerrain, value );
	for ( const value of state.outer.heights ) maxTerrain = Math.max( maxTerrain, value );

	const directionX = [];
	const directionZ = [];
	for ( let k = 0; k < horizonDirections; k ++ ) {

		const azimuth = k * 360 / horizonDirections * degree;
		directionX.push( Math.sin( azimuth ) );
		directionZ.push( - Math.cos( azimuth ) );

	}

	for ( let j = 0; j < countZ; j ++ ) {

		const z = core.minZ + j * spacing;
		for ( let i = 0; i < countX; i ++ ) {

			const x = core.minX + i * spacing;
			// 观察点抬高 2 米，免得双线性插值的小起伏把自己挡住
			const eye = terrainHeightAt( x, z ) + 2;
			let sky = 0;

			for ( let k = 0; k < horizonDirections; k ++ ) {

				let maxTangent = - 0.18;
				let distance = spacing * 0.9;
				while ( distance < 9000 ) {

					const tangent = ( terrainHeightAt( x + directionX[ k ] * distance, z + directionZ[ k ] * distance ) - eye ) / distance;
					if ( tangent > maxTangent ) maxTangent = tangent;
					// 再远的山也不可能比现在挡得更高了，提前收工
					if ( ( maxTerrain - eye ) / distance < maxTangent ) break;
					distance += Math.max( spacing * 0.6, distance * 0.12 );

				}

				const angle = Math.atan( maxTangent ) / degree;
				const encoded = Math.round( Math.min( 1, Math.max( 0, ( angle - horizonMinAngle ) / horizonRange ) ) * 255 );
				const block = k >> 2;
				data[ ( j * width + block * countX + i ) * 4 + ( k & 3 ) ] = encoded;
				const cosine = Math.cos( Math.max( 0, angle ) * degree );
				sky += cosine * cosine;

			}

			visibility[ j * countX + i ] = sky / horizonDirections;

		}

		await yieldIfBusy( slice );

	}

	const textureObject = new THREE.DataTexture( data, width, countZ, THREE.RGBAFormat, THREE.UnsignedByteType );
	textureObject.minFilter = THREE.LinearFilter;
	textureObject.magFilter = THREE.LinearFilter;
	textureObject.wrapS = THREE.ClampToEdgeWrapping;
	textureObject.wrapT = THREE.ClampToEdgeWrapping;
	textureObject.generateMipmaps = false;
	textureObject.needsUpdate = true;
	textureObject.name = '远景地平线图';

	return { texture: textureObject, minX: core.minX, minZ: core.minZ, spacing, countX, countZ, visibility };

}

function horizonVisibilityAt( x, z ) {

	const horizon = state.horizon;
	const cellX = Math.min( horizon.countX - 1.001, Math.max( 0, ( x - horizon.minX ) / horizon.spacing ) );
	const cellZ = Math.min( horizon.countZ - 1.001, Math.max( 0, ( z - horizon.minZ ) / horizon.spacing ) );
	const i = Math.floor( cellX );
	const j = Math.floor( cellZ );
	const fractionX = cellX - i;
	const fractionZ = cellZ - j;
	const values = horizon.visibility;
	const index = j * horizon.countX + i;
	const bottom = values[ index ] + ( values[ index + 1 ] - values[ index ] ) * fractionX;
	const top = values[ index + horizon.countX ] + ( values[ index + horizon.countX + 1 ] - values[ index + horizon.countX ] ) * fractionX;
	return bottom + ( top - bottom ) * fractionZ;

}

// ===================== 地表图：湖、河和水池、桃林、花海、天光遮蔽 =====================
// RGBA8，核心区每 4 米一个像素：R = 到水边的有符号距离（米 / 16 + 0.5，水里为正），G = 桃林，B = 花海，A = 天光遮蔽

// 花园水池：从花园原点朝城堡的长条，两头离原点 30 米、离城堡 62 米（城堡台基半宽 48 米）
function gardenPool( world ) {

	const garden = world.locations.garden;
	const startX = garden.origin[ 0 ];
	const startZ = garden.origin[ 2 ];
	const length = Math.hypot( garden.landmark[ 0 ] - startX, garden.landmark[ 2 ] - startZ );
	const directionX = ( garden.landmark[ 0 ] - startX ) / length;
	const directionZ = ( garden.landmark[ 2 ] - startZ ) / length;
	return { startX: startX + directionX * 30, startZ: startZ + directionZ * 30, directionX, directionZ, length: length - 92, halfWidth: 6.5 };

}

async function buildBiomeMap( world, worldConfig, slice ) {

	const core = state.core;
	const spacing = worldConfig.biomeSpacing;
	const width = Math.round( core.sizeX / spacing );
	const height = Math.round( core.sizeZ / spacing );
	const data = new Uint8Array( width * height * 4 );
	const encodeDistance = ( inside ) => Math.round( Math.min( 1, Math.max( 0, inside / 16 + 0.5 ) ) * 255 );
	const pixelX = ( i ) => core.minX + ( i + 0.5 ) * core.sizeX / width;
	const pixelZ = ( j ) => core.minZ + ( j + 0.5 ) * core.sizeZ / height;

	// A 通道：天光遮蔽（从地平线图双线性插值）
	for ( let j = 0; j < height; j ++ ) {

		const z = pixelZ( j );
		for ( let i = 0; i < width; i ++ ) data[ ( j * width + i ) * 4 + 3 ] = Math.round( horizonVisibilityAt( pixelX( i ), z ) * 255 );
		await yieldIfBusy( slice );

	}

	// 只在一个矩形范围里逐像素算，范围外不碰
	async function forEachPixelIn( minX, maxX, minZ, maxZ, callback ) {

		const startI = Math.max( 0, Math.floor( ( minX - core.minX ) / core.sizeX * width ) );
		const endI = Math.min( width - 1, Math.ceil( ( maxX - core.minX ) / core.sizeX * width ) );
		const startJ = Math.max( 0, Math.floor( ( minZ - core.minZ ) / core.sizeZ * height ) );
		const endJ = Math.min( height - 1, Math.ceil( ( maxZ - core.minZ ) / core.sizeZ * height ) );
		for ( let j = startJ; j <= endJ; j ++ ) {

			for ( let i = startI; i <= endI; i ++ ) callback( ( j * width + i ) * 4, pixelX( i ), pixelZ( j ) );
			await yieldIfBusy( slice );

		}

	}

	// R：湖。lakeRadius 是"按椭圆和岸线起伏归一化的半径"，1 是岸；乘短半径近似成米
	const lake = worldConfig.lake;
	const lakeScale = Math.min( lake.radiusX, lake.radiusZ );
	await forEachPixelIn( lake.center[ 0 ] - lake.radiusX * 1.3, lake.center[ 0 ] + lake.radiusX * 1.3, lake.center[ 1 ] - lake.radiusZ * 1.3, lake.center[ 1 ] + lake.radiusZ * 1.3, ( offset, x, z ) => {

		const inside = ( 1 - world.lakeRadius( x, z ) ) * lakeScale;
		data[ offset ] = Math.max( data[ offset ], encodeDistance( inside ) );

	} );

	// R：河（源头往上游不算水，和 world.sample 一致；河口和海接上的那段由海接管）
	for ( const river of world.rivers ) {

		const margin = river.halfWidth + 10;
		const bounds = river.bounds;
		await forEachPixelIn( bounds.minX - margin, bounds.maxX + margin, bounds.minZ - margin, bounds.maxZ + margin, ( offset, x, z ) => {

			const nearest = world.nearestOnRiver( river, x, z );
			let inside = river.halfWidth - nearest.distance;
			if ( nearest.upstream > 0 ) inside = Math.min( inside, river.halfWidth * 0.5 - nearest.upstream );
			data[ offset ] = Math.max( data[ offset ], encodeDistance( inside ) );

		} );

	}

	// R：花园水池（长方形的有符号距离）
	const pool = gardenPool( world );
	const poolEndX = pool.startX + pool.directionX * pool.length;
	const poolEndZ = pool.startZ + pool.directionZ * pool.length;
	await forEachPixelIn( Math.min( pool.startX, poolEndX ) - 20, Math.max( pool.startX, poolEndX ) + 20, Math.min( pool.startZ, poolEndZ ) - 20, Math.max( pool.startZ, poolEndZ ) + 20, ( offset, x, z ) => {

		const along = ( x - pool.startX ) * pool.directionX + ( z - pool.startZ ) * pool.directionZ;
		const lateral = Math.abs( - ( x - pool.startX ) * pool.directionZ + ( z - pool.startZ ) * pool.directionX );
		const inside = Math.min( pool.halfWidth - lateral, along, pool.length - along );
		data[ offset ] = Math.max( data[ offset ], encodeDistance( inside ) );

	} );

	// G：桃林——山外桃花溪两岸，"夹岸数百步"；溪谷底才有，坡上不长；到源头的山脚戛然而止（林尽水源）
	const peachRiver = world.getRiver( 'peachStream' );
	const peachBounds = peachRiver.bounds;
	await forEachPixelIn( peachBounds.minX - 180, peachBounds.maxX + 180, peachBounds.minZ, peachBounds.maxZ + 180, ( offset, x, z ) => {

		const nearest = world.nearestOnRiver( peachRiver, x, z );
		const aboveStream = terrainHeightAt( x, z ) - nearest.level;
		const peach = smoothJs( 170, 60, nearest.distance ) * smoothJs( 1668, 1715, z ) * smoothJs( 45, 20, aboveStream );
		data[ offset + 1 ] = Math.round( peach * 255 );

	} );

	// B：花海——花园四周
	const garden = world.locations.garden;
	await forEachPixelIn( Math.min( garden.origin[ 0 ], garden.landmark[ 0 ] ) - 650, Math.max( garden.origin[ 0 ], garden.landmark[ 0 ] ) + 650, Math.min( garden.origin[ 2 ], garden.landmark[ 2 ] ) - 650, Math.max( garden.origin[ 2 ], garden.landmark[ 2 ] ) + 650, ( offset, x, z ) => {

		const along = Math.min( Math.max( 0, ( x - pool.startX ) * pool.directionX + ( z - pool.startZ ) * pool.directionZ ), pool.length );
		const distance = Math.hypot( x - ( pool.startX + pool.directionX * along ), z - ( pool.startZ + pool.directionZ * along ) );
		data[ offset + 2 ] = Math.round( smoothJs( 620, 260, distance ) * 255 );

	} );

	const textureObject = new THREE.DataTexture( data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType );
	textureObject.minFilter = THREE.LinearFilter;
	textureObject.magFilter = THREE.LinearFilter;
	textureObject.wrapS = THREE.ClampToEdgeWrapping;
	textureObject.wrapT = THREE.ClampToEdgeWrapping;
	textureObject.generateMipmaps = false;
	textureObject.needsUpdate = true;
	textureObject.name = '远景地表图';

	return { texture: textureObject, data, width, height };

}

function biomeAt( x, z, channel ) {

	const biome = state.textures.biome;
	const core = state.core;
	const i = Math.floor( ( x - core.minX ) / core.sizeX * biome.width );
	const j = Math.floor( ( z - core.minZ ) / core.sizeZ * biome.height );
	if ( i < 0 || j < 0 || i >= biome.width || j >= biome.height ) return 0;
	return biome.data[ ( j * biome.width + i ) * 4 + channel ] / 255;

}

// ===================== 噪声贴图的几种尺度 =====================
// 一张噪声贴图 32 × 32 格；tile 是一张贴图铺多少米（一格 = tile / 32 米）。每层坐标先转个角度、挪一点，几层的格子不对齐
const noiseLayers = {
	large: { tile: 8320, angle: 0.0, offset: [ 0.37, 0.71 ] },     // 大斑块，一格 260 米
	medium: { tile: 2240, angle: 0.52, offset: [ 0.13, 0.52 ] },   // 中斑块，一格 70 米
	relief: { tile: 992, angle: 1.1, offset: [ 0.61, 0.29 ] },     // 地表起伏，一格 31 米
	small: { tile: 416, angle: 2.3, offset: [ 0.83, 0.07 ] },      // 小斑块，一格 13 米
	ripple: { tile: 320, angle: 0.8, offset: [ 0.45, 0.91 ] },     // 水面微波，一格 10 米
	rippleFine: { tile: 138, angle: 2.9, offset: [ 0.27, 0.33 ] }, // 细的微波，一格 4.3 米
};

function noiseUvJs( layerName, x, z ) {

	const layer = noiseLayers[ layerName ];
	const cosine = Math.cos( layer.angle );
	const sine = Math.sin( layer.angle );
	return [ ( x * cosine - z * sine ) / layer.tile + layer.offset[ 0 ], ( x * sine + z * cosine ) / layer.tile + layer.offset[ 1 ] ];

}

function noiseUv( layerName, xz, shift = null ) {

	const layer = noiseLayers[ layerName ];
	const cosine = Math.cos( layer.angle );
	const sine = Math.sin( layer.angle );
	const rotated = vec2( xz.x.mul( cosine ).sub( xz.y.mul( sine ) ), xz.x.mul( sine ).add( xz.y.mul( cosine ) ) );
	const uv = rotated.div( layer.tile ).add( vec2( layer.offset[ 0 ], layer.offset[ 1 ] ) );
	return shift ? uv.add( shift ) : uv;

}

// 一次取样拿到这一层的 RGBA（R、G 两张噪声，B、A 是 R 的梯度）。用屏幕导数选 mip：只在一致的控制流里调，
// 要在分支里用就先 toVar 落地
function noiseAt( layerName, xz, shift = null ) {

	return texture( state.textures.noise, noiseUv( layerName, xz, shift ) );

}

// 噪声贴图 R 的梯度换成世界坐标里"每米"的斜率（贴图坐标转过 angle，要转回来；一格 = tile / 32 米）
function noiseGradientWorld( layerName, sample ) {

	const layer = noiseLayers[ layerName ];
	const cosine = Math.cos( layer.angle );
	const sine = Math.sin( layer.angle );
	const perCell = sample.ba.sub( 0.5 ).mul( 4 );
	const perMeter = 32 / layer.tile;
	return vec2( perCell.x.mul( cosine ).add( perCell.y.mul( sine ) ), perCell.y.mul( cosine ).sub( perCell.x.mul( sine ) ) ).mul( perMeter );

}

function noiseValueJs( layerName, x, z, channel ) {

	const [ u, v ] = noiseUvJs( layerName, x, z );
	return sampleNoiseTexture( state.textures.noiseData, u, v, channel );

}

// ===================== 共用着色 =====================
// 全是构建期函数：返回节点，不在每帧里调

// 相机的世界坐标（俯瞰模式 sceneToWorld 是单位矩阵；挂进地点以后是 root 的逆矩阵）
function viewerPosition() {

	return state.uniforms.sceneToWorld.mul( vec4( cameraPosition, 1 ) ).xyz;

}

// 径向深度压缩：离相机 compressStart 以外的点沿视线拉近到 compressEnd 以内（指数饱和），方向不变，屏幕位置不变
function compressDistance( distance ) {

	const uniforms = state.uniforms;
	const range = uniforms.compressEnd.sub( uniforms.compressStart );
	const excess = max( distance.sub( uniforms.compressStart ), 0 );
	const squeezed = uniforms.compressStart.add( range.mul( float( 1 ).sub( exp( excess.div( range ).negate() ) ) ) );
	return min( distance, squeezed );

}

// positionNode 用：本地坐标就是世界坐标（远景的网格都是 root 的直接子节点、单位变换）
function compressedPosition( localPosition ) {

	const viewer = viewerPosition();
	const offset = localPosition.sub( viewer );
	const distance = max( length( offset ), 1e-3 );
	return viewer.add( offset.mul( compressDistance( distance ).div( distance ) ) );

}

// 地平线图：这个位置朝太阳（或月亮）方位看出去，山挡住的仰角（度）
function horizonAngleAt( point, selector ) {

	const uniforms = state.uniforms;
	const cell = point.xz.sub( uniforms.horizonMin ).div( uniforms.horizonSpacing ).clamp( vec2( 0 ), uniforms.horizonCount.sub( 1 ) );
	const width = uniforms.horizonCount.x.mul( horizonDirections / 4 );
	const v = cell.y.add( 0.5 ).div( uniforms.horizonCount.y );
	const sampleBlock = ( block, mask ) => dot( texture( state.textures.horizon.texture, vec2( cell.x.add( 0.5 ).add( block.mul( uniforms.horizonCount.x ) ).div( width ), v ) ).level( 0 ), mask );
	const encoded = mix( sampleBlock( selector.blockA, selector.maskA ), sampleBlock( selector.blockB, selector.maskB ), selector.blend );
	return encoded.mul( horizonRange ).add( horizonMinAngle );

}

// 地形阴影：0 在山的影子里，1 照得到；penumbra 是半影的半宽（度）：太阳 ±1.3°（圆盘放大到 1.2°），月光 ±3°（柔一些）。
// 地平线图只在核心区，往外 350 米慢慢过渡成"照得到"
function terrainShadow( point, selector, elevation, penumbra ) {

	const uniforms = state.uniforms;
	const shadow = float( 1 ).toVar();
	// 太阳 / 月亮在地平线 4° 以下时它的光已经是 0，不用查（条件只看 uniform，整帧一致，不会分叉）
	If( elevation.greaterThan( - 4 ).and( state.toggles.地形阴影.greaterThan( 0.5 ) ), () => {

		const angle = horizonAngleAt( point, selector );
		// 太阳很低（12° 以下）时半影放宽到 3.5°：地平线图格子粗，贴地的阳光下影子边一块块的，像蓝灰色的污渍（审查 R24 那条"带"其实是它）
		const softPenumbra = float( penumbra ).add( float( 1 ).sub( smoothstep( 4, 12, elevation ) ).mul( 2.2 ) );
		const lit = smoothstep( angle.sub( softPenumbra ), angle.add( softPenumbra ), elevation );
		shadow.assign( mix( float( 1 ), lit, uniforms.insideCoreWide( point ) ) );

	} );
	// 云影（阶段 12 CP5）：只算太阳那一路
	if ( selector === uniforms.sunHorizon ) return shadow.mul( cloudShadowAt( point ) );
	return shadow;

}

// 云影：从地面这一点顺着太阳方向找到 4.5 公里高的薄云层（和天空里的薄云同一套坐标、同一张噪声），取两层噪声的覆盖率；
// 太阳高过 6° 才有，最暗压到六成五（白天大片的云影慢慢飘过山坡和林子，地面不是一整片均匀的光）
function cloudShadowAt( point ) {

	const uniforms = state.uniforms;
	const sky = state.world.uniforms;
	const sunUp = max( sky.sunDirection.y, 0.1 );
	const layerPoint = point.xz.add( sky.sunDirection.xz.mul( uniforms.cloudHeight.sub( point.y ).div( sunUp ) ) );
	const along = dot( layerPoint, uniforms.cloudWind );
	const across = dot( layerPoint, vec2( uniforms.cloudWind.y.negate(), uniforms.cloudWind.x ) );
	const cloudUv = vec2( along.mul( 0.6 ), across.mul( 1.3 ) ).div( uniforms.cloudScale ).add( uniforms.cloudOffset ).div( 32 );
	const density = texture( state.textures.noise, cloudUv ).level( 0 ).r.mul( 0.67 ).add( texture( state.textures.noise, cloudUv.mul( 2 ).add( 0.173 ) ).level( 0 ).r.mul( 0.33 ) );
	const threshold = float( 1 ).sub( uniforms.cloudCoverage );
	const coverage = smoothstep( threshold.sub( 0.1 ), threshold.add( 0.15 ), density );
	const daytime = smoothstep( 4, 10, sky.sunElevation );
	return float( 1 ).sub( coverage.mul( 0.35 ).mul( daytime ).mul( state.toggles.云影 ) );

}

// 夜色：天暗下来以后，反照率去饱和、偏蓝（夜里人眼看不出绿，月光下的草地是灰蓝的）
function nightAlbedo( albedo ) {

	const sky = state.world.uniforms;
	const night = fadeOut( 0.1, 0.5, sky.skyIntensity );
	const gray = dot( albedo, vec3( lumaWeights[ 0 ], lumaWeights[ 1 ], lumaWeights[ 2 ] ) );
	// 夜里人眼的色觉退到偏蓝的灰（Purkinje 效应）：原来只偏四成，雪原往下看盆地还是一片饱和的绿；改六成
	return mix( albedo, vec3( 0.62, 0.72, 0.88 ).mul( gray ), night.mul( 0.6 ) );

}

// 光照：太阳（包裹光照，带地形阴影）+ 月亮（阴影里也有一点月色的半球补光，夜里亮暗比不会像墨团）
// + 天空半球光（山谷里看到的天少）+ 一点地面反光
function lightAt( normal, sunShadow, moonShadow, skyView, wrap = 0.2 ) {

	const sky = state.world.uniforms;
	const sunDiffuse = dot( normal, sky.sunDirection ).add( wrap ).div( 1 + wrap ).clamp();
	const moonDiffuse = dot( normal, sky.moonDirection ).add( wrap ).div( 1 + wrap ).clamp();
	const skyColor = mix( sky.horizonColor, sky.zenithColor, normal.y.mul( 0.5 ).add( 0.5 ) ).mul( sky.skyIntensity );
	const bounce = sky.sunLightColor.mul( max( sky.sunDirection.y, 0 ) ).mul( float( 1 ).sub( normal.y ).mul( 0.04 ) );
	// 月光补光：天光遮蔽最多压到一半、系数 0.18（原来 0.12、可以压到 0）。背月的凹崖原来是一大块死黑，
	// 远看像山上破了个洞（2026-10-02 审查 R4：哥特 → 星月夜途中冰瀑右边那块）
	const moonFill = sky.moonLightColor.mul( normal.y.mul( 0.5 ).add( 0.5 ) ).mul( max( skyView, 0.5 ) ).mul( 0.18 ).mul( state.uniforms.nightFill );
	// 地点的反射补光（见 setBounceLight）：方向光，不看地形阴影
	const bounce2 = state.uniforms.bounceColor.mul( dot( normal, state.uniforms.bounceDirection ).add( 0.15 ).div( 1.15 ).clamp() );
	return sky.sunLightColor.mul( sunDiffuse.mul( sunShadow ) )
		.add( sky.moonLightColor.mul( moonDiffuse.mul( moonShadow ) ) )
		.add( moonFill )
		.add( bounce2 )
		.add( skyColor.mul( skyView ).mul( state.uniforms.ambientStrength ) )
		.add( bounce );

}

// 大气透视 + 贴地薄雾。透视的颜色就是天空贴地平线那一圈（dayAerialColor），远山溶进天里看不出接缝；
// 外圈地形的边缘也溶进去，看不出世界的边
function applyAtmosphere( litSurface, point, viewer ) {

	const sky = state.world.uniforms;
	const uniforms = state.uniforms;
	const worldConfig = state.world.config;
	// 亮度增益：地点自己的光比统一天空亮很多时（雪原的月光是世界月光的 9 倍），远景跟着提亮，接缝处亮度对得上
	const surface = litSurface.mul( uniforms.surfaceGain );
	const toPoint = point.sub( viewer );
	const distance = max( length( toPoint ), 1e-3 );
	const direction = toPoint.div( distance );

	const hazeDensity = float( Math.LN2 ).div( sky.hazeDistance );
	const haze = heightFogFactor( hazeDensity, float( worldConfig.hazeFalloff ), point, viewer ).mul( state.toggles.大气透视 );
	// 世界的边：按到中心的距离（圆形）溶进雾里，不是方的，从高处看不出一个方框
	const edgeDistance = length( point.xz.sub( uniforms.outerCenter ) );
	const edge = smoothstep( uniforms.outerHalf.mul( 0.68 ), uniforms.outerHalf.mul( 0.97 ), edgeDistance );
	const aerial = dayAerialColor( direction, sky );
	const hazed = mix( surface, aerial, max( haze, edge ) );

	// 薄雾：只贴着低处，清晨和入夜才有（mistAmount）；最多盖一半，远处的剪影还能分出层次；
	// 颜色比地平线略暗一点，朝太阳、月亮看时前向散射亮一些
	const mist = min( heightFogFactor( sky.mistAmount.mul( worldConfig.mistDensity ), float( worldConfig.mistFalloff ), point, viewer ), 0.5 ).mul( state.toggles.贴地薄雾 );
	const sunForward = henyeyGreenstein( dot( direction, sky.sunDirection ), float( 0.55 ) );
	const moonForward = henyeyGreenstein( dot( direction, sky.moonDirection ), float( 0.55 ) );
	const mistColor = aerial.mul( 0.92 ).add( sky.sunLightColor.mul( sunForward.mul( 0.05 ) ) ).add( sky.moonLightColor.mul( moonForward.mul( 0.08 ) ) );
	const misted = mix( hazed, mistColor, mist );

	// 地点自己的贴地雾（落日的海雾、雪原的贴地雾）也盖到远景上，地点地形的边上看不出接缝；没在地点里时 amount 是 0。
	// 高度从雾的底面（地点原点的海拔）量；底面以下 15~40 米以外不吃这层雾（雪原的雾不会灌进崖下的盆地），也防 exp 溢出
	const fogPoint = vec3( point.x, max( point.y.sub( uniforms.locationFogBase ), - 40 ), point.z );
	const fogEye = vec3( viewer.x, viewer.y.sub( uniforms.locationFogBase ), viewer.z );
	// 水平 1.2~2.4 公里以外淡掉：这层雾是为了地点地形的边上看不出接缝，远处的山交给大气透视；不然雪原朝南看，
	// 高过雾底面的远山山顶被染成一条均匀的青带（2026-10-02 审查 R2）
	const locationFog = heightFogFactor( uniforms.locationFogDensity, uniforms.locationFogFalloff, fogPoint, fogEye )
		.mul( smoothstep( - 40, - 15, point.y.sub( uniforms.locationFogBase ) ) ).mul( uniforms.locationFogAmount )
		.mul( float( 1 ).sub( smoothstep( 1200, 2400, length( point.xz.sub( viewer.xz ) ) ) ) );
	const locationFogColor = uniforms.locationFogColor.add( uniforms.locationFogScatter.mul( henyeyGreenstein( dot( direction, uniforms.locationFogLight ), uniforms.locationFogAnisotropy ).mul( 0.25 ) ) );
	return mix( misted, locationFogColor, locationFog );

}

// 树林遮罩：GPU 版和 JS 版 forestMaskJs 是同一个公式（同一张噪声贴图），地表的林冠色和实例化的树长在同一个地方。
// 只长在缓坡上（坡度 0.2 以上渐少，0.3 以上没有）：再陡的地方实例化的树会像挂在崖上的水滴
function forestMaskNode( largePatch, mediumPatch, smallPatch, height, slope, flowers, peach ) {

	const band = smoothstep( 28, 60, height ).mul( fadeOut( 420, 540, height ) ).mul( fadeOut( 0.2, 0.3, slope ) );
	// 缓坡上更容易长林子（0.04~0.2 加分），平坦的谷底多是草地；小斑块把林缘打碎
	const density = largePatch.mul( 0.6 ).add( mediumPatch.mul( 0.4 ) ).add( smoothstep( 0.04, 0.2, slope ).mul( 0.12 ) ).add( smallPatch.sub( 0.5 ).mul( 0.15 ) );
	return smoothstep( 0.42, 0.72, density ).mul( band ).mul( float( 1 ).sub( flowers ) ).mul( float( 1 ).sub( peach ) );

}

function forestMaskJs( x, z, height, slope, flowers, peach ) {

	const largePatch = noiseValueJs( 'large', x, z, 0 );
	const mediumPatch = noiseValueJs( 'medium', x, z, 1 );
	const smallPatch = noiseValueJs( 'small', x, z, 0 );
	const band = smoothJs( 28, 60, height ) * ( 1 - smoothJs( 420, 540, height ) ) * ( 1 - smoothJs( 0.2, 0.3, slope ) );
	const density = largePatch * 0.6 + mediumPatch * 0.4 + smoothJs( 0.04, 0.2, slope ) * 0.12 + ( smallPatch - 0.5 ) * 0.15;
	return smoothJs( 0.42, 0.72, density ) * band * ( 1 - flowers ) * ( 1 - peach );

}

// ===================== 融水冰槽的冰（地形着色用，雪原的雪材质也用）=====================
// 离冰槽（terrainShape.notches 里 ice 的）中线多近：底宽以内 + 8 米是 1，再往外 6 米淡掉。折线是常数，直接写进着色器
export function iceTroughAmount( worldXZ ) {

	const notches = ( state.world.config.terrainShape.notches || [] ).filter( ( notch ) => notch.ice );
	let amount = float( 0 );
	for ( const notch of notches ) {

		let nearest = float( 1e5 );
		for ( let i = 1; i < notch.points.length; i ++ ) {

			const from = vec2( notch.points[ i - 1 ][ 0 ], notch.points[ i - 1 ][ 2 ] );
			const span = vec2( notch.points[ i ][ 0 ] - notch.points[ i - 1 ][ 0 ], notch.points[ i ][ 2 ] - notch.points[ i - 1 ][ 2 ] );
			const t = clamp( dot( worldXZ.sub( from ), span ).div( dot( span, span ) ), 0, 1 );
			nearest = min( nearest, length( worldXZ.sub( from.add( span.mul( t ) ) ) ) );

		}

		amount = max( amount, float( 1 ).sub( smoothstep( notch.halfBottom + 8, notch.halfBottom + 14, nearest ) ) );

	}

	return amount;

}

// 海边岩丘（terrainShape.knolls，落日身后被溪水切开的那座）的露岩：规格书 5.3 "顶上缓、长草，两侧有圆有陡、露岩"。
// 岩丘被烘焙保护着（形状由解析公式定），烘焙的岩石外露里没有它，原来两侧整片是光滑的黄绿草坡（2026-10-02 自查）。
// 岩丘范围里坡度 0.2 以上就开始露岩（别处 0.38），按两层噪声成片：一块块岩头从草里拱出来，顶上平缓处还是草
function knollRockAmount( point, slope, mediumPatch, smallPatch ) {

	const knolls = state.world.config.terrainShape.knolls || [];
	let inside = float( 0 );
	for ( const knoll of knolls ) {

		const from = vec2( knoll.from[ 0 ], knoll.from[ 1 ] );
		const span = vec2( knoll.to[ 0 ] - knoll.from[ 0 ], knoll.to[ 1 ] - knoll.from[ 1 ] );
		const t = clamp( dot( point.xz.sub( from ), span ).div( dot( span, span ) ), 0, 1 );
		const distance = length( point.xz.sub( from.add( span.mul( t ) ) ) );
		inside = max( inside, float( 1 ).sub( smoothstep( knoll.width * 0.9, knoll.width * 1.3, distance ) ) );

	}

	// 噪声为主、坡度为辅：成团的岩头（约一半的坡面），不是整面坡刷成岩石（第一版整个侧面成了一块棕的）
	// 着色只给细碎的小块（岩头本身是摆上去的半埋苔石，见 narrows.js 的 knollScatter.outcrops）：小斑块为主，大块的会像迷彩（第二版）
	const outcrop = smoothstep( 0.6, 0.7, smallPatch.mul( 0.7 ).add( mediumPatch.mul( 0.3 ) ).add( slope.sub( 0.35 ).mul( 0.8 ) ) );
	return outcrop.mul( inside ).mul( 0.85 );

}

// 冰的颜色：竖着的融水纹（沿槽方向窄、竖直方向长的噪声）、一层层冻上去的深浅
export function iceTroughColor( point ) {

	const streak = noiseAt( 'rippleFine', vec2( point.x.add( point.z ).mul( 2.2 ), point.y.mul( 0.35 ) ) ).r;
	const layer = noiseAt( 'small', vec2( point.x.mul( 0.4 ), point.y.mul( 3 ) ) ).g;
	return mix( color( '#8db2d8' ), color( '#d4e5f6' ), streak.mul( 0.45 ).add( layer.mul( 0.35 ) ).add( 0.1 ) );

}

// ===================== 地形材质 =====================

function createTerrainMaterial() {

	const sky = state.world.uniforms;
	const uniforms = state.uniforms;
	const toggles = state.toggles;
	const biomeTexture = state.textures.biome.texture;

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '远景地形';
	material.fog = false;
	material.lights = false;   // 不吃场景的灯光（光照全是自己算的）：挂进不同地点的场景时生成的着色器一样，显卡管线可以复用

	// 地点自己画的东西底下，远景要让开，不然两层地面、两层海面互相穿插闪烁：
	//   海面下沉（落日）：海面圆盘里远景的海顶点往下沉（岸上的点不动，着色还是按原来的位置算，颜色不变）
	//   内容挖洞（各地点）：地点局部坐标的一个矩形里，远景逐像素丢掉（阶段 12：原来是把顶点压低，跨在矩形边上的三角形
	//   斜下去，边外一圈出现几十米深的沟；地点自己的地形边上贴着远景的高度，矩形边上正好接上）
	const seaVertex = step( 0, attribute( 'terrainInfo', 'vec3' ).x );
	const seaSink = seaVertex.mul( fadeOut( uniforms.seaCutRadius, uniforms.seaCutRadius.add( uniforms.seaCutFade ), length( positionLocal.xz.sub( uniforms.seaCutCenter ) ) ) ).mul( uniforms.seaCutDepth );
	// 湖面下沉（哥特城堡）：湖岸线（和 world.lakeRadius 同一个带起伏的椭圆）以内的顶点往下沉，地点自己的湖面盖上去
	const lakeConfig = state.world.config.lake;
	const lakeOffset = positionLocal.xz.sub( vec2( lakeConfig.center[ 0 ], lakeConfig.center[ 1 ] ) ).div( vec2( lakeConfig.radiusX, lakeConfig.radiusZ ) );
	const lakeAngle = atan( lakeOffset.y, lakeOffset.x );
	const lakeWobble = float( 1 ).add( sin( lakeAngle.mul( 3 ).add( 0.7 ) ).mul( 0.08 ) ).add( sin( lakeAngle.mul( 7 ) ).mul( 0.05 ) );
	const lakeSink = step( length( lakeOffset ).div( lakeWobble ), 1.02 ).mul( uniforms.lakeCutDepth );
	// 地点地形边上的一条带（雪原原点往南到崖边的看台，不能挖洞：一挖连崖面一起挖掉）：远景顶点往下压几米、边上渐变，
	// 地点自己的地面盖在上面（2026-10-02 自查：飞到雪原时远景的台地从雪原的雪面底下钻出来一大块灰影）
	const sinkPoint = modelWorldMatrix.mul( vec4( positionLocal, 1 ) ).xz;
	const sinkInside = smoothstep( uniforms.sinkMin.x, uniforms.sinkMin.x.add( uniforms.sinkFade ), sinkPoint.x )
		.mul( float( 1 ).sub( smoothstep( uniforms.sinkMax.x.sub( uniforms.sinkFade ), uniforms.sinkMax.x, sinkPoint.x ) ) )
		.mul( smoothstep( uniforms.sinkMin.y, uniforms.sinkMin.y.add( uniforms.sinkFade ), sinkPoint.y ) )
		.mul( float( 1 ).sub( smoothstep( uniforms.sinkMax.y.sub( uniforms.sinkFade ), uniforms.sinkMax.y, sinkPoint.y ) ) );
	const bandSink = sinkInside.mul( uniforms.sinkDepth );
	material.positionNode = compressedPosition( positionLocal.sub( vec3( 0, seaSink.add( lakeSink ).add( bandSink ), 0 ) ) );

	material.colorNode = Fn( () => {

		const point = positionGeometry;   // 几何体就建在世界坐标里
		// 山洞穿过的那一截地形不画（从外面看是山上的口子，从洞里看是洞壁）
		Discard( caveCutout( point ).greaterThan( 0.5 ) );
		// 地点自己的地形块里不画（地点坐标里的矩形，见 setContentHole）
		const scenePoint = modelWorldMatrix.mul( vec4( point, 1 ) ).xyz;
		const inHole = step( uniforms.holeMin.x, scenePoint.x ).mul( step( scenePoint.x, uniforms.holeMax.x ) ).mul( step( uniforms.holeMin.y, scenePoint.z ) ).mul( step( scenePoint.z, uniforms.holeMax.y ) );
		Discard( inHole.greaterThan( 0.5 ) );
		// 窄处的地形补丁里远景网格不画（补丁自己的顶点 patchBlend ≥ 0，不丢）。补丁的位置是定的，直接写成常数
		const patchBlend = attribute( 'patchBlend', 'float' );
		const isGrid = step( patchBlend, - 0.5 );
		for ( const patch of state.patches ) {

			const offset = point.xz.sub( vec2( patch.centerX, patch.centerZ ) );
			const along = dot( offset, vec2( patch.axisX, patch.axisZ ) );
			const across = dot( offset, vec2( - patch.axisZ, patch.axisX ) );
			const inside = step( abs( along ), patch.halfLength - patch.overlap ).mul( step( abs( across ), patch.halfWidth - patch.overlap ) );
			Discard( inside.mul( isGrid ).greaterThan( 0.5 ) );

		}

		const viewer = viewerPosition();
		const toPoint = point.sub( viewer );
		const distance = max( length( toPoint ), 1e-3 );
		const viewDirection = toPoint.div( distance );
		const toViewer = viewDirection.negate();
		const xz = point.xz;
		const height = point.y;
		// 法线：核心区里用烘焙地形的法线（4.17 米一格，侵蚀出来的冲沟、碎石坡都看得出）；网格的法线只有 25 米的平滑起伏
		const surfaceSample = texture( state.textures.surface.texture, xz.mul( uniforms.surfaceScale ).add( uniforms.surfaceOffset ) ).toVar();
		const bakedAmount = uniforms.bakedSurface.mul( uniforms.insideCore( point ) );
		// 补丁里几何体本身就比烘焙的 4 米一格细：法线、岩石外露、凹凸按补丁的 patchBlend 退回几何体自己的（边上接回烘焙的，没有接缝）
		const bakedShape = bakedAmount.mul( float( 1 ).sub( max( patchBlend, 0 ) ) );
		const bakedXZ = surfaceSample.rg.mul( 2 ).sub( 1 );
		const bakedNormal = normalize( vec3( bakedXZ.x, pow( max( float( 1 ).sub( dot( bakedXZ, bakedXZ ) ), 0.0004 ), 0.5 ), bakedXZ.y ) );
		const geometryNormal = normalize( mix( normalize( normalGeometry ), bakedNormal, bakedShape ) );
		const slope = float( 1 ).sub( geometryNormal.y );
		// 一个像素在地面上多大（米）：小尺度的花纹在像素比它大时淡掉，远处不闪
		const footprint = max( length( fwidth( point ) ), 0.01 ).toVar();
		const terrainInfo = attribute( 'terrainInfo', 'vec3' );

		// 地表图：核心区以外没有（湖、河、桃林、花海 0，天光遮蔽按外圈的平均值 0.85）
		const coreUv = xz.sub( uniforms.coreMin ).div( uniforms.coreSize );
		const insideCore = uniforms.insideCore( point );
		const biome = texture( biomeTexture, coreUv ).level( 0 );
		const peachAmount = biome.g.mul( insideCore );
		const flowerAmount = biome.b.mul( insideCore );

		// ---------- 噪声（全部在分支外面取样并落地）----------
		const largePatch = noiseAt( 'large', xz ).r.toVar();
		const mediumPatch = noiseAt( 'medium', xz ).g.toVar();
		const smallSample = noiseAt( 'small', xz ).toVar();
		const reliefSample = noiseAt( 'relief', xz ).toVar();
		const flow = vec2( uniforms.time.mul( 0.0021 ), uniforms.time.mul( 0.0013 ) );
		const rippleCoarse = noiseAt( 'ripple', xz, flow ).toVar();
		const rippleFine = noiseAt( 'rippleFine', xz, flow.mul( - 2.2 ) ).toVar();
		const smallFade = fadeOut( 3, 9, footprint ).mul( toggles.地表细节 );
		const smallPatch = mix( float( 0.5 ), smallSample.r, smallFade );

		// ---------- 反照率 ----------
		// 草甸（阶段 12 CP3 绘本化）：不是一整片均匀的绿，而是几种绿和金绿成片地换——
		//   汇水多的沟里、谷底是深而润的绿，山脊、离谷底高的坡偏干、偏金绿，冲出来的扇面（沉积）偏橄榄；
		//   再按两层大斑块在三四个颜色之间"分色"（smoothstep 收窄，边缘是一块一块的，不是渐变），像水彩的色块；
		//   最后一层顺等高线方向拉长的笔触（几十米长、几米宽），从飞行高度看下去地上有笔触感
		const surfaceSampleB = texture( state.textures.surface.textureB, xz.mul( uniforms.surfaceScale ).add( uniforms.surfaceOffset ) ).toVar();
		const wetness = smoothstep( 0.25, 0.75, surfaceSampleB.r ).mul( bakedAmount );
		const sediment = smoothstep( 0.05, 0.4, surfaceSampleB.g ).mul( bakedAmount );
		const dryness = smoothstep( 0.25, 0.75, surfaceSampleB.b ).mul( bakedAmount ).mul( float( 1 ).sub( wetness.mul( 0.7 ) ) );
		const patchA = smoothstep( 0.33, 0.67, largePatch );
		const patchB = smoothstep( 0.3, 0.7, mediumPatch );
		const fresh = mix( color( '#73a050' ), color( '#8daf5b' ), patchB );          // 翠绿 ↔ 嫩黄绿
		const mellow = mix( color( '#7d9d57' ), color( '#6a9259' ), patchB );         // 橄榄绿 ↔ 蓝绿
		let meadow = mix( fresh, mellow, patchA );
		meadow = mix( meadow, color( '#4e7c43' ), wetness.mul( 0.7 ) );              // 沟里、谷底：深润的绿
		meadow = mix( meadow, color( '#a7a862' ), dryness.mul( 0.55 ) );             // 脊上：金绿
		meadow = mix( meadow, color( '#8f9a5a' ), sediment.mul( 0.4 ) );             // 冲积扇：橄榄
		// 笔触：沿等高线方向拉长的两层噪声（噪声贴图一圈 32 格：等高线方向一格 20 米、下坡方向一格 2.5 米；第二层一半大），只调明暗 ±8%。
		// 直接取噪声贴图（noiseAt 的各层会把坐标转一个角度，拉长的方向就不顺等高线了）
		const downhill = normalize( vec2( geometryNormal.x, geometryNormal.z ).add( vec2( 1e-4, 0 ) ) );
		const strokeCoord = vec2( dot( xz, vec2( downhill.y.negate(), downhill.x ) ).div( 640 ), dot( xz, downhill ).div( 80 ) );
		const stroke = texture( state.textures.noise, strokeCoord ).r.mul( 0.6 ).add( texture( state.textures.noise, strokeCoord.mul( 2.03 ).add( vec2( 0.37, 0.11 ) ) ).g.mul( 0.4 ) );
		meadow = meadow.mul( stroke.sub( 0.5 ).mul( 0.16 ).mul( toggles.笔触边缘 ).add( 1 ) );
		const albedo = mix( meadow, color( '#a29770' ), smoothstep( 260, 460, height ).mul( 0.6 ) ).mul( smallPatch.mul( 0.2 ).add( 0.9 ) ).toVar();

		// 野花（阶段 12 CP3）：草甸上零零星星的白、黄、粉、淡紫小点，冲积的平地和润的地方多一些；
		// 点按像素足迹淡掉（远处只剩一层很淡的花色，不闪）
		const flowerSeed = noiseAt( 'rippleFine', xz.mul( 3.1 ) ).toVar();   // 一格约 1.4 米：一朵朵是半米上下的小团
		const wildDensity = smoothstep( 0.35, 0.7, mediumPatch.mul( 0.6 ).add( sediment.mul( 0.4 ) ).add( wetness.mul( 0.2 ) ) ).mul( fadeOut( 0.08, 0.2, slope ) ).mul( fadeOut( 120, 260, height ) );
		const wildDot = smoothstep( float( 0.8 ).sub( wildDensity.mul( 0.12 ) ), 0.9, flowerSeed.r ).mul( wildDensity ).mul( fadeOut( 0.25, 0.9, footprint ) );
		const wildTint = mix( mix( color( '#f6f2ea' ), color( '#f1d66a' ), smoothstep( 0.3, 0.45, flowerSeed.g ) ), mix( color( '#f0b5c8' ), color( '#c9b6e8' ), smoothstep( 0.6, 0.75, flowerSeed.g ) ), smoothstep( 0.5, 0.55, flowerSeed.g ) );
		const wildHaze = wildDensity.mul( 0.06 ).mul( smoothstep( 0.25, 0.9, footprint ) );
		albedo.assign( mix( albedo, wildTint, max( wildDot.mul( 0.85 ), wildHaze ).mul( toggles.野花 ) ) );

		// 花海：白、粉、淡紫的碎点，远看是一层柔和的粉白；只开在平地上
		If( flowerAmount.greaterThan( 0.004 ), () => {

			const flowerHue = mix( float( 0.5 ), smallSample.g, smallFade );
			const flowerColor = mix( mix( color( '#f5c6d6' ), color( '#d9c8f0' ), smoothstep( 0.35, 0.65, flowerHue ) ), color( '#fbf6f0' ), smoothstep( 0.62, 0.85, flowerHue ) );
			const flowerField = flowerAmount.mul( fadeOut( 0.06, 0.18, slope ) ).mul( smoothstep( 0.35, 0.7, mediumPatch.mul( 0.7 ).add( smallPatch.mul( 0.3 ) ) ) ).mul( 0.45 );
			albedo.assign( mix( albedo, flowerColor, flowerField ) );

		} );

		// 树林的林地（实例化的树就长在这上面）：林冠底下的绿，一团一团；外圈没有树，林地的对比减半
		const forest = forestMaskNode( largePatch, mediumPatch, smallSample.r, height, slope, flowerAmount, peachAmount );
		const canopy = mix( color( '#5d7a4c' ), color( '#44603f' ), smoothstep( 140, 330, height ) ).mul( smallPatch.mul( 0.5 ).add( 0.75 ) );
		albedo.assign( mix( albedo, canopy, forest.mul( mix( float( 0.27 ), float( 0.55 ), insideCore ) ) ) );

		// 桃林：粉色的树冠底色
		const peachBloom = peachAmount.mul( smoothstep( 0.3, 0.5, mediumPatch.mul( 0.5 ).add( smallPatch.mul( 0.5 ) ) ) );
		albedo.assign( mix( albedo, mix( color( '#eeb0c2' ), color( '#f8d3de' ), smallPatch ), peachBloom ) );

		// 岩石：陡坡露出岩石，带水平的岩层（两种频率叠加，噪声扰动，同 TerrainGenerator 的做法）
		// 有烘焙时按烘焙的"岩石外露"（陡崖、被冲刷的地方），不再按一个坡度阈值（那样花园四周压平盘外面正好一圈水平的岩石带）
		const rockBySlope = smoothstep( 0.38, 0.6, slope.add( mediumPatch.sub( 0.5 ).mul( 0.22 ) ) );
		const rockBaked = smoothstep( 0.25, 0.75, surfaceSample.b.add( mediumPatch.sub( 0.5 ).mul( 0.3 ) ) );
		const knollRock = knollRockAmount( point, slope, mediumPatch, smallPatch );
		// 不太陡的坡上露岩碎成一块块（中间夹着草和灌丛），不是整片连着（审查 R23：花园东边山坡上一大片光滑的灰"毯子"）；陡崖照旧整面是岩
		const rockBreakup = mix( smoothstep( 0.32, 0.62, mediumPatch.mul( 0.6 ).add( smallPatch.mul( 0.4 ) ) ), float( 1 ), smoothstep( 0.62, 0.82, slope ) );
		const rock = max( mix( rockBySlope, rockBaked, bakedShape ).mul( rockBreakup ), knollRock ).toVar();
		const strata = sin( height.mul( 0.11 ).add( point.x.mul( 0.008 ) ).add( largePatch.mul( 9 ) ) ).mul( 0.6 )
			.add( sin( height.mul( 0.29 ).add( mediumPatch.mul( 5 ) ) ).mul( 0.4 ) ).mul( 0.5 ).add( 0.5 );
		const rockColor = mix( color( '#8f887d' ), color( '#6c6763' ), strata.mul( 0.35 ).add( mediumPatch.mul( 0.65 ) ) ).mul( smallPatch.mul( 0.2 ).add( 0.9 ) ).toVar();
		// 岩丘的岩头是冷灰、暗一点（和口子两壁的岩石扫描一个色，夕照下不发红）
		rockColor.mulAssign( mix( vec3( 1 ), vec3( 0.66, 0.7, 0.8 ), knollRock ) );
		// 哥特岩台一带的岩是深色的（阶段 12 CP4：原来和别处一样的灰白，夜里一照像一块石膏；城堡要坐在暗的岩上，窗灯才跳出来）
		rockColor.mulAssign( mix( float( 1 ), float( 0.5 ), uniforms.mesaDark( point ) ) );
		// 雪原台地南缘那面崖（冰瀑崖）也是深色岩，岩层明暗加重（审查 R16：原来灰白的岩面夜里一照和雪一个色，
		// 圆鼓鼓的冲沟像一面挂下来的布帘）；雪只留在缓一点的台阶上（下面的雪按坡度减）
		const plateauCliff = smoothstep( - 1300, - 1420, point.z ).mul( smoothstep( 190, 280, height ) ).mul( fadeOut( 545, 562, height ) );
		rockColor.mulAssign( mix( float( 1 ), strata.mul( 0.35 ).add( 0.38 ), plateauCliff ) );
		albedo.assign( mix( albedo, rockColor, rock ) );

		// 海边的沙滩
		const beach = terrainInfo.y.mul( fadeOut( 1.8, 4.5, height ) ).mul( float( 1 ).sub( rock ) );
		albedo.assign( mix( albedo, color( '#d8c9a6' ), beach ) );

		// 雪：雪原台地上全是雪；别处只有 600 米上下的山顶戴雪帽；太陡的岩壁挂不住雪；风吹的雪窝颜色稍冷
		const snowLine = float( 600 ).add( largePatch.sub( 0.5 ).mul( 140 ) );
		const snowCover = max( smoothstep( snowLine.sub( 25 ), snowLine.add( 25 ), height ), smoothstep( 0.4, 0.9, terrainInfo.z ) );
		// 冰瀑崖上雪挂不住的坡度放低一些（0.38 → 0.24 开始掉），陡面露出深色岩，缓的台阶上留雪
		const snowSlopeStart = mix( float( 0.38 ), float( 0.24 ), plateauCliff );
		const snow = snowCover.mul( float( 1 ).sub( smoothstep( snowSlopeStart, snowSlopeStart.add( 0.24 ), slope.add( mediumPatch.sub( 0.5 ).mul( 0.15 ) ) ).mul( mix( float( 0.85 ), float( 0.95 ), plateauCliff ) ) ) );
		const snowColor = mix( color( '#eef3fa' ), color( '#d3dcea' ), smoothstep( 0.3, 0.75, smallPatch ).mul( 0.5 ) );
		albedo.assign( mix( albedo, snowColor, snow ) );

		// 冰瀑：台地南缘、小镇溪源头上方那一段崖壁结着冰（偏蓝、亮、带一点镜面）
		const iceFall = exp( point.x.sub( uniforms.iceFallX ).div( 28 ).pow2().negate() )
			.mul( smoothstep( uniforms.iceFallBottom.sub( 15 ), uniforms.iceFallBottom.add( 5 ), height ) )
			.mul( smoothstep( 0.22, 0.45, slope ) )
			.mul( smoothstep( uniforms.iceFallZ.x.sub( 15 ), uniforms.iceFallZ.x.add( 15 ), point.z ) )
			.mul( fadeOut( uniforms.iceFallZ.y.sub( 15 ), uniforms.iceFallZ.y.add( 15 ), point.z ) );
		albedo.assign( mix( albedo, color( '#cfe6fb' ), iceFall ) );
		// 融水冰槽（星月夜 → 雪原的窄处，阶段 12 CP3 返工）：槽壁是冰——偏青蓝、竖着的融水纹、一层层冻上去的深浅
		const iceTrough = iceTroughAmount( point.xz ).mul( smoothstep( 0.28, 0.5, slope ) );
		albedo.assign( mix( albedo, iceTroughColor( point ), iceTrough ) );
		// 烘焙的凹凸：沟里暗一点、棱上亮一点（细的 AO，只在核心区）
		albedo.assign( albedo.mul( mix( float( 1 ), surfaceSample.a.mul( 0.5 ).add( 0.75 ), bakedShape ) ) );
		// 草根融合（阶段 12 CP3 返工）：地点里的草长出地点自己的地面、落到远景上时，近环里的地面往草根色压，草缝里是暗的草根不是亮的地面
		// 远环范围里往草的中段色靠，近环里往草根色压（形状和 grass.js 的 underlay 共用 grassUnderlayShape）
		const grassDistance = length( point.xz.sub( uniforms.grassUnderlayCenter ) );
		// 半径先夹到 ≥ 1（没有草时半径是 0，smoothstep 的两个边界相等，结果未定义），再乘 step 关掉
		const grassNearRadius = max( uniforms.grassUnderlayRadius, 1 );
		const grassFarRadius = max( uniforms.grassUnderlayFar, 1 );
		const grassNearness = fadeOut( grassNearRadius.mul( grassUnderlayShape.nearStart ), grassNearRadius, grassDistance )
			.mul( step( 1, uniforms.grassUnderlayRadius ) ).mul( uniforms.grassUnderlayNear ).mul( grassUnderlayShape.nearStrength );
		const grassFarness = fadeOut( grassFarRadius.mul( grassUnderlayShape.farStart ), grassFarRadius, grassDistance )
			.mul( step( 1, uniforms.grassUnderlayFar ) ).mul( uniforms.grassUnderlayFarAmount ).mul( grassUnderlayShape.farStrength );
		If( max( grassNearness, grassFarness ).mul( uniforms.grassUnderlayAmount ).greaterThan( 0.001 ), () => {

			const grassDensity = grassGroundAtWorld( point.xz ).density.mul( uniforms.grassUnderlayAmount );
			albedo.assign( mix( albedo, uniforms.grassMiddleColor, grassFarness.mul( grassDensity ) ) );
			albedo.assign( mix( albedo, uniforms.grassRootColor, grassNearness.mul( grassDensity ) ) );

		} );
		albedo.assign( nightAlbedo( albedo ) );

		// ---------- 细节起伏：直接用噪声贴图里的梯度通道扰动法线（对 8 位噪声求屏幕导数会出等高线和棋盘格）----------
		const reliefAmplitude = mix( float( 1.2 ), float( 3.5 ), rock ).mul( mix( float( 1 ), float( 0.2 ), snow ) ).mul( fadeOut( 8, 30, footprint ) ).mul( toggles.地表细节 );
		const reliefSlope = noiseGradientWorld( 'relief', reliefSample ).mul( reliefAmplitude );
		let normal = normalize( geometryNormal.sub( vec3( reliefSlope.x, 0, reliefSlope.y ) ) );

		// ---------- 近处的真贴图（阶段 12 CP3）：明暗、一点色相、法线；雪上、水里不加 ----------
		if ( state.ground ) {

			const forestWeight = forest.mul( 0.9 );
			const meadowWeight = max( float( 1 ).sub( rock ).sub( beach ).sub( forestWeight.mul( 0.7 ) ), 0.05 );
			const detail = groundDetail( state.ground, {
				point,
				normal,
				weights: vec4( meadowWeight, forestWeight, rock, beach ),
				viewDistance: distance,
				near: uniforms.groundNear,
			} );
			const bare = float( 1 ).sub( snow.mul( 0.9 ) );
			albedo.assign( albedo.mul( mix( vec3( 1 ), detail.shade, bare ) ) );
			normal = normalize( mix( normal, detail.normal, bare ) );

		}

		// ---------- 光照 ----------
		const sunShadow = terrainShadow( point, uniforms.sunHorizon, sky.sunElevation, 1.3 );
		const moonShadow = terrainShadow( point, uniforms.moonHorizon, sky.moonElevation, 3 );
		const skyView = mix( float( 0.85 ), biome.a, uniforms.insideCoreWide( point ) ).mul( toggles.天光遮蔽 ).add( float( 1 ).sub( toggles.天光遮蔽 ) );
		const surface = albedo.mul( lightAt( normal, sunShadow, moonShadow, skyView ) ).toVar();

		// 冰瀑和雪在逆光里的一点镜面（掠射时亮）
		const grazing = max( float( 1 ).sub( max( dot( normal, toViewer ), 0 ) ), 0 );
		const sheen = pow( grazing, 4 ).mul( snow.mul( 0.12 ).add( iceFall.mul( 0.2 ) ).add( iceTrough.mul( 0.35 ) ) );
		surface.addAssign( sky.sunLightColor.mul( sunShadow ).add( sky.moonLightColor.mul( moonShadow ) ).mul( sheen ) );

		// ---------- 水：海按顶点（海岸线由顶点插值），湖、河、水池按地表图（4 米一个像素，按像素足迹软边）----------
		const seaWater = smoothstep( - 0.04, 0.04, terrainInfo.x );
		const insideWater = biome.r.sub( 0.5 ).mul( 16 );   // 米，水里为正
		// 陡的地方不会是水面：地表图 4 米一个像素，溪源头那面头墙（每米抬 6 米）会被水边的插值刷上一条"水"
		const inlandWater = smoothstep( footprint.mul( - 0.6 ), footprint.mul( 0.6 ), insideWater ).mul( insideCore ).mul( fadeOut( 0.22, 0.4, slope ) );
		const water = max( seaWater, inlandWater ).mul( toggles.水面 );

		If( water.greaterThan( 0.001 ), () => {

			// 海浪大一些、湖面平一些；像素比微波大时淡掉（远处的统计粗糙度另外加到高光里）。
			// 梯度通道是"每格"的斜率，乘强度当作水面斜率；微波各向同性，贴图坐标的转角不用转回来
			const seaAmount = terrainInfo.y;
			const rippleStrength = mix( float( 0.05 ), float( 0.16 ), seaAmount );
			const coarseFade = fadeOut( 2.5, 12, footprint );
			const fineFade = fadeOut( 1.1, 5, footprint );
			const gradient = rippleCoarse.ba.sub( 0.5 ).mul( 4 ).mul( coarseFade ).add( rippleFine.ba.sub( 0.5 ).mul( 2 ).mul( fineFade ) ).mul( rippleStrength );
			const waterNormal = normalize( vec3( gradient.x.negate(), 1, gradient.y.negate() ) );

			const facing = max( dot( waterNormal, toViewer ), 0.02 );
			// 菲涅尔（Schlick，水 F0 = 0.02）；远处像素里的微波朝向各异，平均下来反射多一点（最多 +0.06）
			const fresnel = float( 0.02 ).add( pow( max( float( 1 ).sub( facing ), 0 ), 5 ).mul( 0.98 ) ).add( smoothstep( 2, 30, footprint ).mul( 0.06 ) );
			const bounced = reflect( viewDirection, waterNormal );
			const reflectedDirection = normalize( vec3( bounced.x, max( bounced.y, 0.01 ), bounced.z ) );
			// 倒影：统一天空（不画太阳圆盘，太阳的高光下面按粗糙度算；不画星星，微波会把每颗星打成一条白划痕）
			const skyReflection = daySkyColor( reflectedDirection, sky, uniforms.time, { sunDisc: false, stars: false } ).mul( toggles.水面倒影 );

			// 太阳、月亮的高光：Beckmann 分布，海面粗糙度按 Cox–Munk 的量级（σ² ≈ 0.02），湖面更平；远处像素里的微波平均掉，粗糙度变大
			const roughness = mix( float( 0.004 ), float( 0.02 ), seaAmount ).add( smoothstep( 0, 40, footprint ).mul( 0.02 ) );
			// Smith 遮挡（Walter 2007 对 Beckmann 的有理近似，和落日海面同一个式子）：掠射角下浪背面互相挡。
			// 原来没有它，太阳贴着海平线时 1 / (4·N·V) 在地平线上冲成一个圆亮斑，出裂隙那一刻像"两个太阳"（审查 R20）
			const smith = ( cosineTheta ) => {

				const clamped = clamp( cosineTheta, 1e-3, 0.9999 );
				const ratio = clamped.div( sqrt( roughness ).mul( sqrt( float( 1 ).sub( clamped.mul( clamped ) ) ) ) );
				const rational = ratio.mul( 3.535 ).add( ratio.mul( ratio ).mul( 2.181 ) ).div( ratio.mul( 2.276 ).add( ratio.mul( ratio ).mul( 2.577 ) ).add( 1 ) );
				return select( ratio.lessThan( 1.6 ), rational, float( 1 ) );

			};
			const glint = ( lightDirection, lightColor, shadow ) => {

				const halfVector = normalize( lightDirection.add( toViewer ) );
				const cosine = max( dot( waterNormal, halfVector ), 1e-3 );
				const cosineSquared = cosine.mul( cosine );
				const beckmann = exp( cosineSquared.sub( 1 ).div( cosineSquared.mul( roughness ) ) ).div( roughness.mul( Math.PI ).mul( cosineSquared ).mul( cosineSquared ) );
				const glintFresnel = float( 0.02 ).add( pow( max( float( 1 ).sub( max( dot( toViewer, halfVector ), 0 ) ), 0 ), 5 ).mul( 0.98 ) );
				const masking = smith( facing ).mul( smith( dot( waterNormal, lightDirection ) ) );
				return lightColor.mul( beckmann.mul( glintFresnel ).mul( masking ).div( facing.mul( 4 ) ) ).mul( shadow ).mul( smoothstep( - 0.02, 0.02, lightDirection.y ) );

			};
			const highlights = glint( sky.sunDirection, sky.sunLightColor, sunShadow ).add( glint( sky.moonDirection, sky.moonLightColor, moonShadow ) ).mul( toggles.水面高光 );

			// 水体：海按顶点水深，湖和河按离岸距离估一个深度；水体本身很暗（看到的大多是倒影），
			// 被照亮的程度只取天光的亮度，不让晚霞把海染成褐色；浅的地方透出水底
			const depth = max( terrainInfo.x, insideWater.mul( 0.5 ).clamp( 0, 8 ).mul( inlandWater ) );
			const deepColor = mix( color( '#24596a' ), color( '#1f3f6e' ), seaAmount );
			const skyAmbient = mix( sky.horizonColor, sky.zenithColor, 0.5 ).mul( sky.skyIntensity );
			const ambientLevel = dot( skyAmbient, vec3( lumaWeights[ 0 ], lumaWeights[ 1 ], lumaWeights[ 2 ] ) );
			const waterLight = sky.sunLightColor.mul( max( sky.sunDirection.y, 0 ).mul( sunShadow ).mul( 0.25 ) ).add( vec3( ambientLevel.mul( 0.7 ) ) ).add( sky.moonLightColor.mul( 0.15 ) );
			const underwater = mix( deepColor.mul( waterLight ), surface.mul( 0.65 ), exp( depth.mul( - 0.45 ) ).mul( 0.85 ) );

			// 海边的一条白浪
			const foam = seaAmount.mul( fadeOut( 0.05, 0.7, depth ) ).mul( smoothstep( 0.4, 0.7, rippleCoarse.g ) );
			const foamColor = color( '#f4f1ea' ).mul( lightAt( vec3( 0, 1, 0 ), sunShadow, moonShadow, float( 1 ) ) );

			const waterColor = mix( mix( underwater, skyReflection, fresnel ).add( highlights ), foamColor, foam.mul( 0.8 ) );
			surface.assign( mix( surface, waterColor, water ) );

		} );

		return applyAtmosphere( surface, point, viewer );

	} )();

	return material;

}

// ===================== 烘焙地形的遮罩贴图 =====================
// A 通道：法线 x、法线 z、岩石外露、凹凸（scripts/bake-terrain.mjs 写的，4.17 米一个像素）。没有烘焙时给一个 1×1 的中性像素
// （法线朝上、没有岩石、不凹不凸），着色器的节点一样，不用另编一套
function createSurfaceTexture( terrainBake ) {

	if ( ! terrainBake || ! terrainBake.surfaceA ) {

		const neutral = new THREE.DataTexture( new Uint8Array( [ 128, 128, 0, 128 ] ), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType );
		neutral.needsUpdate = true;
		neutral.name = '烘焙地形遮罩（没有）';
		// B 的中性值：汇水少、不沉积、离谷底一半高、适合长树
		const neutralB = new THREE.DataTexture( new Uint8Array( [ 40, 0, 64, 200 ] ), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType );
		neutralB.needsUpdate = true;
		neutralB.name = '烘焙地形遮罩 B（没有）';
		return { texture: neutral, textureB: neutralB, grid: null, scale: new THREE.Vector2( 0, 0 ), offset: new THREE.Vector2( 0.5, 0.5 ) };

	}

	const grid = terrainBake.grid;
	if ( terrainBake.surfaceA.length !== grid.width * grid.height * 4 ) throw new Error( `远景：烘焙地形的遮罩大小不对（${ terrainBake.surfaceA.length }，应该是 ${ grid.width * grid.height * 4 }）` );
	const surfaceTexture = new THREE.DataTexture( terrainBake.surfaceA, grid.width, grid.height, THREE.RGBAFormat, THREE.UnsignedByteType );
	surfaceTexture.magFilter = THREE.LinearFilter;
	surfaceTexture.minFilter = THREE.LinearMipmapLinearFilter;
	surfaceTexture.generateMipmaps = true;
	surfaceTexture.wrapS = THREE.ClampToEdgeWrapping;
	surfaceTexture.wrapT = THREE.ClampToEdgeWrapping;
	surfaceTexture.needsUpdate = true;
	surfaceTexture.name = '烘焙地形遮罩 A';
	const surfaceTextureB = new THREE.DataTexture( terrainBake.surfaceB, grid.width, grid.height, THREE.RGBAFormat, THREE.UnsignedByteType );
	surfaceTextureB.magFilter = THREE.LinearFilter;
	surfaceTextureB.minFilter = THREE.LinearMipmapLinearFilter;
	surfaceTextureB.generateMipmaps = true;
	surfaceTextureB.wrapS = THREE.ClampToEdgeWrapping;
	surfaceTextureB.wrapT = THREE.ClampToEdgeWrapping;
	surfaceTextureB.needsUpdate = true;
	surfaceTextureB.name = '烘焙地形遮罩 B';
	// 网格点 i 在 x = minX + i·spacing，对准第 i 个像素的中心：u = (x − minX) / (width·spacing) + 0.5 / width
	const scale = new THREE.Vector2( 1 / ( grid.width * grid.spacing ), 1 / ( grid.height * grid.spacing ) );
	const offset = new THREE.Vector2( - grid.minX * scale.x + 0.5 / grid.width, - grid.minZ * scale.y + 0.5 / grid.height );
	return { texture: surfaceTexture, textureB: surfaceTextureB, grid, scale, offset };

}

// ===================== 天空球 =====================
// 跟着相机走，半径 0.9 × far；不透明物体里最后画、做深度测试但不写深度：被地形、替身挡住的像素直接被深度测试丢掉，不算天空。
// 方向在世界坐标里算（sceneToWorld 把场景里的视线转回世界），太阳月亮星星和云都对得上

function createSkyMaterial( tier ) {

	const sky = state.world.uniforms;
	const uniforms = state.uniforms;
	const cloudConfig = state.world.config.clouds;
	const octaves = cloudConfig.octaves[ tier ] || cloudConfig.octaves.mid;

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '远景天空';
	material.side = THREE.BackSide;
	material.depthWrite = false;
	material.fog = false;
	material.lights = false;

	material.colorNode = Fn( () => {

		const direction = normalize( uniforms.sceneToWorld.mul( vec4( positionWorld.sub( cameraPosition ), 0 ) ).xyz );
		const viewer = viewerPosition();
		const result = daySkyColor( direction, sky, uniforms.time ).toVar();

		// 薄云：一层 4.5 公里高的平面，视线和它相交处叠几层噪声贴图（一格 = cloudScale 米）；沿风向拉长一点，像高空的卷云和高积云。
		// 取样都在分支外面（mip 靠屏幕导数选，贴地平线的远云自动变柔，不出细碎条纹）；朝下看、相机在云层以上时 alpha 为 0
		const upward = max( direction.y, 0.004 );
		const distanceToLayer = max( uniforms.cloudHeight.sub( viewer.y ), 1 ).div( upward );
		const layerPoint = viewer.xz.add( direction.xz.mul( distanceToLayer ) );
		const along = dot( layerPoint, uniforms.cloudWind );
		const across = dot( layerPoint, vec2( uniforms.cloudWind.y.negate(), uniforms.cloudWind.x ) );
		const cloudUv = vec2( along.mul( 0.6 ), across.mul( 1.3 ) ).div( uniforms.cloudScale ).add( uniforms.cloudOffset ).div( 32 );
		let density = float( 0 );
		let weightSum = 0;
		for ( let octave = 0; octave < octaves; octave ++ ) {

			const scale = Math.pow( 2, octave );
			const angle = octave * 0.9;
			const rotated = vec2( cloudUv.x.mul( Math.cos( angle ) ).sub( cloudUv.y.mul( Math.sin( angle ) ) ), cloudUv.x.mul( Math.sin( angle ) ).add( cloudUv.y.mul( Math.cos( angle ) ) ) );
			const weight = Math.pow( 0.5, octave );
			density = density.add( texture( state.textures.noise, rotated.mul( scale ).add( octave * 0.173 ) ).r.mul( weight ) );
			weightSum += weight;

		}

		density = density.div( weightSum ).toVar();
		const threshold = float( 1 ).sub( uniforms.cloudCoverage );
		const coverage = smoothstep( threshold.sub( 0.12 ), threshold.add( 0.2 ), density );
		// 贴着地平线的云挤成一条条，早点淡掉；很远处也淡掉。夜里的云暗一些，但仍然挡住后面的星星
		const fade = smoothstep( 0.03, 0.2, direction.y ).mul( exp( distanceToLayer.div( - 30000 ) ) ).mul( step( viewer.y, uniforms.cloudHeight ) );
		const dayAmount = smoothstep( 0.1, 0.5, sky.skyIntensity );
		const alpha = coverage.mul( fade ).mul( mix( float( 0.7 ), float( 0.85 ), dayAmount ) ).mul( state.toggles.薄云 ).toVar();

		If( alpha.greaterThan( 0.001 ), () => {

			// 云的光照：朝太阳看时前向散射亮；厚的地方暗一点；太阳落下后高空的云还被照着（cloudSunColor 比地面晚暗）
			const sunForward = henyeyGreenstein( dot( direction, sky.sunDirection ), float( 0.6 ) );
			const moonForward = henyeyGreenstein( dot( direction, sky.moonDirection ), float( 0.6 ) );
			const thickness = float( 1 ).sub( coverage.mul( 0.4 ) );
			const sunPart = uniforms.cloudSunColor.mul( sunForward.mul( 0.1 ).add( 0.3 ) ).mul( thickness );
			const ambientPart = mix( sky.horizonColor, sky.zenithColor, 0.55 ).mul( sky.skyIntensity ).mul( 0.95 );
			// 月光照云只照亮一点边，夜里的云比星空稍亮、不发白
			const moonPart = sky.moonLightColor.mul( moonForward.mul( 0.08 ).add( 0.14 ) );
			const glowPart = dayAerialColor( direction, sky ).mul( 0.25 );
			const cloudColor = sunPart.add( ambientPart ).add( moonPart ).add( glowPart );
			result.assign( mix( result, cloudColor, alpha ) );

		} );

		return result;

	} )();

	return material;

}

// ===================== 树林 =====================
// 每棵树一个变形的二十面体（同 ForestGenerator 的 blobGeometry：底窄顶尖、法线朝上朝外，像一团柔软的树冠），
// 阔叶、针叶、桃树三种形状各一个 InstancedMesh，一次绘制画完。离相机 from~to 米之间按每棵树的随机数逐渐稀疏，再远就收成一个点不画。
// 树的真实半径、高度烘进几何体，实例只做均匀缩放：非均匀缩放会经法线矩阵把"朝上朝外"的法线压扁成竖墙

function blobGeometry( detail, radius, height, taper, lumpiness, flatBase ) {

	let geometry = new THREE.IcosahedronGeometry( 1, detail );
	geometry.deleteAttribute( 'uv' );
	geometry.deleteAttribute( 'normal' );
	geometry = mergeVertices( geometry );
	const position = geometry.attributes.position;
	const normals = new Float32Array( position.count * 3 );
	const heights = new Float32Array( position.count );

	for ( let i = 0; i < position.count; i ++ ) {

		const unitX = position.getX( i );
		const unitY = position.getY( i );
		const unitZ = position.getZ( i );
		// 0 底，1 顶；平底的树（针叶）把下面那几圈压到同一个高度，底部是一个平的圆，不是尖的菱形
		const along = flatBase ? Math.max( ( unitY + 1 ) / 2, 0.22 ) : ( unitY + 1 ) / 2;
		const lump = 1 + lumpiness * Math.sin( unitX * 3.1 ) * Math.sin( unitY * 2.7 + 1.3 ) * Math.sin( unitZ * 3.5 + 2.1 );
		const scale = ( 1 - taper * along ) * lump;
		position.setXYZ( i, unitX * scale * radius, ( along - ( flatBase ? 0.22 : 0 ) ) * height, unitZ * scale * radius );
		// 朝上朝外的法线：照起来像一团柔软的树冠，不是多面体
		const inverse = 1 / Math.hypot( unitX, 0.55, unitZ );
		normals[ i * 3 ] = unitX * inverse;
		normals[ i * 3 + 1 ] = 0.55 * inverse;
		normals[ i * 3 + 2 ] = unitZ * inverse;
		heights[ i ] = along;

	}

	geometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'crown', new THREE.BufferAttribute( heights, 1 ) );
	geometry.computeBoundingSphere();
	return geometry;

}

function createForestMaterial() {

	const sky = state.world.uniforms;
	const uniforms = state.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '远景树林';
	material.fog = false;
	material.lights = false;

	const treeData = attribute( 'treeData', 'vec4' );    // rgb 树冠色（线性），w 随机数
	const treeBase = attribute( 'treeBase', 'vec3' );    // 树根的世界坐标

	// 按距离随机稀疏：t = (距离 − from) / (to − from)，随机数小于 t 的树收成一个点（positionLocal 已经乘过实例矩阵）
	const viewer = viewerPosition();
	const treeDistance = length( treeBase.sub( viewer ) );
	const thinning = treeDistance.sub( uniforms.forestFrom ).div( uniforms.forestTo.sub( uniforms.forestFrom ) );
	// 近处画 3D 树（tsl/trees.js）的那些，树团不画：这一棵在 near − band·cull 以内（3D 树那边是同一个判断，一棵树只画一种）
	const nearHandover = step( uniforms.treeNear.sub( uniforms.treeBand.mul( treeData.w ) ), treeDistance );
	const keep = step( thinning, treeData.w ).mul( state.toggles.树林显示 ).mul( mix( float( 1 ), nearHandover, uniforms.treeNearOn ) );
	material.positionNode = compressedPosition( positionLocal ).mul( keep ).add( viewer.mul( float( 1 ).sub( keep ) ) );

	material.colorNode = Fn( () => {

		// 大气透视按树的位置算（positionWorld 是压缩过深度的，距离不对；一棵树很小，用树根往上 5 米就够）
		const point = treeBase.add( vec3( 0, 5, 0 ) );
		const normal = normalize( uniforms.sceneToWorld.mul( vec4( normalWorld, 0 ) ).xyz );
		const crown = attribute( 'crown', 'float' );
		// 树冠底下暗、顶上亮
		const albedo = nightAlbedo( treeData.rgb.mul( crown.mul( 0.55 ).add( 0.55 ) ) );
		const sunShadow = terrainShadow( treeBase, uniforms.sunHorizon, sky.sunElevation, 1.3 );
		const moonShadow = terrainShadow( treeBase, uniforms.moonHorizon, sky.moonElevation, 3 );
		const surface = albedo.mul( lightAt( normal, sunShadow, moonShadow, crown.mul( 0.4 ).add( 0.6 ), 0.35 ) );
		return applyAtmosphere( surface, point, viewerPosition() );

	} )();

	return material;

}

// ===================== 谷雾（阶段 12 CP5）=====================
// 盆地上空几层水平的薄雾片（吉卜力背景那种一层层的雾，不是均匀的一整片）：成团（两层噪声，顺风慢慢飘），
// 碰到地面的地方变薄（按远景草地图里的地面高度，离地 2~18 米里淡出，不和山坡切出一道硬边）；
// 镜头在雾层以下、或者离镜头 150 米以内淡掉（飞进雾里不是一块平板）。浓淡跟着一天的贴地薄雾 mistAmount 走（白天没有），
// 颜色是这个方向上的大气色（朝太阳、月亮看前向散射亮一点）
function buildValleyMist() {

	const mistConfig = state.world.config.valleyMist;
	if ( ! mistConfig || ! state.grassGround ) return [];
	const sky = state.world.uniforms;
	const uniforms = state.uniforms;
	const grid = state.grassGround;
	const meshes = [];
	const width = ( grid.countX - 1 ) * grid.spacing;
	const depth = ( grid.countZ - 1 ) * grid.spacing;
	for ( const layer of mistConfig.layers ) {

		const geometry = new THREE.PlaneGeometry( width, depth, 1, 1 );
		geometry.rotateX( - Math.PI / 2 );
		geometry.translate( grid.minX + width / 2, layer.height, grid.minZ + depth / 2 );
		const material = new THREE.MeshBasicNodeMaterial();
		material.name = '谷雾';
		material.transparent = true;
		material.depthWrite = false;
		material.side = THREE.DoubleSide;
		material.fog = false;
		material.lights = false;
		material.positionNode = compressedPosition( positionLocal );
		material.colorNode = Fn( () => {

			const point = positionGeometry;
			const viewer = viewerPosition();
			// 成团：两层噪声（一格 260 米、70 米），顺风飘
			const drift = uniforms.cloudWind.mul( uniforms.time.mul( layer.drift ) );
			const large = noiseAt( 'large', point.xz.sub( drift ).add( layer.seed ) ).r;
			const medium = noiseAt( 'medium', point.xz.sub( drift.mul( 1.6 ) ).add( layer.seed * 1.7 ) ).g;
			const patches = smoothstep( layer.coverage[ 0 ], layer.coverage[ 1 ], large.mul( 0.65 ).add( medium.mul( 0.35 ) ) );
			// 碰到地面处变薄：离地 6 米以内没有、45 米才满（审查 R24：原来 2~18 米，雾层切过山坡的地方一块块蓝灰的斑，像低分辨率贴图）
			const ground = grassGroundAtWorld( point.xz ).height;
			const aboveGround = smoothstep( 6, 45, point.y.sub( ground ) );
			// 镜头在雾层以下看不见；离镜头 150 米以内淡掉
			const viewerAbove = smoothstep( layer.height + 4, layer.height + 50, viewer.y );
			const toPoint = point.sub( viewer );
			const distance = length( toPoint );
			const nearFade = smoothstep( 80, 220, distance );
			const amount = max( sky.mistAmount, mistConfig.minAmount ).mul( layer.density ).mul( patches ).mul( aboveGround ).mul( viewerAbove ).mul( nearFade ).mul( state.toggles.谷雾 );
			const direction = toPoint.div( max( distance, 1 ) );
			const sunForward = henyeyGreenstein( dot( direction, sky.sunDirection ), float( 0.55 ) );
			const moonForward = henyeyGreenstein( dot( direction, sky.moonDirection ), float( 0.55 ) );
			// 夜里大气色几乎是黑的：雾被月光照着，给一个月光色的底（月光的三成五），从高处往下看是一层层泛白的雾带
			const moonLit = sky.moonLightColor.mul( 0.35 ).add( sky.moonLightColor.mul( moonForward.mul( 0.1 ) ) );
			const mistColor = max( dayAerialColor( vec3( direction.x, 0.05, direction.z ).normalize(), sky ).mul( layer.brightness ), moonLit )
				.add( sky.sunLightColor.mul( sunForward.mul( 0.06 ) ) );
			return vec4( mistColor.mul( uniforms.surfaceGain ), amount );

		} )();
		const mesh = new THREE.Mesh( geometry, material );
		mesh.name = '谷雾';
		mesh.frustumCulled = false;
		mesh.renderOrder = 8;
		meshes.push( mesh );
		state.mistLayers.push( { mesh, height: layer.height } );
		state.disposables.push( geometry, material );

	}

	return meshes;

}

// ===================== 云团（阶段 12 CP5）=====================
// 天上几团有体积感的积云：每团几个朝镜头的大方片（公告板），片元里按噪声咬出棉花团的边、底部压平（积云是平底的），
// 朝太阳的一面亮、底下暗、逆着太阳看时边上一圈银边；远处溶进大气。只放在盆地东、南两面的山上空（西边是海和落日、北边是极光，都不放），
// 白天和黄昏才有（入夜淡掉，不挡哥特城堡的剪影和极光）。调试开关"云团"
function buildCloudClusters( tier ) {

	const clusterConfig = state.world.config.cloudClusters;
	if ( ! clusterConfig ) return [];
	const sky = state.world.uniforms;
	const uniforms = state.uniforms;
	const random = createRandom( 5151 );
	const [ centerX, centerZ ] = state.world.config.terrain.coreCenter;
	const clusterCount = clusterConfig.count[ tier ] || clusterConfig.count.mid;
	const clusterCenters = [];
	const puffData = [];
	const cornerData = [];
	const indices = [];
	let puffCount = 0;
	for ( let attempts = 0; clusterCenters.length < clusterCount && attempts < clusterCount * 40; attempts ++ ) {

		// 方位在允许的扇形里（从北顺时针），离盆地中心 radius 米，团和团至少隔 spacing 米
		const [ fromAzimuth, toAzimuth ] = clusterConfig.azimuth;
		const azimuth = ( fromAzimuth + random() * ( toAzimuth - fromAzimuth ) ) * degree;
		const distance = clusterConfig.radius[ 0 ] + Math.sqrt( random() ) * ( clusterConfig.radius[ 1 ] - clusterConfig.radius[ 0 ] );
		const x = centerX + Math.sin( azimuth ) * distance;
		const z = centerZ - Math.cos( azimuth ) * distance;
		if ( clusterCenters.some( ( item ) => Math.hypot( item[ 0 ] - x, item[ 1 ] - z ) < clusterConfig.spacing ) ) continue;
		clusterCenters.push( [ x, z ] );
		const base = clusterConfig.altitude[ 0 ] + random() * ( clusterConfig.altitude[ 1 ] - clusterConfig.altitude[ 0 ] );
		const width = clusterConfig.width[ 0 ] + random() * ( clusterConfig.width[ 1 ] - clusterConfig.width[ 0 ] );
		const axis = random() * Math.PI;
		const puffs = clusterConfig.puffs[ 0 ] + Math.floor( random() * ( clusterConfig.puffs[ 1 ] - clusterConfig.puffs[ 0 ] + 1 ) );
		for ( let k = 0; k < puffs; k ++ ) {

			// 沿团的长轴排开，中间的大、高，两头小、低（积云的馒头形）
			const along = ( puffs === 1 ? 0 : k / ( puffs - 1 ) - 0.5 ) + ( random() - 0.5 ) * 0.15;
			const middle = 1 - Math.min( 1, Math.abs( along ) * 2 );
			const size = clusterConfig.size[ 0 ] + ( clusterConfig.size[ 1 ] - clusterConfig.size[ 0 ] ) * ( 0.35 + 0.65 * middle ) * ( 0.75 + random() * 0.35 );
			const depthOffset = ( random() - 0.5 ) * width * 0.25;
			const puffX = x + Math.cos( axis ) * along * width - Math.sin( axis ) * depthOffset;
			const puffZ = z + Math.sin( axis ) * along * width + Math.cos( axis ) * depthOffset;
			const puffY = base + size * 0.42 + middle * width * 0.12 + random() * size * 0.15;
			const seed = random();
			for ( const [ cornerX, cornerY ] of [ [ - 1, - 1 ], [ 1, - 1 ], [ 1, 1 ], [ - 1, 1 ] ] ) {

				puffData.push( puffX, puffY, puffZ, size );
				cornerData.push( cornerX, cornerY, seed, base );

			}

			const first = puffCount * 4;
			indices.push( first, first + 1, first + 2, first, first + 2, first + 3 );
			puffCount ++;

		}

	}

	const positions = new Float32Array( puffCount * 4 * 3 );
	for ( let v = 0; v < puffCount * 4; v ++ ) positions.set( [ puffData[ v * 4 ], puffData[ v * 4 + 1 ], puffData[ v * 4 + 2 ] ], v * 3 );
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'puffData', new THREE.Float32BufferAttribute( puffData, 4 ) );
	geometry.setAttribute( 'puffCorner', new THREE.Float32BufferAttribute( cornerData, 4 ) );
	geometry.setIndex( indices );
	geometry.boundingSphere = new THREE.Sphere( new THREE.Vector3( centerX, 2000, centerZ ), 1e6 );

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '云团';
	material.transparent = true;
	material.depthWrite = false;
	material.fog = false;
	material.lights = false;
	const puff = attribute( 'puffData', 'vec4' );           // 中心 xyz（世界坐标）、方片边长（米）
	const corner = attribute( 'puffCorner', 'vec4' );       // 角（±1, ±1）、随机数、这一团的底（海拔）
	// 朝镜头的方片：视图空间里搭（同窗灯），远处按远景的深度压缩拉近
	const viewCenter = cameraViewMatrix.mul( modelWorldMatrix.mul( vec4( puff.xyz, 1 ) ) ).xyz;
	// 方片压扁成横的椭圆（0.62）：一片片圆的看着像棉花球，远处的云是一条条横的
	const viewPosition = viewCenter.add( vec3( corner.xy.mul( vec2( 1, 0.62 ) ).mul( puff.w ).mul( 0.5 ), 0 ) );
	const viewDistance = max( length( viewPosition ), 1e-3 );
	material.vertexNode = cameraProjectionMatrix.mul( vec4( viewPosition.mul( compressDistance( viewDistance ).div( viewDistance ) ), 1 ) );
	const cornerVarying = varying( corner.xy, 'cloudCorner' );
	const seedVarying = varying( corner.z, 'cloudSeed' );
	const heightVarying = varying( puff.y.add( corner.y.mul( puff.w ).mul( 0.31 ) ), 'cloudPointHeight' );
	const baseVarying = varying( corner.w, 'cloudBase' );
	const sizeVarying = varying( puff.w, 'cloudSize' );
	const centerVarying = varying( puff.xyz, 'cloudCenter' );

	material.colorNode = Fn( () => {

		const viewer = viewerPosition();
		// 形状：圆形往外淡，边被两层噪声咬成一团团的棉花边（每片按随机数取噪声贴图的不同地方）
		const radius = length( cornerVarying );
		const noiseUv = cornerVarying.mul( 0.45 ).add( vec2( seedVarying.mul( 7.3 ), seedVarying.mul( 3.1 ) ) );
		const lumps = texture( state.textures.noise, noiseUv ).r.mul( 0.5 ).add( texture( state.textures.noise, noiseUv.mul( 2.3 ).add( 0.37 ) ).g.mul( 0.3 ) )
			.add( texture( state.textures.noise, noiseUv.mul( 5.1 ).add( 0.71 ) ).r.mul( 0.2 ) );
		// 边咬得深一点（不是一个个圆盘），里面实
		const shape = float( 1 ).sub( smoothstep( 0.45, 1.0, radius.add( lumps.sub( 0.5 ).mul( 1.1 ) ) ) );
		// 平底：这一团的底往上 18% 片高里慢慢长出来
		const flatBottom = smoothstep( baseVarying.sub( 15 ), baseVarying.add( sizeVarying.mul( 0.18 ) ), heightVarying );
		// 光照：方片当成球面的一块，法线从角的位置算（视图空间 → 场景 → 世界），再往世界的上方掰三成半：
		// 逆着太阳看时整片球面的中间都背光，只剩一圈亮边，一团团像甜甜圈（2026-10-02 自查）；云是上亮下暗
		const viewNormal = normalize( vec3( cornerVarying.mul( 0.85 ), 0.55 ) );
		const sceneNormal = vec4( viewNormal, 0 ).mul( cameraViewMatrix ).xyz;
		const worldNormal = normalize( mix( normalize( uniforms.sceneToWorld.mul( vec4( sceneNormal, 0 ) ).xyz ), vec3( 0, 1, 0 ), 0.35 ) );
		const sunWrap = max( dot( worldNormal, sky.sunDirection ).add( 0.45 ).div( 1.45 ), 0 );
		const heightShade = mix( float( 0.45 ), float( 1.05 ), smoothstep( baseVarying, baseVarying.add( sizeVarying.mul( 1.1 ) ), heightVarying ) );
		const toCenter = centerVarying.sub( viewer );
		const centerDistance = max( length( toCenter ), 1 );
		// 逆着太阳看时整团透亮（Henyey–Greenstein 前向散射，g = 0.6），薄的边（形状淡的地方）多一点
		const silver = henyeyGreenstein( dot( toCenter.div( centerDistance ), sky.sunDirection ), float( 0.6 ) ).mul( float( 1 ).sub( shape ).mul( 0.5 ).add( 0.5 ) ).mul( 0.22 );
		const ambient = mix( sky.horizonColor, sky.zenithColor, 0.5 ).mul( sky.skyIntensity ).mul( 0.95 );
		// 太阳很低时背着太阳那边的云暗一些（地球的影子升上来了），不然黄昏回身看是一团团发亮的粉棉花
		const towardSun = dot( toCenter.div( centerDistance ).xz, normalize( sky.sunDirection.xz.add( vec2( 1e-4, 0 ) ) ) ).mul( 0.5 ).add( 0.5 );
		const highSun = smoothstep( 4, 12, sky.sunElevation );
		const duskDim = mix( mix( float( 0.45 ), float( 1 ), towardSun ), float( 1 ), highSun );
		const lit = uniforms.cloudSunColor.mul( sunWrap.mul( 0.75 ).add( silver ) ).add( ambient ).mul( heightShade ).mul( duskDim );
		// 大气透视：按团中心算（一片里颜色一致，不会一块块的）
		const colorOut = applyAtmosphere( lit, centerVarying, viewer );
		// 白天、黄昏有，入夜淡掉；镜头离得很近（飞行时）淡掉，不贴脸看到一张大方片
		const dayAmount = smoothstep( 0.08, 0.35, sky.skyIntensity );
		const nearFade = smoothstep( 250, 900, centerDistance );
		// 很远的团淡一些（地平线上一排一样亮的小团像贴纸，落日回身看时最明显）
		const farFade = mix( float( 1 ), float( 0.55 ), smoothstep( 4000, 9000, centerDistance ) );
		// 黄昏背着太阳的团也淡下去（落日的天比统一天空暗，亮的小团浮在上面像贴纸）
		const duskFade = mix( mix( float( 0.2 ), float( 1 ), pow( towardSun, 1.5 ) ), float( 1 ), highSun );
		const alpha = shape.mul( flatBottom ).mul( dayAmount ).mul( nearFade ).mul( farFade ).mul( duskFade ).mul( 0.93 ).mul( state.toggles.云团 );
		return vec4( colorOut, alpha );

	} )();

	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = '云团';
	mesh.frustumCulled = false;
	mesh.renderOrder = 3;
	state.cloudClusterMesh = mesh;
	state.disposables.push( geometry, material );
	console.log( `远景：云团 ${ clusterCenters.length } 团、${ puffCount } 片` );
	return [ mesh ];

}

// ===================== 树林布点的离线烘焙（scripts/bake-forest.mjs）=====================
// 树表每棵 10 个 32 位浮点：x、y、z、size、tint、yaw、cull、树种序号、变体、种类（0 林子 1 林缘 2 草甸 3 河岸）。
// 指纹 forestHash：布点用到的全部配置（世界、树、花园）+ 烘焙地形的指纹；配置一改就对不上，退回当场算
const forestKinds = [ 'forest', 'edge', 'meadow', 'river' ];

function speciesNamesOf( treeConfig ) {

	return Object.keys( treeConfig.species );

}

export function forestHash() {

	const config = state.ctx.config;
	const bake = getManifest( 'terrain' );
	// 只算影响布点的：地形形状、地点、航线（窄处的走廊和加密）、水系、山洞、地形网格、树、花园；飞行速度、天色这些不算
	const world = config.world;
	const text = JSON.stringify( { terrainShape: world.terrainShape, locations: world.locations, legs: world.legs, lake: world.lake, rivers: world.rivers, cave: world.cave, terrain: world.terrain,
		trees: config.trees, garden: config.garden, terrainBake: bake ? bake.hash : null, version: 2 } );
	let hash = 2166136261;
	for ( let i = 0; i < text.length; i ++ ) {

		hash ^= text.charCodeAt( i );
		hash = Math.imul( hash, 16777619 );

	}

	return ( hash >>> 0 ).toString( 16 );

}

async function loadBakedForest( forestKey, speciesNames ) {

	const manifest = getManifest( 'forest' );
	if ( ! manifest ) {

		console.warn( '远景：没有烘焙的树林布点（assets/opt/forest），当场算；跑一下 node scripts/bake-forest.mjs' );
		return null;

	}

	const currentHash = forestHash();
	if ( manifest.hash !== currentHash ) {

		console.warn( `远景：烘焙的树林布点和现在的配置对不上（烘焙时 ${ manifest.hash }，现在 ${ currentHash }），当场算；重跑 node scripts/bake-forest.mjs` );
		return null;

	}

	const entry = ( manifest.files || [] ).find( ( item ) => item.id === 'forest-' + forestKey );
	const blob = entry ? await blobOf( 'forest', entry.id ) : null;
	if ( ! blob ) {

		console.warn( `远景：树林布点的数据块 forest-${ forestKey } 没读到，当场算` );
		return null;

	}

	const buffer = await gunzipToArrayBuffer( blob );
	const data = new Float32Array( buffer );
	const items = [];
	for ( let i = 0; i + 9 < data.length; i += 10 ) {

		const species = speciesNames[ Math.round( data[ i + 7 ] ) ];
		if ( ! species ) {

			console.warn( '远景：烘焙的树林布点里有不认识的树种序号，当场算' );
			return null;

		}

		items.push( { x: data[ i ], y: data[ i + 1 ], z: data[ i + 2 ], size: data[ i + 3 ], tint: data[ i + 4 ], yaw: data[ i + 5 ], cull: data[ i + 6 ], species, variant: Math.round( data[ i + 8 ] ), kind: forestKinds[ Math.round( data[ i + 9 ] ) ] } );

	}

	console.log( `远景：树林布点用烘焙的（${ forestKey }），${ items.length } 棵` );
	return items;

}

// 烘焙脚本用：把这一次布出来的树表打成 10 个浮点一棵
export function dumpForest() {

	const plan = state.plannedForest;
	if ( ! plan ) return null;
	const speciesNames = speciesNamesOf( state.ctx.config.trees );
	const data = new Float32Array( plan.items.length * 10 );
	plan.items.forEach( ( item, index ) => data.set( [ item.x, item.y, item.z, item.size, item.tint, item.yaw, item.cull, speciesNames.indexOf( item.species ), item.variant, Math.max( 0, forestKinds.indexOf( item.kind ) ) ], index * 10 ) );
	return { key: plan.key, hash: forestHash(), data };

}

// ===================== 远处的树：替身卡片 =====================
// 图集由 scripts/bake-foliage.mjs 烘（assets/opt/foliage）。交接、按距离稀疏的规则和树团（createForestMaterial）一样；
// 光照和树团一样（地形阴影按树根查、夜里的反照率、大气透视），法线来自图集
async function buildImpostorForest( items ) {

	const manifest = getManifest( 'foliage' );
	if ( ! manifest ) {

		console.warn( '远景：没有树的替身图集（assets/opt/foliage），远处画树团；跑一下 node scripts/bake-foliage.mjs' );
		return null;

	}

	const treeConfig = state.ctx.config.trees;
	const currentHash = treeSpeciesHash( treeConfig.species, treeConfig.variants );
	if ( manifest.hash !== currentHash ) {

		console.warn( `远景：树的替身图集和现在的树种配置对不上（烘焙时 ${ manifest.hash }，现在 ${ currentHash }），远处画树团；重跑 node scripts/bake-foliage.mjs` );
		return null;

	}

	const [ colorTexture, normalTexture ] = await Promise.all( [
		loadTexture( 'foliage', 'impostor-color', { colorSpace: THREE.NoColorSpace } ),
		loadTexture( 'foliage', 'impostor-normal', { colorSpace: THREE.NoColorSpace } ),
	] );
	if ( ! colorTexture || ! normalTexture ) {

		console.warn( '远景：树的替身图集读不出来，远处画树团' );
		if ( colorTexture ) colorTexture.dispose();
		if ( normalTexture ) normalTexture.dispose();
		return null;

	}

	for ( const item of [ colorTexture, normalTexture ] ) {

		item.wrapS = THREE.ClampToEdgeWrapping;
		item.wrapT = THREE.ClampToEdgeWrapping;
		state.disposables.push( item );

	}

	const sky = state.world.uniforms;
	const uniforms = state.uniforms;
	const result = createImpostorForest( {
		// 焦点樱花树没有自己的替身图，远处借花树第一个变体那一张；nearScale：这个树种画 3D 的距离比例（交接要和近处的树对上）
		items: items.map( ( item ) => ( item.species === 'focal' ? { ...item, species: 'blossom', variant: 0, nearScale: 1 } : { ...item, nearScale: speciesNearScale( item.species ) } ) ),
		manifest,
		textures: { color: colorTexture, normal: normalTexture },
		viewer: viewerPosition(),
		place: ( point ) => compressedPosition( point ),
		// 和树团同一个判断：按距离随机稀疏（随机数小于稀疏比例的收掉）、近处画 3D 的那些不画、调试开关
		keep: ( base, cull, distance, nearScale ) => {

			const thinning = distance.sub( uniforms.forestFrom ).div( uniforms.forestTo.sub( uniforms.forestFrom ) );
			const nearHandover = step( uniforms.treeNear.mul( nearScale ).sub( uniforms.treeBand.mul( cull ) ), distance );
			return step( thinning, cull ).mul( state.toggles.树林显示 ).mul( mix( float( 1 ), nearHandover, uniforms.treeNearOn ) );

		},
		// 地形阴影、大气透视每棵树不变，替身在顶点里按树根算一次（applyAtmosphere 对颜色是仿射的：表面色只经过乘亮度增益和几次 mix）
		shadowsAt: ( base ) => vec2( terrainShadow( base, uniforms.sunHorizon, sky.sunElevation, 1.3 ), terrainShadow( base, uniforms.moonHorizon, sky.moonElevation, 3 ) ),
		atmosphere: ( surface, base ) => applyAtmosphere( surface, base.add( vec3( 0, 5, 0 ) ), viewerPosition() ),
		shade: ( albedo, normal, shadows ) => nightAlbedo( albedo ).mul( lightAt( normal, shadows.x, shadows.y, float( 0.85 ), 0.35 ) ),
	} );
	state.disposables.push( result.geometry, result.material );
	if ( result.missing.length ) console.warn( `远景：替身图集里没有树种 ${ result.missing.join( '、' ) }，这些树远处不画` );
	console.log( `远景：远处的树画替身卡片 ${ result.count } 张（图集 ${ manifest.templates.length } 个模板 × ${ manifest.views } 个方位）` );
	return result.mesh;

}

// 地点自己的花树（花园草坪上的花树、开场夹岸的桃林；2026-10-02 用户："这种树全部换掉"——原来是 tsl/blossom.js 的直棍树枝 + 散开的星形小花）：
// 和远景花树同一套樱花模型（树干 + 程序化花簇）、同一种光照，种在给的世界坐标上，按镜头位置挑实例，near 米以内画 3D
// （地点里一路都看得到，不交给替身卡片）。items：[{ x, y, z（世界坐标，y 是树根）, size, yaw, tint }]；
// options：{ near（米）, colors（三调，缺省用花树的）, cards、cell（花簇，缺省用花树的）, name,
//   reflectWater（可选）：地点自己的水面 { level（倒影平面的世界高度）, capsules（世界 xz 上的胶囊）, slack（弧度）}，见 trees.js createTreeField }。
// 模型读不到返回 null（调用方退回原来的程序化花树）。返回 { group, toggle（调试开关的 uniform）, count,
//   setReflection( on )（倒影 pass 前 true、画完 false：倒影里只画倒影可能落进水面的那些）, dispose() }
export async function createLocationBlossoms( items, options = {} ) {

	if ( ! state.ready || ! state.treeUniforms ) return null;
	const spec = state.ctx.config.trees.species.blossom;
	if ( ! spec || ! spec.models ) return null;
	const variantCount = spec.forms ? spec.forms.length : state.ctx.config.trees.variants;
	const built = await buildModelBlossomTemplates( { ...spec, models: { ...spec.models, cards: options.cards ?? spec.models.cards, cell: options.cell ?? spec.models.cell } }, variantCount );
	if ( ! built ) return null;
	const near = uniform( options.near ?? 400 );
	const toggle = uniform( 1 );
	const uniforms = { ...state.treeUniforms, near, band: uniform( 0 ), toggle };
	const colors = options.colors || spec.colors;
	const palette = { dark: color( colors[ 0 ] ), mid: color( colors[ 1 ] ), light: color( colors[ 2 ] ) };
	const name = options.name || '地点的花树';
	if ( built.barkMap ) {

		built.barkMap.wrapS = THREE.RepeatWrapping;
		built.barkMap.wrapT = THREE.RepeatWrapping;

	}

	const materials = {
		blossom: {
			leaves: createLeafMaterial( { name: name + '·花', palette, uniforms, shade: state.treeShade, style: 'blossom' } ),
			bark: createBarkMaterial( { name: name + '·树皮', barkColor: color( spec.bark ), barkTexture: built.barkMap || null, uniforms, shade: state.treeShade } ),
		},
	};
	const random = createRandom( 7207 + items.length );
	const fieldItems = items.map( ( item ) => ( { ...item, cull: 0, species: 'blossom', variant: Math.floor( random() * variantCount ) } ) );
	const field = createTreeField( {
		items: fieldItems,
		templates: { blossom: built.templates },
		materials,
		settings: { near, band: uniform( 0 ), refreshDistance: 6, maxPerMesh: state.ctx.config.trees.maxPerMesh, view: treeViewSettings() },
		uniforms,
		reflectWater: options.reflectWater || null,
	} );
	field.group.name = name;
	state.root.add( field.group );
	field.update( state.skyDome ? state.skyDome.position : new THREE.Vector3(), true );
	state.locationTrees.add( field );
	let triangles = 0;
	for ( const template of built.templates ) triangles += ( template.bark.index.count + template.leaves.index.count ) / 3;
	console.log( `远景：${ name } ${ items.length } 棵（樱花模型，${ variantCount } 个变体，平均每棵 ${ ( triangles / variantCount ).toFixed( 0 ) } 个三角形），${ near.value } 米以内画 3D` );
	return {
		group: field.group,
		toggle,
		count: items.length,
		setReflection: ( on ) => field.setReflection( on ),
		dispose() {

			state.locationTrees.delete( field );
			if ( field.group.parent ) field.group.parent.remove( field.group );
			field.dispose();
			materials.blossom.leaves.dispose();
			materials.blossom.bark.dispose();
			if ( built.barkMap ) built.barkMap.dispose();

		},
	};

}

// 某个树种画 3D 的距离比例（config.trees.species[名].models.near，默认 1）
function speciesNearScale( name ) {

	const spec = state.ctx.config.trees.species[ name ];
	return spec && spec.models && spec.models.near ? spec.models.near : 1;

}

// 近处的树按镜头朝向挑（config.perf.trees，度换成弧度；createTreeField 的 settings.view）。没配或者关了返回 null（只按距离挑）
function treeViewSettings() {

	const perfTrees = state.ctx.config.perf ? state.ctx.config.perf.trees : null;
	if ( ! perfTrees ) {

		console.warn( '远景：config.perf.trees 没配，近处的树不按朝向挑（四面八方都画）' );
		return null;

	}

	if ( ! perfTrees.viewCulling ) return null;
	const degree = Math.PI / 180;
	return { closeRadius: perfTrees.closeRadius, extraAngle: ( perfTrees.dragAngle + perfTrees.marginAngle ) * degree, turnAngle: perfTrees.turnAngle * degree };

}

// ===================== 近处的 3D 树 =====================
// 树种（config.trees.species）× 变体的模板（tsl/trees.js 生成）；光照、大气和远景的树团一样（地形阴影按树根查）
async function buildNearTrees( ctx, tier, slice ) {

	const treeConfig = ctx.config.trees;
	const uniforms = state.uniforms;
	const sky = state.world.uniforms;
	const speciesNames = [ ...new Set( state.forestItems.map( ( item ) => item.species ) ) ];
	if ( speciesNames.length === 0 ) return null;
	const barkTexture = await loadTexture( 'textures', 'bark_willow_02-diff', { colorSpace: THREE.SRGBColorSpace, anisotropy: tier === 'hi' ? 4 : 2 } );
	if ( barkTexture ) state.disposables.push( barkTexture );
	else console.warn( '远景：树皮贴图没读到，树皮用纯色' );

	const treeUniforms = {
		time: uniforms.time,
		near: uniforms.treeNear,
		band: uniforms.treeBand,
		sceneToWorld: uniforms.sceneToWorld,
		viewer: viewerPosition(),
		toggle: state.toggles.近处树,
		sunDirection: sky.sunDirection,
		sunColor: sky.sunLightColor,
		night: fadeOut( 0.1, 0.5, sky.skyIntensity ),
	};
	// 光照：和远景树团同一套（地形阴影按树根查、夜里的反照率、大气透视）
	const shade = ( albedo, normal, point, { skyView, wrap, base } ) => {

		const sunShadow = terrainShadow( base, uniforms.sunHorizon, sky.sunElevation, 1.3 );
		const moonShadow = terrainShadow( base, uniforms.moonHorizon, sky.moonElevation, 3 );
		const surface = nightAlbedo( albedo ).mul( lightAt( normal, sunShadow, moonShadow, skyView, wrap ) );
		return applyAtmosphere( surface, point, viewerPosition() );

	};

	// 地点自己的花树（createLocationBlossoms）用同一套光照
	state.treeUniforms = treeUniforms;
	state.treeShade = shade;
	const templates = {};
	const materials = {};
	let triangles = 0;
	// 焦点樱花树：模型的树干 + 程序化花簇（花卡、颜色用花树那一套）；模型读不到就把这几棵当普通花树种
	if ( speciesNames.includes( 'focal' ) ) {

		const focalConfig = treeConfig.focal;
		const blossomSpec = { ...treeConfig.species.blossom, ...treeConfig.species.blossom.forms[ 0 ], cell: focalConfig.cell };
		templates.focal = [];
		let barkMap = null;
		for ( const [ index, id ] of focalConfig.models.entries() ) {

			const loaded = await loadBlossomModel( id );
			if ( ! loaded ) {

				console.warn( `远景：焦点樱花树模型 ${ id } 没读到或者没有花位，这一棵种成普通花树` );
				templates.focal.push( buildSpeciesTemplates( 'blossom', treeConfig.species.blossom, treeConfig.variants )[ index % treeConfig.species.blossom.forms.length ] );
				continue;

			}

			if ( loaded.barkMap ) {

				if ( ! barkMap ) barkMap = loaded.barkMap;
				else loaded.barkMap.dispose();

			}

			const template = buildFocalTemplate( loaded.bark, loaded.points, blossomSpec, 700 + index * 31 );
			triangles += ( template.bark.index.count + template.leaves.index.count ) / 3;
			console.log( `远景：焦点樱花树 ${ id }，花簇 ${ template.clumps } 团、高 ${ template.height.toFixed( 1 ) } 米，${ ( ( template.bark.index.count + template.leaves.index.count ) / 3 ).toFixed( 0 ) } 三角` );
			templates.focal.push( template );

		}

		if ( barkMap ) {

			barkMap.wrapS = THREE.RepeatWrapping;
			barkMap.wrapT = THREE.RepeatWrapping;
			state.disposables.push( barkMap );

		}

		const palette = { dark: color( blossomSpec.colors[ 0 ] ), mid: color( blossomSpec.colors[ 1 ] ), light: color( blossomSpec.colors[ 2 ] ) };
		materials.focal = {
			leaves: createLeafMaterial( { name: '近处的树·焦点樱花·花', palette, uniforms: treeUniforms, shade, style: 'blossom' } ),
			bark: createBarkMaterial( { name: '近处的树·焦点樱花·树皮', barkColor: color( blossomSpec.bark ), barkTexture: barkMap || barkTexture, uniforms: treeUniforms, shade } ),
		};
		state.disposables.push( materials.focal.leaves, materials.focal.bark );

	}

	for ( const name of speciesNames ) {

		if ( name === 'focal' ) continue;
		const spec = treeConfig.species[ name ];
		if ( ! spec ) throw new Error( `远景：config.trees.species 里没有树种「${ name }」` );
		// 花树（spec.models）：樱花模型的树干 + 程序化花簇，模型读不到退回程序化的树形
		let speciesBarkTexture = barkTexture;
		const modelBuilt = spec.models ? await buildModelBlossomTemplates( spec, spec.forms ? spec.forms.length : treeConfig.variants ) : null;
		if ( spec.models && ! modelBuilt ) console.warn( `远景：树种「${ name }」的模型一个都没读到，用程序化的树形` );
		if ( modelBuilt ) {

			templates[ name ] = modelBuilt.templates;
			if ( modelBuilt.barkMap ) {

				modelBuilt.barkMap.wrapS = THREE.RepeatWrapping;
				modelBuilt.barkMap.wrapT = THREE.RepeatWrapping;
				state.disposables.push( modelBuilt.barkMap );
				speciesBarkTexture = modelBuilt.barkMap;

			}

		} else templates[ name ] = buildSpeciesTemplates( name, spec, treeConfig.variants );
		for ( const template of templates[ name ] ) triangles += ( template.bark.index.count + template.leaves.index.count ) / 3;
		await yieldIfBusy( slice );

		// 这个树种画 3D 的距离（近处的树的 near 乘 nearScale）：模型花树三角多、花园四周又一千多棵，只在近一些的地方画 3D
		const speciesUniforms = speciesNearScale( name ) < 1 ? { ...treeUniforms, near: uniforms.treeNear.mul( speciesNearScale( name ) ) } : treeUniforms;
		const palette = { dark: color( spec.colors[ 0 ] ), mid: color( spec.colors[ 1 ] ), light: color( spec.colors[ 2 ] ) };
		materials[ name ] = {
			leaves: createLeafMaterial( { name: '近处的树·' + name + '·树叶', palette, uniforms: speciesUniforms, shade, style: spec.cardStyle || 'leaf' } ),
			bark: createBarkMaterial( { name: '近处的树·' + name + '·树皮', barkColor: color( spec.bark ), barkTexture: speciesBarkTexture, uniforms: speciesUniforms, shade } ),
		};
		state.disposables.push( materials[ name ].leaves, materials[ name ].bark );

	}

	// 林下（MegaKit 的灌木、蕨、花丛、草丛）：读得到几种就用几种，一种都没有就不建
	const understoryConfig = treeConfig.understory;
	const understoryKinds = [];
	for ( const [ name, kind ] of Object.entries( understoryConfig.kinds ) ) {

		const object = await loadModel( 'models', kind.model );
		if ( ! object ) continue;
		understoryKinds.push( { name, object, tint: color( kind.tint ), keepHue: kind.keepHue, upright: kind.upright } );
		await yieldIfBusy( slice );

	}

	let understory = null;
	if ( understoryKinds.length > 0 ) {

		const layer = createUnderstoryLayer( {
			kinds: understoryKinds,
			uniforms: { ...treeUniforms, near: uniforms.understoryNear, toggle: state.toggles.林下灌木 },
			shade,
			maxPerMesh: treeConfig.maxPerMesh,
		} );
		// 模型里的几何体已经复制进实例网格，原来的模型（连贴图以外的部分）释放；贴图实例网格还在用，留着
		for ( const kind of understoryKinds ) {

			kind.object.traverse( ( child ) => {

				if ( child.isMesh ) child.geometry.dispose();

			} );
			kind.object.traverse( ( child ) => {

				if ( child.isMesh && child.material && child.material.map ) state.disposables.push( child.material.map );

			} );

		}

		// 林间小路的路面上不撒（路两边的树按规则往周围撒灌木、蕨，会撒到路上）
		const blocked = ( x, z ) => {

			for ( const path of state.trailPaths || [] ) {

				for ( const sample of path.samples ) if ( Math.abs( sample.x - x ) < path.halfWidth + 1.5 && Math.abs( sample.z - z ) < path.halfWidth + 1.5 && Math.hypot( sample.x - x, sample.z - z ) < path.halfWidth ) return true;

			}

			return false;

		};
		understory = { layer, near: uniforms.understoryNear, rules: understoryConfig.rules, groundAt: ( x, z ) => terrainHeightAt( x, z ), blocked };
		console.log( `远景：林下 ${ understoryKinds.map( ( kind ) => kind.name ).join( '、' ) }，${ uniforms.understoryNear.value } 米以内` );

	} else {

		console.warn( '远景：林下的模型一个都没读到，不撒灌木' );

	}

	const field = createTreeField( {
		items: state.forestItems,
		templates,
		materials,
		settings: { near: uniforms.treeNear, band: uniforms.treeBand, refreshDistance: treeConfig.refreshDistance, maxPerMesh: treeConfig.maxPerMesh, nearScale: speciesNearScale, view: treeViewSettings() },
		uniforms: treeUniforms,
		understory,
	} );
	if ( understory ) field.group.add( understory.layer.group );
	state.disposables.push( field );
	const templateCount = Object.values( templates ).reduce( ( sum, list ) => sum + list.length, 0 );
	console.log( `远景：近处的树 ${ speciesNames.map( ( name ) => name + ' ' + templates[ name ].length ).join( '、' ) } 个变体，平均每棵 ${ ( triangles / templateCount ).toFixed( 0 ) } 个三角形，${ uniforms.treeNear.value } 米以内画 3D` );
	return field;

}

// ===================== 草地图（阶段 12 CP3 返工）=====================
// 地点里的草长出地点自己的地面以后落在远景网格上：每个核心网格点一组（高度、长草的密度、法线 x、法线 z），RGBA 32 位浮点。
// 着色器里用 textureLoad 取四个格点，高度按网格同一条对角线三角插值（gridHeight），和画出来的地面完全一样，草不会浮着或埋进去
async function buildGrassGround( slice ) {

	const core = state.core;
	const world = state.world;
	const { countX, countZ, minX, minZ, spacing } = core;
	const data = new Float32Array( countX * countZ * 4 );
	const normal = new THREE.Vector3();
	for ( let j = 0; j < countZ; j ++ ) {

		for ( let i = 0; i < countX; i ++ ) {

			const index = j * countX + i;
			const x = minX + i * spacing;
			const z = minZ + j * spacing;
			gridNormal( core, i, j, normal );
			// 长草的地方：不在水里、水边（河岸 R 通道 0.5）、不是雪原台地、不是海边沙滩、不在高山上。
			// 裸岩、陡坡不在这里按顶点算：烘焙的岩石外露 4 米一格、坡上一格一个样，按 8 米的顶点取再双线性插值，
			// 草地上就是一块块三角形的秃斑（2026-10-02 用户："洞口刚出来草地是三角形的"）。改在着色器里按每根草的位置、
			// 用和地形着色同一个岩石算法挖掉（见 grassGroundAtWorld）
			let density = smoothJs( - 0.6, - 2.5, core.depths[ index ] );
			density *= 1 - smoothJs( 0.3, 0.45, biomeAt( x, z, 0 ) );
			density *= 1 - Math.min( 1, core.plateau[ index ] );
			density *= 1 - smoothJs( 0.35, 0.75, core.seaProximity[ index ] );
			density *= smoothJs( 520, 430, core.heights[ index ] );
			// 湖岸 1.03 倍以内：远景在那里把顶点往下沉（让哥特自己的湖面盖上去），草按没沉的高度放会浮在湖上
			if ( world.lakeRadius( x, z ) < 1.03 ) density = 0;
			data[ index * 4 ] = core.heights[ index ];
			data[ index * 4 + 1 ] = density;
			data[ index * 4 + 2 ] = normal.x;
			data[ index * 4 + 3 ] = normal.z;

		}

		await yieldIfBusy( slice );

	}

	const texture = new THREE.DataTexture( data, countX, countZ, THREE.RGBAFormat, THREE.FloatType );
	texture.magFilter = THREE.NearestFilter;
	texture.minFilter = THREE.NearestFilter;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;
	texture.name = '远景草地图';
	return { texture, countX, countZ, minX, minZ, spacing };

}

// 世界坐标 xz 处远景地面的（高度、长草的密度、世界法线）——着色器节点；出了核心区密度是 0
function grassGroundAtWorld( worldXZ ) {

	const grid = state.grassGround;
	const cell = worldXZ.sub( vec2( grid.minX, grid.minZ ) ).div( grid.spacing );
	const inside = step( 0, cell.x ).mul( step( 0, cell.y ) ).mul( step( cell.x, grid.countX - 1 ) ).mul( step( cell.y, grid.countZ - 1 ) );
	const base = clamp( floor( cell ), vec2( 0, 0 ), vec2( grid.countX - 2, grid.countZ - 2 ) );
	const fraction = clamp( cell.sub( base ), 0, 1 ).toVar();
	const index = ivec2( base );
	const near = textureLoad( grid.texture, index ).toVar();
	const nearRight = textureLoad( grid.texture, index.add( ivec2( 1, 0 ) ) ).toVar();
	const far = textureLoad( grid.texture, index.add( ivec2( 0, 1 ) ) ).toVar();
	const farRight = textureLoad( grid.texture, index.add( ivec2( 1, 1 ) ) ).toVar();
	// 高度：和 gridHeight 同一条对角线（从 (i, j+1) 连到 (i+1, j)）三角插值
	const lowerHeight = near.x.add( nearRight.x.sub( near.x ).mul( fraction.x ) ).add( far.x.sub( near.x ).mul( fraction.y ) );
	const upperHeight = farRight.x.add( far.x.sub( farRight.x ).mul( float( 1 ).sub( fraction.x ) ) ).add( nearRight.x.sub( farRight.x ).mul( float( 1 ).sub( fraction.y ) ) );
	// 两个三角形都算、按权重混（不能用 select：TSL 会把它编成 if / else，四个角的取样只在先用到它们的那个分支里赋值，
	// 另一个分支读到的是没赋值的变量——每个格子上半个三角形的草高度全错、整片不见，2026-10-02 用户："洞口刚出来草地是三角形的"）
	const height = mix( upperHeight, lowerHeight, step( fraction.x.add( fraction.y ), 1 ) );
	// 密度、法线双线性
	const blended = mix( mix( near, nearRight, fraction.x ), mix( far, farRight, fraction.x ), fraction.y );
	const normal = normalize( vec3( blended.z, sqrt( max( float( 1 ).sub( blended.z.mul( blended.z ) ).sub( blended.w.mul( blended.w ) ), 0.01 ) ), blended.w ) );
	// 看得见的岩石上不长草：和远景地形着色同一个算法（烘焙的岩石外露 + 中尺度斑块扰动；核心区外按坡度），按这一根草的位置取，
	// 草的边界就是地面上岩石和草甸的边界。在顶点着色器里也会用到，贴图都按第 0 级取
	const uniforms = state.uniforms;
	const mediumPatch = texture( state.textures.noise, noiseUv( 'medium', worldXZ ) ).level( 0 ).g;
	const rockExposure = texture( state.textures.surface.texture, worldXZ.mul( uniforms.surfaceScale ).add( uniforms.surfaceOffset ) ).level( 0 ).b;
	const rockBySlope = smoothstep( 0.38, 0.6, float( 1 ).sub( normal.y ).add( mediumPatch.sub( 0.5 ).mul( 0.22 ) ) );
	const rockBaked = smoothstep( 0.25, 0.75, rockExposure.add( mediumPatch.sub( 0.5 ).mul( 0.3 ) ) );
	const rock = mix( rockBySlope, rockBaked, uniforms.bakedSurface.mul( uniforms.insideCore( vec3( worldXZ.x, 0, worldXZ.y ) ) ) );
	return { height, density: blended.y.mul( inside ).mul( float( 1 ).sub( smoothstep( 0.1, 0.45, rock ) ) ), normal };

}

// 烘焙地形的"适合长树"（surface-b 的 A 通道：缓坡、不在岩石和水里、汇水多的地方高）；没有烘焙时 1
function bakedForestAt( x, z ) {

	const bake = state.ctx.terrainBake;
	if ( ! bake || ! bake.surfaceB || ! bake.grid ) return 1;
	const grid = bake.grid;
	const i = Math.round( ( x - grid.minX ) / grid.spacing );
	const j = Math.round( ( z - grid.minZ ) / grid.spacing );
	if ( i < 0 || j < 0 || i >= grid.width || j >= grid.height ) return 1;
	return bake.surfaceB[ ( j * grid.width + i ) * 4 + 3 ] / 255;

}

// 不种树的地方：每个地点脚下 150 米（地点自己有近景）、小镇的每座房子，以及几条要留出来的视线
// （落日回身看崖上的哥特城堡和花园城堡、星月夜看湖和小镇、哥特机位看城堡、花园看城堡），视线两侧各 30 米
function treeClearings( world ) {

	const locations = world.locations;
	// 每个地点只让开自己脚下和朝向的扇形（见 config.trees.clearRadius；原来一律 150 米整圈清空，站在花园里四周什么都没有）
	const clearRadius = state.ctx.config.trees.clearRadius;
	const circles = [];
	const sectors = [];
	for ( const [ key, location ] of Object.entries( locations ) ) {

		const setting = clearRadius[ key ] ?? 150;
		if ( typeof setting === 'number' ) {

			circles.push( [ location.origin[ 0 ], location.origin[ 2 ], setting ] );
			continue;

		}

		circles.push( [ location.origin[ 0 ], location.origin[ 2 ], setting.around ] );
		// 朝向：本地 −z 在世界里的方位角 yaw（从北顺时针）→ 世界 (sin, −cos)
		const yaw = location.yaw * degree;
		sectors.push( { x: location.origin[ 0 ], z: location.origin[ 2 ], radius: setting.ahead, directionX: Math.sin( yaw ), directionZ: - Math.cos( yaw ), cosine: Math.cos( setting.halfAngle * degree ) } );

	}

	for ( const [ houseX, houseZ, radius ] of state.houseFootprints ) circles.push( [ houseX, houseZ, radius + 4 ] );
	// 哥特城堡的地基（城堡约 150 米长、横着摆）：台顶上城堡那一块不种
	circles.push( [ locations.gothic.landmark[ 0 ], locations.gothic.landmark[ 2 ], 78 ] );
	for ( const corridor of state.corridors ) circles.push( corridor );
	const lakeCenter = [ world.config.lake.center[ 0 ], world.config.lake.level, world.config.lake.center[ 1 ] ];
	const sightlines = [
		[ locations.sunset.origin, locations.gothic.landmark ],
		[ locations.sunset.origin, locations.garden.landmark ],
		[ locations.starry.origin, locations.starry.landmark ],
		[ locations.starry.origin, locations.gothic.landmark ],
		[ locations.starry.origin, lakeCenter ],
		[ locations.gothic.origin, locations.gothic.landmark ],
		[ locations.garden.origin, locations.garden.landmark ],
		[ locations.garden.origin, locations.gothic.landmark ],
	].map( ( [ from, to ] ) => {

		// 终点前 120 米停下：城堡脚下的树留着
		const length = Math.hypot( to[ 0 ] - from[ 0 ], to[ 2 ] - from[ 2 ] );
		const directionX = ( to[ 0 ] - from[ 0 ] ) / length;
		const directionZ = ( to[ 2 ] - from[ 2 ] ) / length;
		return { startX: from[ 0 ], startZ: from[ 2 ], directionX, directionZ, length: length - 120, halfWidth: 30 };

	} );
	// 开场的整段溪谷（原点 → 洞外口，两岸各 100 米）：开场自己种了桃树，远景的树不再种（不然一棵针叶树会立在桃林里）
	const outer = world.config.cave.outer;
	const overture = locations.overture.origin;
	const valleyLength = Math.hypot( outer[ 0 ] - overture[ 0 ], outer[ 2 ] - overture[ 2 ] );
	sightlines.push( {
		startX: overture[ 0 ] - ( outer[ 0 ] - overture[ 0 ] ) / valleyLength * 60,
		startZ: overture[ 2 ] - ( outer[ 2 ] - overture[ 2 ] ) / valleyLength * 60,
		directionX: ( outer[ 0 ] - overture[ 0 ] ) / valleyLength,
		directionZ: ( outer[ 2 ] - overture[ 2 ] ) / valleyLength,
		length: valleyLength + 60,
		halfWidth: 100,
	} );
	// 花园：水池两边的正式园林（中轴 ±gardenHalf + 8 米，从出生点前 30 米到台基后面）不种，外面的草地种花树；
	// 出洞那段路（洞的内口 → 出生点，两边各 22 米）留出来，出洞时一眼看到秘境
	const gardenConfig = state.ctx.config.garden;
	const gardenLocation = locations.garden;
	const gardenYaw = - gardenLocation.yaw * degree;
	const castleLocal = world.toLocal( new THREE.Vector3().fromArray( gardenLocation.landmark ), 'garden', new THREE.Vector3() );
	const caveInner = world.config.cave.inner;
	const caveLength = Math.hypot( caveInner[ 0 ] - gardenLocation.origin[ 0 ], caveInner[ 2 ] - gardenLocation.origin[ 2 ] );
	sightlines.push( {
		startX: gardenLocation.origin[ 0 ], startZ: gardenLocation.origin[ 2 ],
		directionX: ( caveInner[ 0 ] - gardenLocation.origin[ 0 ] ) / caveLength, directionZ: ( caveInner[ 2 ] - gardenLocation.origin[ 2 ] ) / caveLength,
		length: caveLength, halfWidth: 22,
	} );
	// 出洞以后镜头先顺着洞的方向往前、往上飘到俯瞰点（花园 buildIntro：内口往前 45 米、升 36 米），这一段两边各 14 米也不种
	// （原来镜头从一棵阔叶树的树冠里穿过去，满屏叶子）
	const innerMouth = world.cave.at( world.cave.length, {} );
	sightlines.push( {
		startX: innerMouth.position.x, startZ: innerMouth.position.z,
		directionX: innerMouth.tangent.x / Math.hypot( innerMouth.tangent.x, innerMouth.tangent.z ), directionZ: innerMouth.tangent.z / Math.hypot( innerMouth.tangent.x, innerMouth.tangent.z ),
		length: 70, halfWidth: 14,
	} );
	const garden = {
		originX: gardenLocation.origin[ 0 ], originZ: gardenLocation.origin[ 2 ], cosine: Math.cos( gardenYaw ), sine: Math.sin( gardenYaw ),
		axisX: castleLocal.x, halfWidth: gardenConfig.gardenHalf + 8, minZ: castleLocal.z - 48 * gardenConfig.castleScale - 20, maxZ: 30,
	};
	return { circles, sectors, sightlines, garden };

}

// 世界坐标 → 花园本地（和 world.toLocal 一样：绕 y 转回去），落在正式园林那一条里
function insideGardenFormal( garden, x, z ) {

	const dx = x - garden.originX;
	const dz = z - garden.originZ;
	const localX = dx * garden.cosine - dz * garden.sine;
	const localZ = dx * garden.sine + dz * garden.cosine;
	return Math.abs( localX - garden.axisX ) < garden.halfWidth && localZ > garden.minZ && localZ < garden.maxZ;

}

function insideClearing( clearings, x, z ) {

	if ( clearings.garden && insideGardenFormal( clearings.garden, x, z ) ) return true;
	for ( const sector of clearings.sectors || [] ) {

		const offsetX = x - sector.x;
		const offsetZ = z - sector.z;
		const distance = Math.hypot( offsetX, offsetZ );
		if ( distance < sector.radius && offsetX * sector.directionX + offsetZ * sector.directionZ > distance * sector.cosine ) return true;

	}

	for ( const [ centerX, centerZ, radius ] of clearings.circles ) {

		if ( Math.abs( x - centerX ) < radius && Math.abs( z - centerZ ) < radius && Math.hypot( x - centerX, z - centerZ ) < radius ) return true;

	}

	for ( const line of clearings.sightlines ) {

		const along = ( x - line.startX ) * line.directionX + ( z - line.startZ ) * line.directionZ;
		if ( along < 0 || along > line.length ) continue;
		const lateral = Math.abs( - ( x - line.startX ) * line.directionZ + ( z - line.startZ ) * line.directionX );
		if ( lateral < line.halfWidth ) return true;

	}

	return false;

}

async function buildForest( tier, slice ) {

	const core = state.core;
	const treeConfig = state.ctx.config.trees;
	// 候选格距：hi 9 米、其余 12 米（阶段 12 CP3 返工：原来 11 / 18 米，谷底又不长林，整个世界空）
	const spacing = tier === 'hi' ? 9 : 12;
	const random = createRandom( 20261001 );
	// 二十面体不细分（12 个顶点，ForestGenerator 的默认做法）：3 万多棵树，顶点数是主要开销；树都在几百米外，看不出棱角。
	// 三种树：阔叶（圆）、针叶（高、尖、平底）、桃树（矮、粉）；半径、高（米）直接烘进几何体
	// 阶段 12 CP3：近处换成 3D 树以后，树团只在几百米以外画；二十面体细分一次（42 个顶点）再按噪声鼓包，轮廓是一团团的，不是六边形。
	// 针叶分成松（高处平顶、一团团）和冷杉（尖塔），和近处的 3D 树对得上。
	// 树团是顶点开销（实测 hi 开场：细分一次 0.72 ms、不细分 0.2 ms），mid / lo 档不细分，轮廓的差别在核显的分辨率下看不出
	const blobDetail = tier === 'hi' ? 1 : 0;
	const kinds = {
		broadleaf: { geometry: blobGeometry( blobDetail, 4.2, 10, 0.45, 0.42, false ), items: [], colors: [ '#3d6234', '#5e8040' ] },
		pine: { geometry: blobGeometry( blobDetail, 3.3, 14, 0.35, 0.4, false ), items: [], colors: [ '#2a4632', '#3d5a3c' ] },
		fir: { geometry: blobGeometry( blobDetail, 2.6, 15, 0.85, 0.2, true ), items: [], colors: [ '#233d30', '#345038' ] },
		peach: { geometry: blobGeometry( blobDetail, 3, 5.5, 0.35, 0.35, false ), items: [], colors: [ '#f0b0c4', '#f9d6e0' ] },
		blossom: { geometry: blobGeometry( blobDetail, 3.4, 6.5, 0.35, 0.35, false ), items: [], colors: [ '#f2bccd', '#fbe0e8' ] },
	};
	const tintFirst = new THREE.Color();
	const tintSecond = new THREE.Color();
	const hueShift = new THREE.Color();
	const clearings = treeClearings( state.world );

	// 布点规则在 src/core/forest.js（阶段 12 CP3 返工）：成片的林子、林缘、河岸、草甸孤树、花树林；地点只让开自己脚下
	const gardenLayoutInfo = gardenLayout( state.ctx );
	const gardenRect = gardenLayoutInfo.rect;
	const gardenOrigin = state.world.locations.garden.origin;
	const toGarden = new THREE.Vector3();
	const gardenLocal = ( x, z ) => state.world.toLocal( toGarden.set( x, 0, z ), 'garden', toGarden );
	const nearestIndex = ( x, z ) => Math.round( ( z - core.minZ ) / core.spacing ) * core.countX + Math.round( ( x - core.minX ) / core.spacing );
	// 哥特岩台：两侧的平台、台顶城堡后面加密成松林（阶段 12 CP4，"那种魔法学校的城堡"：崖上的城堡、旁边一片黑森林）
	const mesa = state.world.config.terrainShape.gothicMesa;
	if ( mesa ) {

		const ring = [];
		const ringRadius = mesa.radius + mesa.falloff * 0.45;
		for ( let angle = 0; angle < Math.PI * 2; angle += 6 / ringRadius ) ring.push( { x: mesa.center[ 0 ] + Math.cos( angle ) * ringRadius, z: mesa.center[ 1 ] + Math.sin( angle ) * ringRadius } );
		state.forestBoosts = [ ...( state.forestBoosts || [] ), { samples: ring, radius: mesa.falloff * 0.7, species: 'pine' } ];

	}
	// 加密的地方（窄处、哥特岩台）：先算好每一条的包围盒（外扩 radius）
	const boosts = ( state.forestBoosts || [] ).map( ( boost ) => {

		const xs = boost.samples.map( ( sample ) => sample.x );
		const zs = boost.samples.map( ( sample ) => sample.z );
		return { ...boost, minX: Math.min( ...xs ) - boost.radius, maxX: Math.max( ...xs ) + boost.radius, minZ: Math.min( ...zs ) - boost.radius, maxZ: Math.max( ...zs ) + boost.radius };

	} );
	const noiseChannel = { large: 0, medium: 1, small: 0 };
	const sample = {
		height: ( x, z ) => gridHeight( core, x, z ),
		// 坡度：抖动后的位置上用网格高度中心差分（不能拿最近格点的法线：崖上会对不上）
		slope: ( x, z ) => {

			const slopeX = ( gridHeight( core, x + 2, z ) - gridHeight( core, x - 2, z ) ) / 4;
			const slopeZ = ( gridHeight( core, x, z + 2 ) - gridHeight( core, x, z - 2 ) ) / 4;
			return 1 - 1 / Math.hypot( slopeX, 1, slopeZ );

		},
		water: ( x, z ) => core.depths[ nearestIndex( x, z ) ] > - 1 || biomeAt( x, z, 0 ) > 0.4 || state.world.lakeRadius( x, z ) < 1.05,
		waterEdge: ( x, z ) => biomeAt( x, z, 0 ),
		peach: ( x, z ) => biomeAt( x, z, 1 ),
		flowers: ( x, z ) => biomeAt( x, z, 2 ),
		wet: ( x, z ) => bakedForestAt( x, z ),
		noise: ( name, x, z ) => noiseValueJs( name, x, z, noiseChannel[ name ] ),
		// 花园两侧的草地（中轴 100~430 米、花园前后再各多 80 米）是花树林
		// 窄处要的老林、松林（林间小路两边、冰碛岗上）：离那条线 radius 米以内加密，边上 40% 渐变
		boost: ( x, z ) => {

			let amount = 0;
			let species = null;
			for ( const boost of boosts ) {

				// 包围盒外的直接跳过（14 万个候选点 × 几百个样本，不剪枝要多花一秒多）
				if ( x < boost.minX || x > boost.maxX || z < boost.minZ || z > boost.maxZ ) continue;
				let nearest = Infinity;
				for ( const sample of boost.samples ) {

					const distance = Math.abs( sample.x - x ) + Math.abs( sample.z - z ) < boost.radius * 1.5 ? Math.hypot( sample.x - x, sample.z - z ) : Infinity;
					if ( distance < nearest ) nearest = distance;

				}

				const value = smoothJs( boost.radius, boost.radius * 0.6, nearest );
				if ( value > amount ) {

					amount = value;
					species = boost.species;

				}

			}

			return { amount, species };

		},
		blossomZone: ( x, z ) => {

			const local = gardenLocal( x, z );
			const across = Math.abs( local.x - gardenLayoutInfo.axisX );
			return smoothJs( 100, 118, across ) * ( 1 - smoothJs( 380, 440, across ) ) * smoothJs( gardenRect.minZ - 90, gardenRect.minZ - 30, local.z ) * ( 1 - smoothJs( gardenRect.maxZ + 60, gardenRect.maxZ + 140, local.z ) );

		},
	};
	// 树根高度：花园块里画的是花园自己的地面（远景在块里被挖掉），按花园的地面公式；其余按远景（带窄处的地形补丁）
	const groundAt = ( x, z ) => {

		const local = gardenLocal( x, z );
		if ( local.x > gardenRect.minX && local.x < gardenRect.maxX && local.z > gardenRect.minZ && local.z < gardenRect.maxZ ) return gardenGroundLocal( state.ctx, gardenLayoutInfo, local.x, local.z ) + gardenOrigin[ 1 ];
		return terrainHeightAt( x, z );

	};
	const variants = Object.fromEntries( Object.entries( treeConfig.species ).map( ( [ name, spec ] ) => [ name, Array.isArray( spec.forms ) ? spec.forms.length : treeConfig.variants ] ) );

	// 布点结果先找离线烘焙的（scripts/bake-forest.mjs，assets/opt/forest，带指纹）；没有或对不上就当场算（约 2 秒）
	const forestKey = tier === 'hi' ? 'hi' : 'lo';
	let planned = await loadBakedForest( forestKey, speciesNamesOf( treeConfig ) );
	if ( ! planned ) {

		const started = performance.now();
		planned = await planForest( {
			bounds: { minX: core.minX, minZ: core.minZ, maxX: core.minX + core.sizeX, maxZ: core.minZ + core.sizeZ },
			spacing,
			random,
			sample,
			clearing: ( x, z ) => insideClearing( clearings, x, z ),
			groundAt,
			settings: { conifer: treeConfig.coniferAltitude, firAltitude: treeConfig.firAltitude, meadowChance: treeConfig.meadowChance, variants },
			yieldIfBusy: () => yieldIfBusy( slice ),
		} );
		console.log( `远景：树林当场布点（${ forestKey }），${ planned.length } 棵，用时 ${ ( performance.now() - started ).toFixed( 0 ) } ms` );

	}

	state.plannedForest = { key: forestKey, items: planned };
	for ( const item of planned ) kinds[ item.species ].items.push( item );

	// 窄处要种的树（岩丘裂隙顶上几棵被海风吹歪的松，阶段 12 CP3 返工）：不走林地遮罩和空地，照给的位置种
	for ( const extra of state.extraTrees || [] ) {

		const height = terrainHeightAt( extra.x, extra.z );
		if ( ! Number.isFinite( height ) ) continue;
		const item = { x: extra.x, y: height - 0.8, z: extra.z, size: extra.size, tint: random(), yaw: random() * Math.PI * 2, cull: random(), species: extra.species || 'pine' };
		item.variant = Math.min( variants[ item.species ] - 1, Math.floor( item.tint * variants[ item.species ] ) );
		// 往 leanAngle（方位角，度）那边歪 leanDegrees 度：绕水平轴转，轴和歪的方向垂直
		const leanRadians = ( extra.leanAngle || 0 ) * Math.PI / 180;
		const tilt = ( extra.leanDegrees || 0 ) * Math.PI / 180;
		item.tiltX = - Math.cos( leanRadians ) * tilt;
		item.tiltZ = - Math.sin( leanRadians ) * tilt;
		kinds[ item.species ].items.push( item );

	}

	state.forestItems = Object.values( kinds ).flatMap( ( kind ) => kind.items );
	// 焦点樱花树：照配置的位置种（树种 focal，变体 = 第几个模型）；树根按花园的地面
	for ( const place of treeConfig.focal ? treeConfig.focal.places : [] ) {

		const local = new THREE.Vector3( gardenLayoutInfo.axisX + place.x, 0, place.z );
		const worldPoint = state.world.toWorld( local, place.location, new THREE.Vector3() );
		state.forestItems.push( { x: worldPoint.x, y: groundAt( worldPoint.x, worldPoint.z ) - 0.3, z: worldPoint.z, size: place.size, tint: 0.5, yaw: ( place.yaw - state.world.locations[ place.location ].yaw ) * degree, cull: 0.02, species: 'focal', variant: place.model } );

	}

	// 远处画替身卡片（阶段 12 CP3 返工）；图集没烘、和树种配置对不上、或者读不出来，退回原来的树团
	const impostor = await buildImpostorForest( state.forestItems );
	if ( impostor ) {

		for ( const kind of Object.values( kinds ) ) state.disposables.push( kind.geometry );
		console.log( `远景：树林 阔叶 ${ kinds.broadleaf.items.length }、松 ${ kinds.pine.items.length }、冷杉 ${ kinds.fir.items.length }、桃树 ${ kinds.peach.items.length }、花树 ${ kinds.blossom.items.length } 棵（远处画替身卡片）` );
		return [ impostor ];

	}

	const material = createForestMaterial();
	state.disposables.push( material );
	const placement = new THREE.Object3D();
	const meshes = [];

	for ( const [ name, kind ] of Object.entries( kinds ) ) {

		const count = kind.items.length;
		state.disposables.push( kind.geometry );
		if ( count === 0 ) continue;
		// 不到 4096 棵也按 4096 个实例分配，多出来的缩放为 0（退化成一个点，不画任何东西）：
		// three 对实例矩阵总量不超过 uniform 缓冲上限（约 1024 个）的 InstancedMesh，每挂进一个新的地点场景就生成一份新着色器
		// （缓冲名字带唯一编号），旧场景的程序一直留着，renderer.info 的程序数每换一次地点就涨（4b 实测桃树林 470 棵）
		const allocated = Math.max( count, 4096 );
		const treeData = new Float32Array( allocated * 4 );
		const treeBase = new Float32Array( allocated * 3 );
		const mesh = new THREE.InstancedMesh( kind.geometry, material, allocated );
		const collapsed = new THREE.Matrix4().makeScale( 0, 0, 0 );
		for ( let index = count; index < allocated; index ++ ) mesh.setMatrixAt( index, collapsed );
		tintFirst.set( kind.colors[ 0 ] );
		tintSecond.set( kind.colors[ 1 ] );

		kind.items.forEach( ( item, index ) => {

			placement.position.set( item.x, item.y, item.z );
			placement.rotation.set( item.tiltX || 0, item.yaw, item.tiltZ || 0, 'XZY' );
			placement.scale.setScalar( item.size );
			placement.updateMatrix();
			mesh.setMatrixAt( index, placement.matrix );
			// 色相和近处的 3D 树一样偏一点（有的嫩黄绿、有的老蓝绿），交接时颜色对得上
			const tint = tintFirst.clone().lerp( tintSecond, item.tint );
			const hue = ( item.tint * 7.31 ) % 1;
			tint.multiply( hueShift.setRGB( 1 + ( 0.86 + 0.3 * hue - 1 ) * 0.6, 1 + ( 0.97 + 0.09 * hue - 1 ) * 0.6, 1 + ( 1.12 - 0.4 * hue - 1 ) * 0.6 ) );
			treeData.set( [ tint.r, tint.g, tint.b, item.cull ], index * 4 );
			treeBase.set( [ item.x, item.y, item.z ], index * 3 );

		} );

		kind.geometry.setAttribute( 'treeData', new THREE.InstancedBufferAttribute( treeData, 4 ) );
		kind.geometry.setAttribute( 'treeBase', new THREE.InstancedBufferAttribute( treeBase, 3 ) );
		mesh.instanceMatrix.needsUpdate = true;
		mesh.frustumCulled = false;
		mesh.name = '树林·' + name;
		meshes.push( mesh );

	}

	console.log( `远景：树林 阔叶 ${ kinds.broadleaf.items.length }、松 ${ kinds.pine.items.length }、冷杉 ${ kinds.fir.items.length }、桃树 ${ kinds.peach.items.length }、花树 ${ kinds.blossom.items.length } 棵（远处画树团）` );
	return meshes;

}

// ===================== 替身：几何体工具 =====================
// 替身都在世界坐标里直接建好（合并成一个几何体），顶点带 surface = (rgb 反照率, 金属感)：金属感 1 是银穹顶那样反射天空

function paint( geometry, hex, shine = 0 ) {

	const flat = geometry.index ? geometry.toNonIndexed() : geometry;
	if ( flat !== geometry ) geometry.dispose();
	for ( const name of Object.keys( flat.attributes ) ) {

		if ( name !== 'position' && name !== 'normal' ) flat.deleteAttribute( name );

	}

	if ( ! flat.attributes.normal ) flat.computeVertexNormals();
	const paintColor = new THREE.Color( hex );
	const count = flat.attributes.position.count;
	const surface = new Float32Array( count * 4 );
	for ( let i = 0; i < count; i ++ ) surface.set( [ paintColor.r, paintColor.g, paintColor.b, shine ], i * 4 );
	flat.setAttribute( 'surface', new THREE.BufferAttribute( surface, 4 ) );
	return flat;

}

// 在本地坐标里摆好（平移 + 绕 y 转），再整体换到世界坐标
function placeLocal( geometry, x, y, z, rotationY = 0 ) {

	if ( rotationY !== 0 ) geometry.rotateY( rotationY );
	geometry.translate( x, y, z );
	return geometry;

}

// 合并成一个几何体（都是非索引的，属性一致），再按 origin + 朝向换到世界坐标
function mergeToWorld( parts, originX, originY, originZ, rotationY ) {

	let vertexCount = 0;
	for ( const part of parts ) vertexCount += part.attributes.position.count;
	const positions = new Float32Array( vertexCount * 3 );
	const normals = new Float32Array( vertexCount * 3 );
	const surfaces = new Float32Array( vertexCount * 4 );
	let offset = 0;
	for ( const part of parts ) {

		const count = part.attributes.position.count;
		positions.set( part.attributes.position.array, offset * 3 );
		normals.set( part.attributes.normal.array, offset * 3 );
		surfaces.set( part.attributes.surface.array, offset * 4 );
		offset += count;
		part.dispose();

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'surface', new THREE.BufferAttribute( surfaces, 4 ) );
	geometry.rotateY( rotationY );
	geometry.translate( originX, originY, originZ );
	geometry.computeBoundingSphere();
	return geometry;

}

// 两坡屋顶（三棱柱）：沿本地 x 方向长 length，宽 width，高 height，底面在 y = 0
function gableRoof( length, width, height ) {

	const halfLength = length / 2;
	const halfWidth = width / 2;
	const corners = [
		[ - halfLength, 0, - halfWidth ], [ halfLength, 0, - halfWidth ], [ halfLength, 0, halfWidth ], [ - halfLength, 0, halfWidth ],
		[ - halfLength, height, 0 ], [ halfLength, height, 0 ],
	];
	const faces = [ [ 0, 4, 5 ], [ 0, 5, 1 ], [ 3, 2, 5 ], [ 3, 5, 4 ], [ 0, 3, 4 ], [ 1, 5, 2 ] ];
	const positions = [];
	for ( const face of faces ) for ( const index of face ) positions.push( ...corners[ index ] );
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.computeVertexNormals();
	return geometry;

}

// 尖拱（两段圆弧相交）：宽 width，直墙高 wallHeight，拱尖再高 0.87 × width
function pointedArchShape( width, wallHeight ) {

	const half = width / 2;
	const shape = new THREE.Shape();
	shape.moveTo( - half, 0 );
	shape.lineTo( half, 0 );
	shape.lineTo( half, wallHeight );
	// 右边的弧以左墙顶为圆心，半径 = 宽，两段弧在中线相交成尖
	const radius = width;
	const apex = wallHeight + Math.sqrt( radius * radius - half * half );
	shape.absarc( - half, wallHeight, radius, 0, Math.atan2( apex - wallHeight, half ), false );
	shape.absarc( half, wallHeight, radius, Math.PI - Math.atan2( apex - wallHeight, half ), Math.PI, false );
	shape.lineTo( - half, 0 );
	return shape;

}

// 洋葱穹顶的轮廓（旋转体）：baseRadius 是底半径，总高约 2.5 × baseRadius
function onionDome( baseRadius, segments ) {

	const profile = [ [ 1, 0 ], [ 1.17, 0.22 ], [ 1.27, 0.6 ], [ 1.25, 0.98 ], [ 1.13, 1.35 ], [ 0.9, 1.68 ], [ 0.6, 1.9 ], [ 0.3, 2.05 ], [ 0.12, 2.18 ], [ 0.05, 2.35 ], [ 0, 2.5 ] ];
	return new THREE.LatheGeometry( profile.map( ( [ radius, height ] ) => new THREE.Vector2( radius * baseRadius, height * baseRadius ) ), segments );

}

// ===================== 替身：花园城堡（白色大理石 + 银洋葱顶，规格书 10.1）=====================

function buildGardenCastle( world ) {

	const garden = world.locations.garden;
	const [ castleX, , castleZ ] = garden.landmark;
	const groundY = world.worldHeight( castleX, castleZ );
	// 正面朝花园原点（水池那头）：本地 +z 转到这个方向
	const facing = Math.atan2( garden.origin[ 0 ] - castleX, garden.origin[ 2 ] - castleZ );
	const marble = '#f1ede6';
	const marbleShade = '#c9c3ba';
	const silver = '#e6ecf4';
	const parts = [];

	// 台基、主体（八角，四个大面朝正方向）、鼓座、洋葱顶、顶尖
	parts.push( paint( placeLocal( new THREE.BoxGeometry( 96, 7, 96 ), 0, 3.5, 0 ), '#e8e1d6' ) );
	parts.push( paint( placeLocal( new THREE.CylinderGeometry( 31, 31, 33, 8 ), 0, 23.5, 0, Math.PI / 8 ), marble ) );
	parts.push( paint( placeLocal( new THREE.CylinderGeometry( 13.5, 13.5, 8, 32 ), 0, 44, 0 ), marble ) );
	parts.push( paint( placeLocal( onionDome( 13.5, 40 ), 0, 48, 0 ), silver, 1 ) );
	parts.push( paint( placeLocal( new THREE.CylinderGeometry( 0.25, 0.45, 8, 8 ), 0, 85, 0 ), silver, 1 ) );

	// 四个正面的大尖拱门（凹进去的颜色深一档），四个斜面上下两层小拱
	const apothem = 31 * Math.cos( Math.PI / 8 );
	const bigArch = pointedArchShape( 17, 16 );
	const smallArch = pointedArchShape( 6, 5 );
	for ( let k = 0; k < 4; k ++ ) {

		const angle = k * Math.PI / 2;
		const arch = new THREE.ExtrudeGeometry( bigArch, { depth: 1.2, bevelEnabled: false } );
		arch.translate( 0, 0, apothem - 0.6 );
		parts.push( paint( placeLocal( arch, 0, 9, 0, angle ), marbleShade ) );
		for ( const level of [ 9.5, 22 ] ) {

			const small = new THREE.ExtrudeGeometry( smallArch, { depth: 1, bevelEnabled: false } );
			small.translate( 0, 0, apothem - 0.5 );
			parts.push( paint( placeLocal( small, 0, level, 0, angle + Math.PI / 4 ), marbleShade ) );

		}

	}

	// 屋顶四角的小亭子（柱亭 + 小洋葱顶）
	for ( const [ cornerX, cornerZ ] of [ [ 19, 19 ], [ - 19, 19 ], [ 19, - 19 ], [ - 19, - 19 ] ] ) {

		parts.push( paint( placeLocal( new THREE.CylinderGeometry( 3.6, 3.6, 6, 8 ), cornerX, 43, cornerZ ), marble ) );
		parts.push( paint( placeLocal( onionDome( 3.6, 16 ), cornerX, 46, cornerZ ), silver, 0.7 ) );

	}

	// 台基四角的宣礼塔：细高、三层阳台、顶上小亭
	for ( const [ cornerX, cornerZ ] of [ [ 44, 44 ], [ - 44, 44 ], [ 44, - 44 ], [ - 44, - 44 ] ] ) {

		parts.push( paint( placeLocal( new THREE.CylinderGeometry( 2.2, 2.8, 42, 16 ), cornerX, 28, cornerZ ), marble ) );
		for ( const level of [ 19, 31, 43 ] ) parts.push( paint( placeLocal( new THREE.CylinderGeometry( 3.6, 3.2, 1, 16 ), cornerX, level, cornerZ ), marble ) );
		parts.push( paint( placeLocal( new THREE.CylinderGeometry( 2.6, 2.6, 3.5, 8 ), cornerX, 50.75, cornerZ ), marble ) );
		parts.push( paint( placeLocal( onionDome( 2.6, 12 ), cornerX, 52.5, cornerZ ), silver, 0.7 ) );

	}

	const castle = mergeToWorld( parts, castleX, groundY, castleZ, facing );

	// 水池两边的柏树：每 14 米一棵，离水池中线 13 米
	const pool = gardenPool( world );
	const cypress = [];
	for ( let along = 6; along < pool.length - 4; along += 14 ) {

		for ( const side of [ - 1, 1 ] ) {

			const x = pool.startX + pool.directionX * along - pool.directionZ * 13 * side;
			const z = pool.startZ + pool.directionZ * along + pool.directionX * 13 * side;
			cypress.push( paint( placeLocal( new THREE.ConeGeometry( 1.8, 13, 10 ), x, world.worldHeight( x, z ) + 6.2, z ), '#2b4730' ) );

		}

	}

	return [ castle, mergeToWorld( cypress, 0, 0, 0, 0 ) ];

}

// ===================== 替身：哥特城堡（崖顶，尖塔林立，规格书 11.1）=====================

// 哥特城堡的替身：和哥特场景里同一座零件包拼的城堡（scripts/blender/gothic-castle.py 的远景一级：体素重建的外壳 + 每间屋一块窗片），
// 摆在同一个位置、同一个朝向、同一个放大（config.gothic.modelScale）。外壳刷成城堡的深蓝灰、乘烘好的 AO；窗片换成远景窗灯的窗户表
// （整晚不亮的房间不要，和哥特场景里同一条规则）。模型没读到返回 null，退回程序化的替身
// 花园城堡的替身：和花园里同一个模型（Taj mahal）的第三级（约 1 万三角），起飞、降落时不跳。
// 摆法和花园场景里一样：模型原点放在城堡的位置，绕竖轴转 −yaw（花园场景本地坐标到世界的转角）；大理石按 AO 刷色，银顶反射天空
async function buildGardenProxyModel( world ) {

	const model = await loadModel( 'models', 'taj-castle-lod2' );
	if ( ! model ) {

		console.warn( '远景：花园城堡替身模型 taj-castle-lod2 没读到，用程序化的替身' );
		return null;

	}

	const garden = world.locations.garden;
	const castleLocal = world.toLocal( new THREE.Vector3().fromArray( garden.landmark ), 'garden', new THREE.Vector3() );
	const castleWorld = world.toWorld( new THREE.Vector3( castleLocal.x, 0, castleLocal.z ), 'garden', new THREE.Vector3() );
	const placement = new THREE.Matrix4().makeTranslation( castleWorld.x, garden.origin[ 1 ], castleWorld.z ).multiply( new THREE.Matrix4().makeRotationY( - garden.yaw * degree ) );
	model.updateMatrixWorld( true );
	const geometries = [];
	const point = new THREE.Vector3();
	const marbleColor = new THREE.Color( '#f1ede6' );
	model.traverse( ( child ) => {

		if ( ! child.isMesh ) return;
		const source = child.geometry;
		const matrix = placement.clone().multiply( child.matrixWorld );
		const positions = source.getAttribute( 'position' );
		const flat = new THREE.BufferGeometry();
		const floats = new Float32Array( positions.count * 3 );
		for ( let i = 0; i < positions.count; i ++ ) {

			point.fromBufferAttribute( positions, i ).applyMatrix4( matrix );
			floats.set( [ point.x, point.y, point.z ], i * 3 );

		}

		flat.setAttribute( 'position', new THREE.BufferAttribute( floats, 3 ) );
		if ( source.index ) flat.setIndex( Array.from( source.index.array ) );
		const isSilver = /银/.test( child.material && child.material.name || '' );
		const painted = paint( flat, isSilver ? '#e6ecf4' : '#f1ede6', isSilver ? 1 : 0 );
		const occlusion = source.getAttribute( 'color' );
		if ( occlusion && ! isSilver ) {

			const surface = painted.getAttribute( 'surface' );
			const order = source.index ? source.index.array : null;
			for ( let i = 0; i < surface.count; i ++ ) {

				const ao = occlusion.getX( order ? order[ i ] : i );
				surface.setXYZ( i, marbleColor.r * ( 0.45 + 0.55 * ao ), marbleColor.g * ( 0.47 + 0.53 * ao ), marbleColor.b * ( 0.52 + 0.48 * ao ) );

			}

		}

		geometries.push( painted );

	} );
	disposeModel( model );
	return geometries.length ? geometries : null;

}

async function buildGothicProxyModel( world, windows ) {

	const model = await loadModel( 'models', 'gothic-castle-lod2' );
	if ( ! model ) {

		console.warn( '远景：哥特城堡替身模型 gothic-castle-lod2 没读到，用程序化的替身' );
		return null;

	}

	const gothic = world.locations.gothic;
	const [ castleX, , castleZ ] = gothic.landmark;
	const groundY = world.worldHeight( castleX, castleZ );
	const facing = Math.atan2( gothic.origin[ 0 ] - castleX, gothic.origin[ 2 ] - castleZ );
	const gothicConfig = state.ctx.config.gothic;
	const placement = new THREE.Matrix4().makeTranslation( castleX, groundY, castleZ )
		.multiply( new THREE.Matrix4().makeRotationY( facing ) )
		.multiply( new THREE.Matrix4().makeScale( gothicConfig.modelScale, gothicConfig.modelScale, gothicConfig.modelScale ) );
	model.updateMatrixWorld( true );
	const stoneColor = new THREE.Color( '#4a5064' );
	const geometries = [];
	const point = new THREE.Vector3();
	const corner = new THREE.Vector3();
	model.traverse( ( child ) => {

		if ( ! child.isMesh ) return;
		const source = child.geometry;
		const matrix = placement.clone().multiply( child.matrixWorld );
		const positions = source.getAttribute( 'position' );
		const info = source.getAttribute( '_window' );
		if ( info ) {

			// 窗片：四个顶点一块
			for ( let first = 0; first + 3 < positions.count; first += 4 ) {

				const random = info.getW( first );
				if ( ( random * 7.31 ) % 1 < gothicConfig.windows.darkRooms ) continue;
				point.set( 0, 0, 0 );
				for ( let k = 0; k < 4; k ++ ) point.add( corner.fromBufferAttribute( positions, first + k ).applyMatrix4( matrix ) );
				point.multiplyScalar( 0.25 );
				const a = new THREE.Vector3().fromBufferAttribute( positions, first ).applyMatrix4( matrix );
				const b = new THREE.Vector3().fromBufferAttribute( positions, first + 1 ).applyMatrix4( matrix );
				const c = new THREE.Vector3().fromBufferAttribute( positions, first + 2 ).applyMatrix4( matrix );
				const normal = new THREE.Vector3().subVectors( b, a ).cross( new THREE.Vector3().subVectors( c, a ) );
				normal.y = 0;
				if ( normal.lengthSq() < 1e-8 ) continue;
				normal.normalize();
				windows.push( { x: point.x, y: point.y, z: point.z, normalX: normal.x, normalZ: normal.z, width: a.distanceTo( b ), height: b.distanceTo( c ), floor: info.getZ( first ), random } );

			}

			return;

		}

		// 外壳：量化的属性先转成 32 位浮点再变换（KHR_mesh_quantization 的整数直接变换会被截断）
		const flat = new THREE.BufferGeometry();
		const floats = new Float32Array( positions.count * 3 );
		for ( let i = 0; i < positions.count; i ++ ) {

			point.fromBufferAttribute( positions, i ).applyMatrix4( matrix );
			floats.set( [ point.x, point.y, point.z ], i * 3 );

		}

		flat.setAttribute( 'position', new THREE.BufferAttribute( floats, 3 ) );
		if ( source.index ) flat.setIndex( Array.from( source.index.array ) );
		const occlusion = source.getAttribute( 'color' );
		const painted = paint( flat, '#4a5064' );
		// paint 刷的是一种颜色；按顶点乘烘好的 AO（toNonIndexed 以后顶点顺序是按三角形展开的，从原索引取）
		if ( occlusion ) {

			const surface = painted.getAttribute( 'surface' );
			const order = source.index ? source.index.array : null;
			for ( let i = 0; i < surface.count; i ++ ) {

				const ao = occlusion.getX( order ? order[ i ] : i );
				surface.setXYZ( i, stoneColor.r * ( 0.3 + 0.7 * ao ), stoneColor.g * ( 0.3 + 0.7 * ao ), stoneColor.b * ( 0.3 + 0.7 * ao ) );

			}

		}

		geometries.push( painted );

	} );
	disposeModel( model );
	if ( geometries.length === 0 ) {

		console.warn( '远景：哥特城堡替身模型里没有外壳网格，用程序化的替身' );
		return null;

	}

	return geometries;

}

function buildGothicCastle( world, windows ) {

	const gothic = world.locations.gothic;
	const [ castleX, , castleZ ] = gothic.landmark;
	const groundY = world.worldHeight( castleX, castleZ );
	// 正面朝湖对岸的机位
	const facing = Math.atan2( gothic.origin[ 0 ] - castleX, gothic.origin[ 2 ] - castleZ );
	const cosine = Math.cos( facing );
	const sine = Math.sin( facing );
	const castleScale = state.ctx.config.gothic.castleScale;
	const toWorld = ( x, y, z ) => [ castleX + ( x * cosine + z * sine ) * castleScale, groundY + y * castleScale, castleZ + ( - x * sine + z * cosine ) * castleScale ];
	const stone = '#545a72';
	const roof = '#2c3247';
	const parts = [];
	const random = createRandom( 1185 );

	// 窗户：本地坐标的中心 + 朝外的方向，记下楼层高度比例（从下往上亮）；朝外方向也换到世界坐标（侧着看时窗灯变暗）
	function addWindow( x, y, z, outwardX, outwardZ, topHeight, width = 1.1, height = 1.9 ) {

		const [ worldX, worldY, worldZ ] = toWorld( x + outwardX * 0.3, y, z + outwardZ * 0.3 );
		const normalX = outwardX * cosine + outwardZ * sine;
		const normalZ = - outwardX * sine + outwardZ * cosine;
		windows.push( { x: worldX, y: worldY, z: worldZ, normalX, normalZ, width: width * castleScale, height: height * castleScale, floor: y / topHeight, random: random() } );

	}

	// 主厅：长 48、高 24、深 16，陡的两坡屋顶，屋脊上一排小尖塔；正反两面三排窗。
	// 窗不排成整齐的格子（像写字楼）：每扇随机去掉四成，位置再抖一抖
	parts.push( paint( placeLocal( new THREE.BoxGeometry( 48, 24, 16 ), 0, 12, 0 ), stone ) );
	parts.push( paint( placeLocal( gableRoof( 48, 17, 14 ), 0, 24, 0 ), roof ) );
	for ( let x = - 20; x <= 20; x += 8 ) parts.push( paint( placeLocal( new THREE.ConeGeometry( 0.9, 7, 6 ), x, 41.5, 0 ), roof ) );
	for ( const row of [ 6, 13, 19 ] ) {

		for ( let x = - 21; x <= 21; x += 4.2 ) {

			for ( const side of [ 1, - 1 ] ) {

				if ( random() < 0.4 ) continue;
				addWindow( x + ( random() - 0.5 ) * 2.5, row + ( random() - 0.5 ) * 2, 8 * side, 0, side, 38 );

			}

		}

	}

	// 塔：[本地 x, z, 半径, 高, 尖顶高]；最高的主塔约 85 米
	const towers = [
		[ - 14, - 6, 7.5, 52, 34 ], [ 24, 6, 4.5, 36, 18 ], [ - 26, 7, 4, 30, 16 ], [ 22, - 8, 3.6, 40, 22 ],
		[ 6, 9.5, 3, 28, 14 ], [ - 4, - 12, 5, 44, 24 ], [ 34, - 2, 3.4, 26, 12 ], [ - 36, - 4, 3.8, 24, 13 ],
	];
	for ( const [ x, z, radius, height, spire ] of towers ) {

		parts.push( paint( placeLocal( new THREE.CylinderGeometry( radius, radius * 1.05, height, 20 ), x, height / 2, z ), stone ) );
		parts.push( paint( placeLocal( new THREE.CylinderGeometry( radius + 0.7, radius + 0.7, 1.4, 20 ), x, height - 0.7, z ), stone ) );
		parts.push( paint( placeLocal( new THREE.ConeGeometry( radius + 0.9, spire, 20 ), x, height + spire / 2, z ), roof ) );
		// 每层约 4.5 米，一圈开 6 扇窗（从湖对岸、星月夜、雪原哪边看都有灯），随机空掉一些
		for ( let level = 6; level < height - 3; level += 4 + random() * 1.5 ) {

			for ( const angle of [ - 2.1, - 1.05, 0, 1.05, 2.1, Math.PI ] ) {

				if ( random() < 0.35 ) continue;
				addWindow( x + Math.sin( angle ) * radius, level, z + Math.cos( angle ) * radius, Math.sin( angle ), Math.cos( angle ), 80 );

			}

		}

	}

	// 城墙：连着外侧几座塔，高 14 米
	const walls = [ [ - 36, - 4, - 26, 7 ], [ 24, 6, 34, - 2 ], [ 34, - 2, 22, - 8 ], [ - 36, - 4, - 14, - 6 ] ];
	for ( const [ startX, startZ, endX, endZ ] of walls ) {

		const wallLength = Math.hypot( endX - startX, endZ - startZ );
		const wall = new THREE.BoxGeometry( wallLength, 14, 3 );
		parts.push( paint( placeLocal( wall, ( startX + endX ) / 2, 7, ( startZ + endZ ) / 2, - Math.atan2( endZ - startZ, endX - startX ) ), stone ) );

	}

	// 主厅两头的山墙也开几扇（从北边、南边看过来的时候）
	for ( const side of [ 1, - 1 ] ) {

		for ( const row of [ 7, 15 ] ) {

			for ( const z of [ - 4, 0, 4 ] ) {

				if ( random() < 0.35 ) continue;
				addWindow( 24 * side, row + ( random() - 0.5 ) * 2, z + ( random() - 0.5 ) * 1.5, side, 0, 38 );

			}

		}

	}

	// 小礼拜堂 + 一座细尖塔
	parts.push( paint( placeLocal( new THREE.BoxGeometry( 14, 18, 10 ), 12, 9, - 14 ), stone ) );
	parts.push( paint( placeLocal( gableRoof( 14, 11, 9 ), 12, 18, - 14 ), roof ) );
	parts.push( paint( placeLocal( new THREE.ConeGeometry( 1.6, 16, 8 ), 18, 34, - 14 ), roof ) );
	for ( let x = 7; x <= 17; x += 2.5 ) addWindow( x, 9, - 9, 0, 1, 38, 1.3, 3.2 );

	const merged = mergeToWorld( parts, 0, 0, 0, 0 );
	merged.applyMatrix4( new THREE.Matrix4().makeTranslation( castleX, groundY, castleZ ).multiply( new THREE.Matrix4().makeRotationY( facing ) ).multiply( new THREE.Matrix4().makeScale( castleScale, castleScale, castleScale ) ) );
	return [ merged ];

}

// ===================== 替身：星月夜的小镇（溪边几十座小房子 + 教堂尖塔）=====================
// 星月夜机位、小镇、哥特城堡差不多在一条线上（都在 160° 方位），房子不能挡住"湖和城堡窗灯"（规格书 5.0）：
// 从机位看，去城堡和去湖心那两条视线左右各 4° 的楔形里不盖房子，教堂挪到视线左边

function buildTown( world, windows ) {

	const starry = world.locations.starry;
	const [ centerX, , centerZ ] = starry.landmark;
	const stream = world.getRiver( 'townStream' );
	const random = createRandom( 1889 );
	// 每栋房子再多开一两扇窗（审查 R30：飞过小镇时房子是一个个白盒子，看不出亮窗）。用另一串随机数，房子的位置不变（树林布点按房子让开）
	const extraRandom = createRandom( 4242 );
	const walls = [ '#d9c9a8', '#cbb79a', '#b9a68c', '#a7aab2', '#c7b08a' ];
	const roofs = [ '#6e3b2e', '#5a3a30', '#4a4f63', '#7a4a35' ];
	const parts = [];
	const placed = [];
	const [ viewX, , viewZ ] = starry.origin;
	const lake = world.config.lake;
	const keepClearAzimuths = [ world.locations.gothic.landmark, [ lake.center[ 0 ], 0, lake.center[ 1 ] ] ].map( ( target ) => Math.atan2( target[ 0 ] - viewX, - ( target[ 2 ] - viewZ ) ) );
	const blocksView = ( x, z ) => {

		const azimuth = Math.atan2( x - viewX, - ( z - viewZ ) );
		return keepClearAzimuths.some( ( clear ) => Math.abs( Math.atan2( Math.sin( azimuth - clear ), Math.cos( azimuth - clear ) ) ) < 4 * degree );

	};

	function addHouse( x, z, width, depth, height, yaw, wallHex, roofHex, windowCount ) {

		const corners = [ [ - 1, - 1 ], [ 1, - 1 ], [ 1, 1 ], [ - 1, 1 ] ].map( ( [ signX, signZ ] ) => world.worldHeight(
			x + ( signX * width / 2 ) * Math.cos( yaw ) + ( signZ * depth / 2 ) * Math.sin( yaw ),
			z - ( signX * width / 2 ) * Math.sin( yaw ) + ( signZ * depth / 2 ) * Math.cos( yaw ) ) );
		const base = Math.min( ...corners ) - 0.5;
		const wallHeight = height + Math.max( ...corners ) - Math.min( ...corners );
		parts.push( paint( placeLocal( new THREE.BoxGeometry( width, wallHeight, depth ), x, base + wallHeight / 2, z, yaw ), wallHex ) );
		parts.push( paint( placeLocal( gableRoof( width + 0.6, depth + 0.8, Math.min( width, depth ) * 0.45 ), x, base + wallHeight, z, yaw ), roofHex ) );
		// 盒子：本地 x 方向长 width、z 方向深 depth，绕 y 转 yaw；屋脊沿本地 x，屋顶比墙每边宽出 0.3 / 0.4 米
		state.townHouses.push( { kind: 'house', x, z, base, width, depth, wallHeight, yaw, roofLength: width + 0.6, roofWidth: depth + 0.8, roofHeight: Math.min( width, depth ) * 0.45, wall: wallHex, roof: roofHex } );
		for ( let k = 0; k < windowCount; k ++ ) {

			// 窗开在长边上，前后随机
			const side = random() < 0.5 ? - 1 : 1;
			const along = ( random() - 0.5 ) * width * 0.6;
			const localZ = side * ( depth / 2 + 0.3 );
			windows.push( {
				x: x + along * Math.cos( yaw ) + localZ * Math.sin( yaw ),
				y: base + wallHeight - height + 1.6 + random() * Math.max( 0, height - 3.2 ),
				z: z - along * Math.sin( yaw ) + localZ * Math.cos( yaw ),
				normalX: side * Math.sin( yaw ), normalZ: side * Math.cos( yaw ),
				width: 1.3, height: 1.7, floor: random() * 0.6, random: random(),
			} );

		}

		// 多开的窗：前后两面各一扇的机会，窗比真实的大一点（远处也是一个暖点）
		const extraCount = 1 + Math.floor( extraRandom() * 2 );
		for ( let k = 0; k < extraCount; k ++ ) {

			const side = k % 2 === 0 ? 1 : - 1;
			const along = ( extraRandom() - 0.5 ) * width * 0.6;
			const localZ = side * ( depth / 2 + 0.3 );
			windows.push( {
				x: x + along * Math.cos( yaw ) + localZ * Math.sin( yaw ),
				y: base + wallHeight - height + 1.6 + extraRandom() * Math.max( 0, height - 3.2 ),
				z: z - along * Math.sin( yaw ) + localZ * Math.cos( yaw ),
				normalX: side * Math.sin( yaw ), normalZ: side * Math.cos( yaw ),
				width: 1.3, height: 1.7, floor: extraRandom() * 0.6, random: extraRandom() * 0.9,
			} );

		}

		state.houseFootprints.push( [ x, z, Math.hypot( width, depth ) / 2 ] );

	}

	// 教堂：中殿 + 方塔 + 四棱尖顶（原画里那座细高的教堂尖塔）；放在小镇中心往机位视线右边约 36 米：
	// 星月夜画面里尖塔在柏树右边、城堡右边一点（和原画一样），不挡城堡（原来在左边 50 米，正好藏在柏树后面）
	const rightAzimuth = keepClearAzimuths[ 0 ] + Math.PI / 2;
	const churchX = centerX + Math.sin( rightAzimuth ) * 36;
	const churchZ = centerZ - Math.cos( rightAzimuth ) * 36;
	const churchYaw = 0.4;
	addHouse( churchX + 6, churchZ - 4, 22, 10, 11, churchYaw, '#c9bfae', '#4a4f63', 6 );
	const towerX = churchX - 6;
	const towerZ = churchZ - 9;
	const towerBase = world.worldHeight( towerX, towerZ ) - 0.5;
	parts.push( paint( placeLocal( new THREE.BoxGeometry( 5, 22, 5 ), towerX, towerBase + 11, towerZ, churchYaw ), '#c9bfae' ) );
	parts.push( paint( placeLocal( new THREE.ConeGeometry( 3.6, 20, 4 ), towerX, towerBase + 32, towerZ, churchYaw + Math.PI / 4 ), '#3c4256' ) );
	// 钟楼：5 × 5 米、22 米高的方塔；尖顶是四棱锥（底的外接圆半径 3.6、高 20），四个角对着塔的四个面（多转了 45°）
	state.townHouses.push( { kind: 'tower', x: towerX, z: towerZ, base: towerBase, width: 5, depth: 5, wallHeight: 22, yaw: churchYaw, spireRadius: 3.6, spireHeight: 20, wall: '#c9bfae', roof: '#3c4256' } );
	state.houseFootprints.push( [ towerX, towerZ, 4 ] );
	placed.push( [ churchX + 6, churchZ - 4, 16 ], [ towerX, towerZ, 6 ] );

	let attempts = 0;
	while ( placed.length < 72 && attempts < 5000 ) {

		attempts ++;
		const angle = random() * Math.PI * 2;
		const radius = Math.sqrt( random() ) * 190;
		const x = centerX + Math.cos( angle ) * radius;
		const z = centerZ + Math.sin( angle ) * radius;
		if ( world.nearestOnRiver( stream, x, z ).distance < stream.halfWidth + 7 ) continue;
		if ( blocksView( x, z ) ) continue;
		if ( placed.some( ( [ otherX, otherZ, spacing ] ) => Math.hypot( x - otherX, z - otherZ ) < spacing + 7 ) ) continue;
		// 太陡的地方不盖房子
		const slope = Math.abs( world.worldHeight( x + 4, z ) - world.worldHeight( x - 4, z ) ) + Math.abs( world.worldHeight( x, z + 4 ) - world.worldHeight( x, z - 4 ) );
		if ( slope > 5 ) continue;
		const width = 6 + random() * 5;
		const depth = 6 + random() * 4;
		const yaw = 0.4 + ( random() - 0.5 ) * 0.7 + ( random() < 0.3 ? Math.PI / 2 : 0 );
		addHouse( x, z, width, depth, 4.5 + random() * 3.5, yaw, walls[ Math.floor( random() * walls.length ) ], roofs[ Math.floor( random() * roofs.length ) ], 1 + Math.floor( random() * 2 ) );
		placed.push( [ x, z, Math.max( width, depth ) / 2 ] );

	}

	return [ mergeToWorld( parts, 0, 0, 0, 0 ) ];

}

// ===================== 替身：落日海湾的海蚀柱 =====================

function buildSeaStacks( world ) {

	const parts = [];
	const local = new THREE.Vector3();
	const target = new THREE.Vector3();
	seaStacks.forEach( ( [ x, z, radius, height ], index ) => {

		world.toWorld( local.set( x, 0, z ), 'sunset', target );
		const geometry = new THREE.CylinderGeometry( radius * 0.55, radius * 1.05, height + 3, 12, 6 );
		// 顶点按噪声推进推出，像风化的岩柱
		const position = geometry.attributes.position;
		for ( let i = 0; i < position.count; i ++ ) {

			const vertexX = position.getX( i );
			const vertexY = position.getY( i );
			const vertexZ = position.getZ( i );
			const bulge = 0.8 + 0.4 * jsFbm2D( Math.atan2( vertexZ, vertexX ) * 1.3 + index * 7.1, vertexY * 0.35, 3 );
			position.setXYZ( i, vertexX * bulge, vertexY, vertexZ * bulge );

		}

		geometry.computeVertexNormals();
		parts.push( paint( placeLocal( geometry, target.x, ( height + 3 ) / 2 - 3, target.z ), '#5b514c' ) );

	} );

	return [ mergeToWorld( parts, 0, 0, 0, 0 ) ];

}

// ===================== 替身材质 =====================

function createProxyMaterial() {

	const sky = state.world.uniforms;
	const uniforms = state.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '远景替身';
	material.fog = false;
	material.lights = false;
	material.positionNode = compressedPosition( positionLocal );

	material.colorNode = Fn( () => {

		const point = positionGeometry;
		const viewer = viewerPosition();
		const normal = normalize( normalGeometry );
		const surfaceData = attribute( 'surface', 'vec4' );
		const albedo = nightAlbedo( surfaceData.rgb );
		const shine = surfaceData.a;
		const viewDirection = normalize( point.sub( viewer ) );

		const sunShadow = terrainShadow( point, uniforms.sunHorizon, sky.sunElevation, 1.3 );
		const moonShadow = terrainShadow( point, uniforms.moonHorizon, sky.moonElevation, 3 );
		const result = albedo.mul( lightAt( normal, sunShadow, moonShadow, float( 0.85 ) ) ).toVar();

		// 月光勾边：夜里尖塔、屋脊的轮廓被月光勾出来（规格书 11.2"月光勾出尖塔的轮廓"）
		const rim = pow( max( float( 1 ).sub( max( dot( normal, viewDirection.negate() ), 0 ) ), 0 ), 4 );
		result.addAssign( sky.moonLightColor.mul( rim.mul( 0.8 ) ).mul( moonShadow ) );

		// 银穹顶：反射统一天空（穹顶的美感几乎全靠反射的天空渐变），太阳高光按粗糙度 0.2 的量级给一个宽亮斑
		If( shine.greaterThan( 0.01 ), () => {

			const bounced = reflect( viewDirection, normal );
			const reflected = daySkyColor( normalize( vec3( bounced.x, max( bounced.y, - 0.2 ), bounced.z ) ), sky, uniforms.time, { sunDisc: false, stars: false } );
			const highlight = pow( max( dot( bounced, sky.sunDirection ), 0 ), 40 ).mul( 6 ).mul( sunShadow );
			const metal = albedo.mul( reflected.add( sky.sunLightColor.mul( highlight ) ) ).mul( 0.85 ).add( result.mul( 0.15 ) );
			result.assign( mix( result, metal, shine ) );

		} );

		return applyAtmosphere( result, point, viewer );

	} )();

	return material;

}

// ===================== 窗灯 =====================
// 每扇窗一个面向相机的小方片（顶点着色器里直接算裁剪坐标）。远处缩到不足 1.6 像素时按 1.6 像素画、亮度按面积比例降下来（能量守恒），
// 不会远远一片光斑。方片沿视线往相机挪出自己尺寸的一半多，免得放大以后被自己的墙挡掉；侧着看的窗按朝向变暗；远处跟城堡一样有雾。
// 亮起：天黑程度 windowLights 越过每扇窗自己的门槛就亮，门槛 = 随机 + 楼层（从下往上亮），有一成多的窗深夜也不亮；
// 少数窗偶尔熄了又亮（规格书 11.2）

function buildWindowGeometry( windows ) {

	const count = windows.length;
	const centers = new Float32Array( count * 4 * 3 );
	const outwardNormals = new Float32Array( count * 4 * 3 );
	const corners = new Float32Array( count * 4 * 2 );
	const data = new Float32Array( count * 4 * 4 );
	const indices = [];
	const cornerList = [ [ - 1, - 1 ], [ 1, - 1 ], [ 1, 1 ], [ - 1, 1 ] ];

	windows.forEach( ( item, index ) => {

		for ( let k = 0; k < 4; k ++ ) {

			const vertex = index * 4 + k;
			centers.set( [ item.x, item.y, item.z ], vertex * 3 );
			outwardNormals.set( [ item.normalX, 0, item.normalZ ], vertex * 3 );
			corners.set( cornerList[ k ], vertex * 2 );
			data.set( [ item.random, Math.min( 1, Math.max( 0, item.floor ) ), item.width, item.height ], vertex * 4 );

		}

		const base = index * 4;
		indices.push( base, base + 1, base + 2, base, base + 2, base + 3 );

	} );

	const geometry = new THREE.BufferGeometry();
	// position 只是给包围球用的（真正的位置在顶点着色器里算）
	geometry.setAttribute( 'position', new THREE.BufferAttribute( centers.slice(), 3 ) );
	geometry.setAttribute( 'windowCenter', new THREE.BufferAttribute( centers, 3 ) );
	geometry.setAttribute( 'windowNormal', new THREE.BufferAttribute( outwardNormals, 3 ) );
	geometry.setAttribute( 'windowCorner', new THREE.BufferAttribute( corners, 2 ) );
	geometry.setAttribute( 'windowData', new THREE.BufferAttribute( data, 4 ) );
	geometry.setIndex( indices );
	geometry.computeBoundingSphere();
	return geometry;

}

// amount：这个地点替身窗灯的亮度倍数（uniform）
function createWindowMaterial( amount ) {

	const sky = state.world.uniforms;
	const uniforms = state.uniforms;
	const worldConfig = state.world.config;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '远景窗灯';
	material.fog = false;
	material.lights = false;
	material.transparent = true;
	material.depthWrite = false;
	material.blending = THREE.AdditiveBlending;

	const center = attribute( 'windowCenter', 'vec3' );
	const outward = attribute( 'windowNormal', 'vec3' );
	const corner = attribute( 'windowCorner', 'vec2' );
	const data = attribute( 'windowData', 'vec4' );   // 随机数、楼层比例、宽、高（米）

	const viewCenter = cameraViewMatrix.mul( modelWorldMatrix.mul( vec4( center, 1 ) ) ).xyz;
	const distance = max( length( viewCenter ), 1e-3 );
	// 屏幕上一个像素对应的角度：2 / (投影矩阵[1][1] × 画面高)
	const pixelAngle = float( 2 ).div( cameraProjectionMatrix[ 1 ][ 1 ].mul( screenSize.y ) );
	const minimumSize = pixelAngle.mul( distance ).mul( 1.6 );
	const worldSize = vec2( data.z, data.w );
	const drawnSize = max( worldSize, vec2( minimumSize ) );
	const areaRatio = worldSize.x.mul( worldSize.y ).div( drawnSize.x.mul( drawnSize.y ) );
	// 方片中心沿视线往相机挪：0.3 米 + 画出来尺寸的 0.6 倍（最多挪到一半距离），屏幕上的位置不变
	const pull = min( float( 0.3 ).add( max( drawnSize.x, drawnSize.y ).mul( 0.6 ) ), distance.mul( 0.5 ) );
	const pulledCenter = viewCenter.mul( distance.sub( pull ).div( distance ) );
	const viewPosition = pulledCenter.add( vec3( corner.mul( drawnSize ).mul( 0.5 ), 0 ) );
	const viewDistance = max( length( viewPosition ), 1e-3 );
	material.vertexNode = cameraProjectionMatrix.mul( vec4( viewPosition.mul( compressDistance( viewDistance ).div( viewDistance ) ), 1 ) );

	// 亮不亮：门槛 = 0.05 + 随机 × 0.95 + 楼层 × 0.15（最高约 1.15，天全黑时 windowLights = 1，门槛高的那一成多不亮）；
	// 少数窗（随机 > 0.97）每隔二三十秒熄一会儿
	const threshold = float( 0.05 ).add( data.x.mul( 0.95 ) ).add( data.y.mul( 0.15 ) );
	const lit = smoothstep( threshold, threshold.add( 0.06 ), sky.windowLights );
	const blink = mix( float( 1 ), step( 0.18, sin( uniforms.time.div( data.x.mul( 9 ).add( 20 ) ).mul( Math.PI * 2 ).add( data.x.mul( 40 ) ) ).mul( 0.5 ).add( 0.5 ) ), step( 0.97, data.x ) );
	const flicker = sin( uniforms.time.mul( data.x.mul( 3 ).add( 2 ) ).add( data.x.mul( 40 ) ) ).mul( 0.06 ).add( 1 );
	// 朝向：正对着看最亮，侧着看变暗，背对就看不见
	const viewer = viewerPosition();
	const facing = smoothstep( 0.05, 0.45, dot( outward, normalize( viewer.sub( center ) ) ) );
	// 远处和城堡一样有雾（大气透视）
	const haze = heightFogFactor( float( Math.LN2 ).div( sky.hazeDistance ), float( worldConfig.hazeFalloff ), center, viewer ).mul( state.toggles.大气透视 );
	const brightness = varying( lit.mul( blink ).mul( flicker ).mul( areaRatio ).mul( facing ).mul( float( 1 ).sub( haze.mul( 0.85 ) ) ) );
	const cornerVarying = varying( corner );

	material.colorNode = Fn( () => {

		// 方片里一个软边的窗口形状；画成一两个像素时就是一个柔和的光点
		const shape = fadeOut( 0.55, 1.0, max( abs( cornerVarying.x ), abs( cornerVarying.y ) ) );
		return uniforms.windowColor.mul( uniforms.windowIntensity ).mul( brightness ).mul( shape ).mul( state.toggles.窗灯 ).mul( amount );

	} )();

	return material;

}

// ===================== 构建 =====================

export function init( ctx ) {

	// 上一次还在建：等同一个，不并行建两份（两份会互相覆盖模块里的网格、贴图）
	if ( state.building ) return state.building;
	if ( state.scene ) {

		console.warn( '远景：init 被重复调用，先释放旧的再重建' );
		dispose();

	}

	state.building = build( ctx ).finally( () => {

		state.building = null;

	} );
	return state.building;

}

async function build( ctx ) {

	if ( ! ctx.world ) throw new Error( '远景：ctx.world 为空，先在 main.js 里 createWorld' );

	const buildStart = performance.now();
	const slice = { start: performance.now() };
	const timings = [];
	let stepStart = performance.now();
	const markStep = ( label ) => {

		timings.push( `${ label } ${ ( performance.now() - stepStart ).toFixed( 0 ) }` );
		stepStart = performance.now();

	};

	state.ctx = ctx;
	state.world = ctx.world;
	state.houseFootprints = [];
	state.townHouses = [];
	const world = ctx.world;
	const worldConfig = world.config;
	const terrainConfig = worldConfig.terrain;
	const tier = tierOf( ctx );

	// ---------- 网格采样 ----------
	const coreSpacing = terrainConfig.coreSpacing[ tier ] || terrainConfig.coreSpacing.mid;
	const coreCountX = Math.round( terrainConfig.coreSize[ 0 ] / coreSpacing ) + 1;
	const coreCountZ = Math.round( terrainConfig.coreSize[ 1 ] / coreSpacing ) + 1;
	const coreMinX = terrainConfig.coreCenter[ 0 ] - terrainConfig.coreSize[ 0 ] / 2;
	const coreMinZ = terrainConfig.coreCenter[ 1 ] - terrainConfig.coreSize[ 1 ] / 2;
	state.core = await sampleGrid( world, coreMinX, coreMinZ, coreCountX, coreCountZ, coreSpacing, slice );

	// 外圈：格子线从核心区的角往外数整格，核心区的四条边正好落在外圈的格子线上；核心区边上的高度和外圈的边对齐
	const outerSpacing = typeof terrainConfig.outerSpacing === 'number' ? terrainConfig.outerSpacing : ( terrainConfig.outerSpacing[ tier ] || terrainConfig.outerSpacing.mid );
	const cellsWest = Math.round( ( terrainConfig.outerSize / 2 - terrainConfig.coreSize[ 0 ] / 2 ) / outerSpacing );
	const cellsNorth = Math.round( ( terrainConfig.outerSize / 2 - terrainConfig.coreSize[ 1 ] / 2 ) / outerSpacing );
	const outerCountX = cellsWest * 2 + Math.round( terrainConfig.coreSize[ 0 ] / outerSpacing ) + 1;
	const outerCountZ = cellsNorth * 2 + Math.round( terrainConfig.coreSize[ 1 ] / outerSpacing ) + 1;
	state.outer = await sampleGrid( world, coreMinX - cellsWest * outerSpacing, coreMinZ - cellsNorth * outerSpacing, outerCountX, outerCountZ, outerSpacing, slice );
	matchCoreEdges( state.core, outerSpacing );
	markStep( '采样' );

	// ---------- 噪声贴图（地形、云、水面共用）----------
	const noiseData = createNoiseTextureData( 256, 32, 7 );
	const noiseTexture = new THREE.DataTexture( noiseData.data, noiseData.size, noiseData.size, THREE.RGBAFormat, THREE.UnsignedByteType );
	noiseTexture.wrapS = THREE.RepeatWrapping;
	noiseTexture.wrapT = THREE.RepeatWrapping;
	noiseTexture.magFilter = THREE.LinearFilter;
	noiseTexture.minFilter = THREE.LinearMipmapLinearFilter;
	noiseTexture.generateMipmaps = true;
	noiseTexture.needsUpdate = true;
	noiseTexture.name = '远景噪声';
	state.disposables.push( noiseTexture );
	state.textures = { horizon: null, biome: null, noise: noiseTexture, noiseData };
	markStep( '噪声贴图' );

	// ---------- 地平线图、地表图 ----------
	state.horizon = await buildHorizonMap( worldConfig, slice );
	markStep( '地平线图' );
	state.textures.horizon = state.horizon;
	state.textures.biome = await buildBiomeMap( world, worldConfig, slice );
	markStep( '地表图' );
	state.textures.surface = createSurfaceTexture( ctx.terrainBake );
	state.disposables.push( state.horizon.texture, state.textures.biome.texture, state.textures.surface.texture, state.textures.surface.textureB );
	// 地表贴图（远景和各地点的地面共用，常驻）
	state.ground = await loadGroundTextures( ctx.config.ground, tier === 'hi' ? 8 : 4 );
	if ( state.ground ) state.disposables.push( state.ground );
	markStep( '地表贴图' );
	state.grassGround = await buildGrassGround( slice );
	state.disposables.push( state.grassGround.texture );
	markStep( '草地图' );

	// ---------- uniform 和效果层开关 ----------
	const core = state.core;
	// 在核心区里的程度：insideCore 边上只过渡 1%（湖、河、桃林、花海这些地表图上的东西），
	// insideCoreWide 过渡 8%（约 350 米，地形阴影和天光遮蔽），外圈看不出一条分界线
	const insideCoreNode = ( point, edge ) => {

		const uv = point.xz.sub( uniforms.coreMin ).div( uniforms.coreSize );
		return smoothstep( 0, edge, uv.x ).mul( fadeOut( 1 - edge, 1, uv.x ) ).mul( smoothstep( 0, edge, uv.y ) ).mul( fadeOut( 1 - edge, 1, uv.y ) );

	};

	const horizonSelector = () => ( {
		blockA: uniform( 0 ), blockB: uniform( 0 ),
		maskA: uniform( new THREE.Vector4( 1, 0, 0, 0 ) ), maskB: uniform( new THREE.Vector4( 1, 0, 0, 0 ) ),
		blend: uniform( 0 ),
	} );

	const cloudConfig = worldConfig.clouds;
	const iceSource = world.getRiver( 'townStream' ).points[ 0 ];
	const uniforms = {
		time: uniform( 0 ),
		sceneToWorld: uniform( new THREE.Matrix4() ),
		// 关掉时 start = 1e8、end = 2e8（范围不能是 0：float32 里 1e8 + 1 就是 1e8，0/0 会出 NaN 把顶点甩飞）
		compressStart: uniform( 1e8 ),
		compressEnd: uniform( 2e8 ),
		// 烘焙地形的遮罩：有没有（1/0）、世界 xz → 贴图坐标的缩放和偏移（对准贴图像素中心）
		bakedSurface: uniform( state.textures.surface.grid ? 1 : 0 ),
		surfaceScale: uniform( state.textures.surface.scale ),
		surfaceOffset: uniform( state.textures.surface.offset ),
		coreMin: uniform( new THREE.Vector2( core.minX, core.minZ ) ),
		coreSize: uniform( new THREE.Vector2( core.sizeX, core.sizeZ ) ),
		outerCenter: uniform( new THREE.Vector2( terrainConfig.coreCenter[ 0 ], terrainConfig.coreCenter[ 1 ] ) ),
		outerHalf: uniform( terrainConfig.outerSize / 2 ),
		horizonMin: uniform( new THREE.Vector2( state.horizon.minX, state.horizon.minZ ) ),
		horizonSpacing: uniform( state.horizon.spacing ),
		horizonCount: uniform( new THREE.Vector2( state.horizon.countX, state.horizon.countZ ) ),
		sunHorizon: horizonSelector(),
		moonHorizon: horizonSelector(),
		ambientStrength: uniform( 1 ),
		nightFill: uniform( 1 ),         // 月光补光的倍数（地点设，见 setNightFill）
		bounceDirection: uniform( new THREE.Vector3( 0, 1, 0 ) ),   // 反射补光从哪个方向来（世界，指向光）
		bounceColor: uniform( new THREE.Color( 0, 0, 0 ) ),         // 反射补光的颜色 × 强度（默认黑，不起作用）
		cloudHeight: uniform( cloudConfig.height ),
		cloudCoverage: uniform( cloudConfig.coverage ),
		cloudScale: uniform( cloudConfig.scale ),
		cloudOffset: uniform( new THREE.Vector2() ),
		cloudWind: uniform( new THREE.Vector2( 1, 0 ) ),
		cloudSunColor: uniform( new THREE.Color() ),
		windowColor: uniform( new THREE.Color( worldConfig.windowColor ) ),
		windowIntensity: uniform( worldConfig.windowIntensity ),
		forestFrom: uniform( tier === 'lo' ? 900 : 2000 ),
		forestTo: uniform( tier === 'lo' ? 1600 : 3500 ),
		groundNear: uniform( ctx.config.ground.near[ tier ] || ctx.config.ground.near.mid ),
		treeNear: uniform( ctx.config.trees.near[ tier ] || ctx.config.trees.near.mid ),
		treeNearBase: ctx.config.trees.near[ tier ] || ctx.config.trees.near.mid,
		treeBand: uniform( ctx.config.trees.band ),
		treeNearOn: uniform( 0 ),    // 近处的 3D 树建好了才是 1（没建好时树团照常全画）
		understoryNear: uniform( ctx.config.trees.understory.near[ tier ] || ctx.config.trees.understory.near.mid ),
		understoryNearBase: ctx.config.trees.understory.near[ tier ] || ctx.config.trees.understory.near.mid,
		// 冰瀑：小镇溪源头那一段台地崖壁
		iceFallX: uniform( iceSource.x ),
		iceFallBottom: uniform( iceSource.y ),
		iceFallZ: uniform( new THREE.Vector2( - 1785, - 1645 ) ),   // 冰瀑的南北范围：台地崖顶 → 崖脚
		// 地点对接（见 setSeaCut / setContentHole / setLocationFog / setSurfaceGain）；默认都不起作用
		surfaceGain: uniform( 1 ),
		seaCutCenter: uniform( new THREE.Vector2() ),
		seaCutRadius: uniform( 0 ),
		seaCutFade: uniform( 1 ),
		seaCutDepth: uniform( 0 ),
		holeMin: uniform( new THREE.Vector2( 1e7, 1e7 ) ),
		holeMax: uniform( new THREE.Vector2( - 1e7, - 1e7 ) ),
		sinkMin: uniform( new THREE.Vector2( 1e7, 1e7 ) ),
		sinkMax: uniform( new THREE.Vector2( 1e7 + 1, 1e7 + 1 ) ),
		sinkFade: uniform( 1 ),
		sinkDepth: uniform( 0 ),
		lakeCutDepth: uniform( 0 ),
		locationFogDensity: uniform( 0 ),
		locationFogFalloff: uniform( 10 ),
		locationFogBase: uniform( 0 ),
		locationFogColor: uniform( new THREE.Color() ),
		locationFogScatter: uniform( new THREE.Color() ),
		locationFogLight: uniform( new THREE.Vector3( 0, 1, 0 ) ),
		locationFogAnisotropy: uniform( 0.6 ),
		locationFogAmount: uniform( 0 ),
		// 草根融合（地点的草长到远景地面上时）：草的近环圆心（世界坐标）、半径（0 = 不画）、强度、草根色
		grassUnderlayCenter: uniform( new THREE.Vector2() ),
		grassUnderlayRadius: uniform( 0 ),
		grassUnderlayAmount: uniform( 0 ),
		grassUnderlayNear: uniform( 0 ),
		grassUnderlayFar: uniform( 0 ),          // 远环半径（米）
		grassUnderlayFarAmount: uniform( 0 ),
		grassRootColor: uniform( new THREE.Color( '#2b4f17' ) ),
		grassMiddleColor: uniform( new THREE.Color( '#3c6b20' ) ),
		insideCore: ( point ) => insideCoreNode( point, 0.01 ),
		insideCoreWide: ( point ) => insideCoreNode( point, 0.08 ),
		// 哥特岩台一带（台心往外 半径 + 落差宽度 以内是 1，再往外 60 米淡掉）
		mesaDark: ( point ) => {

			const mesa = worldConfig.terrainShape.gothicMesa;
			if ( ! mesa ) return float( 0 );
			const reach = mesa.radius + mesa.edgeWander + mesa.falloff;
			return float( 1 ).sub( smoothstep( reach, reach + 60, length( point.xz.sub( vec2( mesa.center[ 0 ], mesa.center[ 1 ] ) ) ) ) );

		},
	};
	state.uniforms = uniforms;

	const toggles = {
		地形阴影: uniform( 1 ),
		天光遮蔽: uniform( 1 ),
		地表细节: uniform( 1 ),
		大气透视: uniform( 1 ),
		贴地薄雾: uniform( 1 ),
		水面: uniform( 1 ),
		水面倒影: uniform( 1 ),
		水面高光: uniform( 1 ),
		薄云: uniform( 1 ),
		云影: uniform( 1 ),
		谷雾: uniform( 1 ),
		云团: uniform( 1 ),
		树林显示: uniform( 1 ),
		近处树: uniform( 1 ),
		林下灌木: uniform( 1 ),
		笔触边缘: uniform( 1 ),
		野花: uniform( 1 ),
		窗灯: uniform( 1 ),
		山洞: uniform( 1 ),
	};
	state.toggles = toggles;
	if ( ! Number.isFinite( cloudConfig.direction ) ) throw new Error( '远景：config.world.clouds.direction（云往哪个方位飘，度）没填' );
	const windAngle = cloudConfig.direction * degree;
	state.windDirection.set( Math.sin( windAngle ), - Math.cos( windAngle ) );
	uniforms.cloudWind.value.copy( state.windDirection );

	// ---------- 场景 ----------
	const scene = new THREE.Scene();
	scene.background = new THREE.Color( 0x000000 );
	const root = new THREE.Group();
	root.name = '远景';
	scene.add( root );

	// 天空球
	const skyGeometry = new THREE.SphereGeometry( 1, 64, 32 );
	const skyMaterial = createSkyMaterial( tier );
	const skyDome = new THREE.Mesh( skyGeometry, skyMaterial );
	skyDome.name = '远景天空';
	skyDome.frustumCulled = false;
	skyDome.renderOrder = 1000;
	root.add( skyDome );
	state.skyDome = skyDome;
	state.disposables.push( skyGeometry, skyMaterial );

	// 山洞：先建（地形材质的挖洞要用它的 uniform）
	state.caveMeshes = buildCave( world );
	for ( const mesh of state.caveMeshes ) root.add( mesh );

	// 窄处的地形补丁的位置（材质里要按它丢掉远景网格，先算好）
	state.patches = patchFootprints( worldConfig );

	// 地形：核心区（带 40 米裙边）+ 外圈（挖掉核心区）
	const terrainMaterial = createTerrainMaterial();
	const coreGeometry = buildGridGeometry( state.core, { skirt: 40 } );
	const outerGeometry = buildGridGeometry( state.outer, {
		hole: { minX: core.minX - 0.01, maxX: core.minX + core.sizeX + 0.01, minZ: core.minZ - 0.01, maxZ: core.minZ + core.sizeZ + 0.01 },
	} );
	state.terrainMeshes = [];
	for ( const [ geometry, name ] of [ [ coreGeometry, '远景地形·核心' ], [ outerGeometry, '远景地形·外圈' ] ] ) {

		const mesh = new THREE.Mesh( geometry, terrainMaterial );
		mesh.name = name;
		mesh.frustumCulled = false;
		root.add( mesh );
		state.terrainMeshes.push( mesh );

	}

	state.disposables.push( terrainMaterial, coreGeometry, outerGeometry );
	for ( const patch of state.patches ) {

		const geometry = await buildTerrainPatch( patch, tier, world, slice );
		const mesh = new THREE.Mesh( geometry, terrainMaterial );
		mesh.name = `远景地形·补丁·${ patch.name }`;
		mesh.frustumCulled = false;
		root.add( mesh );
		state.terrainMeshes.push( mesh );
		state.disposables.push( geometry );

	}

	markStep( '地形网格' );

	// 替身和窗灯：每个地点一组，4b 交接时按地点显隐。先建替身（小镇的房子位置要给树林让开）。
	// 替身不做视锥剔除：包围球是没压缩的世界坐标，4b 里压缩深度时会被 far 面错误地整个剔掉
	const proxyMaterial = createProxyMaterial();
	state.disposables.push( proxyMaterial );
	const builders = {
		garden: async ( windows ) => ( await buildGardenProxyModel( world ) ) || buildGardenCastle( world, windows ),
		gothic: async ( windows ) => ( await buildGothicProxyModel( world, windows ) ) || buildGothicCastle( world, windows ),
		starry: ( windows ) => buildTown( world, windows ),
		sunset: () => buildSeaStacks( world ),
	};
	const windowLimits = worldConfig.windowLights;
	for ( const [ locationKey, builder ] of Object.entries( builders ) ) {

		const group = new THREE.Group();
		group.name = '替身·' + world.locations[ locationKey ].name;
		const windows = [];
		for ( const geometry of await builder( windows ) ) {

			const mesh = new THREE.Mesh( geometry, proxyMaterial );
			mesh.name = group.name;
			mesh.frustumCulled = false;
			group.add( mesh );
			state.disposables.push( geometry );

		}

		const limit = windowLimits[ locationKey ];
		if ( windows.length > 0 ) {

			const chosen = limit !== undefined && windows.length > limit ? windows.slice( 0, limit ) : windows;
			state.windowLists[ locationKey ] = chosen;
			const geometry = buildWindowGeometry( chosen );
			state.windowAmounts[ locationKey ] = uniform( 1 );
			const windowMaterial = createWindowMaterial( state.windowAmounts[ locationKey ] );
			state.disposables.push( windowMaterial );
			const mesh = new THREE.Mesh( geometry, windowMaterial );
			mesh.name = group.name + '·窗灯';
			mesh.frustumCulled = false;
			mesh.renderOrder = 10;
			group.add( mesh );
			state.disposables.push( geometry );

		}

		root.add( group );
		state.proxyGroups[ locationKey ] = group;
		await yieldIfBusy( slice );

	}

	markStep( '替身' );

	// 先窄后豁然开朗的窄处（崖缝、林荫隧道、冰缝）：在树林之前建，树林要让开它们的走廊
	const narrows = await buildNarrows( {
		legs: worldConfig.legs,
		terrainShape: worldConfig.terrainShape,
		groundAt: ( x, z ) => {

			// 远景网格画出来的高度（墙脚、树根贴着看得见的地面）
			const drawn = terrainHeightAt( x, z );
			return Number.isFinite( drawn ) ? drawn : world.sample( x, z ).height;

		},
		lighting: worldLighting,
		atmosphere: worldAtmosphere,
		sky: world.uniforms,
		time: uniforms.time,
		toWorldDirection: sceneDirectionToWorld,
	} );
	state.narrows = narrows.meshes;
	state.corridors = narrows.corridors;
	state.extraTrees = narrows.extraTrees;
	state.forestBoosts = narrows.boosts;
	state.trailPaths = narrows.paths;
	for ( const mesh of narrows.meshes ) root.add( mesh );
	state.disposables.push( ...narrows.disposables );
	markStep( '窄处' );

	// 树林
	state.forest = await buildForest( tier, slice );
	for ( const mesh of state.forest ) root.add( mesh );
	// 谷雾、云团（阶段 12 CP5）
	for ( const mesh of buildValleyMist() ) root.add( mesh );
	for ( const mesh of buildCloudClusters( tier ) ) root.add( mesh );
	markStep( '树林' );

	// 近处的 3D 树（阶段 12 CP3）：每个树种几个变体的模板，按镜头位置挑实例
	state.treeField = await buildNearTrees( ctx, tier, slice );
	if ( state.treeField ) {

		root.add( state.treeField.group );
		uniforms.treeNearOn.value = 1;

	}

	markStep( '近处的树' );

	// 引路的花瓣和光点：花瓣用远景的世界光照，逆光时透一点光，夜里带一点自己的微光（不至于在月光下成黑片）
	const guideConfig = ctx.config.guide;
	state.guide = createGuide( {
		petalCount: guideConfig.petalCount[ tier ] || guideConfig.petalCount.mid,
		moteCount: guideConfig.moteCount[ tier ] || guideConfig.moteCount.mid,
		settings: guideConfig,
		shadePetal: ( albedo, normal, point ) => {

			const sky = world.uniforms;
			const lit = worldLighting( albedo, normal, point, { wrap: 0.6 } );
			// 朝太阳看过去、花瓣在中间时透光（方向换到世界坐标再和太阳方向比）
			const awayFromViewer = sceneDirectionToWorld( point.sub( cameraPosition ) );
			const backlit = pow( max( dot( awayFromViewer, sky.sunDirection ), 0 ), 3 ).mul( 0.6 );
			const glow = albedo.mul( sky.sunLightColor.mul( backlit ).add( vec3( 0.025, 0.03, 0.045 ) ) );
			return worldAtmosphere( lit.add( glow ), point );

		},
	} );
	root.add( state.guide.group );
	markStep( '引路' );

	state.scene = scene;
	state.root = root;
	state.ready = true;
	update( 0, 0 );

	console.log( `远景：构建完成，用时 ${ ( performance.now() - buildStart ).toFixed( 0 ) } ms（${ timings.join( '，' ) } ms）；核心网格 ${ core.countX }×${ core.countZ }，间距 ${ core.spacing } 米` );
	return { scene };

}

export function enter() {

	if ( ! state.ready ) throw new Error( '远景：还没 init 就调了 enter' );

}

// 地平线图的方位选择：方位角 → 相邻两个方位所在的块、通道掩码和插值比例
function selectHorizon( selector, azimuthDegrees ) {

	const position = ( ( azimuthDegrees % 360 ) + 360 ) % 360 / ( 360 / horizonDirections );
	const first = Math.floor( position ) % horizonDirections;
	const second = ( first + 1 ) % horizonDirections;
	selector.blockA.value = first >> 2;
	selector.blockB.value = second >> 2;
	selector.maskA.value.set( 0, 0, 0, 0 ).setComponent( first & 3, 1 );
	selector.maskB.value.set( 0, 0, 0, 0 ).setComponent( second & 3, 1 );
	selector.blend.value = position - Math.floor( position );

}

export function update( dt, time ) {

	if ( ! state.ready ) return;
	const uniforms = state.uniforms;
	const world = state.world;
	const camera = state.ctx.camera;
	uniforms.time.value = time;

	// 顶点压力（规格书 6.1）：场景比例降到底还超预算时林下半径跟着缩（下一次重挑近处的树时生效）
	const pressure = state.ctx.quality && Number.isFinite( state.ctx.quality.vertexPressure ) ? state.ctx.quality.vertexPressure : 1;
	uniforms.understoryNear.value = uniforms.understoryNearBase * pressure;
	// 近处 3D 树的范围也跟着缩（2026-10-03 核显跑 hi）：哥特、开场转身对着密林时顶点大头是近处的树，缩到 0.8、0.6 倍，远处交给替身卡片；
	// 替身的交接距离读的是同一个 uniform，不用重编着色器。独显上压力一直是 1，画面不变
	uniforms.treeNear.value = uniforms.treeNearBase * pressure;

	// root 的逆矩阵：场景坐标 → 世界坐标
	state.root.updateMatrixWorld();
	uniforms.sceneToWorld.value.copy( tempMatrix.copy( state.root.matrixWorld ).invert() );

	// 天空球跟着相机，半径 0.9 × far
	camera.updateMatrixWorld();
	state.skyDome.position.copy( state.root.worldToLocal( tempVector.setFromMatrixPosition( camera.matrixWorld ) ) );
	// 近处的 3D 树：镜头（世界坐标，就是 root 的本地坐标）挪远了就重挑；地点自己的花树也一样
	// 也按镜头朝向挑：视锥的水平投影放宽一些以外的不画（倒影的虚拟相机水平投影一样，见 trees.js viewFromCamera）
	viewFromCamera( camera, uniforms.sceneToWorld.value, state.treeView );
	if ( state.treeField ) state.treeField.update( state.skyDome.position, false, state.treeView );
	for ( const field of state.locationTrees ) field.update( state.skyDome.position, false, state.treeView );
	state.skyDome.scale.setScalar( camera.far * 0.9 );

	const sun = world.getSunAngles();
	const moon = world.getMoonAngles();
	selectHorizon( uniforms.sunHorizon, sun.azimuth );
	selectHorizon( uniforms.moonHorizon, moon.azimuth );

	// 云顺着风慢慢飘（按时间算，截图可以复现）
	const cloudConfig = world.config.clouds;
	uniforms.cloudOffset.value.set( time * cloudConfig.speed / cloudConfig.scale * 0.6, 0 );
	// 高空的云比地面晚暗下来：4.5 公里高处，太阳落到地平线下约 2° 还照得到，颜色更红
	const cloudElevation = sun.elevation + 2.2;
	const warmth = smoothJs( 14, 0, sun.elevation );
	uniforms.cloudSunColor.value.copy( cloudSunWhite ).lerp( cloudSunWarm, warmth ).multiplyScalar( 2.4 * smoothJs( - 1.2, 5, cloudElevation ) );

	// 谷雾：镜头在雾层以下时着色器里的透明度正好是 0（viewerAbove 从雾层 + 4 米起才大于 0），整层不画，省掉近乎半屏的透明叠层；
	// 云团：天光弱到 0.08 以下（入夜）时透明度也正好是 0（dayAmount），同样不画。
	// 预编译时 compileScene 会把所有子物体临时设成可见，所以这里藏起来的不会漏编
	const viewerHeight = state.skyDome.position.y;
	for ( const layer of state.mistLayers ) layer.mesh.visible = viewerHeight > layer.height + 4;
	if ( state.cloudClusterMesh ) state.cloudClusterMesh.visible = world.uniforms.skyIntensity.value > 0.08;

}

export function exit() {

	// 常驻远景不随地点进出，这里本来就没有要做的事（挂到哪个场景上、从哪个场景摘下，由用它的地方管）

}

// 4b 用：远处顶点压到 far 以内（start、end 是离相机的距离，米）；传 null 关掉。
// end 要在天空球（0.9 × far）以内，否则压过去的远山会被最后画的天空盖掉，所以最多压到 0.85 × far
export function setCompression( start, end ) {

	if ( ! state.ready ) {

		console.warn( '远景：还没建好，setCompression 不生效' );
		return false;

	}

	if ( start === null || start === undefined ) {

		state.uniforms.compressStart.value = 1e8;
		state.uniforms.compressEnd.value = 2e8;
		return true;

	}

	if ( ! Number.isFinite( start ) || ! Number.isFinite( end ) || start <= 0 || end <= start ) {

		console.warn( `远景：setCompression 参数不对（start ${ start }、end ${ end }），要 0 < start < end` );
		return false;

	}

	const limit = state.ctx.camera.far * 0.85;
	if ( end > limit ) console.warn( `远景：压缩终点 ${ end } 超过 0.85 × far（${ limit.toFixed( 0 ) }），按 ${ limit.toFixed( 0 ) } 算` );
	const clampedEnd = Math.min( end, limit );
	state.uniforms.compressStart.value = Math.min( start, clampedEnd - 1 );
	state.uniforms.compressEnd.value = clampedEnd;
	return true;

}

export function setProxyVisible( locationKey, visible ) {

	const group = state.proxyGroups[ locationKey ];
	if ( group ) group.visible = Boolean( visible );

}

// 某个地点替身窗灯的亮度倍数（0~1）：飞往哥特时先不亮，穿出林荫隧道以后真窗灯一扇扇亮（规格书 5.3 阶段 12）
export function setProxyWindows( locationKey, amount ) {

	const value = state.windowAmounts[ locationKey ];
	if ( value ) value.value = Number.isFinite( amount ) ? Math.min( 1, Math.max( 0, amount ) ) : 1;

}

// 地表贴图（tsl/terrain.js 的 loadGroundTextures 结果）：各地点的地面也用它，接缝两边同一套贴图；没读到是 null
export function getGround() {

	return state.ready ? state.ground : null;

}

// 地面贴图采样的距离（uniform，米）
export function getGroundNear() {

	return state.uniforms ? state.uniforms.groundNear : null;

}

// 引路（tsl/guide.js 建的那一份）；远景没建时是 null
export function getGuide() {

	return state.ready ? state.guide : null;

}

// 小镇房子的尺寸表（世界坐标，见 buildTown 里 townHouses 的说明）；星月夜按面画笔触用
export function getTownHouses() {

	return state.townHouses;

}

// 某个地点替身的窗户表（世界坐标 x、y、z，朝外的水平法线 normalX、normalZ，宽、高，楼层比例 floor，随机数 random）；没有是空数组
export function getWindows( locationKey ) {

	return state.windowLists[ locationKey ] || [];

}

export function getProxyKeys() {

	return Object.keys( state.proxyGroups );

}

export function getRoot() {

	return state.root;

}

// 远景自己的场景：没有灯、背景黑；飞行时直接画它（root 是单位变换，世界坐标）
export function getScene() {

	return state.scene;

}

// 统一天空球的显隐：地点自带天空（落日的 SkyMesh、雪原的极光天空）完全不透明时关掉，省掉一整层云的着色
export function setSkyVisible( visible ) {

	if ( state.skyDome ) state.skyDome.visible = Boolean( visible );

}

// 海面下沉：center 是世界坐标 [x, z]，半径以内远景的海顶点沉 depth 米，fade 米内过渡；传 null 关掉
export function setSeaCut( cut ) {

	if ( ! state.ready ) return;
	const uniforms = state.uniforms;
	if ( ! cut ) {

		uniforms.seaCutDepth.value = 0;
		return;

	}

	uniforms.seaCutCenter.value.set( cut.center[ 0 ], cut.center[ 1 ] );
	uniforms.seaCutRadius.value = cut.radius;
	uniforms.seaCutFade.value = Math.max( 1, cut.fade );
	uniforms.seaCutDepth.value = cut.depth;

}

// 内容挖洞：当前锚点（地点）局部坐标的矩形 [minX, maxX] × [minZ, maxZ] 里，远景地形逐像素不画；传 null 关掉。
// （阶段 12 以前是把顶点压低 depth 米，边外会出沟；现在 depth 不再起作用，地点那边传了也不报错）
// 藏起某一种窄处的摆件（kind：frame.kind，比如 'trough'）；雪原的内容显出来时藏冰槽的冰凌、冰块、融水（审查 R8）
export function setNarrowsHidden( kind, hidden ) {

	// kind 传 'all'：所有窄处一起藏（开场在南岭外面，一处窄处都看不见，"外人不见"）
	for ( const mesh of state.narrows || [] ) if ( kind === 'all' || mesh.userData.narrowsKind === kind ) mesh.userData.hiddenByLocation = hidden;
	for ( const mesh of state.narrows || [] ) mesh.visible = state.narrowsEnabled !== false && ! mesh.userData.hiddenByLocation;

}

export function setContentHole( hole ) {

	if ( ! state.ready ) return;
	const uniforms = state.uniforms;
	uniforms.sinkDepth.value = 0;
	if ( ! hole ) {

		uniforms.holeMin.value.set( 1e7, 1e7 );
		uniforms.holeMax.value.set( - 1e7, - 1e7 );
		return;

	}

	uniforms.holeMin.value.set( hole.minX, hole.minZ );
	uniforms.holeMax.value.set( hole.maxX, hole.maxZ );
	// 可选的下压带 sink：{ minX, maxX, minZ, maxZ, depth（米）, fade（边上渐变米数）}，地点坐标
	if ( hole.sink ) {

		uniforms.sinkMin.value.set( hole.sink.minX, hole.sink.minZ );
		uniforms.sinkMax.value.set( hole.sink.maxX, hole.sink.maxZ );
		uniforms.sinkFade.value = Math.max( 0.1, hole.sink.fade );
		uniforms.sinkDepth.value = hole.sink.depth;

	}

}

// 地点的贴地雾盖到远景上：{ density, falloff, baseHeight（雾底面的海拔）, color, scatterColor（THREE.Color）,
// lightDirection（世界方向）, anisotropy, amount }；传 null 关掉。每帧可以调（只改 uniform）
export function setLocationFog( fog ) {

	if ( ! state.ready ) return;
	const uniforms = state.uniforms;
	if ( ! fog ) {

		uniforms.locationFogAmount.value = 0;
		return;

	}

	uniforms.locationFogDensity.value = fog.density;
	uniforms.locationFogFalloff.value = fog.falloff;
	uniforms.locationFogBase.value = fog.baseHeight;
	uniforms.locationFogColor.value.copy( fog.color );
	uniforms.locationFogScatter.value.copy( fog.scatterColor );
	uniforms.locationFogLight.value.copy( fog.lightDirection );
	uniforms.locationFogAnisotropy.value = fog.anisotropy;
	uniforms.locationFogAmount.value = fog.amount;

}

// 地形、树林、替身的亮度倍数（窗灯和天空不乘）
export function setSurfaceGain( gain ) {

	if ( state.ready ) state.uniforms.surfaceGain.value = Number.isFinite( gain ) ? gain : 1;

}

// 反射补光：湖面、雪地把月光反到对面的崖上（哥特：月亮在城堡背后，朝湖的崖面整面背光，只靠天光是死黑的；
// 月光正铺在崖前的湖面上，反上去一点，朝湖的面亮、侧面暗，石柱和冲沟的起伏才看得出）。
// direction：世界方向（指向光），color：THREE.Color（已乘强度）；传 null 关掉
export function setBounceLight( light ) {

	if ( ! state.ready ) return;
	if ( ! light ) {

		state.uniforms.bounceColor.value.setRGB( 0, 0, 0 );
		return;

	}

	state.uniforms.bounceDirection.value.copy( light.direction ).normalize();
	state.uniforms.bounceColor.value.copy( light.color );

}

// 月光补光（天上一大片被月亮照亮的天和雾反下来的光）的倍数：背着月亮的崖、城堡不再死黑，看得出石头和起伏。
// 只抬补光这一项，被月亮直接照到的地方不会跟着变亮（哥特设 3 左右）
export function setNightFill( amount ) {

	if ( state.ready ) state.uniforms.nightFill.value = Number.isFinite( amount ) ? amount : 1;

}

// 天光环境项的倍数（夜里飞行时抬，地面不至于全黑；地点退出时还原成 1）
export function setAmbientStrength( amount ) {

	if ( state.ready ) state.uniforms.ambientStrength.value = Number.isFinite( amount ) ? amount : 1;

}

// 把上面几项对接设置全部还原（地点退出时调）
// 湖面下沉：depth 米（0 关掉）
export function setLakeCut( depth ) {

	if ( ! state.ready ) return;
	state.uniforms.lakeCutDepth.value = Number.isFinite( depth ) ? Math.max( 0, depth ) : 0;

}

export function resetLocationSettings() {

	setSeaCut( null );
	setLakeCut( 0 );
	setContentHole( null );
	setLocationFog( null );
	setSurfaceGain( 1 );
	setNightFill( 1 );
	setAmbientStrength( 1 );
	setBounceLight( null );
	setSkyVisible( true );
	setGrassUnderlay( null );

}

// 远景网格画出来的地面高度（米）；还没建好返回 NaN。机位、飞行要贴着"看得见的地面"时用它，不用 world.worldHeight（网格是 12.5 米一格的近似）
// 地点自己的东西（开场、花园……）用和远景同一套光照、大气：point、normal 是场景坐标（地点局部），返回已经乘过光照的颜色。
// 必须在远景 init 之后建材质时调（要用远景的 uniform 和地平线图）
export function worldLighting( albedo, normal, point, { skyView = float( 1 ), wrap = 0.2 } = {} ) {

	const uniforms = state.uniforms;
	const sky = state.world.uniforms;
	const worldPoint = uniforms.sceneToWorld.mul( vec4( point, 1 ) ).xyz;
	const worldNormal = normalize( uniforms.sceneToWorld.mul( vec4( normal, 0 ) ).xyz );
	const sunShadow = terrainShadow( worldPoint, uniforms.sunHorizon, sky.sunElevation, 1.3 );
	const moonShadow = terrainShadow( worldPoint, uniforms.moonHorizon, sky.moonElevation, 3 );
	return nightAlbedo( albedo ).mul( lightAt( worldNormal, sunShadow, moonShadow, skyView, wrap ) );

}

// 薄的东西（草叶、花瓣、叶片）：正面光照 + 背面透过来的一部分 + 逆着太阳 / 月亮看时的前向透射（pow 6 的瓣）+ 叶面高光（Blinn-Phong 28）。
// 地形阴影只查一次（worldLighting 调两次的话地平线图要多查一遍）。point、normal、toViewer 是场景坐标；scatter、specular 是节点
export function worldLightingThin( albedo, normal, point, toViewer, { wrap = 0.4, back = 0.4, scatter = float( 0 ), specular = float( 0 ), skyView = float( 1 ) } = {} ) {

	const uniforms = state.uniforms;
	const sky = state.world.uniforms;
	const worldPoint = uniforms.sceneToWorld.mul( vec4( point, 1 ) ).xyz;
	const worldNormal = normalize( uniforms.sceneToWorld.mul( vec4( normal, 0 ) ).xyz );
	const worldToViewer = normalize( uniforms.sceneToWorld.mul( vec4( toViewer, 0 ) ).xyz );
	const sunShadow = terrainShadow( worldPoint, uniforms.sunHorizon, sky.sunElevation, 1.3 );
	const moonShadow = terrainShadow( worldPoint, uniforms.moonHorizon, sky.moonElevation, 3 );
	const front = lightAt( worldNormal, sunShadow, moonShadow, skyView, wrap );
	const behind = lightAt( worldNormal.negate(), sunShadow, moonShadow, skyView, wrap ).mul( back );
	const throughSun = sky.sunLightColor.mul( sunShadow ).mul( pow( max( dot( worldToViewer.negate(), sky.sunDirection ), 0 ), 6 ) );
	const throughMoon = sky.moonLightColor.mul( moonShadow ).mul( pow( max( dot( worldToViewer.negate(), sky.moonDirection ), 0 ), 6 ) );
	const halfVector = normalize( sky.sunDirection.add( worldToViewer ) );
	const glint = sky.sunLightColor.mul( sunShadow ).mul( pow( max( dot( worldNormal, halfVector ), 0 ), 28 ) ).mul( specular );
	return nightAlbedo( albedo ).mul( front.add( behind ).add( throughSun.add( throughMoon ).mul( scatter ) ) ).add( glint );

}

// 山洞挖空的那截地形上不长草：sceneXZ、sceneHeight 是场景坐标（地点局部）节点，返回 0（在洞的体积里）或 1。
// 地形在洞里按像素丢了，长在上面的草原来还在，从洞里看出口像草从天上倒挂下来、出洞时镜头穿过一片悬空的草（2026-10-02 自查）
export function caveKeep( sceneXZ, sceneHeight ) {

	const worldPoint = state.uniforms.sceneToWorld.mul( vec4( sceneXZ.x, sceneHeight, sceneXZ.y, 1 ) ).xyz;
	return float( 1 ).sub( caveCutout( worldPoint ) );

}

// 草落在远景地面上的那部分（阶段 12 CP3 返工）：sceneXZ 是场景坐标（地点局部）节点，返回场景坐标里的
// { height（局部高度）, density（0~1）, normal（场景坐标的地面法线）}。地点只绕竖直轴转（原点 + yaw），所以换算只差一个平移和一个转角
export function grassGround( sceneXZ ) {

	const toWorld = state.uniforms.sceneToWorld;
	const worldXZ = toWorld.mul( vec4( sceneXZ.x, 0, sceneXZ.y, 1 ) ).xz;
	const sceneOriginY = toWorld.mul( vec4( 0, 0, 0, 1 ) ).y;
	const ground = grassGroundAtWorld( worldXZ );
	// 世界法线转回场景：乘旋转的转置（和场景两根水平轴各点乘一次，竖直分量不变）
	const axisX = toWorld.mul( vec4( 1, 0, 0, 0 ) ).xyz;
	const axisZ = toWorld.mul( vec4( 0, 0, 1, 0 ) ).xyz;
	const normal = vec3( dot( ground.normal, axisX ), ground.normal.y, dot( ground.normal, axisZ ) );
	return { height: ground.height.sub( sceneOriginY ), density: ground.density, normal };

}

// 地点的草每帧告诉远景：近环圆心（世界坐标）、近环半径（0 不画）、远环半径、强度（总的、近、远）、草根色、草的中段色（线性）
export function setGrassUnderlay( underlay ) {

	const uniforms = state.uniforms;
	if ( ! uniforms ) return;
	if ( ! underlay ) {

		uniforms.grassUnderlayRadius.value = 0;
		uniforms.grassUnderlayAmount.value = 0;
		return;

	}

	uniforms.grassUnderlayCenter.value.set( underlay.x, underlay.z );
	uniforms.grassUnderlayRadius.value = underlay.radius;
	uniforms.grassUnderlayFar.value = underlay.farRadius || 0;
	uniforms.grassUnderlayAmount.value = underlay.amount;
	uniforms.grassUnderlayNear.value = underlay.nearAmount ?? 1;
	uniforms.grassUnderlayFarAmount.value = underlay.farAmount ?? 1;
	if ( underlay.rootColor ) uniforms.grassRootColor.value.set( underlay.rootColor );
	if ( underlay.middleColor ) uniforms.grassMiddleColor.value.set( underlay.middleColor );

}

// 大气透视 + 贴地薄雾 + 地点的雾（同远景）；point 是场景坐标
// 远景地表图在某个场景坐标点的值：R 到水边的距离、G 桃林、B 花海（核心区外 0）、A 天光遮蔽（核心区外 0.85，和远景地面一样过渡）。
// 地点自己的地面要和远景接得上时用（花园块边上原来是一条直线：块里亮绿、块外花海加山谷里的天光遮蔽，出洞俯瞰时一眼看得到）
export function groundBiomeAt( scenePoint ) {

	const uniforms = state.uniforms;
	const worldPoint = uniforms.sceneToWorld.mul( vec4( scenePoint, 1 ) ).xyz;
	const coreUv = worldPoint.xz.sub( uniforms.coreMin ).div( uniforms.coreSize );
	const biome = texture( state.textures.biome.texture, coreUv ).level( 0 );
	return vec4( biome.rgb.mul( uniforms.insideCore( worldPoint ) ), mix( float( 0.85 ), biome.a, uniforms.insideCoreWide( worldPoint ) ) );

}

export function worldAtmosphere( surface, point ) {

	const worldPoint = state.uniforms.sceneToWorld.mul( vec4( point, 1 ) ).xyz;
	return applyAtmosphere( surface, worldPoint, viewerPosition() );

}

// 场景坐标 → 世界坐标的矩阵 uniform（每帧按远景挂到的场景更新）：地点的材质要换到世界坐标时用
export function getSceneToWorld() {

	return state.uniforms.sceneToWorld;

}

// 场景坐标的方向 → 世界方向（天空、反射用）
export function sceneDirectionToWorld( direction ) {

	return normalize( state.uniforms.sceneToWorld.mul( vec4( direction, 0 ) ).xyz );

}

export function getTerrainHeight( x, z ) {

	return state.ready ? terrainHeightAt( x, z ) : NaN;

}

export function dispose() {

	if ( ! state.scene ) return;
	state.ready = false;
	for ( const item of state.disposables ) {

		if ( item && typeof item.dispose === 'function' ) item.dispose();

	}

	for ( const mesh of state.forest ) mesh.dispose();
	if ( state.guide ) state.guide.dispose();
	state.guide = null;
	state.treeField = null;
	state.forestItems = [];
	state.narrows = [];
	state.corridors = [];
	state.windowAmounts = {};
	state.windowLists = {};
	state.disposables = [];
	state.scene.clear();
	state.scene = null;
	state.root = null;
	state.skyDome = null;
	state.terrainMeshes = [];
	state.forest = [];
	state.caveMeshes = [];
	state.caveUniforms = null;
	state.proxyGroups = {};
	state.houseFootprints = [];
	state.townHouses = [];
	state.patches = [];
	state.core = null;
	state.outer = null;
	state.horizon = null;
	state.textures = null;
	state.uniforms = null;
	state.toggles = null;
	state.world = null;
	state.ctx = null;
	console.log( '远景：已释放' );

}

// 效果层开关（调试面板、逐层截图用）
export function getLayers() {

	if ( ! state.toggles ) return {};
	return {
		...state.toggles,
		...( state.ground ? state.ground.toggles : {} ),
		// 规格书 6.3：烘焙出来的法线、岩石外露、凹凸遮蔽、分色和崖面遮罩；关掉退回网格法线加坡度阈值（高度和树的位置不归它管）
		烘焙地形细节: ( enabled ) => {

			state.uniforms.bakedSurface.value = enabled && state.textures.surface.grid ? 1 : 0;

		},
		// 远处的替身卡片（远景树林现在就是替身卡片那一个网格；没烘图集时是原来的树团）
		树替身: ( enabled ) => {

			for ( const mesh of state.forest ) mesh.visible = enabled;

		},
		// 焦点樱花树（近处的 3D 树里树种是 focal 的那几个网格）
		焦点树: ( enabled ) => {

			if ( state.treeField ) state.treeField.group.traverse( ( object ) => {

				if ( object.isMesh && object.name.includes( '·focal·' ) ) object.visible = enabled;

			} );

		},
		替身: ( enabled ) => {

			for ( const group of Object.values( state.proxyGroups ) ) group.visible = enabled;

		},
		// 下面几个只是整块显隐，量各部分的显卡开销用
		天空球: ( enabled ) => {

			state.skyDome.visible = enabled;

		},
		地形网格: ( enabled ) => {

			for ( const mesh of state.terrainMeshes ) mesh.visible = enabled;

		},
		树林网格: ( enabled ) => {

			for ( const mesh of state.forest ) mesh.visible = enabled;

		},
		山洞网格: ( enabled ) => {

			for ( const mesh of state.caveMeshes ) mesh.visible = enabled;

		},
		窄处: ( enabled ) => {

			state.narrowsEnabled = enabled;
			for ( const mesh of state.narrows ) mesh.visible = enabled && ! mesh.userData.hiddenByLocation;

		},
		引路花瓣: ( enabled ) => {

			if ( state.guide ) state.guide.petals.visible = enabled;

		},
		引路光点: ( enabled ) => {

			if ( state.guide ) state.guide.motes.visible = enabled;

		},
		// 整个远景都不画（量后期链本身的开销用）
		全部远景: ( enabled ) => {

			state.root.visible = enabled;

		},
	};

}
