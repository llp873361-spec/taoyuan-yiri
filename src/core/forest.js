// 树林布点（规格书 §4 阶段 12 CP3 返工）：整个秘境哪里种什么树、多大，输出树表（backdrop 拿去画近处 3D 树、远处替身卡片）。
//
// 原来的规则（backdrop.buildForest）有三个毛病，用户一句话："整个世界过于空旷"：
//   ① 海拔 28 米以下不长林——盆地谷底（花园 24 米、落日身后的草甸）整片是光草地；
//   ② 每个地点周围 150 米整圈清空——站在花园里四周什么都没有；
//   ③ 林子按一张遮罩均匀撒，没有林缘、没有草甸上的孤树、没有花树林。
// 这里按"绘本里的风景"重写：
//   林子：大中两层噪声定出成片的林（缓坡、汇水多的地方更容易成林），林缘的树小一些、稀一些；
//   河岸：河边一条带状的树；
//   草甸：林子之外偶尔一棵大孤树（阔叶或花树），花海里少一些；
//   花树：桃林地表、花园四周一圈（花园两侧 100~420 米、成丛），以及低处草甸上零星的花树；
//   空地：只让开地点自己的地面（各地点一个半径）、花园的正式园林那一条、几条视线、小镇的房子。
// 所有判断只用 sample 给的函数（高度、坡度、水、地表图、烘焙的汇水、噪声），浏览器里和 Node 里都能跑。

function smooth( edge0, edge1, value ) {

	const t = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return t * t * ( 3 - 2 * t );

}

// 一个候选点的林子密度（0~1）和这一处的"种类倾向"。sample 字段：
//   height(x, z)、slope(x, z)（1 − 法线 y）、water(x, z)（在海里、湖里、河里为真）、waterEdge(x, z)（地表图 R：水边 0.5，越近水越大）、
//   peach(x, z)、flowers(x, z)（地表图的桃林、花海 0~1）、wet(x, z)（烘焙的"适合长树"：缓坡、汇水多）、
//   noise(name, x, z)（噪声贴图的 large / medium / small 层，0~1）、blossomZone(x, z)（花树林的地方 0~1，花园四周）
export function forestDensity( sample, x, z, height, slope ) {

	const large = sample.noise( 'large', x, z );
	const medium = sample.noise( 'medium', x, z );
	const small = sample.noise( 'small', x, z );
	// 海拔：海边沙滩以上就能长（原来 28 米以下不长），雪线以下；陡崖上不长
	const altitude = smooth( 3, 12, height ) * ( 1 - smooth( 430, 540, height ) );
	const steep = 1 - smooth( 0.32, 0.45, slope );
	// 成片：大斑块定林子和草甸的大格局，中斑块打碎；缓坡（山脚）加一点；汇水多的地方好长
	const patches = large * 0.55 + medium * 0.45 + smooth( 0.04, 0.2, slope ) * 0.1 + ( small - 0.5 ) * 0.12;
	let density = smooth( 0.44, 0.66, patches ) * ( 0.65 + 0.45 * sample.wet( x, z ) );
	// 谷底大片草甸留着（绘本里林子和草甸要分开），但不是一片光：谷底的林子少三成
	density *= 0.7 + 0.3 * smooth( 30, 80, height );
	// 花海里树很少
	density *= 1 - 0.8 * sample.flowers( x, z );
	// 河岸：离水 1~3 个地表图像素的一条带（R 0.12~0.4）
	const edge = sample.waterEdge( x, z );
	const riparian = smooth( 0.1, 0.22, edge ) * ( 1 - smooth( 0.32, 0.4, edge ) );
	density = Math.max( density, riparian * 0.75 );
	// 花树林：花园四周、桃林地表
	const blossom = Math.max( sample.blossomZone( x, z ), sample.peach( x, z ) );
	density = Math.max( density, blossom * smooth( 0.35, 0.6, medium * 0.6 + small * 0.4 + 0.12 ) );
	// 窄处要的老林、松林（林间小路两边、冰碛岗上）：加密到 0.9，小斑块打一点空
	const boost = sample.boost ? sample.boost( x, z ) : { amount: 0, species: null };
	density = Math.max( density, boost.amount * ( 0.82 + 0.18 * small ) );
	return { density: Math.min( 1, density * altitude * steep ), blossom: boost.amount > 0.3 ? 0 : blossom, riparian, boostSpecies: boost.amount > 0.3 ? boost.species : null };

}

// 布点：bounds { minX, minZ, maxX, maxZ }（世界坐标），spacing 候选格距（米），random 随机数函数，
// clearing(x, z) 是否在空地里，groundAt(x, z) 树根高度（地点自己画地面的地方用地点的高度），
// settings { conifer: [开始换针叶的海拔, 全是针叶的海拔], firAltitude, meadowChance, variants: { 树种: 变体数 } }
// 返回 [{ x, y, z, size, tint, yaw, cull, species, variant, kind }]（kind：forest 林子、edge 林缘、meadow 孤树、river 河岸）
export async function planForest( { bounds, spacing, random, sample, clearing, groundAt, settings, yieldIfBusy } ) {

	const items = [];
	for ( let z = bounds.minZ + spacing; z < bounds.maxZ - spacing; z += spacing ) {

		for ( let x = bounds.minX + spacing; x < bounds.maxX - spacing; x += spacing ) {

			// 每个格子固定取 6 个随机数（不管种不种），改规则时别处的树不会整片挪位置
			const jitterX = x + ( random() - 0.5 ) * spacing * 0.9;
			const jitterZ = z + ( random() - 0.5 ) * spacing * 0.9;
			const roll = random();
			const sizeRoll = random();
			const tint = random();
			const yaw = random() * Math.PI * 2;
			if ( clearing( jitterX, jitterZ ) || sample.water( jitterX, jitterZ ) ) continue;
			const height = sample.height( jitterX, jitterZ );
			const slope = sample.slope( jitterX, jitterZ );
			if ( ! ( slope < 0.45 ) ) continue;
			const { density, blossom, riparian, boostSpecies } = forestDensity( sample, jitterX, jitterZ, height, slope );

			let kind = null;
			let size = 1;
			if ( roll < density * 0.92 ) {

				// 林子里：越靠里越大；林缘（密度 0.2~0.5）小一些
				kind = density > 0.5 ? 'forest' : 'edge';
				size = 0.62 + 0.45 * smooth( 0.15, 0.7, density ) + 0.3 * sizeRoll * sizeRoll;
				if ( riparian > 0.5 && density < 0.8 ) kind = 'river';

			} else if ( density < 0.25 && roll > 1 - settings.meadowChance * ( 1 - 0.7 * sample.flowers( jitterX, jitterZ ) ) && height > 4 && height < 360 ) {

				// 草甸上的孤树：又大又圆，绘本里一眼就看见的那种
				kind = 'meadow';
				size = 1.1 + 0.3 * sizeRoll;

			}

			if ( ! kind ) continue;

			// 树种：花树林里八成五是花树；草甸孤树三成五是花树；低处零星的花树；高处换针叶（松 → 冷杉）
			let species;
			const conifer = smooth( settings.conifer[ 0 ], settings.conifer[ 1 ], height ) * 0.9 + 0.05;
			const blossomChance = Math.max( blossom * 0.85, kind === 'meadow' ? 0.35 : 0, height < 70 ? 0.05 : 0 );
			if ( boostSpecies ) species = boostSpecies === 'pine' && height > settings.firAltitude ? 'fir' : boostSpecies;
			else if ( ( tint * 7.13 ) % 1 < blossomChance && height < 300 ) species = 'blossom';
			else if ( ( tint * 3.71 ) % 1 < conifer && kind !== 'river' ) species = height > settings.firAltitude ? 'fir' : 'pine';
			else species = 'broadleaf';
			if ( species === 'blossom' ) size *= 0.95;
			const variants = settings.variants[ species ] || 1;
			const variant = Math.min( variants - 1, Math.floor( tint * variants ) );
			// 树根往下沉一点，坡上沉得多（下坡那一侧不悬空）
			const sink = 0.6 + 4 * size * slope;
			const ground = groundAt( jitterX, jitterZ );
			items.push( { x: jitterX, y: ground - sink, z: jitterZ, size, tint, yaw, cull: ( tint * 17.3 + sizeRoll * 0.37 ) % 1, species, variant, kind } );

		}

		if ( yieldIfBusy ) await yieldIfBusy();

	}

	return items;

}
