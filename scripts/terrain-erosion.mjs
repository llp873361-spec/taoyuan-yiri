// 地形侵蚀（阶段 12 / CP1）：给 scripts/bake-terrain.mjs 用的离线侵蚀函数。只在 Node 里跑，不进构建。
//
// 约定：
//   - 高度场是 Float32Array，按行存，下标 = z * width + x，单位米；cellSize 是格距（米）。
//   - 侵蚀函数全部原地修改 heights，返回一个小的统计对象（体积单位立方米、时间单位毫秒）。
//   - 网格是"节点对齐"：第 0 列和最后一列落在区域的两条边上，粗细网格之间按 (源宽 − 1) / (目标宽 − 1) 换算坐标，
//     所以降采样、放大、再把差值叠回细网格，位置不会错半格。
//   - hardness（可选，Float32Array，0 到 1）：1 = 完全保护，这个格子的侵蚀和沉积都按 (1 − hardness) 缩放到 0。
//     玩法区、河道、湖、洞口这些不能动的地方给 1；边缘先用 smoothMask 羽化，否则保护区边上会切出一道台阶。
//   - 全部确定性：同样的输入、同样的 seed，输出逐位相同（只有加减乘除和 Math 函数，没有并行、没有 Date）。
//
// 推荐的调用顺序（erosion-test.mjs 就是这么跑的）：
//   1. downsampleAverage 把细网格降到约 16 m 的粗网格，hardness 也一起降；
//      streamPowerErode 在粗网格上刻出树枝状的主沟谷；
//      粗网格"侵蚀后 − 侵蚀前"的差值用 upsampleBilinear 放大回细网格，再乘 (1 − 细网格 hardness) 叠加上去。
//      （放大后的差值会渗进保护区边缘一两格，所以这一步必须乘细网格的 hardness。）
//   2. 细网格 thermalErode：比休止角陡的地方往下崩，坡脚堆出碎石裙，也把沟谷的 V 形侧壁磨到休止角。
//   3. 细网格 dropletErode：雨滴冲出细冲沟，坡脚、沟口沉积出冲积扇。
//   4. 细网格 thermalErode 再跑十来轮：把雨滴留下的尖锐沟沿磨圆，去掉单格毛刺。

// 8 邻域：右、右下、下、左下、左、左上、上、右上
const neighbourOffsetX = [ 1, 1, 0, - 1, - 1, - 1, 0, 1 ];
const neighbourOffsetZ = [ 0, 1, 1, 1, 0, - 1, - 1, - 1 ];
// 到邻居的距离（以格为单位），对角是 √2
const neighbourDistance = [ 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2 ];

// 填洼时每往里走一格最少抬高的量（米）。用 Float64 存填洼高度，几百米的海拔上 1e-5 米不会被舍入吃掉；
// 一片 200 格宽的湖面也只抬高 2 毫米，而且只用来定流向，不写回地形
const floodEpsilon = 1e-5;

function checkGrid( functionName, values, width, height ) {

	if ( ! Number.isInteger( width ) || ! Number.isInteger( height ) || width < 2 || height < 2 ) {

		throw new Error( `${ functionName }：网格尺寸不对（width = ${ width }，height = ${ height }），两边都至少要 2 格` );

	}

	if ( ! ( values instanceof Float32Array ) ) {

		throw new Error( `${ functionName }：高度场必须是 Float32Array` );

	}

	if ( values.length !== width * height ) {

		throw new Error( `${ functionName }：高度场长度 ${ values.length } 和 ${ width } × ${ height } 对不上` );

	}

}

function checkHardness( functionName, hardness, width, height ) {

	if ( hardness === null || hardness === undefined ) return null;
	if ( ! ( hardness instanceof Float32Array ) || hardness.length !== width * height ) {

		throw new Error( `${ functionName }：hardness 必须是长度 ${ width * height } 的 Float32Array` );

	}

	return hardness;

}

function checkCellSize( functionName, cellSize ) {

	if ( ! ( cellSize > 0 ) || ! Number.isFinite( cellSize ) ) {

		throw new Error( `${ functionName }：cellSize 必须是正数（米），现在是 ${ cellSize }` );

	}

}

// 统计"现在的高度 − 开始时的高度"绝对值最大的那一格
function measureMaxChange( heights, startHeights ) {

	let maxChange = 0;
	for ( let i = 0; i < heights.length; i ++ ) {

		const change = Math.abs( heights[ i ] - startHeights[ i ] );
		if ( change > maxChange ) maxChange = change;

	}

	return maxChange;

}

// ---------------------------------------------------------------------------------------------
// 1. 带种子的随机数
// ---------------------------------------------------------------------------------------------

// mulberry32（Tommy Ettinger 公开的 32 位小随机数）：状态每次加一个奇数常数，再做两轮乘法和移位混合。
// 周期 2^32，统计质量对撒几十万个雨滴足够；返回 [0, 1) 的数。
export function createRandom( seed ) {

	if ( ! Number.isFinite( seed ) ) {

		throw new Error( `createRandom：seed 必须是有限数字，现在是 ${ seed }` );

	}

	let state = Math.floor( seed ) >>> 0;
	return function nextRandom() {

		state = ( state + 0x6d2b79f5 ) >>> 0;
		let mixed = state;
		mixed = Math.imul( mixed ^ ( mixed >>> 15 ), mixed | 1 );
		mixed ^= mixed + Math.imul( mixed ^ ( mixed >>> 7 ), mixed | 61 );
		return ( ( mixed ^ ( mixed >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// ---------------------------------------------------------------------------------------------
// 2. 流向和汇水面积
// ---------------------------------------------------------------------------------------------

// 每个格子的水往哪流（D8 最陡下降）、从高到低的处理顺序、上游汇水格数。
//
// 做法：
//   - 先在一份 Float64 副本上做 Priority-Flood+ε 填洼（Barnes, Lehman, Mulla 2014，
//     《Priority-Flood: An optimal depression-filling and watershed-labeling algorithm》）：
//     网格四条边和海面以下（≤ seaLevel）的格子是出水口，先进最小堆；每次弹出最低的格子，
//     把还没访问的邻居抬到 max(自身高度, 当前高度 + ε) 再入堆。这样坑和平地里每一格都有一个严格更低的邻居，
//     水一定能流到边界或海里。输入的 heights 不改。
//   - 在填洼后的高度上取 D8 最陡下降（落差 / 距离最大的邻居）当 receiver；出水口的 receiver 是 −1。
//   - 出堆顺序天然是从低到高，倒过来就是"从高到低"的顺序：每个格子都排在它的 receiver 前面（receiver 严格更低、更早出堆）。
//   - 沿这个顺序把每格的面积加给 receiver，得到汇水格数（含自己）。
//
//   - 汇水面积默认用多流向（MFD）累加：每格的面积按 坡度^flowExponent 的比例分给所有更低的邻居
//     （Freeman 1991《Calculating catchment area with divergent flow based on a regular grid》，
//     指数取法见 Holmgren 1994《Multiple flow direction algorithms for runoff modelling in grid based elevation models》，
//     4 到 8 之间汇流比较像真实地形）。只用 D8 累加时，光滑的山脚斜面上每一格都朝同一个方向流，
//     汇水面积沿网格方向排成一条条平行直线，下切以后就是"电路板"一样的直沟；MFD 让面积按真实坡向散开，沟只在真正汇流的地方长出来。
//     flowExponent = 0 时退回纯 D8 累加。receivers 和 order 不受影响，下切仍沿最陡的 receiver 算坡度。
//
// 返回 { receivers: Int32Array, order: Int32Array（从高到低），area: Float32Array（上游格数，含自己；MFD 下是小数） }
export function computeFlow( { heights, width, height, seaLevel = - Infinity, flowExponent = 4 } ) {

	checkGrid( 'computeFlow', heights, width, height );
	const cellCount = width * height;

	const filledHeights = new Float64Array( cellCount );
	// 0 = 还没入堆，1 = 已入堆，2 = 出水口
	const cellState = new Uint8Array( cellCount );
	const popOrder = new Int32Array( cellCount );
	const heapKeys = new Float64Array( cellCount );
	const heapCells = new Int32Array( cellCount );
	let heapSize = 0;

	function heapPush( cell, key ) {

		let slot = heapSize ++;
		while ( slot > 0 ) {

			const parent = ( slot - 1 ) >> 1;
			if ( heapKeys[ parent ] <= key ) break;
			heapKeys[ slot ] = heapKeys[ parent ];
			heapCells[ slot ] = heapCells[ parent ];
			slot = parent;

		}

		heapKeys[ slot ] = key;
		heapCells[ slot ] = cell;

	}

	function heapPop() {

		const topCell = heapCells[ 0 ];
		heapSize --;
		if ( heapSize > 0 ) {

			const lastKey = heapKeys[ heapSize ];
			const lastCell = heapCells[ heapSize ];
			let slot = 0;
			while ( true ) {

				let child = slot * 2 + 1;
				if ( child >= heapSize ) break;
				if ( child + 1 < heapSize && heapKeys[ child + 1 ] < heapKeys[ child ] ) child ++;
				if ( heapKeys[ child ] >= lastKey ) break;
				heapKeys[ slot ] = heapKeys[ child ];
				heapCells[ slot ] = heapCells[ child ];
				slot = child;

			}

			heapKeys[ slot ] = lastKey;
			heapCells[ slot ] = lastCell;

		}

		return topCell;

	}

	// 出水口：四条边 + 海面以下
	for ( let z = 0; z < height; z ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			const cell = z * width + x;
			const onBorder = x === 0 || z === 0 || x === width - 1 || z === height - 1;
			if ( onBorder || heights[ cell ] <= seaLevel ) {

				filledHeights[ cell ] = heights[ cell ];
				cellState[ cell ] = 2;
				heapPush( cell, filledHeights[ cell ] );

			}

		}

	}

	// 从低往高淹：弹出最低的格子，邻居至少比它高 ε
	let popCount = 0;
	while ( heapSize > 0 ) {

		const cell = heapPop();
		popOrder[ popCount ++ ] = cell;
		const cellX = cell % width;
		const cellZ = ( cell - cellX ) / width;
		const floodLevel = filledHeights[ cell ] + floodEpsilon;
		for ( let k = 0; k < 8; k ++ ) {

			const neighbourX = cellX + neighbourOffsetX[ k ];
			const neighbourZ = cellZ + neighbourOffsetZ[ k ];
			if ( neighbourX < 0 || neighbourZ < 0 || neighbourX >= width || neighbourZ >= height ) continue;
			const neighbour = neighbourZ * width + neighbourX;
			if ( cellState[ neighbour ] !== 0 ) continue;
			cellState[ neighbour ] = 1;
			filledHeights[ neighbour ] = Math.max( heights[ neighbour ], floodLevel );
			heapPush( neighbour, filledHeights[ neighbour ] );

		}

	}

	// D8 最陡下降：在填洼高度上找"落差 / 距离"最大的更低邻居
	const receivers = new Int32Array( cellCount ).fill( - 1 );
	for ( let z = 0; z < height; z ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			const cell = z * width + x;
			if ( cellState[ cell ] === 2 ) continue;
			const cellHeight = filledHeights[ cell ];
			let steepestSlope = 0;
			let steepestNeighbour = - 1;
			for ( let k = 0; k < 8; k ++ ) {

				const neighbour = ( z + neighbourOffsetZ[ k ] ) * width + x + neighbourOffsetX[ k ];
				const slope = ( cellHeight - filledHeights[ neighbour ] ) / neighbourDistance[ k ];
				if ( slope > steepestSlope ) {

					steepestSlope = slope;
					steepestNeighbour = neighbour;

				}

			}

			receivers[ cell ] = steepestNeighbour;

		}

	}

	// 出堆顺序倒过来 = 从高到低
	const order = new Int32Array( cellCount );
	for ( let i = 0; i < cellCount; i ++ ) order[ i ] = popOrder[ cellCount - 1 - i ];

	// 汇水格数：从高往低，把自己的面积交给下游（Float64 累加，最后转 Float32）
	const areaSum = new Float64Array( cellCount ).fill( 1 );
	const shareWeight = new Float64Array( 8 );
	for ( let i = 0; i < cellCount; i ++ ) {

		const cell = order[ i ];
		const receiver = receivers[ cell ];
		if ( receiver < 0 ) continue;
		if ( ! ( flowExponent > 0 ) ) {

			areaSum[ receiver ] += areaSum[ cell ];
			continue;

		}

		// 多流向：按 坡度^flowExponent 分给所有更低的邻居
		const cellX = cell % width;
		const cellZ = ( cell - cellX ) / width;
		const cellHeight = filledHeights[ cell ];
		let weightSum = 0;
		for ( let k = 0; k < 8; k ++ ) {

			shareWeight[ k ] = 0;
			const neighbourX = cellX + neighbourOffsetX[ k ];
			const neighbourZ = cellZ + neighbourOffsetZ[ k ];
			if ( neighbourX < 0 || neighbourZ < 0 || neighbourX >= width || neighbourZ >= height ) continue;
			const slope = ( cellHeight - filledHeights[ neighbourZ * width + neighbourX ] ) / neighbourDistance[ k ];
			if ( slope <= 0 ) continue;
			shareWeight[ k ] = Math.pow( slope, flowExponent );
			weightSum += shareWeight[ k ];

		}

		// 坡度全被 ε 级的落差撑着、pow 下溢成 0 时，退回只给 receiver
		if ( ! ( weightSum > 0 ) ) {

			areaSum[ receiver ] += areaSum[ cell ];
			continue;

		}

		for ( let k = 0; k < 8; k ++ ) {

			if ( shareWeight[ k ] > 0 ) areaSum[ ( cellZ + neighbourOffsetZ[ k ] ) * width + cellX + neighbourOffsetX[ k ] ] += areaSum[ cell ] * shareWeight[ k ] / weightSum;

		}

	}

	const area = Float32Array.from( areaSum );
	return { receivers, order, area };

}

// ---------------------------------------------------------------------------------------------
// 3. 河流下切（stream power law）
// ---------------------------------------------------------------------------------------------

// 坡度淡出系数：slope ≥ minSlope 时是 1，≤ minSlope / 2 时是 0，中间 smoothstep
function slopeFade( slope, minSlope ) {

	if ( ! ( minSlope > 0 ) ) return 1;
	const t = Math.min( 1, Math.max( 0, ( slope - minSlope * 0.5 ) / ( minSlope * 0.5 ) ) );
	return t * t * ( 3 - 2 * t );

}

// 剥蚀受限的河流下切：E = K · A^m · S^n。A 是汇水面积（平方米 = 汇水格数 × cellSize²），S 是到 receiver 的坡度（米/米），
// 每轮迭代算一个单位时间步。汇水面积大的地方下切快，于是沟谷自己长成树枝状。
//
// 数值方法：Braun & Willett 2013（《A very efficient O(n), implicit and parallel method to solve the stream power
// equation governing fluvial incision and landscape evolution》，FastScape）的隐式格式。
// 从低往高处理，receiver 先更新，n = 1 时有闭式解：
//   h' = (h + F · h_r') / (1 + F)，F = K · A^m / L
// 结果永远落在 h 和 h_r' 之间，所以不会切到 receiver 下面、不会造出新坑，K 再大也不会数值爆炸。
// n ≠ 1 时用牛顿迭代解 h' − h + F · (h' − h_r')^n = 0，F = K · A^m / L^n。
//
// 每轮都重新算流向（flowUpdateInterval = 1）：沟谷一加深，旁边的水就会被抢过来，这正是树枝状分叉的来源；
// 粗网格（约 7 万格）上一轮流向只要几毫秒，没必要省。细网格上想省时间可以把 flowUpdateInterval 调成 2 到 4。
//
// 汇水面积用 computeFlow 的多流向（flowExponent 4）。只用 D8 累加时，光滑的山脚斜面上会切出一排排沿网格方向的平行直沟，
// 测试图里像电路板；多流向以后沟谷顺着真实坡向长。
//
// 默认参数针对约 16 m 的粗网格、几百米高的山（阶段 12 测试地形 512 × 512 × 8 m 降到 256 × 256 × 16 m 调出来的）：
//   erodibility 0.006：0.0015 时 60 轮最深只切 17 m，山上几乎看不出沟；0.006 时主沟切到 50 到 60 m，支沟几米到十几米；
//   areaExponent 0.45、slopeExponent 1：m/n = 0.45 落在实测河道凹度 0.35 到 0.6 的中间；
//   maxIncisionPerIteration 2 米：防止大河道一轮切太深，让侧向的小支沟有时间跟上；
//   minChannelSlope 0.03：坡度从 0.03 降到 0.015 之间下切淡出到 0，宽谷底和平原不会被切出直沟，山脚交给雨滴去堆冲积扇。
// hardness：F 乘 (1 − hardness)，1 的地方一点不切。seaLevel：≤ seaLevel 的格子不切，而且当出水口。
// 粗网格结果放大回细网格之前，最好先对"侵蚀后 − 侵蚀前"的差值做一次 smoothMask(差值, 宽, 高, 1)：
// 一格宽的斜向沟直接双线性放大，沟底深浅交替，看起来像一串珠子。
//
// 返回 { iterations, erodedVolume（立方米）, maxIncision（米，单格累计最大下切）, channelCells（下切超过 1 米的格数）, milliseconds }
export function streamPowerErode( {
	heights,
	width,
	height,
	cellSize,
	iterations = 60,
	erodibility = 0.006,
	areaExponent = 0.45,
	slopeExponent = 1,
	maxIncisionPerIteration = 2,
	minChannelSlope = 0.03,
	hardness = null,
	seaLevel = - Infinity,
	flowUpdateInterval = 1,
	flowExponent = 4,
} ) {

	const startTime = performance.now();
	checkGrid( 'streamPowerErode', heights, width, height );
	checkCellSize( 'streamPowerErode', cellSize );
	hardness = checkHardness( 'streamPowerErode', hardness, width, height );
	if ( ! ( slopeExponent > 0 ) ) throw new Error( `streamPowerErode：slopeExponent 必须大于 0，现在是 ${ slopeExponent }` );
	const updateInterval = Math.max( 1, Math.floor( flowUpdateInterval ) );

	const cellCount = width * height;
	const startHeights = Float32Array.from( heights );
	const cellArea = cellSize * cellSize;
	const linearExponent = Math.abs( slopeExponent - 1 ) < 1e-9;
	let erodedVolume = 0;
	let flow = null;

	for ( let iteration = 0; iteration < iterations; iteration ++ ) {

		if ( flow === null || iteration % updateInterval === 0 ) {

			flow = computeFlow( { heights, width, height, seaLevel, flowExponent } );

		}

		const { receivers, order, area } = flow;

		// 从低往高：order 是从高到低，所以倒着走
		for ( let i = cellCount - 1; i >= 0; i -- ) {

			const cell = order[ i ];
			const receiver = receivers[ cell ];
			if ( receiver < 0 ) continue;
			const oldHeight = heights[ cell ];
			if ( oldHeight <= seaLevel ) continue;
			const receiverHeight = heights[ receiver ];
			// 坑里的格子（原高度比填洼后的 receiver 还低）不切，等上游把坑口切开
			if ( oldHeight <= receiverHeight ) continue;
			// receiver 在对角线上时距离是 √2 格
			const isDiagonal = ( receiver % width ) !== ( cell % width ) && Math.floor( receiver / width ) !== Math.floor( cell / width );
			const distance = isDiagonal ? cellSize * Math.SQRT2 : cellSize;

			// 缓坡淡出：坡度从 minChannelSlope 的一半降到 0 之间不再下切，平原和宽谷底不会被切出沿网格方向的直沟
			let erodibilityHere = erodibility * slopeFade( ( oldHeight - receiverHeight ) / distance, minChannelSlope );
			if ( hardness ) erodibilityHere *= 1 - hardness[ cell ];
			if ( erodibilityHere <= 0 ) continue;
			const drainageArea = area[ cell ] * cellArea;

			let newHeight;
			if ( linearExponent ) {

				const factor = erodibilityHere * Math.pow( drainageArea, areaExponent ) / distance;
				newHeight = ( oldHeight + factor * receiverHeight ) / ( 1 + factor );

			} else {

				// 牛顿迭代：f(h) = h − h0 + F · (h − h_r)^n，从 h0 出发，每步夹在 h_r 以上
				const factor = erodibilityHere * Math.pow( drainageArea, areaExponent ) / Math.pow( distance, slopeExponent );
				newHeight = oldHeight;
				for ( let step = 0; step < 8; step ++ ) {

					const drop = newHeight - receiverHeight;
					if ( drop <= 0 ) {

						newHeight = receiverHeight;
						break;

					}

					const residual = newHeight - oldHeight + factor * Math.pow( drop, slopeExponent );
					const derivative = 1 + slopeExponent * factor * Math.pow( drop, slopeExponent - 1 );
					newHeight -= residual / derivative;
					if ( newHeight < receiverHeight ) newHeight = receiverHeight;
					if ( Math.abs( residual ) < 1e-6 ) break;

				}

			}

			// 一轮最多切 maxIncisionPerIteration 米，也不切到 receiver 下面
			if ( newHeight < oldHeight - maxIncisionPerIteration ) newHeight = oldHeight - maxIncisionPerIteration;
			if ( newHeight < receiverHeight ) newHeight = receiverHeight;
			if ( ! ( newHeight < oldHeight ) ) continue;

			heights[ cell ] = newHeight;
			erodedVolume += ( oldHeight - heights[ cell ] ) * cellArea;

		}

	}

	let maxIncision = 0;
	let channelCells = 0;
	for ( let i = 0; i < cellCount; i ++ ) {

		const incision = startHeights[ i ] - heights[ i ];
		if ( incision > maxIncision ) maxIncision = incision;
		if ( incision > 1 ) channelCells ++;

	}

	return {
		iterations,
		erodedVolume,
		maxIncision,
		channelCells,
		milliseconds: performance.now() - startTime,
	};

}

// ---------------------------------------------------------------------------------------------
// 4. 崩塌（thermal erosion）
// ---------------------------------------------------------------------------------------------

// 比休止角陡的地方，碎石往低处的邻居滑，坡脚堆成碎石裙（scree apron）。
// 做法照 Musgrave, Kolb, Mace 1989《The synthesis and rendering of eroded fractal terrains》的热侵蚀，
// 分配规则用 Olsen 2004《Realtime procedural terrain generation》的写法：
//   对 8 个邻居算超出量 d_k = (h − h_k) − talusAngle · 距离_k，只看 d_k > 0 的；
//   这一格搬出 rate · max(d_k) / 2，按 d_k / Σd_k 分给这些邻居。
//   除以 2 是因为给出去的一方降、接的一方升，落差缩小的是搬运量的两倍：rate = 1 时只有一个低邻居的格子一步正好削到休止角。
// 每轮先把所有格子的搬运量记进增量缓冲，最后一起加（Jacobi 式更新），结果和扫描顺序无关，体积严格守恒。
// 稳定性：对一条坡上"一格高一格低"的扰动做线性分析，每轮放大倍数是 1 − 2 · rate。rate ≤ 0.5 时扰动单调衰减；
// rate = 1 时倍数是 −1，扰动不衰减、每轮翻一次号，陡坡上会留下棋盘格纹（阶段 12 测试图里实际看到过），所以默认取 0.5。
//
// hardness：搬出量乘 (1 − 本格 hardness)；分给邻居的权重乘 (1 − 邻居 hardness)，保护区既不往外掉也不接东西。
//
// 默认参数：
//   talusAngle 1.0（tan，45°）：干碎石的休止角是 33° 到 37°（tan 0.65 到 0.75），但整片地形都削到这个角度，
//     山顶的脊状细节会被磨成一片片光滑的斜面（测试图里 0.75 和 0.8 都是这样）；取 45° 时只削真正的陡崖和河谷的 V 形侧壁，
//     崖下照样堆出碎石裙。想要更"碎石化"的山再往 0.75 调；
//   rate 0.5：见上面的稳定性分析；
//   iterations 30：碎石每轮最多挪一格，坡脚的碎石裙大约 iterations / 3 格宽。
//
// 返回 { iterations, movedVolume（立方米）, maxChange（米）, milliseconds }
export function thermalErode( {
	heights,
	width,
	height,
	cellSize,
	iterations = 30,
	talusAngle = 1.0,
	rate = 0.5,
	hardness = null,
} ) {

	const startTime = performance.now();
	checkGrid( 'thermalErode', heights, width, height );
	checkCellSize( 'thermalErode', cellSize );
	hardness = checkHardness( 'thermalErode', hardness, width, height );
	if ( ! ( rate > 0 && rate <= 1 ) ) throw new Error( `thermalErode：rate 要在 (0, 1] 之间，现在是 ${ rate }` );
	if ( ! ( talusAngle >= 0 ) ) throw new Error( `thermalErode：talusAngle 不能是负数，现在是 ${ talusAngle }` );

	const cellCount = width * height;
	const startHeights = Float32Array.from( heights );
	const heightDelta = new Float64Array( cellCount );
	const neighbourExcess = new Float64Array( 8 );
	const neighbourIndex = new Int32Array( 8 );
	// 各方向允许的最大落差（米）
	const talusDrop = neighbourDistance.map( ( distance ) => talusAngle * cellSize * distance );
	let movedHeight = 0;

	for ( let iteration = 0; iteration < iterations; iteration ++ ) {

		heightDelta.fill( 0 );

		for ( let z = 0; z < height; z ++ ) {

			for ( let x = 0; x < width; x ++ ) {

				const cell = z * width + x;
				const mobility = hardness ? 1 - hardness[ cell ] : 1;
				if ( mobility <= 0 ) continue;
				const cellHeight = heights[ cell ];
				let totalExcess = 0;
				let maxExcess = 0;

				for ( let k = 0; k < 8; k ++ ) {

					neighbourExcess[ k ] = 0;
					const neighbourX = x + neighbourOffsetX[ k ];
					const neighbourZ = z + neighbourOffsetZ[ k ];
					if ( neighbourX < 0 || neighbourZ < 0 || neighbourX >= width || neighbourZ >= height ) continue;
					const neighbour = neighbourZ * width + neighbourX;
					let excess = cellHeight - heights[ neighbour ] - talusDrop[ k ];
					if ( excess <= 0 ) continue;
					if ( hardness ) excess *= 1 - hardness[ neighbour ];
					if ( excess <= 0 ) continue;
					neighbourExcess[ k ] = excess;
					neighbourIndex[ k ] = neighbour;
					totalExcess += excess;
					if ( excess > maxExcess ) maxExcess = excess;

				}

				if ( totalExcess <= 0 ) continue;

				const moved = 0.5 * rate * maxExcess * mobility;
				heightDelta[ cell ] -= moved;
				movedHeight += moved;
				for ( let k = 0; k < 8; k ++ ) {

					if ( neighbourExcess[ k ] > 0 ) heightDelta[ neighbourIndex[ k ] ] += moved * neighbourExcess[ k ] / totalExcess;

				}

			}

		}

		for ( let i = 0; i < cellCount; i ++ ) {

			if ( heightDelta[ i ] !== 0 ) heights[ i ] += heightDelta[ i ];

		}

	}

	return {
		iterations,
		movedVolume: movedHeight * cellSize * cellSize,
		maxChange: measureMaxChange( heights, startHeights ),
		milliseconds: performance.now() - startTime,
	};

}

// ---------------------------------------------------------------------------------------------
// 5. 雨滴侵蚀（particle-based hydraulic erosion）
// ---------------------------------------------------------------------------------------------

// 算法改写自 Sebastian Lague 的 Hydraulic-Erosion（https://github.com/SebLague/Hydraulic-Erosion，Erosion.cs），
// 他的实现又出自 Hans Theobald Beyer 2015《Implementation of a method for hydraulic erosion》。下面是原仓库的许可证：
//
// MIT License
//
// Copyright (c) 2019 Sebastian Lague
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// 每个雨滴：随机落在地图上，沿双线性插值的梯度往下走（带惯性），每步走一格；
//   - 携沙能力 = max(−高差 · 速度 · 水量 · sedimentCapacityFactor, minSedimentCapacity)；
//   - 往上坡走或者沙超载：把沙按双线性权重放到所在格子的 4 个角点上（上坡时最多填平这一步的高差，不会堆出尖包）；
//   - 否则：按 erodeSpeed 吃掉一部分欠缺的沙量，但不超过这一步的落差（不挖坑），用半径 erosionRadius 的锥形笔刷分摊到周围格子；
//   - 速度按落差更新，再乘 (1 − friction)；水量每步按 evaporateSpeed 蒸发。
//
// 内部按"格"做单位：高度除以 cellSize 后梯度就是真实坡度（米/米），参数和地图分辨率无关，冲沟的宽度按格算。
// 改动 Lague 原版的地方：
//   - 速度更新用物理上对的符号：v² ← v² + 落差 · gravity（下坡变快）。原版写成 v² + 高差 · gravity，
//     下坡反而减速，坡度一陡 v² 变负、开方得 NaN；这里另外夹在 0 以上。
//   - 加了摩擦 friction：符号改对以后，几百米高的山上雨滴越跑越快（没有摩擦时冲下 400 m 的山速度到 14 左右），
//     携沙能力跟着涨，一滴水能把整条路刨低几米。每步乘 (1 − friction) 后速度稳定在 √(坡度 · gravity / (2 · friction)) 附近，
//     陡坡上约 3，平地上不到 1，速度只"记得"最近 1 / (2 · friction) 步的坡。
//   - 原版为每个格子都预存笔刷下标（百万格时几百 MB），这里只存一份相对偏移，靠近边界时现场裁剪、重新归一化。
//   - 笔刷中心取离雨滴最近的格点（原版取左上角格点，会整体偏半格）。
//   - 原版不让高度挖到 0 以下（它的高度图在 0 到 1 之间）；这里高度是米、可以是负数，不做这个限制。
//   - 加了 hardness（侵蚀和沉积都乘 1 − hardness，放不下的沙留在雨滴里接着带走）和 seaLevel（流进海里就结束）。
//   - 雨滴寿命到了、流出地图、流进海里时，身上的沙算"带走"（lostVolume），统计里 eroded = deposited + lost。
//
// 默认参数（阶段 12 测试地形 512 × 512 × 8 m 上调的，判断标准是晕渲图上冲沟成树枝状汇合、坡脚有沉积扇，而不是满坡毛刺）：
//   droplets 每格 1.5 个、erodeSpeed 0.1、depositSpeed 0.1、sedimentCapacityFactor 1：关键是"多而弱"。
//     Lague 原版的 4 / 0.3 / 0.3 配每格 0.4 个雨滴时，每滴水的侵蚀量是现在的近六倍，各刨一条自己的细沟，满坡平行的毛刺；
//     每滴水弱一点、数量多几倍，后来的雨滴会被前面刨出的浅沟吸过去，沟才会汇合成树枝状；
//   maxDropletLifetime 60 步：30 步时半山腰的雨滴还没走到山脚就"死"了，一半的沙凭空消失（统计里沉积只占侵蚀的四到五成），
//     山脚也堆不出冲积扇；60 步时约七成的沙落回地面，其余流进海里、流出地图或寿命到了被带走；
//   friction 0.1：见上；
//   inertia 0.05：惯性大了雨滴不肯拐弯，冲沟变成笔直的平行线（0.3 时满坡毛刺）；
//   minSedimentCapacity 0.01、evaporateSpeed 0.01、gravity 4、erosionRadius 3：Lague 原版的值。
// 冲沟的宽度按格算（半径 3 格），深度按米算会随 cellSize 变小：同样每格 1.5 个雨滴，4.17 m 网格上的沟大约是 8 m 网格上的一半深。
//
// 返回 { droplets, erodedVolume, depositedVolume, lostVolume（立方米）, maxChange（米）, averageSteps, milliseconds }
export function dropletErode( {
	heights,
	width,
	height,
	cellSize,
	droplets = Math.round( width * height * 1.5 ),
	seed = 1,
	inertia = 0.05,
	sedimentCapacityFactor = 1,
	minSedimentCapacity = 0.01,
	erodeSpeed = 0.1,
	depositSpeed = 0.1,
	evaporateSpeed = 0.01,
	gravity = 4,
	friction = 0.1,
	maxDropletLifetime = 60,
	erosionRadius = 3,
	initialWaterVolume = 1,
	initialSpeed = 1,
	hardness = null,
	seaLevel = - Infinity,
} ) {

	const startTime = performance.now();
	checkGrid( 'dropletErode', heights, width, height );
	checkCellSize( 'dropletErode', cellSize );
	hardness = checkHardness( 'dropletErode', hardness, width, height );
	if ( ! ( erosionRadius >= 1 ) ) throw new Error( `dropletErode：erosionRadius 至少 1 格，现在是 ${ erosionRadius }` );
	if ( ! ( inertia >= 0 && inertia < 1 ) ) throw new Error( `dropletErode：inertia 要在 [0, 1) 之间，现在是 ${ inertia }` );

	const startHeights = Float32Array.from( heights );
	const random = createRandom( seed );

	// 锥形笔刷：半径内权重 = 1 − 距离 / 半径，整体归一化到 1（Lague 原版的权重）
	const radiusCeil = Math.ceil( erosionRadius );
	const brushOffsetX = [];
	const brushOffsetZ = [];
	const brushRawWeight = [];
	let brushWeightSum = 0;
	for ( let offsetZ = - radiusCeil; offsetZ <= radiusCeil; offsetZ ++ ) {

		for ( let offsetX = - radiusCeil; offsetX <= radiusCeil; offsetX ++ ) {

			const distance = Math.sqrt( offsetX * offsetX + offsetZ * offsetZ );
			if ( distance >= erosionRadius ) continue;
			const weight = 1 - distance / erosionRadius;
			brushOffsetX.push( offsetX );
			brushOffsetZ.push( offsetZ );
			brushRawWeight.push( weight );
			brushWeightSum += weight;

		}

	}

	const brushSize = brushRawWeight.length;
	const brushWeight = Float64Array.from( brushRawWeight, ( weight ) => weight / brushWeightSum );
	const brushIndexOffset = Int32Array.from( brushOffsetX, ( offsetX, i ) => brushOffsetZ[ i ] * width + offsetX );

	// 体积都先按"格高 × 格面积"累计，最后乘 cellSize³ 换成立方米
	let erodedCells = 0;
	let depositedCells = 0;
	let lostCells = 0;
	let totalSteps = 0;
	const maxPositionX = width - 1;
	const maxPositionZ = height - 1;

	for ( let droplet = 0; droplet < droplets; droplet ++ ) {

		let positionX = random() * maxPositionX;
		let positionZ = random() * maxPositionZ;
		let directionX = 0;
		let directionZ = 0;
		let speed = initialSpeed;
		let water = initialWaterVolume;
		let sediment = 0;
		let lifetime = 0;

		for ( ; lifetime < maxDropletLifetime; lifetime ++ ) {

			const nodeX = Math.floor( positionX );
			const nodeZ = Math.floor( positionZ );
			const cell = nodeZ * width + nodeX;
			const fractionX = positionX - nodeX;
			const fractionZ = positionZ - nodeZ;

			// 双线性插值求这一点的高度（米）和梯度（换成格单位 = 真实坡度）
			const heightNorthWest = heights[ cell ];
			const heightNorthEast = heights[ cell + 1 ];
			const heightSouthWest = heights[ cell + width ];
			const heightSouthEast = heights[ cell + width + 1 ];
			const gradientX = ( ( heightNorthEast - heightNorthWest ) * ( 1 - fractionZ ) + ( heightSouthEast - heightSouthWest ) * fractionZ ) / cellSize;
			const gradientZ = ( ( heightSouthWest - heightNorthWest ) * ( 1 - fractionX ) + ( heightSouthEast - heightNorthEast ) * fractionX ) / cellSize;
			const heightHere = heightNorthWest * ( 1 - fractionX ) * ( 1 - fractionZ ) + heightNorthEast * fractionX * ( 1 - fractionZ )
				+ heightSouthWest * ( 1 - fractionX ) * fractionZ + heightSouthEast * fractionX * fractionZ;

			// 流进海里：结束，沙子算带进海里
			if ( heightHere <= seaLevel ) break;

			// 惯性：新方向 = 旧方向 · inertia − 梯度 · (1 − inertia)，再归一化成一步一格
			directionX = directionX * inertia - gradientX * ( 1 - inertia );
			directionZ = directionZ * inertia - gradientZ * ( 1 - inertia );
			const directionLength = Math.sqrt( directionX * directionX + directionZ * directionZ );
			// 绝对平的地方没有方向可走，原版也是在这里结束
			if ( directionLength < 1e-12 ) break;
			directionX /= directionLength;
			directionZ /= directionLength;
			const oldPositionX = positionX;
			const oldPositionZ = positionZ;
			positionX += directionX;
			positionZ += directionZ;
			totalSteps ++;
			if ( positionX < 0 || positionZ < 0 || positionX >= maxPositionX || positionZ >= maxPositionZ ) break;

			// 新位置的高度
			const newNodeX = Math.floor( positionX );
			const newNodeZ = Math.floor( positionZ );
			const newCell = newNodeZ * width + newNodeX;
			const newFractionX = positionX - newNodeX;
			const newFractionZ = positionZ - newNodeZ;
			const newHeight = heights[ newCell ] * ( 1 - newFractionX ) * ( 1 - newFractionZ ) + heights[ newCell + 1 ] * newFractionX * ( 1 - newFractionZ )
				+ heights[ newCell + width ] * ( 1 - newFractionX ) * newFractionZ + heights[ newCell + width + 1 ] * newFractionX * newFractionZ;
			// 这一步的高差（格单位）：负数是下坡
			const deltaHeight = ( newHeight - heightHere ) / cellSize;

			const sedimentCapacity = Math.max( - deltaHeight * speed * water * sedimentCapacityFactor, minSedimentCapacity );

			if ( sediment > sedimentCapacity || deltaHeight > 0 ) {

				// 沉积：上坡时最多填平这一步的高差，超载时按 depositSpeed 放下超出的部分
				const depositAmount = deltaHeight > 0 ? Math.min( deltaHeight, sediment ) : ( sediment - sedimentCapacity ) * depositSpeed;
				const weightNorthWest = ( 1 - fractionX ) * ( 1 - fractionZ ) * ( hardness ? 1 - hardness[ cell ] : 1 );
				const weightNorthEast = fractionX * ( 1 - fractionZ ) * ( hardness ? 1 - hardness[ cell + 1 ] : 1 );
				const weightSouthWest = ( 1 - fractionX ) * fractionZ * ( hardness ? 1 - hardness[ cell + width ] : 1 );
				const weightSouthEast = fractionX * fractionZ * ( hardness ? 1 - hardness[ cell + width + 1 ] : 1 );
				heights[ cell ] += depositAmount * weightNorthWest * cellSize;
				heights[ cell + 1 ] += depositAmount * weightNorthEast * cellSize;
				heights[ cell + width ] += depositAmount * weightSouthWest * cellSize;
				heights[ cell + width + 1 ] += depositAmount * weightSouthEast * cellSize;
				// 保护区放不下的那部分留在雨滴里
				const deposited = depositAmount * ( weightNorthWest + weightNorthEast + weightSouthWest + weightSouthEast );
				sediment -= deposited;
				depositedCells += deposited;

			} else {

				// 侵蚀：吃掉欠缺量的 erodeSpeed 倍，但不超过这一步的落差，免得挖出坑
				const erodeAmount = Math.min( ( sedimentCapacity - sediment ) * erodeSpeed, - deltaHeight );
				const centerX = Math.round( oldPositionX );
				const centerZ = Math.round( oldPositionZ );
				const centerCell = centerZ * width + centerX;
				const nearBorder = centerX < radiusCeil || centerZ < radiusCeil || centerX >= width - radiusCeil || centerZ >= height - radiusCeil;

				if ( ! nearBorder ) {

					for ( let i = 0; i < brushSize; i ++ ) {

						const brushCell = centerCell + brushIndexOffset[ i ];
						const eroded = erodeAmount * brushWeight[ i ] * ( hardness ? 1 - hardness[ brushCell ] : 1 );
						heights[ brushCell ] -= eroded * cellSize;
						sediment += eroded;
						erodedCells += eroded;

					}

				} else {

					// 靠近边界：只用落在网格里的笔刷格，权重重新归一化
					let insideWeightSum = 0;
					for ( let i = 0; i < brushSize; i ++ ) {

						const brushX = centerX + brushOffsetX[ i ];
						const brushZ = centerZ + brushOffsetZ[ i ];
						if ( brushX >= 0 && brushZ >= 0 && brushX < width && brushZ < height ) insideWeightSum += brushRawWeight[ i ];

					}

					for ( let i = 0; i < brushSize; i ++ ) {

						const brushX = centerX + brushOffsetX[ i ];
						const brushZ = centerZ + brushOffsetZ[ i ];
						if ( brushX < 0 || brushZ < 0 || brushX >= width || brushZ >= height ) continue;
						const brushCell = brushZ * width + brushX;
						const eroded = erodeAmount * brushRawWeight[ i ] / insideWeightSum * ( hardness ? 1 - hardness[ brushCell ] : 1 );
						heights[ brushCell ] -= eroded * cellSize;
						sediment += eroded;
						erodedCells += eroded;

					}

				}

			}

			// 下坡加速、上坡减速；夹在 0 以上，避免开方出 NaN
			speed = Math.sqrt( Math.max( 0, speed * speed - deltaHeight * gravity ) ) * ( 1 - friction );
			water *= 1 - evaporateSpeed;

		}

		lostCells += sediment;

	}

	const cellVolume = cellSize * cellSize * cellSize;
	return {
		droplets,
		erodedVolume: erodedCells * cellVolume,
		depositedVolume: depositedCells * cellVolume,
		lostVolume: lostCells * cellVolume,
		maxChange: measureMaxChange( heights, startHeights ),
		averageSteps: droplets > 0 ? totalSteps / droplets : 0,
		milliseconds: performance.now() - startTime,
	};

}

// ---------------------------------------------------------------------------------------------
// 6. 粗细网格互换
// ---------------------------------------------------------------------------------------------

// 双线性放大（节点对齐）：目标第 i 列对应源坐标 i · (源宽 − 1) / (目标宽 − 1)。返回新的 Float32Array。
export function upsampleBilinear( source, sourceWidth, sourceHeight, targetWidth, targetHeight ) {

	checkGrid( 'upsampleBilinear', source, sourceWidth, sourceHeight );
	if ( ! Number.isInteger( targetWidth ) || ! Number.isInteger( targetHeight ) || targetWidth < 2 || targetHeight < 2 ) {

		throw new Error( `upsampleBilinear：目标尺寸不对（${ targetWidth } × ${ targetHeight }）` );

	}

	const target = new Float32Array( targetWidth * targetHeight );
	const scaleX = ( sourceWidth - 1 ) / ( targetWidth - 1 );
	const scaleZ = ( sourceHeight - 1 ) / ( targetHeight - 1 );

	for ( let z = 0; z < targetHeight; z ++ ) {

		const sourceZ = z * scaleZ;
		const nodeZ = Math.min( Math.floor( sourceZ ), sourceHeight - 2 );
		const fractionZ = sourceZ - nodeZ;
		for ( let x = 0; x < targetWidth; x ++ ) {

			const sourceX = x * scaleX;
			const nodeX = Math.min( Math.floor( sourceX ), sourceWidth - 2 );
			const fractionX = sourceX - nodeX;
			const cell = nodeZ * sourceWidth + nodeX;
			const top = source[ cell ] * ( 1 - fractionX ) + source[ cell + 1 ] * fractionX;
			const bottom = source[ cell + sourceWidth ] * ( 1 - fractionX ) + source[ cell + sourceWidth + 1 ] * fractionX;
			target[ z * targetWidth + x ] = top * ( 1 - fractionZ ) + bottom * fractionZ;

		}

	}

	return target;

}

// 一维的面积平均权重：目标节点 i 覆盖源坐标 [i · r − r / 2, i · r + r / 2]（r = (源长 − 1) / (目标长 − 1)），
// 每个源节点当成宽 1 格、以自己为中心的小段，权重 = 重叠长度，最后归一化。超出网格的部分裁掉。
function buildAverageWeights( sourceSize, targetSize ) {

	const ratio = ( sourceSize - 1 ) / ( targetSize - 1 );
	const firstSource = new Int32Array( targetSize );
	const weightCount = new Int32Array( targetSize );
	const weights = [];
	const weightStart = new Int32Array( targetSize );

	for ( let i = 0; i < targetSize; i ++ ) {

		const center = i * ratio;
		const halfWidth = Math.max( ratio, 1 ) / 2;
		const rangeStart = Math.max( center - halfWidth, - 0.5 );
		const rangeEnd = Math.min( center + halfWidth, sourceSize - 0.5 );
		const first = Math.max( 0, Math.floor( rangeStart + 0.5 ) );
		const last = Math.min( sourceSize - 1, Math.ceil( rangeEnd - 0.5 ) );
		firstSource[ i ] = first;
		weightStart[ i ] = weights.length;
		let weightSum = 0;
		const localWeights = [];
		for ( let j = first; j <= last; j ++ ) {

			const overlap = Math.min( rangeEnd, j + 0.5 ) - Math.max( rangeStart, j - 0.5 );
			localWeights.push( Math.max( 0, overlap ) );
			weightSum += Math.max( 0, overlap );

		}

		for ( const weight of localWeights ) weights.push( weightSum > 0 ? weight / weightSum : 1 / localWeights.length );
		weightCount[ i ] = localWeights.length;

	}

	return { firstSource, weightCount, weightStart, weights: Float64Array.from( weights ) };

}

// 面积平均降采样（节点对齐，和 upsampleBilinear 用同一套坐标换算），先横向再纵向。返回新的 Float32Array。
export function downsampleAverage( source, sourceWidth, sourceHeight, targetWidth, targetHeight ) {

	checkGrid( 'downsampleAverage', source, sourceWidth, sourceHeight );
	if ( ! Number.isInteger( targetWidth ) || ! Number.isInteger( targetHeight ) || targetWidth < 2 || targetHeight < 2 ) {

		throw new Error( `downsampleAverage：目标尺寸不对（${ targetWidth } × ${ targetHeight }）` );

	}

	const weightsX = buildAverageWeights( sourceWidth, targetWidth );
	const weightsZ = buildAverageWeights( sourceHeight, targetHeight );

	// 横向：sourceWidth → targetWidth，行数不变
	const horizontal = new Float64Array( targetWidth * sourceHeight );
	for ( let z = 0; z < sourceHeight; z ++ ) {

		const rowStart = z * sourceWidth;
		for ( let x = 0; x < targetWidth; x ++ ) {

			let sum = 0;
			const first = weightsX.firstSource[ x ];
			const start = weightsX.weightStart[ x ];
			for ( let j = 0; j < weightsX.weightCount[ x ]; j ++ ) sum += source[ rowStart + first + j ] * weightsX.weights[ start + j ];
			horizontal[ z * targetWidth + x ] = sum;

		}

	}

	// 纵向：sourceHeight → targetHeight
	const target = new Float32Array( targetWidth * targetHeight );
	for ( let z = 0; z < targetHeight; z ++ ) {

		const first = weightsZ.firstSource[ z ];
		const start = weightsZ.weightStart[ z ];
		for ( let x = 0; x < targetWidth; x ++ ) {

			let sum = 0;
			for ( let j = 0; j < weightsZ.weightCount[ z ]; j ++ ) sum += horizontal[ ( first + j ) * targetWidth + x ] * weightsZ.weights[ start + j ];
			target[ z * targetWidth + x ] = sum;

		}

	}

	return target;

}

// ---------------------------------------------------------------------------------------------
// 7. 遮罩羽化
// ---------------------------------------------------------------------------------------------

// 可分离的方框模糊（窗口 2 · radiusCells + 1），先横向再纵向。边界处只平均落在网格里的格子，不往外补 0，
// 所以贴着地图边的保护区不会被冲淡。返回新的 Float32Array，不改输入。
// 每格直接把窗口加一遍（O(半径)），不用滑动和：滑动和一加一减会累积舍入误差，全是 1 的区域模糊完可能变成 0.99999994，
// 保护区就不再是严格的 1；直接求和时全 1 的窗口结果正好是 1。半径 50 格、百万格的网格也只要零点几秒。
// 想让保护区内部保持 1、只往外羽化 r 格：先把保护区往外扩 r 格再模糊（过渡带落在原边界外 0 到 2r 格）。
export function smoothMask( values, width, height, radiusCells ) {

	checkGrid( 'smoothMask', values, width, height );
	const radius = Math.max( 0, Math.floor( radiusCells ) );
	if ( radius === 0 ) return Float32Array.from( values );

	const horizontal = new Float64Array( width * height );
	for ( let z = 0; z < height; z ++ ) {

		const rowStart = z * width;
		for ( let x = 0; x < width; x ++ ) {

			const windowStart = Math.max( 0, x - radius );
			const windowEnd = Math.min( width - 1, x + radius );
			let sum = 0;
			for ( let i = windowStart; i <= windowEnd; i ++ ) sum += values[ rowStart + i ];
			horizontal[ rowStart + x ] = sum / ( windowEnd - windowStart + 1 );

		}

	}

	const result = new Float32Array( width * height );
	for ( let z = 0; z < height; z ++ ) {

		const windowStart = Math.max( 0, z - radius );
		const windowEnd = Math.min( height - 1, z + radius );
		const count = windowEnd - windowStart + 1;
		for ( let x = 0; x < width; x ++ ) {

			let sum = 0;
			for ( let i = windowStart; i <= windowEnd; i ++ ) sum += horizontal[ i * width + x ];
			result[ z * width + x ] = sum / count;

		}

	}

	return result;

}
