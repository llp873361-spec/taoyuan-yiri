// 场景 3：入夜哥特城堡（规格书第 11 节）。入夜的深蓝天，一座尖塔林立的城堡立在湖对岸的崖上，几百扇窗从下往上、一扇扇亮起暖黄的灯；
// 湖面倒映着城堡和灯光，倒影被波纹拉成竖向的光柱；夜雾，月亮从城堡背后的东山口升起，勾出尖塔的轮廓；湖边飘着萤火虫，偶尔几只蝙蝠绕过塔尖。
//
// 地点局部坐标：原点是湖西岸的机位（地面比湖面高半米），−z 朝湖对岸崖上的城堡（方位 72°，约 600 米外）。镜头不靠近城堡（规格书 11.2），
// 可以在岸边走动。城堡全程序化，布局和远景的替身一样（从落日、星月夜、雪原看过来是同一座），细节多一些：
// 主厅（陡的两坡屋顶、屋脊尖塔、扶壁）、八座圆塔（尖锥顶、檐口、塔身小尖塔）、城墙垛口、小礼拜堂（玫瑰窗、细尖塔）。
// 光照、大气、雾和远景同一套；湖面 hi、mid 有平面倒影（主要倒城堡剪影和天），窗灯的倒影另外按"光柱"画（所有档位都有）。

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, uniform, attribute, texture, color, select,
	positionWorld, positionGeometry, normalGeometry, normalWorld, cameraPosition, cameraViewMatrix, cameraProjectionMatrix,
	normalize, length, dot, max, min, mix, smoothstep, step, pow, abs, sin, cos, floor, fract, reflect, fwidth, exp, Discard, If,
} from 'three/tsl';
import { reflector } from 'three/tsl';
import { NodeUpdateType } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createGrassField, buildGroundField, resolveRings, blendGround } from '../tsl/grass.js';
import { jsFbm2D, createNoiseTextureData } from '../tsl/noise.js';
import { daySkyColor } from '../tsl/sky.js';
import { groundDetailInScene } from '../tsl/terrain.js';
import { loadModel, disposeModel } from '../core/assets.js';
import { isMeshInView, prepareMeshView } from '../core/camera.js';

export const key = 'gothic';

const state = {
	ctx: null,
	scene: null,
	ready: false,
	disposables: [],
	layout: null,
	uniforms: null,
	layers: {},
	reflectorNode: null,
	reflectionPass: null,
	heights: null,
	grass: null,
	grassField: null,       // 草地图（高度、密度、法线，grass.js 的 buildGroundField）
	bats: [],
	enteredAt: 0,
	castleHeight: 0,        // 城堡在场景里的高度（米），蝙蝠绕着塔尖飞要用
	castleModel: null,      // 零件包拼的城堡模型（没读到时是 null，用程序化的）
	reflectionCastle: null, // 倒影里换上的 lod1 城堡（perf.scenesA.reflectionLod.gothic 开着时，hi 档才有）
	lake: null,
	columns: null,          // 窗灯倒影光柱（倒影里不画）
};

const tempPoint = new THREE.Vector3();
const tempDirection = new THREE.Vector3();
const worldUp = new THREE.Vector3( 0, 1, 0 );

function createRandom( seed ) {

	let value = ( seed >>> 0 ) || 1;
	return function next() {

		value = ( value + 0x6D2B79F5 ) >>> 0;
		let mixed = Math.imul( value ^ ( value >>> 15 ), 1 | value );
		mixed = ( mixed + Math.imul( mixed ^ ( mixed >>> 7 ), 61 | mixed ) ) ^ mixed;
		return ( ( mixed ^ ( mixed >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

function smoothJs( edge0, edge1, value ) {

	const amount = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return amount * amount * ( 3 - 2 * amount );

}

const yieldToBrowser = () => new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

function toWorldXZ( x, z ) {

	const point = state.ctx.world.toWorld( tempPoint.set( x, 0, z ), key, tempPoint );
	return [ point.x, point.z ];

}

function originY() {

	return state.ctx.world.locations[ key ].origin[ 1 ];

}

// ===================== 布局 =====================

function buildLayout() {

	const world = state.ctx.world;
	const gothicConfig = state.ctx.config.gothic;
	const landmark = world.locations[ key ].landmark;
	const castle = world.toLocal( new THREE.Vector3().fromArray( landmark ), key, new THREE.Vector3() );
	// 城堡脚下的地面（崖顶）
	castle.y = world.worldHeight( landmark[ 0 ], landmark[ 2 ] ) - originY();
	// 正面朝机位（和远景替身同一个朝向：本地 +z 朝机位）
	const facing = Math.atan2( - castle.x, - castle.z );
	const lake = world.config.lake;
	return {
		castle,
		facing,
		lakeLevel: lake.level - originY(),
		lakeCenter: world.toLocal( new THREE.Vector3( lake.center[ 0 ], lake.level, lake.center[ 1 ] ), key, new THREE.Vector3() ),
		rect: gothicConfig.terrainRect,
	};

}

// ===================== 近岸的地形 =====================
// 机位周围一块（湖边的草坡、碎石滩）：世界地形 + 小起伏，块的边上接回远景
function terrainHeightLocal( x, z ) {

	const rect = state.layout.rect;
	const [ worldX, worldZ ] = toWorldXZ( x, z );
	let height = state.ctx.world.sample( worldX, worldZ ).height - originY();
	const aboveLake = height - state.layout.lakeLevel;
	// 水边以上的草坡上有小土包；水下不加
	height += ( jsFbm2D( x / 6 + 1.7, z / 6 - 3.1, 3 ) - 0.5 ) * 0.35 * smoothJs( 0.1, 1.5, aboveLake );
	const edge = Math.min( x - rect.minX, rect.maxX - x, z - rect.minZ, rect.maxZ - z );
	if ( edge < 16 ) {

		const drawn = state.ctx.backdrop.getTerrainHeight( worldX, worldZ ) - originY();
		if ( Number.isFinite( drawn ) ) height += ( drawn - height ) * smoothJs( 16, 2, edge );

	}

	return height;

}

async function buildTerrain() {

	const rect = state.layout.rect;
	const spacing = 1.5;
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
			positions.set( [ x, height, z ], index * 3 );

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

function groundHeight( x, z ) {

	const grid = state.heights;
	const rect = state.layout.rect;
	const gridX = grid ? ( x - rect.minX ) / grid.spacing : - 1;
	const gridZ = grid ? ( z - rect.minZ ) / grid.spacing : - 1;
	if ( ! grid || gridX < 0 || gridZ < 0 || gridX > grid.countX - 1 || gridZ > grid.countZ - 1 ) {

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

// 不能走进湖里
function canWalk( x, z ) {

	return groundHeight( x, z ) > state.layout.lakeLevel + 0.15;

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

function createTerrainMaterial( noiseTexture ) {

	const layout = state.layout;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '湖岸';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const point = positionGeometry;
		const normal = normalize( normalGeometry );
		const aboveLake = point.y.sub( layout.lakeLevel );
		const patch = texture( noiseTexture, point.xz.div( 17 ) ).r;
		const fine = texture( noiseTexture, point.xz.div( 2.3 ) ).g;
		// 草坡（夜里看不出绿，偏灰蓝的暗绿）→ 水边的碎石滩 → 水下的泥
		const grass = mix( color( '#3c4f33' ), color( '#56683f' ), patch ).mul( fine.mul( 0.25 ).add( 0.85 ) );
		const pebbles = mix( color( '#5d5a55' ), color( '#7d776e' ), smoothstep( 0.35, 0.65, texture( noiseTexture, point.xz.div( 0.7 ) ).r ) );
		const mud = color( '#2c2a26' );
		const grassAmount = smoothstep( 0.6, 1.4, aboveLake.add( patch.sub( 0.5 ) ) );
		let albedo = mix( mud, mix( pebbles, grass, grassAmount ), smoothstep( - 0.1, 0.15, aboveLake ) );
		let lightingNormal = normal;
		// 近处的真贴图（和远景同一套，阶段 12 CP3）：草坡按草甸，碎石滩、泥按沙土
		const ground = state.ctx.backdrop.getGround();
		if ( ground ) {

			const detail = groundDetailInScene( ground, state.ctx.backdrop.getSceneToWorld(), {
				point, normal, weights: vec4( grassAmount, 0, 0, float( 1 ).sub( grassAmount ) ), near: state.ctx.backdrop.getGroundNear(), cameraPoint: cameraPosition,
			} );
			albedo = albedo.mul( detail.shade );
			lightingNormal = detail.normal;

		}

		// 草根融合（阶段 12 CP3 返工）：草的近环里草坡往草根色压
		// 密度用回调传：草的半径外不取（省两张草地图的取样）
		if ( state.grass && state.grassField ) albedo = state.grass.underlay( albedo, point.xz, () => grassGroundAt( point.xz ).density );
		const lit = state.ctx.backdrop.worldLighting( albedo, lightingNormal, point, { skyView: float( 0.9 ), wrap: 0.25 } );
		const fill = albedo.mul( state.ctx.world.uniforms.moonLightColor ).mul( 0.22 ).mul( state.uniforms.moonFill );
		return state.ctx.backdrop.worldAtmosphere( lit.add( fill ), point );

	} )();
	return material;

}

// ===================== 城堡 =====================

// 两坡屋顶（三棱柱）：长 length（沿 x）、宽 width（沿 z）、高 height
function gableRoof( length, width, height ) {

	const shape = new THREE.Shape();
	shape.moveTo( - width / 2, 0 );
	shape.lineTo( 0, height );
	shape.lineTo( width / 2, 0 );
	shape.lineTo( - width / 2, 0 );
	const geometry = new THREE.ExtrudeGeometry( shape, { depth: length, bevelEnabled: false } );
	geometry.rotateY( Math.PI / 2 );
	geometry.translate( - length / 2, 0, 0 );
	return geometry;

}

// 城堡几何体（城堡自己的坐标：原点在主厅中心的地面，+z 朝机位）：石头一份、屋顶一份；
// 窗户另外一份（每扇一张尖拱形的片，带编号、楼层高度比例、随机数、属于哪一组房间）
function buildCastle( random ) {

	const stone = [];
	const roofs = [];
	const windows = [];
	const matrix = new THREE.Matrix4();
	const rotation = new THREE.Matrix4();
	const add = ( list, geometry, x, y, z, angle = 0 ) => {

		let piece = geometry.index ? geometry.toNonIndexed() : geometry;
		if ( piece !== geometry ) geometry.dispose();
		piece.deleteAttribute( 'uv' );
		if ( ! piece.attributes.normal ) piece.computeVertexNormals();
		matrix.makeTranslation( x, y, z ).multiply( rotation.makeRotationY( angle ) );
		piece.applyMatrix4( matrix );
		list.push( piece );

	};
	// 窗：中心、朝外方向、楼层比例（0 底 1 顶）、所属的房间组
	let group = 0;
	const addWindow = ( x, y, z, outwardX, outwardZ, floorRatio, width = 1.1, height = 2.1 ) => {

		windows.push( { x: x + outwardX * 0.25, y, z: z + outwardZ * 0.25, outwardX, outwardZ, floor: floorRatio, width, height, group, random: random() } );

	};

	// 主厅：长 48、高 24、深 16，陡的两坡屋顶，屋脊上一排小尖塔；两面扶壁；三排窗（随机空掉一些，一个房间的几扇一起亮）
	add( stone, new THREE.BoxGeometry( 48, 24, 16 ), 0, 12, 0 );
	add( roofs, gableRoof( 48, 17, 14 ), 0, 24, 0 );
	for ( let x = - 20; x <= 20; x += 8 ) add( roofs, new THREE.ConeGeometry( 0.9, 7, 6 ), x, 41.5, 0 );
	for ( let x = - 22; x <= 22; x += 5.5 ) {

		for ( const side of [ 1, - 1 ] ) {

			// 扶壁：贴墙的窄墩子，顶上一个小尖
			add( stone, new THREE.BoxGeometry( 1.2, 20, 2.2 ), x, 10, 8.6 * side );
			add( roofs, new THREE.ConeGeometry( 0.8, 3.5, 4 ), x, 21.7, 8.6 * side, Math.PI / 4 );

		}

	}

	for ( const row of [ 6, 13, 19 ] ) {

		for ( let x = - 19.5; x <= 19.5; x += 5.5 ) {

			for ( const side of [ 1, - 1 ] ) {

				if ( random() < 0.3 ) continue;
				group ++;
				addWindow( x - 1.2, row, 8 * side, 0, side, row / 40 );
				addWindow( x + 1.2, row, 8 * side, 0, side, row / 40 );

			}

		}

	}

	// 圆塔：[本地 x, z, 半径, 高, 尖顶高]（和远景替身一样），塔身每层一圈窗、檐口一圈、尖锥顶、顶上细尖
	const towers = [
		[ - 14, - 6, 7.5, 52, 34 ], [ 24, 6, 4.5, 36, 18 ], [ - 26, 7, 4, 30, 16 ], [ 22, - 8, 3.6, 40, 22 ],
		[ 6, 9.5, 3, 28, 14 ], [ - 4, - 12, 5, 44, 24 ], [ 34, - 2, 3.4, 26, 12 ], [ - 36, - 4, 3.8, 24, 13 ],
	];
	for ( const [ x, z, radius, height, spire ] of towers ) {

		add( stone, new THREE.CylinderGeometry( radius, radius * 1.06, height, 24 ), x, height / 2, z );
		add( stone, new THREE.CylinderGeometry( radius + 0.7, radius + 0.7, 1.4, 24 ), x, height - 0.7, z );
		// 檐口下一圈托石
		for ( let k = 0; k < 16; k ++ ) {

			const angle = k / 16 * Math.PI * 2;
			add( stone, new THREE.BoxGeometry( 0.5, 1.2, 0.7 ), x + Math.sin( angle ) * ( radius + 0.35 ), height - 2, z + Math.cos( angle ) * ( radius + 0.35 ), angle );

		}

		add( roofs, new THREE.ConeGeometry( radius + 0.9, spire, 24 ), x, height + spire / 2, z );
		add( roofs, new THREE.CylinderGeometry( 0.08, 0.2, spire * 0.25, 6 ), x, height + spire + spire * 0.12, z );
		// 塔身上的小尖塔（大塔上四个）
		if ( radius > 4.5 ) {

			for ( let k = 0; k < 4; k ++ ) {

				const angle = ( k + 0.5 ) / 4 * Math.PI * 2;
				add( stone, new THREE.CylinderGeometry( 1.1, 1.1, 6, 10 ), x + Math.sin( angle ) * ( radius + 0.4 ), height + 1, z + Math.cos( angle ) * ( radius + 0.4 ) );
				add( roofs, new THREE.ConeGeometry( 1.3, 7, 10 ), x + Math.sin( angle ) * ( radius + 0.4 ), height + 7.5, z + Math.cos( angle ) * ( radius + 0.4 ) );

			}

		}

		// 每层约 4.5 米一圈窗（一层的几扇一起亮）
		for ( let level = 6; level < height - 3; level += 4 + random() * 1.5 ) {

			group ++;
			for ( const angle of [ - 2.1, - 1.05, 0, 1.05, 2.1, Math.PI ] ) {

				if ( random() < 0.35 ) continue;
				addWindow( x + Math.sin( angle ) * radius, level, z + Math.cos( angle ) * radius, Math.sin( angle ), Math.cos( angle ), level / 80 );

			}

		}

	}

	// 城墙：连着外侧几座塔，高 14 米，顶上垛口
	const walls = [ [ - 36, - 4, - 26, 7 ], [ 24, 6, 34, - 2 ], [ 34, - 2, 22, - 8 ], [ - 36, - 4, - 14, - 6 ] ];
	for ( const [ startX, startZ, endX, endZ ] of walls ) {

		const wallLength = Math.hypot( endX - startX, endZ - startZ );
		const angle = - Math.atan2( endZ - startZ, endX - startX );
		const centerX = ( startX + endX ) / 2;
		const centerZ = ( startZ + endZ ) / 2;
		add( stone, new THREE.BoxGeometry( wallLength, 14, 3 ), centerX, 7, centerZ, angle );
		const count = Math.floor( wallLength / 2 );
		for ( let k = 0; k < count; k += 2 ) {

			const along = ( k + 0.5 ) / count - 0.5;
			add( stone, new THREE.BoxGeometry( 1, 1.2, 3 ), centerX + Math.cos( angle ) * along * wallLength, 14.6, centerZ - Math.sin( angle ) * along * wallLength, angle );

		}

	}

	// 主厅两头的山墙
	for ( const side of [ 1, - 1 ] ) {

		group ++;
		for ( const row of [ 7, 15 ] ) {

			for ( const z of [ - 4, 0, 4 ] ) {

				if ( random() < 0.35 ) continue;
				addWindow( 24 * side, row, z, side, 0, row / 40 );

			}

		}

	}

	// 小礼拜堂：一排高窗、山墙上的玫瑰窗、一座细尖塔
	add( stone, new THREE.BoxGeometry( 14, 18, 10 ), 12, 9, - 14 );
	add( roofs, gableRoof( 14, 11, 9 ), 12, 18, - 14 );
	add( roofs, new THREE.ConeGeometry( 1.6, 16, 8 ), 18, 34, - 14 );
	add( stone, new THREE.CylinderGeometry( 1.2, 1.2, 8, 8 ), 18, 22, - 14 );
	group ++;
	for ( let x = 7; x <= 17; x += 2.5 ) addWindow( x, 9, - 9, 0, 1, 0.25, 1.3, 3.6 );
	group ++;
	addWindow( 19, 13, - 14, 1, 0, 0.35, 3.2, 3.2 );

	const merge = ( list ) => {

		let count = 0;
		for ( const piece of list ) count += piece.attributes.position.count;
		const positions = new Float32Array( count * 3 );
		const normals = new Float32Array( count * 3 );
		let offset = 0;
		for ( const piece of list ) {

			positions.set( piece.attributes.position.array, offset * 3 );
			normals.set( piece.attributes.normal.array, offset * 3 );
			offset += piece.attributes.position.count;
			piece.dispose();

		}

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		geometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
		geometry.computeBoundingSphere();
		return geometry;

	};

	return { stone: merge( stone ), roofs: merge( roofs ), windows };

}

// 城堡的石头：深蓝灰，月光（月亮在城堡背后）只勾一圈轮廓；屋顶石板更暗、带一点月光的镜面
function createStoneMaterial( noiseTexture, roof ) {

	const sky = state.ctx.world.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = roof ? '城堡屋顶' : '城堡石头';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const point = positionWorld;
		const local = positionGeometry;
		const normal = normalize( normalWorld );
		const toViewer = normalize( cameraPosition.sub( point ) );
		const blocks = texture( noiseTexture, vec2( local.x.add( local.z ), local.y ).div( 6 ) ).r;
		const albedo = roof ? mix( color( '#1a1f2c' ), color( '#262c3c' ), blocks ) : mix( color( '#3a4052' ), color( '#4c5266' ), blocks );
		const lit = state.ctx.backdrop.worldLighting( albedo, normal, point, { skyView: float( 0.85 ), wrap: 0.3 } ).toVar();
		// 月亮在背后：掠射的边上一圈冷白的亮边
		const viewWorld = state.ctx.backdrop.sceneDirectionToWorld( toViewer.negate() );
		const edge = pow( float( 1 ).sub( max( dot( normal, toViewer ), 0 ) ), 3 );
		const behind = pow( max( dot( viewWorld, sky.moonDirection ), 0 ), 3 );
		lit.addAssign( sky.moonLightColor.mul( edge.mul( behind ).mul( state.uniforms.moonRim ).mul( roof ? 1.4 : 0.9 ) ) );
		return state.ctx.backdrop.worldAtmosphere( lit, point );

	} )();
	return material;

}

// ===================== 零件包拼的城堡（阶段 12 CP4）=====================
// scripts/blender/gothic-castle.py 用 chambersu1996 的零件包（CC BY 4.0）拼的：一座主尖塔、两段高低错开的飞扶壁中殿、后面的细高尖塔、
// 前沿一排矮塔和方楼。模型里石头两种材质（Dark 深石、Light 浅一点的石边），顶点色是 Blender 里烘的环境光遮蔽；
// 窗玻璃单独一个网格，每个顶点带 _window = (房间号, 格号, 离地高度 / 城堡总高, 房间的随机数)

// 石头：零件包贴图只取明暗（砖缝、石块的起伏），颜色按暗黑哥特的深蓝灰；乘烘好的 AO（拱门里、檐下、扶壁之间暗下去）；
// 光照、大气同远景；月亮在背后，掠射的边上一圈冷白的亮边
function createKitStoneMaterial( map, light ) {

	const sky = state.ctx.world.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = light ? '城堡浅石' : '城堡石头';
	material.fog = false;
	material.lights = false;
	material.userData.map = map;
	material.colorNode = Fn( () => {

		const point = positionWorld;
		const normal = normalize( normalWorld );
		const toViewer = normalize( cameraPosition.sub( point ) );
		const sample = map ? texture( map ).rgb : vec3( 0.3 );
		const brightness = dot( sample, vec3( 0.2126, 0.7152, 0.0722 ) );
		const occlusion = attribute( 'color', 'vec3' ).r;
		const dark = light ? color( '#3a4050' ) : color( '#252a36' );
		const bright = light ? color( '#5a6274' ) : color( '#414858' );
		const albedo = mix( dark, bright, smoothstep( 0.04, 0.4, brightness ) ).mul( mix( float( 0.3 ), float( 1 ), occlusion ) );
		const lit = state.ctx.backdrop.worldLighting( albedo, normal, point, { skyView: occlusion.mul( 0.7 ).add( 0.25 ), wrap: 0.3 } ).toVar();
		const viewWorld = state.ctx.backdrop.sceneDirectionToWorld( toViewer.negate() );
		const edge = pow( float( 1 ).sub( max( dot( normal, toViewer ), 0 ) ), 3 );
		const behind = pow( max( dot( viewWorld, sky.moonDirection ), 0 ), 3 );
		lit.addAssign( sky.moonLightColor.mul( edge.mul( behind ).mul( state.uniforms.moonRim ).mul( occlusion ).mul( 1.1 ) ) );
		return state.ctx.backdrop.worldAtmosphere( lit, point );

	} )();
	return material;

}

// 一间屋的灯（和程序化窗灯同一套亮起规则，见 windowLight）：亮起时刻 = start + 楼层比例 × floorDelay + 房间的随机延迟 + 每格一点抖动；
// darkRooms 比例的房间整晚不亮（规格书 11.2：35%~45% 整翼、整层一直不亮）；每间屋色温 2200~3200 K 不同
function kitWindowData( info, lightConfig ) {

	const delay = float( lightConfig.start ).add( info.z.mul( lightConfig.floorDelay ) ).add( info.w.mul( lightConfig.groupSpread ) ).add( fract( info.y.mul( 0.618 ) ).mul( lightConfig.windowJitter ) );
	return vec4( 0.5, 0.5, delay, info.w );

}

function kitWindowTint( randomValue ) {

	return mix( color( '#ff9440' ), color( '#ffcf8f' ), fract( randomValue.mul( 3.7 ) ) );

}

function createKitWindowMaterial() {

	const uniforms = state.uniforms;
	const lightConfig = state.ctx.config.gothic.windows;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '窗灯';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const info = attribute( '_window', 'vec4' );
		const data = kitWindowData( info, lightConfig );
		const lit = step( lightConfig.darkRooms, fract( info.w.mul( 7.31 ) ) );
		const light = windowLight( data, uniforms.windowTime ).mul( uniforms.windowAmount ).mul( lit );
		const intensity = mix( float( lightConfig.intensity[ 0 ] ), float( lightConfig.intensity[ 1 ] ), info.w );
		// 不亮的窗是暗玻璃，反一点天光
		const darkGlass = color( '#10131c' ).add( state.ctx.world.uniforms.moonLightColor.mul( 0.02 ) );
		return state.ctx.backdrop.worldAtmosphere( mix( darkGlass, kitWindowTint( info.w ).mul( intensity ), light ), positionWorld );

	} )();
	return material;

}

// 模型的窗玻璃按房间号归成"窗"（场景坐标的中心、朝外方向），倒影光柱和亮灯时刻用；整晚不亮的房间不要
function kitRooms( glassMesh, lightConfig ) {

	const geometry = glassMesh.geometry;
	const positions = geometry.getAttribute( 'position' );
	const normals = geometry.getAttribute( 'normal' );
	const info = geometry.getAttribute( '_window' );
	const rooms = new Map();
	const point = new THREE.Vector3();
	const normal = new THREE.Vector3();
	const normalMatrix = new THREE.Matrix3().getNormalMatrix( glassMesh.matrixWorld );
	for ( let i = 0; i < positions.count; i ++ ) {

		const id = Math.round( info.getX( i ) );
		let room = rooms.get( id );
		if ( ! room ) {

			room = { center: new THREE.Vector3(), outward: new THREE.Vector3(), count: 0, floor: info.getZ( i ), random: info.getW( i ) };
			rooms.set( id, room );

		}

		point.fromBufferAttribute( positions, i ).applyMatrix4( glassMesh.matrixWorld );
		normal.fromBufferAttribute( normals, i ).applyMatrix3( normalMatrix );
		room.center.add( point );
		room.outward.add( normal );
		room.count ++;

	}

	const result = [];
	for ( const room of rooms.values() ) {

		if ( ( room.random * 7.31 ) % 1 < lightConfig.darkRooms ) continue;
		room.center.divideScalar( room.count );
		room.outward.y = 0;
		if ( room.outward.lengthSq() < 1e-6 ) room.outward.set( 0, 0, 1 );
		room.outward.normalize();
		result.push( room );

	}

	return result;

}

// 倒影光柱的几何体（buildColumnGeometry 的输入格式：每间屋一张"窗片"，四个角都放在房间中心，windowData = (角的 u, v, 亮起时刻, 随机数)）
function buildRoomWindowGeometry( rooms, lightConfig ) {

	const positions = [];
	const windowData = [];
	const indices = [];
	rooms.forEach( ( room, index ) => {

		const delay = lightConfig.start + room.floor * lightConfig.floorDelay + room.random * lightConfig.groupSpread;
		for ( const [ u, v ] of [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ] ) {

			positions.push( room.center.x, room.center.y, room.center.z );
			windowData.push( u, v, delay, room.random );

		}

		indices.push( index * 4, index * 4 + 1, index * 4 + 2, index * 4, index * 4 + 2, index * 4 + 3 );

	} );
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'windowData', new THREE.Float32BufferAttribute( windowData, 4 ) );
	geometry.setIndex( indices );
	return geometry;

}

// 读城堡模型（高档 gothic-castle 10 万三角，别的档 gothic-castle-lod1），摆到崖顶、正面朝机位，换材质。
// 返回 { group, rooms, height }；模型没读到返回 null（用程序化的城堡兜底）
async function loadKitCastle( content, castleMatrix ) {

	const id = content === 'hi' ? 'gothic-castle' : 'gothic-castle-lod1';
	const model = await loadModel( 'models', id );
	if ( ! model ) {

		console.warn( `哥特城堡：模型 ${ id } 没读到，用程序化的城堡兜底` );
		return null;

	}

	const group = new THREE.Group();
	group.name = '城堡';
	group.applyMatrix4( castleMatrix );
	group.add( model );
	group.updateMatrixWorld( true );
	const lightConfig = state.ctx.config.gothic.windows;
	let glassMesh = null;
	const materials = new Map();
	model.traverse( ( child ) => {

		if ( ! child.isMesh ) return;
		child.frustumCulled = false;
		// 换下来的原材质：法线贴图在 570 米外用不上，直接放掉；漂白贴图（map）石头材质还要用，退场时放
		const original = child.material;
		if ( original.normalMap ) original.normalMap.dispose();
		if ( original.metalnessMap ) original.metalnessMap.dispose();
		original.dispose();
		if ( child.geometry.getAttribute( '_window' ) ) {

			glassMesh = child;
			if ( original.map ) original.map.dispose();
			child.material = createKitWindowMaterial();
			state.disposables.push( child.material );
			return;

		}

		const light = /Light/.test( original.name || '' );
		const key = light ? 'light' : 'dark';
		if ( ! materials.has( key ) ) {

			const replaced = createKitStoneMaterial( original.map || null, light );
			materials.set( key, replaced );
			state.disposables.push( replaced );
			if ( original.map ) state.disposables.push( original.map );

		} else if ( original.map && original.map !== materials.get( key ).userData.map ) {

			original.map.dispose();

		}

		child.material = materials.get( key );

	} );
	if ( ! glassMesh ) {

		console.warn( `哥特城堡：模型 ${ id } 里没有带 _window 的窗玻璃，用程序化的城堡兜底` );
		disposeModel( model );
		return null;

	}

	const box = new THREE.Box3().setFromObject( group );
	const size = box.getSize( new THREE.Vector3() );
	console.log( `哥特城堡：模型 ${ id }，在场景里 ${ size.x.toFixed( 0 ) } × ${ size.z.toFixed( 0 ) } 米、高 ${ size.y.toFixed( 0 ) } 米` );
	return { group, rooms: kitRooms( glassMesh, lightConfig ), height: size.y };

}

// 倒影里的城堡（perf.scenesA.reflectionLod.gothic，默认关）：hi 档读 lod1（6.6 万三角，近处级 11.3 万），材质换成近处级那几个（不多编着色器）。
// lod1 的窗玻璃和近处级逐顶点一样（同样 14560 个三角、192 间屋，房间号、格号、楼层比例、随机数都相同），窗灯亮法对得上；
// 但石头减面后窗框、窗花少了，倒影里露出来的亮窗多一截，所以默认关（见 config.js）。
// 平时藏着，倒影那一遍和近处级换着显示；没读到返回 null（倒影照旧画近处级）
async function loadKitReflectionCastle( castleMatrix, nearGroup ) {

	const model = await loadModel( 'models', 'gothic-castle-lod1' );
	if ( ! model ) {

		console.warn( '哥特城堡：倒影用的 gothic-castle-lod1 没读到，倒影照旧画近处级' );
		return null;

	}

	// 近处级换好的材质：窗玻璃一个、石头按 Light / Dark 两个（材质名见 createKitStoneMaterial）
	const nearMaterials = {};
	nearGroup.traverse( ( child ) => {

		if ( ! child.isMesh ) return;
		if ( child.geometry.getAttribute( '_window' ) ) nearMaterials.window = child.material;
		else nearMaterials[ child.material.name === '城堡浅石' ? 'light' : 'dark' ] = child.material;

	} );
	const group = new THREE.Group();
	group.name = '城堡·倒影';
	group.applyMatrix4( castleMatrix );
	group.add( model );
	let missing = false;
	model.traverse( ( child ) => {

		if ( ! child.isMesh ) return;
		child.frustumCulled = false;
		child.name = '城堡·倒影';
		const original = child.material;
		for ( const map of [ original.map, original.normalMap, original.metalnessMap ] ) if ( map ) map.dispose();
		original.dispose();
		const replaced = child.geometry.getAttribute( '_window' ) ? nearMaterials.window : nearMaterials[ /Light/.test( original.name || '' ) ? 'light' : 'dark' ];
		if ( ! replaced ) missing = true;
		child.material = replaced || nearMaterials.dark;

	} );
	if ( missing || ! nearMaterials.window || ! nearMaterials.dark ) {

		console.warn( '哥特城堡：lod1 的网格和近处级的材质对不上，倒影照旧画近处级' );
		disposeGeometries( group );
		return null;

	}

	group.visible = false;
	return group;

}

// 只放几何体（倒影城堡的材质是借近处级的，跟着近处级放）
function disposeGeometries( object ) {

	object.traverse( ( child ) => {

		if ( child.geometry ) child.geometry.dispose();

	} );

}

// 窗户：每扇一张尖拱形的片。亮起来的时刻 = 房间组的随机延迟 + 楼层（从下往上）+ 每扇一点抖动（一个房间的几扇差不多一起亮，
// 不是一扇接一扇像进度条）；亮度 HDR 3~8，2700K 暖黄，轻轻闪；少数（3%）偶尔熄掉一会儿再亮
function buildWindowGeometry( windows, castleMatrix ) {

	const positions = [];
	const windowData = [];    // 窗上的坐标（xy，0~1）、亮起时刻（z）、随机数（w）
	const normals = [];
	const indices = [];
	const center = new THREE.Vector3();
	const outward = new THREE.Vector3();
	const side = new THREE.Vector3();
	const groupDelays = new Map();
	const random = createRandom( 404 );
	const lightConfig = state.ctx.config.gothic.windows;
	const windowScale = state.ctx.config.gothic.castleScale;
	for ( const item of windows ) {

		if ( ! groupDelays.has( item.group ) ) groupDelays.set( item.group, random() * lightConfig.groupSpread );
		const delay = lightConfig.start + item.floor * lightConfig.floorDelay + groupDelays.get( item.group ) + item.random * lightConfig.windowJitter;
		center.set( item.x, item.y, item.z ).applyMatrix4( castleMatrix );
		outward.set( item.outwardX, 0, item.outwardZ ).transformDirection( castleMatrix );
		side.crossVectors( worldUp, outward ).normalize();
		const first = positions.length / 3;
		for ( const [ u, v ] of [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ] ) {

			const point = center.clone().addScaledVector( side, ( u - 0.5 ) * item.width * windowScale ).addScaledVector( worldUp, ( v - 0.5 ) * item.height * windowScale );
			positions.push( point.x, point.y, point.z );
			normals.push( outward.x, outward.y, outward.z );
			windowData.push( u, v, delay, item.random );

		}

		indices.push( first, first + 1, first + 2, first, first + 2, first + 3 );

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'windowData', new THREE.Float32BufferAttribute( windowData, 4 ) );
	geometry.setIndex( indices );
	geometry.computeBoundingSphere();
	return geometry;

}

// 一扇窗此刻的亮度（0~1）：亮起、闪、偶尔熄
function windowLight( data, time ) {

	const lit = smoothstep( 0, 0.3, time.sub( data.z ) );
	const flicker = sin( time.mul( data.w.mul( 4 ).add( 3 ) ).add( data.w.mul( 40 ) ) ).mul( 0.06 ).add( 0.94 );
	// 3% 的窗偶尔熄掉（每 20 秒左右的一个周期里有 15% 的时间是黑的）
	const blink = select( data.w.greaterThan( 0.97 ), step01( fract( time.mul( 0.05 ).add( data.w.mul( 7 ) ) ).sub( 0.15 ) ), float( 1 ) );
	return lit.mul( flicker ).mul( blink );

}

function step01( value ) {

	return smoothstep( 0, 0.01, value );

}

function createWindowMaterial() {

	const uniforms = state.uniforms;
	const lightConfig = state.ctx.config.gothic.windows;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '窗灯';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const data = attribute( 'windowData', 'vec4' );
		// 尖拱形：上面三成收成尖
		const across = abs( data.x.sub( 0.5 ) ).mul( 2 );
		const archTop = float( 1 ).sub( pow( across, 1.6 ).mul( 0.3 ) );
		Discard( data.y.greaterThan( archTop ) );
		const light = windowLight( data, uniforms.windowTime ).mul( uniforms.windowAmount );
		// 窗格：十字窗棂暗一些；窗里中间亮、边上暗一点
		const mullion = max( smoothstep( 0.06, 0.02, abs( data.x.sub( 0.5 ) ) ), smoothstep( 0.04, 0.015, abs( data.y.sub( 0.55 ) ) ) );
		const glow = mix( float( 0.75 ), float( 1 ), float( 1 ).sub( across ) ).mul( float( 1 ).sub( mullion.mul( 0.6 ) ) );
		const intensity = mix( float( lightConfig.intensity[ 0 ] ), float( lightConfig.intensity[ 1 ] ), data.w );
		const dark = color( '#0b0d14' );
		const warm = color( lightConfig.color ).mul( intensity ).mul( glow );
		return state.ctx.backdrop.worldAtmosphere( mix( dark, warm, light ), positionWorld );

	} )();
	return material;

}

// 窗灯在湖里的倒影光柱：每扇窗一张对着镜头的竖条，放在"从镜头看向窗的镜像点"那条视线和湖面的交点上（略高一点，深度测试照常、
// 不写深度，近岸的地挡得住），尺寸按距离比例缩放，屏幕上和镜像点一样大；竖向拉长、往镜头这边拖出长尾，被波纹打碎、慢慢晃
function createColumnMaterial( noiseTexture ) {

	const uniforms = state.uniforms;
	const layout = state.layout;
	const lightConfig = state.ctx.config.gothic.windows;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '窗灯倒影';
	material.transparent = true;
	material.depthWrite = false;
	material.blending = THREE.AdditiveBlending;
	material.fog = false;
	material.lights = false;
	const data = attribute( 'windowData', 'vec4' );
	const center = attribute( 'columnCenter', 'vec3' );
	// 镜像点：窗中心关于湖面翻下去
	const mirrored = vec3( center.x, float( layout.lakeLevel * 2 ).sub( center.y ), center.z );
	const toMirror = mirrored.sub( cameraPosition );
	const hit = float( layout.lakeLevel + 0.03 ).sub( cameraPosition.y ).div( min( toMirror.y, - 1e-3 ) );
	const onWater = cameraPosition.add( toMirror.mul( hit ) );
	const scale = hit;   // 交点离镜头的距离 / 镜像点离镜头的距离
	// 在视图空间里搭一张竖条：上端在交点附近，往下（屏幕下方 = 往镜头这边的水面）拖 length
	const viewCenter = cameraViewMatrix.mul( vec4( onWater, 1 ) ).xyz;
	const width = float( 1.6 ).mul( scale );
	const length = float( lightConfig.columnLength ).mul( scale );
	const viewPosition = viewCenter.add( vec3( data.x.sub( 0.5 ).mul( width ), data.y.sub( 0.85 ).mul( length ), 0 ) );
	material.vertexNode = cameraProjectionMatrix.mul( vec4( viewPosition, 1 ) );
	material.colorNode = Fn( () => {

		const across = abs( data.x.sub( 0.5 ) ).mul( 2 );
		const along = float( 1 ).sub( data.y );
		// 横向：中间亮的窄芯；纵向：上头最亮，往下拖尾变暗；按沿光柱的噪声打碎成一段段（波纹），噪声随时间往下漂
		const core = exp( across.mul( across ).mul( - 9 ) );
		const tail = exp( along.mul( - 2.4 ) ).mul( smoothstep( 0, 0.12, data.y ) );
		const ripple = texture( noiseTexture, vec2( data.w.mul( 13 ).add( data.x.mul( 0.2 ) ), data.y.mul( 3.5 ).add( uniforms.time.mul( 0.25 ) ) ) ).r;
		const broken = smoothstep( 0.35, 0.75, ripple );
		const light = windowLight( data, uniforms.windowTime ).mul( uniforms.windowAmount ).mul( uniforms.columnAmount );
		const intensity = mix( float( lightConfig.intensity[ 0 ] ), float( lightConfig.intensity[ 1 ] ), data.w ).mul( 0.35 );
		return vec4( color( lightConfig.color ).mul( intensity ).mul( core ).mul( tail ).mul( broken ).mul( light ), 1 );

	} )();
	return material;

}

function buildColumnGeometry( windowGeometry ) {

	// 每扇窗一条：四个角的 windowData 换成光柱自己的 0~1 坐标，窗中心记在 columnCenter 里
	const positions = windowGeometry.attributes.position.array;
	const data = windowGeometry.attributes.windowData.array;
	const count = positions.length / 12;
	const columnData = new Float32Array( count * 16 );
	const centers = new Float32Array( count * 12 );
	const dummy = new Float32Array( count * 12 );
	const indices = [];
	for ( let i = 0; i < count; i ++ ) {

		let cx = 0;
		let cy = 0;
		let cz = 0;
		for ( let k = 0; k < 4; k ++ ) {

			cx += positions[ ( i * 4 + k ) * 3 ] / 4;
			cy += positions[ ( i * 4 + k ) * 3 + 1 ] / 4;
			cz += positions[ ( i * 4 + k ) * 3 + 2 ] / 4;

		}

		for ( let k = 0; k < 4; k ++ ) {

			const index = i * 4 + k;
			centers.set( [ cx, cy, cz ], index * 3 );
			dummy.set( [ cx, cy, cz ], index * 3 );
			columnData.set( [ data[ index * 4 ], data[ index * 4 + 1 ], data[ index * 4 + 2 ], data[ index * 4 + 3 ] ], index * 4 );

		}

		indices.push( i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3 );

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( dummy, 3 ) );
	geometry.setAttribute( 'columnCenter', new THREE.BufferAttribute( centers, 3 ) );
	geometry.setAttribute( 'windowData', new THREE.BufferAttribute( columnData, 4 ) );
	geometry.setIndex( indices );
	geometry.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e5 );
	return geometry;

}

// ===================== 湖面 =====================
// 湖岸线以内一整块（带起伏的椭圆，和世界的湖同一个形状，往外多 2%，压到岸下面）：64 段 × 24 圈
function buildLakeGeometry() {

	const lake = state.ctx.world.config.lake;
	const segments = 96;
	const rings = 28;
	const positions = [ ];
	const indices = [];
	const center = new THREE.Vector3();
	const point = new THREE.Vector3();
	for ( let ring = 0; ring <= rings; ring ++ ) {

		const radius = ( ring / rings ) * 1.02;
		for ( let k = 0; k < segments; k ++ ) {

			const angle = k / segments * Math.PI * 2;
			const wobble = 1 + 0.08 * Math.sin( angle * 3 + 0.7 ) + 0.05 * Math.sin( angle * 7 );
			const worldX = lake.center[ 0 ] + Math.cos( angle ) * lake.radiusX * radius * wobble;
			const worldZ = lake.center[ 1 ] + Math.sin( angle ) * lake.radiusZ * radius * wobble;
			state.ctx.world.toLocal( point.set( worldX, lake.level, worldZ ), key, point );
			positions.push( point.x, point.y, point.z );
			if ( ring === 0 ) break;

		}

	}

	// 第 0 圈只有一个中心点
	for ( let k = 0; k < segments; k ++ ) indices.push( 0, 1 + ( k + 1 ) % segments, 1 + k );
	for ( let ring = 1; ring < rings; ring ++ ) {

		const inner = 1 + ( ring - 1 ) * segments;
		const outer = 1 + ring * segments;
		for ( let k = 0; k < segments; k ++ ) {

			const next = ( k + 1 ) % segments;
			indices.push( inner + k, inner + next, outer + k, inner + next, outer + next, outer + k );

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setIndex( indices );
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	center.set( 0, 0, 0 );
	return geometry;

}

function createLakeMaterial( noiseTexture, useReflector ) {

	const uniforms = state.uniforms;
	const layout = state.layout;
	const sky = state.ctx.world.uniforms;
	let mirror = null;
	if ( useReflector ) {

		mirror = reflector( { resolutionScale: state.reflectionScale, bounces: false } );
		mirror.reflector.updateBeforeType = NodeUpdateType.NONE;
		mirror.target.rotation.x = - Math.PI / 2;
		mirror.target.position.y = layout.lakeLevel;
		state.reflectorNode = mirror;

	}

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = useReflector ? '湖面（平面倒影）' : '湖面';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const point = positionGeometry;
		// 分支前后都要用的量先落成变量（TSL 按第一次用到的位置生成代码，不落地的话会生成进 If 里面，If 外读到的是 0）
		const toViewer = normalize( cameraPosition.sub( point ) ).toVar();
		const footprint = max( length( fwidth( point ) ), 0.001 ).toVar();
		// 夜里的微风：两层噪声梯度慢慢漂；远处像素大了淡掉
		const drift = vec2( uniforms.time.mul( 0.03 ), uniforms.time.mul( 0.017 ) );
		const coarse = texture( noiseTexture, point.xz.div( 11 ).add( drift ) ).ba.sub( 0.5 ).mul( float( 1 ).sub( smoothstep( 0.5, 3, footprint ) ) );
		const fine = texture( noiseTexture, point.xz.div( 3.1 ).sub( drift.mul( 1.7 ) ) ).ba.sub( 0.5 ).mul( float( 1 ).sub( smoothstep( 0.08, 0.5, footprint ) ) );
		const gradient = coarse.mul( 0.05 ).add( fine.mul( 0.025 ) ).mul( uniforms.rippleAmount ).toVar();
		const normal = normalize( vec3( gradient.x.negate(), 1, gradient.y.negate() ) ).toVar();
		const reflected = reflect( toViewer.negate(), normal ).toVar();
		const skyColor = vec3( 0 ).toVar();
		// If 的回调不能有返回值（TSL 会当成 return 语句），写成块
		const skyPart = () => {

			const worldReflected = state.ctx.backdrop.sceneDirectionToWorld( reflected );
			skyColor.assign( daySkyColor( vec3( worldReflected.x, max( worldReflected.y, 0.01 ), worldReflected.z ), sky, uniforms.time, { sunDisc: false, stars: false } ) );

		};
		// 平面倒影开着（mirrorAmount = 1）时天空色（连同月晕）乘 0 被盖掉，整段不算（perf.scenesA.skipHiddenShading；条件只看 uniform，整帧一致）
		if ( mirror && state.ctx.config.perf.scenesA.skipHiddenShading ) If( uniforms.mirrorAmount.lessThan( 0.999 ), skyPart );
		else skyPart();
		const reflection = skyColor.toVar();
		if ( mirror ) {

			// 倒影：竖直方向的扰动比水平大很多，灯光和城堡的倒影被拉成竖条（夜景倒影最出彩的地方，规格书 11.2）
			const mirrored = mirror.sample( mirror.uvNode.add( vec2( gradient.x.mul( 0.15 ), gradient.y.mul( 1.2 ) ) ) ).rgb;
			reflection.assign( mix( skyColor, mirrored, uniforms.mirrorAmount ) );

		}

		const facing = max( dot( normal, toViewer ), 0.02 );
		const fresnel = float( 0.02 ).add( pow( float( 1 ).sub( facing ), 5 ).mul( 0.98 ) );
		const body = color( '#0a1226' ).mul( sky.skyIntensity.add( 0.02 ) );
		const surface = mix( body, reflection, fresnel.mul( 0.6 ).add( 0.4 ) ).toVar();
		// 月亮的碎光路：Beckmann 高光，粗糙度按微波的量级（夜里有一点风，σ² 约 0.012），月亮低的时候在湖面上拉成一条朝镜头的光路
		const moonDirection = sky.moonDirection;
		const viewWorld = state.ctx.backdrop.sceneDirectionToWorld( toViewer );
		const normalWorldLake = state.ctx.backdrop.sceneDirectionToWorld( normal );
		// 碎光：月光高光用一层更强的微波法线（6 米一格的噪声梯度），再乘一层成团的明暗（40 米、15 米两层噪声），
		// 光路是一段段、一片片的碎闪，不是一根边缘笔直的光柱（2026-10-02 审查 R14 "像探照灯"）
		const glintRipple = texture( noiseTexture, point.xz.div( 6 ).add( drift.mul( 2.3 ) ) ).ba.sub( 0.5 ).mul( float( 1 ).sub( smoothstep( 0.3, 2, footprint ) ) ).mul( 0.14 );
		const glintNormal = state.ctx.backdrop.sceneDirectionToWorld( normalize( vec3( gradient.x.add( glintRipple.x ).negate(), 1, gradient.y.add( glintRipple.y ).negate() ) ) );
		const halfVector = normalize( moonDirection.add( viewWorld ) );
		const cosine = max( dot( glintNormal, halfVector ), 1e-3 );
		const cosineSquared = cosine.mul( cosine );
		const roughness = float( 0.02 );
		const beckmann = exp( cosineSquared.sub( 1 ).div( cosineSquared.mul( roughness ) ) ).div( roughness.mul( Math.PI ).mul( cosineSquared ).mul( cosineSquared ) );
		const breakup = smoothstep( 0.4, 0.72, texture( noiseTexture, point.xz.div( 40 ).add( drift.mul( 3 ) ) ).r.mul( 0.6 ).add( texture( noiseTexture, point.xz.div( 15 ).sub( drift.mul( 4 ) ) ).g.mul( 0.4 ) ) ).mul( 0.85 ).add( 0.15 );
		const glint = sky.moonLightColor.mul( beckmann.mul( 0.02 ).div( facing.mul( 4 ) ) ).mul( breakup ).mul( smoothstep( - 0.02, 0.03, moonDirection.y ) ).mul( uniforms.moonPath );
		surface.addAssign( glint );
		return state.ctx.backdrop.worldAtmosphere( surface, point );

	} )();
	return material;

}

// ===================== 萤火虫 =====================
// 湖边草坡上几百只：一个小亮点，位置在顶点着色器里按正弦慢慢绕，一闪一闪（HDR，交给泛光）
function buildFireflies( count ) {

	const random = createRandom( 77 );
	const positions = [];
	const data = [];
	const indices = [];
	for ( let i = 0; i < count; i ++ ) {

		// 机位前后左右 60 米、离岸不远的草上
		let x = 0;
		let z = 0;
		let ground = 0;
		for ( let attempt = 0; attempt < 20; attempt ++ ) {

			x = ( random() - 0.5 ) * 120;
			z = ( random() - 0.5 ) * 80 - 10;
			ground = groundHeight( x, z );
			if ( ground > state.layout.lakeLevel + 0.2 ) break;

		}

		const y = Math.max( ground, state.layout.lakeLevel ) + 0.4 + random() * 2.2;
		// 两个随机数每只一份（四个角一样，不然四个角各自乱飘，方片被拉成长条）
		const seed = random();
		const phase = random();
		for ( const [ u, v ] of [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ] ) {

			positions.push( x, y, z );
			data.push( u, v, seed, phase );

		}

		const first = i * 4;
		indices.push( first, first + 1, first + 2, first, first + 2, first + 3 );

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'fireflyData', new THREE.Float32BufferAttribute( data, 4 ) );
	geometry.setIndex( indices );
	geometry.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e4 );
	return geometry;

}

function createFireflyMaterial() {

	const uniforms = state.uniforms;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '萤火虫';
	material.transparent = true;
	material.depthWrite = false;
	material.blending = THREE.AdditiveBlending;
	material.fog = false;
	material.lights = false;
	const data = attribute( 'fireflyData', 'vec4' );
	const time = uniforms.time;
	const wander = vec3(
		sin( time.mul( data.z.mul( 0.4 ).add( 0.25 ) ).add( data.w.mul( 30 ) ) ).mul( 1.6 ),
		sin( time.mul( data.w.mul( 0.5 ).add( 0.3 ) ).add( data.z.mul( 20 ) ) ).mul( 0.5 ),
		cos( time.mul( data.z.mul( 0.35 ).add( 0.2 ) ).add( data.w.mul( 11 ) ) ).mul( 1.6 ),
	);
	// 对着镜头的小方片，在视图空间里搭（远处的萤火虫至少画 2 个像素大，不然一闪就没了）
	const viewCenter = cameraViewMatrix.mul( vec4( positionGeometry.add( wander ), 1 ) ).xyz;
	const pixelAngle = float( 2 ).div( cameraProjectionMatrix[ 1 ][ 1 ].mul( 900 ) );
	const size = max( float( 0.1 ), pixelAngle.mul( length( viewCenter ) ).mul( 3 ) );
	material.vertexNode = cameraProjectionMatrix.mul( vec4( viewCenter.add( vec3( data.xy.sub( 0.5 ).mul( size ), 0 ) ), 1 ) );
	material.colorNode = Fn( () => {

		const offset = data.xy.sub( 0.5 ).mul( 2 );
		const glow = exp( dot( offset, offset ).mul( - 5 ) );
		// 一闪一闪：大部分时间暗，周期 2~5 秒亮一下
		const phase = fract( time.mul( data.z.mul( 0.3 ).add( 0.2 ) ).add( data.w ) );
		const pulse = smoothstep( 0, 0.15, phase ).mul( float( 1 ).sub( smoothstep( 0.25, 0.6, phase ) ) );
		return vec4( color( '#d8ff7a' ).mul( glow.mul( pulse ).mul( 6 ) ).mul( uniforms.fireflyAmount ), 1 );

	} )();
	return material;

}

// ===================== 崖上点灯的石阶小路（阶段 12 CP4）=====================
// 从城堡脚下的湖边一路折上去到城堡门口，灯隔几米一盏（"那种魔法学校的城堡"：夜里湖上望过去，崖上一串暖灯折上去，倒影里也是一串）。
// 位置：城堡往机位方向是朝湖的崖面；把崖面从湖边到崖沿分成 switchbacks 段，每段横着走 sweep 米（来回折），
// 每盏灯在崖面上按"这一段这一刻该在的高度"沿朝湖方向找到地面（远景的高度，二分），往外挪 0.8 米、抬高 0.6 米
function buildLanterns() {

	const ctx = state.ctx;
	const world = ctx.world;
	const config = ctx.config.gothic.lanterns;
	const landmark = world.locations[ key ].landmark;
	const origin = world.locations[ key ].origin;
	const heightAt = ( x, z ) => {

		const value = ctx.backdrop.getTerrainHeight( x, z );
		return Number.isFinite( value ) ? value : world.worldHeight( x, z );

	};
	// 朝湖方向（城堡 → 机位，水平）和沿崖面的横向
	const outX = origin[ 0 ] - landmark[ 0 ];
	const outZ = origin[ 2 ] - landmark[ 2 ];
	const outLength = Math.hypot( outX, outZ );
	const dirX = outX / outLength;
	const dirZ = outZ / outLength;
	const sideX = - dirZ;
	const sideZ = dirX;
	const lakeLevel = state.layout.lakeLevel + world.locations[ key ].origin[ 1 ];
	const top = heightAt( landmark[ 0 ], landmark[ 2 ] );
	// 往外走多远地面降到 targetHeight（从崖沿往外二分；横向偏 lateral 米）
	const findAlong = ( lateral, targetHeight ) => {

		let near = 0;
		let far = 260;
		for ( let i = 0; i < 24; i ++ ) {

			const middle = ( near + far ) / 2;
			const height = heightAt( landmark[ 0 ] + dirX * middle + sideX * lateral, landmark[ 2 ] + dirZ * middle + sideZ * lateral );
			if ( height > targetHeight ) near = middle;
			else far = middle;

		}

		return ( near + far ) / 2;

	};
	const random = createRandom( 991 );
	const points = [];
	const legs = config.switchbacks;
	for ( let leg = 0; leg < legs; leg ++ ) {

		const fromHeight = lakeLevel + 1.5 + ( top - lakeLevel - 4 ) * leg / legs;
		const toHeight = lakeLevel + 1.5 + ( top - lakeLevel - 4 ) * ( leg + 1 ) / legs;
		const direction = leg % 2 === 0 ? 1 : - 1;
		const legLength = Math.hypot( config.sweep, toHeight - fromHeight );
		const count = Math.max( 2, Math.round( legLength / config.spacing ) );
		for ( let k = ( leg === 0 ? 0 : 1 ); k <= count; k ++ ) {

			const fraction = k / count;
			const lateral = ( fraction - 0.5 ) * config.sweep * direction + ( random() - 0.5 ) * 1.5;
			const height = fromHeight + ( toHeight - fromHeight ) * fraction;
			const along = findAlong( lateral, height ) + 0.8;
			const x = landmark[ 0 ] + dirX * along + sideX * lateral;
			const z = landmark[ 2 ] + dirZ * along + sideZ * lateral;
			points.push( world.toLocal( new THREE.Vector3( x, Math.max( heightAt( x, z ), height ) + 0.6, z ), key, new THREE.Vector3() ) );

		}

	}

	const positions = [];
	const data = [];
	const indices = [];
	points.forEach( ( point, index ) => {

		const seed = random();
		for ( const [ u, v ] of [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ] ) {

			positions.push( point.x, point.y, point.z );
			data.push( u, v, seed, index / points.length );

		}

		const first = index * 4;
		indices.push( first, first + 1, first + 2, first, first + 2, first + 3 );

	} );
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'lanternData', new THREE.Float32BufferAttribute( data, 4 ) );
	geometry.setIndex( indices );
	geometry.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e4 );
	console.log( `哥特城堡：崖上的石阶小路 ${ points.length } 盏灯，${ legs } 折` );
	return geometry;

}

// ===================== 石桥（2026-10-02 用户：在湖上看城堡的那条视线上建一座桥，让人走过去近看）=====================
// 从机位旁边的湖岸起，微微弯着跨过湖，落到城堡崖脚石阶小路的起点（崖上那一串灯的第一盏），走上桥就能走到城堡脚下、抬头看崖上的城堡。
// 形状：两头各一段坡道（实心的堤），中间一孔孔半圆石拱架在桥墩上（拱脚没在水里）；桥面两边一道矮胸墙，
// 每隔一个桥墩两边各一盏铁框玻璃灯（和林间小路的灯一个样子），桥面上灯下一片暖光；倒影里是一串拱和一串灯。
// 都在地点自己的坐标里（state.scene），湖面的平面倒影自然把它画进去。走路：桥面上按桥面的高度走，桥上走得快一点（speedScale）

// 石阶小路的起点（世界坐标）：崖面上横偏 −sweep/2、高出湖面 1.5 米的地方（同 buildLanterns 的第一盏灯）
function stairFootWorld() {

	const ctx = state.ctx;
	const world = ctx.world;
	const config = ctx.config.gothic.lanterns;
	const landmark = world.locations[ key ].landmark;
	const origin = world.locations[ key ].origin;
	const heightAt = ( x, z ) => {

		const value = ctx.backdrop.getTerrainHeight( x, z );
		return Number.isFinite( value ) ? value : world.worldHeight( x, z );

	};
	const outX = origin[ 0 ] - landmark[ 0 ];
	const outZ = origin[ 2 ] - landmark[ 2 ];
	const outLength = Math.hypot( outX, outZ );
	const dirX = outX / outLength;
	const dirZ = outZ / outLength;
	const lateral = - config.sweep / 2;
	const target = state.layout.lakeLevel + originY() + 1.5;
	let near = 0;
	let far = 260;
	for ( let i = 0; i < 24; i ++ ) {

		const middle = ( near + far ) / 2;
		if ( heightAt( landmark[ 0 ] + dirX * middle - dirZ * lateral, landmark[ 2 ] + dirZ * middle + dirX * lateral ) > target ) near = middle;
		else far = middle;

	}

	const along = ( near + far ) / 2 + 0.8;
	return new THREE.Vector3( landmark[ 0 ] + dirX * along - dirZ * lateral, target, landmark[ 2 ] + dirZ * along + dirX * lateral );

}

// 桥的中线（本地坐标）：起点在机位左手边 sideOffset 米的岸上（往城堡方向走到湖边、再退回岸上几米；不从机位脚下起，
// 不然一上来一道桥墙挡住整片湖和倒影）；终点在石阶小路起点往湖里伸出 quay 米（崖脚的小码头）；
// 中间按二次贝塞尔往左弯 arc 米（让开画面中间的湖和倒影）。每 1 米一个点：{ x, z, s（沿桥的米数）, height（桥面高度，本地）}
function buildBridgePath() {

	const config = state.ctx.config.gothic.bridge;
	const lakeLevel = state.layout.lakeLevel;
	const foot = state.ctx.world.toLocal( stairFootWorld(), key, new THREE.Vector3() );
	const toFootX = foot.x;
	const toFootZ = foot.z;
	const toFootLength = Math.hypot( toFootX, toFootZ );
	const dirX = toFootX / toFootLength;
	const dirZ = toFootZ / toFootLength;
	// 起点：从机位左手边 sideOffset 米处往石阶方向走，到湖边为止，再往回退 landBack 米（左手边 = 朝石阶方向的左侧）
	const leftX = dirZ;
	const leftZ = - dirX;
	const fromX = leftX * config.sideOffset;
	const fromZ = leftZ * config.sideOffset;
	let shore = 0;
	for ( let d = 0; d < toFootLength; d += 0.5 ) {

		if ( groundHeight( fromX + dirX * d, fromZ + dirZ * d ) < lakeLevel + 0.4 ) break;
		shore = d;

	}

	const start = new THREE.Vector2( fromX + dirX * Math.max( 0, shore - config.landBack ), fromZ + dirZ * Math.max( 0, shore - config.landBack ) );
	const end = new THREE.Vector2( foot.x - dirX * config.quay, foot.z - dirZ * config.quay );
	const middle = start.clone().lerp( end, 0.5 );
	const control = middle.add( new THREE.Vector2( leftX, leftZ ).multiplyScalar( config.arc * 2 ) );
	// 先密采样贝塞尔，再按弧长每 1 米取一个点
	const dense = [];
	for ( let k = 0; k <= 2000; k ++ ) {

		const t = k / 2000;
		const a = ( 1 - t ) * ( 1 - t );
		const b = 2 * ( 1 - t ) * t;
		const c = t * t;
		dense.push( new THREE.Vector2( a * start.x + b * control.x + c * end.x, a * start.y + b * control.y + c * end.y ) );

	}

	let total = 0;
	const lengths = [ 0 ];
	for ( let k = 1; k < dense.length; k ++ ) {

		total += dense[ k ].distanceTo( dense[ k - 1 ] );
		lengths.push( total );

	}

	const startGround = groundHeight( start.x, start.y ) + 0.12;
	const deckTop = lakeLevel + config.deckHeight;
	const quayHeight = lakeLevel + 1.6;
	const samples = [];
	let cursor = 0;
	for ( let s = 0; s <= total + 1e-6; s += 1 ) {

		while ( cursor < lengths.length - 2 && lengths[ cursor + 1 ] < s ) cursor ++;
		const span = Math.max( 1e-6, lengths[ cursor + 1 ] - lengths[ cursor ] );
		const point = dense[ cursor ].clone().lerp( dense[ cursor + 1 ], ( s - lengths[ cursor ] ) / span );
		// 桥面：起点贴着岸，ramp 米里升到 deckHeight，中间平，最后 ramp 米落到码头
		const up = smoothJs( 0, config.ramp, s );
		const down = smoothJs( total, total - config.ramp, s );
		const height = startGround + ( deckTop - startGround ) * up + ( quayHeight - deckTop ) * ( 1 - down );
		samples.push( { x: point.x, z: point.y, s, height } );

	}

	console.log( `哥特城堡：石桥 ${ total.toFixed( 0 ) } 米（从湖岸到崖脚的石阶起点），桥头本地 ${ start.x.toFixed( 1 ) }, ${ start.y.toFixed( 1 ) }，桥尾 ${ end.x.toFixed( 1 ) }, ${ end.y.toFixed( 1 ) }` );
	return { samples, length: total, halfWidth: config.width / 2, endFoot: foot };

}

// 某点在不在桥面上；在就返回桥面高度（本地），不在返回 null。按中线上最近的点（每 1 米一个，先粗后细）
function bridgeAt( x, z ) {

	const bridge = state.bridge;
	if ( ! bridge ) return null;
	const samples = bridge.samples;
	let best = - 1;
	let bestDistance = Infinity;
	for ( let i = 0; i < samples.length; i += 6 ) {

		const distance = Math.hypot( samples[ i ].x - x, samples[ i ].z - z );
		if ( distance < bestDistance ) {

			bestDistance = distance;
			best = i;

		}

	}

	if ( bestDistance > bridge.halfWidth + 8 ) return null;
	for ( let i = Math.max( 0, best - 6 ); i <= Math.min( samples.length - 1, best + 6 ); i ++ ) {

		const distance = Math.hypot( samples[ i ].x - x, samples[ i ].z - z );
		if ( distance < bestDistance ) {

			bestDistance = distance;
			best = i;

		}

	}

	// 码头那头放宽成一个小平台（离终点 6 米以内半宽 + 2 米）
	const quay = samples[ best ].s > bridge.length - 6 ? 2 : 0;
	if ( bestDistance > bridge.halfWidth - 0.45 + quay ) return null;
	return samples[ best ].height;

}

// 走到桥面外（胸墙上、湖里）但离桥不远时，挪回桥面上：横向贴着胸墙内侧（桥是弯的，往前走会慢慢偏出去，这样就顺着桥走）
function bridgeSnap( x, z ) {

	const bridge = state.bridge;
	if ( ! bridge ) return null;
	let best = null;
	let bestDistance = Infinity;
	for ( const sample of bridge.samples ) {

		const distance = Math.hypot( sample.x - x, sample.z - z );
		if ( distance < bestDistance ) {

			bestDistance = distance;
			best = sample;

		}

	}

	const limit = bridge.halfWidth - 0.5;
	if ( ! best || bestDistance > bridge.halfWidth + 3 || bestDistance < 1e-6 ) return null;
	if ( bestDistance <= limit ) return [ x, z ];
	return [ best.x + ( x - best.x ) / bestDistance * limit, best.z + ( z - best.z ) / bestDistance * limit ];

}

// 桥的几何体：拱、桥墩、胸墙、码头（石头，一个网格）；灯（杆和玻璃，一个网格）；灯晕；桥面上的光池
function buildBridgeGeometry( bridge ) {

	const config = state.ctx.config.gothic.bridge;
	const lakeLevel = state.layout.lakeLevel;
	const samples = bridge.samples;
	const width = config.width;
	const bottom = lakeLevel - 4;
	const stoneParts = [];
	const lampParts = [];
	const lampPoints = [];
	const poolStrips = [];
	const at = ( s ) => samples[ Math.min( samples.length - 1, Math.max( 0, Math.round( s ) ) ) ];
	// 局部坐标系：原点在 a，x 沿 a → b，z 横过桥，y 朝上
	const frameMatrix = ( a, b ) => {

		const dx = b.x - a.x;
		const dz = b.z - a.z;
		const length = Math.hypot( dx, dz ) || 1;
		const along = new THREE.Vector3( dx / length, 0, dz / length );
		const across = new THREE.Vector3( - along.z, 0, along.x );
		return { matrix: new THREE.Matrix4().makeBasis( along, new THREE.Vector3( 0, 1, 0 ), across ).setPosition( a.x, 0, a.z ), length };

	};
	// 石头的 UV 按米（墙面上 x 沿桥、y 高；拱腹和桥面上 x 沿桥、y 横过去）：材质按它画石块
	const meterUv = ( geometry ) => {

		const position = geometry.attributes.position;
		const normal = geometry.attributes.normal;
		const uv = new Float32Array( position.count * 2 );
		for ( let i = 0; i < position.count; i ++ ) {

			const sideways = Math.abs( normal.getZ( i ) ) > 0.7;
			const flat = Math.abs( normal.getY( i ) ) > 0.7;
			uv[ i * 2 ] = sideways || flat ? position.getX( i ) : position.getZ( i ) + position.getX( i );
			uv[ i * 2 + 1 ] = flat ? position.getZ( i ) : position.getY( i );

		}

		geometry.setAttribute( 'uv', new THREE.BufferAttribute( uv, 2 ) );
		return geometry;

	};
	const addStone = ( geometry, matrix ) => {

		const flat = geometry.index ? geometry.toNonIndexed() : geometry;
		if ( flat !== geometry ) geometry.dispose();
		flat.deleteAttribute( 'uv' );
		flat.computeVertexNormals();
		meterUv( flat );
		flat.applyMatrix4( matrix );
		stoneParts.push( flat );

	};

	// ---------- 一跨一跨：桥墩之间 ----------
	const spanLength = config.span;
	const pierHalf = config.pier / 2;
	const spans = Math.max( 1, Math.round( bridge.length / spanLength ) );
	const step = bridge.length / spans;
	for ( let k = 0; k < spans; k ++ ) {

		const a = at( k * step );
		const b = at( ( k + 1 ) * step );
		const { matrix, length } = frameMatrix( a, b );
		const h0 = a.height;
		const h1 = b.height;
		const lowest = Math.min( h0, h1 );
		// 墙身：桥面以下到水下 4 米，桥面够高（离水 3.5 米以上）就挖一孔半圆拱
		const shape = new THREE.Shape();
		shape.moveTo( 0, bottom );
		shape.lineTo( length, bottom );
		shape.lineTo( length, h1 );
		shape.lineTo( 0, h0 );
		shape.lineTo( 0, bottom );
		const open = length - 2 * pierHalf;
		const apex = lowest - config.archCrown;
		if ( apex - lakeLevel > 2.2 && open > 2 ) {

			const radius = open / 2;
			const spring = Math.max( lakeLevel - 1, apex - radius );
			const arch = new THREE.Path();
			arch.moveTo( pierHalf, bottom + 0.5 );
			arch.lineTo( pierHalf, spring );
			// 半圆（或者拱高不够时压扁的半椭圆）
			const rise = apex - spring;
			for ( let j = 1; j <= 16; j ++ ) {

				const angle = Math.PI - j / 16 * Math.PI;
				arch.lineTo( pierHalf + radius + Math.cos( angle ) * radius, spring + Math.sin( angle ) * rise );

			}

			arch.lineTo( length - pierHalf, bottom + 0.5 );
			arch.lineTo( pierHalf, bottom + 0.5 );
			shape.holes.push( arch );

		}

		const wall = new THREE.ExtrudeGeometry( shape, { depth: width, bevelEnabled: false, steps: 1, curveSegments: 4 } );
		wall.translate( 0, 0, - width / 2 );
		addStone( wall, matrix );
		// 胸墙：桥面两边各一道，高 parapet、厚 0.35
		for ( const side of [ - 1, 1 ] ) {

			const top = new THREE.Shape();
			top.moveTo( 0, h0 - 0.05 );
			top.lineTo( length, h1 - 0.05 );
			top.lineTo( length, h1 + config.parapet );
			top.lineTo( 0, h0 + config.parapet );
			top.lineTo( 0, h0 - 0.05 );
			const parapet = new THREE.ExtrudeGeometry( top, { depth: 0.35, bevelEnabled: false } );
			parapet.translate( 0, 0, side > 0 ? width / 2 - 0.35 : - width / 2 );
			addStone( parapet, matrix );

		}

		// 桥面上这一跨的光池条带（灯在跨的起点那个桥墩上）
		poolStrips.push( { a, b, matrix, length, h0, h1 } );

	}

	// ---------- 桥墩：每一跨的两头，比桥身宽出一圈，顶上一道压檐；水线处一圈苔（材质里按高度画）----------
	for ( let k = 0; k <= spans; k ++ ) {

		const center = at( k * step );
		const prev = at( Math.max( 0, k * step - 2 ) );
		const next = at( Math.min( bridge.length, k * step + 2 ) );
		const { matrix } = frameMatrix( prev, next );
		const position = new THREE.Vector3( center.x, 0, center.z );
		matrix.setPosition( position );
		const pierTop = center.height - 0.3;
		if ( pierTop - bottom < 1 ) continue;
		const pier = new THREE.BoxGeometry( config.pier, pierTop - bottom, width + 0.9 );
		pier.translate( 0, ( pierTop + bottom ) / 2, 0 );
		addStone( pier, matrix );
		// 迎水的尖（两边各一个三棱柱，像分水尖）
		if ( center.height - lakeLevel > 2.5 ) {

			for ( const side of [ - 1, 1 ] ) {

				const cut = new THREE.CylinderGeometry( config.pier * 0.7, config.pier * 0.7, lakeLevel + 1.2 - bottom, 3, 1 );
				cut.rotateY( side > 0 ? Math.PI / 6 : - Math.PI / 6 + Math.PI );
				cut.translate( 0, ( lakeLevel + 1.2 + bottom ) / 2, side * ( width / 2 + 0.45 ) );
				addStone( cut, matrix );

			}

		}

		// 灯：每隔 lampEvery 个桥墩，桥面够高的地方，两边胸墙顶上各一盏
		if ( k % config.lampEvery === 0 && k > 0 && k < spans ) {

			for ( const side of [ - 1, 1 ] ) {

				const base = new THREE.Vector3( 0, center.height + config.parapet, side * ( width / 2 - 0.18 ) );
				const pieces = [];
				const add = ( geometry, glow, x0, y0, z0 ) => {

					geometry.translate( x0, y0, z0 );
					geometry.setAttribute( 'lanternGlow', new THREE.BufferAttribute( new Float32Array( geometry.attributes.position.count ).fill( glow ), 1 ) );
					pieces.push( geometry.index ? geometry.toNonIndexed() : geometry );

				};
				add( new THREE.BoxGeometry( 0.12, config.lampPost, 0.12 ), 0, base.x, base.y + config.lampPost / 2, base.z );
				const bodyCenter = base.y + config.lampPost + 0.18;
				add( new THREE.BoxGeometry( 0.3, 0.03, 0.3 ), 0, base.x, bodyCenter - 0.18, base.z );
				add( new THREE.BoxGeometry( 0.24, 0.32, 0.24 ), 1, base.x, bodyCenter, base.z );
				const roof = new THREE.ConeGeometry( 0.22, 0.16, 4, 1 );
				roof.rotateY( Math.PI / 4 );
				add( roof, 0, base.x, bodyCenter + 0.24, base.z );
				add( new THREE.SphereGeometry( 0.03, 6, 4 ), 0, base.x, bodyCenter + 0.34, base.z );
				for ( const piece of pieces ) {

					piece.applyMatrix4( matrix );
					lampParts.push( piece );

				}

				lampPoints.push( new THREE.Vector3( base.x, bodyCenter, base.z ).applyMatrix4( matrix ) );

			}

		}

	}

	// ---------- 码头：石阶起点前一块平台，接上崖脚 ----------
	{

		const end = samples[ samples.length - 1 ];
		const prev = samples[ Math.max( 0, samples.length - 4 ) ];
		const { matrix } = frameMatrix( prev, end );
		matrix.setPosition( new THREE.Vector3( end.x, 0, end.z ) );
		const quay = new THREE.BoxGeometry( 8, end.height - bottom, width + 4 );
		quay.translate( 3, ( end.height + bottom ) / 2, 0 );
		addStone( quay, matrix );

	}

	const stone = mergeGeometries( stoneParts );
	for ( const part of stoneParts ) part.dispose();
	const lamps = lampParts.length ? mergeGeometries( lampParts ) : null;
	for ( const part of lampParts ) part.dispose();

	// ---------- 灯晕 ----------
	const haloPositions = [];
	const haloData = [];
	const haloIndices = [];
	lampPoints.forEach( ( point, index ) => {

		for ( const [ u, v ] of [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ] ) {

			haloPositions.push( point.x, point.y, point.z );
			haloData.push( u, v, ( index * 0.618 ) % 1, index / Math.max( 1, lampPoints.length ) );

		}

		haloIndices.push( index * 4, index * 4 + 1, index * 4 + 2, index * 4, index * 4 + 2, index * 4 + 3 );

	} );
	const halos = new THREE.BufferGeometry();
	halos.setAttribute( 'position', new THREE.Float32BufferAttribute( haloPositions, 3 ) );
	halos.setAttribute( 'lanternData', new THREE.Float32BufferAttribute( haloData, 4 ) );
	halos.setIndex( haloIndices );
	halos.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e5 );

	// ---------- 桥面上的光池：每盏灯所在的桥墩前后各 poolLength 米、横满桥面，9 × 5 个点贴着桥面 ----------
	const poolPositions = [];
	const poolData = [];
	const poolIndices = [];
	for ( const lamp of lampPoints ) {

		const first = poolPositions.length / 3;
		// 灯在桥上的位置：最近的中线点
		let nearest = samples[ 0 ];
		for ( const sample of samples ) if ( Math.hypot( sample.x - lamp.x, sample.z - lamp.z ) < Math.hypot( nearest.x - lamp.x, nearest.z - lamp.z ) ) nearest = sample;
		for ( let j = 0; j < 9; j ++ ) {

			const s = nearest.s + ( j / 8 * 2 - 1 ) * config.poolLength;
			const center = at( s );
			const ahead = at( s + 1 );
			const behind = at( s - 1 );
			const ax = ahead.x - behind.x;
			const az = ahead.z - behind.z;
			const al = Math.hypot( ax, az ) || 1;
			for ( let i = 0; i < 5; i ++ ) {

				const across = ( i / 4 * 2 - 1 ) * ( width / 2 - 0.4 );
				const x = center.x - az / al * across;
				const z = center.z + ax / al * across;
				poolPositions.push( x, center.height + 0.04, z );
				poolData.push( Math.hypot( x - lamp.x, z - lamp.z ), lamp.y - center.height );

			}

		}

		for ( let j = 0; j < 8; j ++ ) {

			for ( let i = 0; i < 4; i ++ ) {

				const a = first + j * 5 + i;
				poolIndices.push( a, a + 5, a + 1, a + 1, a + 5, a + 6 );

			}

		}

	}

	const pools = new THREE.BufferGeometry();
	pools.setAttribute( 'position', new THREE.Float32BufferAttribute( poolPositions, 3 ) );
	pools.setAttribute( 'poolData', new THREE.Float32BufferAttribute( poolData, 2 ) );
	pools.setIndex( poolIndices );
	pools.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e5 );
	return { stone, lamps, halos, pools, lampCount: lampPoints.length, spans };

}

// 桥的石头：深蓝灰的方石，按米的 UV 画错缝的石块（行高 0.55 米、块长 1.1~1.6 米）、灰缝暗；水线以下湿而暗、水线上一圈苔；
// 光照同湖岸（远景的世界光照 + 月光补光 + 湖面反上来的光）
function createBridgeStoneMaterial( noiseTexture ) {

	const uniforms = state.uniforms;
	const lakeLevel = state.layout.lakeLevel;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '石桥';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const point = positionGeometry;
		const normal = normalize( normalGeometry );
		const uv = attribute( 'uv', 'vec2' );
		const row = floor( uv.y.div( 0.55 ) );
		const blockCoord = uv.x.div( 1.3 ).add( fract( row.mul( 0.37 ) ).mul( 1.3 ) );
		const block = floor( blockCoord );
		const blockSeed = fract( sin( block.mul( 12.9898 ).add( row.mul( 78.233 ) ) ).mul( 43758.5453 ) );
		const jointY = smoothstep( 0.04, 0.0, abs( fract( uv.y.div( 0.55 ) ).sub( 0.5 ) ).sub( 0.46 ).negate() );
		const jointX = smoothstep( 0.04, 0.0, abs( fract( blockCoord ).sub( 0.5 ) ).sub( 0.47 ).negate() );
		const joint = max( jointY, jointX );
		const grain = texture( noiseTexture, point.xz.div( 3.1 ).add( point.y.div( 2.3 ) ) ).r;
		let albedo = mix( color( '#5e6370' ), color( '#858894' ), blockSeed.mul( 0.6 ).add( grain.mul( 0.4 ) ) ).mul( float( 1 ).sub( joint.mul( 0.45 ) ) );
		// 水线：以下湿、暗；以上 0.6 米一圈苔
		const aboveWater = point.y.sub( lakeLevel );
		albedo = mix( albedo.mul( 0.45 ), albedo, smoothstep( - 0.3, 0.15, aboveWater ) );
		const moss = smoothstep( 0.9, 0.1, aboveWater ).mul( smoothstep( - 0.2, 0.1, aboveWater ) ).mul( grain.mul( 0.6 ).add( 0.4 ) );
		albedo = mix( albedo, color( '#3c4a33' ), moss.mul( 0.6 ) );
		const lit = state.ctx.backdrop.worldLighting( albedo, normal, point, { skyView: float( 0.85 ), wrap: 0.25 } );
		// 月光补光比湖岸多一点（桥在湖中间，四面是反光的水），夜里看得出一孔孔拱
		const fill = albedo.mul( state.ctx.world.uniforms.moonLightColor ).mul( 0.4 ).mul( uniforms.moonFill );
		return state.ctx.backdrop.worldAtmosphere( lit.add( fill ), point );

	} )();
	return material;

}

// 桥上的灯：杆、铁框按世界光照（暗）；玻璃按 UV 画窗格，格子里透出暖光（入夜就亮，和崖上的石阶灯一样跟着停留时间点亮）
function createBridgeLampMaterial() {

	const uniforms = state.uniforms;
	const config = state.ctx.config.gothic.bridge;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '石桥·灯';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const glowFlag = attribute( 'lanternGlow', 'float' );
		const lampUv = attribute( 'uv', 'vec2' );
		const frameColor = mix( color( '#2c2620' ), color( '#211f1c' ), glowFlag );
		const lit = state.ctx.backdrop.worldAtmosphere( state.ctx.backdrop.worldLighting( frameColor, normalize( normalGeometry ), positionGeometry, { skyView: float( 0.6 ), wrap: 0.3 } ), positionGeometry );
		const edge = max( abs( lampUv.x.sub( 0.5 ) ), abs( lampUv.y.sub( 0.5 ) ) );
		const cross = min( abs( lampUv.x.sub( 0.5 ) ), abs( lampUv.y.sub( 0.5 ) ) );
		const pane = float( 1 ).sub( smoothstep( 0.36, 0.4, edge ) ).mul( smoothstep( 0.025, 0.045, cross ) );
		const on = smoothstep( 0, 0.4, uniforms.time.sub( 1 ) ).mul( uniforms.lanternAmount );
		const warm = color( config.lampColor ).mul( config.glassIntensity ).mul( pane ).mul( glowFlag ).mul( on );
		return vec4( lit.add( warm ), 1 );

	} )();
	return material;

}

// 桥上的灯晕（小、收得紧，往镜头挪 0.3 米不被玻璃挡住）
function createBridgeHaloMaterial() {

	const uniforms = state.uniforms;
	const config = state.ctx.config.gothic.bridge;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '石桥·灯晕';
	material.transparent = true;
	material.depthWrite = false;
	material.blending = THREE.AdditiveBlending;
	material.fog = false;
	material.lights = false;
	const data = attribute( 'lanternData', 'vec4' );
	const viewCenter = cameraViewMatrix.mul( vec4( positionGeometry, 1 ) ).xyz;
	const pulled = viewCenter.mul( max( length( viewCenter ).sub( 0.3 ), 0.05 ).div( max( length( viewCenter ), 1e-3 ) ) );
	const pixelAngle = float( 2 ).div( cameraProjectionMatrix[ 1 ][ 1 ].mul( 900 ) );
	const size = max( float( 0.6 ), pixelAngle.mul( length( viewCenter ) ).mul( 2.5 ) );
	material.vertexNode = cameraProjectionMatrix.mul( vec4( pulled.add( vec3( data.xy.sub( 0.5 ).mul( size ), 0 ) ), 1 ) );
	material.colorNode = Fn( () => {

		const offset = data.xy.sub( 0.5 ).mul( 2 );
		const glow = exp( dot( offset, offset ).mul( - 9 ) );
		const flicker = sin( uniforms.time.mul( data.z.mul( 5 ).add( 7 ) ).add( data.z.mul( 40 ) ) ).mul( 0.06 ).add( 0.94 );
		const on = smoothstep( 0, 0.4, uniforms.time.sub( 1 ).sub( data.w.mul( 3 ) ) ).mul( uniforms.lanternAmount );
		return vec4( color( config.lampColor ).mul( glow.mul( flicker ).mul( on ).mul( config.haloIntensity ) ), 1 );

	} )();
	return material;

}

// 桥面上灯下的暖光（加法混合；照度按点光源 高 / (距离² + 高²)^1.5）
function createBridgePoolMaterial() {

	const uniforms = state.uniforms;
	const config = state.ctx.config.gothic.bridge;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '石桥·灯下光池';
	material.transparent = true;
	material.depthWrite = false;
	material.blending = THREE.AdditiveBlending;
	material.fog = false;
	material.lights = false;
	material.polygonOffset = true;
	material.polygonOffsetFactor = - 2;
	material.polygonOffsetUnits = - 2;
	const info = attribute( 'poolData', 'vec2' );
	material.colorNode = Fn( () => {

		const distance = info.x;
		const lampHeight = info.y;
		const irradiance = lampHeight.mul( lampHeight ).mul( lampHeight ).div( pow( distance.mul( distance ).add( lampHeight.mul( lampHeight ) ), 1.5 ) );
		const edge = float( 1 ).sub( smoothstep( config.poolLength * 0.6, config.poolLength, distance ) );
		const on = smoothstep( 0, 0.4, uniforms.time.sub( 1 ) ).mul( uniforms.lanternAmount );
		return vec4( color( config.lampColor ).mul( irradiance.mul( edge ).mul( config.poolIntensity ).mul( on ) ), 1 );

	} )();
	return material;

}

// 灯：对着镜头的小方片，暖色 HDR（交给泛光晕开），轻轻跳动；和窗灯一样跟着天黑亮起来（从下往上，一盏接一盏地快速点亮）
function createLanternMaterial() {

	const uniforms = state.uniforms;
	const config = state.ctx.config.gothic.lanterns;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '石阶灯';
	material.transparent = true;
	material.depthWrite = false;
	material.blending = THREE.AdditiveBlending;
	material.fog = false;
	material.lights = false;
	const data = attribute( 'lanternData', 'vec4' );
	const viewCenter = cameraViewMatrix.mul( vec4( positionGeometry, 1 ) ).xyz;
	// 屏幕上至少 3 个像素（600 米外的一盏灯也看得见），近处是 0.5 米
	const pixelAngle = float( 2 ).div( cameraProjectionMatrix[ 1 ][ 1 ].mul( 900 ) );
	const size = max( float( 0.5 ), pixelAngle.mul( length( viewCenter ) ).mul( 3 ) );
	material.vertexNode = cameraProjectionMatrix.mul( vec4( viewCenter.add( vec3( data.xy.sub( 0.5 ).mul( size ), 0 ) ), 1 ) );
	material.colorNode = Fn( () => {

		const offset = data.xy.sub( 0.5 ).mul( 2 );
		const glow = exp( dot( offset, offset ).mul( - 6 ) );
		const flicker = sin( uniforms.time.mul( data.z.mul( 5 ).add( 7 ) ).add( data.z.mul( 40 ) ) ).mul( 0.08 ).add( 0.92 );
		// 从下往上点亮：停留开始以后 1 秒起，6 秒点完
		const lit = smoothstep( 0, 0.4, uniforms.time.sub( 1 ).sub( data.w.mul( 6 ) ) );
		return vec4( color( config.color ).mul( glow.mul( flicker ).mul( lit ).mul( config.intensity ) ).mul( uniforms.lanternAmount ), 1 );

	} )();
	return material;

}

// ===================== 蝙蝠 =====================
// 几只小小的 V 形剪影绕着塔尖飞，翅膀扇动在顶点着色器里（一只一个网格，位置每帧在 JS 里按时间算，只有几只）
function createBat() {

	// 两片翅膀，翅尖 x = ±1，中间身体；flap 属性：翅尖 1、身体 0
	const positions = new Float32Array( [ - 1, 0, 0.1, 0, 0, - 0.25, 0, 0, 0.3, 1, 0, 0.1, 0, 0, - 0.25, 0, 0, 0.3 ] );
	const flaps = new Float32Array( [ 1, 0, 0, 1, 0, 0 ] );
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'flap', new THREE.BufferAttribute( flaps, 1 ) );
	const flapUniform = uniform( 0 );
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '蝙蝠';
	material.side = THREE.DoubleSide;
	material.fog = false;
	material.lights = false;
	const flap = attribute( 'flap', 'float' );
	material.positionNode = positionGeometry.add( vec3( 0, flap.mul( sin( flapUniform ) ).mul( 0.7 ), 0 ) );
	material.colorNode = vec4( color( '#05060a' ), 1 );
	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = '蝙蝠';
	mesh.frustumCulled = false;
	mesh.scale.setScalar( 0.6 );
	state.disposables.push( geometry, material );
	return { mesh, flapUniform };

}

// ===================== init =====================

export async function init( ctx ) {

	if ( state.scene ) {

		console.warn( '哥特城堡场景：init 被重复调用，先释放旧的再重建' );
		dispose();

	}

	if ( ! ctx.backdrop || ! ctx.world || ! ctx.backdrop.getRoot() ) throw new Error( '哥特城堡场景：要先建好秘境（ctx.world、ctx.backdrop）' );
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
	const gothicConfig = ctx.config.gothic;
	const content = ctx.quality.content;
	state.layout = buildLayout();
	state.reflectionScale = gothicConfig.reflectionScale[ content ] || 0;
	const layout = state.layout;

	const scene = new THREE.Scene();
	scene.name = '哥特城堡';
	scene.background = new THREE.Color( 0x000000 );
	state.scene = scene;
	state.uniforms = {
		time: uniform( 0 ),
		windowTime: uniform( 0 ),
		windowAmount: uniform( 1 ),
		columnAmount: uniform( 1 ),
		rippleAmount: uniform( 1 ),
		mirrorAmount: uniform( 1 ),
		moonRim: uniform( 1 ),
		moonPath: uniform( 1 ),
		moonFill: uniform( 1 ),
		fireflyAmount: uniform( 1 ),
		lanternAmount: uniform( 1 ),
		fogAmount: uniform( 1 ),
	};

	const noiseData = createNoiseTextureData( 256, 32, 57 );
	const noiseTexture = new THREE.DataTexture( noiseData.data, noiseData.size, noiseData.size, THREE.RGBAFormat, THREE.UnsignedByteType );
	noiseTexture.wrapS = THREE.RepeatWrapping;
	noiseTexture.wrapT = THREE.RepeatWrapping;
	noiseTexture.magFilter = THREE.LinearFilter;
	noiseTexture.minFilter = THREE.LinearMipmapLinearFilter;
	noiseTexture.generateMipmaps = true;
	noiseTexture.needsUpdate = true;
	state.disposables.push( noiseTexture );

	// 近岸的地形
	const terrainGeometry = await buildTerrain();
	const terrainMaterial = createTerrainMaterial( noiseTexture );
	const terrain = new THREE.Mesh( terrainGeometry, terrainMaterial );
	terrain.name = '湖岸';
	scene.add( terrain );
	state.disposables.push( terrainGeometry, terrainMaterial );

	// 城堡（城堡自己的坐标 → 场景：平移到崖顶、转到正面朝机位）：零件包拼的模型，没读到用程序化的兜底
	const facingMatrix = new THREE.Matrix4().makeTranslation( layout.castle.x, layout.castle.y, layout.castle.z ).multiply( new THREE.Matrix4().makeRotationY( layout.facing ) );
	const kitCastle = await loadKitCastle( content, facingMatrix.clone().multiply( new THREE.Matrix4().makeScale( gothicConfig.modelScale, gothicConfig.modelScale, gothicConfig.modelScale ) ) );
	let castleParts;
	let windowGeometry;
	if ( kitCastle ) {

		scene.add( kitCastle.group );
		state.castleModel = kitCastle.group;
		state.castleHeight = kitCastle.height;
		windowGeometry = buildRoomWindowGeometry( kitCastle.rooms, gothicConfig.windows );
		castleParts = [ kitCastle.group ];
		// 别的档主画面本来就是 lod1，只有 hi 档另读一份给倒影
		state.reflectionCastle = null;
		if ( content === 'hi' && state.reflectionScale > 0 && ctx.config.perf.scenesA.reflectionLod.gothic ) {

			state.reflectionCastle = await loadKitReflectionCastle( facingMatrix.clone().multiply( new THREE.Matrix4().makeScale( gothicConfig.modelScale, gothicConfig.modelScale, gothicConfig.modelScale ) ), kitCastle.group );
			if ( state.reflectionCastle ) scene.add( state.reflectionCastle );

		}

	} else {

		const castle = buildCastle( createRandom( 1185 ) );
		const castleMatrix = facingMatrix.clone().multiply( new THREE.Matrix4().makeScale( gothicConfig.castleScale, gothicConfig.castleScale, gothicConfig.castleScale ) );
		const stoneMaterial = createStoneMaterial( noiseTexture, false );
		const roofMaterial = createStoneMaterial( noiseTexture, true );
		const stone = new THREE.Mesh( castle.stone, stoneMaterial );
		const roofs = new THREE.Mesh( castle.roofs, roofMaterial );
		for ( const mesh of [ stone, roofs ] ) {

			mesh.applyMatrix4( castleMatrix );
			mesh.name = '城堡';
			scene.add( mesh );

		}

		state.disposables.push( castle.stone, castle.roofs, stoneMaterial, roofMaterial );
		state.castleHeight = 86 * gothicConfig.castleScale;
		windowGeometry = buildWindowGeometry( castle.windows, castleMatrix );
		const windowMaterial = createWindowMaterial();
		const windowMesh = new THREE.Mesh( windowGeometry, windowMaterial );
		windowMesh.name = '窗灯';
		scene.add( windowMesh );
		state.disposables.push( windowMaterial );
		castleParts = [ stone, roofs, windowMesh ];

	}

	// 窗灯在湖里的倒影光柱
	const columnGeometry = buildColumnGeometry( windowGeometry );
	const columnMaterial = createColumnMaterial( noiseTexture );
	const columns = new THREE.Mesh( columnGeometry, columnMaterial );
	columns.name = '窗灯倒影';
	columns.frustumCulled = false;
	columns.renderOrder = 5;
	scene.add( columns );
	state.columns = columns;
	state.disposables.push( windowGeometry, columnGeometry, columnMaterial );
	await yieldToBrowser();

	// 湖面
	const lakeGeometry = buildLakeGeometry();
	const lakeMaterial = createLakeMaterial( noiseTexture, state.reflectionScale > 0 );
	const lake = new THREE.Mesh( lakeGeometry, lakeMaterial );
	lake.name = '湖面';
	scene.add( lake );
	state.lake = lake;
	// 倒影跳过用的水面分块（camera.js 的 prepareMeshView），在这里取好点，不放进第一帧
	prepareMeshView( lake, { groundHeight } );
	state.disposables.push( lakeGeometry, lakeMaterial );
	if ( state.reflectorNode ) {

		scene.add( state.reflectorNode.target );
		state.reflectionPass = () => {

			if ( ! state.ready || ! state.reflectorNode || state.uniforms.mirrorAmount.value < 0.5 ) return;
			// 水面不在视锥里（转身背对水面）这一帧不画倒影（camera.js 的 isMeshInView）
			if ( ! isMeshInView( ctx.camera, state.lake, { groundHeight } ) ) return;
			state.reflectorNode.reflector.resolutionScale = reflectionResolution();
			const restore = enterReflection();
			try {

				state.reflectorNode.reflector.updateBefore( { scene: state.scene, camera: ctx.camera, renderer: ctx.renderer, material: lakeMaterial } );

			} finally {

				restore();

			}

		};

	}

	// 湖边的草（阶段 12 CP3 返工：三环，规格书 10.2）
	// 石桥的中线（草图要让开桥头那段）
	state.bridge = gothicConfig.bridge ? buildBridgePath() : null;
	await buildGrassField();
	const grassConfig = gothicConfig.grass;
	state.grass = createGrassField( {
		name: '湖边的草',
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
		seed: 3,
	} );
	scene.add( state.grass.group );

	// 崖上点灯的石阶小路
	const lanternGeometry = buildLanterns();
	const lanternMaterial = createLanternMaterial();
	const lanterns = new THREE.Mesh( lanternGeometry, lanternMaterial );
	lanterns.name = '石阶灯';
	lanterns.frustumCulled = false;
	lanterns.renderOrder = 6;
	scene.add( lanterns );
	state.disposables.push( lanternGeometry, lanternMaterial );

	// 石桥
	let bridgeMeshes = [];
	if ( state.bridge ) {

		const built = buildBridgeGeometry( state.bridge );
		const stoneMaterial = createBridgeStoneMaterial( noiseTexture );
		const stone = new THREE.Mesh( built.stone, stoneMaterial );
		stone.name = '石桥';
		stone.frustumCulled = false;
		scene.add( stone );
		state.disposables.push( built.stone, stoneMaterial );
		bridgeMeshes.push( stone );
		if ( built.lamps ) {

			const lampMaterial = createBridgeLampMaterial();
			const lamps = new THREE.Mesh( built.lamps, lampMaterial );
			lamps.name = '石桥·灯';
			lamps.frustumCulled = false;
			const haloMaterial = createBridgeHaloMaterial();
			const halos = new THREE.Mesh( built.halos, haloMaterial );
			halos.name = '石桥·灯晕';
			halos.frustumCulled = false;
			halos.renderOrder = 6;
			const poolMaterial = createBridgePoolMaterial();
			const pools = new THREE.Mesh( built.pools, poolMaterial );
			pools.name = '石桥·灯下光池';
			pools.frustumCulled = false;
			pools.renderOrder = 2;
			scene.add( lamps, pools, halos );
			state.disposables.push( built.lamps, lampMaterial, built.halos, haloMaterial, built.pools, poolMaterial );
			bridgeMeshes.push( lamps, pools, halos );

		}

		console.log( `哥特城堡：石桥 ${ built.spans } 跨、${ built.lampCount } 盏灯，${ ( built.stone.attributes.position.count / 3 ).toFixed( 0 ) } 个三角形` );

	}

	// 萤火虫、蝙蝠
	const fireflyGeometry = buildFireflies( gothicConfig.fireflies[ content ] || gothicConfig.fireflies.mid );
	const fireflyMaterial = createFireflyMaterial();
	const fireflies = new THREE.Mesh( fireflyGeometry, fireflyMaterial );
	fireflies.name = '萤火虫';
	fireflies.frustumCulled = false;
	fireflies.renderOrder = 6;
	scene.add( fireflies );
	state.disposables.push( fireflyGeometry, fireflyMaterial );
	state.bats = [];
	for ( let i = 0; i < 4; i ++ ) {

		const bat = createBat();
		scene.add( bat.mesh );
		state.bats.push( bat );

	}

	const visibility = ( ...objects ) => ( enabled ) => {

		for ( const object of objects ) object.visible = enabled;

	};
	state.layers = {
		湖岸: visibility( terrain ),
		城堡: visibility( ...castleParts ),
		窗灯: state.uniforms.windowAmount,
		窗灯倒影: state.uniforms.columnAmount,
		湖面: visibility( lake ),
		平面倒影: state.uniforms.mirrorAmount,
		月光碎路: state.uniforms.moonPath,
		月光补光: state.uniforms.moonFill,
		微波: state.uniforms.rippleAmount,
		月光轮廓: state.uniforms.moonRim,
		...state.grass.layers(),
		萤火虫: state.uniforms.fireflyAmount,
		石阶灯: state.uniforms.lanternAmount,
		石桥: visibility( ...bridgeMeshes ),
		蝙蝠: visibility( ...state.bats.map( ( bat ) => bat.mesh ) ),
		夜雾: state.uniforms.fogAmount,
	};

	state.ready = true;
	console.log( `哥特城堡：建好了，用时 ${ ( performance.now() - started ).toFixed( 0 ) } ms；窗 ${ windowGeometry.getAttribute( 'position' ).count / 4 } 扇（${ kitCastle ? '零件包模型' : '程序化兜底' }）、草 ${ state.grass.blades } 根（三环 ${ state.grass.counts.inner } / ${ state.grass.counts.outer } / ${ state.grass.counts.far }）、倒影 ${ state.reflectionScale > 0 ? state.reflectionScale + ' 倍分辨率' : '关' }` );
	return { scene };

}

// 草地图（阶段 12 CP3 返工；grass.js 的 buildGroundField）：水边 0.3 米以上的缓坡有草；块边不收（块外由远景的草地图接上）
async function buildGrassField() {

	const layout = state.layout;
	state.grassField = await buildGroundField( {
		rect: layout.rect,
		spacing: 0.5,
		heightAt: groundHeight,
		densityAt: ( x, z, slope ) => smoothJs( 0.3, 1.0, groundHeight( x, z ) - layout.lakeLevel ) * smoothJs( 0.2, 0.07, slope ) * ( bridgeAt( x, z ) === null ? 1 : 0 ),
		name: '湖岸草地图',
		yieldToBrowser: () => new Promise( ( resolve ) => setTimeout( resolve, 0 ) ),
	} );
	state.disposables.push( ...state.grassField.textures );

}

// 草落地：块里用湖岸自己的草地图，块外用远景的（grass.js 的 blendGround：密度在块边 10 米里交叉过渡）
function grassGroundAt( xz ) {

	return blendGround( state.grassField, state.ctx.backdrop, xz );

}

// 预编译：倒影目标上把场景和挂进来的远景再编一遍
export async function compile() {

	if ( ! state.ready || ! state.reflectorNode ) return;
	const ctx = state.ctx;
	const reflectorObject = state.reflectorNode.reflector;
	const virtualCamera = reflectorObject.getVirtualCamera( ctx.camera );
	const target = reflectorObject.getRenderTarget( virtualCamera );
	// 和倒影那一遍画的东西一样（城堡换 lod1、草和光柱不画）：倒影目标上只编真会画的
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

// 倒影那一遍要换掉的东西：湖面自己、窗灯光柱不画；perf.scenesA.reflectionCull 开着时岸上的草不画（眼睛离湖面 2 米多，
// 岸上的草反射交点都在岸上、不在水里），关着时草照旧画三成；hi 档城堡换 lod1。返回还原函数
function enterReflection() {

	const cull = state.ctx.config.perf.scenesA.reflectionCull;
	const saved = [];
	const hide = ( object ) => {

		saved.push( [ object, object.visible ] );
		object.visible = false;

	};
	hide( state.lake );
	if ( state.columns ) hide( state.columns );
	if ( cull ) {

		if ( state.grass ) hide( state.grass.group );

	} else if ( state.grass ) {

		state.grass.beginReflection();

	}

	if ( state.reflectionCastle && state.castleModel ) {

		saved.push( [ state.reflectionCastle, state.reflectionCastle.visible ] );
		// 跟着城堡的调试开关
		state.reflectionCastle.visible = state.castleModel.visible;
		hide( state.castleModel );

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
	const fogConfig = ctx.config.gothic.fog;
	const sky = ctx.world.uniforms;
	backdrop.setSkyVisible( true );
	backdrop.setContentHole( { ...state.layout.rect, depth: 30 } );
	backdrop.setLakeCut( 4 );
	backdrop.setNightFill( ctx.config.gothic.nightFill );
	// 湖面反上去的月光：从机位那边（岩台 → 机位的水平方向）、略微从下往上照（光从湖面来），颜色是月光乘 bounce
	const castleWorld = ctx.world.locations[ key ].landmark;
	const cameraWorld = ctx.world.locations[ key ].origin;
	state.bounceColor = state.bounceColor || new THREE.Color();
	state.bounceColor.copy( sky.moonLightColor.value ).multiplyScalar( ctx.config.gothic.lakeBounce );
	backdrop.setBounceLight( {
		direction: tempDirection.set( cameraWorld[ 0 ] - castleWorld[ 0 ], 0, cameraWorld[ 2 ] - castleWorld[ 2 ] ).normalize().setY( - 0.25 ),
		color: state.bounceColor,
	} );
	// 夜雾：从湖面往上慢慢淡掉的月光薄霭（衰减高度见 config.gothic.fog），深蓝；朝月亮那边前向散射亮（Henyey–Greenstein，g = 0.6，规格书 11.2）
	state.fogColor = state.fogColor || new THREE.Color();
	state.fogScatter = state.fogScatter || new THREE.Color();
	state.fogColor.copy( sky.horizonColor.value ).multiplyScalar( sky.skyIntensity.value * fogConfig.brightness );
	state.fogScatter.copy( sky.moonLightColor.value ).multiplyScalar( fogConfig.moonScatter );
	backdrop.setLocationFog( {
		density: fogConfig.density,
		falloff: fogConfig.falloff,
		baseHeight: ctx.world.config.lake.level,
		color: state.fogColor,
		scatterColor: state.fogScatter,
		lightDirection: tempDirection.copy( sky.moonDirection.value ),
		anisotropy: 0.6,
		amount: state.uniforms.fogAmount.value,
	} );

}

export function enter() {

	if ( ! state.ready ) throw new Error( '哥特城堡场景：还没 init 就调了 enter' );
	const ctx = state.ctx;
	if ( state.reflectionPass ) ctx.pipeline.addPrePass( state.reflectionPass );
	for ( const label of Object.keys( state.layers ) ) ctx.debug.addLayerToggle( key, label, state.layers[ label ] );
	const spawn = getSpawn();
	const walk = ctx.config.gothic.walk;
	// 石桥：桥面上的点能站、高度是桥面；岸上照旧（在 walk 的范围里、不下水）。范围框放大到把整座桥框进去
	const bridge = state.bridge;
	const insideShore = ( x, z ) => x >= walk.minX && x <= walk.maxX && ( walk.minZ === undefined || z >= walk.minZ ) && z <= walk.maxZ;
	let bounds = walk;
	if ( bridge ) {

		bounds = { minX: walk.minX, maxX: walk.maxX, minZ: walk.minZ ?? - 1e4, maxZ: walk.maxZ };
		for ( const sample of bridge.samples ) {

			bounds.minX = Math.min( bounds.minX, sample.x - 12 );
			bounds.maxX = Math.max( bounds.maxX, sample.x + 12 );
			bounds.minZ = Math.min( bounds.minZ, sample.z - 12 );
			bounds.maxZ = Math.max( bounds.maxZ, sample.z + 12 );

		}

	}

	ctx.director.setWalk( {
		position: spawn.position,
		lookAt: spawn.lookAt,
		groundHeight: ( x, z ) => {

			const deck = bridgeAt( x, z );
			return deck === null ? groundHeight( x, z ) : deck;

		},
		canWalk: ( x, z ) => bridgeAt( x, z ) !== null || ( insideShore( x, z ) && canWalk( x, z ) ),
		bounds,
		speedScale: bridge ? ( x, z ) => ( bridgeAt( x, z ) === null ? 1 : ctx.config.gothic.bridge.speedScale ) : null,
		snap: bridge ? bridgeSnap : null,
	} );
	update( 0, 0 );

}

export function update( dt, time ) {

	if ( ! state.ready ) return;
	const ctx = state.ctx;
	state.uniforms.time.value = time;
	// 窗灯按停留时间一组组亮起来（从出发地飞过来的路上已经是夜里，到了才开始亮）
	state.uniforms.windowTime.value = time;
	applyWorldSettings();
	ctx.camera.updateMatrixWorld();
	tempPoint.setFromMatrixPosition( ctx.camera.matrixWorld );
	state.grass.update( time, tempPoint, ctx, ( point ) => ctx.world.toWorld( point, key, point ) );

	// 蝙蝠：绕着最高的那座塔转圈（程序化城堡在城堡坐标 (-14, -6)，模型的主尖塔在 (-4, 2) 附近），高度在城堡高的 55%~85%，
	// 各自高度、半径、方向不同，偶尔离开圈子再回来
	const layout = state.layout;
	const cosine = Math.cos( layout.facing );
	const sine = Math.sin( layout.facing );
	state.bats.forEach( ( bat, index ) => {

		const speed = 0.35 + index * 0.07;
		const angle = time * speed * ( index % 2 === 0 ? 1 : - 1 ) + index * 1.7;
		const radius = 18 + index * 6 + Math.sin( time * 0.13 + index ) * 8;
		const towerX = state.castleModel ? - 4 : - 14;
		const towerZ = state.castleModel ? 2 : - 6;
		const localX = towerX + Math.cos( angle ) * radius;
		const localZ = towerZ + Math.sin( angle ) * radius;
		const scale = state.castleModel ? state.ctx.config.gothic.modelScale : state.ctx.config.gothic.castleScale;
		const height = state.castleHeight * ( 0.55 + index * 0.06 ) + Math.sin( time * 0.5 + index * 2 ) * 4 * scale;
		bat.mesh.position.set( layout.castle.x + ( localX * cosine + localZ * sine ) * scale, layout.castle.y + height, layout.castle.z + ( - localX * sine + localZ * cosine ) * scale );
		const headingX = - Math.sin( angle ) * ( index % 2 === 0 ? 1 : - 1 );
		const headingZ = Math.cos( angle ) * ( index % 2 === 0 ? 1 : - 1 );
		bat.mesh.lookAt( bat.mesh.position.x + headingX * cosine + headingZ * sine, bat.mesh.position.y, bat.mesh.position.z - headingX * sine + headingZ * cosine );
		bat.flapUniform.value = time * ( 14 + index * 2 );

	} );

}

export function exit() {

	if ( ! state.ctx ) return;
	const ctx = state.ctx;
	if ( state.reflectionPass ) ctx.pipeline.removePrePass( state.reflectionPass );
	ctx.debug.removeSceneToggles( key );
	ctx.director.clearWalk();

}

function releaseResources() {

	for ( const item of state.disposables ) if ( item && typeof item.dispose === 'function' ) item.dispose();
	state.disposables = [];
	if ( state.grass ) state.grass.dispose();
	if ( state.reflectorNode ) state.reflectorNode.dispose();
	state.grass = null;
	state.reflectorNode = null;
	state.reflectionPass = null;
	state.bats = [];
	// 倒影城堡只放几何体（材质借的近处级，下面跟着近处级一起放）
	if ( state.reflectionCastle ) disposeGeometries( state.reflectionCastle );
	state.reflectionCastle = null;
	if ( state.castleModel ) disposeModel( state.castleModel );
	state.castleModel = null;
	state.castleHeight = 0;
	state.lake = null;
	state.columns = null;

}

export function dispose() {

	if ( ! state.scene && state.disposables.length === 0 ) return;
	state.ready = false;
	if ( state.ctx && state.reflectionPass ) state.ctx.pipeline.removePrePass( state.reflectionPass );
	releaseResources();
	if ( state.scene ) state.scene.clear();
	state.scene = null;
	state.heights = null;
	state.layout = null;
	state.grassField = null;
	state.layers = {};
	state.ctx = null;
	console.log( '哥特城堡场景：已释放' );

}

// ===================== 截图、烘焙、调试 =====================

export function groundHeightAt( x, z ) {

	return groundHeight( x, z );

}

// 出生点：机位原点（站在地面上），看向湖对岸崖上的城堡
export function getSpawn() {

	const eye = groundHeight( 0, 0 ) + state.ctx.config.camera.eyeHeight;
	const castle = state.layout ? state.layout.castle : new THREE.Vector3( 0, 40, - 600 );
	return { position: [ 0, eye, 0 ], lookAt: [ castle.x, castle.y + 22, castle.z ] };

}

export function getShotViews() {

	const spawn = getSpawn();
	const castle = state.layout.castle;
	return [
		{ name: '出生点', ...spawn },
		{ name: '水边', position: [ 12, groundHeight( 12, 4 ) + 1.2, 4 ], lookAt: [ castle.x, castle.y + 10, castle.z ] },
		{ name: '低头看倒影', position: [ 0, spawn.position[ 1 ], 0 ], lookAt: [ castle.x * 0.3, - 30, castle.z * 0.3 ] },
	];

}

export function getLayers() {

	return state.layers;

}
