// 开场序列（规格书 5.1.1，约 62 秒）：黎明，渔人的小船沿桃花溪逆流而上，两岸桃林"夹岸数百步，中无杂树，芳草鲜美，落英缤纷"；
// "林尽水源"：桃林在山脚止住，崖脚石缝里流出溪水，崖上一个小口"仿佛若有光"；"便舍船，从口入"：镜头离船升到洞口；
// "初极狭，才通人"：进洞，擦着两壁往前走，在洞里原地交给花园（world.cave 的 handoff 处，位置、朝向、速度都接得上）。
//
// 地点局部坐标：原点在溪上（洞口南边约 210 米），−z 朝洞口（方位 355°）。远处的山、天空、远处的桃林、山洞都是常驻远景画的，
// 这里画近处的东西：细地形（1.25 米一格，崖面也在里面）、溪水、桃树、草、飘落和漂在水上的花瓣、小船；
// 光照和大气用远景同一套（backdrop.worldLighting / worldAtmosphere），远近接得上。
// 镜头不是步行也不是路线关键帧：沿一条合成的路线（溪中线 → 升到洞口 → 洞的中线）按时间走（单调三次插值，速度连续），
// 每帧用 setExternalPose 交给导演（可以拖动转头，松手回正）。

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, uniform, attribute, texture, color, select,
	positionWorld, positionGeometry, normalGeometry, normalWorld, frontFacing, modelWorldMatrix, cameraPosition,
	normalize, length, dot, max, min, mix, smoothstep, pow, abs, sin, cos, floor, fract, reflect, fwidth, Discard, step, sqrt, If, dFdx, dFdy,
} from 'three/tsl';
import { reflector } from 'three/tsl';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { NodeUpdateType } from 'three/webgpu';
import { createPetals } from '../tsl/petals.js';
import { createGrassField, buildGroundField, resolveRings, blendGround } from '../tsl/grass.js';
import { hash33, valueNoise2D, jsFbm2D, createNoiseTextureData } from '../tsl/noise.js';
import { daySkyColor } from '../tsl/sky.js';
import { monotoneCurve, resampleCurve, pointOnCurve } from '../core/route.js';
import { isMeshInView, prepareMeshView } from '../core/camera.js';
import { blossomTemplate, instanceTrunks, blossomCards, createBlossomMaterial, createBarkMaterial } from '../tsl/blossom.js';
import { groundDetailInScene } from '../tsl/terrain.js';

export const key = 'overture';

const degree = Math.PI / 180;

// 地形块（局部坐标）：x 两岸各 95 米，z 从洞顶的山梁后面（-312）到身后 45 米；1.25 米一格（洞口那面山整个在块里，近看是细地形）
const terrainRect = { minX: - 95, maxX: 95, minZ: - 312, maxZ: 45 };
const terrainSpacing = 1.25;
// 草和地形查询用的高度、密度图：0.5 米一个像素
const fieldSpacing = 0.5;
// 溪面"平水"的坡度上限：溪水着色器里跌水的碎波从 0.02 起、白沫从 0.025 起，留一点余量（插值的舍入）
const calmSlope = 0.019;

const state = {
	ctx: null,
	scene: null,
	ready: false,
	disposables: [],
	uniforms: null,
	layers: {},
	route: null,
	river: null,
	heights: null,          // 地形网格的高度（局部 y）
	field: null,            // 高度、草密度（Float32，fieldSpacing 一格）
	boat: null,
	grass: null,
	petals: null,
	water: null,
	reflectorNode: null,
	reflectionPass: null,
	reflectionScale: 0,
	caveHidden: false,      // 进洞以后藏起了开场自己的草、溪水（perf.scenesA.caveHide）
	caveSaved: null,        // 藏之前它们各自的 visible（出洞方向跳回来时还原）
	duration: 62,
	caveSample: {},
};

const tempVector = new THREE.Vector3();
const tempTarget = new THREE.Vector3();
const tempMatrix = new THREE.Matrix4();
const tempQuaternion = new THREE.Quaternion();
const tempEuler = new THREE.Euler();
const tempWorld = new THREE.Vector3();
const worldUp = new THREE.Vector3( 0, 1, 0 );

function smoothJs( edge0, edge1, value ) {

	const amount = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return amount * amount * ( 3 - 2 * amount );

}

function createRandom( seed ) {

	let value = ( seed >>> 0 ) || 1;
	return function next() {

		value = ( value + 0x6D2B79F5 ) >>> 0;
		let mixed = Math.imul( value ^ ( value >>> 15 ), 1 | value );
		mixed = ( mixed + Math.imul( mixed ^ ( mixed >>> 7 ), 61 | mixed ) ) ^ mixed;
		return ( ( mixed ^ ( mixed >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// 让出主线程（init 里建几十万个顶点，分段做，开场卡上的粒子进度不卡）
const yieldToBrowser = () => new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

// ===================== 坐标换算 =====================

function toWorldXZ( x, z ) {

	const point = state.ctx.world.toWorld( tempVector.set( x, 0, z ), key, tempVector );
	return [ point.x, point.z ];

}

function originY() {

	return state.ctx.world.locations[ key ].origin[ 1 ];

}

// ===================== 地形 =====================

// 局部 (x, z) 到溪中线（state.line，从源头往下游每 1 米一个点）：离中线多远、沿溪多远、水位（局部 y）、在源头上游多远
function streamAt( x, z ) {

	const points = state.line.points;
	let best = Infinity;
	let bestAlong = 0;
	let bestLevel = points[ 0 ].y;
	let upstream = 0;
	for ( let i = 0; i < points.length - 1; i ++ ) {

		const start = points[ i ];
		const end = points[ i + 1 ];
		const spanX = end.x - start.x;
		const spanZ = end.z - start.z;
		const lengthSquared = spanX * spanX + spanZ * spanZ || 1;
		const projection = ( ( x - start.x ) * spanX + ( z - start.z ) * spanZ ) / lengthSquared;
		const t = Math.min( 1, Math.max( 0, projection ) );
		const distance = Math.hypot( x - start.x - spanX * t, z - start.z - spanZ * t );
		if ( distance < best ) {

			best = distance;
			bestAlong = state.line.distances[ i ] + t * Math.sqrt( lengthSquared );
			bestLevel = start.y + ( end.y - start.y ) * t;
			upstream = i === 0 && projection < 0 ? - projection * Math.sqrt( lengthSquared ) : 0;

		}

	}

	return { distance: best, along: bestAlong, level: bestLevel, upstream };

}

// 溪在沿溪 along 米处的半宽：源头是窄窄的泉眼，往下游放宽到世界里溪的半宽
function streamHalfWidth( along ) {

	const spring = state.ctx.config.overture.spring;
	return spring.halfWidth + ( state.river.halfWidth - spring.halfWidth ) * smoothJs( 2, spring.widenTo, along );

}

// 局部 (x, z) 的地面高度（局部 y）：世界地形（含溪的河谷、源头的崖）+ 溪边的河漫滩 + 小起伏；块的边上 18 米内接回远景画的高度
function terrainHeightLocal( x, z ) {

	const ctx = state.ctx;
	const world = ctx.world;
	const [ worldX, worldZ ] = toWorldXZ( x, z );
	const wall = world.headWallRise( state.river, worldX, worldZ );
	const base = world.sample( worldX, worldZ ).height - originY() - wall;
	const nearest = streamAt( x, z );
	const level = nearest.level;
	const halfWidth = streamHalfWidth( nearest.along );
	let height = base;

	if ( nearest.upstream <= 0.5 ) {

		// 河床：中间深 0.9 米；岸：水边往外 3 米抬 0.35 米的小坎，再往外很缓，带土包
		const distance = nearest.distance;
		let target;
		if ( distance < halfWidth ) {

			const ratio = distance / halfWidth;
			target = level - 0.15 - 0.9 * ( 1 - ratio * ratio );

		} else {

			const mounds = ( jsFbm2D( x / 9 + 4.1, z / 9 - 2.3, 3 ) - 0.5 ) * 0.7 * smoothJs( halfWidth + 2, halfWidth + 8, distance );
			target = level + 0.22 + smoothJs( halfWidth, halfWidth + 3, distance ) * 0.35 + ( distance - halfWidth ) * 0.03 + mounds;

		}

		height += ( target - height ) * smoothJs( 34, 18, distance );

	}

	height += wall;

	// 小起伏：水边以外都有，崖上（陡的地方）更大
	const [ edgeX, edgeZ ] = [ Math.min( x - terrainRect.minX, terrainRect.maxX - x ), Math.min( z - terrainRect.minZ, terrainRect.maxZ - z ) ];
	height += ( jsFbm2D( x / 5.5 + 3.3, z / 5.5 - 1.7, 3 ) - 0.5 ) * 0.22;

	// 块的边上接回远景画的高度（远景在块里整体压低了，边上那一圈三角形会斜下去，被这里盖住）
	const edge = Math.min( edgeX, edgeZ );
	if ( edge < 18 ) {

		const drawn = ctx.backdrop.getTerrainHeight( worldX, worldZ ) - originY();
		if ( Number.isFinite( drawn ) ) height += ( drawn - height ) * smoothJs( 18, 2, edge );

	}

	return height;

}

async function buildTerrain() {

	const countX = Math.round( ( terrainRect.maxX - terrainRect.minX ) / terrainSpacing ) + 1;
	const countZ = Math.round( ( terrainRect.maxZ - terrainRect.minZ ) / terrainSpacing ) + 1;
	const positions = new Float32Array( countX * countZ * 3 );
	const heights = new Float32Array( countX * countZ );
	const aboveWater = new Float32Array( countX * countZ );
	let sliceStart = performance.now();
	for ( let j = 0; j < countZ; j ++ ) {

		const z = terrainRect.minZ + j * terrainSpacing;
		for ( let i = 0; i < countX; i ++ ) {

			const x = terrainRect.minX + i * terrainSpacing;
			const height = terrainHeightLocal( x, z );
			const index = j * countX + i;
			heights[ index ] = height;
			aboveWater[ index ] = height - streamAt( x, z ).level;
			positions[ index * 3 ] = x;
			positions[ index * 3 + 1 ] = height;
			positions[ index * 3 + 2 ] = z;

		}

		if ( performance.now() - sliceStart > 12 ) {

			await yieldToBrowser();
			sliceStart = performance.now();

		}

	}

	const indices = new Uint32Array( ( countX - 1 ) * ( countZ - 1 ) * 6 );
	let cursor = 0;
	for ( let j = 0; j < countZ - 1; j ++ ) {

		for ( let i = 0; i < countX - 1; i ++ ) {

			const a = j * countX + i;
			const b = a + 1;
			const c = a + countX;
			const d = c + 1;
			indices.set( [ a, c, b, b, c, d ], cursor );
			cursor += 6;

		}

	}

	// 平滑法线：按左右前后 3 格（3.75 米）的高度差算，三向投影的权重和"这里是岩石还是草地"用它
	const smoothNormals = new Float32Array( countX * countZ * 3 );
	const reach = 3;
	for ( let j = 0; j < countZ; j ++ ) {

		for ( let i = 0; i < countX; i ++ ) {

			const left = heights[ j * countX + Math.max( 0, i - reach ) ];
			const right = heights[ j * countX + Math.min( countX - 1, i + reach ) ];
			const back = heights[ Math.max( 0, j - reach ) * countX + i ];
			const front = heights[ Math.min( countZ - 1, j + reach ) * countX + i ];
			const spanX = ( Math.min( countX - 1, i + reach ) - Math.max( 0, i - reach ) ) * terrainSpacing;
			const spanZ = ( Math.min( countZ - 1, j + reach ) - Math.max( 0, j - reach ) ) * terrainSpacing;
			const nx = - ( right - left ) / spanX;
			const nz = - ( front - back ) / spanZ;
			const length = Math.hypot( nx, 1, nz );
			const index = ( j * countX + i ) * 3;
			smoothNormals[ index ] = nx / length;
			smoothNormals[ index + 1 ] = 1 / length;
			smoothNormals[ index + 2 ] = nz / length;

		}

	}

	// 曲率：这一格比周围 2 格（2.5 米）一圈的平均高多少。凸起的棱上是正的、凹进去的沟里是负的；崖面上凹处压暗、棱上提亮，
	// 只有天光照着的崖面（月亮在山后）才分得出起伏
	const cavity = new Float32Array( countX * countZ );
	for ( let j = 0; j < countZ; j ++ ) {

		for ( let i = 0; i < countX; i ++ ) {

			let sum = 0;
			let count = 0;
			for ( let offsetZ = - 2; offsetZ <= 2; offsetZ ++ ) {

				for ( let offsetX = - 2; offsetX <= 2; offsetX ++ ) {

					if ( offsetX === 0 && offsetZ === 0 ) continue;
					const neighborX = Math.min( countX - 1, Math.max( 0, i + offsetX ) );
					const neighborZ = Math.min( countZ - 1, Math.max( 0, j + offsetZ ) );
					sum += heights[ neighborZ * countX + neighborX ];
					count ++;

				}

			}

			cavity[ j * countX + i ] = heights[ j * countX + i ] - sum / count;

		}

	}

	// 更宽的坡度（左右前后 6 格、7.5 米）：草地换岩石按它，坡上一道道几米宽的小沟不会把岩石色刷成竖条
	const wideSlope = new Float32Array( countX * countZ );
	for ( let j = 0; j < countZ; j ++ ) {

		for ( let i = 0; i < countX; i ++ ) {

			const left = Math.max( 0, i - 6 );
			const right = Math.min( countX - 1, i + 6 );
			const back = Math.max( 0, j - 6 );
			const front = Math.min( countZ - 1, j + 6 );
			const gradientX = ( heights[ j * countX + right ] - heights[ j * countX + left ] ) / ( ( right - left ) * terrainSpacing );
			const gradientZ = ( heights[ front * countX + i ] - heights[ back * countX + i ] ) / ( ( front - back ) * terrainSpacing );
			wideSlope[ j * countX + i ] = 1 - 1 / Math.hypot( gradientX, 1, gradientZ );

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'aboveWater', new THREE.BufferAttribute( aboveWater, 1 ) );
	geometry.setAttribute( 'wideSlope', new THREE.BufferAttribute( wideSlope, 1 ) );
	geometry.setAttribute( 'smoothNormal', new THREE.BufferAttribute( smoothNormals, 3 ) );
	geometry.setAttribute( 'cavity', new THREE.BufferAttribute( cavity, 1 ) );
	geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	state.heights = { data: heights, countX, countZ, aboveWater };
	return geometry;

}

// 地形网格上存的一个量（高度、离水面多高）在局部 (x, z) 的双线性插值；块外 NaN
function gridValue( data, x, z ) {

	const grid = state.heights;
	const gridX = ( x - terrainRect.minX ) / terrainSpacing;
	const gridZ = ( z - terrainRect.minZ ) / terrainSpacing;
	if ( gridX < 0 || gridZ < 0 || gridX > grid.countX - 1 || gridZ > grid.countZ - 1 ) return NaN;
	const i = Math.min( grid.countX - 2, Math.floor( gridX ) );
	const j = Math.min( grid.countZ - 2, Math.floor( gridZ ) );
	const fx = gridX - i;
	const fz = gridZ - j;
	const read = ( a, b ) => data[ b * grid.countX + a ];
	const bottom = read( i, j ) + ( read( i + 1, j ) - read( i, j ) ) * fx;
	const top = read( i, j + 1 ) + ( read( i + 1, j + 1 ) - read( i, j + 1 ) ) * fx;
	return bottom + ( top - bottom ) * fz;

}

// 局部 (x, z) 的地面高度（双线性插值地形网格）；块外 NaN
function groundHeight( x, z ) {

	const grid = state.heights;
	if ( ! grid ) return NaN;
	const gridX = ( x - terrainRect.minX ) / terrainSpacing;
	const gridZ = ( z - terrainRect.minZ ) / terrainSpacing;
	if ( gridX < 0 || gridZ < 0 || gridX > grid.countX - 1 || gridZ > grid.countZ - 1 ) return NaN;
	const i = Math.min( grid.countX - 2, Math.floor( gridX ) );
	const j = Math.min( grid.countZ - 2, Math.floor( gridZ ) );
	const fx = gridX - i;
	const fz = gridZ - j;
	const read = ( a, b ) => grid.data[ b * grid.countX + a ];
	const bottom = read( i, j ) + ( read( i + 1, j ) - read( i, j ) ) * fx;
	const top = read( i, j + 1 ) + ( read( i + 1, j + 1 ) - read( i, j + 1 ) ) * fx;
	return bottom + ( top - bottom ) * fz;

}

// 草地图（半精度 RGBA：地面高度、长草的密度、地面法线 x、z；grass.js 的 buildGroundField）：水里、水边 0.4 米以内、陡坡、崖上没有草。
// 块边不收草：块外由远景的草地图接上（backdrop.grassGround）
async function buildField() {

	state.field = await buildGroundField( {
		rect: terrainRect,
		spacing: fieldSpacing,
		heightAt: groundHeight,
		// slope = 1 − 法线 y：0.07（约 22°）以下全长，0.2（约 37°）以上不长
		densityAt: ( x, z, slope ) => smoothJs( 0.1, 0.45, gridValue( state.heights.aboveWater, x, z ) ) * smoothJs( 0.2, 0.07, slope ),
		name: '开场草地图',
		yieldToBrowser,
	} );
	state.disposables.push( ...state.field.textures );

}

// 草落地：块里用开场自己的草地图，块外用远景的（grass.js 的 blendGround：密度在块边 10 米里交叉过渡）
function grassGroundAt( xz ) {

	return blendGround( state.field, state.ctx.backdrop, xz );

}

// ===================== 光照（同远景）+ 地点自己的晨雾 =====================

function shade( albedo, normal, point, { skyView = float( 1 ), wrap = 0.3 } = {} ) {

	const backdrop = state.ctx.backdrop;
	return backdrop.worldAtmosphere( backdrop.worldLighting( albedo, normal, point, { skyView, wrap } ), point );

}

// 花、草、叶这类薄的东西：正面光照 + 背面透过来的一半（逆光时透亮）
function shadeThin( albedo, normal, point, toViewer ) {

	const backdrop = state.ctx.backdrop;
	const front = backdrop.worldLighting( albedo, normal, point, { wrap: 0.5 } );
	const back = backdrop.worldLighting( albedo, normal.negate(), point, { wrap: 0.5 } ).mul( 0.45 );
	return backdrop.worldAtmosphere( front.add( back ), point );

}

function createTerrainMaterial( noiseTexture ) {

	const uniforms = state.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '开场地形';
	material.fog = false;
	material.lights = false;

	material.colorNode = Fn( () => {

		const point = positionGeometry;
		// 洞穿过的那一截不画（远景的洞壁在那里）：caveCutout 要世界坐标
		const worldPosition = uniforms.sceneToWorld.mul( vec4( point, 1 ) ).xyz;
		Discard( state.ctx.backdrop.caveCutout( worldPosition ).greaterThan( 0.5 ) );
		const normal = normalize( normalGeometry ).toVar();
		const broadNormal = normalize( attribute( 'smoothNormal', 'vec3' ) );
		const slope = float( 1 ).sub( broadNormal.y );
		// 草地的斑块也按三向投影取（只按 xz 取的话，山坡上斑块顺着坡拉成一道道竖条）
		const weights = pow( abs( broadNormal ), vec3( 4 ) );
		const weightSum = weights.x.add( weights.y ).add( weights.z );
		const planar = ( scale, offset ) => texture( noiseTexture, point.zy.div( scale ).add( offset ) ).mul( weights.x )
			.add( texture( noiseTexture, point.xz.div( scale ) ).mul( weights.y ) )
			.add( texture( noiseTexture, point.xy.div( scale ).add( offset.yx ) ).mul( weights.z ) ).div( weightSum );
		const patch = planar( 23, vec2( 0.21, 0.63 ) ).r;
		const fine = planar( 3.1, vec2( 0.47, 0.18 ) ).g;
		const aboveWater = attribute( 'aboveWater', 'float' );

		// 草地：翠绿和嫩黄绿按斑块交替；水边是湿泥和卵石；陡坡、崖上是岩石
		const meadow = mix( color( '#5f7d3c' ), color( '#86a052' ), smoothstep( 0.3, 0.75, patch ) ).mul( fine.mul( 0.25 ).add( 0.85 ) );
		const mud = mix( color( '#4a3f33' ), color( '#6b6152' ), fine );
		// 岩石：三向投影（按平滑法线三个轴向加权，崖面不会拉成竖条），每个投影取三层不同尺度、各自转过一个角度的噪声
		// （单层 value noise 的格子是方的，近看一块块像马赛克；三层转开了叠起来才像石头）。一次取 RGBA：R、G 两张噪声，BA 是 R 的梯度
		const rotate = ( coordinate, angle ) => vec2( coordinate.x.mul( Math.cos( angle ) ).sub( coordinate.y.mul( Math.sin( angle ) ) ), coordinate.x.mul( Math.sin( angle ) ).add( coordinate.y.mul( Math.cos( angle ) ) ) );
		const triplanar = ( scale, angle, offset ) => texture( noiseTexture, rotate( point.zy.div( scale ), angle ).add( offset ) ).mul( weights.x )
			.add( texture( noiseTexture, rotate( point.xz.div( scale ), angle ).add( offset ) ).mul( weights.y ) )
			.add( texture( noiseTexture, rotate( point.xy.div( scale ), angle ).add( offset ) ).mul( weights.z ) ).div( weightSum );
		// 岸上的草地（rockAmount = 0，草地上大部分像素）不算下面岩石那一大段（perf.scenesA.skipHiddenShading）：岩石那段的采样在分支里，
		// 不能用隐式导数，改用分支外先算好的 point 屏幕导数（.grad，导数按投影、缩放、转角换算过去，和隐式采样取同一级 mip）。
		// 只落 point 的两个导数（6 个数）跨过分支；把 12 组坐标和导数都落地也试过（2026-10-02）：寄存器多占几十个，仍差几个轮廓上的像素，不划算
		const lean = state.ctx.config.perf.scenesA.skipHiddenShading;
		const pointDx = lean ? dFdx( point ).toVar() : null;
		const pointDy = lean ? dFdy( point ).toVar() : null;
		// 岩石的中、小两层三向投影（scale 米一圈、转角、偏移）和三道竖纹（横向、竖向几米一圈、偏移）
		const rockOctaves = { middle: [ 6.3, 1.3, vec2( 0.52, 0.27 ) ], small: [ 1.9, 2.4, vec2( 0.84, 0.38 ) ] };
		const rockStreaks = {
			crackWide: [ 26, 210, vec2( 0.17, 0.43 ) ],    // 横 0.8 米、竖 6.6 米一格
			crackThin: [ 11, 90, vec2( 0.71, 0.29 ) ],     // 横 0.34 米、竖 2.8 米一格
			waterStain: [ 40, 620, vec2( 0.52, 0.91 ) ],   // 1.25 米宽、十几米长的深色水渍
		};
		const projections = { zy: ( vector ) => vector.zy, xz: ( vector ) => vector.xz, xy: ( vector ) => vector.xy };
		const octaveSample = ( name, projection ) => {

			const [ scale, angle, offset ] = rockOctaves[ name ];
			const project = projections[ projection ];
			const coordinate = rotate( project( point ).div( scale ), angle ).add( offset );
			if ( ! lean ) return texture( noiseTexture, coordinate );
			return texture( noiseTexture, coordinate ).grad( rotate( project( pointDx ).div( scale ), angle ), rotate( project( pointDy ).div( scale ), angle ) );

		};
		const rockTriplanar = ( name ) => octaveSample( name, 'zy' ).mul( weights.x )
			.add( octaveSample( name, 'xz' ).mul( weights.y ) )
			.add( octaveSample( name, 'xy' ).mul( weights.z ) ).div( weightSum );
		// 竖纹只在崖的侧面投影（x、z 两个朝向）上取：朝 x 的面按 z 横向取，朝 z 的面按 x 横向取、偏移两分量对调
		const streakSample = ( name, axis ) => {

			const [ across, upward, offset ] = rockStreaks[ name ];
			const pick = ( vector ) => ( axis === 'z' ? vector.z : vector.x );
			const coordinate = vec2( pick( point ).div( across ), point.y.div( upward ) ).add( axis === 'z' ? offset : offset.yx );
			if ( ! lean ) return texture( noiseTexture, coordinate );
			return texture( noiseTexture, coordinate ).grad( vec2( pick( pointDx ).div( across ), pointDx.y.div( upward ) ), vec2( pick( pointDy ).div( across ), pointDy.y.div( upward ) ) );

		};
		// 噪声贴图一圈 32 格：scale 米一圈，一格是 scale / 32 米。近处的细节（0.06~0.7 米一格）照旧；
		// 崖面远看要有十几米、几米一块的结构，不然几十米外是一整片均匀的灰色迷彩（原来最大一层才 0.7 米一格）
		const macro = triplanar( 384, 0.7, vec2( 0.31, 0.58 ) );     // 12 米一格
		const medium = triplanar( 96, 1.9, vec2( 0.66, 0.12 ) );     // 3 米一格
		// 屏幕导数在分支外面先落地成变量（裂纹随距离淡掉要用）
		const footprint = max( length( fwidth( point ) ), 0.001 ).toVar();
		const albedo = mix( mud, meadow, smoothstep( 0.05, 0.5, aboveWater ) ).toVar();
		// 草地到岩石的过渡要利落：草地的颜色按 xz 采样，在陡坡上会拉成竖条，所以陡一点就全是岩石（岩石是三向投影）
		const rockSlope = mix( attribute( 'wideSlope', 'float' ), slope, 0.3 );
		// 草和岩石的分界按 3 米、12 米两层噪声上下错开：草顺着沟往崖上爬一截，崖脚不是一条水平线
		const rockEdge = rockSlope.add( patch.sub( 0.5 ).mul( 0.06 ) ).add( medium.r.sub( 0.5 ).mul( 0.16 ) ).add( macro.g.sub( 0.5 ).mul( 0.12 ) );
		const rockAmount = smoothstep( 0.26, 0.36, rockEdge ).toVar();
		// 岩石的起伏：中、小两层的梯度当作表面斜率，在平滑法线的切线框架里加回法线（只在陡的地方，草地上不加）；
		// 台面往上翻、檐下往下扣，天光从上面来，台面亮、檐下暗
		normal.assign( normalize( mix( broadNormal, normal, rockAmount.mul( 0.7 ).add( 0.3 ) ) ) );
		const rockPart = () => {

			const octaveMiddle = rockTriplanar( 'middle' );
			const octaveSmall = rockTriplanar( 'small' );
			const rockNoise = octaveMiddle.r.mul( 0.6 ).add( octaveSmall.r.mul( 0.4 ) );
			const rockFine = octaveSmall.g;
			// ① 岩层台阶（国画的"折带皴"）：5.5 米一层，层高被大、中两层噪声扭弯；每层下暗上亮，层顶是朝天的台面（长草长苔），
			// 台面上方紧贴着一条暗缝（上一层压出来的檐下阴影）
			// 层线不能是一圈圈等高线：层厚按大块噪声在 3.5~7.5 米之间变，台面、檐下暗缝按中块噪声断成一截一截的
			const layerThickness = mix( float( 3.5 ), float( 7.5 ), macro.g );
			const layerCoordinate = point.y.add( macro.r.sub( 0.5 ).mul( 11 ) ).add( medium.g.sub( 0.5 ).mul( 3.2 ) ).div( layerThickness );
			const layerFraction = fract( layerCoordinate );
			// 断得更碎、层的明暗收一点（审查 R41：远看还是一层层横向的弧线，像等高线）
			const layerBreak = smoothstep( 0.48, 0.7, medium.r.mul( 0.7 ).add( rockNoise.mul( 0.3 ) ) );
			const layerShade = mix( float( 1 ), mix( float( 0.8 ), float( 1.06 ), smoothstep( 0.04, 0.88, layerFraction ) ), layerBreak.mul( 0.75 ).add( 0.1 ) );
			const ledge = smoothstep( 0.84, 0.94, layerFraction ).mul( layerBreak );
			const undercut = float( 1 ).sub( smoothstep( 0, 0.08, layerFraction ) ).mul( layerBreak );
			// ② 竖向的裂纹和水渍（"披麻皴"）：只在崖的侧面投影（x、z 两个朝向）上取竖着拉长的噪声；
			// 裂纹是噪声 0.5 等值线（一条条弯弯的竖线），细线随距离淡掉，远处不闪
			const sideTotal = weights.x.add( weights.z ).add( 1e-4 );
			const streakAt = ( name ) => streakSample( name, 'z' ).r.mul( weights.x ).add( streakSample( name, 'x' ).r.mul( weights.z ) ).div( sideTotal );
			const crackWide = streakAt( 'crackWide' );
			const crackThin = streakAt( 'crackThin' );
			// 竖纹成片出现（大块噪声），不是满墙一样密的木纹
			const crackPatch = smoothstep( 0.42, 0.66, macro.g.mul( 0.5 ).add( medium.g.mul( 0.5 ) ) );
			const crack = float( 1 ).sub( smoothstep( 0.02, 0.09, abs( crackWide.sub( 0.5 ) ) ) ).mul( crackPatch.mul( 0.4 ).add( 0.15 ) )
				.add( float( 1 ).sub( smoothstep( 0.01, 0.06, abs( crackThin.sub( 0.5 ) ) ) ).mul( float( 1 ).sub( smoothstep( 0.04, 0.14, footprint ) ) ).mul( 0.35 ) )
				.mul( crackPatch.mul( 0.6 ).add( 0.4 ) ).mul( float( 1 ).sub( smoothstep( 0.12, 0.35, footprint ) ) );
			const waterStain = smoothstep( 0.55, 0.78, streakAt( 'waterStain' ) );
			// ③ 颜色：偏冷的青灰，大块地深浅交替，夹着赭黄的锈斑
			const rockTone = mix( color( '#3a3836' ), color( '#857f76' ), smoothstep( 0.28, 0.72, macro.r.mul( 0.55 ).add( medium.r.mul( 0.3 ) ).add( rockNoise.mul( 0.15 ) ) ) ).toVar();
			rockTone.assign( mix( rockTone, color( '#76654f' ), smoothstep( 0.56, 0.74, macro.g ).mul( 0.45 ) ) );
			rockTone.assign( rockTone.mul( layerShade ).mul( float( 1 ).sub( waterStain.mul( 0.3 ) ) ).mul( float( 1 ).sub( crack.mul( 0.55 ) ) ) );
			rockTone.assign( mix( rockTone, rockTone.mul( 0.45 ), undercut.mul( 0.7 ) ) );
			// ④ 草木：台面上一丛丛（按大、中两层噪声成片），缓一点的坡面上也长苔
			const greenPatch = smoothstep( 0.34, 0.58, macro.g.mul( 0.6 ).add( medium.r.mul( 0.4 ) ) );
			const mossCover = smoothstep( 0.5, 0.8, broadNormal.y.add( macro.r.sub( 0.5 ).mul( 0.3 ) ) ).mul( 0.85 )
				.max( ledge.mul( greenPatch ).mul( 0.9 ) )
				.max( smoothstep( 0.62, 0.8, medium.g ).mul( greenPatch ).mul( 0.5 ) );
			const vegetation = mix( color( '#2f4127' ), color( '#56683a' ), rockFine.mul( 0.5 ).add( medium.g.mul( 0.5 ) ) );
			const rock = mix( rockTone, vegetation, mossCover ).mul( rockFine.mul( 0.12 ).add( 0.93 ) ).toVar();
			// ⑤ 凹处暗、棱上亮（建网格时算的曲率，±0.5 米就到头）
			const cavity = attribute( 'cavity', 'float' );
			rock.assign( rock.mul( cavity.mul( 0.7 ).clamp( - 0.32, 0.14 ).add( 1 ) ) );
			albedo.assign( mix( albedo, rock, rockAmount ) );
			const tangent = normalize( vec3( broadNormal.z, 0, broadNormal.x.negate() ).add( vec3( 1e-4, 0, 0 ) ) );
			const bitangent = normalize( broadNormal.cross( tangent ) );
			const gradient = octaveMiddle.ba.sub( 0.5 ).mul( 1.2 ).add( octaveSmall.ba.sub( 0.5 ).mul( 0.7 ) );
			normal.assign( normalize( normal.sub( tangent.mul( gradient.x ).add( bitangent.mul( gradient.y ) ).mul( rockAmount ) ) ) );
			normal.assign( normalize( normal.add( vec3( 0, ledge.mul( 0.9 ).sub( undercut.mul( 0.6 ) ), 0 ).mul( rockAmount ) ) ) );

		};
		if ( lean ) {

			// 草地上岩石那段乘 0：只剩原来那两次归一化（逐位一样）
			If( rockAmount.greaterThan( 0 ), rockPart ).Else( () => {

				normal.assign( normalize( normal ) );
				normal.assign( normalize( normal ) );

			} );

		} else {

			rockPart();

		}

		// 近处的真贴图（和远景同一套，阶段 12 CP3）：草地按草甸、水边的泥按沙土；岩石是自己画的岩层，不加
		const ground = state.ctx.backdrop.getGround();
		if ( ground ) {

			const grassAmount = smoothstep( 0.05, 0.5, aboveWater );
			const detail = groundDetailInScene( ground, uniforms.sceneToWorld, {
				point, normal: broadNormal, weights: vec4( grassAmount, 0, 0, float( 1 ).sub( grassAmount ) ), near: state.ctx.backdrop.getGroundNear(), cameraPoint: cameraPosition,
			} );
			const soilAmount = float( 1 ).sub( rockAmount );
			albedo.assign( albedo.mul( mix( vec3( 1 ), detail.shade, soilAmount ) ) );
			normal.assign( normalize( mix( normal, detail.normal, soilAmount ) ) );

		}

		// 草根融合（阶段 12 CP3 返工）：草的近环里地面往草根色压，草缝里是暗的草根
		if ( state.grass && state.field ) {

			// 密度用回调传：草的半径外不取（省两张草地图的取样）
			albedo.assign( state.grass.underlay( albedo, point.xz, () => grassGroundAt( point.xz ).density.mul( float( 1 ).sub( rockAmount ) ) ) );

		}

		// 地上的落花：桃林里地上一层碎粉白点，水边被冲走了
		const petalSpot = smoothstep( 0.72, 0.8, texture( noiseTexture, point.xz.div( 0.9 ) ).r ).mul( smoothstep( 0.3, 1.2, aboveWater ) ).mul( float( 1 ).sub( smoothstep( 0.08, 0.2, slope ) ) ).mul( uniforms.groundPetals );
		albedo.assign( mix( albedo, color( '#f3c9d4' ), petalSpot.mul( 0.8 ) ) );

		const backdrop = state.ctx.backdrop;
		const sky = state.ctx.world.uniforms;
		const lit = backdrop.worldLighting( albedo, normal, point, { skyView: float( 0.9 ), wrap: 0.2 } ).toVar();
		// 天边的晨光：太阳还在地平线下，东边那片天先亮起来，朝东的崖面、台面沾一层暖粉（共用光照里天光是不分方向的，崖面只靠它会一片平）
		const worldNormal = backdrop.sceneDirectionToWorld( normal );
		const dawnSide = normalize( vec3( sky.sunDirection.x, 0, sky.sunDirection.z ).add( vec3( 1e-4, 0, 0 ) ) );
		const dawnFacing = max( dot( worldNormal, dawnSide ).add( 0.25 ).div( 1.25 ), 0 );
		const dawnGlow = sky.sunHorizonColor.mul( sky.skyIntensity ).mul( dawnFacing.mul( 1.6 ) ).mul( float( 1 ).sub( smoothstep( 0.02, 0.2, sky.sunDirection.y ) ) ).mul( uniforms.dawnGlow ).mul( state.ctx.config.overture.dawnGlow );
		lit.addAssign( albedo.mul( dawnGlow ) );
		// 缠在崖上的雾带（山水画里截断山腰的那几道云）：泉眼以上 9~20 米、30~46 米两道，按慢慢横移的大块噪声断续；
		// 洞口附近 9 米以内让开
		const heightAboveSpring = point.y.sub( uniforms.springLevel );
		const bandLow = smoothstep( 7, 14, heightAboveSpring ).mul( float( 1 ).sub( smoothstep( 14, 23, heightAboveSpring ) ) );
		const bandHigh = smoothstep( 27, 35, heightAboveSpring ).mul( float( 1 ).sub( smoothstep( 37, 48, heightAboveSpring ) ) ).mul( 0.8 );
		const drift = uniforms.time.mul( 0.0015 );
		const mistNoise = texture( noiseTexture, vec2( point.x.div( 900 ).add( drift ), point.y.div( 120 ).add( point.z.div( 900 ) ) ) ).r.mul( 0.7 )
			.add( texture( noiseTexture, vec2( point.x.div( 170 ).sub( drift.mul( 1.7 ) ), point.y.div( 60 ) ).add( 0.4 ) ).g.mul( 0.3 ) );
		const awayFromMouth = smoothstep( 6, 12, length( point.sub( uniforms.mouth ) ) );
		// 雾带只在远看时有：贴近了（镜头升到洞口那几秒）一层雾贴在石头上没有前后，像抹了一道颜料
		const awayFromCamera = smoothstep( 32, 75, length( point.sub( cameraPosition ) ) );
		const mist = bandLow.add( bandHigh ).mul( smoothstep( 0.32, 0.75, mistNoise ) ).mul( rockAmount ).mul( awayFromMouth ).mul( awayFromCamera ).mul( uniforms.cliffMist ).mul( 0.2 );
		const mistColor = mix( sky.horizonColor, sky.zenithColor, 0.3 ).mul( sky.skyIntensity ).mul( 1.1 ).add( sky.sunHorizonColor.mul( sky.skyIntensity ).mul( 0.15 ) );
		lit.assign( mix( lit, mistColor, mist ) );
		return backdrop.worldAtmosphere( lit, point );

	} )();

	return material;

}

// ===================== 溪水 =====================

// 溪的中线（局部坐标）：世界的溪道点换到局部，Catmull-Rom 加密成每 1 米一个点；along 从源头往下游量
function buildRiverLine() {

	const world = state.ctx.world;
	const river = state.river;
	const controls = river.points.map( ( point ) => world.toLocal( new THREE.Vector3( point.x, point.y, point.z ), key, new THREE.Vector3() ) );
	const curve = new THREE.CatmullRomCurve3( controls, false, 'centripetal' );
	const dense = [];
	const samples = 3000;
	for ( let i = 0; i < samples; i ++ ) dense.push( curve.getPoint( i / ( samples - 1 ) ) );
	const along = [ 0 ];
	for ( let i = 1; i < dense.length; i ++ ) along.push( along[ i - 1 ] + Math.hypot( dense[ i ].x - dense[ i - 1 ].x, dense[ i ].z - dense[ i - 1 ].z ) );
	// 只要块里那一段（再往下游多 20 米）
	const points = [];
	const distances = [];
	const total = along[ along.length - 1 ];
	let cursor = 0;
	for ( let distance = 0; distance <= total; distance += 1 ) {

		while ( cursor < dense.length - 2 && along[ cursor + 1 ] < distance ) cursor ++;
		const span = along[ cursor + 1 ] - along[ cursor ] || 1;
		const point = new THREE.Vector3().lerpVectors( dense[ cursor ], dense[ cursor + 1 ], ( distance - along[ cursor ] ) / span );
		if ( point.z > terrainRect.maxZ + 20 ) break;
		// 水位按世界的溪道（地形的河床、岸也按它），不用曲线插出来的 y（跌水那段会过冲）
		const [ worldX, worldZ ] = toWorldXZ( point.x, point.z );
		point.y = world.nearestOnRiver( river, worldX, worldZ ).level - originY();
		points.push( point );
		distances.push( distance );

	}

	return { points, distances };

}

// 溪面：沿中线的一条带子，宽到两岸的地形下面；属性：沿溪距离、横向（−1 ~ 1）、横向方向、坡度（跌水处起白沫）
function buildWaterGeometry( line ) {

	const across = 12;
	const count = line.points.length;
	const positions = new Float32Array( count * ( across + 1 ) * 3 );
	const streamInfo = new Float32Array( count * ( across + 1 ) * 4 );
	for ( let i = 0; i < count; i ++ ) {

		const point = line.points[ i ];
		const before = line.points[ Math.max( 0, i - 2 ) ];
		const after = line.points[ Math.min( count - 1, i + 2 ) ];
		const tangentX = after.x - before.x;
		const tangentZ = after.z - before.z;
		const tangentLength = Math.hypot( tangentX, tangentZ ) || 1;
		const sideX = - tangentZ / tangentLength;
		const sideZ = tangentX / tangentLength;
		const slope = Math.abs( after.y - before.y ) / tangentLength;
		// 水位：中线上的（line 的 y 已经是世界溪道的水位，和地形一样）；宽：泉眼窄、往下游放宽，再多铺 1.6 米压到岸下面
		const level = point.y;
		const halfWidth = streamHalfWidth( line.distances[ i ] ) + 1.6;
		for ( let k = 0; k <= across; k ++ ) {

			const lateral = ( k / across ) * 2 - 1;
			const index = i * ( across + 1 ) + k;
			positions[ index * 3 ] = point.x + sideX * lateral * halfWidth;
			positions[ index * 3 + 1 ] = level;
			positions[ index * 3 + 2 ] = point.z + sideZ * lateral * halfWidth;
			streamInfo[ index * 4 ] = line.distances[ i ];
			streamInfo[ index * 4 + 1 ] = lateral * halfWidth / ( halfWidth - 1.6 ) * state.river.halfWidth;
			streamInfo[ index * 4 + 2 ] = Math.atan2( sideZ, sideX );
			streamInfo[ index * 4 + 3 ] = slope;

		}

	}

	// 三角形分两段：平水（这一格两头的坡度都 ≤ 0.019，着色器里跌水的碎波、白沫、假倒影的混入都是 0）在前，跌水在后，
	// 各一个材质组（perf.scenesA.skipHiddenShading 开着时平水用省掉那几段的材质，见 createWaterMaterial 的 calm）
	const calmIndices = [];
	const steepIndices = [];
	const slopeAt = ( row ) => streamInfo[ row * ( across + 1 ) * 4 + 3 ];
	for ( let i = 0; i < count - 1; i ++ ) {

		const target = Math.max( slopeAt( i ), slopeAt( i + 1 ) ) > calmSlope ? steepIndices : calmIndices;
		for ( let k = 0; k < across; k ++ ) {

			const a = i * ( across + 1 ) + k;
			const b = a + across + 1;
			target.push( a, a + 1, b, a + 1, b + 1, b );

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'streamInfo', new THREE.BufferAttribute( streamInfo, 4 ) );
	geometry.setIndex( calmIndices.concat( steepIndices ) );
	geometry.addGroup( 0, calmIndices.length, 0 );
	geometry.addGroup( calmIndices.length, steepIndices.length, 1 );
	geometry.computeBoundingSphere();
	return geometry;

}

// 溪面的平面倒影：同落日，倒影不在画溪面时嵌套着画，改成后期管线每帧画主场景之前在最外层画一次
function createWaterReflector() {

	const mirror = reflector( { resolutionScale: state.reflectionScale, bounces: false } );
	mirror.reflector.updateBeforeType = NodeUpdateType.NONE;
	mirror.target.rotation.x = - Math.PI / 2;
	mirror.target.position.y = state.uniforms.reflectionPlane.value;
	state.reflectorNode = mirror;
	return mirror;

}

// mirror：平面倒影节点（没有就传 null）。calm：只画平水那一段（三角形的坡度都 ≤ calmSlope，跌水的碎波、白沫、假倒影的混入都是 0）——
// 白沫整段不生成；假倒影（天空 + 两岸桃林）在平面倒影开着时乘 0 被盖掉，放进只看 uniform 的分支；漂花的光照只在有花瓣的像素算。
// 每个像素的结果和完整的那个材质一样（perf.scenesA.skipHiddenShading）
function createWaterMaterial( noiseTexture, mirror, calm = false ) {

	const uniforms = state.uniforms;
	const sky = state.ctx.world.uniforms;
	const backdrop = state.ctx.backdrop;

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = ( mirror ? '溪水（平面倒影）' : '溪水' ) + ( calm ? '·平水' : '' );
	material.fog = false;
	material.lights = false;

	material.colorNode = Fn( () => {

		const info = attribute( 'streamInfo', 'vec4' );
		const along = info.x;
		const lateral = info.y;
		const sideAngle = info.z;
		const steep = info.w;
		const side = vec3( cos( sideAngle ), 0, sin( sideAngle ) ).toVar();
		const downstream = vec3( side.z, 0, side.x.negate() );
		const point = positionGeometry;
		// 分支前后都要用的量先落成变量（TSL 按第一次用到的位置生成代码，不落地的话会生成进 If 里面，If 外读到的是 0）
		const toViewer = normalize( cameraPosition.sub( point ) ).toVar();
		const halfWidth = float( state.river.halfWidth );

		// ---------- 微波：两层噪声贴图的梯度，顺水往下游流（流速 0.35 米/秒），跌水处流得快、波大 ----------
		const flowSpeed = mix( float( 0.35 ), float( 1.6 ), smoothstep( 0.02, 0.08, steep ) );
		const flowCoordinate = vec2( along.sub( uniforms.time.mul( flowSpeed ) ), lateral );
		const coarse = texture( noiseTexture, flowCoordinate.div( vec2( 5.5, 3.2 ) ) );
		const fineSample = texture( noiseTexture, flowCoordinate.div( vec2( 1.7, 1.1 ) ).add( vec2( 0.37, uniforms.time.mul( 0.013 ) ) ) );
		// 一个像素在水面上多大（米）：比细波纹大时细波纹淡掉，比粗波纹大时粗波纹也淡掉，远处是平静的镜面
		const footprint = max( length( fwidth( point ) ), 0.001 );
		const coarseFade = float( 1 ).sub( smoothstep( 0.25, 1.2, footprint ) );
		const fineFade = float( 1 ).sub( smoothstep( 0.06, 0.3, footprint ) );
		const gradient = coarse.ba.sub( 0.5 ).mul( 0.07 ).mul( coarseFade ).add( fineSample.ba.sub( 0.5 ).mul( 0.035 ).mul( fineFade ) ).mul( mix( float( 1 ), float( 4 ), smoothstep( 0.02, 0.08, steep ) ) ).mul( uniforms.rippleAmount ).toVar();
		const normal = normalize( vec3( 0, 1, 0 ).sub( downstream.mul( gradient.x ) ).sub( side.mul( gradient.y ) ) ).toVar();

		// ---------- 倒影 ----------
		const reflected = reflect( toViewer.negate(), normal ).toVar();
		reflected.y.assign( max( reflected.y, 0.005 ) );
		const fakeReflection = vec3( 0 ).toVar();
		// If 的回调不能有返回值（TSL 会当成 return 语句），写成块
		const fakePart = () => {

			// 天空（远景的统一天空，不画太阳圆盘、星星）
			const worldReflected = backdrop.sceneDirectionToWorld( reflected );
			const skyColor = daySkyColor( worldReflected, sky, uniforms.time, { sunDisc: false, stars: false } );
			// 两岸的桃林倒在水里：反射光线往岸那边走，横向走到林边（离中线 halfWidth + 3 米）时升起的高度低于树冠（约 5.5 米，按沿溪的噪声起伏）就是树
			const lateralRate = dot( reflected.xz, side.xz );
			const gap = select( lateralRate.greaterThan( 0 ), halfWidth.add( 3 ).sub( lateral ), halfWidth.add( 3 ).add( lateral ) ).max( 0.5 );
			const rise = reflected.y.mul( gap ).div( max( abs( lateralRate ), 0.02 ) );
			const crown = valueNoise2D( vec2( along.mul( 0.11 ), select( lateralRate.greaterThan( 0 ), float( 3.7 ), float( 9.1 ) ) ) ).mul( 2.2 ).add( 4.4 );
			const treeAmount = float( 1 ).sub( smoothstep( crown.sub( 0.6 ), crown.add( 0.4 ), rise ) ).mul( uniforms.bankReflection );
			// 树的倒影：上面是花（粉），贴水那一截是岸和树干（暗）；光照按天光
			const blossomTone = mix( color( '#d9a0b4' ), color( '#f2c8d6' ), valueNoise2D( vec2( along.mul( 0.6 ), rise.mul( 0.8 ) ) ) );
			const bankTone = color( '#3d3a2c' );
			const treeAlbedo = mix( bankTone, blossomTone, smoothstep( 0.25, 1.1, rise.add( valueNoise2D( vec2( along.mul( 0.9 ), 1.3 ) ).sub( 0.5 ).mul( 0.6 ) ) ) );
			const treeColor = shade( treeAlbedo, vec3( 0, 1, 0 ), point.add( vec3( 0, 3, 0 ) ), { skyView: float( 0.85 ), wrap: 0.5 } );
			fakeReflection.assign( mix( skyColor, treeColor, treeAmount ) );

		};
		// 平水：平面倒影开着（mirrorAmount = 1）时假倒影乘 0，跌水的混入也是 0，整段不算（条件只看 uniform，整帧一致）
		if ( calm && mirror ) If( uniforms.mirrorAmount.lessThan( 0.999 ), fakePart );
		else fakePart();
		const reflection = fakeReflection.toVar();
		if ( mirror ) {

			// 平面倒影：按微波把采样位置偏一点（竖直方向偏得多，倒影被拉成竖条）
			const mirrored = mirror.sample( mirror.uvNode.add( vec2( gradient.y.mul( 0.25 ), gradient.x.mul( 0.6 ) ) ) ).rgb;
			reflection.assign( mix( fakeReflection, mirrored, uniforms.mirrorAmount ) );

		}

		// 菲涅尔（Schlick，水 F0 = 0.02）
		const facing = max( dot( normal, toViewer ), 0.02 );
		// 跌水的地方水面碎，倒影几乎没有（平面倒影的平面在下游的水面上，跌水那段比它高 1~3 米，硬用会错位）
		const rough = smoothstep( 0.02, 0.07, steep );
		reflection.assign( mix( reflection, fakeReflection.mul( 0.6 ), rough.mul( 0.5 ) ) );
		const fresnel = float( 0.02 ).add( pow( float( 1 ).sub( facing ), 5 ).mul( 0.98 ) ).mul( float( 1 ).sub( rough.mul( 0.6 ) ) );
		// 水体：浅的地方透出水底（卵石、泥），深的地方暗绿
		const depthRatio = abs( lateral ).div( halfWidth ).clamp( 0, 1 );
		const bed = mix( color( '#2f3a2e' ), color( '#6e6450' ), depthRatio.mul( depthRatio ) );
		const body = shade( bed, vec3( 0, 1, 0 ), point, { skyView: float( 0.7 ), wrap: 0.3 } ).mul( 0.55 );
		const surface = mix( body, reflection, fresnel.mul( 0.85 ).add( 0.15 ) ).toVar();

		// ---------- 漂着的花瓣：沿溪 0.32 米一格，每格最多一片，顺水往下漂；岸边多、中间少 ----------
		const cellSize = float( 0.32 );
		const petalCoordinate = vec2( along.sub( uniforms.time.mul( 0.35 ) ), lateral ).div( cellSize );
		const cell = floor( petalCoordinate );
		const local = fract( petalCoordinate ).sub( 0.5 );
		const random = hash33( vec3( cell, 3 ) );
		const nearBank = smoothstep( 0.2, 0.95, depthRatio );
		const exists = random.x.lessThan( mix( float( 0.08 ), float( 0.42 ), nearBank ).mul( uniforms.floatingPetals ) );
		const angle = random.y.mul( 6.28 );
		const rotated = vec2( local.x.mul( cos( angle ) ).sub( local.y.mul( sin( angle ) ) ), local.x.mul( sin( angle ) ).add( local.y.mul( cos( angle ) ) ) ).sub( random.zx.sub( 0.5 ).mul( 0.4 ) );
		// 花瓣形（审查 R40：原来是一样大的白椭圆，像药片）：大小 0.6~1.2 倍；根部窄、瓣尖宽（水滴形），瓣尖一个小缺口（桃花瓣那样）；
		// 颜色淡粉到粉白，根部深一点
		const petalSize = random.z.mul( 0.6 ).add( 0.6 );
		const petalLocal = rotated.div( petalSize );
		const petalWidth = mix( float( 0.075 ), float( 0.12 ), smoothstep( - 0.17, 0.12, petalLocal.x ) );
		const petalBody = float( 1 ).sub( smoothstep( 0.7, 1, length( vec2( petalLocal.x.div( 0.17 ), petalLocal.y.div( petalWidth ) ) ) ) );
		const petalNotch = smoothstep( 0.035, 0.05, length( petalLocal.sub( vec2( 0.17, 0 ) ) ) );
		const petalShape = petalBody.mul( petalNotch );
		const petalAmount = select( exists, petalShape, float( 0 ) ).mul( float( 1 ).sub( smoothstep( 0.03, 0.06, steep ) ) ).toVar();
		const petalPart = () => {

			const petalTint = mix( color( '#f2b3c7' ), color( '#fde6ee' ), random.z ).mul( mix( float( 0.85 ), float( 1 ), smoothstep( - 0.17, 0, petalLocal.x ) ) );
			const petalColor = shadeThin( petalTint, vec3( 0, 1, 0 ), point, toViewer );
			surface.assign( mix( surface, petalColor, petalAmount ) );

		};
		// 平水：没花瓣的像素（大部分）不算花瓣的光照（mix 系数是 0）；光照里只有 .level(0) 的采样，放进分支没问题
		if ( calm ) If( petalAmount.greaterThan( 0 ), petalPart );
		else petalPart();

		// ---------- 跌水的白沫（源头石缝流下来那一段）：平水那一段白沫是 0，不生成 ----------
		if ( ! calm ) {

			const foamNoise = texture( noiseTexture, vec2( along.mul( 0.22 ).sub( uniforms.time.mul( 0.35 ) ), lateral.mul( 0.9 ) ) ).r.mul( 0.6 ).add( texture( noiseTexture, vec2( along.mul( 0.5 ).sub( uniforms.time.mul( 0.8 ) ), lateral.mul( 2.1 ).add( 0.3 ) ) ).g.mul( 0.4 ) );
			const foam = smoothstep( 0.025, 0.08, steep ).mul( smoothstep( 0.52, 0.78, foamNoise ) );
			surface.assign( mix( surface, shade( color( '#e2e8e6' ), vec3( 0, 1, 0 ), point, { wrap: 0.5 } ), foam.mul( 0.55 ) ) );

		}

		return backdrop.worldAtmosphere( surface, point );

	} )();

	return material;

}

// ===================== 桃树 =====================

// 种树：两岸离溪中线 7.5~75 米，坡缓的地方；"林尽"——世界坐标 z 1690~1770 之间桃林慢慢没了（和远景的桃林遮罩一样）
function plantTrees( line ) {

	const overtureConfig = state.ctx.config.overture;
	const random = createRandom( 19840 );
	const world = state.ctx.world;
	const trees = [];
	const spacing = overtureConfig.treeSpacing;
	for ( let z = terrainRect.minZ + 10; z < terrainRect.maxZ - 6; z += spacing ) {

		for ( let x = terrainRect.minX + 8; x < terrainRect.maxX - 8; x += spacing ) {

			const treeX = x + ( random() - 0.5 ) * spacing * 0.9;
			const treeZ = z + ( random() - 0.5 ) * spacing * 0.9;
			const [ worldX, worldZ ] = toWorldXZ( treeX, treeZ );
			const nearest = world.nearestOnRiver( state.river, worldX, worldZ );
			if ( nearest.upstream > 0 ) continue;
			const distance = nearest.distance;
			if ( distance < 7.5 || distance > overtureConfig.treeReach ) continue;
			const forestEnd = smoothJs( 1668, 1715, worldZ );
			const ground = groundHeight( treeX, treeZ );
			const slope = Math.hypot( groundHeight( treeX + 1, treeZ ) - groundHeight( treeX - 1, treeZ ), groundHeight( treeX, treeZ + 1 ) - groundHeight( treeX, treeZ - 1 ) ) / 2;
			// 靠溪的几排最密（"夹岸"），往外疏一些；坡上按 22 米上下的噪声成丛、丛间留空（审查 R39：原来等距成排，像果园）
			const clump = smoothJs( 0.32, 0.62, jsFbm2D( worldX / 22 + 3.1, worldZ / 22 - 1.7, 2 ) );
			const density = forestEnd * smoothJs( 0.5, 0.3, slope ) * ( distance < 14 ? 0.95 : ( distance < 22 ? 0.95 : 0.7 ) * ( 0.35 + 0.8 * clump ) );
			if ( random() > density ) continue;
			// 近水的大、坡上远处的小，成丛的地方大一点（同一片林子里高矮错开）
			const sizeBase = 0.7 + 0.4 * smoothJs( 40, 12, distance ) + 0.15 * clump;
			trees.push( { x: treeX, z: treeZ, y: ground - 0.05, distance, yaw: random() * Math.PI * 2, scale: sizeBase + random() * 0.3, template: Math.floor( random() * overtureConfig.treeTemplates ) } );

		}

	}

	return trees;

}

// ===================== 泉眼的石头（"水从石缝流出"）=====================

// 源头往下游 38 米：两岸一溜大大小小的卵石（盖住溪面笔直的边），源头崖脚堆一堆（水从石头缝里出来），水里零星几块。
// 每块是一个鼓包的二十面体（细分两次、合并顶点，表面圆润），按低频噪声凹凸、压扁，埋进地里三成；全部合成一个网格
function buildSpringRocks( line ) {

	const random = createRandom( 2711 );
	const parts = [];
	const addRock = ( x, z, radius, sink ) => {

		const ground = groundHeight( x, z );
		if ( ! Number.isFinite( ground ) ) return;
		const geometry = mergeVertices( new THREE.IcosahedronGeometry( 1, 2 ).deleteAttribute( 'normal' ).deleteAttribute( 'uv' ) );
		const position = geometry.attributes.position;
		const seed = random() * 50;
		const squash = 0.55 + random() * 0.3;
		const stretch = 0.9 + random() * 0.5;
		const yaw = random() * Math.PI * 2;
		const cosine = Math.cos( yaw );
		const sine = Math.sin( yaw );
		const centerY = ground + radius * squash * ( 0.62 - sink );
		for ( let i = 0; i < position.count; i ++ ) {

			const px = position.getX( i );
			const py = position.getY( i );
			const pz = position.getZ( i );
			const lump = 0.78 + 0.44 * jsFbm2D( px * 1.3 + seed, pz * 1.3 + py * 0.9, 3 );
			// 底下压平一点（坐在地上），顶上圆
			const flatBottom = py < - 0.4 ? 0.4 + ( py + 0.4 ) * 0.5 : py;
			const localX = px * lump * radius * stretch;
			const localY = flatBottom * lump * radius * squash;
			const localZ = pz * lump * radius;
			position.setXYZ( i, x + localX * cosine - localZ * sine, centerY + localY, z + localX * sine + localZ * cosine );

		}

		geometry.computeVertexNormals();
		// 离水面多高（每块石头按它中心处的水位算）：贴水那一圈画湿
		const level = streamAt( x, z ).level;
		const aboveWater = new Float32Array( position.count );
		for ( let i = 0; i < position.count; i ++ ) aboveWater[ i ] = position.getY( i ) - level;
		geometry.setAttribute( 'aboveWater', new THREE.BufferAttribute( aboveWater, 1 ) );
		parts.push( geometry );

	};

	const sideOf = ( index ) => {

		const point = line.points[ index ];
		const after = line.points[ Math.min( line.points.length - 1, index + 1 ) ];
		const before = line.points[ Math.max( 0, index - 1 ) ];
		const tangentX = after.x - before.x;
		const tangentZ = after.z - before.z;
		const length = Math.hypot( tangentX, tangentZ ) || 1;
		return { point, sideX: - tangentZ / length, sideZ: tangentX / length, tangentX: tangentX / length, tangentZ: tangentZ / length };

	};

	// 两岸：沿溪每 0.7~1.3 米一块，半径 0.25~0.75 米，越靠源头越大越密
	for ( const sideSign of [ - 1, 1 ] ) {

		let along = 0.5 + random();
		while ( along < 38 ) {

			const index = Math.min( line.points.length - 1, Math.round( along ) );
			const { point, sideX, sideZ } = sideOf( index );
			const nearSource = 1 - Math.min( 1, along / 38 );
			const radius = ( 0.18 + random() * random() * 0.7 ) * ( 1 + nearSource * 0.5 );
			const offset = streamHalfWidth( line.distances[ index ] ) + radius * ( - 0.1 + random() * 0.8 ) + random() * random() * 1.6;
			if ( random() < 0.82 ) addRock( point.x + sideX * offset * sideSign, point.z + sideZ * offset * sideSign, radius, 0.3 );
			// 大石头脚下偶尔再挨一块小的
			if ( random() < 0.4 ) addRock( point.x + sideX * ( offset + radius * ( 0.7 + random() * 0.6 ) ) * sideSign + ( random() - 0.5 ) * radius, point.z + sideZ * ( offset + radius * ( 0.7 + random() * 0.6 ) ) * sideSign + ( random() - 0.5 ) * radius, radius * ( 0.35 + random() * 0.3 ), 0.25 );
			along += 0.5 + random() * random() * 2.4 + ( 1 - nearSource ) * 0.5;

		}

	}

	// 源头：崖脚一堆，水从中间的缝里出来（中间留 1 米宽不放）
	const source = sideOf( 0 );
	for ( let i = 0; i < 9; i ++ ) {

		const sideSign = i % 2 === 0 ? - 1 : 1;
		const lateral = sideSign * ( 0.8 + random() * 1.4 );
		const back = 0.2 + random() * 2.2;
		const radius = 0.45 + random() * 0.5;
		addRock( source.point.x + source.sideX * lateral + source.tangentX * back, source.point.z + source.sideZ * lateral + source.tangentZ * back, radius, 0.35 );

	}

	// 水里：零星几块小的，水从旁边绕过去
	for ( let i = 0; i < 6; i ++ ) {

		const along = 3 + random() * 30;
		const index = Math.min( line.points.length - 1, Math.round( along ) );
		const { point, sideX, sideZ } = sideOf( index );
		const lateral = ( random() - 0.5 ) * streamHalfWidth( line.distances[ index ] ) * 1.2;
		addRock( point.x + sideX * lateral, point.z + sideZ * lateral, 0.16 + random() * 0.18, 0.45 );

	}

	const geometry = mergeGeometries( parts );
	for ( const part of parts ) part.dispose();
	geometry.computeBoundingSphere();
	return geometry;

}

function createSpringRockMaterial( noiseTexture ) {

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '泉眼的石头';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const point = positionGeometry;
		const normal = normalize( normalGeometry );
		const weights = pow( abs( normal ), vec3( 4 ) );
		const weightSum = weights.x.add( weights.y ).add( weights.z );
		const planar = ( scale ) => texture( noiseTexture, point.zy.div( scale ) ).mul( weights.x )
			.add( texture( noiseTexture, point.xz.div( scale ) ).mul( weights.y ) )
			.add( texture( noiseTexture, point.xy.div( scale ) ).mul( weights.z ) ).div( weightSum );
		const broad = planar( 9 );
		const grain = planar( 1.7 );
		// 青灰的卵石，深浅一块一块；朝上的一面长苔；贴着水面那一圈是湿的（更暗）
		const stone = mix( color( '#4a4744' ), color( '#7c766d' ), broad.r.mul( 0.7 ).add( grain.g.mul( 0.3 ) ) ).mul( grain.r.mul( 0.2 ).add( 0.9 ) );
		const moss = mix( color( '#33462a' ), color( '#5c6e3c' ), grain.g );
		const mossCover = smoothstep( 0.45, 0.85, normal.y.add( broad.g.sub( 0.5 ).mul( 0.6 ) ) ).mul( 0.85 );
		const wet = float( 1 ).sub( smoothstep( 0.05, 0.3, attribute( 'aboveWater', 'float' ) ) );
		const albedo = mix( stone, moss, mossCover ).mul( float( 1 ).sub( wet.mul( 0.4 ) ) );
		return shade( albedo, normal, point, { skyView: float( 0.85 ), wrap: 0.3 } );

	} )();
	return material;

}

// ===================== 小船（只露出一角空船头）=====================

function buildBoatGeometry() {

	// 船身：横截面是一条 U 形（深 0.32 米），沿船长从船尾（z = 1.2）到船头（z = −2.6）收窄、船头翘起。
	// 船沿在本地 y = 0（船头翘起 rise）；船里铺一层底板（y = −0.16），再横两条坐板，船尾封一块尾板：
	// 船放在水上时船沿高出水面 freeboard 米、底板也在水面以上，从船里往下看看到的是底板，不会看到水面从船里穿出来
	const hullDepth = 0.32;
	const floorY = - 0.16;
	const sections = 14;
	const around = 9;
	const parts = [];
	const widthAt = ( along ) => 0.62 * Math.sqrt( Math.max( 0, 1 - Math.pow( Math.max( 0, along - 0.35 ) / 0.65, 2 ) ) ) + 0.02;
	const riseAt = ( along ) => Math.pow( Math.max( 0, along - 0.55 ) / 0.45, 2 ) * 0.35;
	const zAt = ( along ) => 1.2 - along * 3.8;
	const withPart = ( geometry, part ) => {

		geometry.computeVertexNormals();
		geometry.setAttribute( 'boatPart', new THREE.Float32BufferAttribute( new Array( geometry.attributes.position.count ).fill( part ), 1 ) );
		return geometry;

	};

	// 船身
	const hullPositions = [];
	const hullIndices = [];
	for ( let i = 0; i <= sections; i ++ ) {

		const along = i / sections;
		for ( let k = 0; k <= around; k ++ ) {

			const angle = Math.PI * ( k / around );
			hullPositions.push( Math.cos( angle ) * widthAt( along ), - Math.sin( angle ) * hullDepth + riseAt( along ), zAt( along ) );

		}

	}

	for ( let i = 0; i < sections; i ++ ) {

		for ( let k = 0; k < around; k ++ ) {

			const a = i * ( around + 1 ) + k;
			const b = a + around + 1;
			hullIndices.push( a, b, a + 1, a + 1, b, b + 1 );

		}

	}

	const hull = new THREE.BufferGeometry();
	hull.setAttribute( 'position', new THREE.Float32BufferAttribute( hullPositions, 3 ) );
	hull.setIndex( hullIndices );
	parts.push( withPart( hull, 0 ) );

	// 底板：每一节在 floorY 那个高度上量出船身的半宽（U 形截面 y = −sin·深 + rise → 宽 = w·cos），船头翘起来、船底高过底板的那几节就没有
	// 底板收窄到 5 厘米以下就停（宽度是 0 的三角形算不出法线，着色器里会变成 NaN，整块底板发黑）；三角形朝上绕（正面朝上）
	const floorPositions = [];
	const floorIndices = [];
	let floorRows = 0;
	for ( let i = 0; i <= sections; i ++ ) {

		const along = i / sections;
		const sine = Math.min( 1, Math.max( 0, ( riseAt( along ) - floorY ) / hullDepth ) );
		const halfWidth = widthAt( along ) * Math.sqrt( 1 - sine * sine ) * 0.98;
		if ( halfWidth < 0.05 ) break;
		floorPositions.push( - halfWidth, floorY, zAt( along ), halfWidth, floorY, zAt( along ) );
		if ( floorRows > 0 ) {

			const a = ( floorRows - 1 ) * 2;
			floorIndices.push( a, a + 1, a + 2, a + 1, a + 3, a + 2 );

		}

		floorRows ++;

	}

	const floorGeometry = new THREE.BufferGeometry();
	floorGeometry.setAttribute( 'position', new THREE.Float32BufferAttribute( floorPositions, 3 ) );
	floorGeometry.setIndex( floorIndices );
	parts.push( withPart( floorGeometry, 1 ) );

	// 尾板：船尾那一圈 U 形和船沿连线之间的半圆，从船沿中点扇形连过去
	const sternPositions = [ 0, 0, zAt( 0 ) ];
	const sternIndices = [];
	for ( let k = 0; k <= around; k ++ ) {

		const angle = Math.PI * ( k / around );
		sternPositions.push( Math.cos( angle ) * widthAt( 0 ), - Math.sin( angle ) * hullDepth, zAt( 0 ) );
		if ( k > 0 ) sternIndices.push( 0, k, k + 1 );

	}

	const stern = new THREE.BufferGeometry();
	stern.setAttribute( 'position', new THREE.Float32BufferAttribute( sternPositions, 3 ) );
	stern.setIndex( sternIndices );
	parts.push( withPart( stern, 0 ) );

	// 两条坐板：在船沿下面 4 厘米，横跨两舷
	for ( const along of [ 0.18, 0.52 ] ) {

		const seatY = - 0.04 + riseAt( along );
		const sine = Math.min( 1, ( riseAt( along ) - seatY ) / hullDepth );
		const span = widthAt( along ) * Math.sqrt( 1 - sine * sine ) * 2;
		const seat = new THREE.BoxGeometry( span, 0.035, 0.22 );
		seat.deleteAttribute( 'uv' );
		seat.translate( 0, seatY, zAt( along ) );
		parts.push( withPart( seat.toNonIndexed(), 2 ) );

	}

	const merged = mergeGeometries( parts.map( ( part ) => part.index ? part.toNonIndexed() : part ) );
	for ( const part of parts ) part.dispose();
	merged.computeBoundingSphere();
	return merged;

}

function createBoatMaterial( noiseTexture ) {

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '小船';
	material.side = THREE.DoubleSide;
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const point = positionWorld;
		// 船是转过、挪过的网格：法线要用世界法线（normalGeometry 是船自己的坐标，光照方向全错）；船里面那一面（背面）把法线翻过来
		const part = attribute( 'boatPart', 'float' );
		const outward = normalize( normalWorld );
		// 底板的法线就是船的"上"（船本地 +y 转到场景里），不靠顶点法线
		const boatUp = normalize( modelWorldMatrix.mul( vec4( 0, 1, 0, 0 ) ).xyz );
		const normal = select( part.greaterThan( 0.5 ).and( part.lessThan( 1.5 ) ), boatUp, select( frontFacing, outward, outward.negate() ) );
		// 木板：船身沿船长的条纹（板缝横着走），底板顺着船长铺（板缝顺着走），坐板颜色浅一点；再叠旧木头的纹理
		const hullPlank = sin( positionGeometry.y.mul( 38 ) ).mul( 0.5 ).add( 0.5 );
		const floorPlank = sin( positionGeometry.x.mul( 34 ) ).mul( 0.5 ).add( 0.5 );
		const plank = select( part.greaterThan( 0.5 ), floorPlank, hullPlank );
		const grain = texture( noiseTexture, vec2( positionGeometry.z.mul( 0.4 ), positionGeometry.y.mul( 6 ).add( positionGeometry.x.mul( 3 ) ) ) ).r;
		// 旧木头晒得发白的暖灰褐（原来 #4a3a2c 太深，天还没亮时船是一团黑）
		const albedo = mix( color( '#7d6650' ), color( '#a68e70' ), grain.mul( 0.7 ).add( plank.mul( 0.3 ) ) )
			.mul( select( part.greaterThan( 1.5 ), float( 1.18 ), select( part.greaterThan( 0.5 ), float( 0.9 ), float( 1 ) ) ) );
		return shade( albedo, normal, point, { skyView: float( 0.8 ), wrap: 0.4 } );

	} )();
	return material;

}

// ===================== 路线 =====================

// 合成路线（局部坐标）：前一段是溪中线（水面 + 眼高，从原点下游 6 米起往上游）→ 船停的地方 → 往上抬到洞口外 →
// 洞口，按弧长 0.5 米一个点；后一段是洞的中线（world.cave.at，地面 + 洞里的眼高），直接算，和花园接着走的那段是同一个函数
function buildRoute( line ) {

	const ctx = state.ctx;
	const world = ctx.world;
	const overtureConfig = ctx.config.overture;
	const cave = world.cave;
	const caveEye = overtureConfig.caveEyeHeight;
	const controls = [];

	// 溪：line 是从源头往下游；路线从下游往上游走
	const boatStopAlong = overtureConfig.boatStopFromSource;
	let originAlong = 0;
	let bestDistance = Infinity;
	line.points.forEach( ( point, index ) => {

		const distance = Math.hypot( point.x, point.z );
		if ( distance < bestDistance ) {

			bestDistance = distance;
			originAlong = line.distances[ index ];

		}

	} );

	for ( let index = line.points.length - 1; index >= 0; index -- ) {

		const along = line.distances[ index ];
		if ( along > originAlong + 6 || along < boatStopAlong ) continue;
		if ( index % 4 !== 0 && along > boatStopAlong + 2 ) continue;
		const point = line.points[ index ];
		controls.push( new THREE.Vector3( point.x, point.y + overtureConfig.eyeHeight, point.z ) );

	}

	const stopPoint = controls[ controls.length - 1 ].clone();
	// 往上抬到洞口：洞外 7 米、比洞里眼高高 0.4 米的地方，再进洞口；最后补一个洞里 2 米的点只定方向（重采样后截掉）
	const caveSample = {};
	const toLocal = ( worldPoint ) => world.toLocal( worldPoint, key, new THREE.Vector3() );
	cave.at( 0, caveSample );
	const caveEntry = toLocal( caveSample.position.clone().add( new THREE.Vector3( 0, caveEye, 0 ) ) );
	const mouthOutside = toLocal( caveSample.position.clone().addScaledVector( caveSample.tangent, - 7 ).add( new THREE.Vector3( 0, caveEye + 0.4, 0 ) ) );
	const rise = stopPoint.clone().lerp( mouthOutside, 0.5 );
	rise.y = Math.max( rise.y, mouthOutside.y - 0.6 );
	cave.at( 2, caveSample );
	const insideCave = toLocal( caveSample.position.clone().add( new THREE.Vector3( 0, caveEye, 0 ) ) );
	controls.push( rise, mouthOutside, caveEntry, insideCave );
	const resampled = resampleCurve( controls, 0.5 );
	// 截到洞口
	let entryIndex = resampled.points.length - 1;
	let entryGap = Infinity;
	resampled.points.forEach( ( point, index ) => {

		const gap = point.distanceToSquared( caveEntry );
		if ( gap < entryGap ) {

			entryGap = gap;
			entryIndex = index;

		}

	} );
	resampled.points.length = entryIndex + 1;
	resampled.points[ entryIndex ].copy( caveEntry );
	resampled.length = entryIndex * resampled.spacing;

	let stop = 0;
	let stopGap = Infinity;
	resampled.points.forEach( ( point, index ) => {

		const gap = point.distanceToSquared( stopPoint );
		if ( gap < stopGap ) {

			stopGap = gap;
			stop = index * resampled.spacing;

		}

	} );

	return {
		before: resampled,
		cave: resampled.length,                                  // 路线上洞口的位置（米）
		stop,
		handoff: resampled.length + cave.handoffDistance,       // 交给花园的位置
		length: resampled.length + cave.length,
		caveEye,
		originAlong,
	};

}

function routePoint( distance, target ) {

	const route = state.route;
	if ( distance <= route.cave ) return pointOnCurve( route.before, distance, target );
	const world = state.ctx.world;
	const sample = world.cave.at( distance - route.cave, state.caveSample );
	tempWorld.copy( sample.position );
	tempWorld.y += route.caveEye;
	return world.toLocal( tempWorld, key, target );

}

// 按时间走过的距离：几个关键时刻对上规格书的分镜（0~6 秒几乎不动、6~38 秒逆流约 130 米、38~48 秒慢下来停在林尽处、
// 48~56 秒离船升到洞口、56~62 秒进洞到交接处；交接处的速度强制成 handoffSpeed，花园从这个速度接着走）
function buildSchedule() {

	const route = state.route;
	const overtureConfig = state.ctx.config.overture;
	const handoffSpeed = overtureConfig.handoffSpeed;
	const duration = state.duration;
	const keys = [
		[ 0, 0 ],
		[ 6, 2.2 ],
		[ 38, route.stop - 26 ],
		[ 47, route.stop - 0.4 ],
		[ 48.5, route.stop ],
		[ 56, route.cave ],
		[ duration, route.handoff ],
		[ duration + 4, route.handoff + handoffSpeed * 4 ],
	];
	return monotoneCurve( keys, { 6: handoffSpeed, 7: handoffSpeed } );

}

// 时间 → 位置、朝向。朝向看前方路线上的点（越快看得越远），再按分镜加几样：开头抬头看山顶的落月、
// 林尽处抬头看崖上的洞口
function poseAt( time, position, quaternion ) {

	const route = state.route;
	const distance = state.schedule( time );
	routePoint( distance, position );
	const speed = ( state.schedule( time + 0.05 ) - state.schedule( time - 0.05 ) ) / 0.1;
	const ahead = routePoint( distance + Math.max( 9, speed * 3.2 ), tempTarget );
	// 洞口截面中心（局部）
	const mouth = state.mouthLocal;
	const lookMouth = smoothJs( 36, 44, time ) * ( 1 - smoothJs( 54, 57.5, time ) );
	ahead.lerp( mouth, lookMouth );
	// 开头：看前方山顶上的落月（抬头约 13°），4 秒以后慢慢放平
	const lift = 11.5 * ( 1 - smoothJs( 4, 15, time ) ) + 1.5;
	tempMatrix.lookAt( position, ahead, worldUp );
	quaternion.setFromRotationMatrix( tempMatrix );
	tempEuler.setFromQuaternion( quaternion, 'YXZ' );
	tempEuler.x += lift * degree * ( 1 - lookMouth );
	quaternion.setFromEuler( tempEuler );
	return distance;

}

// ===================== init =====================

export async function init( ctx ) {

	if ( state.scene ) {

		console.warn( '开场：init 被重复调用，先释放旧的再重建' );
		dispose();

	}

	try {

		return await build( ctx );

	} catch ( error ) {

		releaseResources();
		throw error;

	}

}

async function build( ctx ) {

	const started = performance.now();
	if ( ! ctx.backdrop || ! ctx.world || ! ctx.backdrop.getRoot() ) throw new Error( '开场：要先建好秘境（ctx.world、ctx.backdrop）' );
	state.ctx = ctx;
	state.disposables = [];
	const overtureConfig = ctx.config.overture;
	const sceneConfig = ctx.config.scenes.find( ( item ) => item.key === key );
	state.duration = sceneConfig ? sceneConfig.duration : 62;
	state.river = ctx.world.getRiver( 'peachStream' );
	const params = ctx.quality.params;
	const content = ctx.quality.content;

	const scene = new THREE.Scene();
	scene.name = '开场·桃花溪';
	scene.background = new THREE.Color( 0x000000 );
	state.scene = scene;

	// 远景的 sceneToWorld：远景挂进来以后每帧更新；开场的材质要用（地形挖洞、倒影方向换世界）
	const backdropUniforms = ctx.backdrop.getSceneToWorld();
	const line = buildRiverLine();
	state.line = line;
	state.uniforms = {
		time: uniform( 0 ),
		sceneToWorld: backdropUniforms,
		reflectionPlane: uniform( line.points[ Math.round( line.points.length * 0.5 ) ].y ),
		rippleAmount: uniform( 1 ),
		bankReflection: uniform( 1 ),
		mirrorAmount: uniform( 1 ),
		floatingPetals: uniform( 1 ),
		groundPetals: uniform( 1 ),
		windAmount: uniform( 1 ),
		springLevel: uniform( line.points[ 0 ].y ),      // 泉眼的水位（局部 y），崖上雾带按它定高度
		mouth: uniform( new THREE.Vector3() ),            // 洞口截面中心（局部），雾带在这附近让开
		cliffMist: uniform( 1 ),
		dawnGlow: uniform( 1 ),
	};

	const noiseData = createNoiseTextureData( 256, 32, 23 );
	const noiseTexture = new THREE.DataTexture( noiseData.data, noiseData.size, noiseData.size, THREE.RGBAFormat, THREE.UnsignedByteType );
	noiseTexture.wrapS = THREE.RepeatWrapping;
	noiseTexture.wrapT = THREE.RepeatWrapping;
	noiseTexture.magFilter = THREE.LinearFilter;
	noiseTexture.minFilter = THREE.LinearMipmapLinearFilter;
	noiseTexture.generateMipmaps = true;
	noiseTexture.needsUpdate = true;
	state.disposables.push( noiseTexture );

	// 地形
	const terrainGeometry = await buildTerrain();
	const terrainMaterial = createTerrainMaterial( noiseTexture );
	const terrain = new THREE.Mesh( terrainGeometry, terrainMaterial );
	terrain.name = '开场地形';
	scene.add( terrain );
	state.disposables.push( terrainGeometry, terrainMaterial );
	await buildField();

	// 溪水
	const useReflector = params.reflectionScale > 0;
	state.reflectionScale = params.reflectionScale;
	state.caveHidden = false;
	const waterGeometry = buildWaterGeometry( line );
	const mirror = useReflector ? createWaterReflector() : null;
	const waterMaterial = createWaterMaterial( noiseTexture, mirror );
	// 平水那一段（几何体的第 0 组）用省掉跌水几段的材质（perf.scenesA.skipHiddenShading）；关掉时整条溪一个材质，分组不起作用
	const calmMaterial = ctx.config.perf.scenesA.skipHiddenShading ? createWaterMaterial( noiseTexture, mirror, true ) : null;
	const water = new THREE.Mesh( waterGeometry, calmMaterial ? [ calmMaterial, waterMaterial ] : waterMaterial );
	water.name = '桃花溪';
	water.frustumCulled = false;
	scene.add( water );
	state.water = water;
	// 倒影跳过用的水面分块（camera.js 的 prepareMeshView），在这里取好点，不放进第一帧
	prepareMeshView( water, { groundHeight: groundHeightAt } );
	state.disposables.push( waterGeometry, waterMaterial );
	if ( calmMaterial ) state.disposables.push( calmMaterial );
	if ( state.reflectorNode ) {

		scene.add( state.reflectorNode.target );
		state.reflectionPass = () => {

			if ( ! state.ready || ! state.reflectorNode || state.uniforms.mirrorAmount.value < 0.5 ) return;
			// 进了洞、溪水藏起来了（见 updateCaveHide）：倒影没人看，不画
			if ( state.caveHidden ) return;
			// 水面不在视锥里（转身背对水面）这一帧不画倒影（camera.js 的 isMeshInView）
			if ( ! isMeshInView( ctx.camera, state.water, { groundHeight: groundHeightAt } ) ) return;
			// 倒影分辨率：放大模式下场景按 renderScale 画，倒影跟着乘（perf.scenesA.reflectionFollowScale）；满分辨率时就是配置值
			const quality = ctx.quality;
			const follow = ctx.config.perf.scenesA.reflectionFollowScale && quality.mode === 'upscale';
			state.reflectorNode.reflector.resolutionScale = state.reflectionScale * ( follow ? quality.renderScale : 1 );
			const waterVisible = state.water.visible;
			state.water.visible = false;
			if ( state.grass ) state.grass.beginReflection();
			try {

				state.reflectorNode.reflector.updateBefore( { scene: state.scene, camera: ctx.camera, renderer: ctx.renderer, material: waterMaterial } );

			} finally {

				state.water.visible = waterVisible;
				if ( state.grass ) state.grass.endReflection();

			}

		};

	}

	// 泉眼的石头
	const springRockGeometry = buildSpringRocks( line );
	const springRockMaterial = createSpringRockMaterial( noiseTexture );
	const springRocks = new THREE.Mesh( springRockGeometry, springRockMaterial );
	springRocks.name = '泉眼的石头';
	scene.add( springRocks );
	state.disposables.push( springRockGeometry, springRockMaterial );

	await yieldToBrowser();

	// 桃树：和远景花树同一套樱花模型（backdrop.createLocationBlossoms；2026-10-02 用户："这种树全部换掉"——原来 tsl/blossom.js 的直棍树枝 +
	// 散开的星形小花）。种在开场本地坐标（树根贴开场自己的地形），换成世界坐标交给远景画；花簇格子大一点、每团花卡少一点（夹岸几百棵），
	// 颜色用桃花的粉。模型读不到退回原来的程序化桃树
	const trees = plantTrees( line );
	const worldPoint = new THREE.Vector3();
	// 桃林在溪面倒影里照原样全画（不给 reflectWater）：镜头离水只有 1 米、溪面微波把倒影的采样错开好几度，按镜头位置保守地算，
	// 挑中的桃树几乎每棵的倒影都可能落进溪面，省不下什么；按离溪中线 36 米一刀切会在 overture 20 秒的倒影里少几块（2026-10-02 自查）
	const locationTrees = await ctx.backdrop.createLocationBlossoms( trees.map( ( tree ) => {

		ctx.world.toWorld( worldPoint.set( tree.x, tree.y, tree.z ), key, worldPoint );
		return { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z, size: tree.scale * overtureConfig.blossomTreeSize, yaw: tree.yaw, tint: ( tree.template + 0.5 ) / overtureConfig.treeTemplates };

	} ), { near: content === 'hi' ? 600 : 220, colors: overtureConfig.blossomColors, cards: overtureConfig.blossomCards[ content ] || overtureConfig.blossomCards.mid, cell: overtureConfig.blossomCell, name: '开场的桃林' } );
	if ( locationTrees ) {

		state.locationTrees = locationTrees;
		state.trunks = [];

	} else {

		const random = createRandom( 512 );
		const templates = [];
		for ( let i = 0; i < overtureConfig.treeTemplates; i ++ ) templates.push( blossomTemplate( random ) );
		const barkMaterial = createBarkMaterial( { noiseTexture, shade, name: '桃树干' } );
		state.disposables.push( barkMaterial );
		const trunks = instanceTrunks( templates, trees, barkMaterial, '桃树干' );
		for ( const mesh of trunks.meshes ) scene.add( mesh );
		state.trunks = trunks.meshes;
		state.disposables.push( ...trunks.geometries );

		// 花枝卡片：近处的树每团 cardsPerCluster 张，远处少一些、卡片大一点
		const cardRatio = content === 'hi' ? 1 : ( content === 'mid' ? 0.75 : 0.55 );
		const blossom = blossomCards( trees, templates, {
			random: createRandom( 7713 ),
			perCluster: ( tree ) => overtureConfig.cardsPerCluster * ( tree.distance < 26 ? 1 : ( tree.distance < 48 ? 0.6 : 0.4 ) ) * cardRatio,
			sizeScale: ( tree ) => ( tree.distance < 26 ? 1 : 1.25 ),
		} );
		const blossomMaterial = createBlossomMaterial( {
			time: state.uniforms.time,
			windAmount: state.uniforms.windAmount,
			shadeThin,
			colors: { heart: '#c9577a', inner: '#f2a9bf', outer: '#fde6ec' },
			name: '桃花',
		} );
		const blossoms = new THREE.Mesh( blossom.geometry, blossomMaterial );
		blossoms.name = '桃花';
		blossoms.frustumCulled = false;
		scene.add( blossoms );
		state.blossoms = blossoms;
		state.disposables.push( blossom.geometry, blossomMaterial );

	}

	await yieldToBrowser();

	// 草（阶段 12 CP3 返工：三环，规格书 10.2）
	const grassConfig = overtureConfig.grass;
	state.grass = createGrassField( {
		name: '开场的草',
		rings: resolveRings( ctx.config.grassField, content, grassConfig ),
		bladeLength: grassConfig.length,
		bladeWidth: grassConfig.width,
		ground: grassGroundAt,
		field: state.field,
		palette: ctx.config.grassField.palette,
		groundColor: grassConfig.groundColor,
		dryAmount: grassConfig.dry,
		lighting: ( albedo, normal, point, toViewer, extra ) => ctx.backdrop.worldLightingThin( albedo, normal, point, toViewer, extra ),
		atmosphere: ( surface, point ) => ctx.backdrop.worldAtmosphere( surface, point ),
		wind: grassConfig.wind,
		seed: 1,
		// 倒影里内环也留三成：溪只有几米宽，两岸离船 1~5 米，倒影里的岸要有草（"芳草鲜美"）；
		// 外环两成、远环不画（perf.scenesA.overtureGrassReflection：远处的岸在倒影里只剩贴水一条，看不出草的疏密）
		reflection: { ...ctx.config.perf.scenesA.overtureGrassReflection },
	} );
	scene.add( state.grass.group );

	// 飘落的花瓣
	const petalConfig = overtureConfig.petals;
	state.petals = createPetals( {
		count: petalConfig.count[ content ] || petalConfig.count.mid,
		boxSize: petalConfig.box,
		size: [ 0.025, 0.045 ],
		fallSpeed: 0.45,
		wind: new THREE.Vector3( 0.25, 0, 0.55 ),
		colors: [ '#f7c6d4', '#fff0f4' ],
		shade: shadeThin,
		name: '飘落的花瓣',
	} );
	scene.add( state.petals.mesh );

	// 小船
	const boatGeometry = buildBoatGeometry();
	const boatMaterial = createBoatMaterial( noiseTexture );
	state.boat = new THREE.Mesh( boatGeometry, boatMaterial );
	state.boat.name = '小船';
	state.boat.frustumCulled = false;
	scene.add( state.boat );
	state.disposables.push( boatGeometry, boatMaterial );

	// 路线
	state.route = buildRoute( line );
	state.schedule = buildSchedule();
	const caveStart = ctx.world.cave.at( 0, {} );
	state.mouthLocal = ctx.world.toLocal( caveStart.position.clone().add( new THREE.Vector3( 0, caveStart.height * 0.55, 0 ) ), key, new THREE.Vector3() );
	state.uniforms.mouth.value.copy( state.mouthLocal );

	const visibility = ( ...objects ) => ( enabled ) => {

		for ( const object of objects ) object.visible = enabled;

	};
	state.uniforms.fogAmount = uniform( 1 );
	state.layers = {
		地形: visibility( terrain ),
		溪水: visibility( water ),
		泉眼的石头: visibility( springRocks ),
		桃树干: visibility( ...( state.trunks || [] ) ),
		桃花: state.locationTrees ? state.locationTrees.toggle : visibility( state.blossoms ),
		...state.grass.layers(),
		飘落花瓣: state.petals.uniforms.amount,
		小船: visibility( state.boat ),
		晨雾: state.uniforms.fogAmount,
		微波: state.uniforms.rippleAmount,
		岸的倒影: state.uniforms.bankReflection,
		平面倒影: state.uniforms.mirrorAmount,
		漂浮花瓣: state.uniforms.floatingPetals,
		地上落花: state.uniforms.groundPetals,
		风: state.uniforms.windAmount,
		崖上雾带: state.uniforms.cliffMist,
		晨光: state.uniforms.dawnGlow,
	};

	state.ready = true;
	console.log( `开场：建好了，用时 ${ ( performance.now() - started ).toFixed( 0 ) } ms；桃树 ${ trees.length } 棵（${ state.locationTrees ? "樱花模型" : "程序化" }）、草 ${ state.grass.blades } 根（三环 ${ state.grass.counts.inner } / ${ state.grass.counts.outer } / ${ state.grass.counts.far }，${ ( state.grass.vertices / 1e6 ).toFixed( 2 ) } 百万顶点）、路线 ${ state.route.length.toFixed( 0 ) } 米（船停 ${ state.route.stop.toFixed( 0 ) }、洞口 ${ state.route.cave.toFixed( 0 ) }、交接 ${ state.route.handoff.toFixed( 0 ) }）` );
	return { scene };

}

// 预编译：倒影目标上把场景和挂进来的远景再编一遍（同落日）
export async function compile() {

	if ( ! state.ready || ! state.reflectorNode ) return;
	const ctx = state.ctx;
	const reflectorObject = state.reflectorNode.reflector;
	const virtualCamera = reflectorObject.getVirtualCamera( ctx.camera );
	const target = reflectorObject.getRenderTarget( virtualCamera );
	const waterVisible = state.water.visible;
	state.water.visible = false;
	// 草按倒影里的份数（远环在倒影里不画，倒影目标上就不编它）
	if ( state.grass ) state.grass.beginReflection();
	let jobs;
	try {

		jobs = [
			ctx.pipeline.compileScene( state.scene, virtualCamera, null, target ),
			ctx.pipeline.compileScene( ctx.backdrop.getRoot(), virtualCamera, state.scene, target ),
		];

	} finally {

		state.water.visible = waterVisible;
		if ( state.grass ) state.grass.endReflection();

	}

	await Promise.all( jobs );

}

// ===================== 进出、每帧 =====================

function applyWorldSettings() {

	const ctx = state.ctx;
	const backdrop = ctx.backdrop;
	const fogConfig = ctx.config.overture.fog;
	backdrop.setSkyVisible( true );
	// 远景地形在块里压低 120 米：崖面那里远景 12.5 米一格的三角形和真地形差几十米，压得不够会从崖面里戳出来
	backdrop.setContentHole( { ...terrainRect, depth: 120 } );
	// 贴水的晨雾：雾底在水面，衰减高度 2.5 米；颜色跟着天色
	const sky = ctx.world.uniforms;
	state.fogColor = state.fogColor || new THREE.Color();
	state.fogScatter = state.fogScatter || new THREE.Color();
	state.fogColor.copy( sky.horizonColor.value ).lerp( sky.zenithColor.value, 0.25 ).multiplyScalar( sky.skyIntensity.value * fogConfig.brightness );
	state.fogScatter.copy( sky.sunHorizonColor.value ).multiplyScalar( sky.skyIntensity.value );
	backdrop.setLocationFog( {
		density: fogConfig.density,
		falloff: fogConfig.falloff,
		baseHeight: ctx.world.locations[ key ].origin[ 1 ] + 0.2,
		color: state.fogColor,
		scatterColor: state.fogScatter,
		lightDirection: tempVector.copy( sky.sunDirection.value ),
		anisotropy: 0.6,
		amount: state.uniforms.fogAmount.value,
	} );

}

export function enter() {

	if ( ! state.ready ) throw new Error( '开场：还没 init 就调了 enter' );
	const ctx = state.ctx;
	if ( state.reflectionPass ) ctx.pipeline.addPrePass( state.reflectionPass );
	for ( const label of Object.keys( state.layers ) ) ctx.debug.addLayerToggle( key, label, state.layers[ label ] );
	// 开场在南岭外面，窄处（落日的岩丘、冰槽、林间小路）全被山挡着，整组不画（原来每帧白跑约 2.4 M 三角的顶点）
	if ( ctx.backdrop && typeof ctx.backdrop.setNarrowsHidden === 'function' ) ctx.backdrop.setNarrowsHidden( 'all', true );

}

export function update( dt, time ) {

	if ( ! state.ready ) return;
	const ctx = state.ctx;
	const uniforms = state.uniforms;
	uniforms.time.value = time;
	applyWorldSettings();

	// 镜头
	const position = tempVector.set( 0, 0, 0 );
	const quaternion = tempQuaternion;
	const distance = poseAt( Math.min( time, state.duration + 3 ), position, quaternion );
	ctx.director.setExternalPose( position, quaternion, ctx.config.camera.fov );

	// 船桨：船停下来（离船）以后不再划
	if ( ctx.audio && ctx.audio.setOars ) ctx.audio.setOars( time < 46.5 );

	// 洞里的明暗适应：进洞前后眼睛慢慢适应暗处（曝光往上抬），交给花园时还抬着，出洞时花园再让它落回来
	const caveDepth = smoothJs( state.route.cave - 3, state.route.cave + 14, distance );
	// 开头从黑场淡入（规格书 5.1.1：0~6 秒黑场淡入）：曝光乘一个从 0 到 1 的系数
	const fadeIn = Math.max( 0.001, smoothJs( 0.3, 4.5, time ) );
	ctx.pipeline.setAdaptation( fadeIn * ( 1 + ( ctx.config.overture.caveAdaptation - 1 ) * caveDepth ) );

	// 小船：在船停的地方之前跟着镜头，船头朝上游；水上轻轻起伏
	const boatDistance = Math.min( distance, state.route.stop );
	const boatPosition = routePoint( boatDistance + 0.6, state.boat.position );
	const boatAhead = routePoint( boatDistance + 3, tempTarget );
	// 路线点在水面上 eyeHeight 米；船沿高出水面 boatFreeboard 米（底板也在水面以上，水不会从船里穿出来）
	boatPosition.y -= ctx.config.overture.eyeHeight - ctx.config.overture.boatFreeboard + Math.sin( time * 1.1 ) * 0.025;
	state.boat.lookAt( boatAhead.x, boatPosition.y, boatAhead.z );
	state.boat.rotateY( Math.PI );
	state.boat.rotateX( Math.sin( time * 0.9 + 1.3 ) * 0.012 );
	state.boat.rotateZ( Math.sin( time * 0.7 ) * 0.018 );

	// 草、花瓣跟着相机
	state.grass.update( time, position, ctx, ( point ) => ctx.world.toWorld( point, key, point ) );
	state.petals.uniforms.time.value = time;
	state.petals.uniforms.center.value.copy( position );
	updateCaveHide( distance );

}

// 进洞以后（perf.scenesA.caveHide）：过了洞口 caveHideDistance 米，洞口在身后、"初极狭"那段洞壁挡住了外面，开场自己的草、溪水
// 都看不见了，藏起来（三环草的顶点、溪水和它的平面倒影都省掉）；草根融合照旧（远景地面颜色不变）。往回跳到洞外时还原。
// 飘落的花瓣不藏：它跟着镜头飘，洞里也看得见（藏了洞里会少一半花瓣，截图对比出来的），它也就几千个面片
function updateCaveHide( distance ) {

	const perf = state.ctx.config.perf.scenesA;
	const hide = Boolean( perf.caveHide ) && distance > state.route.cave + perf.caveHideDistance;
	if ( hide === state.caveHidden ) return;
	const objects = [ state.grass.group, state.water ];
	if ( hide ) {

		state.caveSaved = objects.map( ( object ) => object.visible );
		for ( const object of objects ) object.visible = false;

	} else {

		objects.forEach( ( object, index ) => {

			object.visible = state.caveSaved ? state.caveSaved[ index ] : true;

		} );
		state.caveSaved = null;

	}

	state.caveHidden = hide;

}

export function exit() {

	if ( ! state.ctx ) return;
	const ctx = state.ctx;
	if ( state.reflectionPass ) ctx.pipeline.removePrePass( state.reflectionPass );
	if ( ctx.backdrop && typeof ctx.backdrop.setNarrowsHidden === 'function' ) ctx.backdrop.setNarrowsHidden( 'all', false );
	ctx.debug.removeSceneToggles( key );
	ctx.director.clearExternal();

}

function releaseResources() {

	for ( const item of state.disposables ) if ( item && typeof item.dispose === 'function' ) item.dispose();
	state.disposables = [];
	if ( state.grass ) state.grass.dispose();
	if ( state.petals ) state.petals.dispose();
	if ( state.reflectorNode ) state.reflectorNode.dispose();
	if ( state.trunks ) for ( const mesh of state.trunks ) mesh.dispose();
	if ( state.locationTrees ) state.locationTrees.dispose();
	state.locationTrees = null;
	state.grass = null;
	state.petals = null;
	state.reflectorNode = null;
	state.reflectionPass = null;
	state.trunks = null;

}

export function dispose() {

	if ( ! state.scene && state.disposables.length === 0 ) return;
	state.ready = false;
	if ( state.ctx && state.reflectionPass ) state.ctx.pipeline.removePrePass( state.reflectionPass );
	releaseResources();
	if ( state.scene ) state.scene.clear();
	state.scene = null;
	state.heights = null;
	state.field = null;
	state.route = null;
	state.caveHidden = false;
	state.caveSaved = null;
	state.layers = {};
	state.ctx = null;
	console.log( '开场：已释放' );

}

// ===================== 截图、烘焙、调试 =====================

// 局部 (x, z) 的地面高度（全景烘焙点按它放眼睛）；块外按世界地形
export function groundHeightAt( x, z ) {

	const height = groundHeight( x, z );
	if ( Number.isFinite( height ) ) return height;
	const [ worldX, worldZ ] = toWorldXZ( x, z );
	return state.ctx.world.sample( worldX, worldZ ).height - originY();

}

export function getSpawn() {

	const position = new THREE.Vector3();
	const quaternion = new THREE.Quaternion();
	poseAt( 0, position, quaternion );
	const forward = new THREE.Vector3( 0, 0, - 30 ).applyQuaternion( quaternion ).add( position );
	return { position: position.toArray(), lookAt: forward.toArray() };

}

// 引路（规格书 5.3 阶段 12）：路线上第几秒走到第几米、离起点 distance 米的点（局部坐标）。花瓣从"林尽水源"起顺着路线流进山洞
export function getGuideRoute() {

	if ( ! state.ready ) return null;
	return { distanceAt: ( time ) => state.schedule( time ), pointAt: ( distance, target ) => routePoint( distance, target ) };

}

// 路线上某个时刻的位姿（全景烘焙点、截图用）
export function getPoseAt( time ) {

	const position = new THREE.Vector3();
	const quaternion = new THREE.Quaternion();
	poseAt( time, position, quaternion );
	return { position, quaternion };

}

// 地形自查：NaN 个数、高度范围、相邻格子落差最大的地方（截图里看到破洞时用）
export function terrainStats() {

	const grid = state.heights;
	if ( ! grid ) return null;
	let nan = 0;
	let low = Infinity;
	let high = - Infinity;
	let jump = 0;
	let jumpAt = null;
	for ( let j = 0; j < grid.countZ; j ++ ) {

		for ( let i = 0; i < grid.countX; i ++ ) {

			const value = grid.data[ j * grid.countX + i ];
			if ( ! Number.isFinite( value ) ) {

				nan ++;
				continue;

			}

			low = Math.min( low, value );
			high = Math.max( high, value );
			if ( i > 0 ) {

				const step = Math.abs( value - grid.data[ j * grid.countX + i - 1 ] );
				if ( step > jump ) {

					jump = step;
					jumpAt = [ terrainRect.minX + i * terrainSpacing, terrainRect.minZ + j * terrainSpacing ];

				}

			}

		}

	}

	return { nan, low, high, jump, jumpAt };

}

export function getLayers() {

	return state.layers;

}
