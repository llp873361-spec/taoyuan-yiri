// 场景 1：清晨白银花园城堡（规格书第 10 节）。清晨薄雾、逆光：一条长长的倒影水池从脚下伸向城堡，城堡是白色大理石主体、
// 银色洋葱顶、四角细高的宣礼塔、正面大尖拱门；水池两侧成排的柏树、成片的白色和淡紫粉色的花，远处开花的树，花瓣从镜头前飘过，
// 城堡完整地倒映在水里。太阳从城堡背后东边的山口升起（逆着日出看），后期加光束。
//
// 地点局部坐标：原点是出生点（水池远端前 30 米），−z 朝城堡（方位 75°），城堡中心在 −z 约 331 米。没有素材，城堡全是程序化的：
// 台基 + 八角主体（四个大面各一座凸出的拱门框，框里尖拱龛）+ 鼓座 + 洋葱顶 + 顶尖 + 屋顶四角小亭 + 台基四角宣礼塔。
// 光照、大气、雾和远景同一套（backdrop.worldLighting / worldAtmosphere）；大理石按规格书加包裹光照和暖色透光，
// 银顶的颜色就是反射方向上的统一天空（daySkyColor），美感全靠天空渐变。
// 从开场的山洞里接过来时先走出洞的路线（见"出洞"），之后自由漫游。

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, uniform, attribute, texture, color, select,
	positionWorld, positionGeometry, normalGeometry, normalWorld, cameraPosition,
	normalize, length, dot, max, min, mix, smoothstep, pow, abs, sin, cos, atan, floor, fract, reflect, fwidth, mod, Discard, If,
} from 'three/tsl';
import { reflector } from 'three/tsl';
import { NodeUpdateType } from 'three/webgpu';
import { monotoneCurve, resampleCurve, pointOnCurve } from '../core/route.js';
import { createPetals } from '../tsl/petals.js';
import { createGrassField, buildGroundField, resolveRings, blendGround } from '../tsl/grass.js';
import { blossomTemplate, instanceTrunks, blossomCards, createBlossomMaterial, createBarkMaterial } from '../tsl/blossom.js';
import { hash33, jsFbm2D, createNoiseTextureData } from '../tsl/noise.js';
import { daySkyColor } from '../tsl/sky.js';
import { groundDetailInScene } from '../tsl/terrain.js';
import { loadModel, disposeModel } from '../core/assets.js';
import { isMeshInView, prepareMeshView } from '../core/camera.js';

export const key = 'garden';

const state = {
	ctx: null,
	scene: null,
	ready: false,
	intro: null,         // 从开场的山洞里接过来时的出洞路线（见 buildIntro）
	caveSample: {},
	disposables: [],
	layout: null,
	uniforms: null,
	layers: {},
	reflectorNode: null,
	reflectionPass: null,
	reflectionCastle: null, // 倒影里换上的 lod1 城堡 { near: [大理石, 银顶], low: [大理石, 银顶] }（perf.scenesA.reflectionLod.garden）
	flowers: null,          // 花圃（倒影里不画）
	grass: null,
	grassField: null,       // 草地图（高度、密度、法线，grass.js 的 buildGroundField）
	petals: null,
	trunks: null,
	pool: null,
};

const tempPoint = new THREE.Vector3();
const tempWorld = new THREE.Vector3();
const tempTarget = new THREE.Vector3();
const tempMatrix = new THREE.Matrix4();
const tempEuler = new THREE.Euler();
const tempQuaternion = new THREE.Quaternion();
const tempDirection = new THREE.Vector3();
const worldUp = new THREE.Vector3( 0, 1, 0 );
const degree = Math.PI / 180;

function createRandom( seed ) {

	let value = ( seed >>> 0 ) || 1;
	return function next() {

		value = ( value + 0x6D2B79F5 ) >>> 0;
		let mixed = Math.imul( value ^ ( value >>> 15 ), 1 | value );
		mixed = ( mixed + Math.imul( mixed ^ ( mixed >>> 7 ), 61 | mixed ) ) ^ mixed;
		return ( ( mixed ^ ( mixed >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

const yieldToBrowser = () => new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

function smoothJs( edge0, edge1, value ) {

	const amount = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return amount * amount * ( 3 - 2 * amount );

}

// ===================== 出洞（规格书 5.1.1 "豁然开朗"，花园前 13 秒）=====================
// 从开场交接的地方接着沿洞的中线走到内口（和开场用同一个 world.cave.at，位置、朝向、速度接得上），出洞走到崖边的平台上，
// 升起来先看晨雾里的整个秘境（朝北），再右转找到日出背光下的城堡，然后慢慢飘下去到出生点，交还步行。
// 曝光：洞里眼睛适应了暗处（开场把明暗适应抬到 caveAdaptation），出洞那一下过亮，再在 1.5 秒左右落回来；
// 调色从开场的那套慢慢过渡到花园的
function buildIntro() {

	const ctx = state.ctx;
	const world = ctx.world;
	const cave = world.cave;
	const overtureConfig = ctx.config.overture;
	const caveEye = overtureConfig.caveEyeHeight;
	const toLocal = ( worldPoint ) => world.toLocal( worldPoint, key, new THREE.Vector3() );
	const inner = cave.at( cave.length, {} );
	const exitPoint = toLocal( inner.position.clone().add( new THREE.Vector3( 0, caveEye, 0 ) ) );
	// 出洞后的路线（局部）：内口 → 洞外平台往前 7 米 → 往前往上飘到 35 米高的地方（洞口只比盆地高几米，要升起来才看得到
	// "整个秘境"）→ 右转以后一路往城堡那边飘下去 → 出生点
	const ledge = toLocal( inner.position.clone().addScaledVector( inner.tangent, 7 ).add( new THREE.Vector3( 0, ctx.config.camera.eyeHeight + 0.2, 0 ) ) );
	const overlook = toLocal( inner.position.clone().addScaledVector( inner.tangent, 45 ).add( new THREE.Vector3( 0, 36, 0 ) ) );
	const spawn = new THREE.Vector3().fromArray( getSpawn().position );
	const glideMiddle = overlook.clone().lerp( spawn, 0.5 );
	glideMiddle.y = Math.max( overlook.y - 14, spawn.y + 8 );
	const caveBefore = toLocal( cave.at( cave.length - 2, {} ).position.clone().add( new THREE.Vector3( 0, caveEye, 0 ) ) );
	const after = resampleCurve( [ caveBefore, exitPoint, ledge, overlook, glideMiddle, spawn ], 0.5 );
	// 截掉洞里那 2 米（只用来定出口的方向）
	let exitIndex = 0;
	let exitGap = Infinity;
	after.points.forEach( ( point, index ) => {

		const gap = point.distanceToSquared( exitPoint );
		if ( gap < exitGap ) {

			exitGap = gap;
			exitIndex = index;

		}

	} );
	after.points.splice( 0, exitIndex );
	after.points[ 0 ].copy( exitPoint );
	after.length = ( after.points.length - 1 ) * after.spacing;
	const nearestDistance = ( target ) => {

		let best = 0;
		let bestGap = Infinity;
		after.points.forEach( ( point, index ) => {

			const gap = point.distanceToSquared( target );
			if ( gap < bestGap ) {

				bestGap = gap;
				best = index * after.spacing;

			}

		} );
		return best;

	};
	const ledgeDistance = nearestDistance( ledge );
	const overlookDistance = nearestDistance( overlook );

	const caveRemaining = cave.length - cave.handoffDistance;
	const total = caveRemaining + after.length;
	const handoffSpeed = overtureConfig.handoffSpeed;
	const keys = [
		[ 0, 0 ],
		[ 6.5, caveRemaining ],
		[ 8.5, caveRemaining + ledgeDistance ],
		[ 13.5, caveRemaining + overlookDistance ],
		[ 15, caveRemaining + overlookDistance + 1.5 ],
		[ 28, total ],
	];
	const schedule = monotoneCurve( keys, { 0: handoffSpeed, 5: 0 } );
	// 出洞的时刻（明暗适应从这一刻往回落）
	let exitTime = 6.5;
	for ( let time = 0; time < 13; time += 0.02 ) {

		if ( schedule( time ) >= caveRemaining ) {

			exitTime = time;
			break;

		}

	}

	return { after, caveRemaining, total, schedule, exitTime, duration: 28, ledgeDistance, overlook };

}

function introPoint( distance, target ) {

	const intro = state.intro;
	const world = state.ctx.world;
	if ( distance < intro.caveRemaining ) {

		const sample = world.cave.at( world.cave.handoffDistance + distance, state.caveSample );
		tempWorld.copy( sample.position );
		tempWorld.y += state.ctx.config.overture.caveEyeHeight;
		return world.toLocal( tempWorld, key, target );

	}

	return pointOnCurve( intro.after, distance - intro.caveRemaining, target );

}

// 出洞路线上的位姿。看的方向：洞里看前方路线（和开场同一条规则：前方 max(9, 速度 × 3.2) 米，加 1.5° 抬头，交接时一样）；
// 出洞后升起来朝北看秘境，13~16 秒右转看城堡，之后看着城堡飘下去
function introPose( time, position, quaternion ) {

	const intro = state.intro;
	const distance = intro.schedule( time );
	introPoint( distance, position );
	const speed = ( intro.schedule( time + 0.05 ) - intro.schedule( time - 0.05 ) ) / 0.1;
	const ahead = introPoint( distance + Math.max( 9, speed * 3.2 ), tempTarget );
	const world = state.ctx.world;
	// 朝北看秘境：洞口往北 700 米、海拔 20 米的地方（盆地中间，湖那边）；城堡：远景替身的城堡（地标）往上 18 米
	const innerMouth = world.cave.at( world.cave.length, state.caveSample ).position;
	const north = world.toLocal( tempWorld.set( innerMouth.x + 40, 20, innerMouth.z - 700 ), key, new THREE.Vector3() );
	const castle = world.toLocal( tempWorld.fromArray( world.locations[ key ].landmark ).add( new THREE.Vector3( 0, 18, 0 ) ), key, new THREE.Vector3() );
	const northAmount = smoothJs( intro.exitTime - 1.5, intro.exitTime + 1.5, time ) * ( 1 - smoothJs( 13, 16, time ) );
	const castleAmount = smoothJs( 13, 16, time );
	ahead.lerp( north, northAmount ).lerp( castle, castleAmount );
	tempMatrix.lookAt( position, ahead, worldUp );
	quaternion.setFromRotationMatrix( tempMatrix );
	tempEuler.setFromQuaternion( quaternion, 'YXZ' );
	tempEuler.x += 1.5 * degree * ( 1 - smoothJs( 0, 3, time ) );
	quaternion.setFromEuler( tempEuler );
	return distance;

}

function updateIntro( time ) {

	const ctx = state.ctx;
	const intro = state.intro;
	const own = ctx.config.scenes.find( ( item ) => item.key === key );
	if ( time >= intro.duration ) {

		// 飘到出生点：交还步行（朝向就是现在看城堡的方向）
		introPose( intro.duration, tempPoint, tempQuaternion );
		state.intro = null;
		ctx.director.clearExternal();
		ctx.pipeline.setAdaptation( 1 );
		ctx.pipeline.setGrading( own.grading );
		startWalk( tempQuaternion );
		return;

	}

	introPose( time, tempPoint, tempQuaternion );
	ctx.director.setExternalPose( tempPoint, tempQuaternion, ctx.config.camera.fov );
	// 明暗适应：出洞前保持开场给的值，出洞后按 1.4 秒的时间常数落回 1
	const start = ctx.config.overture.caveAdaptation;
	const after = Math.max( 0, time - intro.exitTime );
	ctx.pipeline.setAdaptation( 1 + ( start - 1 ) * Math.exp( - after / 1.4 ) );
	// 调色：洞里是开场那套（曝光高），出洞前后 3 秒过渡到花园的
	const overture = ctx.config.scenes.find( ( item ) => item.key === 'overture' );
	if ( overture ) ctx.pipeline.setGradingBlend( overture.grading, own.grading, smoothJs( intro.exitTime - 1, intro.exitTime + 2.5, time ) );

}

// ===================== 布局 =====================
// 城堡中心（地标）在局部 −z 约 331 米，水池从原点前 30 米伸到台基脚下；水池中轴在城堡中心的 x 上
function buildLayout() {

	return gardenLayout( state.ctx );

}

// 花园的布局（纯函数，不用等花园初始化：远景种树时要知道正式园林在哪、地面多高）
export function gardenLayout( ctx ) {

	const world = ctx.world;
	const gardenConfig = ctx.config.garden;
	const castle = world.toLocal( new THREE.Vector3().fromArray( world.locations[ key ].landmark ), key, new THREE.Vector3() );
	castle.y = 0;
	const pool = gardenConfig.pool;
	return {
		axisX: castle.x,
		castle,
		plinthHalf: 48 * gardenConfig.castleScale,
		poolStart: pool.start,
		poolEnd: castle.z + 48,
		poolHalf: pool.halfWidth,
		waterLevel: - pool.waterDepth,
		coping: 0.8,
		pathOuter: gardenConfig.paths.outer,
		bedInner: gardenConfig.beds.inner,
		bedOuter: gardenConfig.beds.outer,
		gardenHalf: gardenConfig.gardenHalf,
		rect: gardenConfig.terrainRect,
	};

}

// 某个点在哪一块：水池、池边、步道、花圃、草地（JS 版；着色器里同样的判断在 zoneNodes）
function zoneAt( x, z ) {

	const layout = state.layout;
	const across = Math.abs( x - layout.axisX );
	const alongPool = z <= layout.poolStart && z >= layout.poolEnd;
	if ( alongPool && across < layout.poolHalf ) return 'pool';
	if ( alongPool && across < layout.poolHalf + layout.coping ) return 'coping';
	if ( across < layout.plinthHalf && Math.abs( z - layout.castle.z ) < layout.plinthHalf ) return 'plinth';
	// 出生点那块广场：±16 米（原来 ±26 米，出生点画面下三分之一全是灰色铺地，2026-10-02 审查 R21）
	if ( z > layout.poolStart && z < layout.poolStart + 12 && across < 16 ) return 'plaza';
	if ( alongPool && across < layout.pathOuter ) return 'path';
	if ( alongPool && across > layout.bedInner && across < layout.bedOuter ) return 'bed';
	return 'lawn';

}

// ===================== 地形 =====================
// 花园里是平的（局部 y = 0，草地有几厘米的起伏）；块的边上 30 米内接回远景画的高度
function terrainHeightLocal( x, z ) {

	return gardenGroundLocal( state.ctx, state.layout, x, z );

}

const groundPoint = new THREE.Vector3();

// 花园地面高度（本地坐标、纯函数）：远景种在花园块里的树按它定树根（远景在块里被挖掉，画的是花园自己的地面）
export function gardenGroundLocal( ctx, layout, x, z ) {

	const rect = layout.rect;
	const edge = Math.min( x - rect.minX, rect.maxX - x, z - rect.minZ, rect.maxZ - z );
	let height = ( jsFbm2D( x / 13 + 2.1, z / 13 - 0.7, 3 ) - 0.5 ) * 0.12;
	const across = Math.abs( x - layout.axisX );
	// 正式花园（步道、花圃、水池两边）完全平；外面的草地才有起伏，越往外起伏越大
	height *= smoothstep01( ( across - layout.bedOuter ) / 20 );
	height += Math.max( 0, across - layout.gardenHalf ) * 0.02 * ( jsFbm2D( x / 40, z / 40, 2 ) );
	if ( edge < 30 ) {

		const world = ctx.world;
		const point = world.toWorld( groundPoint.set( x, 0, z ), key, groundPoint );
		const drawn = ctx.backdrop.getTerrainHeight( point.x, point.z ) - world.locations[ key ].origin[ 1 ];
		if ( Number.isFinite( drawn ) ) height += ( drawn - height ) * smoothJs( 30, 3, edge );

	}

	return height;

}

// 草地图（阶段 12 CP3 返工；grass.js 的 buildGroundField）：只有草地长草，步道、花圃、水池、池边、广场、台基不长，
// 它们边上再让出 0.35 米（地图 0.5 米一格，双线性插值后草不会伸到石板上）
async function buildGrassField() {

	const layout = state.layout;
	const lawnAt = ( x, z ) => zoneAt( x, z ) === 'lawn';
	const margin = 0.35;
	state.grassField = await buildGroundField( {
		rect: layout.rect,
		spacing: 0.5,
		heightAt: terrainHeightLocal,
		densityAt: ( x, z, slope ) => ( lawnAt( x, z ) && lawnAt( x + margin, z ) && lawnAt( x - margin, z ) && lawnAt( x, z + margin ) && lawnAt( x, z - margin ) ? 1 : 0 ) * smoothJs( 0.2, 0.07, slope ),
		name: '花园草地图',
		yieldToBrowser,
	} );
	state.disposables.push( ...state.grassField.textures );

}

// 草落地：块里用花园自己的草地图，块外用远景的（grass.js 的 blendGround）。
// 正式花园（gardenHalf 以内）是修剪过的短草坪，往外渐渐变成长草甸
function grassGroundAt( xz ) {

	const layout = state.layout;
	const across = abs( xz.x.sub( layout.axisX ) );
	const lawnLength = state.ctx.config.garden.grass.lawnLength;
	const ground = blendGround( state.grassField, state.ctx.backdrop, xz, mix( float( lawnLength ), float( 1 ), smoothstep( layout.gardenHalf - 12, layout.gardenHalf + 12, across ) ) );
	// 出洞那几米（洞的内口往外 14 米以内）不长草：镜头贴着地面出洞，近处的草叶塞满洞口（2026-10-02 审查 R28）
	if ( state.caveMouthLocal ) ground.density = ground.density.mul( smoothstep( 8, 16, length( xz.sub( vec2( state.caveMouthLocal.x, state.caveMouthLocal.z ) ) ) ) );
	return ground;

}

function smoothstep01( value ) {

	const t = Math.min( 1, Math.max( 0, value ) );
	return t * t * ( 3 - 2 * t );

}

function toWorldXZ( x, z ) {

	const point = state.ctx.world.toWorld( tempPoint.set( x, 0, z ), key, tempPoint );
	return [ point.x, point.z ];

}

function originY() {

	return state.ctx.world.locations[ key ].origin[ 1 ];

}

async function buildTerrain() {

	const rect = state.layout.rect;
	const spacing = 2;
	const countX = Math.round( ( rect.maxX - rect.minX ) / spacing ) + 1;
	const countZ = Math.round( ( rect.maxZ - rect.minZ ) / spacing ) + 1;
	const positions = new Float32Array( countX * countZ * 3 );
	const heights = new Float32Array( countX * countZ );
	let sliceStart = performance.now();
	for ( let j = 0; j < countZ; j ++ ) {

		const z = rect.minZ + j * spacing;
		for ( let i = 0; i < countX; i ++ ) {

			const x = rect.minX + i * spacing;
			const height = terrainHeightLocal( x, z );
			const index = j * countX + i;
			heights[ index ] = height;
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
			indices.set( [ a, a + countX, a + 1, a + 1, a + countX, a + countX + 1 ], cursor );
			cursor += 6;

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	state.heights = { data: heights, countX, countZ, spacing };
	return geometry;

}

// 局部 (x, z) 的地面高度：地形网格上双线性插值；块外按远景
function groundHeight( x, z ) {

	const grid = state.heights;
	const rect = state.layout.rect;
	const gridX = ( x - rect.minX ) / grid.spacing;
	const gridZ = ( z - rect.minZ ) / grid.spacing;
	if ( gridX < 0 || gridZ < 0 || gridX > grid.countX - 1 || gridZ > grid.countZ - 1 ) {

		const [ worldX, worldZ ] = toWorldXZ( x, z );
		return state.ctx.backdrop.getTerrainHeight( worldX, worldZ ) - originY();

	}

	const i = Math.min( grid.countX - 2, Math.floor( gridX ) );
	const j = Math.min( grid.countZ - 2, Math.floor( gridZ ) );
	const fx = gridX - i;
	const fz = gridZ - j;
	const read = ( a, b ) => grid.data[ b * grid.countX + a ];
	const bottom = read( i, j ) + ( read( i + 1, j ) - read( i, j ) ) * fx;
	const top = read( i, j + 1 ) + ( read( i + 1, j + 1 ) - read( i, j + 1 ) ) * fx;
	return bottom + ( top - bottom ) * fz;

}

// 不能走进水池、不能爬上城堡的台基
function canWalk( x, z ) {

	const zone = zoneAt( x, z );
	return zone !== 'pool' && zone !== 'plinth';

}

// ===================== 光照（同远景）=====================

function shade( albedo, normal, point, { skyView = float( 1 ), wrap = 0.3 } = {} ) {

	const backdrop = state.ctx.backdrop;
	return backdrop.worldAtmosphere( backdrop.worldLighting( albedo, normal, point, { skyView, wrap } ), point );

}

function shadeThin( albedo, normal, point ) {

	const backdrop = state.ctx.backdrop;
	const front = backdrop.worldLighting( albedo, normal, point, { wrap: 0.5 } );
	const back = backdrop.worldLighting( albedo, normal.negate(), point, { wrap: 0.5 } ).mul( 0.45 );
	return backdrop.worldAtmosphere( front.add( back ), point );

}

// 天空在某个方向上的颜色（场景坐标的方向），用于银顶、大理石、水的反射；朝下的方向换成草地和大理石地面的颜色
function skyReflection( direction, { sunDisc = false } = {} ) {

	const backdrop = state.ctx.backdrop;
	const worldDirection = backdrop.sceneDirectionToWorld( direction );
	const sky = daySkyColor( vec3( worldDirection.x, max( worldDirection.y, 0.01 ), worldDirection.z ), state.ctx.world.uniforms, state.uniforms.time, { sunDisc, stars: false } );
	const groundLight = mix( state.ctx.world.uniforms.horizonColor, state.ctx.world.uniforms.zenithColor, 0.4 ).mul( state.ctx.world.uniforms.skyIntensity );
	const ground = color( '#6f8458' ).mul( groundLight ).mul( 0.6 );
	return mix( ground, sky, smoothstep( - 0.08, 0.04, worldDirection.y ) );

}

// ===================== 地形材质 =====================

function createTerrainMaterial( noiseTexture ) {

	const layout = state.layout;
	const uniforms = state.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '花园地面';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const point = positionGeometry;
		const across = abs( point.x.sub( layout.axisX ) );
		const alongPool = point.z.lessThanEqual( layout.poolStart ).and( point.z.greaterThanEqual( layout.poolEnd ) );
		// 水池（池边石头之内）不画地面
		Discard( alongPool.and( across.lessThan( layout.poolHalf + 0.2 ) ) );
		const normal = normalize( normalGeometry ).toVar();
		const patch = texture( noiseTexture, point.xz.div( 19 ) ).r;
		const fine = texture( noiseTexture, point.xz.div( 2.7 ) ).g;

		// 草地：规格书的草地色，大斑块深浅；花圃底下是深一点的绿（花的叶子），花在上面另外画
		const lawn = mix( color( '#6f8c55' ), color( '#8aa66a' ), smoothstep( 0.3, 0.7, patch ) ).mul( fine.mul( 0.2 ).add( 0.88 ) );
		const bedGround = mix( color( '#465f34' ), color( '#5b7743' ), fine );
		// 步道：浅米色石板，1.2 × 0.6 米一块，缝深一点
		const slab = vec2( point.x.sub( layout.axisX ).div( 1.2 ), point.z.div( 0.6 ) );
		const joint = max( smoothstep( 0.46, 0.5, abs( fract( slab.x ).sub( 0.5 ) ) ), smoothstep( 0.44, 0.5, abs( fract( slab.y.add( floor( slab.x ).mul( 0.5 ) ) ).sub( 0.5 ) ) ) );
		const stone = mix( color( '#e4dccd' ), color( '#d6ccbb' ), texture( noiseTexture, point.xz.div( 3.3 ) ).r ).mul( float( 1 ).sub( joint.mul( 0.25 ) ) );
		const isPath = alongPool.and( across.lessThan( layout.pathOuter ) );
		const isBed = alongPool.and( across.greaterThan( layout.bedInner ) ).and( across.lessThan( layout.bedOuter ) );
		const isPlaza = point.z.greaterThan( layout.poolStart ).and( point.z.lessThan( layout.poolStart + 12 ) ).and( across.lessThan( 16 ) );
		// 广场：嵌花地面（审查 R21：出生点画面下三分之一是一大块平整的灰色铺地）。淡粉的砂岩底上嵌白大理石的八角星
		// （两个正方形叠一起，和拱门四周墙上的八角星纹样同一个形），星外一圈细的深色描边，格角一个小菱形；1.8 米一格，从池头往外排
		const inlayTile = vec2( point.x.sub( layout.axisX ), point.z.sub( layout.poolStart ) ).div( 1.8 );
		const inlayLocal = fract( inlayTile ).sub( 0.5 );
		const starDistance = min( max( abs( inlayLocal.x ), abs( inlayLocal.y ) ), max( abs( inlayLocal.x.add( inlayLocal.y ) ), abs( inlayLocal.x.sub( inlayLocal.y ) ) ).mul( 0.7071 ) );
		const cornerLocal = fract( inlayTile.add( 0.5 ) ).sub( 0.5 );
		const cornerDistance = abs( cornerLocal.x ).add( abs( cornerLocal.y ) );
		// 按屏幕导数软边（远处线条细于一个像素时淡掉，不闪）
		const inlayBlur = max( fwidth( starDistance ), 0.004 );
		const starFill = smoothstep( inlayBlur, inlayBlur.negate(), starDistance.sub( 0.27 ) );
		const starLine = smoothstep( inlayBlur.add( 0.012 ), float( 0.012 ).sub( inlayBlur ), abs( starDistance.sub( 0.27 ) ) );
		const diamond = smoothstep( inlayBlur, inlayBlur.negate(), cornerDistance.sub( 0.11 ) );
		const sandstone = mix( color( '#e2c3b3' ), color( '#d6b09f' ), texture( noiseTexture, point.xz.div( 4.1 ) ).r );
		const inlayMarble = mix( color( '#f8f1e4' ), color( '#efe5d4' ), fine );
		const inlay = mix( mix( sandstone, inlayMarble, max( starFill, diamond ) ), color( '#b07e6e' ), starLine.mul( smoothstep( 0.05, 0.02, inlayBlur ) ).mul( 0.6 ) );
		const albedo = select( isPlaza, inlay, select( isPath, stone, select( isBed, bedGround, lawn ) ) ).toVar();
		// 地上的落花（草地、花圃上）
		const petalSpot = smoothstep( 0.74, 0.8, texture( noiseTexture, point.xz.div( 0.8 ) ).r ).mul( select( isPath.or( isPlaza ), float( 0.35 ), float( 1 ) ) ).mul( uniforms.groundPetals );
		albedo.assign( mix( albedo, color( '#fbe9ef' ), petalSpot.mul( 0.75 ) ) );
		// 石板地面带一点天空的反光（清晨潮湿）
		const toViewer = normalize( cameraPosition.sub( point ) );
		const fresnel = pow( float( 1 ).sub( max( dot( normal, toViewer ), 0 ) ), 5 );
		// 广场的反光淡一点（原来整块被天空映成冷灰蓝）
		const wet = select( isPath.or( isPlaza ), skyReflection( reflect( toViewer.negate(), normal ) ).mul( fresnel.mul( select( isPlaza, float( 0.15 ), float( 0.35 ) ) ) ), vec3( 0 ) );
		let lightingNormal = normal;
		// 近处的真贴图（和远景同一套，阶段 12 CP3）：草坪按草甸、花圃底下按林地，石板路和广场不加
		const ground = state.ctx.backdrop.getGround();
		if ( ground ) {

			const soil = select( isPath.or( isPlaza ), float( 0 ), float( 1 ) );
			const bed = select( isBed, float( 1 ), float( 0 ) );
			const detail = groundDetailInScene( ground, state.ctx.backdrop.getSceneToWorld(), {
				point, normal, weights: vec4( float( 1 ).sub( bed ), bed, 0, 0 ), near: state.ctx.backdrop.getGroundNear(), cameraPoint: cameraPosition,
			} );
			albedo.assign( albedo.mul( mix( vec3( 1 ), detail.shade, soil ) ) );
			lightingNormal = normalize( mix( normal, detail.normal, soil ) );

		}

		// 正式花园外面的草地和远景接上（原来块边上一条直线：块里亮绿，块外是远景的花海和山谷里的天光遮蔽）：
		// 天光遮蔽取远景同一张地表图；远景画花海的地方这里也撒一层白、粉、淡紫的碎点（离中轴越远越接近远景）
		const biome = state.ctx.backdrop.groundBiomeAt( point );
		const blockEdge = min( min( point.x.sub( layout.rect.minX ), float( layout.rect.maxX ).sub( point.x ) ), min( point.z.sub( layout.rect.minZ ), float( layout.rect.maxZ ).sub( point.z ) ) );
		const outerLawn = max( smoothstep( layout.gardenHalf - 10, layout.gardenHalf + 30, across ), smoothstep( 120, 30, blockEdge ) ).mul( select( isPath.or( isPlaza ).or( isBed ), float( 0 ), float( 1 ) ) );
		const flowerHue = texture( noiseTexture, point.xz.div( 1.7 ) ).g;
		const flowerTint = mix( mix( color( '#f5c6d6' ), color( '#d9c8f0' ), smoothstep( 0.35, 0.65, flowerHue ) ), color( '#fbf6f0' ), smoothstep( 0.62, 0.85, flowerHue ) );
		const flowerField = biome.b.mul( smoothstep( 0.35, 0.7, patch.mul( 0.7 ).add( fine.mul( 0.3 ) ) ) ).mul( 0.3 ).mul( outerLawn );
		albedo.assign( mix( albedo, flowerTint, flowerField ) );
		const groundSkyView = mix( float( 0.95 ), biome.a, outerLawn );
		// 草根融合（阶段 12 CP3 返工）：草的近环里草坪往草根色压，草缝里是暗的草根
		// 密度用回调传：草的半径外不取（省两张草地图的取样）
		if ( state.grass && state.grassField ) albedo.assign( state.grass.underlay( albedo, point.xz, () => grassGroundAt( point.xz ).density ) );
		const lit = state.ctx.backdrop.worldLighting( albedo, lightingNormal, point, { skyView: groundSkyView, wrap: 0.2 } );
		return state.ctx.backdrop.worldAtmosphere( lit.add( wet ), point );

	} )();
	return material;

}

// ===================== 城堡 =====================

// 尖拱（二维）：宽 width、高 height，两侧直墙到起拱线，再两段曲线在顶上收成尖
function pointedArch( width, height ) {

	const half = width / 2;
	const rise = width * 0.62;
	const spring = height - rise;
	const shape = new THREE.Shape();
	shape.moveTo( - half, 0 );
	shape.lineTo( - half, spring );
	shape.quadraticCurveTo( - half, spring + rise * 0.78, 0, height );
	shape.quadraticCurveTo( half, spring + rise * 0.78, half, spring );
	shape.lineTo( half, 0 );
	shape.lineTo( - half, 0 );
	return shape;

}

function lathe( profile, segments ) {

	return new THREE.LatheGeometry( profile.map( ( [ radius, y ] ) => new THREE.Vector2( radius, y ) ), segments );

}

// 城堡几何体：大理石一份、银顶一份。part 属性：0 大理石、2 拱龛（凹进去的暗面）、3 嵌花纹的饰带和拱门框、4 门洞
function buildCastleGeometry() {

	const marble = [];
	const silver = [];
	const matrix = new THREE.Matrix4();
	const rotation = new THREE.Matrix4();
	const add = ( list, geometry, part, x, y, z, angle = 0 ) => {

		let piece = geometry.index ? geometry.toNonIndexed() : geometry;
		if ( piece !== geometry ) geometry.dispose();
		piece.deleteAttribute( 'uv' );
		if ( ! piece.attributes.normal ) piece.computeVertexNormals();
		piece.setAttribute( 'part', new THREE.BufferAttribute( new Float32Array( piece.attributes.position.count ).fill( part ), 1 ) );
		matrix.makeTranslation( x, y, z ).multiply( rotation.makeRotationY( angle ) );
		piece.applyMatrix4( matrix );
		list.push( piece );

	};

	// 台基：96 米见方、6.5 米高，顶上一圈檐口；正面中间一段台阶；正面一排小拱龛
	add( marble, new THREE.BoxGeometry( 96, 6.5, 96 ), 0, 0, 3.25, 0 );
	add( marble, new THREE.BoxGeometry( 97.4, 0.6, 97.4 ), 3, 0, 6.8, 0 );
	for ( let k = 0; k < 6; k ++ ) add( marble, new THREE.BoxGeometry( 20, ( k + 1 ) * 1.1, 0.8 ), 0, 0, ( k + 1 ) * 0.55, 48 + ( 5.5 - k ) * 0.8 );
	for ( let k = - 5; k <= 5; k ++ ) {

		if ( Math.abs( k ) < 2 ) continue;
		const niche = new THREE.ExtrudeGeometry( pointedArch( 4.4, 4.6 ), { depth: 0.12, bevelEnabled: false } );
		add( marble, niche, 2, k * 8.2, 0.9, 48.01, 0 );

	}

	// 主体：边长 58 米、四角各切掉 9 米的八角，从台基顶（7 米）升到 40 米
	const body = new THREE.Shape();
	for ( const [ px, py ] of [ [ 20, 29 ], [ 29, 20 ], [ 29, - 20 ], [ 20, - 29 ], [ - 20, - 29 ], [ - 29, - 20 ], [ - 29, 20 ], [ - 20, 29 ] ] ) {

		if ( body.curves.length === 0 && ! body.currentPoint.x && ! body.currentPoint.y ) body.moveTo( px, py );
		else body.lineTo( px, py );

	}

	body.closePath();
	const bodyGeometry = new THREE.ExtrudeGeometry( body, { depth: 33, bevelEnabled: false } );
	bodyGeometry.rotateX( - Math.PI / 2 );
	add( marble, bodyGeometry, 0, 0, 7, 0 );
	// 屋顶的女儿墙：同样的八角，略大一圈、1.2 米高
	const parapetGeometry = new THREE.ExtrudeGeometry( body, { depth: 1.2, bevelEnabled: false } );
	parapetGeometry.rotateX( - Math.PI / 2 );
	parapetGeometry.scale( 1.015, 1, 1.015 );
	add( marble, parapetGeometry, 3, 0, 40, 0 );

	// 四个大面：凸出 2.4 米的拱门框（嵌花纹），框上一个大尖拱龛，龛底一个门洞
	for ( let k = 0; k < 4; k ++ ) {

		const angle = k * Math.PI / 2;
		const sine = Math.sin( angle );
		const cosine = Math.cos( angle );
		const at = ( distance ) => [ sine * distance, cosine * distance ];
		const [ frameX, frameZ ] = at( 29 + 1.2 );
		add( marble, new THREE.BoxGeometry( 25, 34, 2.4 ), 3, frameX, 7 + 17, frameZ, angle );
		const [ archX, archZ ] = at( 29 + 2.41 );
		add( marble, new THREE.ExtrudeGeometry( pointedArch( 15.5, 23 ), { depth: 0.2, bevelEnabled: false } ), 2, archX, 8.5, archZ, angle );
		const [ doorX, doorZ ] = at( 29 + 2.62 );
		add( marble, new THREE.ExtrudeGeometry( pointedArch( 6.2, 10 ), { depth: 0.15, bevelEnabled: false } ), 4, doorX, 8.5, doorZ, angle );
		// 斜面上两层小拱龛
		const diagonal = angle + Math.PI / 4;
		const apothem = Math.SQRT1_2 * ( 29 + 20 ) + 0.02;
		for ( const level of [ 9.5, 23 ] ) add( marble, new THREE.ExtrudeGeometry( pointedArch( 6.4, 10 ), { depth: 0.15, bevelEnabled: false } ), 2, Math.sin( diagonal ) * apothem, level, Math.cos( diagonal ) * apothem, diagonal );

	}

	// 鼓座、洋葱顶、顶尖
	add( marble, new THREE.CylinderGeometry( 14.5, 14.5, 9, 64, 1 ), 0, 0, 44.5, 0 );
	add( marble, new THREE.CylinderGeometry( 14.9, 14.9, 0.8, 64, 1 ), 3, 0, 48.9, 0 );
	const onion = [ [ 14.5, 0 ], [ 15.3, 2 ], [ 16.2, 6 ], [ 16.4, 9 ], [ 15.6, 13 ], [ 13.2, 17.5 ], [ 9.6, 22 ], [ 6.2, 26 ], [ 3.2, 29.5 ], [ 1.3, 32.2 ], [ 0.45, 34 ], [ 0, 35.2 ] ];
	add( silver, lathe( onion, 72 ), 0, 0, 49.3, 0 );
	add( silver, new THREE.CylinderGeometry( 0.22, 0.4, 9, 12 ), 0, 0, 88.5, 0 );
	add( silver, new THREE.SphereGeometry( 0.9, 16, 12 ), 0, 0, 86.4, 0 );
	add( silver, new THREE.SphereGeometry( 0.55, 16, 12 ), 0, 0, 89.6, 0 );

	// 屋顶四角的小亭：八根柱子、顶板、小洋葱顶
	const smallOnion = ( scale ) => lathe( onion.map( ( [ radius, y ] ) => [ radius * scale, y * scale ] ), 32 );
	const pavilion = ( list, x, y, z, radius, height ) => {

		add( marble, new THREE.CylinderGeometry( radius * 1.15, radius * 1.15, 0.8, 24 ), 3, x, y + 0.4, z );
		for ( let c = 0; c < 8; c ++ ) {

			const a = c / 8 * Math.PI * 2;
			add( marble, new THREE.CylinderGeometry( radius * 0.08, radius * 0.09, height, 8 ), 0, x + Math.cos( a ) * radius * 0.9, y + 0.8 + height / 2, z + Math.sin( a ) * radius * 0.9 );

		}

		add( marble, new THREE.CylinderGeometry( radius * 1.2, radius * 1.2, 0.6, 24 ), 3, x, y + 0.8 + height + 0.3, z );
		add( silver, smallOnion( radius / 14.5 ), 0, x, y + 1.7 + height, z );

	};

	for ( const [ cornerX, cornerZ ] of [ [ 19, 19 ], [ - 19, 19 ], [ 19, - 19 ], [ - 19, - 19 ] ] ) pavilion( marble, cornerX, 41.2, cornerZ, 3.6, 5 );

	// 台基四角的宣礼塔：细高、往上收，三层阳台（带栏杆），顶上小亭
	for ( const [ cornerX, cornerZ ] of [ [ 43, 43 ], [ - 43, 43 ], [ 43, - 43 ], [ - 43, - 43 ] ] ) {

		add( marble, new THREE.CylinderGeometry( 2.25, 2.9, 43, 24 ), 0, cornerX, 7 + 21.5, cornerZ );
		for ( const level of [ 19, 31, 43 ] ) {

			add( marble, new THREE.CylinderGeometry( 4.0, 3.4, 0.8, 24 ), 3, cornerX, level, cornerZ );
			add( marble, new THREE.CylinderGeometry( 4.0, 4.0, 1.0, 24, 1, true ), 3, cornerX, level + 0.9, cornerZ );

		}

		pavilion( marble, cornerX, 50, cornerZ, 2.6, 3.6 );

	}

	const merge = ( list ) => {

		let count = 0;
		for ( const piece of list ) count += piece.attributes.position.count;
		const positions = new Float32Array( count * 3 );
		const normals = new Float32Array( count * 3 );
		const parts = new Float32Array( count );
		let offset = 0;
		for ( const piece of list ) {

			positions.set( piece.attributes.position.array, offset * 3 );
			normals.set( piece.attributes.normal.array, offset * 3 );
			parts.set( piece.attributes.part.array, offset );
			offset += piece.attributes.position.count;
			piece.dispose();

		}

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		geometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
		geometry.setAttribute( 'part', new THREE.BufferAttribute( parts, 1 ) );
		geometry.computeBoundingSphere();
		return geometry;

	};

	return { marble: merge( marble ), silver: merge( silver ) };

}

// 大理石：白里带一点暖，灰蓝色的细脉（规格书的 1 − |sin(x·f + fbm·6)|^0.2）；包裹光照 + 背光时暖色透光 + 一点天空反光；
// 饰带和拱门框上是八角星的嵌花（θ 按 2π/8 折叠，规格书 10.2），拱龛暗、门洞深
// fromModel：城堡是 Taj mahal 模型（scripts/blender/taj-castle.py）。模型带烘好的 AO（顶点色 r）：凹进去的拱门、檐下、塔脚
// 暗一些、往冷里染（拱门内部偏冷，规格书 10.2）；部件号 part 5 是台基（偏暖）。程序化兜底的城堡没有 AO，按原来的做法
function createMarbleMaterial( noiseTexture, fromModel = false ) {

	const uniforms = state.uniforms;
	const castle = state.layout.castle;
	const sky = state.ctx.world.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '大理石';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		// 光照、视线、大气按场景坐标（城堡网格平移、放大过）；细脉、嵌花、石板缝按城堡自己的坐标（几何体坐标）
		const point = positionWorld;
		const local = positionGeometry;
		const part = attribute( 'part', 'float' );
		const normal = normalize( normalWorld ).toVar();
		const toViewer = normalize( cameraPosition.sub( point ) );

		// 细脉：沿一个斜方向的正弦，被两层噪声扭弯
		const warp = texture( noiseTexture, local.xz.add( local.yy.mul( 0.7 ) ).div( 23 ) ).r.mul( 0.65 ).add( texture( noiseTexture, local.zy.div( 9 ) ).g.mul( 0.35 ) );
		const veinLine = float( 1 ).sub( pow( abs( sin( local.x.mul( 0.21 ).add( local.y.mul( 0.13 ) ).add( local.z.mul( 0.17 ) ).add( warp.mul( 6 ) ) ) ), 0.2 ) );
		const veins = veinLine.mul( uniforms.marbleVeins );
		const albedo = mix( color( '#e8e2d8' ), color( '#9ea7b6' ), veins.mul( 0.4 ) ).toVar();

		// 石板缝：墙面上 2.4 × 1.2 米一块，错缝砌；缝细，远处淡掉（不然会闪）
		const wallCoordinate = select( abs( normal.x ).greaterThan( abs( normal.z ) ), vec2( local.z, local.y ), vec2( local.x, local.y ) );
		const blockCoordinate = vec2( wallCoordinate.x.div( 2.4 ).add( floor( wallCoordinate.y.div( 1.2 ) ).mul( 0.5 ) ), wallCoordinate.y.div( 1.2 ) );
		const seamWidth = max( fwidth( blockCoordinate.y ).mul( 0.8 ), 0.01 );
		const seam = max( float( 1 ).sub( smoothstep( seamWidth, seamWidth.mul( 2 ), abs( fract( blockCoordinate.x ).sub( 0.5 ) ).sub( 0.5 ).abs() ) ), float( 1 ).sub( smoothstep( seamWidth, seamWidth.mul( 2 ), abs( fract( blockCoordinate.y ).sub( 0.5 ) ).sub( 0.5 ).abs() ) ) );
		const seamFade = float( 1 ).sub( smoothstep( 0.02, 0.08, fwidth( blockCoordinate.y ) ) ).mul( select( abs( normal.y ).lessThan( 0.5 ), float( 1 ), float( 0 ) ) );
		albedo.mulAssign( float( 1 ).sub( seam.mul( seamFade ).mul( 0.18 ) ) );

		// 八角星嵌花：饰带和拱门框（part 3）上，按法线的主方向取墙面上的二维坐标，1.6 米一格
		const inlay = part.greaterThan( 2.5 ).and( part.lessThan( 3.5 ) );
		const faceCoordinate = select( abs( normal.x ).greaterThan( abs( normal.z ) ), vec2( local.z, local.y ), vec2( local.x, local.y ) ).div( 1.6 );
		const cellPoint = fract( faceCoordinate ).sub( 0.5 );
		const radius = length( cellPoint );
		const angle = atan( cellPoint.y, cellPoint.x );
		const folded = mod( angle, Math.PI * 2 / 8 ).sub( Math.PI / 8 );
		// 八角星的边：r·cos(折叠后的角) 接近一个常数的地方是一圈八边形，两层叠出星形
		const star = min( abs( radius.mul( cos( folded ) ).sub( 0.3 ) ), abs( radius.mul( cos( folded.sub( Math.PI / 8 ) ) ).sub( 0.24 ) ) );
		const lattice = min( abs( cellPoint.x ), abs( cellPoint.y ) );
		const lineWidth = max( fwidth( faceCoordinate.x ).mul( 1.2 ), 0.012 );
		const inlayLine = float( 1 ).sub( smoothstep( lineWidth, lineWidth.mul( 2.2 ), min( star, lattice.add( 0.03 ) ) ) ).mul( uniforms.inlayAmount );
		albedo.assign( select( inlay, mix( albedo, color( '#b9c2cf' ), inlayLine.mul( 0.7 ) ), albedo ) );
		// 拱龛：暗一档、冷一点（凹进去的地方天光少）；门洞：深，里面有一点暖光
		albedo.assign( select( part.greaterThan( 1.5 ).and( part.lessThan( 2.5 ) ), albedo.mul( vec3( 0.7, 0.72, 0.78 ) ), albedo ) );
		// 门洞是 4（模型的台基是 5，不是门）
		const door = part.greaterThan( 3.5 ).and( part.lessThan( 4.5 ) );
		albedo.assign( select( door, color( '#2b2623' ), albedo ) );
		// 台基（part 5）的 AO 减半：台基外墙一排排浅拱龛烘出来整面偏暗，背光时成了一堵棕墙
		const occlusion = fromModel ? mix( attribute( 'color', 'vec4' ).r, float( 1 ), select( part.greaterThan( 4.5 ), float( 0.55 ), float( 0 ) ) ) : float( 1 );
		if ( fromModel ) {

			// 台基偏暖；上暖下冷的绘本渐变（顶上被晨光染暖、脚下带一点天的灰蓝）；凹处偏冷偏暗
			albedo.assign( select( part.greaterThan( 4.5 ), albedo.mul( vec3( 1.02, 0.99, 0.95 ) ), albedo ) );
			albedo.mulAssign( mix( vec3( 0.95, 0.97, 1.02 ), vec3( 1.02, 1.0, 0.97 ), smoothstep( 4, 60, local.y ) ) );
			albedo.assign( mix( albedo.mul( vec3( 0.74, 0.8, 0.93 ) ), albedo, smoothstep( 0.25, 0.9, occlusion ) ) );

		}

		// 光照：包裹光照（同雪的做法，大理石的温润感）+ 天空反光（光滑，菲涅尔）+ 背光透出来的暖色（太阳在城堡背后）
		// 天光按方向分：清晨朝太阳那边的天是暖亮的（sunHorizon），背着太阳的是地影的灰蓝（earthShadow），头顶是天顶色；
		// 朝西的正面（对着水池）吃的是灰蓝的那半边天，暗而冷，朝南北的侧面一半一半，城堡有了体积感。再加世界的直射光（太阳出山以后）
		const normalSky = state.ctx.backdrop.sceneDirectionToWorld( normal );
		const sunSideFlat = normalize( vec3( sky.sunDirection.x, 0, sky.sunDirection.z ).add( vec3( 1e-4, 0, 0 ) ) );
		const towardSun = smoothstep( - 0.7, 0.9, dot( normalSky, sunSideFlat ) );
		const sideSky = mix( sky.earthShadowColor, sky.sunHorizonColor.mul( 1.25 ), towardSun );
		const up = max( normalSky.y, 0 );
		const skyLight = mix( sideSky, sky.zenithColor.mul( 1.1 ), up ).mul( sky.skyIntensity ).mul( float( 1 ).sub( max( normalSky.y.negate(), 0 ).mul( 0.6 ) ) ).mul( 0.95 );
		const direct = state.ctx.backdrop.worldLighting( albedo, normal, point, { skyView: float( 0 ), wrap: 0.4 } );
		// AO 只压天光（直射光有地形阴影管）；凹处也不是死黑，留四成
		const lit = albedo.mul( skyLight ).mul( occlusion.mul( 0.6 ).add( 0.4 ) ).add( direct.mul( occlusion.mul( 0.35 ).add( 0.65 ) ) ).toVar();
		const fresnel = float( 0.03 ).add( pow( float( 1 ).sub( max( dot( normal, toViewer ), 0 ) ), 5 ).mul( 0.3 ) );
		const glossy = skyReflection( reflect( toViewer.negate(), normal ) ).mul( fresnel ).mul( select( door, float( 0 ), float( 1 ) ) );
		const viewWorld = state.ctx.backdrop.sceneDirectionToWorld( toViewer.negate() );
		// 背光透出来的暖色只在掠射的边上（轮廓一圈亮边），正对着的墙面不加
		const edge = pow( float( 1 ).sub( max( dot( normal, toViewer ), 0 ) ), 2 );
		const backlight = pow( max( dot( viewWorld, sky.sunDirection ), 0 ), 5 ).mul( edge ).mul( 0.35 ).mul( uniforms.marbleGlow );
		lit.addAssign( sky.sunLightColor.add( sky.glowColor.mul( sky.glowAmount.mul( sky.skyIntensity ) ) ).mul( color( '#ffd8b8' ) ).mul( backlight ) );
		lit.addAssign( select( door, color( '#ffcf9e' ).mul( sky.skyIntensity.mul( 0.08 ) ), vec3( 0 ) ) );
		return state.ctx.backdrop.worldAtmosphere( lit.add( glossy ), point );

	} )();
	return material;

}

// 银顶：金属，颜色就是反射方向上的天空（带太阳圆盘，太阳升到山口上面时顶上一点亮光），粗糙度 0.2 左右用往天空平均色混一点代替
function createSilverMaterial( fromModel = false ) {

	const sky = state.ctx.world.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '银顶';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const point = positionWorld;
		const normal = normalize( normalWorld );
		const toViewer = normalize( cameraPosition.sub( point ) );
		const reflected = reflect( toViewer.negate(), normal );
		const mirror = skyReflection( reflected, { sunDisc: true } );
		const average = mix( sky.horizonColor, sky.zenithColor, 0.5 ).mul( sky.skyIntensity );
		const facing = max( dot( normal, toViewer ), 0 );
		// 金属的菲涅尔：正对时是本色（银 0.95），掠射时接近白
		const tint = mix( color( '#dfe6ef' ), color( '#ffffff' ), pow( float( 1 ).sub( facing ), 5 ) );
		// 模型带 AO：凉亭小穹顶的根部、塔顶凉亭里面暗一些
		const occlusion = fromModel ? attribute( 'color', 'vec4' ).r.mul( 0.55 ).add( 0.45 ) : float( 1 );
		const surface = mix( mirror, average, 0.22 ).mul( tint ).mul( state.uniforms.silverAmount ).add( state.ctx.backdrop.worldLighting( color( '#9aa3b0' ), normal, point, { wrap: 0.3 } ).mul( float( 1 ).sub( state.uniforms.silverAmount ) ) ).mul( occlusion );
		return state.ctx.backdrop.worldAtmosphere( surface, point );

	} )();
	return material;

}

// ===================== 城堡模型（阶段 12 CP3 返工）=====================
// Taj mahal（Gokul.Saravanappriyan，CC BY 4.0）：hi 档用近处那一级（约 25 万三角），其余档用中档（约 6 万）。
// 模型里两个网格：大理石（部件号 _part：0 主体、1 台基、2 宣礼塔）、银顶。没读到返回 null，用程序化的城堡兜底
async function loadTajCastle( content ) {

	const id = content === 'hi' ? 'taj-castle' : 'taj-castle-lod1';
	const model = await loadModel( 'models', id );
	if ( ! model ) {

		console.warn( `花园：城堡模型 ${ id } 没读到，用程序化的城堡兜底` );
		return null;

	}

	model.updateMatrixWorld( true );
	let marble = null;
	let silver = null;
	model.traverse( ( child ) => {

		if ( ! child.isMesh ) return;
		// 模型是 meshopt 量化过的（KHR_mesh_quantization：位置、法线、顶点色是归一化的整数，反量化的缩放在节点矩阵里），
		// 直接 applyMatrix4 会被夹回 ±1（整座城堡缩成 2 米的盒子）：先全部转成 32 位浮点再变换
		const geometry = new THREE.BufferGeometry();
		for ( const [ name, source ] of Object.entries( child.geometry.attributes ) ) {

			const values = new Float32Array( source.count * source.itemSize );
			for ( let i = 0; i < source.count; i ++ ) for ( let k = 0; k < source.itemSize; k ++ ) values[ i * source.itemSize + k ] = source.getComponent( i, k );
			geometry.setAttribute( name, new THREE.BufferAttribute( values, source.itemSize ) );

		}

		if ( child.geometry.index ) geometry.setIndex( new THREE.BufferAttribute( new Uint32Array( child.geometry.index.array ), 1 ) );
		geometry.applyMatrix4( child.matrixWorld );
		if ( ! geometry.getAttribute( 'color' ) ) {

			console.warn( `花园：城堡模型 ${ id } 的网格「${ child.name }」没有 AO 顶点色，按 1 算` );
			geometry.setAttribute( 'color', new THREE.BufferAttribute( new Float32Array( geometry.attributes.position.count * 4 ).fill( 1 ), 4 ) );

		}

		// 部件号：模型里 1 台基 → 着色器的 5（偏暖），主体、宣礼塔 → 0（着色器里 2~4 是程序化城堡的拱龛、嵌花、门洞）
		const source = geometry.getAttribute( '_part' );
		const part = new Float32Array( geometry.attributes.position.count );
		if ( source ) for ( let i = 0; i < part.length; i ++ ) part[ i ] = Math.round( source.getX( i ) ) === 1 ? 5 : 0;
		geometry.setAttribute( 'part', new THREE.BufferAttribute( part, 1 ) );
		if ( /银/.test( child.material && child.material.name || '' ) ) silver = geometry;
		else marble = geometry;

	} );
	disposeModel( model );
	if ( ! marble || ! silver ) {

		console.warn( `花园：城堡模型 ${ id } 里没有分开的大理石和银顶，用程序化的城堡兜底` );
		if ( marble ) marble.dispose();
		if ( silver ) silver.dispose();
		return null;

	}

	marble.computeBoundingBox();
	const size = marble.boundingBox.getSize( new THREE.Vector3() );
	console.log( `花园：城堡模型 ${ id }，台基 ${ size.x.toFixed( 0 ) } × ${ size.z.toFixed( 0 ) } 米，${ ( ( marble.index ? marble.index.count : marble.attributes.position.count ) / 3 + ( silver.index ? silver.index.count : silver.attributes.position.count ) / 3 ).toFixed( 0 ) } 三角` );
	return { marble, silver };

}

// ===================== 水池 =====================

function buildPoolGeometry() {

	const layout = state.layout;
	const length = layout.poolStart - layout.poolEnd;
	const water = new THREE.PlaneGeometry( layout.poolHalf * 2 + 0.4, length + 0.4, 8, Math.round( length / 4 ) );
	water.rotateX( - Math.PI / 2 );
	water.translate( layout.axisX, layout.waterLevel, ( layout.poolStart + layout.poolEnd ) / 2 );
	// 池边：一圈白大理石的压顶，高出地面 0.15 米、宽 0.8 米，内壁一直下到水面下
	const copingParts = [];
	const height = 0.15 - layout.waterLevel + 0.6;
	const centerY = 0.15 - height / 2;
	const middleZ = ( layout.poolStart + layout.poolEnd ) / 2;
	for ( const side of [ - 1, 1 ] ) {

		const box = new THREE.BoxGeometry( layout.coping, height, length + layout.coping * 2 );
		box.translate( layout.axisX + side * ( layout.poolHalf + layout.coping / 2 ), centerY, middleZ );
		copingParts.push( box );

	}

	for ( const end of [ layout.poolStart, layout.poolEnd ] ) {

		const box = new THREE.BoxGeometry( layout.poolHalf * 2, height, layout.coping );
		box.translate( layout.axisX, centerY, end + ( end === layout.poolStart ? layout.coping / 2 : - layout.coping / 2 ) );
		copingParts.push( box );

	}

	return { water, copingParts };

}

function createWaterMaterial( noiseTexture, useReflector ) {

	const uniforms = state.uniforms;
	const layout = state.layout;
	let mirror = null;
	if ( useReflector ) {

		mirror = reflector( { resolutionScale: state.reflectionScale, bounces: false } );
		// 同落日、开场：倒影改成后期管线每帧画主场景之前在最外层画一次
		mirror.reflector.updateBeforeType = NodeUpdateType.NONE;
		mirror.target.rotation.x = - Math.PI / 2;
		mirror.target.position.y = layout.waterLevel;
		state.reflectorNode = mirror;

	}

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = useReflector ? '水池（平面倒影）' : '水池';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const point = positionGeometry;
		const skipHidden = state.ctx.config.perf.scenesA.skipHiddenShading;
		// 分支前后都要用的量先落成变量（TSL 按第一次用到的位置生成代码，不落地的话会生成进 If 里面，If 外读到的是 0）
		const toViewer = normalize( cameraPosition.sub( point ) ).toVar();
		// 很轻的微波（无风的清晨）：两层噪声梯度慢慢漂；像素比波纹大时淡掉，远处是镜面
		const footprint = max( length( fwidth( point ) ), 0.001 );
		const drift = vec2( uniforms.time.mul( 0.021 ), uniforms.time.mul( - 0.013 ) );
		const coarse = texture( noiseTexture, point.xz.div( 7 ).add( drift ) ).ba.sub( 0.5 ).mul( float( 1 ).sub( smoothstep( 0.3, 1.5, footprint ) ) );
		const fine = texture( noiseTexture, point.xz.div( 1.9 ).sub( drift.mul( 2 ) ) ).ba.sub( 0.5 ).mul( float( 1 ).sub( smoothstep( 0.05, 0.25, footprint ) ) );
		const gradient = coarse.mul( 0.035 ).add( fine.mul( 0.018 ) ).mul( uniforms.rippleAmount ).toVar();
		const normal = normalize( vec3( gradient.x.negate(), 1, gradient.y.negate() ) ).toVar();
		const reflected = reflect( toViewer.negate(), normal ).toVar();
		const reflection = vec3( 0 ).toVar();
		// If 的回调不能有返回值（TSL 会当成 return 语句），写成块
		const skyPart = () => {

			reflection.assign( skyReflection( reflected, { sunDisc: true } ) );

		};
		// 平面倒影开着（mirrorAmount = 1）时天空色乘 0 被盖掉，整段不算（perf.scenesA.skipHiddenShading；条件只看 uniform，整帧一致）
		if ( mirror && skipHidden ) If( uniforms.mirrorAmount.lessThan( 0.999 ), skyPart );
		else skyPart();
		if ( mirror ) {

			const mirrored = mirror.sample( mirror.uvNode.add( vec2( gradient.x, gradient.y ).mul( 0.35 ) ) ).rgb;
			reflection.assign( mix( reflection, mirrored, uniforms.mirrorAmount ) );

		}

		// 菲涅尔（水 F0 = 0.02），倒影整体再提一点（浅池底是深色石头，看到的几乎全是倒影）
		const facing = max( dot( normal, toViewer ), 0.02 );
		const fresnel = float( 0.02 ).add( pow( float( 1 ).sub( facing ), 5 ).mul( 0.98 ) );
		const body = shade( color( '#1f3a3d' ), vec3( 0, 1, 0 ), point, { skyView: float( 0.8 ) } ).mul( 0.4 );
		const surface = mix( body, reflection, fresnel.mul( 0.45 ).add( 0.5 ) ).toVar();
		// 漂着的花瓣：零零星星
		const cell = floor( point.xz.div( 0.45 ) );
		const local = fract( point.xz.div( 0.45 ) ).sub( 0.5 );
		const random = hash33( vec3( cell, 9 ) );
		const petal = float( 1 ).sub( smoothstep( 0.7, 1, length( local.sub( random.xy.sub( 0.5 ).mul( 0.5 ) ).div( vec2( 0.16, 0.1 ) ) ) ) ).mul( select( random.z.lessThan( 0.05 ), float( 1 ), float( 0 ) ) ).mul( uniforms.floatingPetals ).toVar();
		// 没花瓣的像素（95% 以上）不算花瓣的光照（mix 系数是 0，算了也被盖掉）；光照里只有 .level(0) 的采样，放进分支没问题
		const petalPart = () => {

			surface.assign( mix( surface, shadeThin( color( '#fbeaf0' ), vec3( 0, 1, 0 ), point ), petal ) );

		};
		if ( skipHidden ) If( petal.greaterThan( 0 ), petalPart );
		else petalPart();
		return state.ctx.backdrop.worldAtmosphere( surface, point );

	} )();
	return material;

}

// ===================== 柏树 =====================

// 一棵柏树：细高的火焰形（转一圈的轮廓 + 噪声鼓包），14 段 × 24 层
function cypressGeometry( random, height, radius ) {

	const around = 14;
	const rows = 24;
	const positions = [];
	const shades = [];
	const indices = [];
	const seed = random() * 50;
	for ( let row = 0; row <= rows; row ++ ) {

		const along = row / rows;
		// 柏树的剪影：意大利柏的叶子一直长到地面，底下是一圈圆鼓鼓的根部叶丛（六成粗、往上 15% 里长到全粗），往上是柱形，最后三成收成尖。
		// 原来底下 3.5% 是细树干、再往上 7% 才长满，远看两头尖、悬在地上（2026-10-02 自查）
		const base = Math.min( 1, along / 0.15 );
		const profile = ( 0.62 + 0.38 * base * base * ( 3 - 2 * base ) ) * Math.pow( Math.max( 0, 1 - Math.pow( along, 2.4 ) ), 0.75 );
		for ( let k = 0; k <= around; k ++ ) {

			const angle = k / around * Math.PI * 2;
			const lump = 0.78 + 0.44 * jsFbm2D( Math.cos( angle ) * 2.1 + seed, along * 11 + Math.sin( angle ) * 2.1, 3 );
			const r = radius * profile * lump;
			// 底圈埋进地面 0.3 米（草地有几厘米的起伏，不能露缝）
			positions.push( Math.cos( angle ) * r, along * height - 0.3, Math.sin( angle ) * r );
			shades.push( 0.55 + 0.45 * along * lump );

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
	geometry.setAttribute( 'foliageShade', new THREE.Float32BufferAttribute( shades, 1 ) );
	geometry.setIndex( indices );
	geometry.computeVertexNormals();
	return geometry;

}

function buildCypressRows( random ) {

	const layout = state.layout;
	const gardenConfig = state.ctx.config.garden;
	const parts = [];
	for ( let z = layout.poolStart - 4; z > layout.poolEnd + 3; z -= gardenConfig.cypressSpacing ) {

		for ( const side of [ - 1, 1 ] ) {

			// 越往城堡越矮（近处 12.5~15.5 米，到池尾七成）：远处的柏树不把四座宣礼塔挡住（审查 R22），透视上池子也显得更长
			const towardCastle = ( layout.poolStart - 4 - z ) / Math.max( 1, layout.poolStart - layout.poolEnd );
			const geometry = cypressGeometry( random, ( 12.5 + random() * 3 ) * ( 1 - 0.3 * towardCastle ), 1.15 + random() * 0.2 );
			geometry.translate( layout.axisX + side * gardenConfig.cypressOffset, groundHeight( layout.axisX + side * gardenConfig.cypressOffset, z ), z );
			parts.push( geometry );

		}

	}

	let vertexCount = 0;
	let indexCount = 0;
	for ( const part of parts ) {

		vertexCount += part.attributes.position.count;
		indexCount += part.index.count;

	}

	const positions = new Float32Array( vertexCount * 3 );
	const normals = new Float32Array( vertexCount * 3 );
	const shades = new Float32Array( vertexCount );
	const indices = new Uint32Array( indexCount );
	let vertexOffset = 0;
	let indexOffset = 0;
	for ( const part of parts ) {

		positions.set( part.attributes.position.array, vertexOffset * 3 );
		normals.set( part.attributes.normal.array, vertexOffset * 3 );
		shades.set( part.attributes.foliageShade.array, vertexOffset );
		for ( let i = 0; i < part.index.count; i ++ ) indices[ indexOffset + i ] = part.index.array[ i ] + vertexOffset;
		vertexOffset += part.attributes.position.count;
		indexOffset += part.index.count;
		part.dispose();

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'foliageShade', new THREE.BufferAttribute( shades, 1 ) );
	geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );
	geometry.computeBoundingSphere();
	return geometry;

}

function createCypressMaterial( noiseTexture ) {

	const sky = state.ctx.world.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '柏树';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const point = positionGeometry;
		const normal = normalize( normalGeometry ).toVar();
		// 叶簇：法线按噪声梯度抖一抖，一团一团的；颜色深绿，往上、往外亮一点
		const clump = texture( noiseTexture, vec2( atan( normal.z, normal.x ).mul( 1.3 ), point.y.div( 1.1 ) ) );
		// 再叠一层细的叶簇（约 0.35 米一簇）：原来只有大团，近处一整面光滑的绿像纸板（审查 R25）
		const sprig = texture( noiseTexture, vec2( atan( normal.z, normal.x ).mul( 4.2 ), point.y.div( 0.35 ) ) );
		normal.assign( normalize( normal.add( vec3( clump.b.sub( 0.5 ), clump.a.sub( 0.5 ), clump.b.sub( clump.a ) ).mul( 0.9 ) ).add( vec3( sprig.b.sub( 0.5 ), sprig.a.sub( 0.5 ), sprig.a.sub( sprig.b ) ).mul( 0.6 ) ) ) );
		const shadeValue = attribute( 'foliageShade', 'float' );
		const albedo = mix( color( '#1d3220' ), color( '#3b5f35' ), clump.r.mul( 0.5 ).add( shadeValue.mul( 0.5 ) ) ).mul( shadeValue.mul( 0.5 ).add( 0.6 ) )
			.mul( sprig.r.mul( 0.5 ).add( 0.75 ) );
		// 天光多给一点（skyView 不低于 0.55）：清晨逆光时近处柏树原来几乎是纯黑的剪影（2026-10-02 审查 R25）
		const lit = state.ctx.backdrop.worldLighting( albedo, normal, point, { skyView: max( shadeValue, 0.55 ), wrap: 0.5 } );
		// 逆光时边缘透一点绿光
		const toViewer = normalize( cameraPosition.sub( point ) );
		const rim = pow( float( 1 ).sub( max( dot( normal, toViewer ), 0 ) ), 3 ).mul( pow( max( dot( state.ctx.backdrop.sceneDirectionToWorld( toViewer.negate() ), sky.sunDirection ), 0 ), 3 ) );
		// 叶子透光：整棵树朝太阳那半边都透一点黄绿（不只是边缘），逆光的柏树是发亮的一圈、里面透绿
		const throughLeaves = pow( max( dot( state.ctx.backdrop.sceneDirectionToWorld( toViewer.negate() ), sky.sunDirection ), 0 ), 2 ).mul( shadeValue.mul( 0.5 ).add( 0.3 ) );
		return state.ctx.backdrop.worldAtmosphere( lit.add( sky.sunLightColor.add( sky.glowColor.mul( sky.glowAmount.mul( sky.skyIntensity ) ) ).mul( color( '#86c272' ) ).mul( rim.mul( 0.25 ).add( throughLeaves.mul( 0.07 ) ) ) ), point );

	} )();
	return material;

}

// ===================== 花圃 =====================
// 每朵花一张斜着朝上的小卡片（0.12~0.22 米），片元里画五瓣的花和黄色花心；白、粉、淡紫、米黄四种，规格书的配色
function buildFlowerGeometry( random, density ) {

	const layout = state.layout;
	const positions = [];
	const flowerData = [];
	const normals = [];
	const indices = [];
	const corners = [ [ - 0.5, - 0.5 ], [ 0.5, - 0.5 ], [ 0.5, 0.5 ], [ - 0.5, 0.5 ] ];
	const normal = new THREE.Vector3();
	const tangent = new THREE.Vector3();
	const bitangent = new THREE.Vector3();
	let seed = 0;
	const width = layout.bedOuter - layout.bedInner;
	const length = layout.poolStart - layout.poolEnd;
	const count = Math.round( width * length * 2 * density );
	for ( let n = 0; n < count; n ++ ) {

		const side = n % 2 === 0 ? - 1 : 1;
		const across = layout.bedInner + 0.3 + random() * ( width - 0.6 );
		const z = layout.poolEnd + 1 + random() * ( length - 2 );
		const x = layout.axisX + side * across;
		const leaf = random() < 0.42;
		const y = groundHeight( x, z ) + ( leaf ? 0.08 + random() * 0.22 : 0.25 + random() * 0.4 );
		normal.set( ( random() - 0.5 ) * ( leaf ? 2.2 : 1.2 ), 1, ( random() - 0.5 ) * ( leaf ? 2.2 : 1.2 ) ).normalize();
		tangent.set( 1, 0, 0 ).cross( normal ).normalize();
		bitangent.crossVectors( normal, tangent );
		const size = leaf ? 0.22 + random() * 0.14 : 0.16 + random() * 0.12;
		const first = positions.length / 3;
		// kind：0~1 是花的颜色，2 是叶丛
		const kind = leaf ? 2 : random();
		for ( const [ cornerX, cornerY ] of corners ) {

			positions.push( x + ( tangent.x * cornerX + bitangent.x * cornerY ) * size, y + ( tangent.y * cornerX + bitangent.y * cornerY ) * size, z + ( tangent.z * cornerX + bitangent.z * cornerY ) * size );
			normals.push( normal.x, normal.y, normal.z );
			flowerData.push( cornerX + 0.5, cornerY + 0.5, seed, kind );

		}

		indices.push( first, first + 1, first + 2, first, first + 2, first + 3 );
		seed ++;

	}

	// 草坪上的花海（审查 R21："周围很多花和树"，原来花只有池边一窄条）：池边花圃外面到 95 米、出生点前后 60 米到台基，
	// 按两层噪声成团（约三成的草坪），一团里一种主色；每平方米约 density × 0.16 朵（hi 约 2.6 朵），不长在步道、广场、台基上
	const lawnCount = Math.round( 2 * 72 * ( length + 60 ) * 0.3 * density * 0.16 );
	for ( let n = 0; n < lawnCount; n ++ ) {

		let x = 0;
		let z = 0;
		let found = false;
		let patchTone = 0;
		for ( let attempt = 0; attempt < 6 && ! found; attempt ++ ) {

			const side = random() < 0.5 ? - 1 : 1;
			const across = layout.bedOuter + 2 + random() * ( 95 - layout.bedOuter - 2 );
			z = layout.poolEnd + random() * ( length + 60 );
			x = layout.axisX + side * across;
			const patch = jsFbm2D( x / 32 + 4.2, z / 32 - 1.7, 3 ) * 0.7 + jsFbm2D( x / 9 - 3.1, z / 9 + 6.6, 2 ) * 0.3;
			patchTone = jsFbm2D( x / 60 - 8.8, z / 60 + 2.4, 2 );
			found = patch > 0.55 && zoneAt( x, z ) === 'lawn';

		}

		if ( ! found ) continue;
		const leaf = random() < 0.3;
		const y = groundHeight( x, z ) + ( leaf ? 0.08 + random() * 0.18 : 0.2 + random() * 0.35 );
		normal.set( ( random() - 0.5 ) * ( leaf ? 2.2 : 1.2 ), 1, ( random() - 0.5 ) * ( leaf ? 2.2 : 1.2 ) ).normalize();
		tangent.set( 1, 0, 0 ).cross( normal ).normalize();
		bitangent.crossVectors( normal, tangent );
		const size = leaf ? 0.2 + random() * 0.12 : 0.14 + random() * 0.12;
		const first = positions.length / 3;
		// 一团一种主色（花色 0~1 按大块噪声取，团里再抖一点）
		const kind = leaf ? 2 : Math.min( 0.999, Math.max( 0, patchTone * 1.4 - 0.2 + ( random() - 0.5 ) * 0.15 ) );
		for ( const [ cornerX, cornerY ] of corners ) {

			positions.push( x + ( tangent.x * cornerX + bitangent.x * cornerY ) * size, y + ( tangent.y * cornerX + bitangent.y * cornerY ) * size, z + ( tangent.z * cornerX + bitangent.z * cornerY ) * size );
			normals.push( normal.x, normal.y, normal.z );
			flowerData.push( cornerX + 0.5, cornerY + 0.5, seed, kind );

		}

		indices.push( first, first + 1, first + 2, first, first + 2, first + 3 );
		seed ++;

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'flowerData', new THREE.Float32BufferAttribute( flowerData, 4 ) );
	geometry.setIndex( positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute( indices, 1 ) : new THREE.Uint16BufferAttribute( indices, 1 ) );
	geometry.computeBoundingSphere();
	return { geometry, flowers: seed };

}

function createFlowerMaterial() {

	const uniforms = state.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '花圃的花';
	material.side = THREE.DoubleSide;
	material.fog = false;
	material.lights = false;
	const data = attribute( 'flowerData', 'vec4' );
	const random = hash33( vec3( data.z, 5, 17 ) );
	// 风：花头轻轻点头
	const sway = vec3( sin( uniforms.time.mul( 1.6 ).add( random.x.mul( 6.28 ) ).add( positionGeometry.z.mul( 0.2 ) ) ), 0, cos( uniforms.time.mul( 1.3 ).add( random.y.mul( 6.28 ) ) ) ).mul( 0.018 ).mul( uniforms.windAmount );
	material.positionNode = positionGeometry.add( sway );
	material.colorNode = Fn( () => {

		const point = data.xy.sub( 0.5 );
		const radius = length( point );
		const angle = atan( point.y, point.x ).add( random.z.mul( 6.28 ) );
		const kind = data.w;
		const isLeaf = kind.greaterThan( 1.5 );
		// 叶丛：三片尖叶（cos(3θ) 的花瓣形，尖一点）；花：五瓣或六瓣
		const petals = select( isLeaf, float( 3 ), select( random.x.greaterThan( 0.5 ), float( 5 ), float( 6 ) ) );
		const edge = select( isLeaf, pow( max( cos( angle.mul( petals ) ), 0 ), 2 ).mul( 0.42 ).add( 0.05 ), cos( angle.mul( petals ) ).mul( 0.18 ).add( 0.4 ) );
		Discard( radius.greaterThan( edge ) );
		const tone = select( kind.lessThan( 0.4 ), color( '#ffffff' ), select( kind.lessThan( 0.65 ), color( '#f5c6d6' ), select( kind.lessThan( 0.85 ), color( '#d9c8f0' ), color( '#fbf0c9' ) ) ) );
		const heart = smoothstep( 0.05, 0.11, radius );
		const flowerAlbedo = mix( color( '#e8c14a' ), tone.mul( mix( float( 0.85 ), float( 1 ), radius.div( edge ) ) ), heart );
		const leafAlbedo = mix( color( '#2f4a26' ), color( '#4f6e38' ), random.y ).mul( mix( float( 0.7 ), float( 1 ), radius.div( edge ) ) );
		const albedo = select( isLeaf, leafAlbedo, flowerAlbedo );
		const normal = normalize( normalGeometry );
		const toViewer = normalize( cameraPosition.sub( positionWorld ) );
		const facing = select( dot( normal, toViewer ).greaterThan( 0 ), normal, normal.negate() );
		return vec4( shadeThin( albedo, facing, positionWorld ), 1 );

	} )();
	return material;

}

// ===================== 开花的树 =====================
// 草地外圈和城堡两边：白里透粉的花树（比桃树高大），离水池中轴 30 米以外
function plantBlossomTrees( random ) {

	const layout = state.layout;
	const gardenConfig = state.ctx.config.garden;
	const trees = [];
	let attempts = 0;
	while ( trees.length < gardenConfig.blossomTrees && attempts < 6000 ) {

		attempts ++;
		const side = random() < 0.5 ? - 1 : 1;
		const across = 30 + random() * 85;
		const z = layout.rect.minZ + 40 + random() * ( layout.rect.maxZ - layout.rect.minZ - 70 );
		const x = layout.axisX + side * across;
		if ( zoneAt( x, z ) !== 'lawn' ) continue;
		if ( Math.abs( x - layout.axisX ) < layout.plinthHalf + 8 && Math.abs( z - layout.castle.z ) < layout.plinthHalf + 8 ) continue;
		// 成片：和已经种的树至少隔 7 米
		if ( trees.some( ( tree ) => Math.hypot( tree.x - x, tree.z - z ) < 7 ) ) continue;
		trees.push( { x, z, y: groundHeight( x, z ) - 0.05, yaw: random() * Math.PI * 2, scale: 0.85 + random() * 0.4, template: Math.floor( random() * 4 ), distance: across } );

	}

	return trees;

}

// ===================== init =====================

export async function init( ctx ) {

	if ( state.scene ) {

		console.warn( '花园场景：init 被重复调用，先释放旧的再重建' );
		dispose();

	}

	if ( ! ctx.backdrop || ! ctx.world || ! ctx.backdrop.getRoot() ) throw new Error( '花园场景：要先建好秘境（ctx.world、ctx.backdrop）' );
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
	const gardenConfig = ctx.config.garden;
	const content = ctx.quality.content;
	state.layout = buildLayout();
	state.reflectionScale = gardenConfig.reflectionScale[ content ] || 0;

	const scene = new THREE.Scene();
	scene.name = '花园';
	scene.background = new THREE.Color( 0x000000 );
	state.scene = scene;

	state.uniforms = {
		time: uniform( 0 ),
		rippleAmount: uniform( 1 ),
		mirrorAmount: uniform( 1 ),
		floatingPetals: uniform( 1 ),
		groundPetals: uniform( 1 ),
		windAmount: uniform( 1 ),
		marbleVeins: uniform( 1 ),
		inlayAmount: uniform( 1 ),
		marbleGlow: uniform( 1 ),
		silverAmount: uniform( 1 ),
		fogAmount: uniform( 1 ),
		shaftAmount: uniform( 1 ),
	};

	const noiseData = createNoiseTextureData( 256, 32, 41 );
	const noiseTexture = new THREE.DataTexture( noiseData.data, noiseData.size, noiseData.size, THREE.RGBAFormat, THREE.UnsignedByteType );
	noiseTexture.wrapS = THREE.RepeatWrapping;
	noiseTexture.wrapT = THREE.RepeatWrapping;
	noiseTexture.magFilter = THREE.LinearFilter;
	noiseTexture.minFilter = THREE.LinearMipmapLinearFilter;
	noiseTexture.generateMipmaps = true;
	noiseTexture.needsUpdate = true;
	state.disposables.push( noiseTexture );

	// 地面
	const terrainGeometry = await buildTerrain();
	const terrainMaterial = createTerrainMaterial( noiseTexture );
	const terrain = new THREE.Mesh( terrainGeometry, terrainMaterial );
	terrain.name = '花园地面';
	scene.add( terrain );
	state.disposables.push( terrainGeometry, terrainMaterial );

	// 城堡
	// 城堡：先读 Taj mahal 模型（已经是米、原点在台基底面中心），读不到用程序化的（按 castleScale 放大）
	const tajModel = await loadTajCastle( content );
	const castleGeometry = tajModel || buildCastleGeometry();
	const marbleMaterial = createMarbleMaterial( noiseTexture, Boolean( tajModel ) );
	const silverMaterial = createSilverMaterial( Boolean( tajModel ) );
	const castleScale = tajModel ? 1 : gardenConfig.castleScale;
	const castleMarble = new THREE.Mesh( castleGeometry.marble, marbleMaterial );
	castleMarble.name = '城堡';
	castleMarble.position.set( state.layout.castle.x, groundHeight( state.layout.castle.x, state.layout.castle.z ), state.layout.castle.z );
	castleMarble.scale.setScalar( castleScale );
	castleMarble.frustumCulled = false;
	const castleSilver = new THREE.Mesh( castleGeometry.silver, silverMaterial );
	castleSilver.name = '银顶';
	castleSilver.position.copy( castleMarble.position );
	castleSilver.scale.setScalar( castleScale );
	castleSilver.frustumCulled = false;
	scene.add( castleMarble, castleSilver );
	state.disposables.push( castleGeometry.marble, castleGeometry.silver, marbleMaterial, silverMaterial );
	// 倒影里的城堡（perf.scenesA.reflectionLod.garden）：hi 档主画面是近处级 25 万三角，倒影只有 960×600 还被微波打散，换中档那一级（约 6 万，
	// 规格书 10.2）。同一个材质，平时藏着，倒影那一遍和城堡换着显示；别的档主画面本来就是这一级，不用另读
	state.reflectionCastle = null;
	if ( content === 'hi' && tajModel && state.reflectionScale > 0 && ctx.config.perf.scenesA.reflectionLod.garden ) {

		const reflectionModel = await loadTajCastle( 'mid' );
		if ( reflectionModel ) {

			const marbleLow = new THREE.Mesh( reflectionModel.marble, marbleMaterial );
			const silverLow = new THREE.Mesh( reflectionModel.silver, silverMaterial );
			marbleLow.name = '城堡·倒影';
			silverLow.name = '银顶·倒影';
			for ( const mesh of [ marbleLow, silverLow ] ) {

				mesh.position.copy( castleMarble.position );
				mesh.frustumCulled = false;
				mesh.visible = false;

			}

			scene.add( marbleLow, silverLow );
			state.disposables.push( reflectionModel.marble, reflectionModel.silver );
			state.reflectionCastle = { near: [ castleMarble, castleSilver ], low: [ marbleLow, silverLow ] };

		}

	}

	await yieldToBrowser();

	// 水池：水面（hi、mid 有平面倒影，规格书 10.3 的验收就是城堡完整清晰的倒影）+ 池边压顶（大理石）
	const poolGeometry = buildPoolGeometry();
	const waterMaterial = createWaterMaterial( noiseTexture, state.reflectionScale > 0 );
	const water = new THREE.Mesh( poolGeometry.water, waterMaterial );
	water.name = '倒影水池';
	scene.add( water );
	state.water = water;
	// 倒影跳过用的水面分块（camera.js 的 prepareMeshView），在这里取好点，不放进第一帧
	prepareMeshView( water );
	const copingMeshes = poolGeometry.copingParts.map( ( geometry ) => {

		const parts = new Float32Array( geometry.attributes.position.count ).fill( 0 );
		geometry.setAttribute( 'part', new THREE.BufferAttribute( parts, 1 ) );
		// 城堡用模型时大理石材质要读 AO 顶点色：池边没有 AO，刷一层 1（和城堡共用一个材质，不多编一份着色器）
		if ( tajModel ) geometry.setAttribute( 'color', new THREE.BufferAttribute( new Float32Array( geometry.attributes.position.count * 4 ).fill( 1 ), 4 ) );
		const mesh = new THREE.Mesh( geometry, marbleMaterial );
		mesh.name = '池边';
		scene.add( mesh );
		state.disposables.push( geometry );
		return mesh;

	} );
	state.disposables.push( poolGeometry.water, waterMaterial );
	if ( state.reflectorNode ) {

		scene.add( state.reflectorNode.target );
		state.reflectionPass = () => {

			if ( ! state.ready || ! state.reflectorNode || state.uniforms.mirrorAmount.value < 0.5 ) return;
			// 水面不在视锥里（转身背对水面）这一帧不画倒影（camera.js 的 isMeshInView）
			if ( ! isMeshInView( ctx.camera, state.water ) ) return;
			state.reflectorNode.reflector.resolutionScale = reflectionResolution();
			const restore = enterReflection();
			// 花树在倒影里只画倒影可能落进池面的那些（见下面 reflectWater）
			if ( state.locationTrees ) state.locationTrees.setReflection( true );
			try {

				state.reflectorNode.reflector.updateBefore( { scene: state.scene, camera: ctx.camera, renderer: ctx.renderer, material: waterMaterial } );

			} finally {

				restore();
				if ( state.locationTrees ) state.locationTrees.setReflection( false );

			}

		};

	}

	// 柏树
	const random = createRandom( 6650 );
	const cypressGeometryMerged = buildCypressRows( random );
	const cypressMaterial = createCypressMaterial( noiseTexture );
	const cypress = new THREE.Mesh( cypressGeometryMerged, cypressMaterial );
	cypress.name = '柏树';
	scene.add( cypress );
	state.disposables.push( cypressGeometryMerged, cypressMaterial );

	// 花圃
	const flowerDensity = gardenConfig.flowerDensity[ content ] || gardenConfig.flowerDensity.mid;
	const flowerBuild = buildFlowerGeometry( createRandom( 8122 ), flowerDensity );
	const flowerMaterial = createFlowerMaterial();
	const flowers = new THREE.Mesh( flowerBuild.geometry, flowerMaterial );
	flowers.name = '花圃';
	flowers.frustumCulled = false;
	scene.add( flowers );
	state.flowers = flowers;
	state.disposables.push( flowerBuild.geometry, flowerMaterial );
	await yieldToBrowser();

	// 开花的树：和远景花树同一套樱花模型（backdrop.createLocationBlossoms；2026-10-02 用户："这种树全部换掉"——
	// 原来 tsl/blossom.js 的直棍树枝 + 散开的星形小花）。种在花园本地坐标，换成世界坐标交给远景画；模型读不到退回原来的程序化花树
	const trees = plantBlossomTrees( createRandom( 3031 ) );
	const worldPoint = new THREE.Vector3();
	// 池面的倒影（有平面倒影时）：倒影平面的世界高度、池面的范围（沿中轴一段胶囊，半径是水面网格的半宽），哪些花树的倒影会落进池面由 trees.js
	// 按镜头位置算（站在池边往对岸看，对岸一百米外的花树树冠也会倒映在池里，不能按离中轴多远一刀切）；slack 是微波把倒影采样错开的最大角度
	const pool = state.layout;
	const reflectWater = state.reflectorNode ? { level: ctx.world.toWorld( worldPoint.set( 0, pool.waterLevel, 0 ), key, worldPoint ).y, capsules: [], slack: ctx.config.perf.trees.reflectSlack.garden * Math.PI / 180 } : null;
	if ( reflectWater ) {

		const start = ctx.world.toWorld( worldPoint.set( pool.axisX, 0, pool.poolStart ), key, new THREE.Vector3() );
		const end = ctx.world.toWorld( worldPoint.set( pool.axisX, 0, pool.poolEnd ), key, new THREE.Vector3() );
		reflectWater.capsules.push( { ax: start.x, az: start.z, bx: end.x, bz: end.z, radius: pool.poolHalf + 0.2 } );

	}

	const locationTrees = await ctx.backdrop.createLocationBlossoms( trees.map( ( tree ) => {

		ctx.world.toWorld( worldPoint.set( tree.x, tree.y, tree.z ), key, worldPoint );
		// 樱花模型约 9 米高，花园的花树 5~7 米
		return { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z, size: tree.scale * gardenConfig.blossomTreeSize, yaw: tree.yaw, tint: ( tree.template + 0.5 ) / 4 };

	} ), { near: content === 'hi' ? 700 : 420, colors: gardenConfig.blossomColors, name: '花园的花树', reflectWater } );
	let blossoms = null;
	if ( locationTrees ) {

		state.locationTrees = locationTrees;
		state.trunks = [];

	} else {

		const templateRandom = createRandom( 9091 );
		const templates = [];
		for ( let i = 0; i < 4; i ++ ) templates.push( blossomTemplate( templateRandom, { height: 1.45 } ) );
		const barkMaterial = createBarkMaterial( { noiseTexture, shade, name: '花树干' } );
		const trunks = instanceTrunks( templates, trees, barkMaterial, '花树干' );
		for ( const mesh of trunks.meshes ) scene.add( mesh );
		state.trunks = trunks.meshes;
		state.disposables.push( barkMaterial, ...trunks.geometries );
		const cardRatio = content === 'hi' ? 1 : ( content === 'mid' ? 0.75 : 0.55 );
		const blossom = blossomCards( trees, templates, {
			random: createRandom( 4413 ),
			perCluster: ( tree ) => gardenConfig.cardsPerCluster * cardRatio * ( tree.distance < 60 ? 1 : 0.7 ),
			sizeScale: ( tree ) => ( tree.distance < 60 ? 1.1 : 1.3 ),
		} );
		const blossomMaterial = createBlossomMaterial( {
			time: state.uniforms.time,
			windAmount: state.uniforms.windAmount,
			shadeThin,
			colors: { heart: '#e59ab1', inner: '#fadbe5', outer: '#ffffff' },
			name: '花树的花',
		} );
		blossoms = new THREE.Mesh( blossom.geometry, blossomMaterial );
		blossoms.name = '花树的花';
		blossoms.frustumCulled = false;
		scene.add( blossoms );
		state.disposables.push( blossom.geometry, blossomMaterial );

	}

	// 草（阶段 12 CP3 返工：三环，规格书 10.2）：只长在草地上（步道、花圃、水池、广场、台基没有）
	await buildGrassField();
	// 洞的内口（局部）：草图要用，buildIntro 在后面才建
	state.caveMouthLocal = ctx.world.toLocal( ctx.world.cave.at( ctx.world.cave.length, {} ).position.clone(), key, new THREE.Vector3() );
	const grassConfig = gardenConfig.grass;
	state.grass = createGrassField( {
		name: '花园的草',
		rings: resolveRings( ctx.config.grassField, content, grassConfig ),
		bladeLength: grassConfig.length,
		bladeWidth: grassConfig.width,
		ground: grassGroundAt,
		field: state.grassField,
		palette: ctx.config.grassField.palette,
		groundColor: grassConfig.groundColor,
		dryAmount: grassConfig.dry,
		lighting: ( albedo, normal, point, toViewer, extra ) => ctx.backdrop.worldLightingThin( albedo, normal, point, toViewer, extra ),
		atmosphere: ( surface, point ) => ctx.backdrop.worldAtmosphere( surface, point ),
		wind: grassConfig.wind,
		seed: 2,
	} );
	scene.add( state.grass.group );

	// 飘落的花瓣
	const petalConfig = gardenConfig.petals;
	state.petals = createPetals( {
		count: petalConfig.count[ content ] || petalConfig.count.mid,
		boxSize: petalConfig.box,
		size: [ 0.025, 0.045 ],
		fallSpeed: 0.4,
		wind: new THREE.Vector3( 0.3, 0, - 0.5 ),
		colors: [ '#fbe1ea', '#ffffff' ],
		shade: shadeThin,
		name: '花园的花瓣',
	} );
	scene.add( state.petals.mesh );

	const visibility = ( ...objects ) => ( enabled ) => {

		for ( const object of objects ) object.visible = enabled;

	};
	state.layers = {
		地面: visibility( terrain ),
		城堡: visibility( castleMarble, ...copingMeshes ),
		银顶: visibility( castleSilver ),
		水池: visibility( water ),
		平面倒影: state.uniforms.mirrorAmount,
		微波: state.uniforms.rippleAmount,
		大理石纹: state.uniforms.marbleVeins,
		几何纹样: state.uniforms.inlayAmount,
		暖色透光: state.uniforms.marbleGlow,
		银顶反射: state.uniforms.silverAmount,
		柏树: visibility( cypress ),
		花圃: visibility( flowers ),
		花树: state.locationTrees ? state.locationTrees.toggle : visibility( blossoms, ...state.trunks ),
		...state.grass.layers(),
		飘落花瓣: state.petals.uniforms.amount,
		漂浮花瓣: state.uniforms.floatingPetals,
		地上落花: state.uniforms.groundPetals,
		风: state.uniforms.windAmount,
		晨雾: state.uniforms.fogAmount,
		光束: state.uniforms.shaftAmount,
	};

	state.ready = true;
	console.log( `花园：建好了，用时 ${ ( performance.now() - started ).toFixed( 0 ) } ms；花圃 ${ flowerBuild.flowers } 朵、花树 ${ trees.length } 棵（${ state.locationTrees ? "樱花模型" : "程序化" }）、草 ${ state.grass.blades } 根（三环 ${ state.grass.counts.inner } / ${ state.grass.counts.outer } / ${ state.grass.counts.far }）、倒影 ${ state.reflectionScale > 0 ? state.reflectionScale + ' 倍分辨率' : '关' }` );
	return { scene };

}

// 预编译：倒影目标上把场景和挂进来的远景再编一遍（同落日、开场）
export async function compile() {

	if ( ! state.ready || ! state.reflectorNode ) return;
	const ctx = state.ctx;
	const reflectorObject = state.reflectorNode.reflector;
	const virtualCamera = reflectorObject.getVirtualCamera( ctx.camera );
	const target = reflectorObject.getRenderTarget( virtualCamera );
	// 和倒影那一遍画的东西一样（城堡换 lod1、草和花圃不画）：倒影目标上只编真会画的
	const restore = enterReflection();
	let jobs;
	try {

		jobs = [
			ctx.pipeline.compileScene( state.scene, virtualCamera, null, target ),
			ctx.pipeline.compileScene( ctx.backdrop.getRoot(), virtualCamera, state.scene, target ),
		];

	} finally {

		restore();

	}

	await Promise.all( jobs );

}

// 倒影那一遍要换掉的东西：水面自己不画；perf.scenesA.reflectionCull 开着时草和花圃不画（眼睛离水约 2 米，花圃、草坪的反射交点
// 横距 = 物体横距 × 2 / (2.35 + 物高)，都落在池子外面，池边压顶的上沿也挡着），关着时草照旧画三成；城堡换 lod1。返回还原函数
function enterReflection() {

	const cull = state.ctx.config.perf.scenesA.reflectionCull;
	const saved = [];
	const hide = ( object ) => {

		saved.push( [ object, object.visible ] );
		object.visible = false;

	};
	hide( state.water );
	if ( cull ) {

		if ( state.grass ) hide( state.grass.group );
		if ( state.flowers ) hide( state.flowers );

	} else if ( state.grass ) {

		state.grass.beginReflection();

	}

	if ( state.reflectionCastle ) {

		state.reflectionCastle.near.forEach( ( near, index ) => {

			const low = state.reflectionCastle.low[ index ];
			saved.push( [ low, low.visible ] );
			// 跟着城堡的调试开关
			low.visible = near.visible;
			hide( near );

		} );

	}

	return () => {

		for ( const [ object, visible ] of saved ) object.visible = visible;
		if ( ! cull && state.grass ) state.grass.endReflection();

	};

}

// 倒影的分辨率倍数（相对画布）：放大模式下场景按 renderScale 画，倒影跟着乘（perf.scenesA.reflectionFollowScale）；满分辨率时就是配置值
function reflectionResolution() {

	const quality = state.ctx.quality;
	const follow = state.ctx.config.perf.scenesA.reflectionFollowScale && quality.mode === 'upscale';
	return state.reflectionScale * ( follow ? quality.renderScale : 1 );

}

// ===================== 进出、每帧 =====================

function applyWorldSettings() {

	const ctx = state.ctx;
	const backdrop = ctx.backdrop;
	const fogConfig = ctx.config.garden.fog;
	const sky = ctx.world.uniforms;
	backdrop.setSkyVisible( true );
	backdrop.setContentHole( { ...state.layout.rect, depth: 40 } );
	// 晨雾：贴着花园的地面（衰减高度 14 米），颜色是天边的暖色，朝太阳那边前向散射亮一些
	state.fogColor = state.fogColor || new THREE.Color();
	state.fogScatter = state.fogScatter || new THREE.Color();
	state.fogColor.copy( sky.horizonColor.value ).lerp( sky.sunHorizonColor.value, 0.35 ).multiplyScalar( sky.skyIntensity.value * fogConfig.brightness );
	state.fogScatter.copy( sky.glowColor.value ).multiplyScalar( sky.glowAmount.value * sky.skyIntensity.value );
	backdrop.setLocationFog( {
		density: fogConfig.density,
		falloff: fogConfig.falloff,
		baseHeight: originY(),
		color: state.fogColor,
		scatterColor: state.fogScatter,
		lightDirection: tempDirection.copy( sky.sunDirection.value ),
		anisotropy: 0.65,
		amount: state.uniforms.fogAmount.value,
	} );
	// 光束：太阳方向换到场景坐标；太阳还在山后面时光束从山口那一圈亮天里出来
	const sunLocal = ctx.world.directionToLocal( tempDirection.copy( sky.sunDirection.value ), key, tempDirection );
	ctx.pipeline.setLightShafts( { amount: ctx.config.garden.shafts.amount * state.uniforms.shaftAmount.value, direction: sunLocal, color: state.shaftColor || ( state.shaftColor = new THREE.Color( '#ffe2c4' ) ) } );

}

// 交还步行：quaternion 给了就按它的朝向（出洞飘下来时看着城堡），没给就按出生点
function startWalk( quaternion ) {

	const spawn = getSpawn();
	let lookAt = spawn.lookAt;
	if ( quaternion ) {

		const forward = new THREE.Vector3( 0, 0, - 50 ).applyQuaternion( quaternion );
		lookAt = [ spawn.position[ 0 ] + forward.x, spawn.position[ 1 ] + forward.y, spawn.position[ 2 ] + forward.z ];

	}

	const walk = state.ctx.config.garden.walk;
	state.ctx.director.setWalk( {
		position: spawn.position,
		lookAt,
		groundHeight,
		canWalk,
		bounds: { minX: walk.minX, maxX: walk.maxX, minZ: state.layout.castle.z + state.layout.plinthHalf + 2, maxZ: walk.maxZ },
	} );

}

// options.arrival === 'cave'：从开场的山洞里接过来，先走出洞的那段路线
export function enter( options = {} ) {

	if ( ! state.ready ) throw new Error( '花园场景：还没 init 就调了 enter' );
	const ctx = state.ctx;
	if ( state.reflectionPass ) ctx.pipeline.addPrePass( state.reflectionPass );
	for ( const label of Object.keys( state.layers ) ) ctx.debug.addLayerToggle( key, label, state.layers[ label ] );
	if ( options.arrival === 'cave' ) {

		state.intro = buildIntro();
		updateIntro( 0 );
		update( 0, 0 );
		return;

	}

	state.intro = null;
	startWalk( null );
	update( 0, 0 );

}

export function update( dt, time ) {

	if ( ! state.ready ) return;
	const ctx = state.ctx;
	state.uniforms.time.value = time;
	applyWorldSettings();
	if ( state.intro ) updateIntro( time );
	ctx.camera.updateMatrixWorld();
	tempPoint.setFromMatrixPosition( ctx.camera.matrixWorld );
	state.grass.update( time, tempPoint, ctx, ( point ) => ctx.world.toWorld( point, key, point ) );
	state.petals.uniforms.time.value = time;
	state.petals.uniforms.center.value.copy( tempPoint );

}

export function exit() {

	if ( ! state.ctx ) return;
	const ctx = state.ctx;
	state.intro = null;
	if ( state.reflectionPass ) ctx.pipeline.removePrePass( state.reflectionPass );
	ctx.pipeline.setLightShafts( null );
	ctx.debug.removeSceneToggles( key );
	ctx.director.clearExternal();
	ctx.director.clearWalk();

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
	state.reflectionCastle = null;
	state.flowers = null;
	state.trunks = null;

}

export function dispose() {

	if ( ! state.scene && state.disposables.length === 0 ) return;
	state.ready = false;
	if ( state.ctx && state.reflectionPass ) state.ctx.pipeline.removePrePass( state.reflectionPass );
	releaseResources();
	// 远景根节点由时间线在释放之前摘走，这里只清自己的东西
	if ( state.scene ) state.scene.clear();
	state.scene = null;
	state.heights = null;
	state.layout = null;
	state.grassField = null;
	state.layers = {};
	state.ctx = null;
	console.log( '花园场景：已释放' );

}

// ===================== 截图、烘焙、调试 =====================

// 本地 (x, z) 的地面高度（全景烘焙点按它放眼睛）
export function groundHeightAt( x, z ) {

	return groundHeight( x, z );

}

// 引路（规格书 5.3 阶段 12）：出洞路线上第几秒走到第几米、离起点 distance 米的点（局部坐标）、出洞的时刻；没在出洞时返回 null
export function getGuideRoute() {

	const intro = state.intro;
	if ( ! intro ) return null;
	return {
		distanceAt: ( time ) => intro.schedule( Math.min( time, intro.duration ) ),
		pointAt: ( distance, target ) => introPoint( Math.min( distance, intro.total ), target ),
		exitTime: intro.exitTime,
	};

}

// 出生点：水池远端前 8 米，朝城堡（局部 −z）看，略微抬头看城堡顶
export function getSpawn() {

	const spawnZ = state.layout ? state.layout.poolStart + 8 : 0;
	const eye = groundHeight( 0, spawnZ ) + state.ctx.config.camera.eyeHeight;
	return { position: [ 0, eye, spawnZ ], lookAt: [ state.layout ? state.layout.axisX : 0, eye + 4, - 200 ] };

}

export function getShotViews() {

	const layout = state.layout;
	const eye = state.ctx.config.camera.eyeHeight;
	return [
		{ name: '出生点', ...getSpawn() },
		{ name: '池边', position: [ layout.axisX + 9.5, eye, - 150 ], lookAt: [ layout.axisX, 20, layout.castle.z ] },
		{ name: '城堡前', position: [ layout.axisX - 16, eye, layout.poolEnd + 45 ], lookAt: [ layout.axisX, 40, layout.castle.z ] },
		{ name: '花圃', position: [ layout.axisX - 23, eye, - 90 ], lookAt: [ layout.axisX + 6, 1, - 130 ] },
	];

}

export function getLayers() {

	return state.layers;

}
