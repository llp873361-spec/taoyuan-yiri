// 树（规格书阶段 12 CP3）：程序化生成几种绘本风的树，近处画成真的 3D 树，远处还是远景里一团一团的树冠（backdrop 的树林）。
//
// 生成：树干 + 几根主枝（锥形管子，带一点弯），枝头和枝上长一团团树冠；每团树冠是几十张"叶片卡"（方片，片元里按噪声抠出
// 毛边的团状叶簇）。卡片的法线不用它自己的平面法线，而是"从这团树冠中心指出来"的球面法线，再混一点整棵树冠的球面法线：
// 光照起来是一团柔软的体积，不是一堆纸片（做法参照 brunosimon/folio-2025 的 Foliage，MIT，只借思路，TSL 自己重写）。
// 四种树形：round 圆冠（阔叶、桃、白樱）、tiered 分层的松（吉卜力那种一层层枝盘）、conical 冷杉、column 柏。
//
// 远近交接：每棵树按自己的随机数 cull 定一个距离 near − band·cull，这个距离以内画 3D、以外画远景的树团，
// 一棵树要么是 3D、要么是树团（两边着色器用同一个判断），不会两个都画、也不会都不画。
// 3D 树的实例矩阵在镜头挪动超过 refreshDistance 米、或者转头超过 turnAngle 时按空间网格重新挑一遍：
// 只收镜头视锥水平投影里（再放宽 extraAngle）的树，closeRadius 米以内全收（几千个矩阵，零点几毫秒，只上传用到的那一段）。

import * as THREE from 'three/webgpu';
import {
	Fn, If, Discard, float, vec2, vec3, vec4, attribute, varying, texture,
	positionLocal, normalWorld,
	normalize, length, dot, max, min, mix, smoothstep, sin, cos, pow, step, floor, fract, atan, abs,
} from 'three/tsl';
import { valueNoise2D } from './noise.js';
import { loadModel, disposeModel } from '../core/assets.js';

function createRandom( seed ) {

	let value = ( seed >>> 0 ) || 1;
	return function next() {

		value = ( value + 0x6D2B79F5 ) | 0;
		let mixed = Math.imul( value ^ ( value >>> 15 ), 1 | value );
		mixed = ( mixed + Math.imul( mixed ^ ( mixed >>> 7 ), 61 | mixed ) ) ^ mixed;
		return ( ( mixed ^ ( mixed >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

const between = ( random, range ) => range[ 0 ] + ( range[ 1 ] - range[ 0 ] ) * random();

// ===================== 骨架 =====================

// 一根锥形管子：points 是中心线（Vector3），radii 每点半径；sides 边数。返回 { positions, normals, uvs, indices }（追加到 out 里）
function addTube( out, points, radii, sides, barkScale ) {

	const start = out.positions.length / 3;
	const tangent = new THREE.Vector3();
	const side = new THREE.Vector3();
	const up = new THREE.Vector3();
	const helper = new THREE.Vector3();
	let along = 0;
	for ( let i = 0; i < points.length; i ++ ) {

		const previous = points[ Math.max( 0, i - 1 ) ];
		const next = points[ Math.min( points.length - 1, i + 1 ) ];
		tangent.subVectors( next, previous ).normalize();
		helper.set( 0, 0, 1 );
		if ( Math.abs( tangent.dot( helper ) ) > 0.9 ) helper.set( 1, 0, 0 );
		side.crossVectors( tangent, helper ).normalize();
		up.crossVectors( side, tangent ).normalize();
		if ( i > 0 ) along += points[ i ].distanceTo( points[ i - 1 ] );
		for ( let k = 0; k <= sides; k ++ ) {

			const angle = k / sides * Math.PI * 2;
			const nx = side.x * Math.cos( angle ) + up.x * Math.sin( angle );
			const ny = side.y * Math.cos( angle ) + up.y * Math.sin( angle );
			const nz = side.z * Math.cos( angle ) + up.z * Math.sin( angle );
			out.positions.push( points[ i ].x + nx * radii[ i ], points[ i ].y + ny * radii[ i ], points[ i ].z + nz * radii[ i ] );
			out.normals.push( nx, ny, nz );
			out.uvs.push( k / sides * Math.max( 1, Math.round( radii[ 0 ] * 2 * Math.PI / barkScale ) ), along / barkScale );

		}

	}

	for ( let i = 0; i < points.length - 1; i ++ ) {

		for ( let k = 0; k < sides; k ++ ) {

			const a = start + i * ( sides + 1 ) + k;
			const b = a + sides + 1;
			out.indices.push( a, b, a + 1, a + 1, b, b + 1 );

		}

	}

}

// 一根弯的枝：从 base 沿 direction 长 length 米，往上（bend > 0）或往下垂（< 0）弯；分 segments 段
function branchLine( base, direction, length, bend, segments ) {

	const points = [];
	const heading = direction.clone().normalize();
	const position = base.clone();
	for ( let i = 0; i <= segments; i ++ ) {

		points.push( position.clone() );
		position.addScaledVector( heading, length / segments );
		heading.y += bend / segments;
		heading.normalize();

	}

	return points;

}

// ===================== 叶片卡 =====================

// 一团树冠：中心 center、半径 radius、上下压扁 squash；count 张卡，卡边长 = radius × cardScale。
// 卡片位置偏向球壳（里面空一些，透光、显得蓬），朝向大致朝外再随机歪一点
function addClump( out, random, center, radius, squash, count, cardScale, crownCenter, crownHeight, hue ) {

	const normal = new THREE.Vector3();
	const axisA = new THREE.Vector3();
	const axisB = new THREE.Vector3();
	const helper = new THREE.Vector3();
	const corner = new THREE.Vector3();
	const sphereNormal = new THREE.Vector3();
	const crownNormal = new THREE.Vector3();
	for ( let c = 0; c < count; c ++ ) {

		// 球面上均匀的方向
		const z = random() * 2 - 1;
		const angle = random() * Math.PI * 2;
		const ring = Math.sqrt( 1 - z * z );
		const direction = new THREE.Vector3( ring * Math.cos( angle ), z, ring * Math.sin( angle ) );
		const shell = 0.5 + 0.5 * Math.sqrt( random() );
		const position = center.clone().add( new THREE.Vector3( direction.x * radius * shell, direction.y * radius * squash * shell, direction.z * radius * shell ) );
		normal.copy( direction ).add( new THREE.Vector3( random() - 0.5, random() - 0.5, random() - 0.5 ).multiplyScalar( 1.2 ) ).normalize();
		helper.set( 0, 1, 0 );
		if ( Math.abs( normal.dot( helper ) ) > 0.9 ) helper.set( 1, 0, 0 );
		axisA.crossVectors( normal, helper ).normalize();
		axisB.crossVectors( normal, axisA ).normalize();
		const roll = random() * Math.PI * 2;
		const size = radius * cardScale * ( 0.75 + random() * 0.5 );
		const rolledA = axisA.clone().multiplyScalar( Math.cos( roll ) ).addScaledVector( axisB, Math.sin( roll ) );
		const rolledB = axisB.clone().multiplyScalar( Math.cos( roll ) ).addScaledVector( axisA, - Math.sin( roll ) );
		const seed = random();
		const start = out.positions.length / 3;
		for ( const [ u, v ] of [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ] ) {

			corner.copy( position ).addScaledVector( rolledA, ( u - 0.5 ) * size ).addScaledVector( rolledB, ( v - 0.5 ) * size );
			// 球面法线：从团中心指出来（按压扁的比例修正），混 35% 整棵树冠的球面法线
			sphereNormal.subVectors( corner, center );
			sphereNormal.y /= squash * squash;
			sphereNormal.normalize();
			crownNormal.subVectors( corner, crownCenter ).normalize();
			sphereNormal.lerp( crownNormal, 0.35 ).normalize();
			out.positions.push( corner.x, corner.y, corner.z );
			out.normals.push( sphereNormal.x, sphereNormal.y, sphereNormal.z );
			out.uvs.push( u, v );
			// 种子、在团里靠外的程度、在树冠里的高度比例、这一团的色相偏移
			out.leaf.push( seed, ( shell - 0.5 ) * 2, Math.min( 1, Math.max( 0, corner.y / crownHeight ) ), hue );

		}

		out.indices.push( start, start + 1, start + 2, start, start + 2, start + 3 );

	}

}

// ===================== 分级树冠（阶段 12 CP3 返工：阔叶、桃樱）=====================
// 原来的 round 形是"树干 + 几根主枝 + 枝头一大团"，远看就是棒棒糖。这里按真树长：树干（根部张开）在 trunkReach 处分叉，
// 主枝往外斜着长、各分几根侧枝、侧枝上再分小枝；树冠是长在侧枝、小枝梢上的一团团（大小跟枝长走），合起来是一朵起伏的云。
// 几种树形只是参数不同（config.trees.species 里 style 只是注释用）：
//   开心形 spread：矮干、主枝斜得开、树冠又宽又平；垂枝 weeping：侧枝往下垂（droop），团挂在枝梢下面、竖着拉长（hang）；
//   伞形 umbrella：主枝几乎水平、团压扁；斜干 leaning：树干歪 15~25°；双干 twin：从根上分成两根干；老桩 old：干粗、枝少、团稀
// spec 字段（米 / 弧度 / 比例）：trunks 干数、trunkLean 树干歪的角度、flare 根部张开倍数、primaries [少, 多]、primaryUp 主枝仰角、
//   primaryLength 主枝长（树高的比例）、primaryBend 主枝往上弯（负的往下）、secondaries、secondaryLength（主枝长的比例）、
//   secondarySpread 侧枝偏开的程度、droop 侧枝往下垂、twigs、clumpRadius、clumpSquash、hang 团往下挂的比例、topClump 树顶有没有一团
function buildCrown( spec, random, bark, clumps, height, trunkRadius ) {

	const trunkCount = spec.trunks || 1;
	const splitHeight = height * spec.trunkReach;
	const tips = [];
	for ( let trunk = 0; trunk < trunkCount; trunk ++ ) {

		// 每根干：从地下 0.6 米起，按 trunkLean 歪（双干两根往两边歪），中间带一点弯
		const leanAzimuth = random() * Math.PI * 2 + trunk * Math.PI;
		const leanAngle = ( spec.trunkLean || 0.06 ) * ( 0.7 + random() * 0.6 ) + ( trunkCount > 1 ? 0.22 : 0 );
		const direction = new THREE.Vector3( Math.sin( leanAngle ) * Math.cos( leanAzimuth ), Math.cos( leanAngle ), Math.sin( leanAngle ) * Math.sin( leanAzimuth ) );
		const length = ( splitHeight + 0.6 ) / Math.cos( leanAngle ) * ( trunkCount > 1 ? 0.92 + random() * 0.16 : 1 );
		const points = branchLine( new THREE.Vector3( 0, - 0.6, 0 ), direction, length, ( random() - 0.5 ) * 0.25, 7 );
		const radius = trunkRadius * ( trunkCount > 1 ? 0.78 : 1 );
		const flare = spec.flare || 1.4;
		addTube( bark, points, points.map( ( point, i ) => {

			const along = i / ( points.length - 1 );
			// 根部张开（前两段），往上收到六成
			return radius * ( 1 - 0.4 * along ) * ( 1 + ( flare - 1 ) * Math.max( 0, 1 - along * 4 ) );

		} ), 8, 1.2 );
		tips.push( { top: points[ points.length - 1 ], direction: points[ points.length - 1 ].clone().sub( points[ points.length - 2 ] ).normalize(), radius: radius * 0.6 } );

	}

	const primaryCount = Math.round( between( random, spec.primaries ) );
	const crownBottom = splitHeight;
	for ( let b = 0; b < primaryCount; b ++ ) {

		const tip = tips[ b % tips.length ];
		// 方位按黄金角错开；双干的两根各管一半，朝自己歪的那边多长
		const azimuth = b * 2.39996 + random() * 0.7;
		const elevation = between( random, spec.primaryUp );
		const direction = new THREE.Vector3( Math.cos( azimuth ) * Math.cos( elevation ), Math.sin( elevation ), Math.sin( azimuth ) * Math.cos( elevation ) )
			.addScaledVector( tip.direction, 0.35 ).normalize();
		const primaryLength = between( random, spec.primaryLength ) * height;
		const base = tip.top.clone().addScaledVector( tip.direction, - random() * 0.6 );
		const points = branchLine( base, direction, primaryLength, spec.primaryBend + ( random() - 0.5 ) * 0.3, 5 );
		addTube( bark, points, points.map( ( point, i ) => tip.radius * 0.75 * ( 1 - 0.7 * i / ( points.length - 1 ) ) ), 6, 1 );
		const secondaryCount = Math.round( between( random, spec.secondaries ) );
		for ( let s = 0; s < secondaryCount; s ++ ) {

			const at = points[ Math.min( points.length - 1, 2 + Math.floor( ( s + random() * 0.7 ) / secondaryCount * ( points.length - 2 ) ) ) ];
			const heading = points[ points.length - 1 ].clone().sub( points[ 1 ] ).normalize();
			const sideDirection = heading.clone().add( new THREE.Vector3( ( random() - 0.5 ) * 2, ( random() - 0.3 ) * 0.9, ( random() - 0.5 ) * 2 ).multiplyScalar( spec.secondarySpread ) ).normalize();
			const sideLength = primaryLength * between( random, spec.secondaryLength );
			const sidePoints = branchLine( at, sideDirection, sideLength, - ( spec.droop || 0 ) + ( random() - 0.5 ) * 0.25, spec.droop > 0.8 ? 7 : 4 );
			// branchThinning：垂枝的枝细一些（花帘里露出来的枝原来像一圈黑铁丝）
			addTube( bark, sidePoints, sidePoints.map( ( point, i ) => tip.radius * 0.32 * ( spec.branchThinning || 1 ) * ( 1 - 0.75 * i / ( sidePoints.length - 1 ) ) ), 4, 0.8 );
			const end = sidePoints[ sidePoints.length - 1 ];
			const clumpSize = between( random, spec.clumpRadius ) * Math.min( 1.25, 0.55 + sideLength / ( height * 0.35 ) );
			pushClump( clumps, spec, end, clumpSize, random );
			// 沿侧枝再挂几团（clumpsAlong，默认 1 团在中段）：垂枝的枝从拱顶一路垂下来，一串团连成一道花帘
			const along = spec.clumpsAlong || 1;
			for ( let c = 1; c <= along; c ++ ) {

				const fraction = c / ( along + 1 );
				const index = Math.min( sidePoints.length - 2, Math.floor( fraction * ( sidePoints.length - 1 ) ) );
				const point = sidePoints[ index ].clone().lerp( sidePoints[ index + 1 ], fraction * ( sidePoints.length - 1 ) - index );
				pushClump( clumps, spec, point, clumpSize * ( 0.55 + 0.25 * fraction ), random );

			}
			const twigCount = Math.round( between( random, spec.twigs || [ 0, 0 ] ) );
			for ( let k = 0; k < twigCount; k ++ ) {

				const from = sidePoints[ 1 + Math.floor( random() * ( sidePoints.length - 2 ) ) ];
				const twigDirection = sideDirection.clone().add( new THREE.Vector3( ( random() - 0.5 ) * 1.8, random() * 0.9 - 0.2 - ( spec.droop || 0 ) * 0.8, ( random() - 0.5 ) * 1.8 ) ).normalize();
				const twigLength = sideLength * ( 0.45 + random() * 0.3 );
				const twigEnd = from.clone().addScaledVector( twigDirection, twigLength );
				addTube( bark, [ from, from.clone().lerp( twigEnd, 0.5 ).add( new THREE.Vector3( 0, - ( spec.droop || 0 ) * twigLength * 0.25, 0 ) ), twigEnd ], [ tip.radius * 0.12, tip.radius * 0.08, tip.radius * 0.04 ], 3, 0.6 );
				pushClump( clumps, spec, twigEnd, clumpSize * 0.6, random );

			}

		}

		// 主枝梢：没有侧枝的那截也长一团
		pushClump( clumps, spec, points[ points.length - 1 ], between( random, spec.clumpRadius ) * 0.85, random );

	}

	if ( spec.topClump !== false ) {

		const top = tips[ 0 ].top.clone().add( new THREE.Vector3( 0, Math.max( height - crownBottom, 1 ) * 0.55, 0 ) );
		pushClump( clumps, spec, top, spec.clumpRadius[ 1 ] * 1.1, random );

	}

}

// 一团树冠：垂枝的团挂到枝梢下面、竖着拉长
function pushClump( clumps, spec, center, radius, random ) {

	const hang = spec.hang || 0;
	const position = center.clone().add( new THREE.Vector3( ( random() - 0.5 ) * radius * 0.3, radius * ( 0.25 - hang * 0.9 ), ( random() - 0.5 ) * radius * 0.3 ) );
	clumps.push( { center: position, radius, squash: spec.clumpSquash * ( 1 + hang * 0.8 ) } );

}

// 一棵树的模板（树种 spec、种子）：返回 { bark: BufferGeometry, leaves: BufferGeometry, height }
// 坐标：树根在原点，+y 朝上；高度、半径都是"size = 1"时的米数（实例按 size 缩放）
export function buildTreeTemplate( spec, seed ) {

	const random = createRandom( seed );
	const bark = { positions: [], normals: [], uvs: [], indices: [] };
	const leaves = { positions: [], normals: [], uvs: [], indices: [], leaf: [] };
	const height = between( random, spec.height );
	const clumps = [];   // { center, radius, squash }
	const lean = new THREE.Vector3( ( random() - 0.5 ) * ( spec.lean || 0 ), 1, ( random() - 0.5 ) * ( spec.lean || 0 ) ).normalize();

	// 树干：从根往上，带一点弯；半径往上收
	const trunkTop = height * spec.trunkReach;
	const trunkPoints = branchLine( new THREE.Vector3( 0, - 0.6, 0 ), lean, trunkTop + 0.6, ( random() - 0.5 ) * 0.2, 6 );
	const trunkRadius = spec.trunkRadius * ( 0.85 + random() * 0.3 );
	if ( spec.form !== 'crown' ) addTube( bark, trunkPoints, trunkPoints.map( ( point, i ) => trunkRadius * ( 1 - 0.65 * i / ( trunkPoints.length - 1 ) ) * ( i === 0 ? 1.35 : 1 ) ), spec.form === 'conical' || spec.form === 'column' ? 6 : 7, 1.2 );
	const trunkAt = ( fraction ) => {

		const scaled = fraction * ( trunkPoints.length - 1 );
		const index = Math.min( trunkPoints.length - 2, Math.floor( scaled ) );
		return trunkPoints[ index ].clone().lerp( trunkPoints[ index + 1 ], scaled - index );

	};

	if ( spec.form === 'round' ) {

		// 圆冠：几根主枝从树干上部斜着伸出去（方位按黄金角错开），枝头一大团、枝中间一小团，树顶一团
		const count = Math.round( between( random, spec.branches ) );
		for ( let b = 0; b < count; b ++ ) {

			const fraction = spec.branchStart + ( 1 - spec.branchStart ) * ( b + random() * 0.6 ) / count;
			const base = trunkAt( Math.min( 0.98, fraction ) );
			const azimuth = b * 2.39996 + random() * 0.6;
			const elevation = between( random, spec.branchUp );
			const direction = new THREE.Vector3( Math.cos( azimuth ) * Math.cos( elevation ), Math.sin( elevation ), Math.sin( azimuth ) * Math.cos( elevation ) );
			const branchLength = between( random, spec.branchLength ) * ( 1.1 - 0.4 * fraction );
			const points = branchLine( base, direction, branchLength, spec.branchBend, 4 );
			const radius = trunkRadius * 0.45;
			addTube( bark, points, points.map( ( point, i ) => radius * ( 1 - 0.75 * i / ( points.length - 1 ) ) ), 5, 1 );
			clumps.push( { center: points[ points.length - 1 ].clone().add( new THREE.Vector3( 0, 0.4, 0 ) ), radius: between( random, spec.clumpRadius ), squash: spec.clumpSquash } );
			if ( random() < 0.7 ) clumps.push( { center: points[ 2 ].clone().add( new THREE.Vector3( 0, 0.6, 0 ) ), radius: between( random, spec.clumpRadius ) * 0.7, squash: spec.clumpSquash } );

		}

		clumps.push( { center: trunkAt( 1 ).add( new THREE.Vector3( 0, spec.clumpRadius[ 1 ] * 0.5, 0 ) ), radius: spec.clumpRadius[ 1 ] * 1.05, squash: spec.clumpSquash } );

	} else if ( spec.form === 'tiered' ) {

		// 松：一层层几乎水平的枝，枝头一块压扁的枝盘；越往上枝越短
		const tiers = Math.round( between( random, spec.branches ) );
		for ( let t = 0; t < tiers; t ++ ) {

			const fraction = spec.branchStart + ( 1 - spec.branchStart ) * t / Math.max( 1, tiers - 1 );
			const base = trunkAt( Math.min( 0.98, fraction ) );
			const perTier = 2 + Math.floor( random() * 1.8 );
			for ( let b = 0; b < perTier; b ++ ) {

				const azimuth = t * 2.39996 + b * Math.PI * 2 / perTier + random() * 0.5;
				const elevation = between( random, spec.branchUp );
				const direction = new THREE.Vector3( Math.cos( azimuth ) * Math.cos( elevation ), Math.sin( elevation ), Math.sin( azimuth ) * Math.cos( elevation ) );
				const branchLength = between( random, spec.branchLength ) * ( 1.2 - 0.7 * fraction );
				const points = branchLine( base, direction, branchLength, spec.branchBend, 3 );
				addTube( bark, points, points.map( ( point, i ) => trunkRadius * 0.35 * ( 1 - 0.7 * i / ( points.length - 1 ) ) ), 5, 1 );
				// 枝盘：枝头一大块、枝中间一小块，压扁，连成一层
				const padRadius = Math.max( 1.1, branchLength * 0.95 ) * between( random, spec.clumpRadius ) / spec.clumpRadius[ 1 ];
				clumps.push( { center: points[ points.length - 1 ].clone(), radius: padRadius, squash: spec.clumpSquash } );
				clumps.push( { center: points[ 1 ].clone().add( new THREE.Vector3( 0, 0.2, 0 ) ), radius: padRadius * 0.7, squash: spec.clumpSquash } );

			}

		}

		clumps.push( { center: trunkAt( 1 ).add( new THREE.Vector3( 0, 0.5, 0 ) ), radius: spec.clumpRadius[ 0 ], squash: spec.clumpSquash * 1.4 } );

	} else if ( spec.form === 'conical' ) {

		// 冷杉：沿树干一圈圈小团，越往上圈越小，整体是个尖塔
		const rings = Math.round( between( random, spec.branches ) );
		for ( let r = 0; r < rings; r ++ ) {

			const fraction = spec.branchStart + ( 1 - spec.branchStart ) * r / ( rings - 1 );
			const center = trunkAt( Math.min( 1, fraction ) );
			const spread = spec.branchLength[ 1 ] * Math.pow( 1 - fraction, 0.9 ) + 0.4;
			const around = Math.max( 1, Math.round( 2 + spread * 1.2 ) );
			for ( let k = 0; k < around; k ++ ) {

				const azimuth = k * Math.PI * 2 / around + r * 0.9 + random() * 0.4;
				const reach = spread * ( 0.55 + random() * 0.3 );
				clumps.push( { center: center.clone().add( new THREE.Vector3( Math.cos( azimuth ) * reach, - reach * 0.25, Math.sin( azimuth ) * reach ) ), radius: Math.max( 0.7, spread * between( random, spec.clumpRadius ) ), squash: spec.clumpSquash } );

			}

		}

		clumps.push( { center: trunkAt( 1 ).add( new THREE.Vector3( 0, 0.3, 0 ) ), radius: 0.7, squash: 1.6 } );

	} else if ( spec.form === 'crown' ) {

		buildCrown( spec, random, bark, clumps, height, trunkRadius );

	} else {

		// 柏：细高的纺锤形，团贴着树干往上叠
		const stacks = Math.round( between( random, spec.branches ) );
		for ( let s = 0; s < stacks; s ++ ) {

			const fraction = spec.branchStart + ( 1 - spec.branchStart ) * s / ( stacks - 1 );
			const center = trunkAt( Math.min( 1, fraction ) );
			const width = spec.branchLength[ 1 ] * Math.sin( Math.PI * Math.pow( Math.min( 0.999, fraction * 0.92 + 0.04 ), 0.8 ) );
			const azimuth = random() * Math.PI * 2;
			clumps.push( { center: center.clone().add( new THREE.Vector3( Math.cos( azimuth ) * width * 0.25, 0, Math.sin( azimuth ) * width * 0.25 ) ), radius: Math.max( 0.5, width ), squash: spec.clumpSquash } );

		}

	}

	// 叶片卡：整棵树冠的中心按团的平均位置
	const crownCenter = new THREE.Vector3();
	for ( const clump of clumps ) crownCenter.add( clump.center );
	crownCenter.multiplyScalar( 1 / Math.max( 1, clumps.length ) );
	let top = 0;
	for ( const clump of clumps ) top = Math.max( top, clump.center.y + clump.radius * clump.squash );
	for ( const clump of clumps ) {

		const count = Math.max( 6, Math.round( spec.cards * Math.pow( clump.radius / spec.clumpRadius[ 1 ], 1.4 ) ) );
		addClump( leaves, random, clump.center, clump.radius, clump.squash, count, spec.cardScale, crownCenter, top, random() );

	}

	const toGeometry = ( data, withLeaf ) => {

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( data.positions, 3 ) );
		geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( data.normals, 3 ) );
		geometry.setAttribute( 'uv', new THREE.Float32BufferAttribute( data.uvs, 2 ) );
		if ( withLeaf ) geometry.setAttribute( 'leafData', new THREE.Float32BufferAttribute( data.leaf, 4 ) );
		geometry.setIndex( data.indices );
		geometry.computeBoundingSphere();
		return geometry;

	};

	return { bark: toGeometry( bark, false ), leaves: toGeometry( leaves, true ), height: top };

}

// ===================== 焦点树：模型的树干 + 程序化花簇 =====================
// 树干、枝是模型里的（RosticOstafi 的樱花，scripts/blender/sakura-focal.py 处理过），花簇长在原模型叶片卡的位置上：
// 花位按 cell 米的格子聚成一团团（一格里花位越多团越大），每团撒花卡（和程序化花树同一种 addClump、同一个花卡材质）。
// barkGeometry 要有 position、normal、uv；points 是花位（Vector3，树根在原点）；spec 用花树的那套（cards、cardScale、clumpSquash、clumpRadius）
export function buildFocalTemplate( barkGeometry, points, spec, seed ) {

	const random = createRandom( seed );
	const cell = spec.cell || 1.1;
	const cells = new Map();
	for ( const point of points ) {

		const key = Math.floor( point.x / cell ) + ',' + Math.floor( point.y / cell ) + ',' + Math.floor( point.z / cell );
		if ( ! cells.has( key ) ) cells.set( key, { sum: new THREE.Vector3(), count: 0 } );
		const entry = cells.get( key );
		entry.sum.add( point );
		entry.count ++;

	}

	const clumps = [];
	for ( const entry of cells.values() ) {

		if ( entry.count < 2 ) continue;
		clumps.push( { center: entry.sum.multiplyScalar( 1 / entry.count ), radius: cell * ( 0.55 + 0.3 * Math.min( 1, entry.count / 14 ) ) } );

	}

	const crownCenter = new THREE.Vector3();
	let top = 0;
	for ( const clump of clumps ) {

		crownCenter.add( clump.center );
		top = Math.max( top, clump.center.y + clump.radius );

	}

	crownCenter.multiplyScalar( 1 / Math.max( 1, clumps.length ) );
	const leaves = { positions: [], normals: [], uvs: [], indices: [], leaf: [] };
	for ( const clump of clumps ) {

		const count = Math.max( 4, Math.round( spec.cards * Math.pow( clump.radius / spec.clumpRadius[ 1 ], 1.4 ) ) );
		addClump( leaves, random, clump.center, clump.radius, spec.clumpSquash, count, spec.cardScale, crownCenter, top, random() );

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( leaves.positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( leaves.normals, 3 ) );
	geometry.setAttribute( 'uv', new THREE.Float32BufferAttribute( leaves.uvs, 2 ) );
	geometry.setAttribute( 'leafData', new THREE.Float32BufferAttribute( leaves.leaf, 4 ) );
	geometry.setIndex( leaves.indices );
	geometry.computeBoundingSphere();
	return { bark: barkGeometry, leaves: geometry, height: top, clumps: clumps.length };

}

// 模型里的一个网格 → 32 位浮点的几何体（量化的属性先反量化，再乘网格的变换）；只留 position、normal、uv
export function meshToGeometry( mesh ) {

	mesh.updateMatrixWorld( true );
	const source = mesh.geometry;
	const geometry = new THREE.BufferGeometry();
	for ( const name of [ 'position', 'normal', 'uv' ] ) {

		const attribute = source.getAttribute( name );
		if ( ! attribute ) continue;
		const values = new Float32Array( attribute.count * attribute.itemSize );
		for ( let i = 0; i < attribute.count; i ++ ) for ( let k = 0; k < attribute.itemSize; k ++ ) values[ i * attribute.itemSize + k ] = attribute.getComponent( i, k );
		geometry.setAttribute( name, new THREE.BufferAttribute( values, attribute.itemSize ) );

	}

	if ( source.index ) geometry.setIndex( Array.from( source.index.array ) );
	geometry.applyMatrix4( mesh.matrixWorld );
	if ( ! geometry.getAttribute( 'normal' ) ) geometry.computeVertexNormals();
	return geometry;

}

// ===================== 模型花树：樱花模型的树干 + 程序化花簇 =====================
// 读一个花位模型（scripts/blender/sakura-focal.py 出的：网格"树干"带树皮贴图和 UV，网格"花位"是一个个小三角形，取中心当花簇位置）。
// 树皮贴图先从材质上摘下来，disposeModel 就不会把它（连同 ImageBitmap）释放掉。读不到或者没有花位返回 null
export async function loadBlossomModel( id ) {

	const model = await loadModel( 'models', id );
	if ( ! model ) return null;
	let bark = null;
	let barkMap = null;
	const points = [];
	model.traverse( ( child ) => {

		if ( ! child.isMesh ) return;
		const geometry = meshToGeometry( child );
		if ( /花位/.test( child.name ) || /花位/.test( child.material && child.material.name || '' ) ) {

			const position = geometry.getAttribute( 'position' );
			const index = geometry.index ? geometry.index.array : null;
			const triangles = index ? index.length / 3 : position.count / 3;
			for ( let t = 0; t < triangles; t ++ ) {

				const point = new THREE.Vector3();
				for ( let k = 0; k < 3; k ++ ) point.add( new THREE.Vector3().fromBufferAttribute( position, index ? index[ t * 3 + k ] : t * 3 + k ) );
				points.push( point.multiplyScalar( 1 / 3 ) );

			}

			geometry.dispose();

		} else {

			if ( bark ) bark.dispose();
			bark = geometry;
			if ( child.material && child.material.map ) {

				if ( ! barkMap ) barkMap = child.material.map;
				else if ( child.material.map !== barkMap ) child.material.map.dispose();
				child.material.map = null;

			}

		}

	} );
	disposeModel( model );
	if ( ! bark || points.length === 0 ) {

		if ( bark ) bark.dispose();
		if ( barkMap ) barkMap.dispose();
		return null;

	}

	return { bark, points, barkMap };

}

// 花树（桃樱）整个树种用模型（2026-10-02 用户："这种树全部换掉"——程序化的花树枝干又直又硬、花一点一点散着，近看像插了几根棍子）：
// spec.models.ids 几个模型轮着用，凑够 count 个变体（和程序化树形一样多，烘好的树林布点里的变体号照用）；
// 每个变体换一个花簇种子、聚团格子大小差一点，同一个模型的几个变体花团不一样。返回 { templates, barkMap }；一个模型都读不到返回 null
export async function buildModelBlossomTemplates( spec, count ) {

	const loaded = [];
	for ( const id of spec.models.ids ) {

		const item = await loadBlossomModel( id );
		if ( item ) loaded.push( item );
		else console.warn( `树：花树模型 ${ id } 没读到或者没有花位` );

	}

	if ( loaded.length === 0 ) return null;
	const flowerSpec = { ...spec, ...( spec.forms ? spec.forms[ 0 ] : {} ), cards: spec.models.cards, cell: spec.models.cell };
	const templates = [];
	for ( let variant = 0; variant < count; variant ++ ) {

		const source = loaded[ variant % loaded.length ];
		const round = Math.floor( variant / loaded.length );
		// 每个模板要有自己的树干几何体（近处的树往模板几何体上挂各自的实例属性）
		const bark = round === 0 ? source.bark : source.bark.clone();
		const cell = flowerSpec.cell * ( 1 + ( ( round % 3 ) - 1 ) * 0.08 );
		templates.push( buildFocalTemplate( bark, source.points, { ...flowerSpec, cell }, 900 + variant * 41 ) );

	}

	const barkMap = loaded.find( ( item ) => item.barkMap ) ? loaded.find( ( item ) => item.barkMap ).barkMap : null;
	for ( const item of loaded ) if ( item.barkMap && item.barkMap !== barkMap ) item.barkMap.dispose();
	return { templates, barkMap };

}

// 一个树种的全部模板：有 forms 的（花树）每种树形一个变体（树种的公共字段 + 这种树形的字段），没有的按 variants 个种子各生成一个。
// 种子和原来 backdrop 里一样（1000 + 变体 × 97 + 名字长度 × 13），已有树种的样子不变
export function buildSpeciesTemplates( name, spec, variants ) {

	if ( Array.isArray( spec.forms ) && spec.forms.length > 0 ) {

		return spec.forms.map( ( form, index ) => buildTreeTemplate( { ...spec, ...form }, 1000 + index * 97 + name.length * 13 ) );

	}

	const templates = [];
	for ( let variant = 0; variant < variants; variant ++ ) templates.push( buildTreeTemplate( spec, 1000 + variant * 97 + name.length * 13 ) );
	return templates;

}

// ===================== 材质 =====================
// shade( albedo, normal, point, { skyView, wrap, base } )：远景的世界光照 + 大气（normal、point 是世界坐标，base 是树根）
// uniforms：{ time, near, band, sceneToWorld, viewer（世界坐标的镜头位置，节点）, toggle（近处树的开关）, sunDirection, sunColor（世界的太阳）}

// 实例数据：treeBase（树根世界坐标）、treeInfo（色相随机数、远近随机数 cull、size、树种的亮度偏移）
function instanceVisible( uniforms ) {

	const base = attribute( 'treeBase', 'vec3' );
	const info = attribute( 'treeInfo', 'vec4' );
	// 和远景树团同一个判断：这一棵在 near − band·cull 以内画 3D
	const threshold = uniforms.near.sub( uniforms.band.mul( info.y ) );
	const distance = length( base.sub( uniforms.viewer ) );
	return step( distance, threshold ).mul( uniforms.toggle );

}

// style：'leaf' 叶簇（默认）；'blossom' 花簇——底子还是一团咬碎边的色块（远看是一朵粉云），上面画一朵朵五瓣花（近看是花）
export function createLeafMaterial( { name, palette, uniforms, shade, style = 'leaf' } ) {

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = name;
	material.side = THREE.DoubleSide;
	material.fog = false;
	material.lights = false;
	const base = attribute( 'treeBase', 'vec3' );
	const info = attribute( 'treeInfo', 'vec4' );
	const leaf = attribute( 'leafData', 'vec4' );
	const visible = instanceVisible( uniforms );
	// 风：树冠越高晃得越多，每棵树相位不同；不在近处的实例缩成一个点（不画）
	const phase = base.x.mul( 0.071 ).add( base.z.mul( 0.053 ) );
	const sway = pow( leaf.z, 2 ).mul( 0.18 ).mul( info.z );
	const wind = vec3( sin( uniforms.time.mul( 0.9 ).add( phase ) ), 0, cos( uniforms.time.mul( 0.71 ).add( phase.mul( 1.3 ) ) ) ).mul( sway );
	material.positionNode = mix( base, positionLocal.add( wind ), visible );
	const leafVarying = varying( leaf, 'treeLeaf' );
	const tintVarying = varying( info.x, 'treeTint' );
	const hueVarying = varying( info.w, 'treeHue' );
	const baseVarying = varying( base, 'treeBaseV' );
	const worldPoint = varying( positionLocal, 'treePoint' );

	material.colorNode = Fn( () => {

		// 丢掉的片元后面的着色整段跳过（If 包起来）：discard 只把片元降成辅助调用，后面的光照、大气照样算；
		// 叶卡一大半面积是抠掉的毛边和洞，整片抠掉的线程组就不用算光照了（2026-10-02 核显性能）
		const outColor = vec4( 0, 0, 0, 1 ).toVar();
		// 叶簇的形状：一大一小两层噪声把圆片的边咬碎、中间咬出几个洞，像一簇叶子（每张卡的噪声不一样）
		const uv = attribute( 'uv', 'vec2' );
		const centered = uv.mul( 2 ).sub( 1 );
		const seedOffset = vec2( leafVarying.x.mul( 91 ), leafVarying.x.mul( 37 ) );
		const coarse = valueNoise2D( uv.mul( 6 ).add( seedOffset ) );
		const fine = valueNoise2D( uv.mul( 14 ).add( seedOffset.mul( 1.7 ) ) );
		const shape = length( centered ).mul( 0.9 ).add( coarse.sub( 0.5 ).mul( 0.6 ) ).add( fine.sub( 0.5 ).mul( 0.4 ) );
		// 花簇：卡片的轮廓由一朵朵五瓣花拼出来（4×4 格，每格按种子抖一朵、八成格子有花，极坐标 r < 0.3·(0.55 + 0.45·|cos(2.5θ)|)），
		// 中间留一小块底色撑体积。原来是一整块色片上印规则的小白花，近看像印花纸片（2026-10-02 开发页自查）
		const petal = float( 0 ).toVar();
		const heart = float( 0 ).toVar();
		if ( style === 'blossom' ) {

			const cellCoord = uv.mul( 4 );
			const cell = floor( cellCoord );
			const cellSeed = fract( sin( dot( cell.add( seedOffset ), vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );
			const local = fract( cellCoord ).sub( 0.5 ).sub( vec2( cellSeed.sub( 0.5 ), fract( cellSeed.mul( 7.13 ) ).sub( 0.5 ) ).mul( 0.28 ) );
			const radius = length( local );
			const angle = atan( local.y, local.x ).add( cellSeed.mul( 6.283 ) );
			const flowerSize = fract( cellSeed.mul( 3.7 ) ).mul( 0.1 ).add( 0.3 );
			petal.assign( float( 1 ).sub( step( flowerSize, radius.div( abs( cos( angle.mul( 2.5 ) ) ).mul( 0.45 ).add( 0.55 ) ) ) ).mul( step( 0.2, cellSeed ) ) );
			// 卡的四角圆掉，花只开在一个圆里
			petal.mulAssign( step( length( centered ), 0.95 ) );
			heart.assign( float( 1 ).sub( step( 0.06, radius ) ).mul( petal ) );

		}

		const discarded = ( style === 'blossom' ? shape.greaterThan( 0.5 ).and( petal.lessThan( 0.5 ) ) : shape.greaterThan( 0.74 ) ).toVar();
		Discard( discarded );
		If( discarded.not(), () => {

			const normal = normalize( uniforms.sceneToWorld.mul( vec4( normalWorld, 0 ) ).xyz );
			// 两调：团的外面、树冠上部偏亮，里面、下部偏暗；亮的那一调只在最外面一点（绘本里亮叶是几笔，不是一片）；每团、每棵树的色相错开一点
			const tone = leafVarying.y.mul( 0.5 ).add( leafVarying.z.mul( 0.3 ) ).add( coarse.sub( 0.5 ).mul( 0.4 ) ).add( leafVarying.w.sub( 0.5 ).mul( 0.25 ) );
			const albedo = mix( mix( palette.dark, palette.mid, smoothstep( 0.25, 0.55, tone ) ), palette.light, smoothstep( 0.72, 0.95, tone ) ).mul( tintVarying.sub( 0.5 ).mul( 0.3 ).add( 1 ) ).toVar();
			if ( style === 'blossom' ) {

				// 花瓣比底子亮一档、偏白，花心一点深粉；底子（中间那块）留原来的明暗。远处一朵花不到一个像素，平均下来就是底子和花的混色
				const flower = mix( palette.light, vec3( 1, 0.97, 0.96 ), 0.4 ).mul( tone.mul( 0.25 ).add( 0.85 ) );
				albedo.assign( mix( albedo, flower, petal.mul( 0.8 ) ) );
				albedo.assign( mix( albedo, palette.dark.mul( 0.9 ), heart.mul( 0.7 ) ) );
				// 花的色相每棵偏一点：有的偏白（樱），有的偏粉（桃）
				albedo.assign( mix( albedo, mix( albedo, vec3( 0.98, 0.95, 0.96 ), 0.35 ), hueVarying.mul( 0.6 ) ) );
				// 夜里花压暗四成：白花是夜景里最亮的东西，一排樱花像打了灯（2026-10-02 审查 R15）
				if ( uniforms.night ) albedo.mulAssign( mix( float( 1 ), float( 0.6 ), uniforms.night ) );

			} else {

				// 每棵树的色相偏一点：有的偏黄绿（嫩），有的偏蓝绿（老），林子不是一种绿
				albedo.assign( mix( albedo, albedo.mul( mix( vec3( 0.86, 0.97, 1.12 ), vec3( 1.16, 1.06, 0.72 ), hueVarying ) ), 0.6 ) );

			}

			// 团里面、树冠下部看到的天少（暗得下去，树冠才有体积）
			const skyView = leafVarying.y.mul( 0.5 ).add( leafVarying.z.mul( 0.3 ) ).add( 0.12 );
			// 花瓣薄，包裹光照和逆光都比叶子多
			const lit = shade( albedo, normal, worldPoint, { skyView, wrap: style === 'blossom' ? 0.45 : 0.25, base: baseVarying } );
			// 逆光透亮：朝太阳看过去，团外缘的叶子透一点光
			const toPoint = normalize( worldPoint.sub( uniforms.viewer ) );
			const backlit = pow( max( dot( toPoint, uniforms.sunDirection ), 0 ), 5 ).mul( leafVarying.y ).mul( style === 'blossom' ? 0.8 : 0.5 );
			outColor.assign( vec4( lit.add( albedo.mul( uniforms.sunColor ).mul( backlit ) ), 1 ) );

		} );
		return outColor;

	} )();
	return material;

}

export function createBarkMaterial( { name, barkColor, barkTexture, uniforms, shade } ) {

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = name;
	material.fog = false;
	material.lights = false;
	const base = attribute( 'treeBase', 'vec3' );
	const visible = instanceVisible( uniforms );
	material.positionNode = mix( base, positionLocal, visible );
	const baseVarying = varying( base, 'barkBase' );
	const worldPoint = varying( positionLocal, 'barkPoint' );
	material.colorNode = Fn( () => {

		const normal = normalize( uniforms.sceneToWorld.mul( vec4( normalWorld, 0 ) ).xyz );
		const uv = attribute( 'uv', 'vec2' );
		// 树皮：贴图只给明暗（按 0.45 的平均亮度归一），颜色是树种自己的
		const detail = barkTexture ? dot( texture( barkTexture, uv ).rgb, vec3( 0.2126, 0.7152, 0.0722 ) ).div( 0.2 ) : float( 1 );
		const albedo = barkColor.mul( min( max( detail, 0.3 ), 1.8 ) );
		return vec4( shade( albedo, normal, worldPoint, { skyView: float( 0.6 ), wrap: 0.3, base: baseVarying } ), 1 );

	} )();
	return material;

}

// ===================== 镜头视锥的水平投影：按朝向挑近处的树 =====================
// 返回 out = { x, z（镜头朝向的水平单位向量，世界坐标）, halfAngle（弧度）}：视锥四条棱投到水平面上、离朝向最远的那条和朝向的夹角。
// 平视时就是半个水平视场，低头、抬头时比它大，视锥罩住正下方或正上方时是 π（四面八方都要）。
// 视锥是凸的：不罩住竖直方向时它的水平投影是一个小于 180° 的扇形，两条边一定是某两条棱的投影，所以看四条棱就够。
// 倒影的虚拟相机是主相机按水面上下翻过来的，水平投影和主相机一样，同一份挑选倒影里也对。
// sceneToWorld：场景坐标 → 世界坐标（远景挂进地点以后是 root 的逆矩阵）；camera.matrixWorld 要是这一帧最终的位姿
const viewMatrix = new THREE.Matrix4();
const viewRight = new THREE.Vector3();
const viewUp = new THREE.Vector3();
const viewBack = new THREE.Vector3();
export function viewFromCamera( camera, sceneToWorld, out = { x: 0, z: - 1, halfAngle: Math.PI } ) {

	out.halfAngle = Math.PI;
	if ( ! camera.isPerspectiveCamera ) return out;
	viewMatrix.multiplyMatrices( sceneToWorld, camera.matrixWorld ).extractBasis( viewRight, viewUp, viewBack );
	viewRight.normalize();
	viewUp.normalize();
	viewBack.normalize();
	// 视锥边的斜率（setViewOffset 的偏心视锥按宽的那一边算）
	const elements = camera.projectionMatrix.elements;
	const tanX = ( 1 + Math.abs( elements[ 8 ] ) ) / elements[ 0 ];
	const tanY = ( 1 + Math.abs( elements[ 9 ] ) ) / elements[ 5 ];
	const flat = Math.hypot( viewBack.x, viewBack.z );
	if ( flat < 1e-4 ) return out;
	out.x = - viewBack.x / flat;
	out.z = - viewBack.z / flat;
	// 世界的竖直方向在相机坐标里是 (right.y, up.y, back.y)：落在视锥里就是罩住了正上方或正下方
	const depth = Math.abs( viewBack.y );
	if ( Math.abs( viewRight.y ) <= tanX * depth && Math.abs( viewUp.y ) <= tanY * depth ) return out;
	let widest = 0;
	for ( let k = 0; k < 4; k ++ ) {

		const sideX = ( k & 1 ) ? tanX : - tanX;
		const sideY = ( k & 2 ) ? tanY : - tanY;
		const edgeX = viewRight.x * sideX + viewUp.x * sideY - viewBack.x;
		const edgeZ = viewRight.z * sideX + viewUp.z * sideY - viewBack.z;
		const edgeLength = Math.hypot( edgeX, edgeZ );
		if ( edgeLength < 1e-6 ) return out;
		widest = Math.max( widest, Math.acos( Math.min( 1, Math.max( - 1, ( edgeX * out.x + edgeZ * out.z ) / edgeLength ) ) ) );

	}

	out.halfAngle = widest;
	return out;

}

// 平面上两条线段 AB、CD 的最近距离（相交是 0）
function segmentDistance( ax, az, bx, bz, cx, cz, dx, dz ) {

	const side = ( px, pz, qx, qz, rx, rz ) => ( qx - px ) * ( rz - pz ) - ( qz - pz ) * ( rx - px );
	const sideC = side( ax, az, bx, bz, cx, cz );
	const sideD = side( ax, az, bx, bz, dx, dz );
	const sideA = side( cx, cz, dx, dz, ax, az );
	const sideB = side( cx, cz, dx, dz, bx, bz );
	if ( ( ( sideC > 0 && sideD < 0 ) || ( sideC < 0 && sideD > 0 ) ) && ( ( sideA > 0 && sideB < 0 ) || ( sideA < 0 && sideB > 0 ) ) ) return 0;
	const pointToSegment = ( px, pz, sx, sz, ex, ez ) => {

		const lengthX = ex - sx;
		const lengthZ = ez - sz;
		const lengthSquared = lengthX * lengthX + lengthZ * lengthZ;
		const t = lengthSquared > 0 ? Math.min( 1, Math.max( 0, ( ( px - sx ) * lengthX + ( pz - sz ) * lengthZ ) / lengthSquared ) ) : 0;
		return Math.hypot( px - sx - lengthX * t, pz - sz - lengthZ * t );

	};
	return Math.min( pointToSegment( ax, az, cx, cz, dx, dz ), pointToSegment( bx, bz, cx, cz, dx, dz ), pointToSegment( cx, cz, ax, az, bx, bz ), pointToSegment( dx, dz, ax, az, bx, bz ) );

}

// 凸四边形（quad：4 个角 x, z 依次排）和线段 AB 的最近距离（线段有一头在里面是 0）
function quadSegmentDistance( quad, ax, az, bx, bz ) {

	const inside = ( px, pz ) => {

		let positive = 0;
		let negative = 0;
		for ( let k = 0; k < 4; k ++ ) {

			const sx = quad[ k * 2 ];
			const sz = quad[ k * 2 + 1 ];
			const ex = quad[ ( k + 1 ) % 4 * 2 ];
			const ez = quad[ ( k + 1 ) % 4 * 2 + 1 ];
			const cross = ( ex - sx ) * ( pz - sz ) - ( ez - sz ) * ( px - sx );
			if ( cross > 0 ) positive ++;
			else if ( cross < 0 ) negative ++;

		}

		return positive === 0 || negative === 0;

	};
	if ( inside( ax, az ) || inside( bx, bz ) ) return 0;
	let nearest = Infinity;
	for ( let k = 0; k < 4; k ++ ) nearest = Math.min( nearest, segmentDistance( ax, az, bx, bz, quad[ k * 2 ], quad[ k * 2 + 1 ], quad[ ( k + 1 ) % 4 * 2 ], quad[ ( k + 1 ) % 4 * 2 + 1 ] ) );
	return nearest;

}

// ===================== 近处的树：按镜头位置和朝向挑实例 =====================
// items：[{ x, y, z, size, yaw, tint, cull, species, variant }]；templates[species][variant] = { bark, leaves }；
// materials[species] = { bark, leaves }；settings：{ near, band, refreshDistance, maxPerMesh, nearScale( species ) → 这个树种画 3D 的距离比例（可选），
//   view（可选，按朝向挑）：{ closeRadius（米，以内全收）, extraAngle（弧度，视锥水平半张角外再放宽多少：拖动转头 + 树冠宽 + 重挑前的偏差）, turnAngle（弧度，朝向偏了这么多就重挑）}}
// understory（可选）：{ layer（createUnderstoryLayer 的结果）, near（uniform，多远以内撒）, rules（树种 → [{ kind, count, radius:[内,外], scale:[小,大] }]）, groundAt( x, z ) }
// reflectWater（可选，地点自己的水面倒影）：{ level（倒影平面的世界高度）, capsules: [{ ax, az, bx, bz, radius }]（水面盖住的范围，世界 xz 上的胶囊）,
//   slack（弧度：水面微波把倒影的采样位置错开的最大角度）}。每次重挑时按镜头位置算哪些树的倒影可能落进水面（见 mayReflect），
//   倒影 pass 前 setReflection( true )、画完 setReflection( false )，倒影里只画这些
export function createTreeField( { items, templates, materials, settings, uniforms, understory = null, reflectWater = null } ) {

	const group = new THREE.Group();
	group.name = '近处的树';
	// 空间网格：格子号拼成一个数当键（原来拼字符串，每次重挑几百个格子都要拼一遍）
	const cellSize = 64;
	const cellKey = ( cellX, cellZ ) => ( cellX + 32768 ) * 65536 + ( cellZ + 32768 );
	const cells = new Map();
	items.forEach( ( item, index ) => {

		const key = cellKey( Math.floor( item.x / cellSize ), Math.floor( item.z / cellSize ) );
		if ( ! cells.has( key ) ) cells.set( key, [] );
		cells.get( key ).push( index );

	} );

	// 每个树种 × 变体一对网格（树皮、叶子），共用实例数据
	const slots = new Map();
	const disposables = [];
	for ( const [ species, variants ] of Object.entries( templates ) ) {

		variants.forEach( ( template, variant ) => {

			const allocated = settings.maxPerMesh;
			const treeBase = new THREE.InstancedBufferAttribute( new Float32Array( allocated * 3 ), 3 );
			const treeInfo = new THREE.InstancedBufferAttribute( new Float32Array( allocated * 4 ), 4 );
			treeBase.setUsage( THREE.DynamicDrawUsage );
			treeInfo.setUsage( THREE.DynamicDrawUsage );
			template.bark.setAttribute( 'treeBase', treeBase );
			template.bark.setAttribute( 'treeInfo', treeInfo );
			template.leaves.setAttribute( 'treeBase', treeBase );
			template.leaves.setAttribute( 'treeInfo', treeInfo );
			// 没挑到树的槽位实例数是 0：three 照样把它放进渲染列表、照样编着色器（预编译不受影响），只是跳过这次绘制。
			// 原来第 0 个实例是一棵藏在地下一万米的树、保证实例数 ≥ 1，没挑到树的槽位每帧还要把整棵模板的顶点白跑一遍（2026-10-02 核显性能）
			const meshes = [ [ template.bark, materials[ species ].bark, '树皮' ], [ template.leaves, materials[ species ].leaves, '树叶' ] ].map( ( [ geometry, material, label ] ) => {

				// 按 maxPerMesh（≥ 4096）个实例分配：three 对实例少的 InstancedMesh 每挂进一个新场景就生成一份新着色器（见 backdrop 的树林）
				const mesh = new THREE.InstancedMesh( geometry, material, allocated );
				mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
				mesh.count = 0;
				mesh.frustumCulled = false;
				mesh.name = `近处的树·${ species }·${ variant }·${ label }`;
				group.add( mesh );
				return mesh;

			} );
			// 模板的大小（树自己的坐标，乘 size 以前）：树顶多高、离树干最远多少（算倒影用；叶卡随风晃的那一点另外留余量）
			let top = 0;
			let radius = 0;
			for ( const geometry of [ template.bark, template.leaves ] ) {

				if ( ! geometry.boundingBox ) geometry.computeBoundingBox();
				const box = geometry.boundingBox;
				top = Math.max( top, box.max.y );
				radius = Math.max( radius, Math.abs( box.min.x ), Math.abs( box.max.x ), Math.abs( box.min.z ), Math.abs( box.max.z ) );

			}

			slots.set( species + '/' + variant, { meshes, treeBase, treeInfo, count: 0, reflectCount: 0, picked: [], top, radius: radius * Math.SQRT2 } );
			disposables.push( template.bark, template.leaves );

		} );

	}

	// 每棵树属于哪个槽位、画 3D 的距离比例：建的时候查一次（原来每次重挑每棵树都拼一遍字符串查表）
	const slotOf = items.map( ( item ) => slots.get( item.species + '/' + item.variant ) || null );
	const speciesScale = new Map();
	const scaleOf = Float32Array.from( items, ( item ) => {

		if ( ! speciesScale.has( item.species ) ) speciesScale.set( item.species, settings.nearScale ? settings.nearScale( item.species ) : 1 );
		return speciesScale.get( item.species );

	} );
	// 这一次重挑里哪些会进倒影（只对挑中的算）；扇环的外接四边形（mayReflect 里反复用）
	const reflectable = reflectWater ? new Uint8Array( items.length ) : null;
	const quad = new Float64Array( 8 );
	// 上次分倒影时的镜头位置；挪了 reflectStep 米、升降 eyeSlack 米就重分（mayReflect 里镜头位置、高度按这么多留余量）
	const lastReflect = new THREE.Vector3( 1e9, 0, 1e9 );
	const reflectStep = 1;
	const eyeSlack = 0.15;
	// 实例矩阵第一次挑到时组好存起来，以后挑到直接拷（转头也重挑，比原来勤）
	const matrixCache = new Float32Array( items.length * 16 );
	const matrixReady = new Uint8Array( items.length );
	const placement = new THREE.Object3D();
	const lastViewer = new THREE.Vector3( 1e9, 0, 1e9 );
	// 上次挑树时的近处范围、林下范围：顶点压力把它们缩了（核显吃紧）就当场重挑，不然替身已经按新范围接手、3D 树还按旧范围画，交接带上会叠两份
	let lastNear = - 1;
	let lastUnderstoryNear = - 1;
	// 上次挑的时候的朝向；limit 是收进来的方位半张角，≥ π 是四面八方都收
	const lastView = { x: 0, z: - 1, limit: Math.PI, used: false };
	const pickStats = { picks: 0, lastMs: 0, maxMs: 0 };
	let selected = 0;
	let reflecting = false;
	const understoryRules = understory ? Object.fromEntries( Object.entries( understory.rules ).map( ( [ species, list ] ) => [ species, list.map( ( rule ) => ( { ...rule, index: understory.layer.kindIndex( rule.kind ) } ) ).filter( ( rule ) => rule.index >= 0 ) ] ) ) : {};

	// 一棵树周围的林下：按树的序号取随机数（同一棵树每次一样）。第一次算完存起来（落点要查地面高度、躲林间小路，挺费），
	// 一丛 7 个数：种类、x、y、z、朝向、大小、色调；用普通数组存（双精度，和原来当场算的结果一模一样）
	const understoryCache = new Map();
	function understoryOf( item, index ) {

		if ( understoryCache.has( index ) ) return understoryCache.get( index );
		const rules = understoryRules[ item.species ];
		let entry = null;
		if ( rules ) {

			entry = [];
			const random = createRandom( index * 7919 + 13 );
			for ( const rule of rules ) {

				const count = Math.floor( rule.count + random() );
				for ( let k = 0; k < count; k ++ ) {

					const angle = random() * Math.PI * 2;
					const distance = between( random, rule.radius ) * item.size;
					const x = item.x + Math.cos( angle ) * distance;
					const z = item.z + Math.sin( angle ) * distance;
					if ( understory.blocked && understory.blocked( x, z ) ) continue;
					const y = understory.groundAt( x, z ) - 0.05;
					entry.push( rule.index, x, y, z, random() * Math.PI * 2, between( random, rule.scale ), random() );

				}

			}

		}

		understoryCache.set( index, entry );
		return entry;

	}

	function addUnderstory( item, index ) {

		const entry = understoryOf( item, index );
		if ( ! entry ) return;
		for ( let k = 0; k < entry.length; k += 7 ) understory.layer.add( entry[ k ], entry[ k + 1 ], entry[ k + 2 ], entry[ k + 3 ], entry[ k + 4 ], entry[ k + 5 ], entry[ k + 6 ], item.cull );

	}

	// 这棵树的倒影会不会落进水面（镜头在 viewer，世界坐标）。保守地算，宁多勿漏：
	// 把树按倒影平面翻到水下，从镜头看过去它占一段俯角（树根贴水那头最平、翻下去的树顶最陡）和一段方位（树冠宽）；
	// 水面上俯角为 θ 的点离镜头水平 eye / tan θ 远，所以这段俯角对应水面上的一圈扇环。俯角上下各放宽 slack（微波把采样错开）、
	// 方位也放宽 slack，扇环用外接四边形代替，和水面的胶囊（半径再加 reflectStep：两次重分之间镜头最多挪这么远）有交就算会进倒影。
	// 镜头高度上下按 eyeSlack 的余量取（船的起伏、走路的颠都在几厘米）
	function mayReflect( item, slot, viewer ) {

		const water = reflectWater;
		const eye = viewer.y - water.level;
		if ( eye <= eyeSlack + 0.05 ) return true;
		const eyeLow = eye - eyeSlack;
		const eyeHigh = eye + eyeSlack;
		const top = item.y + slot.top * item.size + 0.5 - water.level;
		if ( top <= 0 ) return false;
		const crown = slot.radius * item.size + 0.5;
		const offsetX = item.x - viewer.x;
		const offsetZ = item.z - viewer.z;
		const distance = Math.sqrt( offsetX * offsetX + offsetZ * offsetZ );
		const movement = reflectStep;
		if ( distance <= crown + movement ) return true;
		const spread = Math.asin( Math.min( 1, crown / distance ) ) + water.slack;
		if ( spread >= 1.2 ) return true;
		const steepest = Math.atan( ( eyeHigh + top ) / Math.max( distance - crown, 0.01 ) ) + water.slack;
		const shallowest = Math.atan( eyeLow / ( distance + crown ) ) - water.slack;
		const nearDistance = steepest >= Math.PI / 2 - 1e-3 ? 0 : eyeLow / Math.tan( steepest );
		const farDistance = shallowest <= 1e-3 ? 6000 : Math.min( 6000, eyeHigh / Math.tan( shallowest ) );
		// 外接四边形：里边是两角的弦（比圆弧离镜头近，只会多不会少），外边按 farDistance / cos(spread) 放出去（整段圆弧都在里面）
		const angle = Math.atan2( offsetZ, offsetX );
		const outer = farDistance / Math.cos( spread );
		const cosineA = Math.cos( angle - spread );
		const sineA = Math.sin( angle - spread );
		const cosineB = Math.cos( angle + spread );
		const sineB = Math.sin( angle + spread );
		quad[ 0 ] = viewer.x + cosineA * nearDistance; quad[ 1 ] = viewer.z + sineA * nearDistance;
		quad[ 2 ] = viewer.x + cosineB * nearDistance; quad[ 3 ] = viewer.z + sineB * nearDistance;
		quad[ 4 ] = viewer.x + cosineB * outer; quad[ 5 ] = viewer.z + sineB * outer;
		quad[ 6 ] = viewer.x + cosineA * outer; quad[ 7 ] = viewer.z + sineA * outer;
		let minX = Infinity, maxX = - Infinity, minZ = Infinity, maxZ = - Infinity;
		for ( let k = 0; k < 8; k += 2 ) {

			minX = Math.min( minX, quad[ k ] ); maxX = Math.max( maxX, quad[ k ] );
			minZ = Math.min( minZ, quad[ k + 1 ] ); maxZ = Math.max( maxZ, quad[ k + 1 ] );

		}

		for ( const capsule of water.capsules ) {

			const reach = capsule.radius + movement;
			if ( Math.min( capsule.ax, capsule.bx ) > maxX + reach || Math.max( capsule.ax, capsule.bx ) < minX - reach ) continue;
			if ( Math.min( capsule.az, capsule.bz ) > maxZ + reach || Math.max( capsule.az, capsule.bz ) < minZ - reach ) continue;
			if ( quadSegmentDistance( quad, capsule.ax, capsule.az, capsule.bx, capsule.bz ) <= reach ) return true;

		}

		return false;

	}

	function writeTree( slot, at, index ) {

		const item = items[ index ];
		const offset = index * 16;
		if ( ! matrixReady[ index ] ) {

			placement.position.set( item.x, item.y, item.z );
			// 歪的树（窄处的海风松）：先绕竖轴转朝向，再按世界水平轴歪
			placement.rotation.set( item.tiltX || 0, item.yaw, item.tiltZ || 0, 'XZY' );
			placement.scale.setScalar( item.size );
			placement.updateMatrix();
			matrixCache.set( placement.matrix.elements, offset );
			matrixReady[ index ] = 1;

		}

		const barkMatrices = slot.meshes[ 0 ].instanceMatrix.array;
		const leafMatrices = slot.meshes[ 1 ].instanceMatrix.array;
		for ( let k = 0; k < 16; k ++ ) {

			barkMatrices[ at * 16 + k ] = matrixCache[ offset + k ];
			leafMatrices[ at * 16 + k ] = matrixCache[ offset + k ];

		}

		slot.treeBase.setXYZ( at, item.x, item.y, item.z );
		slot.treeInfo.setXYZW( at, item.tint, item.cull, item.size, ( item.tint * 7.31 ) % 1 );

	}

	// 镜头（世界坐标）挪动超过 refreshDistance 米、或者转头（view 给了时）偏过 turnAngle 才重挑；force 时一定重挑。
	// view：viewFromCamera 的结果；不给就只按距离挑（四面八方都收）
	function update( viewer, force = false, view = null ) {

		const viewSettings = view && settings.view ? settings.view : null;
		const limit = viewSettings ? Math.min( Math.PI, view.halfAngle + viewSettings.extraAngle ) : Math.PI;
		let turned = Boolean( viewSettings ) !== lastView.used;
		if ( ! turned && viewSettings ) {

			// 朝向偏了多少 + 视锥变宽了多少（低头、抬头）超过 turnAngle 重挑；视锥收窄很多（抬起头来）也重挑，把身后的树放掉。
			// 上次四面八方都收的话朝向偏多少都无所谓
			const drift = lastView.limit >= Math.PI ? 0 : Math.acos( Math.min( 1, Math.max( - 1, view.x * lastView.x + view.z * lastView.z ) ) );
			const widen = limit - lastView.limit;
			turned = drift + Math.max( 0, widen ) > viewSettings.turnAngle || widen < - 2 * viewSettings.turnAngle;

		}

		const moved = Math.hypot( viewer.x - lastViewer.x, viewer.z - lastViewer.z ) >= settings.refreshDistance;
		// 有倒影的：哪些进倒影按镜头位置算，挪了 reflectStep 米或升降超过 eyeSlack 米就重新分一次（只重排挑中的那些、不重挑，很便宜）
		const shifted = reflectWater !== null && ( Math.hypot( viewer.x - lastReflect.x, viewer.z - lastReflect.z ) >= reflectStep || Math.abs( viewer.y - lastReflect.y ) > eyeSlack );
		const rescaled = settings.near.value !== lastNear || ( understory && understory.near.value !== lastUnderstoryNear );
		if ( ! force && ! turned && ! moved && ! shifted && ! rescaled ) return;
		const started = performance.now();
		if ( force || turned || moved || rescaled ) pickTrees( viewer, view, viewSettings, limit );
		if ( reflectWater ) lastReflect.copy( viewer );
		writeSlots( viewer );
		const elapsed = performance.now() - started;
		pickStats.picks ++;
		pickStats.lastMs = elapsed;
		pickStats.maxMs = Math.max( pickStats.maxMs, elapsed );

	}

	// 按镜头位置和朝向重挑（结果在各槽位的 picked 里），林下跟着撒
	function pickTrees( viewer, view, viewSettings, limit ) {

		lastViewer.copy( viewer );
		lastNear = settings.near.value;
		if ( understory ) lastUnderstoryNear = understory.near.value;
		lastView.used = Boolean( viewSettings );
		lastView.limit = limit;
		if ( viewSettings ) {

			lastView.x = view.x;
			lastView.z = view.z;

		}

		// 方位：水平方向和朝向夹角的余弦不小于 cosLimit 的收进来（limit 是 π 时全收）；closeRadius 米以内不看方位
		const cosLimit = limit >= Math.PI ? - 2 : Math.cos( limit );
		const closeRadius = viewSettings ? viewSettings.closeRadius : Infinity;
		const band = settings.band && Number.isFinite( settings.band.value ) ? settings.band.value : 0;
		for ( const slot of slots.values() ) slot.picked.length = 0;
		if ( understory ) understory.layer.reset();
		const understoryReach = understory ? understory.near.value + settings.refreshDistance + 4 : 0;
		const near = settings.near.value;
		const reach = near + settings.refreshDistance + 8;
		const minCellX = Math.floor( ( viewer.x - reach ) / cellSize );
		const maxCellX = Math.floor( ( viewer.x + reach ) / cellSize );
		const minCellZ = Math.floor( ( viewer.z - reach ) / cellSize );
		const maxCellZ = Math.floor( ( viewer.z + reach ) / cellSize );
		selected = 0;
		for ( let cellX = minCellX; cellX <= maxCellX; cellX ++ ) {

			for ( let cellZ = minCellZ; cellZ <= maxCellZ; cellZ ++ ) {

				const list = cells.get( cellKey( cellX, cellZ ) );
				if ( ! list ) continue;
				for ( const index of list ) {

					const slot = slotOf[ index ];
					if ( ! slot ) continue;
					const item = items[ index ];
					const offsetX = item.x - viewer.x;
					const offsetZ = item.z - viewer.z;
					const offsetY = ( item.y - viewer.y ) * 0.5;
					// 先比平方再开方（Math.hypot 在 V8 里比 sqrt 慢好几倍，这里一次重挑要跑几千棵）
					const flatSquared = offsetX * offsetX + offsetZ * offsetZ;
					const itemReach = settings.nearScale ? near * scaleOf[ index ] + settings.refreshDistance + 8 : reach;
					const distanceSquared = flatSquared + offsetY * offsetY;
					if ( distanceSquared > itemReach * itemReach ) continue;
					const distance = Math.sqrt( distanceSquared );
					const flat = Math.sqrt( flatSquared );
					if ( flat > closeRadius && offsetX * lastView.x + offsetZ * lastView.z < cosLimit * flat ) continue;
					if ( slot.picked.length >= settings.maxPerMesh ) continue;
					// 着色器里画 3D 的距离是 near·nearScale − band·cull（远近随机数大的树早早交给替身），再远的挑进来也只是缩成一个点、白跑顶点。
					// 林下照原来的条件撒（树挑没挑上都撒，和原来一样）
					if ( distance <= itemReach - band * item.cull ) {

						slot.picked.push( index );
						selected ++;

					}

					if ( understory && distance < understoryReach ) addUnderstory( item, index );

				}

			}

		}

		if ( understory ) understory.layer.commit();

	}

	// 挑中的树写进实例数据（矩阵是缓存好的，直接拷）；有倒影的，会进倒影的排在前面
	function writeSlots( viewer ) {

		for ( const slot of slots.values() ) {

			let at = 0;
			if ( reflectWater ) {

				// 会进倒影的排在前面：倒影 pass 里实例数换成 reflectCount，只画前面这些
				for ( const index of slot.picked ) reflectable[ index ] = mayReflect( items[ index ], slot, viewer ) ? 1 : 0;
				for ( const index of slot.picked ) if ( reflectable[ index ] ) writeTree( slot, at ++, index );
				slot.reflectCount = at;
				for ( const index of slot.picked ) if ( ! reflectable[ index ] ) writeTree( slot, at ++, index );

			} else {

				for ( const index of slot.picked ) writeTree( slot, at ++, index );
				slot.reflectCount = at;

			}

			slot.count = at;
			for ( const mesh of slot.meshes ) {

				mesh.count = reflecting ? slot.reflectCount : at;
				if ( at === 0 ) continue;
				mesh.instanceMatrix.clearUpdateRanges();
				mesh.instanceMatrix.addUpdateRange( 0, at * 16 );
				mesh.instanceMatrix.needsUpdate = true;

			}

			if ( at === 0 ) continue;
			slot.treeBase.clearUpdateRanges();
			slot.treeBase.addUpdateRange( 0, at * 3 );
			slot.treeBase.needsUpdate = true;
			slot.treeInfo.clearUpdateRanges();
			slot.treeInfo.addUpdateRange( 0, at * 4 );
			slot.treeInfo.needsUpdate = true;

		}

	}

	return {
		group,
		update,
		getSelectedCount: () => selected,
		// 重挑了几次（有倒影的，只重分倒影的那几次也算在里面）、上一次和最慢一次用了多少毫秒
		getPickStats: () => pickStats,
		// 倒影 pass 前 true、画完 false：只画会出现在倒影里的树（建的时候没给 reflectWater 就和平时一样）
		setReflection( on ) {

			reflecting = Boolean( on );
			for ( const slot of slots.values() ) for ( const mesh of slot.meshes ) mesh.count = reflecting ? slot.reflectCount : slot.count;

		},
		dispose() {

			for ( const item of disposables ) item.dispose();
			if ( understory ) understory.layer.dispose();

		},
	};

}

// ===================== 林下：灌木、蕨、花丛、草丛（Quaternius Stylized Nature MegaKit，CC0）=====================
// 每种一组网格（模型里有几个子网格就几个），实例化；位置跟着近处的树挑：每棵树按树种的规则在树根周围撒几丛，
// 规则和随机数都由树的序号定（同一棵树每次挑出来，周围的灌木一样）。重新着色：贴图只取明暗，颜色乘这一种的调色（绘本的绿），
// 花这类保留一部分原来的色相（keepHue）。叶子类的法线往上掰（单面的叶片按自己的法线打光，明暗碎得像噪点）
// kinds：[{ name, object（loadModel 的结果）, tint（颜色节点）, keepHue（0~1）, upright（0~1）}]
export function createUnderstoryLayer( { kinds, uniforms, shade, maxPerMesh } ) {

	const group = new THREE.Group();
	group.name = '林下';
	const layers = [];
	const disposables = [];
	for ( const kind of kinds ) {

		const base = new THREE.InstancedBufferAttribute( new Float32Array( maxPerMesh * 3 ), 3 );
		const info = new THREE.InstancedBufferAttribute( new Float32Array( maxPerMesh * 4 ), 4 );
		base.setUsage( THREE.DynamicDrawUsage );
		info.setUsage( THREE.DynamicDrawUsage );
		// 一丛都没撒的时候实例数是 0（同近处的树：照样预编译，只是不画；原来留一丛藏在地下一万米的，每帧白跑一遍顶点）
		const meshes = [];
		kind.object.updateMatrixWorld( true );
		kind.object.traverse( ( child ) => {

			if ( ! child.isMesh ) return;
			// 子网格的局部变换烘进几何体（实例矩阵只管摆放）。模型是 meshopt 量化过的（KHR_mesh_quantization：位置、uv 是归一化的 16 位整数，
			// 反量化的缩放在节点矩阵里），直接 applyMatrix4 会把超出 ±1 的坐标夹回去，整丛灌木变成一个盒子：先转成 32 位浮点
			const geometry = new THREE.BufferGeometry();
			for ( const name of [ 'position', 'normal', 'uv' ] ) {

				const source = child.geometry.getAttribute( name );
				if ( ! source ) continue;
				const array = new Float32Array( source.count * source.itemSize );
				for ( let i = 0; i < source.count; i ++ ) {

					for ( let c = 0; c < source.itemSize; c ++ ) array[ i * source.itemSize + c ] = source.getComponent( i, c );

				}

				geometry.setAttribute( name, new THREE.BufferAttribute( array, source.itemSize ) );

			}

			if ( child.geometry.index ) geometry.setIndex( Array.from( child.geometry.index.array ) );
			geometry.applyMatrix4( child.matrixWorld );

			if ( ! geometry.attributes.normal ) geometry.computeVertexNormals();
			geometry.setAttribute( 'treeBase', base );
			geometry.setAttribute( 'treeInfo', info );
			const map = child.material && child.material.map ? child.material.map : null;
			const material = new THREE.MeshBasicNodeMaterial();
			material.name = '林下·' + kind.name;
			material.side = THREE.DoubleSide;
			material.fog = false;
			material.lights = false;
			const visible = instanceVisible( uniforms );
			const baseNode = attribute( 'treeBase', 'vec3' );
			const infoNode = attribute( 'treeInfo', 'vec4' );
			// 风：高处的叶子晃一点
			const phase = baseNode.x.mul( 0.13 ).add( baseNode.z.mul( 0.11 ) );
			const sway = vec3( sin( uniforms.time.mul( 1.3 ).add( phase ) ), 0, cos( uniforms.time.mul( 1.1 ).add( phase ) ) ).mul( max( attribute( 'position', 'vec3' ).y, 0 ).mul( 0.04 ) );
			material.positionNode = mix( baseNode, positionLocal.add( sway ), visible );
			const baseVarying = varying( baseNode, 'understoryBase' );
			const pointVarying = varying( positionLocal, 'understoryPoint' );
			const tintVarying = varying( infoNode.x, 'understoryTint' );
			material.colorNode = Fn( () => {

				const uv = attribute( 'uv', 'vec2' );
				const sample = ( map ? texture( map, uv ) : vec4( 0.5, 0.5, 0.5, 1 ) ).toVar();
				const discarded = sample.a.lessThan( 0.5 ).toVar();
				Discard( discarded );
				// 丢掉的片元后面的光照、大气整段跳过（同叶卡）
				const outColor = vec4( 0, 0, 0, 1 ).toVar();
				If( discarded.not(), () => {

					// 明暗按亮度比（0.18 当中灰），压到 0.5~1.4：贴图本身偏暗、偏亮都不影响整体颜色
					const brightness = min( max( pow( max( dot( sample.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.005 ).div( 0.18 ), 0.6 ), 0.5 ), 1.4 );
					const albedo = mix( kind.tint.mul( brightness ), sample.rgb, kind.keepHue ).mul( tintVarying.sub( 0.5 ).mul( 0.25 ).add( 1 ) );
					const geometryNormal = normalize( uniforms.sceneToWorld.mul( vec4( normalWorld, 0 ) ).xyz );
					const normal = normalize( mix( geometryNormal, vec3( 0, 1, 0 ), kind.upright ) );
					outColor.assign( vec4( shade( albedo, normal, pointVarying, { skyView: float( 0.75 ), wrap: 0.4, base: baseVarying } ), 1 ) );

				} );
				return outColor;

			} )();
			const mesh = new THREE.InstancedMesh( geometry, material, maxPerMesh );
			mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
			mesh.count = 0;
			mesh.frustumCulled = false;
			mesh.name = '林下·' + kind.name;
			group.add( mesh );
			meshes.push( mesh );
			disposables.push( geometry, material );

		} );

		layers.push( { kind, meshes, base, info, count: 0 } );

	}

	return {
		group,
		kindIndex: ( name ) => kinds.findIndex( ( kind ) => kind.name === name ),
		reset() {

			for ( const layer of layers ) layer.count = 0;

		},
		add( index, x, y, z, yaw, scale, tint, cull ) {

			const layer = layers[ index ];
			if ( ! layer || layer.count >= maxPerMesh ) return;
			const at = layer.count ++;
			// 只绕竖轴转 + 等比缩放：矩阵直接写（原来每丛走一遍 Object3D.updateMatrix 的欧拉角 → 四元数 → 矩阵），列主序
			const cosine = Math.cos( yaw ) * scale;
			const sine = Math.sin( yaw ) * scale;
			for ( const mesh of layer.meshes ) {

				const array = mesh.instanceMatrix.array;
				const offset = at * 16;
				array[ offset ] = cosine; array[ offset + 1 ] = 0; array[ offset + 2 ] = - sine; array[ offset + 3 ] = 0;
				array[ offset + 4 ] = 0; array[ offset + 5 ] = scale; array[ offset + 6 ] = 0; array[ offset + 7 ] = 0;
				array[ offset + 8 ] = sine; array[ offset + 9 ] = 0; array[ offset + 10 ] = cosine; array[ offset + 11 ] = 0;
				array[ offset + 12 ] = x; array[ offset + 13 ] = y; array[ offset + 14 ] = z; array[ offset + 15 ] = 1;

			}

			layer.base.setXYZ( at, x, y, z );
			layer.info.setXYZW( at, tint, cull, scale, 0 );

		},
		commit() {

			for ( const layer of layers ) {

				for ( const mesh of layer.meshes ) {

					mesh.count = layer.count;
					if ( layer.count === 0 ) continue;
					mesh.instanceMatrix.clearUpdateRanges();
					mesh.instanceMatrix.addUpdateRange( 0, layer.count * 16 );
					mesh.instanceMatrix.needsUpdate = true;

				}

				if ( layer.count === 0 ) continue;
				layer.base.clearUpdateRanges();
				layer.base.addUpdateRange( 0, layer.count * 3 );
				layer.base.needsUpdate = true;
				layer.info.clearUpdateRanges();
				layer.info.addUpdateRange( 0, layer.count * 4 );
				layer.info.needsUpdate = true;

			}

		},
		dispose() {

			for ( const item of disposables ) item.dispose();

		},
	};

}

// 树种配置的指纹（替身图集烘焙时记下，运行时对不上就说明配置改过、图集要重烘）
export function treeSpeciesHash( species, variants ) {

	const text = JSON.stringify( { species, variants } );
	let hash = 2166136261;
	for ( let i = 0; i < text.length; i ++ ) {

		hash ^= text.charCodeAt( i );
		hash = Math.imul( hash, 16777619 );

	}

	return ( hash >>> 0 ).toString( 16 );

}
