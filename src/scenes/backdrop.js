// 常驻远景（秘境）：世界地形（海画在地形顶点里，湖、河和花园水池画在地表图里）、统一天空和薄云、树林、各地点的替身、窗灯。
// 规格书 4、5.0、5.3、6.4。
//
// 所有东西都在世界坐标里建，挂在 root 下：秘境俯瞰模式 root 是单位变换；4b 起挂进各地点的场景时，root 用 world.worldToAnchorMatrix() 换到地点的局部坐标。
// 着色全在世界坐标里算：几何体坐标就是世界坐标，相机的世界坐标 = sceneToWorld × cameraPosition（换了相机的反射 pass 也对）。
// 远处的顶点做"径向深度压缩"：compressStart 以外沿视线拉近，屏幕位置不变、只改深度，给 4b 里 far = 2000 的地点相机用；俯瞰模式不压。
// 做法参照 three r186 自带的 TerrainGenerator（大气透视、岩层）和 ForestGenerator（一次实例化画完所有树、按距离随机稀疏）。
// 山洞的洞壁和洞口近景放到阶段 7（开场序列）一起做，这里只在地形上留好洞口前的平台和洞顶的山梁（world.js）。
//
// 着色器里的几条规矩（Metal / Vulkan 上的坑）：pow 的底数一律先夹到 ≥ 0（平方用 pow2）；
// 要在分支里用的贴图取样和屏幕导数，先在分支外 toVar 落地（TSL 按第一次用到的位置生成代码）。

import * as THREE from 'three/webgpu';
import {
	Fn, If, float, vec2, vec3, vec4, uniform, attribute, texture, color, varying,
	positionLocal, positionWorld, positionGeometry, normalGeometry, normalWorld, modelWorldMatrix,
	cameraPosition, cameraViewMatrix, cameraProjectionMatrix, screenSize,
	normalize, length, dot, max, min, mix, smoothstep, exp, pow, abs, sin, fwidth, reflect, step,
} from 'three/tsl';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { jsFbm2D, createNoiseTextureData, sampleNoiseTexture } from '../tsl/noise.js';
import { daySkyColor, dayAerialColor } from '../tsl/sky.js';
import { heightFogFactor, henyeyGreenstein } from '../tsl/fog.js';
import { seaStacks } from './sunset.js';

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

	return ctx.quality && ctx.quality.tier ? ctx.quality.tier : 'mid';

}

// 着色器里的递减 smoothstep：1 - smoothstep(low, high, x)，不写 edge0 > edge1 的 smoothstep
function fadeOut( low, high, value ) {

	return float( 1 ).sub( smoothstep( low, high, value ) );

}

// ===================== 模块状态 =====================

const state = {
	ctx: null,
	world: null,
	scene: null,
	root: null,
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
	core: null,
	outer: null,
	horizon: null,
	windDirection: new THREE.Vector2( 1, 0 ),
};

const tempVector = new THREE.Vector3();
const tempMatrix = new THREE.Matrix4();
const cloudSunWarm = new THREE.Color( '#ff8a5c' );
const cloudSunWhite = new THREE.Color( '#fff2e0' );

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

// 网格上的双线性高度；出了网格返回 NaN
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
	const bottom = heights[ index ] + ( heights[ index + 1 ] - heights[ index ] ) * fractionX;
	const top = heights[ index + grid.countX ] + ( heights[ index + grid.countX + 1 ] - heights[ index + grid.countX ] ) * fractionX;
	return bottom + ( top - bottom ) * fractionZ;

}

// 远景地形的高度（就是网格画出来的高度）：核心区用细网格，外圈用粗网格，再往外当海平面
function terrainHeightAt( x, z ) {

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
	geometry.setIndex( positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute( indices, 1 ) : new THREE.Uint16BufferAttribute( indices, 1 ) );
	geometry.computeBoundingSphere();
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
		const peach = smoothJs( 170, 60, nearest.distance ) * smoothJs( 1690, 1770, z ) * smoothJs( 45, 20, aboveStream );
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
		const lit = smoothstep( angle.sub( penumbra ), angle.add( penumbra ), elevation );
		shadow.assign( mix( float( 1 ), lit, uniforms.insideCoreWide( point ) ) );

	} );
	return shadow;

}

// 夜色：天暗下来以后，反照率去饱和、偏蓝（夜里人眼看不出绿，月光下的草地是灰蓝的）
function nightAlbedo( albedo ) {

	const sky = state.world.uniforms;
	const night = fadeOut( 0.1, 0.5, sky.skyIntensity );
	const gray = dot( albedo, vec3( lumaWeights[ 0 ], lumaWeights[ 1 ], lumaWeights[ 2 ] ) );
	return mix( albedo, vec3( 0.62, 0.72, 0.88 ).mul( gray ), night.mul( 0.4 ) );

}

// 光照：太阳（包裹光照，带地形阴影）+ 月亮（阴影里也有一点月色的半球补光，夜里亮暗比不会像墨团）
// + 天空半球光（山谷里看到的天少）+ 一点地面反光
function lightAt( normal, sunShadow, moonShadow, skyView, wrap = 0.2 ) {

	const sky = state.world.uniforms;
	const sunDiffuse = dot( normal, sky.sunDirection ).add( wrap ).div( 1 + wrap ).clamp();
	const moonDiffuse = dot( normal, sky.moonDirection ).add( wrap ).div( 1 + wrap ).clamp();
	const skyColor = mix( sky.horizonColor, sky.zenithColor, normal.y.mul( 0.5 ).add( 0.5 ) ).mul( sky.skyIntensity );
	const bounce = sky.sunLightColor.mul( max( sky.sunDirection.y, 0 ) ).mul( float( 1 ).sub( normal.y ).mul( 0.04 ) );
	const moonFill = sky.moonLightColor.mul( normal.y.mul( 0.5 ).add( 0.5 ) ).mul( skyView ).mul( 0.12 );
	return sky.sunLightColor.mul( sunDiffuse.mul( sunShadow ) )
		.add( sky.moonLightColor.mul( moonDiffuse.mul( moonShadow ) ) )
		.add( moonFill )
		.add( skyColor.mul( skyView ).mul( state.uniforms.ambientStrength ) )
		.add( bounce );

}

// 大气透视 + 贴地薄雾。透视的颜色就是天空贴地平线那一圈（dayAerialColor），远山溶进天里看不出接缝；
// 外圈地形的边缘也溶进去，看不出世界的边
function applyAtmosphere( surface, point, viewer ) {

	const sky = state.world.uniforms;
	const uniforms = state.uniforms;
	const worldConfig = state.world.config;
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
	return mix( hazed, mistColor, mist );

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

// ===================== 地形材质 =====================

function createTerrainMaterial() {

	const sky = state.world.uniforms;
	const uniforms = state.uniforms;
	const toggles = state.toggles;
	const biomeTexture = state.textures.biome.texture;

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '远景地形';
	material.fog = false;
	material.positionNode = compressedPosition( positionLocal );

	material.colorNode = Fn( () => {

		const point = positionGeometry;   // 几何体就建在世界坐标里
		const viewer = viewerPosition();
		const toPoint = point.sub( viewer );
		const distance = max( length( toPoint ), 1e-3 );
		const viewDirection = toPoint.div( distance );
		const toViewer = viewDirection.negate();
		const xz = point.xz;
		const height = point.y;
		const geometryNormal = normalize( normalGeometry );
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
		// 草地：黄绿和翠绿按大斑块交替，高处的草甸偏黄褐
		const meadow = mix( color( '#7d9a58' ), color( '#a3b46a' ), smoothstep( 0.3, 0.7, largePatch ) ).mul( mediumPatch.mul( 0.25 ).add( 0.85 ) );
		const albedo = mix( meadow, color( '#a29770' ), smoothstep( 260, 460, height ).mul( 0.6 ) ).mul( smallPatch.mul( 0.2 ).add( 0.9 ) ).toVar();

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
		const rock = smoothstep( 0.38, 0.6, slope.add( mediumPatch.sub( 0.5 ).mul( 0.22 ) ) );
		const strata = sin( height.mul( 0.11 ).add( point.x.mul( 0.008 ) ).add( largePatch.mul( 9 ) ) ).mul( 0.6 )
			.add( sin( height.mul( 0.29 ).add( mediumPatch.mul( 5 ) ) ).mul( 0.4 ) ).mul( 0.5 ).add( 0.5 );
		const rockColor = mix( color( '#8f887d' ), color( '#6c6763' ), strata.mul( 0.35 ).add( mediumPatch.mul( 0.65 ) ) ).mul( smallPatch.mul( 0.2 ).add( 0.9 ) );
		albedo.assign( mix( albedo, rockColor, rock ) );

		// 海边的沙滩
		const beach = terrainInfo.y.mul( fadeOut( 1.8, 4.5, height ) ).mul( float( 1 ).sub( rock ) );
		albedo.assign( mix( albedo, color( '#d8c9a6' ), beach ) );

		// 雪：雪原台地上全是雪；别处只有 600 米上下的山顶戴雪帽；太陡的岩壁挂不住雪；风吹的雪窝颜色稍冷
		const snowLine = float( 600 ).add( largePatch.sub( 0.5 ).mul( 140 ) );
		const snowCover = max( smoothstep( snowLine.sub( 25 ), snowLine.add( 25 ), height ), smoothstep( 0.4, 0.9, terrainInfo.z ) );
		const snow = snowCover.mul( float( 1 ).sub( smoothstep( 0.38, 0.62, slope.add( mediumPatch.sub( 0.5 ).mul( 0.15 ) ) ).mul( 0.85 ) ) );
		const snowColor = mix( color( '#eef3fa' ), color( '#d3dcea' ), smoothstep( 0.3, 0.75, smallPatch ).mul( 0.5 ) );
		albedo.assign( mix( albedo, snowColor, snow ) );

		// 冰瀑：台地南缘、小镇溪源头上方那一段崖壁结着冰（偏蓝、亮、带一点镜面）
		const iceFall = exp( point.x.sub( uniforms.iceFallX ).div( 28 ).pow2().negate() )
			.mul( smoothstep( uniforms.iceFallBottom.sub( 15 ), uniforms.iceFallBottom.add( 5 ), height ) )
			.mul( smoothstep( 0.22, 0.45, slope ) )
			.mul( smoothstep( uniforms.iceFallZ.x.sub( 15 ), uniforms.iceFallZ.x.add( 15 ), point.z ) )
			.mul( fadeOut( uniforms.iceFallZ.y.sub( 15 ), uniforms.iceFallZ.y.add( 15 ), point.z ) );
		albedo.assign( mix( albedo, color( '#cfe6fb' ), iceFall ) );
		albedo.assign( nightAlbedo( albedo ) );

		// ---------- 细节起伏：直接用噪声贴图里的梯度通道扰动法线（对 8 位噪声求屏幕导数会出等高线和棋盘格）----------
		const reliefAmplitude = mix( float( 1.2 ), float( 3.5 ), rock ).mul( mix( float( 1 ), float( 0.2 ), snow ) ).mul( fadeOut( 8, 30, footprint ) ).mul( toggles.地表细节 );
		const reliefSlope = noiseGradientWorld( 'relief', reliefSample ).mul( reliefAmplitude );
		const normal = normalize( geometryNormal.sub( vec3( reliefSlope.x, 0, reliefSlope.y ) ) );

		// ---------- 光照 ----------
		const sunShadow = terrainShadow( point, uniforms.sunHorizon, sky.sunElevation, 1.3 );
		const moonShadow = terrainShadow( point, uniforms.moonHorizon, sky.moonElevation, 3 );
		const skyView = mix( float( 0.85 ), biome.a, uniforms.insideCoreWide( point ) ).mul( toggles.天光遮蔽 ).add( float( 1 ).sub( toggles.天光遮蔽 ) );
		const surface = albedo.mul( lightAt( normal, sunShadow, moonShadow, skyView ) ).toVar();

		// 冰瀑和雪在逆光里的一点镜面（掠射时亮）
		const grazing = max( float( 1 ).sub( max( dot( normal, toViewer ), 0 ) ), 0 );
		const sheen = pow( grazing, 4 ).mul( snow.mul( 0.12 ).add( iceFall.mul( 0.2 ) ) );
		surface.addAssign( sky.sunLightColor.mul( sunShadow ).add( sky.moonLightColor.mul( moonShadow ) ).mul( sheen ) );

		// ---------- 水：海按顶点（海岸线由顶点插值），湖、河、水池按地表图（4 米一个像素，按像素足迹软边）----------
		const seaWater = smoothstep( - 0.04, 0.04, terrainInfo.x );
		const insideWater = biome.r.sub( 0.5 ).mul( 16 );   // 米，水里为正
		const inlandWater = smoothstep( footprint.mul( - 0.6 ), footprint.mul( 0.6 ), insideWater ).mul( insideCore );
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
			const glint = ( lightDirection, lightColor, shadow ) => {

				const halfVector = normalize( lightDirection.add( toViewer ) );
				const cosine = max( dot( waterNormal, halfVector ), 1e-3 );
				const cosineSquared = cosine.mul( cosine );
				const beckmann = exp( cosineSquared.sub( 1 ).div( cosineSquared.mul( roughness ) ) ).div( roughness.mul( Math.PI ).mul( cosineSquared ).mul( cosineSquared ) );
				const glintFresnel = float( 0.02 ).add( pow( max( float( 1 ).sub( max( dot( toViewer, halfVector ), 0 ) ), 0 ), 5 ).mul( 0.98 ) );
				return lightColor.mul( beckmann.mul( glintFresnel ).div( facing.mul( 4 ) ) ).mul( shadow ).mul( smoothstep( - 0.02, 0.02, lightDirection.y ) );

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

	const treeData = attribute( 'treeData', 'vec4' );    // rgb 树冠色（线性），w 随机数
	const treeBase = attribute( 'treeBase', 'vec3' );    // 树根的世界坐标

	// 按距离随机稀疏：t = (距离 − from) / (to − from)，随机数小于 t 的树收成一个点（positionLocal 已经乘过实例矩阵）
	const viewer = viewerPosition();
	const thinning = length( treeBase.sub( viewer ) ).sub( uniforms.forestFrom ).div( uniforms.forestTo.sub( uniforms.forestFrom ) );
	const keep = step( thinning, treeData.w ).mul( state.toggles.树林显示 );
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

// 不种树的地方：每个地点脚下 150 米（地点自己有近景）、小镇的每座房子，以及几条要留出来的视线
// （落日回身看崖上的哥特城堡和花园城堡、星月夜看湖和小镇、哥特机位看城堡、花园看城堡），视线两侧各 30 米
function treeClearings( world ) {

	const locations = world.locations;
	const circles = Object.values( locations ).map( ( location ) => [ location.origin[ 0 ], location.origin[ 2 ], 150 ] );
	for ( const [ houseX, houseZ, radius ] of state.houseFootprints ) circles.push( [ houseX, houseZ, radius + 4 ] );
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
	return { circles, sightlines };

}

function insideClearing( clearings, x, z ) {

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
	const spacing = tier === 'lo' ? 18 : 11;
	const random = createRandom( 20261001 );
	// 二十面体不细分（12 个顶点，ForestGenerator 的默认做法）：3 万多棵树，顶点数是主要开销；树都在几百米外，看不出棱角。
	// 三种树：阔叶（圆）、针叶（高、尖、平底）、桃树（矮、粉）；半径、高（米）直接烘进几何体
	const kinds = {
		broadleaf: { geometry: blobGeometry( 0, 4.2, 10, 0.45, 0.35, false ), items: [], colors: [ '#4a6b3e', '#62803f' ] },
		conifer: { geometry: blobGeometry( 0, 2.6, 15, 0.85, 0.15, true ), items: [], colors: [ '#2b4636', '#3a553c' ] },
		peach: { geometry: blobGeometry( 0, 3, 5.5, 0.35, 0.3, false ), items: [], colors: [ '#f0b0c4', '#f9d6e0' ] },
	};
	const tintFirst = new THREE.Color();
	const tintSecond = new THREE.Color();
	const clearings = treeClearings( state.world );

	for ( let z = core.minZ + spacing; z < core.minZ + core.sizeZ - spacing; z += spacing ) {

		for ( let x = core.minX + spacing; x < core.minX + core.sizeX - spacing; x += spacing ) {

			const jitterX = x + ( random() - 0.5 ) * spacing * 0.9;
			const jitterZ = z + ( random() - 0.5 ) * spacing * 0.9;
			if ( insideClearing( clearings, jitterX, jitterZ ) ) {

				random();
				random();
				continue;

			}

			const height = gridHeight( core, jitterX, jitterZ );
			const nearestIndex = Math.round( ( jitterZ - core.minZ ) / core.spacing ) * core.countX + Math.round( ( jitterX - core.minX ) / core.spacing );
			if ( core.depths[ nearestIndex ] > - 1 ) continue;                    // 海里、湖面上不长
			if ( biomeAt( jitterX, jitterZ, 0 ) > 0.4 ) continue;                // 湖边、河边留出来（R 通道 0.5 是水边）
			// 坡度在抖动后的位置上用网格高度做中心差分（不能拿最近格点的法线：崖上会对不上）
			const slopeX = ( gridHeight( core, jitterX + 2, jitterZ ) - gridHeight( core, jitterX - 2, jitterZ ) ) / 4;
			const slopeZ = ( gridHeight( core, jitterX, jitterZ + 2 ) - gridHeight( core, jitterX, jitterZ - 2 ) ) / 4;
			const slope = 1 - 1 / Math.hypot( slopeX, 1, slopeZ );
			if ( ! ( slope < 0.25 ) ) continue;
			const flowers = biomeAt( jitterX, jitterZ, 2 );
			const peach = biomeAt( jitterX, jitterZ, 1 );
			const roll = random();

			let kind = null;
			if ( peach > 0.25 && roll < peach * 0.9 ) {

				kind = 'peach';

			} else if ( roll < forestMaskJs( jitterX, jitterZ, height, slope, flowers, peach ) * 0.95 ) {

				// 低处阔叶为主，高处针叶为主
				kind = random() < smoothJs( 120, 300, height ) * 0.9 + 0.05 ? 'conifer' : 'broadleaf';

			}

			if ( ! kind ) continue;
			const size = 0.7 + random() * random() * 0.55;   // 大多数中等，少数大一些
			// 树根往下沉一点，坡上沉得多一些，免得下坡那一侧悬空
			const sink = 0.6 + 4 * size * slope;
			kinds[ kind ].items.push( { x: jitterX, y: height - sink, z: jitterZ, size, tint: random(), yaw: random() * Math.PI * 2, cull: random() } );

		}

		await yieldIfBusy( slice );

	}

	const material = createForestMaterial();
	state.disposables.push( material );
	const placement = new THREE.Object3D();
	const meshes = [];

	for ( const [ name, kind ] of Object.entries( kinds ) ) {

		const count = kind.items.length;
		state.disposables.push( kind.geometry );
		if ( count === 0 ) continue;
		const treeData = new Float32Array( count * 4 );
		const treeBase = new Float32Array( count * 3 );
		const mesh = new THREE.InstancedMesh( kind.geometry, material, count );
		tintFirst.set( kind.colors[ 0 ] );
		tintSecond.set( kind.colors[ 1 ] );

		kind.items.forEach( ( item, index ) => {

			placement.position.set( item.x, item.y, item.z );
			placement.rotation.set( 0, item.yaw, 0 );
			placement.scale.setScalar( item.size );
			placement.updateMatrix();
			mesh.setMatrixAt( index, placement.matrix );
			const tint = tintFirst.clone().lerp( tintSecond, item.tint );
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

	console.log( `远景：树林 阔叶 ${ kinds.broadleaf.items.length }、针叶 ${ kinds.conifer.items.length }、桃树 ${ kinds.peach.items.length } 棵` );
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

function buildGothicCastle( world, windows ) {

	const gothic = world.locations.gothic;
	const [ castleX, , castleZ ] = gothic.landmark;
	const groundY = world.worldHeight( castleX, castleZ );
	// 正面朝湖对岸的机位
	const facing = Math.atan2( gothic.origin[ 0 ] - castleX, gothic.origin[ 2 ] - castleZ );
	const cosine = Math.cos( facing );
	const sine = Math.sin( facing );
	const toWorld = ( x, y, z ) => [ castleX + x * cosine + z * sine, groundY + y, castleZ - x * sine + z * cosine ];
	const stone = '#545a72';
	const roof = '#2c3247';
	const parts = [];
	const random = createRandom( 1185 );

	// 窗户：本地坐标的中心 + 朝外的方向，记下楼层高度比例（从下往上亮）；朝外方向也换到世界坐标（侧着看时窗灯变暗）
	function addWindow( x, y, z, outwardX, outwardZ, topHeight, width = 1.1, height = 1.9 ) {

		const [ worldX, worldY, worldZ ] = toWorld( x + outwardX * 0.3, y, z + outwardZ * 0.3 );
		const normalX = outwardX * cosine + outwardZ * sine;
		const normalZ = - outwardX * sine + outwardZ * cosine;
		windows.push( { x: worldX, y: worldY, z: worldZ, normalX, normalZ, width, height, floor: y / topHeight, random: random() } );

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

	return [ mergeToWorld( parts, castleX, groundY, castleZ, facing ) ];

}

// ===================== 替身：星月夜的小镇（溪边几十座小房子 + 教堂尖塔）=====================
// 星月夜机位、小镇、哥特城堡差不多在一条线上（都在 160° 方位），房子不能挡住"湖和城堡窗灯"（规格书 5.0）：
// 从机位看，去城堡和去湖心那两条视线左右各 4° 的楔形里不盖房子，教堂挪到视线左边

function buildTown( world, windows ) {

	const starry = world.locations.starry;
	const [ centerX, , centerZ ] = starry.landmark;
	const stream = world.getRiver( 'townStream' );
	const random = createRandom( 1889 );
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
				width: 0.9, height: 1.2, floor: random() * 0.6, random: random(),
			} );

		}

		state.houseFootprints.push( [ x, z, Math.hypot( width, depth ) / 2 ] );

	}

	// 教堂：中殿 + 方塔 + 四棱尖顶（原画里那座细高的教堂尖塔）；放在机位视线左边约 50 米，不挡城堡
	const leftAzimuth = keepClearAzimuths[ 0 ] - Math.PI / 2;
	const churchX = centerX + Math.sin( leftAzimuth ) * 50;
	const churchZ = centerZ - Math.cos( leftAzimuth ) * 50;
	const churchYaw = 0.4;
	addHouse( churchX + 6, churchZ - 4, 22, 10, 11, churchYaw, '#c9bfae', '#4a4f63', 6 );
	const towerX = churchX - 6;
	const towerZ = churchZ - 9;
	const towerBase = world.worldHeight( towerX, towerZ ) - 0.5;
	parts.push( paint( placeLocal( new THREE.BoxGeometry( 5, 22, 5 ), towerX, towerBase + 11, towerZ, churchYaw ), '#c9bfae' ) );
	parts.push( paint( placeLocal( new THREE.ConeGeometry( 3.6, 20, 4 ), towerX, towerBase + 32, towerZ, churchYaw + Math.PI / 4 ), '#3c4256' ) );
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

function createWindowMaterial() {

	const sky = state.world.uniforms;
	const uniforms = state.uniforms;
	const worldConfig = state.world.config;
	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '远景窗灯';
	material.fog = false;
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
		return uniforms.windowColor.mul( uniforms.windowIntensity ).mul( brightness ).mul( shape ).mul( state.toggles.窗灯 );

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
	const outerSpacing = terrainConfig.outerSpacing;
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
	state.disposables.push( state.horizon.texture, state.textures.biome.texture );

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
		// 冰瀑：小镇溪源头那一段台地崖壁
		iceFallX: uniform( iceSource.x ),
		iceFallBottom: uniform( iceSource.y ),
		iceFallZ: uniform( new THREE.Vector2( - 1785, - 1645 ) ),   // 冰瀑的南北范围：台地崖顶 → 崖脚
		insideCore: ( point ) => insideCoreNode( point, 0.01 ),
		insideCoreWide: ( point ) => insideCoreNode( point, 0.08 ),
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
		树林显示: uniform( 1 ),
		窗灯: uniform( 1 ),
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
	markStep( '地形网格' );

	// 替身和窗灯：每个地点一组，4b 交接时按地点显隐。先建替身（小镇的房子位置要给树林让开）。
	// 替身不做视锥剔除：包围球是没压缩的世界坐标，4b 里压缩深度时会被 far 面错误地整个剔掉
	const proxyMaterial = createProxyMaterial();
	const windowMaterial = createWindowMaterial();
	state.disposables.push( proxyMaterial, windowMaterial );
	const builders = {
		garden: ( windows ) => buildGardenCastle( world, windows ),
		gothic: ( windows ) => buildGothicCastle( world, windows ),
		starry: ( windows ) => buildTown( world, windows ),
		sunset: () => buildSeaStacks( world ),
	};
	const windowLimits = worldConfig.windowLights;
	for ( const [ locationKey, builder ] of Object.entries( builders ) ) {

		const group = new THREE.Group();
		group.name = '替身·' + world.locations[ locationKey ].name;
		const windows = [];
		for ( const geometry of builder( windows ) ) {

			const mesh = new THREE.Mesh( geometry, proxyMaterial );
			mesh.name = group.name;
			mesh.frustumCulled = false;
			group.add( mesh );
			state.disposables.push( geometry );

		}

		const limit = windowLimits[ locationKey ];
		if ( windows.length > 0 ) {

			const chosen = limit !== undefined && windows.length > limit ? windows.slice( 0, limit ) : windows;
			const geometry = buildWindowGeometry( chosen );
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

	// 树林
	state.forest = await buildForest( tier, slice );
	for ( const mesh of state.forest ) root.add( mesh );
	markStep( '树林' );

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

	// root 的逆矩阵：场景坐标 → 世界坐标
	state.root.updateMatrixWorld();
	uniforms.sceneToWorld.value.copy( tempMatrix.copy( state.root.matrixWorld ).invert() );

	// 天空球跟着相机，半径 0.9 × far
	camera.updateMatrixWorld();
	state.skyDome.position.copy( state.root.worldToLocal( tempVector.setFromMatrixPosition( camera.matrixWorld ) ) );
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

export function getRoot() {

	return state.root;

}

// 远景网格画出来的地面高度（米）；还没建好返回 NaN。机位、飞行要贴着"看得见的地面"时用它，不用 world.worldHeight（网格是 12.5 米一格的近似）
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
	state.disposables = [];
	state.scene.clear();
	state.scene = null;
	state.root = null;
	state.skyDome = null;
	state.terrainMeshes = [];
	state.forest = [];
	state.proxyGroups = {};
	state.houseFootprints = [];
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
		// 整个远景都不画（量后期链本身的开销用）
		全部远景: ( enabled ) => {

			state.root.visible = enabled;

		},
	};

}
