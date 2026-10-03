// 草（阶段 12 CP3 返工；开场、花园、哥特、落日共用，规格书 10.2）。
// 用户给的参考图是 reference/notes/grass-target.webp（一整片又密又软、一簇一簇的草），做法照 reference/notes/grass-3dgs-doc.md：
// 那份文档的草叶模型思路来自 windcrest（PolyForm Noncommercial，只学做法），代码全部自己用 TSL 写；思路上还参考了 SimonDev 的 Quick_Grass（MIT，没有搬代码）。
//
// 三环：
//   近内环：每片叶 7 个顶点（3 节 + 公共叶尖），最密，跟着镜头取模环绕（草根在世界里不动，人走到哪草就铺到哪）；
//   近外环：每片叶 5 个顶点，稀一些，和内环在交界处按同一个圆交叉淡化；外沿后四成慢慢变稀，最后 2 米淡到 0（圆的，不是方块）；
//   远环：每片叶 3 个顶点（单三角形），径向分布、越远越稀越长，半透明不写深度——实心的远草在掠射角下会叠成一堵叶尖色的墙（文档 5.3 的坑）。
// 每根草一个实例，实例属性是一个 vec4（偏移的种子 + 两个随机数）和它在 R2 序列里的序号，位置、弯曲、风、光照全在顶点着色器里算；
// 偏移用 R2 低差异序列（Roberts 2018）：任意前缀都均匀，按序号截前缀就是均匀地变稀（顶点压力、倒影里用；画质档的不同数量是建场景时定的）。
// 光照逐顶点算（varying 传给片元），远处的叶子按地面法线受光，不会一根根闪。
//
// 省顶点着色（核显 hi 档 30 帧那一轮，开关在 config.perf.grass）：
//   出生点视角 70%~90% 的叶子是死的（环形淡出、方块四角、广场 / 水池 / 湖 / 溪上密度 0）。顶点着色器开头先用便宜的必要条件判死
//   （环形淡出 × 存活随机数、开关、顶点压力的序号、草地图里存的"附近最大密度"），没过的整片叶子输出同一个点（退化三角形，不出片元），
//   丛簇、地面、风、宽度、光照都不算；过了的再算到秃斑和密度，真死的也停在那里。实例按空间小格排序（格里再按存活随机数排），
//   同一个 SIMD 组里的顶点一起死、一起跳过。这两条画面逐像素不变（远环排序除外：半透明叠画的先后变了，见 config 的 sortFar）。
//   另外三条换了算法、画面有细小差别（截图对比过）：4 个值噪声改取噪声贴图、丛心只找 2×2 格、秃斑和成片长短烘进地点草地图。

import * as THREE from 'three/webgpu';
import {
	Fn, If, float, vec2, vec3, vec4, uniform, attribute, cameraPosition, texture, varyingProperty,
	normalize, length, dot, max, min, mix, smoothstep, sin, cos, abs, floor, fract, pow, select, clamp, sqrt, step,
} from 'three/tsl';
import { hash22, valueNoise2D, jsValueNoise2D, createNoiseTextureData, sampleNoiseTexture } from './noise.js';
import config from '../config.js';

// 省法的开关（config.perf.grass；没写的按下面的默认）。都是建材质时读的，改了要重建场景
const perf = {
	cheapCull: true,
	sortBlades: true,
	sortFar: true,
	nearAtmosphere: true,
	noiseTexture: true,
	clumpSearch: 2,
	bakeNoise: true,
	...( ( config.perf && config.perf.grass ) || {} ),
};

// R2 低差异序列的两个常数（平面上最均匀的加法递推）
const r2StepX = 0.7548776662466927;
const r2StepY = 0.5698402909980532;

// 实例按 R2 序号分 10 桶，桶是排序的第一关键字：桶 0~k−1 正好是原来 R2 的前缀，倒影、顶点压力按桶截 instanceCount，
// 最后那个不整的桶里多出来的靠 bladeRank 在着色器里判掉（压力 1、不在倒影里时一个都不判）
const rankBuckets = 10;

// 便宜判死用的密度上界：草地图 A 通道存每格附近 ±dilateTexels 格里的最大值（丛簇往丛心拉最多 0.16 米，加上双线性取样的一格，
// 0.5 米一格时 ±2 格就盖住了）；上界再放宽 1%（半精度的舍入、mix 的舍入都在这里面）
const boundMargin = 1.01;
// 地点草地图里离块边超过这么多米才只用自己的草地图（远景那几次取样省掉；块边 10 米里地点和远景的密度交叉过渡）
const deepInside = 10;

// 秃斑、成片长短、阵风的值噪声坐标（米 × 频率 + 偏移）。noiseTexture 开着时从草自己的噪声贴图取（512 像素、32 格，R、G 两张值噪声，
// 和 createNoiseTextureData 的格子一样大：贴图坐标 = 噪声坐标 / 32），关着时照原来每个顶点算 valueNoise2D。
// 每格 16 像素：硬件双线性在像素之间是折线，阵风随时间滚过去时速度在像素边上有小拐点，每格 8 像素时拐点能到斜率的四成，16 像素压到两成以下
const noiseCells = 32;
const noisePixels = 512;
const bareNoise = { scale: 0.11, offset: 17.3, channel: 0 };
const meadowNoise = { scale: 0.06, offset: 3.7, channel: 1 };

// 草的噪声贴图数据：模块里只算一次，草地图烘焙（JS 双线性取样）和每片草的贴图（GPU）用同一份
let grassNoiseData = null;
function grassNoise() {

	if ( ! grassNoiseData ) grassNoiseData = createNoiseTextureData( noisePixels, noiseCells, 97 );
	return grassNoiseData;

}

// JS 版：某一点的秃斑 / 成片长短噪声（烘进地点草地图用），和着色器里取的是同一个函数
function noiseValueJs( noise, x, z ) {

	const u = x * noise.scale + noise.offset;
	const v = z * noise.scale + noise.offset;
	if ( perf.noiseTexture ) return sampleNoiseTexture( grassNoise(), u / noiseCells, v / noiseCells, noise.channel );
	return jsValueNoise2D( u, v );

}

// 草根融合的形状（地点地面和远景地面共用一份，两边对得上）：
//   近环半径的 nearStart~1 倍之间从全压淡到 0，最多往草根色压 nearStrength；草根色提亮 rootBoost 倍（地面压过去不至于成黑洞）；
//   远环半径的 farStart~1 倍之间淡掉，往草的中段色（乘 middleScale）靠 farStrength（远处草稀，地面本身要像一片草）
export const grassUnderlayShape = { nearStart: 0.5, nearStrength: 0.9, rootBoost: 1.3, farStart: 0.5, farStrength: 0.5, middleScale: 0.85 };

// mulberry32：周期 2³²，几十万根草的随机数不会成段重复（线性同余模 233280 时外环、远环的随机数整段重复）
function createRandom( seed ) {

	let value = ( seed >>> 0 ) || 1;
	return function next() {

		value = ( value + 0x6D2B79F5 ) >>> 0;
		let mixed = Math.imul( value ^ ( value >>> 15 ), 1 | value );
		mixed = ( mixed + Math.imul( mixed ^ ( mixed >>> 7 ), 61 | mixed ) ) ^ mixed;
		return ( ( mixed ^ ( mixed >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// 一片草叶的模板：segments 节，两边各 segments 个点 + 一个公共叶尖；bladeParam = (左右 −1 / 1，叶尖 0；沿叶片 0~1)
function bladeGeometry( segments, blades, count ) {

	const geometry = new THREE.InstancedBufferGeometry();
	const vertexCount = segments * 2 + 1;
	const bladeParam = new Float32Array( vertexCount * 2 );
	for ( let k = 0; k < vertexCount; k ++ ) {

		const tip = k === vertexCount - 1;
		bladeParam[ k * 2 ] = tip ? 0 : ( k % 2 === 0 ? - 1 : 1 );
		bladeParam[ k * 2 + 1 ] = tip ? 1 : Math.floor( k / 2 ) / segments;

	}

	const indices = [];
	for ( let row = 0; row < segments - 1; row ++ ) {

		const first = row * 2;
		indices.push( first, first + 1, first + 2, first + 1, first + 3, first + 2 );

	}

	indices.push( ( segments - 1 ) * 2, ( segments - 1 ) * 2 + 1, vertexCount - 1 );
	geometry.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( vertexCount * 3 ), 3 ) );
	geometry.setAttribute( 'bladeParam', new THREE.BufferAttribute( bladeParam, 2 ) );
	geometry.setIndex( indices );
	geometry.setAttribute( 'bladeSeed', new THREE.InstancedBufferAttribute( blades.seeds, 4 ) );
	geometry.setAttribute( 'bladeRank', new THREE.InstancedBufferAttribute( blades.ranks, 1 ) );
	geometry.instanceCount = count;
	return geometry;

}

// 种子：xy 是 R2 序列（近环，0~1）或径向偏移（远环，米），zw 是两个随机数。
// 生成顺序还是 R2 序号 i（随机数也按 i 取，和原来一根不差），再排序：桶（R2 序号的十分之一）→ 空间小格 → 格里的存活随机数。
// 近环的小格在种子方块里（size 米见方，跟着镜头取模环绕后还是挨着的），格子按蛇形走（相邻两格在空间上也相邻），
// 格子大小让每格每桶约 48 根（内环 1.3 米、外环 2.4 米左右）；远环按 4 米宽的半径带、带里约 4 米长的扇区分箱。
// 返回 { seeds（排好序的 vec4）, ranks（每根的 R2 序号）, bucketStarts（每个桶在排好的顺序里从第几根开始，最后一项是总数）}
function bladeSeeds( count, seed, radial, size, sort ) {

	const raw = new Float32Array( count * 4 );
	const random = createRandom( seed * 7919 + 17 );
	for ( let i = 0; i < count; i ++ ) {

		const u = ( 0.5 + r2StepX * ( i + 1 ) ) % 1;
		const v = ( 0.5 + r2StepY * ( i + 1 ) ) % 1;
		if ( radial ) {

			// 径向：半径 inner + (outer − inner) × v^1.4，越靠里越密（文档 5.3）
			const angle = u * Math.PI * 2;
			const radius = radial.inner + ( radial.outer - radial.inner ) * Math.pow( v, 1.4 );
			raw[ i * 4 ] = Math.cos( angle ) * radius;
			raw[ i * 4 + 1 ] = Math.sin( angle ) * radius;

		} else {

			raw[ i * 4 ] = u;
			raw[ i * 4 + 1 ] = v;

		}

		raw[ i * 4 + 2 ] = random();
		raw[ i * 4 + 3 ] = random();

	}

	const bucketStarts = new Uint32Array( rankBuckets + 1 );
	for ( let b = 0; b <= rankBuckets; b ++ ) bucketStarts[ b ] = Math.ceil( b * count / rankBuckets );
	const ranks = new Float32Array( count );
	if ( ! sort || count === 0 ) {

		for ( let i = 0; i < count; i ++ ) ranks[ i ] = i;
		return { seeds: raw, ranks, bucketStarts };

	}

	// 排序关键字（整数）：(桶 × 格数 + 格) × survivalBins + 存活随机数分档
	const survivalBins = 32;
	const keys = new Uint32Array( count );
	let keyCount;
	if ( radial ) {

		const bandWidth = 4;
		const arcLength = 4;
		const bandCount = Math.max( 1, Math.ceil( ( radial.outer - radial.inner ) / bandWidth ) );
		const sectors = [];
		const bandStart = [];
		let binCount = 0;
		for ( let band = 0; band < bandCount; band ++ ) {

			const middle = radial.inner + ( band + 0.5 ) * bandWidth;
			sectors.push( Math.max( 8, Math.round( 2 * Math.PI * middle / arcLength ) ) );
			bandStart.push( binCount );
			binCount += sectors[ band ];

		}

		for ( let i = 0; i < count; i ++ ) {

			const x = raw[ i * 4 ];
			const z = raw[ i * 4 + 1 ];
			const band = Math.min( bandCount - 1, Math.max( 0, Math.floor( ( Math.hypot( x, z ) - radial.inner ) / bandWidth ) ) );
			const turn = ( Math.atan2( z, x ) / ( 2 * Math.PI ) + 1 ) % 1;
			// 带内的扇区也按蛇形走：奇数带倒着数，带和带的交界处还挨着
			let sector = Math.min( sectors[ band ] - 1, Math.floor( turn * sectors[ band ] ) );
			if ( band % 2 === 1 ) sector = sectors[ band ] - 1 - sector;
			const bucket = Math.floor( i * rankBuckets / count );
			keys[ i ] = bucket * binCount + bandStart[ band ] + sector;

		}

		keyCount = rankBuckets * binCount;

	} else {

		const perBucketDensity = count / ( size * size ) / rankBuckets;
		const cellSize = Math.min( 3, Math.max( 1, Math.sqrt( 48 / Math.max( perBucketDensity, 1e-6 ) ) ) );
		const cellsPerRow = Math.max( 1, Math.ceil( size / cellSize ) );
		const cellCount = cellsPerRow * cellsPerRow;
		for ( let i = 0; i < count; i ++ ) {

			const cellX = Math.min( cellsPerRow - 1, Math.floor( raw[ i * 4 ] * size / cellSize ) );
			const cellY = Math.min( cellsPerRow - 1, Math.floor( raw[ i * 4 + 1 ] * size / cellSize ) );
			const cell = cellY * cellsPerRow + ( cellY % 2 === 1 ? cellsPerRow - 1 - cellX : cellX );
			// 和着色器里同一个存活随机数（近环的随机数就是 zw）：格里存活随机数小的排在前面，淡出带里活下来的连成一段
			const survivalValue = ( raw[ i * 4 + 2 ] * 7.13 + raw[ i * 4 + 3 ] * 3.71 ) % 1;
			const survivalBin = Math.min( survivalBins - 1, Math.floor( survivalValue * survivalBins ) );
			const bucket = Math.floor( i * rankBuckets / count );
			keys[ i ] = ( bucket * cellCount + cell ) * survivalBins + survivalBin;

		}

		keyCount = rankBuckets * cellCount * survivalBins;

	}

	// 计数排序（稳定：同一个关键字里还是 R2 顺序），几十万根几毫秒
	const offsets = new Uint32Array( keyCount + 1 );
	for ( let i = 0; i < count; i ++ ) offsets[ keys[ i ] + 1 ] ++;
	for ( let k = 0; k < keyCount; k ++ ) offsets[ k + 1 ] += offsets[ k ];
	const seeds = new Float32Array( count * 4 );
	for ( let i = 0; i < count; i ++ ) {

		const target = offsets[ keys[ i ] ] ++;
		seeds[ target * 4 ] = raw[ i * 4 ];
		seeds[ target * 4 + 1 ] = raw[ i * 4 + 1 ];
		seeds[ target * 4 + 2 ] = raw[ i * 4 + 2 ];
		seeds[ target * 4 + 3 ] = raw[ i * 4 + 3 ];
		ranks[ target ] = i;

	}

	return { seeds, ranks, bucketStarts };

}

// 草的调色板按地点地面的草色校正（文档 5.9）：两者各除以亮度，相除得每个通道的比值，夹在 0.7~1.3，再按 match 插值
function matchedPalette( palette, groundHex, match ) {

	const luminance = ( color ) => Math.max( 1e-4, color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722 );
	const ground = new THREE.Color( groundHex );
	const middle = new THREE.Color( palette.mid );
	const groundLuminance = luminance( ground );
	const middleLuminance = luminance( middle );
	const ratio = [ 'r', 'g', 'b' ].map( ( channel ) => {

		const value = ( ground[ channel ] / groundLuminance ) / Math.max( 1e-4, middle[ channel ] / middleLuminance );
		return 1 + ( Math.min( 1.3, Math.max( 0.7, value ) ) - 1 ) * match;

	} );
	const tinted = {};
	for ( const name of [ 'root', 'mid', 'tip', 'dry' ] ) {

		const value = new THREE.Color( palette[ name ] );
		tinted[ name ] = uniform( new THREE.Color( value.r * ratio[ 0 ], value.g * ratio[ 1 ], value.b * ratio[ 2 ] ) );

	}

	return tinted;

}

// options：
//   name；rings { inner: { size, density }, outer: { size, density }, far: { count, inner, outer } }（米、根 / 平方米，已经按画质档和地点系数算好）；
//   bladeLength [短, 长]（米，再乘成片长短 0.8~1.2、秃斑 0.9~1、ground.lengthScale）；bladeWidth 根部宽（米）；
//   ground( xz ) → { height, density, normal, lengthScale }：场景坐标里某一点的地面高度、长草的密度（0~1）、地面法线、叶长倍数（TSL 节点）；
//   palette { root, mid, tip, dry }（sRGB）、groundColor 地面的草色（校正用）、dryAmount 枯草阈值（0~1，越大枯草越多，0 没有）；
//   lighting( albedo, normal, point, toViewer, { scatter, specular } ) → 着色后的颜色（场景坐标）；atmosphere( color, point ) → 加上大气；
//   wind [x, z]（场景坐标的水平风向）；seed；reflection { inner, outer, far } 倒影里各环画几成（默认 0 / 0.3 / 0.3）；
//   field：ground 用的地点草地图（buildGroundField 的返回值），给了才按它的"附近最大密度"便宜判死（块外、块边 10 米里不判）
export function createGrassField( options ) {

	const rings = options.rings;
	const field = options.field || null;
	const reflection = { inner: 0, outer: 0.3, far: 0.3, ...( options.reflection || {} ) };
	const uniforms = {
		time: uniform( 0 ),
		center: uniform( new THREE.Vector2() ),          // 镜头的水平位置（场景坐标）
		pixelWorld: uniform( 0.001 ),                     // 离镜头每米、一个像素有多宽（米）：2 tan(fov/2) / 场景目标的高
		nearAmount: uniform( 1 ),                         // 调试开关：近草
		farAmount: uniform( 1 ),                          // 调试开关：远草
		clumpAmount: uniform( 1 ),                        // 调试开关：草丛簇（0 时每根草各自随机，看得出丛簇的作用）
		windAmount: uniform( 1 ),                         // 调试开关：草风
		maskAmount: uniform( 1 ),                         // 调试开关：草掩码（0 时水里、路上、崖上也长，看得出掩码去掉了哪些）
		underlayAmount: uniform( 1 ),                     // 调试开关：草根融合
		windDirection: uniform( new THREE.Vector2( options.wind[ 0 ], options.wind[ 1 ] ).normalize() ),
	};
	const nearPalette = matchedPalette( options.palette, options.groundColor, 0.7 );
	const farPalette = matchedPalette( options.palette, options.groundColor, 0.3 );
	const dryAmount = Math.max( options.dryAmount || 0, 0.002 );
	const hasDry = ( options.dryAmount || 0 ) > 0.001 ? 1 : 0;   // 文档 5.9 的坑：dry = 0 时 smoothstep 两个边界相等，结果未定义
	const disposables = [];

	// 草自己的噪声贴图（noiseTexture 开着时用；顶点着色器里取，只要第 0 级）
	let noiseTexture = null;
	if ( perf.noiseTexture ) {

		const noiseData = grassNoise();
		noiseTexture = new THREE.DataTexture( noiseData.data, noiseData.size, noiseData.size, THREE.RGBAFormat, THREE.UnsignedByteType );
		noiseTexture.wrapS = THREE.RepeatWrapping;
		noiseTexture.wrapT = THREE.RepeatWrapping;
		noiseTexture.magFilter = THREE.LinearFilter;
		noiseTexture.minFilter = THREE.LinearFilter;
		noiseTexture.generateMipmaps = false;
		noiseTexture.needsUpdate = true;
		noiseTexture.name = options.name + '·噪声';
		disposables.push( noiseTexture );

	}

	// 值噪声（0~1）：坐标 = xz × scale + offset（+ 额外平移）；贴图版是一次取样，算的版是 4 个格点哈希
	const noiseAt = ( xz, noise, shift = null ) => {

		const position = xz.mul( noise.scale ).add( noise.offset );
		const shifted = shift ? position.add( shift ) : position;
		if ( ! noiseTexture ) return valueNoise2D( shifted );
		const sample = texture( noiseTexture, shifted.div( noiseCells ) ).level( 0 );
		return noise.channel === 0 ? sample.r : sample.g;

	};

	// 风：两层值噪声沿风向滚动 + 一道正弦，平方成一阵一阵的（文档 5.6）。减 0.2 再乘 1.5：大约四成的地方没风，阵风过处才压下去。
	// 贴图版的两层另加一个平移（贴图坐标里 0.37 / 0.53 张），和秃斑、成片长短取的不是同一块
	const gustAt = ( xz ) => {

		const rolling = uniforms.windDirection.mul( uniforms.time );
		const noise = noiseTexture
			? noiseAt( xz, { scale: 0.055, offset: 0, channel: 0 }, rolling.mul( - 0.11 ).add( noiseCells * 0.37 ) ).mul( 0.65 ).add( noiseAt( xz, { scale: 0.19, offset: 0, channel: 1 }, rolling.mul( - 0.35 ).add( noiseCells * 0.53 ) ).mul( 0.35 ) )
			: valueNoise2D( xz.mul( 0.055 ).sub( rolling.mul( 0.11 ) ) ).mul( 0.65 ).add( valueNoise2D( xz.mul( 0.19 ).sub( rolling.mul( 0.35 ) ) ).mul( 0.35 ) );
		const wave = sin( dot( xz, uniforms.windDirection ).mul( 0.42 ).sub( uniforms.time.mul( 1.9 ) ) ).mul( 0.18 );
		return clamp( noise.add( wave ).sub( 0.2 ).mul( 1.5 ), 0, 1 ).pow2();

	};

	const group = new THREE.Group();
	group.name = options.name;

	// 一环草。layer：{ name, segments, count, size（近环取模方块边长）, hole（近外环的内圈半径）, fadeInner（近内环外沿开始淡的半径）,
	//   radial { inner, outer }（远环）, clump（丛簇大小，米）, pull（往丛心拉多少）, coverMax, minPixels, transparent, palette, amount, seed,
	//   skipAtmosphere（不加大气：近环 26 米里大气只有百分之几，见 config.perf.grass.nearAtmosphere）}
	function createRing( layer ) {

		const blades = bladeSeeds( layer.count, layer.seed, layer.radial, layer.size, perf.sortBlades && ( ! layer.radial || perf.sortFar ) );
		const geometry = bladeGeometry( layer.segments, blades, layer.count );
		const seed = attribute( 'bladeSeed', 'vec4' );
		const bladeRank = attribute( 'bladeRank', 'float' );
		const bladeParam = attribute( 'bladeParam', 'vec2' );
		const center = uniforms.center;
		// 顶点压力、倒影：R2 序号小于它的才画（压力 1、不在倒影里时等于总数，一根都不判）
		const rankLimit = uniform( layer.count );
		// 顶点着色器算好传给片元的颜色、远环的不透明度
		const grassColor = varyingProperty( 'vec3', 'grassColor' );
		const grassFade = varyingProperty( 'float', 'grassFade' );
		const palette = layer.palette;

		const material = new THREE.MeshBasicNodeMaterial();
		material.name = options.name + '·' + layer.name;
		material.side = THREE.DoubleSide;
		material.fog = false;
		material.lights = false;
		material.positionNode = Fn( () => {

			// 没过便宜判死、或者判下来是死叶的：所有顶点都在同一点（退化三角形，不出片元）。varying 先给值，每条路上都有赋值
			const position = vec3( 0 ).toVar();
			grassColor.assign( vec3( 0 ) );
			if ( layer.transparent ) grassFade.assign( 0 );

			// ---------- 草根 ----------
			let rootXZ;
			let keep;
			// 每根草的随机数：近环用实例自己的；远环用格子的哈希（镜头走过一格，同一个格子还是同一根草，不会闪）
			let bladeRandom;
			if ( layer.radial ) {

				// 远环：锚点 = 镜头 + 偏移，按 0.25 米量化再在格子里哈希抖动；越远越稀（文档 5.3）
				const anchor = center.add( seed.xy );
				const cell = floor( anchor.div( 0.25 ) );
				rootXZ = cell.add( hash22( cell ) ).mul( 0.25 );
				bladeRandom = hash22( cell.add( vec2( 41.7, 13.1 ) ) );
				const radialDistance = length( rootXZ.sub( center ) );
				keep = clamp( float( 35 ).div( radialDistance ), 0.05, 1 )
					.mul( smoothstep( layer.radial.inner, layer.radial.inner + 5, radialDistance ) )
					.mul( float( 1 ).sub( smoothstep( layer.radial.outer - 12, layer.radial.outer, radialDistance ) ) );

			} else {

				// 近环：边长 size 的方块跟着镜头取模环绕。先算整数的环绕圈数再减：草根 = 种子位置 − 圈数 × size，
				// 圈数不变时每帧按位一样（直接从镜头位置加减的话，浮点舍入每帧都变，靠近丛簇分界的叶片会在两丛之间跳）
				const half = layer.size / 2;
				const seedPosition = seed.xy.mul( layer.size );
				const wraps = floor( seedPosition.sub( center ).add( half ).div( layer.size ) );
				rootXZ = seedPosition.sub( wraps.mul( layer.size ) );
				bladeRandom = seed.zw;
				const radialDistance = length( rootXZ.sub( center ) );
				keep = float( 1 );
				// 内环外沿和外环内圈按同一个圆交叉淡化（两环密度不同，交界处是渐变不是台阶）
				if ( layer.hole ) keep = keep.mul( smoothstep( layer.hole - 2.5, layer.hole - 0.5, radialDistance ) );
				if ( layer.fadeInner ) keep = keep.mul( float( 1 ).sub( smoothstep( layer.fadeInner - 2.5, layer.fadeInner - 0.5, radialDistance ) ) );
				// 外沿：后四成慢慢稀到 15%（密草到稀草是渐变，地面上看不出一条线），最后 2 米淡到 0
				keep = keep.mul( mix( float( 1 ), float( 0.15 ), smoothstep( half * 0.6, half - 2.5, radialDistance ) ) ).mul( float( 1 ).sub( smoothstep( half - 2.5, half - 0.5, radialDistance ) ) );

			}

			// 存活另用一个去相关的随机数：和朝向、色调共用 seed.z 的话，稀的地方活下来的都是 seed.z 小的那些，朝向扎堆、颜色偏暗
			const survival = fract( bladeRandom.x.mul( 7.13 ).add( bladeRandom.y.mul( 3.71 ) ) );

			// ---------- 便宜判死 ----------
			// 活着要满足：存活随机数 ≤ 淡出 × 秃斑 × 密度、开关开着、序号在顶点压力 / 倒影的份额里。秃斑 ≤ 1，密度 ≤ 草地图 A 通道存的
			// 附近最大值（丛簇往丛心拉的那一点也盖住了），所以下面几条都是必要条件：过不了的叶子原来的算法里长、宽也是 0，跳过它们画面不变
			let possible = bladeRank.lessThan( rankLimit ).and( layer.amount.greaterThan( 0 ) );
			if ( perf.cheapCull ) {

				const densityBound = field ? mix( float( 1 ), field.densityBound( rootXZ ), uniforms.maskAmount ) : float( 1 );
				possible = possible.and( survival.lessThanEqual( keep.mul( densityBound ).mul( boundMargin ) ) );

			}

			If( possible, () => {

				// ---------- Voronoi 丛簇（世界固定，clump 米一格）：往丛心拉，同一丛共用长度、色调、倒向（文档 5.2）----------
				// 找最近的丛心，顺手记下赢家格子的哈希（不用再算一次）。clumpSearch = 3 是原来的 3×3；= 2 按格内象限只找 2×2
				// （丛心在格里 0.05~0.95 抖动，最近的那个几乎都在这四格里，少数点找到的是第二近的，9 次哈希省成 4 次）
				const clumpCoord = rootXZ.div( layer.clump );
				const clumpBase = floor( clumpCoord );
				const searchOffsets = [];
				if ( perf.clumpSearch === 2 ) {

					const corner = step( 0.5, clumpCoord.sub( clumpBase ) ).sub( 1 );
					for ( let j = 0; j <= 1; j ++ ) for ( let i = 0; i <= 1; i ++ ) searchOffsets.push( corner.add( vec2( i, j ) ) );

				} else {

					for ( let j = - 1; j <= 1; j ++ ) for ( let i = - 1; i <= 1; i ++ ) searchOffsets.push( vec2( i, j ) );

				}

				let bestPoint = null;
				let bestDistance = null;
				let bestHash = null;
				for ( const searchOffset of searchOffsets ) {

					const cell = clumpBase.add( searchOffset );
					const cellHash = hash22( cell );
					const point = cell.add( cellHash.mul( 0.9 ).add( 0.05 ) );
					const distance = length( point.sub( clumpCoord ) );
					if ( bestPoint === null ) {

						bestPoint = point;
						bestDistance = distance;
						bestHash = cellHash;

					} else {

						const closer = distance.lessThan( bestDistance );
						bestPoint = select( closer, point, bestPoint );
						bestHash = select( closer, cellHash, bestHash );
						bestDistance = min( distance, bestDistance );

					}

				}

				const clumpCenter = bestPoint.mul( layer.clump );
				// 丛的随机数：x 管长短和色调、y 管朝向；关掉丛簇时每根草用自己的随机数（看得出丛簇的作用）
				const clumpRandom = mix( bladeRandom, bestHash, uniforms.clumpAmount ).toVar();
				// 丛的倒向另取两个去相关的数（和长短、朝向分开，长的丛不会全往一边倒）；±0.25 的水平位移
				const clumpLean = vec2( fract( clumpRandom.x.mul( 13.71 ) ), fract( clumpRandom.y.mul( 7.33 ) ) ).sub( 0.5 ).mul( 0.5 );
				const root = mix( rootXZ, clumpCenter, uniforms.clumpAmount.mul( layer.pull ) ).toVar();
				const viewDistance = length( root.sub( center ) ).toVar();

				// ---------- 地面、掩码、秃斑 ----------
				const ground = options.ground( root );
				const density = mix( float( 1 ), ground.density, uniforms.maskAmount );
				// 秃斑、成片长短的噪声：块里离边 10 米以上用地点草地图里烘好的（ground.bakedNoise，和现算的是同一个函数），别处现算
				let bareValue;
				let meadowValue;
				if ( ground.bakedNoise ) {

					const noisePair = vec2( 0 ).toVar();
					If( ground.deepInside, () => {

						noisePair.assign( ground.bakedNoise );

					} ).Else( () => {

						noisePair.assign( vec2( noiseAt( root, bareNoise ), noiseAt( root, meadowNoise ) ) );

					} );
					bareValue = noisePair.x;
					meadowValue = noisePair.y;

				} else {

					bareValue = noiseAt( root, bareNoise );
					meadowValue = noiseAt( root, meadowNoise );

				}

				// 秃斑：大块噪声让草地有疏有密，不像地毯（文档 5.4：0.72 + 0.28 × smoothstep(噪声)）
				const bare = smoothstep( 0.25, 0.65, bareValue ).mul( 0.28 ).add( 0.72 ).toVar();
				const alive = step( survival, keep.mul( bare ).mul( density ) ).mul( layer.amount ).toVar();
				// 成片的长短（8~20 米一片，×0.8~1.2）：草地有高有矮，顶面不是一个平面
				const meadowPatch = meadowValue.toVar();

				// 过了便宜判死、真算下来还是死的（秃斑、密度插值、淡出带里没抽中）：原来长、宽都乘 alive = 0，整片叶子缩在草根上，
				// 不出片元；这里直接留在开头那个点上，风、宽度、光照都不算
				If( alive.greaterThan( 0 ), () => {

					let bladeLength = mix( float( options.bladeLength[ 0 ] ), float( options.bladeLength[ 1 ] ), clumpRandom.x.mul( 0.65 ).add( bladeRandom.y.mul( 0.35 ) ) )
						.mul( meadowPatch.mul( 0.4 ).add( 0.8 ) ).mul( ground.lengthScale ).mul( bare.mul( 0.35 ).add( 0.65 ) ).mul( alive );
					// 远处的草叶在屏幕上太短看不见，越远越长一点（文档 5.3，grow 0.008）
					if ( layer.radial ) bladeLength = bladeLength.mul( float( 1 ).add( max( viewDistance.sub( layer.radial.inner ), 0 ).mul( 0.008 ) ) );
					bladeLength = bladeLength.toVar();

					// ---------- 朝向、倒向、风 ----------
					// 丛的朝向 + 每根 ±1.2 弧度的抖动（一丛里的叶片不完全朝一个方向）
					const yaw = clumpRandom.y.mul( 6.2832 ).add( bladeRandom.x.sub( 0.5 ).mul( 2.4 ) );
					const facing = vec3( sin( yaw ), 0, cos( yaw ) );
					const side = vec3( facing.z, 0, facing.x.negate() );
					const gust = gustAt( root ).mul( uniforms.windAmount );
					// 抖动：两个不同频率的正弦（4.3、7.1 弧度/秒），每根相位不同
					const flutter = sin( uniforms.time.mul( 4.3 ).add( bladeRandom.x.mul( 40 ) ) ).mul( 0.05 ).add( sin( uniforms.time.mul( 7.1 ).add( bladeRandom.y.mul( 60 ) ) ).mul( 0.03 ) ).mul( uniforms.windAmount );
					// 人脚边 0.9 米内往外推（平方衰减）；镜头离地 2~3 米以上不推（站在礁石上、飞起来时，正下方不会压出一个秃圈）
					const rootHeight = ground.height.toVar();
					const away = root.sub( center );
					const cameraLift = cameraPosition.y.sub( rootHeight );
					const push = float( 1 ).sub( smoothstep( 0.2, 0.9, length( away ) ) ).pow2().mul( float( 1 ).sub( smoothstep( 2, 3, cameraLift ) ) );
					// 叶尖水平位移 = 丛的倒向 + 风 × (0.08 + 阵风 × 0.66) + 抖动 + 脚边推开
					const tipRaw = clumpLean
						.add( uniforms.windDirection.mul( gust.mul( 0.66 ).add( uniforms.windAmount.mul( 0.08 ) ) ) )
						.add( vec2( facing.x, facing.z ).mul( flutter ) )
						.add( normalize( away.add( vec2( 1e-4, 0 ) ) ).mul( push.mul( 0.8 ) ) );
					// 保长：水平位移超过 0.94 按比例缩回，竖直抬高 sqrt(1 − tip²)，草叶倒下时总长度不变（文档 5.6）
					const tipFlat = tipRaw.mul( min( float( 1 ), float( 0.94 ).div( max( length( tipRaw ), 1e-4 ) ) ) ).toVar();
					const lift = sqrt( max( float( 1 ).sub( dot( tipFlat, tipFlat ) ), 0.0036 ) );

					// 沿叶片：水平位移按 t² 弯（根部不动），竖直按 t 长
					const along = bladeParam.y;
					const bend = along.mul( along );
					const offset = vec3( tipFlat.x.mul( bend ), lift.mul( along ), tipFlat.y.mul( bend ) ).mul( bladeLength );
					const tangent = normalize( vec3( tipFlat.x.mul( along.mul( 2 ) ), lift, tipFlat.y.mul( along.mul( 2 ) ) ) );
					const rootPoint = vec3( root.x, rootHeight.sub( 0.03 ), root.y ).toVar();

					// ---------- 宽度：侧对相机时加宽、越远越宽（覆盖），再保一个最小像素宽（防闪）（文档 5.7）----------
					// 覆盖和最小像素宽按到眼睛的三维距离算（镜头高出草地时水平距离偏小，最小像素宽会不到一个像素）
					const eyeDistance = length( rootPoint.sub( cameraPosition ) );
					const toCameraFlat = normalize( vec3( cameraPosition.x.sub( root.x ), 0, cameraPosition.z.sub( root.y ) ).add( vec3( 1e-4, 0, 0 ) ) );
					const edgeOn = float( 1 ).sub( abs( dot( facing, toCameraFlat ) ) );
					const coverage = clamp( eyeDistance.div( 4.5 ), 1, layer.coverMax );
					const taper = float( 1 ).sub( pow( along, 1.6 ) ).mul( 0.5 );
					// 每根宽度 ±20%
					const baseWidth = float( options.bladeWidth ).mul( edgeOn.mul( 1.1 ).add( 1 ) ).mul( coverage ).mul( bladeRandom.y.mul( 0.4 ).add( 0.8 ) );
					const rootWidth = max( baseWidth, eyeDistance.mul( uniforms.pixelWorld ).mul( layer.minPixels ) ).mul( alive );
					position.assign( rootPoint.add( offset ).add( side.mul( bladeParam.x.mul( rootWidth.mul( taper ) ) ) ) );

					// ---------- 逐顶点光照（文档 5.8）；死掉的叶片（长度、宽度都是 0）不算 ----------
					If( alive.greaterThan( 0.5 ), () => {

						// 叶面微微卷：左右边的法线各往外偏一点；再和叶片切向正交；背对镜头时翻过来，正反两面受光一样
						const rounded = normalize( facing.add( side.mul( bladeParam.x.mul( 0.5 ) ) ) );
						const bladeNormal = normalize( rounded.sub( tangent.mul( dot( rounded, tangent ) ) ) ).toVar();
						const worldPoint = rootPoint.add( offset );
						const toViewer = normalize( cameraPosition.sub( worldPoint ) );
						bladeNormal.assign( select( dot( bladeNormal, toViewer ).greaterThan( 0 ), bladeNormal, bladeNormal.negate() ) );
						// 5~15 米把叶片法线混到地面法线：远处按地面受光，不会一根根闪；近环最多混八成五（还留一点叶片的明暗），远环全混。
						// 两个法线差不多相反时（镜头在叶片下方）mix 会接近零向量，加一点向上的保底
						const flat = smoothstep( 5, 15, viewDistance ).mul( layer.radial ? 1 : 0.85 );
						const normal = normalize( mix( bladeNormal, ground.normal, flat ).add( vec3( 0, 1e-3, 0 ) ) );
						// 颜色：根 → 中段 → 叶尖（叶尖按丛的色调混进去），少数丛偏枯；根部压暗（草丛里的遮蔽）
						const tone = clumpRandom.x.mul( 0.6 ).add( bladeRandom.y.mul( 0.4 ) );
						// 成片的深浅：长得高的那片草深而润（暗一点），矮的那片浅而偏黄
						const patchShade = float( 1.12 ).sub( meadowPatch.mul( 0.25 ) );
						const body = mix( palette.root, palette.mid, smoothstep( 0, 0.55, along ) );
						const albedo = mix( body, palette.tip, smoothstep( 0.45, 1, along ).mul( tone.mul( 0.6 ).add( 0.4 ) ) ).toVar();
						albedo.assign( mix( albedo, palette.dry, smoothstep( float( 1 - dryAmount ), 1, tone ).mul( hasDry * 0.6 ) ) );
						albedo.assign( mix( albedo, palette.dry, float( 1 ).sub( meadowPatch ).mul( 0.22 ).mul( smoothstep( 0.4, 1, along ) ) ).mul( patchShade ) );
						const occlusion = mix( float( 0.14 ), float( 1 ), smoothstep( 0, 0.85, along ) );
						// 高光只在叶片中段、14 米以内（Blinn-Phong 28，最多 0.35）；逆光透射只给近环（远环开着会整片发白，文档 5.8）
						const specular = layer.radial ? float( 0 ) : smoothstep( 0.25, 0.6, along ).mul( float( 1 ).sub( smoothstep( 0.6, 0.9, along ) ) ).mul( float( 1 ).sub( smoothstep( 8, 14, viewDistance ) ) ).mul( 0.35 );
						const scatter = layer.radial ? float( 0 ) : along.mul( 0.6 );
						const lit = options.lighting( albedo.mul( occlusion ), normal, worldPoint, toViewer, { scatter, specular } );
						grassColor.assign( layer.skipAtmosphere ? lit : options.atmosphere( lit, worldPoint ) );
						// 远环：近端从 inner 起 6 米淡入、远端后一半淡出（不写深度，地面从草缝里透出来）；最多 0.85 不透明（叠起来也不成墙）
						if ( layer.transparent ) grassFade.assign( smoothstep( layer.radial.inner, layer.radial.inner + 6, viewDistance ).mul( float( 1 ).sub( smoothstep( layer.radial.outer * 0.5, layer.radial.outer, viewDistance ) ) ).mul( 0.85 ) );

					} );

				} );

			} );
			return position;

		} )();

		if ( layer.transparent ) {

			material.colorNode = vec4( grassColor, grassFade );
			material.transparent = true;
			material.depthWrite = false;
			// 半透明 + 双面时 three 默认先画背面再画正面（两遍）；草叶是单层薄片、同一个网格里本来也排不了序，一遍就够
			material.forceSinglePass = true;

		} else {

			material.colorNode = vec4( grassColor, 1 );

		}

		const mesh = new THREE.Mesh( geometry, material );
		mesh.name = material.name;
		mesh.frustumCulled = false;     // 草根在着色器里环绕定位，包围盒没有意义
		// 实心的草先画（renderOrder −1）：草下面的地面片元被深度挡掉，草越密地面越省；远环半透明，在不透明的之后画
		mesh.renderOrder = layer.transparent ? 4 : - 1;
		group.add( mesh );
		disposables.push( geometry, material );
		return { mesh, geometry, count: layer.count, vertices: layer.count * ( layer.segments * 2 + 1 ), bucketStarts: blades.bucketStarts, rankLimit };

	}

	const inner = createRing( {
		name: '近内环', segments: 3, count: Math.round( rings.inner.size * rings.inner.size * rings.inner.density ), size: rings.inner.size,
		fadeInner: rings.inner.size / 2, clump: 0.3, pull: 0.25, coverMax: 2.2, minPixels: 1, palette: nearPalette, amount: uniforms.nearAmount, seed: ( options.seed || 1 ) * 3 + 1,
		skipAtmosphere: ! perf.nearAtmosphere,
	} );
	const outer = createRing( {
		name: '近外环', segments: 2, count: Math.round( rings.outer.size * rings.outer.size * rings.outer.density ), size: rings.outer.size,
		hole: rings.inner.size / 2, clump: 0.3, pull: 0.25, coverMax: 3.2, minPixels: 1, palette: nearPalette, amount: uniforms.nearAmount, seed: ( options.seed || 1 ) * 3 + 2,
		skipAtmosphere: ! perf.nearAtmosphere,
	} );
	// 远环的丛簇大一倍、覆盖上限 2.4（文档是 1.5；本项目远处地面没有 3DGS 那层糊掉的草，远草要多盖一点，半透明 0.85 不会成墙）
	const far = rings.far.count > 0 ? createRing( {
		name: '远环', segments: 1, count: rings.far.count, radial: { inner: rings.far.inner, outer: rings.far.outer },
		clump: 0.6, pull: 0.2, coverMax: 2.4, minPixels: 0.35, transparent: true, palette: farPalette, amount: uniforms.farAmount, seed: ( options.seed || 1 ) * 3 + 3,
	} ) : null;
	const ringList = [ inner, outer, far ].filter( Boolean );
	const reflectionShare = new Map( [ [ inner, reflection.inner ], [ outer, reflection.outer ], [ far, reflection.far ] ] );
	let pressure = 1;
	let inReflection = false;

	function applyCounts() {

		// 顶点压力：只画 R2 序号的前 count × 比例根（R2 序列任意前缀都均匀，等于整片均匀变稀）；倒影里各环按 reflection 画几成。
		// 实例按桶排过序：instanceCount 截到盖住这些序号的那个桶的末尾，桶里多出来的由着色器按 bladeRank 判掉
		for ( const ring of ringList ) {

			let factor = pressure;
			if ( inReflection ) factor *= reflectionShare.get( ring );
			const limit = Math.min( ring.count, Math.max( 0, Math.floor( ring.count * factor ) ) );
			const lastBucket = limit > 0 ? Math.floor( ( limit - 1 ) * rankBuckets / ring.count ) : - 1;
			ring.geometry.instanceCount = limit > 0 ? ring.bucketStarts[ lastBucket + 1 ] : 0;
			ring.rankLimit.value = limit;
			ring.mesh.visible = limit > 0;

		}

	}

	const drawingSize = new THREE.Vector2();
	const worldPoint = new THREE.Vector3();
	const underlayRoot = nearPalette.root.mul( grassUnderlayShape.rootBoost );
	const underlayMiddle = nearPalette.mid.mul( grassUnderlayShape.middleScale );
	// 同样的两个颜色给远景（线性）
	const underlayColor = nearPalette.root.value.clone().multiplyScalar( grassUnderlayShape.rootBoost );
	const middleColor = nearPalette.mid.value.clone().multiplyScalar( grassUnderlayShape.middleScale );
	return {
		group,
		uniforms,
		blades: ringList.reduce( ( sum, ring ) => sum + ring.count, 0 ),
		vertices: ringList.reduce( ( sum, ring ) => sum + ring.vertices, 0 ),
		counts: { inner: inner.count, outer: outer.count, far: far ? far.count : 0 },
		// 草根融合（文档第 6 节）：地点自己的地面在近环里往草根色压，草缝里看到的是暗的草根，不是亮的地面；
		// 远环范围里往草的中段色靠（形状见 grassUnderlayShape）。albedo 是地面材质里的节点，pointXZ 是场景坐标；
		// density 是长草的密度：节点，或者返回节点的函数（推荐：近环、远环半径外两个权重都正好是 0，那里的像素连密度都不取——
		// 密度要查地点和远景两张草地图；传节点的话它在调用之前已经建好，省不掉）。必须在 Fn 里调（用了 If）
		underlay( albedo, pointXZ, density ) {

			const radius = rings.outer.size / 2;
			const reach = Math.max( radius, rings.far.count > 0 ? rings.far.outer : 0 );
			const result = vec3( albedo ).toVar();
			const distance = length( pointXZ.sub( uniforms.center ) ).toVar();
			If( distance.lessThan( reach ), () => {

				const strength = ( typeof density === 'function' ? density() : density ).mul( uniforms.underlayAmount );
				let blended = result;
				if ( rings.far.count > 0 ) {

					const farness = float( 1 ).sub( smoothstep( rings.far.outer * grassUnderlayShape.farStart, rings.far.outer, distance ) ).mul( grassUnderlayShape.farStrength ).mul( uniforms.farAmount );
					blended = mix( blended, underlayMiddle, farness.mul( strength ) );

				}

				const nearness = float( 1 ).sub( smoothstep( radius * grassUnderlayShape.nearStart, radius, distance ) ).mul( grassUnderlayShape.nearStrength ).mul( uniforms.nearAmount );
				result.assign( mix( blended, underlayRoot, nearness.mul( strength ) ) );

			} );
			return result;

		},
		// 每帧：时间、镜头位置（场景坐标）、像素宽（场景目标的高，mid 档按场景比例算）、顶点压力；
		// toWorld( 场景坐标 Vector3 ) → 世界坐标：给了就把近环圆心告诉远景，草长到远景地面上那部分也压草根色
		update( time, position, ctx, toWorld = null ) {

			uniforms.time.value = time;
			uniforms.center.value.set( position.x, position.z );
			ctx.renderer.getDrawingBufferSize( drawingSize );
			const quality = ctx.quality;
			const scale = quality && quality.mode === 'upscale' ? quality.renderScale : 1;
			uniforms.pixelWorld.value = 2 * Math.tan( THREE.MathUtils.degToRad( ctx.camera.fov ) / 2 ) / Math.max( 1, drawingSize.y * scale );
			if ( quality ) quality.vertexPressureUsedAt = performance.now();
			const nextPressure = quality && Number.isFinite( quality.vertexPressure ) ? quality.vertexPressure : 1;
			if ( nextPressure !== pressure ) {

				pressure = nextPressure;
				applyCounts();

			}

			if ( toWorld && ctx.backdrop && ctx.backdrop.setGrassUnderlay ) {

				const world = toWorld( worldPoint.copy( position ) );
				ctx.backdrop.setGrassUnderlay( {
					x: world.x, z: world.z, radius: rings.outer.size / 2, farRadius: rings.far.count > 0 ? rings.far.outer : 0,
					amount: uniforms.underlayAmount.value, nearAmount: uniforms.nearAmount.value, farAmount: uniforms.farAmount.value,
					rootColor: underlayColor, middleColor,
				} );

			}

		},
		beginReflection() {

			inReflection = true;
			applyCounts();

		},
		endReflection() {

			inReflection = false;
			applyCounts();

		},
		layers() {

			return {
				近草: uniforms.nearAmount,
				远草: uniforms.farAmount,
				草丛簇: uniforms.clumpAmount,
				草风: uniforms.windAmount,
				草根融合: uniforms.underlayAmount,
				草掩码: uniforms.maskAmount,
			};

		},
		dispose() {

			for ( const item of disposables ) item.dispose();

		},
	};

}

// 地点自己的草地图（半精度，局部坐标）。半精度在 64~128 米一格 6 厘米，比草根往下沉的 3 厘米还大，高处的草会浮起来，所以高度拆成两份存：
//   主图 RGBA：R 粗高度（取到 0.25 米的整数倍，半精度在 512 米以内存得准）、G 细高度（余下的 ±0.125 米，精度到 0.1 毫米）、B 长草的密度、
//     A 便宜判死用的上界：这一格附近 ±2 格里密度的最大值（烘了秃斑时再乘附近秃斑系数的最大值），往上取整；
//   法线图 RG：地面法线的 x、z；烘了秃斑、成片长短（config.perf.grass.bakeNoise）时是 RGBA，B、A 是这两个噪声（和草着色器里现算的同一个函数）。
//   双线性插值对和是线性的，粗 + 细插出来就是高度的插值。
// heightAt( x, z )、densityAt( x, z, slope ) 是 JS 函数（slope = 1 − 法线 y）；切片计算，开场卡阶段做完。
// 返回 { textures, sample( xz ) → { value: vec4(高度, 密度, 法线 x, 法线 z), edge: 离矩形边多远（米，负数在外面）, noise: vec2(秃斑, 成片长短) 或 null },
//   densityBound( xz ) → 离边 10.5 米以上是 A 通道的上界，别处 1 }
export async function buildGroundField( { rect, spacing, heightAt, densityAt, name, yieldToBrowser } ) {

	const width = Math.round( ( rect.maxX - rect.minX ) / spacing ) + 1;
	const height = Math.round( ( rect.maxZ - rect.minZ ) / spacing ) + 1;
	const heights = new Float32Array( width * height );
	let sliceStart = performance.now();
	for ( let j = 0; j < height; j ++ ) {

		const z = rect.minZ + j * spacing;
		for ( let i = 0; i < width; i ++ ) {

			const value = heightAt( rect.minX + i * spacing, z );
			if ( ! Number.isFinite( value ) ) throw new Error( `${ name }：(${ ( rect.minX + i * spacing ).toFixed( 1 ) }, ${ z.toFixed( 1 ) }) 的地面高度无效，草没法落地` );
			if ( Math.abs( value ) > 500 ) throw new Error( `${ name }：地面高度 ${ value.toFixed( 1 ) } 米超出了草地图能存的范围（±500 米）` );
			heights[ j * width + i ] = value;

		}

		if ( performance.now() - sliceStart > 12 ) {

			await yieldToBrowser();
			sliceStart = performance.now();

		}

	}

	const bakeNoise = perf.bakeNoise;
	const normalChannels = bakeNoise ? 4 : 2;
	const data = new Uint16Array( width * height * 4 );
	const normalData = new Uint16Array( width * height * normalChannels );
	const toHalf = THREE.DataUtils.toHalfFloat;
	const fromHalf = THREE.DataUtils.fromHalfFloat;
	// 上界按着色器真正读到的数算（半精度存过再取回来的密度、秃斑噪声）
	const storedDensity = new Float32Array( width * height );
	const storedBare = new Float32Array( width * height );
	const normal = new THREE.Vector3();
	for ( let j = 0; j < height; j ++ ) {

		const z = rect.minZ + j * spacing;
		for ( let i = 0; i < width; i ++ ) {

			const index = j * width + i;
			const x = rect.minX + i * spacing;
			const left = heights[ j * width + Math.max( 0, i - 1 ) ];
			const right = heights[ j * width + Math.min( width - 1, i + 1 ) ];
			const down = heights[ Math.max( 0, j - 1 ) * width + i ];
			const up = heights[ Math.min( height - 1, j + 1 ) * width + i ];
			normal.set( ( left - right ) / ( 2 * spacing ), 1, ( down - up ) / ( 2 * spacing ) ).normalize();
			const density = Math.min( 1, Math.max( 0, densityAt( x, z, 1 - normal.y ) ) );
			const coarse = Math.round( heights[ index ] * 4 ) / 4;
			data[ index * 4 ] = toHalf( coarse );
			data[ index * 4 + 1 ] = toHalf( heights[ index ] - coarse );
			data[ index * 4 + 2 ] = toHalf( density );
			storedDensity[ index ] = fromHalf( data[ index * 4 + 2 ] );
			normalData[ index * normalChannels ] = toHalf( normal.x );
			normalData[ index * normalChannels + 1 ] = toHalf( normal.z );
			storedBare[ index ] = 1;
			if ( bakeNoise ) {

				normalData[ index * normalChannels + 2 ] = toHalf( noiseValueJs( bareNoise, x, z ) );
				normalData[ index * normalChannels + 3 ] = toHalf( noiseValueJs( meadowNoise, x, z ) );
				// 秃斑系数 = 0.72 + 0.28 × smoothstep(0.25, 0.65, 噪声)，和草着色器里一样；单调的，噪声取最大处它也最大
				const bareRaw = Math.min( 1, Math.max( 0, ( fromHalf( normalData[ index * normalChannels + 2 ] ) - 0.25 ) / 0.4 ) );
				storedBare[ index ] = 0.72 + 0.28 * bareRaw * bareRaw * ( 3 - 2 * bareRaw );

			}

		}

		if ( performance.now() - sliceStart > 12 ) {

			await yieldToBrowser();
			sliceStart = performance.now();

		}

	}

	// A 通道：±dilateTexels 格里的最大密度 × 最大秃斑系数（先横后竖两遍取最大）。丛簇往丛心拉的 0.16 米（不到半格）加上
	// 双线性取样用到的那一格，草根附近四个格点都在这个范围里，插出来的密度 × 秃斑不会超过它
	const dilateTexels = Math.ceil( 0.2 / spacing ) + 1;
	const dilate = ( source ) => {

		const across = new Float32Array( width * height );
		const result = new Float32Array( width * height );
		for ( let j = 0; j < height; j ++ ) {

			for ( let i = 0; i < width; i ++ ) {

				let largest = 0;
				for ( let k = Math.max( 0, i - dilateTexels ); k <= Math.min( width - 1, i + dilateTexels ); k ++ ) largest = Math.max( largest, source[ j * width + k ] );
				across[ j * width + i ] = largest;

			}

		}

		for ( let j = 0; j < height; j ++ ) {

			for ( let i = 0; i < width; i ++ ) {

				let largest = 0;
				for ( let k = Math.max( 0, j - dilateTexels ); k <= Math.min( height - 1, j + dilateTexels ); k ++ ) largest = Math.max( largest, across[ k * width + i ] );
				result[ j * width + i ] = largest;

			}

		}

		return result;

	};
	const densityMax = dilate( storedDensity );
	const bareMax = bakeNoise ? dilate( storedBare ) : null;
	await yieldToBrowser();
	sliceStart = performance.now();
	for ( let index = 0; index < width * height; index ++ ) {

		const bound = densityMax[ index ] * ( bareMax ? bareMax[ index ] : 1 );
		let half = toHalf( bound );
		// 半精度舍入可能往下：往上挪一档，上界只能偏大不能偏小
		if ( fromHalf( half ) < bound ) half += 1;
		data[ index * 4 + 3 ] = half;

	}

	const makeTexture = ( array, format, label ) => {

		const result = new THREE.DataTexture( array, width, height, format, THREE.HalfFloatType );
		result.magFilter = THREE.LinearFilter;
		result.minFilter = THREE.LinearFilter;
		result.generateMipmaps = false;
		result.wrapS = THREE.ClampToEdgeWrapping;
		result.wrapT = THREE.ClampToEdgeWrapping;
		result.needsUpdate = true;
		result.name = label;
		return result;

	};

	const fieldTexture = makeTexture( data, THREE.RGBAFormat, name );
	const normalTexture = makeTexture( normalData, bakeNoise ? THREE.RGBAFormat : THREE.RGFormat, name + '·法线' );
	// 格点在 minX + i·spacing 上：贴图坐标 = (位置 − 原点) / ((格数 − 1)·spacing) × (格数 − 1)/格数 + 半个纹素（矩形边长不是 spacing 的整数倍也对齐）
	const origin = vec2( rect.minX, rect.minZ );
	const gridSize = vec2( ( width - 1 ) * spacing, ( height - 1 ) * spacing );
	const uvOf = ( xz ) => xz.sub( origin ).div( gridSize ).mul( vec2( ( width - 1 ) / width, ( height - 1 ) / height ) ).add( vec2( 0.5 / width, 0.5 / height ) );
	const edgeOf = ( xz ) => min( min( xz.x.sub( rect.minX ), float( rect.maxX ).sub( xz.x ) ), min( xz.y.sub( rect.minZ ), float( rect.maxZ ).sub( xz.y ) ) );
	return {
		textures: [ fieldTexture, normalTexture ],
		sample( xz ) {

			const uv = uvOf( xz );
			const main = texture( fieldTexture, uv ).level( 0 );
			const slope = texture( normalTexture, uv ).level( 0 );
			return { value: vec4( main.x.add( main.y ), main.z, slope.x, slope.y ), edge: edgeOf( xz ), noise: bakeNoise ? slope.zw : null };

		},
		// 便宜判死的密度上界（草根挪到丛心之前的位置 xz）：离块边 10.5 米以上取 A 通道；块边上密度要和远景交叉过渡、秃斑是现算的，给 1（不判）
		densityBound( xz ) {

			return max( texture( fieldTexture, uvOf( xz ) ).level( 0 ).w, float( 1 ).sub( step( deepInside + 0.5, edgeOf( xz ) ) ) );

		},
	};

}

// 草落地：地点自己的草地图（块里）和远景的草地图（块外）接起来。高度、法线块里用自己的、块外用远景的
// （地点地形在块边上贴着远景的高度，两边在边上一样）；密度在块边 10 米里交叉过渡。lengthScale 叶长倍数（节点或数）。
// 块里离边 10 米以上时交叉过渡和块里块外的选择都已经是"全用自己的"，远景那几次取样（4 个格点 + 噪声 + 地表图 + 岩石判断）不做。
// 用了 If，必须在 Fn 里调；返回的 deepInside（离边 10 米以上）、bakedNoise（烘好的秃斑、成片长短，没烘是 null）给草用
export function blendGround( field, backdrop, xz, lengthScale = 1 ) {

	const local = field.sample( xz );
	// 两条路都要用的先落成变量：分支里第一次用到的节点只在那个分支里赋值，另一条路读到的是没赋值的变量
	const localValue = local.value.toVar();
	const edge = local.edge.toVar();
	// 法线只存了 x、z：y = sqrt(1 − x² − z²)（法线朝上，y 一定是正的）
	const localNormal = normalize( vec3( localValue.z, sqrt( max( float( 1 ).sub( localValue.z.mul( localValue.z ) ).sub( localValue.w.mul( localValue.w ) ), 0.01 ) ), localValue.w ) ).toVar();
	const height = float( 0 ).toVar();
	const density = float( 0 ).toVar();
	const normal = vec3( 0, 1, 0 ).toVar();
	const deep = edge.greaterThan( deepInside );
	If( deep, () => {

		height.assign( localValue.x );
		density.assign( localValue.y );
		normal.assign( normalize( localNormal ) );

	} ).Else( () => {

		const outside = backdrop.grassGround( xz );
		const inside = step( 0.25, edge );
		const blend = smoothstep( 0, 10, edge );
		height.assign( mix( outside.height, localValue.x, inside ) );
		density.assign( mix( outside.density, localValue.y, blend ) );
		normal.assign( normalize( mix( outside.normal, localNormal, inside ) ) );

	} );
	// 山洞挖掉的那截地形上不长草（远景提供 caveKeep 时）
	const caveKeep = typeof backdrop.caveKeep === 'function' ? backdrop.caveKeep( xz, height ) : float( 1 );
	return {
		height,
		density: density.mul( caveKeep ),
		normal,
		lengthScale: float( lengthScale ),
		deepInside: deep,
		bakedNoise: local.noise,
	};

}

// 某个画质内容档的三环数量，乘上地点自己的密度倍数（density 全部、innerDensity 只乘内环；填 0 就是这个地点不长草）
export function resolveRings( fieldConfig, content, grassConfig ) {

	const base = fieldConfig.rings[ content ] || fieldConfig.rings.lo;
	const density = grassConfig.density ?? 1;
	const innerDensity = grassConfig.innerDensity ?? 1;
	return {
		inner: { size: base.inner.size, density: base.inner.density * density * innerDensity },
		outer: { size: base.outer.size, density: base.outer.density * density },
		far: { count: Math.round( base.far.count * density ), inner: base.far.inner, outer: base.far.outer },
	};

}
