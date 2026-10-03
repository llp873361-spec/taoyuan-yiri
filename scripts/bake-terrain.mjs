// 地形侵蚀烘焙（阶段 12，规格书 §13 阶段 12 CP1）：
// 解析世界（src/core/world.js 的 baseHeight，已经含地点压平、视线低谷）→ 山上加脊状细节 → 粗网格河流侵蚀（冲出树枝状的山谷）
// → 细网格热力侵蚀（崖下的碎石坡）→ 水滴侵蚀（冲沟、冲积扇）→ 再热力侵蚀一遍 → 挖回湖、河、海（world.applyWater）。
// 地点自己的地形块、洞口、河床、湖、哥特城堡地基、星月夜机位和小镇不许动（world.protectionAt 给硬度）。
// 输出到 assets/opt/terrain/：核心区 4.17 米一格、外圈 25 米一格的最终高度（Int16，0.1 米一档，gzip），
// 核心区两张遮罩（RGBA8，gzip）：A = 法线 x、法线 z、岩石外露、凹凸；B = 汇水、沉积、离谷底多高、适合长树的程度；
// 清单 manifest.json 里记网格、编码和地形配置的指纹（页面加载时对指纹，不一致就退回解析公式）。
// 用法：node scripts/bake-terrain.mjs [--droplets=300000] [--preview]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import config from '../src/config.js';
import { createWorld } from '../src/core/world.js';
import { jsFbm2D } from '../src/tsl/noise.js';
import { streamPowerErode, thermalErode, dropletErode, computeFlow, upsampleBilinear, downsampleAverage, smoothMask } from './terrain-erosion.mjs';

const started = Date.now();
const args = Object.fromEntries( process.argv.slice( 2 ).map( ( item ) => {

	const [ name, ...rest ] = item.replace( /^--/, '' ).split( '=' );
	return [ name, rest.length ? rest.join( '=' ) : true ];

} ) );
const dropletCount = Number( args.droplets || 1750000 );   // 每格约 1.5 滴（少了每滴各冲一条细沟，满坡平行毛刺，汇不成树枝状）
const outputDirectory = path.resolve( 'assets/opt/terrain' );
const previewPath = path.resolve( 'reference/tmp-headless/bake-terrain-preview.png' );
const heightScale = 0.1;   // Int16 每一档 0.1 米（±3276 米够用）

const world = createWorld( config );
const terrainConfig = config.world.terrain;

function smooth( edge0, edge1, value ) {

	const amount = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return amount * amount * ( 3 - 2 * amount );

}

function elapsed() {

	return ( ( Date.now() - started ) / 1000 ).toFixed( 1 ) + ' 秒';

}

// 网格：核心区 4200 × 4800 米，4.1667 米一格（远景 hi 档 8.33 米、lo 档 12.5 米都能整格对上）；外圈 20 千米，25 米一格
const coreSpacing = 25 / 6;
const core = {
	minX: terrainConfig.coreCenter[ 0 ] - terrainConfig.coreSize[ 0 ] / 2,
	minZ: terrainConfig.coreCenter[ 1 ] - terrainConfig.coreSize[ 1 ] / 2,
	spacing: coreSpacing,
	width: Math.round( terrainConfig.coreSize[ 0 ] / coreSpacing ) + 1,
	height: Math.round( terrainConfig.coreSize[ 1 ] / coreSpacing ) + 1,
};
const outerSpacing = 25;
const outer = {
	minX: terrainConfig.coreCenter[ 0 ] - terrainConfig.outerSize / 2,
	minZ: terrainConfig.coreCenter[ 1 ] - terrainConfig.outerSize / 2,
	spacing: outerSpacing,
	width: Math.round( terrainConfig.outerSize / outerSpacing ) + 1,
	height: Math.round( terrainConfig.outerSize / outerSpacing ) + 1,
};

// ===================== 脊状细节 =====================
// 脊状多重分形（Musgrave 的 ridged multifractal）：每个八度取 1 − |2n − 1| 再平方，前一个八度越尖的地方后一个八度权重越大，
// 山脊一道一道地分出细脊；坐标先做 120 米的扭曲，脊线不是直的。返回 0~1，平均约 0.3
function ridgedMultifractal( x, z ) {

	const warpX = x + ( jsFbm2D( x / 600 + 7.7, z / 600 - 3.1, 2 ) - 0.5 ) * 240;
	const warpZ = z + ( jsFbm2D( x / 600 - 2.6, z / 600 + 9.4, 2 ) - 0.5 ) * 240;
	let frequency = 1 / 420;
	let amplitude = 1;
	let weight = 1;
	let sum = 0;
	let normalizer = 0;
	for ( let octave = 0; octave < 5; octave ++ ) {

		let value = 1 - Math.abs( 2 * jsFbm2D( warpX * frequency + octave * 17.3, warpZ * frequency - octave * 11.9, 1 ) - 1 );
		value = value * value * weight;
		weight = Math.min( 1, Math.max( 0, value * 1.6 ) );
		sum += value * amplitude;
		normalizer += amplitude;
		amplitude *= 0.5;
		frequency *= 2.03;

	}

	return sum / normalizer;

}

// 按网格取解析高度和保护度；slice 让出主线程的打印进度
function sampleGrid( grid, label ) {

	const count = grid.width * grid.height;
	const heights = new Float32Array( count );
	const protection = new Float32Array( count );
	let lastReport = Date.now();
	for ( let row = 0; row < grid.height; row ++ ) {

		const z = grid.minZ + row * grid.spacing;
		for ( let column = 0; column < grid.width; column ++ ) {

			const x = grid.minX + column * grid.spacing;
			const index = row * grid.width + column;
			heights[ index ] = world.baseHeight( x, z );
			protection[ index ] = world.protectionAt( x, z );

		}

		if ( Date.now() - lastReport > 5000 ) {

			lastReport = Date.now();
			console.log( `  ${ label }：解析高度 ${ ( row / grid.height * 100 ).toFixed( 0 ) }%（${ elapsed() }）` );

		}

	}

	return { heights, protection };

}

// 盒式模糊（可分离，半径 radius 格），算"周围平均高度"用
function boxBlur( values, width, height, radius ) {

	return smoothMask( values, width, height, radius );

}

// 山上加脊状细节：幅度按"比周围 600 米平均高出多少"（山越突出细节越大，最多约 60 米），平地上只有 1~2 米的小起伏；
// 保护区乘 (1 − 保护度)，海里不加
function addRidgedDetail( grid, heights, protection ) {

	const blurRadius = Math.round( 600 / grid.spacing );
	const surrounding = boxBlur( heights, grid.width, grid.height, blurRadius );
	const reliefs = new Float32Array( heights.length );
	for ( let row = 0; row < grid.height; row ++ ) {

		const z = grid.minZ + row * grid.spacing;
		for ( let column = 0; column < grid.width; column ++ ) {

			const index = row * grid.width + column;
			const base = heights[ index ];
			if ( base < 0.5 ) continue;
			const x = grid.minX + column * grid.spacing;
			const relief = Math.min( 400, Math.max( 0, base - surrounding[ index ] ) ) + Math.max( 0, base - 260 ) * 0.15;
			reliefs[ index ] = relief;
			const amplitude = relief * 0.16 + 1.5;
			const detail = ( ridgedMultifractal( x, z ) - 0.32 ) * amplitude * smooth( 0.5, 6, base );
			heights[ index ] = base + detail * ( 1 - protection[ index ] );

		}

	}

	return reliefs;

}

// 汇流起伏：坡面上加一层 120~250 米尺度、扭曲过的起伏（幅度按山的突出程度，最多十来米），水不再顺着光滑的坡面一道道平行地往下流，
// 而是汇进一条条沟里，侵蚀出来是树枝状的山谷（不加的话坡上全是梳子齿一样的平行细沟）
function addConvergenceNoise( grid, heights, hardness, reliefs ) {

	for ( let row = 0; row < grid.height; row ++ ) {

		const z = grid.minZ + row * grid.spacing;
		for ( let column = 0; column < grid.width; column ++ ) {

			const index = row * grid.width + column;
			if ( heights[ index ] < 0.5 ) continue;
			const x = grid.minX + column * grid.spacing;
			const warpX = x + ( jsFbm2D( x / 400 + 1.9, z / 400 + 6.1, 2 ) - 0.5 ) * 260;
			const warpZ = z + ( jsFbm2D( x / 400 - 8.3, z / 400 - 2.7, 2 ) - 0.5 ) * 260;
			const undulation = jsFbm2D( warpX / 190 + 3.3, warpZ / 190 - 4.8, 3 ) - 0.5;
			const amplitude = Math.min( 14, reliefs[ index ] * 0.07 ) + 1;
			heights[ index ] += undulation * 2 * amplitude * ( 1 - hardness[ index ] );

		}

	}

}

// 平地上不冲河谷：缓缓倾斜的盆地底上，每格的水都顺着同一个方向流，河流侵蚀会切出一道道平行的直沟（网格的方向），
// 所以按"比周围高出多少"给平地加硬度：高出 15 米以下不冲，80 米以上照常冲；水滴侵蚀在平地上只留四成
function plainHardness( reliefs, hardness, plainsWeight ) {

	const result = new Float32Array( hardness.length );
	for ( let i = 0; i < hardness.length; i ++ ) result[ i ] = Math.max( hardness[ i ], ( 1 - smooth( 15, 80, reliefs[ i ] ) ) * plainsWeight );
	return result;

}

// 粗网格（4 倍间距）上做河流侵蚀，把高度的变化量插值回细网格
function streamPowerOnCoarse( grid, heights, hardness, factor, options ) {

	const coarseWidth = Math.floor( ( grid.width - 1 ) / factor ) + 1;
	const coarseHeight = Math.floor( ( grid.height - 1 ) / factor ) + 1;
	const coarse = downsampleAverage( heights, grid.width, grid.height, coarseWidth, coarseHeight );
	const coarseHardness = downsampleAverage( hardness, grid.width, grid.height, coarseWidth, coarseHeight );
	const before = coarse.slice();
	const stats = streamPowerErode( { heights: coarse, width: coarseWidth, height: coarseHeight, cellSize: grid.spacing * factor, hardness: coarseHardness, seaLevel: 0, ...options } );
	const change = new Float32Array( coarse.length );
	for ( let i = 0; i < coarse.length; i ++ ) change[ i ] = coarse[ i ] - before[ i ];
	// 放大前先平滑一格：一格宽的斜向沟直接放大，看起来是一串珠子
	const fineChange = upsampleBilinear( smoothMask( change, coarseWidth, coarseHeight, 1 ), coarseWidth, coarseHeight, grid.width, grid.height );
	for ( let i = 0; i < heights.length; i ++ ) heights[ i ] += fineChange[ i ] * ( 1 - hardness[ i ] );
	return stats;

}

// 挖回湖、河、海（同解析世界的规则，保证水面、河床在规定的位置）
function carveWater( grid, heights ) {

	for ( let row = 0; row < grid.height; row ++ ) {

		const z = grid.minZ + row * grid.spacing;
		for ( let column = 0; column < grid.width; column ++ ) {

			const index = row * grid.width + column;
			heights[ index ] = world.applyWater( grid.minX + column * grid.spacing, z, heights[ index ], true ).height;

		}

	}

}

function keepCaveCovered( grid, heights, minimumCover ) {

	const cave = world.cave;
	const touched = new Set();
	const sample = {};
	for ( let distance = 12; distance <= cave.length - 12; distance += 1 ) {

		cave.at( distance, sample );
		const roof = sample.position.y + sample.height + minimumCover;
		const reach = sample.width / 2 + 4;
		const sideX = - sample.tangent.z;
		const sideZ = sample.tangent.x;
		for ( let offset = - reach; offset <= reach; offset += grid.spacing / 2 ) {

			const x = sample.position.x + sideX * offset;
			const z = sample.position.z + sideZ * offset;
			const column = Math.round( ( x - grid.minX ) / grid.spacing );
			const row = Math.round( ( z - grid.minZ ) / grid.spacing );
			for ( let rowOffset = - 1; rowOffset <= 1; rowOffset ++ ) {

				for ( let columnOffset = - 1; columnOffset <= 1; columnOffset ++ ) {

					const index = ( row + rowOffset ) * grid.width + column + columnOffset;
					if ( coreSample.protection[ index ] < 0.99 && heights[ index ] < roof ) {

						heights[ index ] = roof;
						touched.add( index );

					}

				}

			}

		}

	}

	return touched.size;

}

function encodeHeights( heights ) {

	const encoded = new Int16Array( heights.length );
	for ( let i = 0; i < heights.length; i ++ ) encoded[ i ] = Math.max( - 32768, Math.min( 32767, Math.round( heights[ i ] / heightScale ) ) );
	return zlib.gzipSync( Buffer.from( encoded.buffer ), { level: 9 } );

}

function toByte( value ) {

	return Math.max( 0, Math.min( 255, Math.round( value * 255 ) ) );

}

// 遮罩：A = 法线 x、法线 z（0.5 + n/2）、岩石外露、凹凸（0.5 是平，越亮越凸）；B = 汇水（对数）、沉积、离谷底多高（每档 2 米）、适合长树
function buildSurfaceMasks( grid, final, beforeErosion ) {

	const width = grid.width;
	const height = grid.height;
	const spacing = grid.spacing;
	const surfaceA = new Uint8Array( width * height * 4 );
	const surfaceB = new Uint8Array( width * height * 4 );
	const smoothed = smoothMask( final, width, height, 2 );
	// 谷底高度：先取 40 格（约 170 米）半径的最小值，再模糊 20 格
	const valleyFloor = smoothMask( minimumFilter( final, width, height, 40 ), width, height, 20 );
	const flow = computeFlow( { heights: final, width, height } );
	let maxArea = 1;
	for ( let i = 0; i < flow.area.length; i ++ ) maxArea = Math.max( maxArea, flow.area[ i ] );
	const logMax = Math.log( maxArea );
	for ( let row = 0; row < height; row ++ ) {

		for ( let column = 0; column < width; column ++ ) {

			const index = row * width + column;
			const left = final[ row * width + Math.max( 0, column - 1 ) ];
			const right = final[ row * width + Math.min( width - 1, column + 1 ) ];
			const up = final[ Math.max( 0, row - 1 ) * width + column ];
			const down = final[ Math.min( height - 1, row + 1 ) * width + column ];
			const gradientX = ( right - left ) / ( 2 * spacing );
			const gradientZ = ( down - up ) / ( 2 * spacing );
			const length = Math.hypot( gradientX, 1, gradientZ );
			const normalX = - gradientX / length;
			const normalZ = - gradientZ / length;
			const slope = Math.hypot( gradientX, gradientZ );
			const change = final[ index ] - beforeErosion[ index ];
			const eroded = Math.max( 0, - change );
			const deposited = Math.max( 0, change );
			// 岩石外露：陡（高差比 1.1~1.8，约 48°~61° 起露石头；绘本里中等坡还是草和树）或者又陡又被冲刷得多（冲掉 5~16 米）的地方
			const rock = Math.min( 1, smooth( 1.1, 1.8, slope ) + smooth( 5, 16, eroded ) * smooth( 0.6, 1.1, slope ) * 0.5 );
			const cavity = 0.5 + Math.max( - 0.5, Math.min( 0.5, ( final[ index ] - smoothed[ index ] ) / 3 ) );
			const flowAmount = Math.log( Math.max( 1, flow.area[ index ] ) ) / logMax;
			const aboveValley = Math.max( 0, final[ index ] - valleyFloor[ index ] );
			const isWater = final[ index ] < 0.3 ? 1 : 0;
			// 适合长树：缓坡、不太高（雪线以下）、不是岩石、不是水；汇水多的沟里更密
			const forest = smooth( 0.75, 0.35, slope ) * smooth( 26, 60, final[ index ] ) * smooth( 560, 430, final[ index ] ) * ( 1 - rock ) * ( 1 - isWater ) * ( 0.6 + 0.4 * flowAmount );
			surfaceA[ index * 4 ] = toByte( normalX * 0.5 + 0.5 );
			surfaceA[ index * 4 + 1 ] = toByte( normalZ * 0.5 + 0.5 );
			surfaceA[ index * 4 + 2 ] = toByte( rock );
			surfaceA[ index * 4 + 3 ] = toByte( cavity );
			surfaceB[ index * 4 ] = toByte( flowAmount );
			surfaceB[ index * 4 + 1 ] = toByte( Math.min( 1, deposited / 6 ) );
			surfaceB[ index * 4 + 2 ] = toByte( Math.min( 1, aboveValley / 510 ) );
			surfaceB[ index * 4 + 3 ] = toByte( forest );

		}

	}

	return { surfaceA, surfaceB };

}

// 最小值滤波（可分离，半径 radius 格）
function minimumFilter( values, width, height, radius ) {

	const horizontal = new Float32Array( values.length );
	for ( let row = 0; row < height; row ++ ) {

		for ( let column = 0; column < width; column ++ ) {

			let minimum = Infinity;
			for ( let offset = - radius; offset <= radius; offset += 2 ) {

				const sampleColumn = Math.min( width - 1, Math.max( 0, column + offset ) );
				minimum = Math.min( minimum, values[ row * width + sampleColumn ] );

			}

			horizontal[ row * width + column ] = minimum;

		}

	}

	const result = new Float32Array( values.length );
	for ( let column = 0; column < width; column ++ ) {

		for ( let row = 0; row < height; row ++ ) {

			let minimum = Infinity;
			for ( let offset = - radius; offset <= radius; offset += 2 ) {

				const sampleRow = Math.min( height - 1, Math.max( 0, row + offset ) );
				minimum = Math.min( minimum, horizontal[ sampleRow * width + column ] );

			}

			result[ row * width + column ] = minimum;

		}

	}

	return result;

}

// 预览：改前（解析）/ 改后（烘焙）的核心区晕渲图，并排写一张 PNG（北在上）
async function writePreview( grid, beforeHeights, afterHeights ) {

	const scale = 1;
	const shade = ( heights ) => {

		const pixels = new Uint8Array( grid.width * grid.height * 3 );
		for ( let row = 0; row < grid.height; row ++ ) {

			for ( let column = 0; column < grid.width; column ++ ) {

				const index = row * grid.width + column;
				const left = heights[ row * grid.width + Math.max( 0, column - 1 ) ];
				const right = heights[ row * grid.width + Math.min( grid.width - 1, column + 1 ) ];
				const up = heights[ Math.max( 0, row - 1 ) * grid.width + column ];
				const down = heights[ Math.min( grid.height - 1, row + 1 ) * grid.width + column ];
				const gradientX = ( right - left ) / ( 2 * grid.spacing );
				const gradientZ = ( down - up ) / ( 2 * grid.spacing );
				// 西北方向 45° 高的光
				const lambert = Math.max( 0, ( gradientX * 0.5 + gradientZ * 0.5 + 0.707 ) / Math.hypot( gradientX, gradientZ, 1 ) );
				const value = heights[ index ];
				const water = value < 0.3;
				const tint = water ? [ 70, 110, 160 ] : [ 150 + Math.min( 90, value * 0.15 ), 160 + Math.min( 80, value * 0.1 ), 130 + Math.min( 110, value * 0.18 ) ];
				for ( let channel = 0; channel < 3; channel ++ ) pixels[ index * 3 + channel ] = Math.max( 0, Math.min( 255, tint[ channel ] * ( 0.35 + 0.75 * lambert ) * scale ) );

			}

		}

		return pixels;

	};

	const width = grid.width;
	const height = grid.height;
	const left = await sharp( Buffer.from( shade( beforeHeights ) ), { raw: { width, height, channels: 3 } } ).png().toBuffer();
	const right = await sharp( Buffer.from( shade( afterHeights ) ), { raw: { width, height, channels: 3 } } ).png().toBuffer();
	await sharp( { create: { width: width * 2 + 10, height, channels: 3, background: '#000' } } )
		.composite( [ { input: left, left: 0, top: 0 }, { input: right, left: width + 10, top: 0 } ] )
		.png().toFile( previewPath );
	console.log( `预览（左：改前解析地形，右：烘焙后）：${ path.relative( process.cwd(), previewPath ) }` );

}

// ===================== 主流程 =====================

console.log( `核心区 ${ core.width }×${ core.height }（${ coreSpacing.toFixed( 3 ) } 米一格），外圈 ${ outer.width }×${ outer.height }（${ outerSpacing } 米一格）` );

// 核心区
const coreSample = sampleGrid( core, '核心区' );
console.log( `核心区解析高度取完（${ elapsed() }）` );
const coreBase = coreSample.heights.slice();
// 硬度：保护度再往外羽化 12 格（50 米），侵蚀不会在保护区边上切出台阶
const coreHardness = smoothMask( coreSample.protection, core.width, core.height, 12 );
for ( let i = 0; i < coreHardness.length; i ++ ) coreHardness[ i ] = Math.max( coreHardness[ i ], coreSample.protection[ i ] );
const coreHeights = coreSample.heights;
const coreReliefs = addRidgedDetail( core, coreHeights, coreHardness );
const coreBeforeErosion = coreHeights.slice();
console.log( `脊状细节加好（${ elapsed() }）` );
addConvergenceNoise( core, coreHeights, coreHardness, coreReliefs );
const coreStreamHardness = plainHardness( coreReliefs, coreHardness, 1 );
const coreDropletHardness = plainHardness( coreReliefs, coreHardness, 0.6 );
const streamStats = streamPowerOnCoarse( core, coreHeights, coreStreamHardness, 4, { iterations: 60, erodibility: 0.006, areaExponent: 0.45, slopeExponent: 1, maxIncisionPerIteration: 2 } );
console.log( `河流侵蚀（粗网格 16.7 米）：${ JSON.stringify( streamStats ) }（${ elapsed() }）` );
const thermalStats = thermalErode( { heights: coreHeights, width: core.width, height: core.height, cellSize: core.spacing, iterations: 20, talusAngle: 1.0, rate: 0.5, hardness: coreHardness } );
console.log( `热力侵蚀：${ JSON.stringify( thermalStats ) }（${ elapsed() }）` );
// 水滴：惯性大一点、刷子宽一点、冲得慢一点，沟是圆润的，不是细碎的划痕；冲完把这一步的改动模糊一下（去掉刷子留下的细格纹）
const beforeDroplets = coreHeights.slice();
const dropletStats = dropletErode( { heights: coreHeights, width: core.width, height: core.height, cellSize: core.spacing, droplets: dropletCount, seed: 20261001, hardness: coreDropletHardness, seaLevel: 0 } );
const dropletChange = new Float32Array( coreHeights.length );
for ( let i = 0; i < coreHeights.length; i ++ ) dropletChange[ i ] = coreHeights[ i ] - beforeDroplets[ i ];
const smoothedChange = smoothMask( smoothMask( dropletChange, core.width, core.height, 1 ), core.width, core.height, 1 );
// 冲沟的深浅按 450 米上下的噪声一片深一片浅（审查 R16：整面坡一样深、一样密的平行沟，夜里从远处看像一排窗帘的竖褶）
for ( let i = 0; i < coreHeights.length; i ++ ) {

	const x = core.minX + ( i % core.width ) * core.spacing;
	const z = core.minZ + Math.floor( i / core.width ) * core.spacing;
	const variation = 0.3 + 0.95 * smooth( 0.35, 0.68, jsFbm2D( x / 450 + 2.7, z / 450 - 6.4, 3 ) );
	coreHeights[ i ] = beforeDroplets[ i ] + smoothedChange[ i ] * variation * ( 1 - coreHardness[ i ] );

}
console.log( `水滴侵蚀（${ dropletCount } 滴）：${ JSON.stringify( dropletStats ) }（${ elapsed() }）` );
const thermalStats2 = thermalErode( { heights: coreHeights, width: core.width, height: core.height, cellSize: core.spacing, iterations: 8, talusAngle: 1.0, rate: 0.5, hardness: coreHardness } );
console.log( `热力侵蚀（第二遍）：${ JSON.stringify( thermalStats2 ) }（${ elapsed() }）` );
carveWater( core, coreHeights );
console.log( `湖、河、海挖回去（${ elapsed() }）` );
// 山洞上面至少还盖着 8 米：沿洞的中线每 1 米取一点，洞宽两边各多 4 米的范围里，地面不许低于洞顶 + 8 米
// （两头 12 米的洞口段、完全保护的格子不管：洞口要开着，开场那面崖不动）
const caveCovered = keepCaveCovered( core, coreHeights, 8 );
console.log( `洞顶补盖了 ${ caveCovered } 格（${ elapsed() }）` );

// 保护区检查：保护度 ≥ 0.99 的格子，最终高度和"解析高度挖水"差多少
const analyticCarved = coreBase.slice();
carveWater( core, analyticCarved );
let protectedCells = 0;
let protectedMaxChange = 0;
let fullyProtectedChanged = 0;
let worstIndex = - 1;
for ( let i = 0; i < coreHeights.length; i ++ ) {

	if ( coreSample.protection[ i ] < 0.99 ) continue;
	protectedCells ++;
	const change = Math.abs( coreHeights[ i ] - analyticCarved[ i ] );
	if ( coreSample.protection[ i ] >= 1 && change > 0.05 ) fullyProtectedChanged ++;
	if ( change > protectedMaxChange ) {

		protectedMaxChange = change;
		worstIndex = i;

	}

}

const worstX = core.minX + ( worstIndex % core.width ) * core.spacing;
const worstZ = core.minZ + Math.floor( worstIndex / core.width ) * core.spacing;
console.log( `保护区 ${ protectedCells } 格，最大改动 ${ protectedMaxChange.toFixed( 3 ) } 米（在 ${ worstX.toFixed( 0 ) }, ${ worstZ.toFixed( 0 ) }，保护度 ${ worstIndex >= 0 ? coreSample.protection[ worstIndex ].toFixed( 3 ) : '-' }）；完全保护的格子里改动超过 5 厘米的 ${ fullyProtectedChanged } 格` );

// 外圈：解析高度 + 脊状细节 + 粗河流侵蚀 + 热力侵蚀（25 米一格，没有水滴那一步）
const outerSample = sampleGrid( outer, '外圈' );
console.log( `外圈解析高度取完（${ elapsed() }）` );
const outerHardness = smoothMask( outerSample.protection, outer.width, outer.height, 3 );
for ( let i = 0; i < outerHardness.length; i ++ ) outerHardness[ i ] = Math.max( outerHardness[ i ], outerSample.protection[ i ] );
const outerHeights = outerSample.heights;
const outerReliefs = addRidgedDetail( outer, outerHeights, outerHardness );
const outerStreamStats = streamPowerOnCoarse( outer, outerHeights, plainHardness( outerReliefs, outerHardness, 1 ), 2, { iterations: 40, erodibility: 0.006, areaExponent: 0.45, slopeExponent: 1, maxIncisionPerIteration: 4 } );
console.log( `外圈河流侵蚀（粗网格 50 米）：${ JSON.stringify( outerStreamStats ) }（${ elapsed() }）` );
thermalErode( { heights: outerHeights, width: outer.width, height: outer.height, cellSize: outer.spacing, iterations: 6, talusAngle: 1.0, rate: 0.5, hardness: outerHardness } );
carveWater( outer, outerHeights );
console.log( `外圈做完（${ elapsed() }）` );

// 遮罩
const masks = buildSurfaceMasks( core, coreHeights, coreBeforeErosion );
console.log( `遮罩算好（${ elapsed() }）` );

// 写文件
fs.mkdirSync( outputDirectory, { recursive: true } );
const outputs = [
	{ id: 'height-core', file: 'height-core.i16.gz', mime: 'application/gzip', data: encodeHeights( coreHeights ) },
	{ id: 'height-outer', file: 'height-outer.i16.gz', mime: 'application/gzip', data: encodeHeights( outerHeights ) },
	{ id: 'surface-a', file: 'surface-a.rgba.gz', mime: 'application/gzip', data: zlib.gzipSync( Buffer.from( masks.surfaceA.buffer ), { level: 9 } ) },
	{ id: 'surface-b', file: 'surface-b.rgba.gz', mime: 'application/gzip', data: zlib.gzipSync( Buffer.from( masks.surfaceB.buffer ), { level: 9 } ) },
];
const files = [];
for ( const output of outputs ) {

	fs.writeFileSync( path.join( outputDirectory, output.file ), output.data );
	files.push( { id: output.id, file: output.file, mime: output.mime, bytes: output.data.length } );

}

const manifest = {
	version: 1,
	hash: world.terrainConfigHash(),
	heightScale,
	grids: { core, outer },
	masks: {
		surfaceA: [ '法线 x（0.5 + n/2）', '法线 z（0.5 + n/2）', '岩石外露', '凹凸（0.5 平，亮凸暗凹）' ],
		surfaceB: [ '汇水（对数）', '沉积（每档 6/255 米）', '离谷底多高（每档 2 米）', '适合长树' ],
	},
	files,
	stats: { droplets: dropletCount, protectedCells, protectedMaxChange, seconds: ( Date.now() - started ) / 1000 },
};
fs.writeFileSync( path.join( outputDirectory, 'manifest.json' ), JSON.stringify( manifest, null, '\t' ) + '\n' );
const totalBytes = files.reduce( ( sum, item ) => sum + item.bytes, 0 );
console.log( `写到 ${ path.relative( process.cwd(), outputDirectory ) }：${ files.map( ( item ) => `${ item.file } ${ ( item.bytes / 1048576 ).toFixed( 2 ) } MB` ).join( '，' ) }；合计 ${ ( totalBytes / 1048576 ).toFixed( 2 ) } MB（内联成 base64 约 ${ ( totalBytes * 4 / 3 / 1048576 ).toFixed( 2 ) } MB），指纹 ${ manifest.hash }` );

await writePreview( core, analyticCarved, coreHeights );
console.log( `全部完成，用时 ${ elapsed() }` );
