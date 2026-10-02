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
	normalize, length, dot, max, min, mix, smoothstep, pow, abs, sin, cos, floor, fract, reflect, fwidth, exp, Discard,
} from 'three/tsl';
import { reflector } from 'three/tsl';
import { NodeUpdateType } from 'three/webgpu';
import { createGrass } from '../tsl/grass.js';
import { jsFbm2D, createNoiseTextureData } from '../tsl/noise.js';
import { daySkyColor } from '../tsl/sky.js';

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
	bats: [],
	enteredAt: 0,
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
		const albedo = mix( mud, mix( pebbles, grass, smoothstep( 0.6, 1.4, aboveLake.add( patch.sub( 0.5 ) ) ) ), smoothstep( - 0.1, 0.15, aboveLake ) );
		const lit = state.ctx.backdrop.worldLighting( albedo, normal, point, { skyView: float( 0.9 ), wrap: 0.25 } );
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
		const toViewer = normalize( cameraPosition.sub( point ) );
		const footprint = max( length( fwidth( point ) ), 0.001 );
		// 夜里的微风：两层噪声梯度慢慢漂；远处像素大了淡掉
		const drift = vec2( uniforms.time.mul( 0.03 ), uniforms.time.mul( 0.017 ) );
		const coarse = texture( noiseTexture, point.xz.div( 11 ).add( drift ) ).ba.sub( 0.5 ).mul( float( 1 ).sub( smoothstep( 0.5, 3, footprint ) ) );
		const fine = texture( noiseTexture, point.xz.div( 3.1 ).sub( drift.mul( 1.7 ) ) ).ba.sub( 0.5 ).mul( float( 1 ).sub( smoothstep( 0.08, 0.5, footprint ) ) );
		const gradient = coarse.mul( 0.05 ).add( fine.mul( 0.025 ) ).mul( uniforms.rippleAmount );
		const normal = normalize( vec3( gradient.x.negate(), 1, gradient.y.negate() ) );
		const reflected = reflect( toViewer.negate(), normal );
		const worldReflected = state.ctx.backdrop.sceneDirectionToWorld( reflected );
		const skyColor = daySkyColor( vec3( worldReflected.x, max( worldReflected.y, 0.01 ), worldReflected.z ), sky, uniforms.time, { sunDisc: false, stars: false } ).toVar();
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
		const halfVector = normalize( moonDirection.add( viewWorld ) );
		const cosine = max( dot( normalWorldLake, halfVector ), 1e-3 );
		const cosineSquared = cosine.mul( cosine );
		const roughness = float( 0.012 );
		const beckmann = exp( cosineSquared.sub( 1 ).div( cosineSquared.mul( roughness ) ) ).div( roughness.mul( Math.PI ).mul( cosineSquared ).mul( cosineSquared ) );
		const glint = sky.moonLightColor.mul( beckmann.mul( 0.02 ).div( facing.mul( 4 ) ) ).mul( smoothstep( - 0.02, 0.03, moonDirection.y ) ).mul( uniforms.moonPath );
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

	// 城堡（城堡自己的坐标 → 场景：平移到崖顶、转到正面朝机位）
	const castle = buildCastle( createRandom( 1185 ) );
	const castleMatrix = new THREE.Matrix4().makeTranslation( layout.castle.x, layout.castle.y, layout.castle.z ).multiply( new THREE.Matrix4().makeRotationY( layout.facing ) ).multiply( new THREE.Matrix4().makeScale( gothicConfig.castleScale, gothicConfig.castleScale, gothicConfig.castleScale ) );
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

	// 窗灯和它们的倒影光柱
	const windowGeometry = buildWindowGeometry( castle.windows, castleMatrix );
	const windowMaterial = createWindowMaterial();
	const windowMesh = new THREE.Mesh( windowGeometry, windowMaterial );
	windowMesh.name = '窗灯';
	scene.add( windowMesh );
	const columnGeometry = buildColumnGeometry( windowGeometry );
	const columnMaterial = createColumnMaterial( noiseTexture );
	const columns = new THREE.Mesh( columnGeometry, columnMaterial );
	columns.name = '窗灯倒影';
	columns.frustumCulled = false;
	columns.renderOrder = 5;
	scene.add( columns );
	state.disposables.push( windowGeometry, windowMaterial, columnGeometry, columnMaterial );
	await yieldToBrowser();

	// 湖面
	const lakeGeometry = buildLakeGeometry();
	const lakeMaterial = createLakeMaterial( noiseTexture, state.reflectionScale > 0 );
	const lake = new THREE.Mesh( lakeGeometry, lakeMaterial );
	lake.name = '湖面';
	scene.add( lake );
	state.lake = lake;
	state.disposables.push( lakeGeometry, lakeMaterial );
	if ( state.reflectorNode ) {

		scene.add( state.reflectorNode.target );
		state.reflectionPass = () => {

			if ( ! state.ready || ! state.reflectorNode || state.uniforms.mirrorAmount.value < 0.5 ) return;
			state.lake.visible = false;
			columns.visible = false;
			try {

				state.reflectorNode.reflector.updateBefore( { scene: state.scene, camera: ctx.camera, renderer: ctx.renderer, material: lakeMaterial } );

			} finally {

				state.lake.visible = true;
				columns.visible = true;

			}

		};

	}

	// 湖边的草
	const grassConfig = gothicConfig.grass;
	const fieldTexture = buildGrassField();
	state.grass = createGrass( {
		radius: grassConfig.radius,
		spacing: grassConfig.spacing[ content ] || grassConfig.spacing.mid,
		height: grassConfig.height,
		width: grassConfig.width,
		field: ( xz ) => {

			const rect = layout.rect;
			const uv = xz.sub( vec2( rect.minX, rect.minZ ) ).div( vec2( rect.maxX - rect.minX, rect.maxZ - rect.minZ ) );
			const sample = texture( fieldTexture, uv ).level( 0 );
			const inside = uv.x.greaterThan( 0 ).and( uv.x.lessThan( 1 ) ).and( uv.y.greaterThan( 0 ) ).and( uv.y.lessThan( 1 ) );
			return vec2( sample.r, select( inside, sample.g, float( 0 ) ) );

		},
		colors: { base: '#24331f', tip: '#5b7046', dry: '#6d6a52' },
		wind: [ 0.6, - 0.8 ],
		shade: shadeThin,
		name: '湖边的草',
	} );
	scene.add( state.grass.mesh );

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
		城堡: visibility( stone, roofs ),
		窗灯: state.uniforms.windowAmount,
		窗灯倒影: state.uniforms.columnAmount,
		湖面: visibility( lake ),
		平面倒影: state.uniforms.mirrorAmount,
		月光碎路: state.uniforms.moonPath,
		月光补光: state.uniforms.moonFill,
		微波: state.uniforms.rippleAmount,
		月光轮廓: state.uniforms.moonRim,
		草: state.grass.uniforms.amount,
		萤火虫: state.uniforms.fireflyAmount,
		蝙蝠: visibility( ...state.bats.map( ( bat ) => bat.mesh ) ),
		夜雾: state.uniforms.fogAmount,
	};

	state.ready = true;
	console.log( `哥特城堡：建好了，用时 ${ ( performance.now() - started ).toFixed( 0 ) } ms；窗 ${ castle.windows.length } 扇、草 ${ state.grass.blades } 根、倒影 ${ state.reflectionScale > 0 ? state.reflectionScale + ' 倍分辨率' : '关' }` );
	return { scene };

}

// 草地图（半精度 RG：地面高度、密度）：水边 0.3 米以上的缓坡有草
function buildGrassField() {

	const rect = state.layout.rect;
	const spacing = 0.75;
	const width = Math.round( ( rect.maxX - rect.minX ) / spacing ) + 1;
	const height = Math.round( ( rect.maxZ - rect.minZ ) / spacing ) + 1;
	const data = new Uint16Array( width * height * 4 );
	for ( let j = 0; j < height; j ++ ) {

		for ( let i = 0; i < width; i ++ ) {

			const x = rect.minX + i * spacing;
			const z = rect.minZ + j * spacing;
			const ground = groundHeight( x, z );
			const slope = Math.hypot( groundHeight( x + 0.75, z ) - groundHeight( x - 0.75, z ), groundHeight( x, z + 0.75 ) - groundHeight( x, z - 0.75 ) ) / 1.5;
			const edge = Math.min( x - rect.minX, rect.maxX - x, z - rect.minZ, rect.maxZ - z );
			const density = smoothJs( 0.3, 1.0, ground - state.layout.lakeLevel ) * smoothJs( 0.7, 0.35, slope ) * smoothJs( 3, 12, edge ) * ( 0.6 + 0.4 * smoothJs( 0.3, 0.6, jsFbm2D( x / 6, z / 6, 2 ) ) );
			const index = ( j * width + i ) * 4;
			data[ index ] = THREE.DataUtils.toHalfFloat( ground );
			data[ index + 1 ] = THREE.DataUtils.toHalfFloat( density );
			data[ index + 3 ] = THREE.DataUtils.toHalfFloat( 1 );

		}

	}

	const fieldTexture = new THREE.DataTexture( data, width, height, THREE.RGBAFormat, THREE.HalfFloatType );
	fieldTexture.magFilter = THREE.LinearFilter;
	fieldTexture.minFilter = THREE.LinearFilter;
	fieldTexture.generateMipmaps = false;
	fieldTexture.needsUpdate = true;
	state.disposables.push( fieldTexture );
	return fieldTexture;

}

// 预编译：倒影目标上把场景和挂进来的远景再编一遍
export async function compile() {

	if ( ! state.ready || ! state.reflectorNode ) return;
	const ctx = state.ctx;
	const reflectorObject = state.reflectorNode.reflector;
	const virtualCamera = reflectorObject.getVirtualCamera( ctx.camera );
	const target = reflectorObject.getRenderTarget( virtualCamera );
	state.lake.visible = false;
	let jobs;
	try {

		jobs = [
			ctx.pipeline.compileScene( state.scene, virtualCamera, null, target ),
			ctx.pipeline.compileScene( ctx.backdrop.getRoot(), virtualCamera, state.scene, target ),
		];

	} finally {

		state.lake.visible = true;

	}

	await Promise.all( jobs );

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
	// 夜雾：贴着湖面（衰减高度 9 米），深蓝；朝月亮那边前向散射亮（Henyey–Greenstein，g = 0.6，规格书 11.2）
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
	ctx.director.setWalk( {
		position: spawn.position,
		lookAt: spawn.lookAt,
		groundHeight,
		canWalk,
		bounds: walk,
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
	state.grass.uniforms.time.value = time;
	state.grass.uniforms.center.value.set( tempPoint.x, tempPoint.z );

	// 蝙蝠：绕着最高的那座塔（城堡坐标 (-14, -6)，尖顶约 86 米）转圈，各自高度、半径、方向不同，偶尔离开圈子再回来
	const layout = state.layout;
	const cosine = Math.cos( layout.facing );
	const sine = Math.sin( layout.facing );
	state.bats.forEach( ( bat, index ) => {

		const speed = 0.35 + index * 0.07;
		const angle = time * speed * ( index % 2 === 0 ? 1 : - 1 ) + index * 1.7;
		const radius = 18 + index * 6 + Math.sin( time * 0.13 + index ) * 8;
		const localX = - 14 + Math.cos( angle ) * radius;
		const localZ = - 6 + Math.sin( angle ) * radius;
		const height = 62 + index * 7 + Math.sin( time * 0.5 + index * 2 ) * 4;
		const scale = state.ctx.config.gothic.castleScale;
		bat.mesh.position.set( layout.castle.x + ( localX * cosine + localZ * sine ) * scale, layout.castle.y + height * scale, layout.castle.z + ( - localX * sine + localZ * cosine ) * scale );
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
