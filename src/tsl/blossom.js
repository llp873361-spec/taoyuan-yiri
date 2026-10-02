// 开花的树（开场的桃林、花园的花树共用）：程序化的树枝（五棱锥管合成一个几何体，按模板实例化）+ 花枝卡片
// （0.4~0.75 米的方片撒在开花的位置周围，片元里画成一簇五瓣的花，alpha 测试）。光照由场景给（shade / shadeThin）。

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, attribute, texture, color, select,
	positionWorld, positionGeometry, normalGeometry, normalWorld, cameraPosition,
	normalize, length, dot, mix, smoothstep, sin, cos, atan, floor, fract, Discard,
} from 'three/tsl';
import { hash33 } from './noise.js';

const degree = Math.PI / 180;
const worldUp = new THREE.Vector3( 0, 1, 0 );

// 一棵树的模板（米，树根在原点）：主干 1~1.5 米分出 3~4 根主枝，往外斜着长，再各分 2~3 根侧枝、侧枝上两根小枝；
// 返回树枝段（起点、终点、半径）和开花的位置（侧枝、小枝的后半截和梢上，团状）。shape.height 整体拉高（花园的花树比桃树高）
export function blossomTemplate( random, shape = {} ) {

	const height = shape.height || 1;
	const segments = [];
	const blossoms = [];
	const trunkTop = new THREE.Vector3( ( random() - 0.5 ) * 0.4, ( 1.0 + random() * 0.5 ) * height, ( random() - 0.5 ) * 0.4 );
	segments.push( { start: new THREE.Vector3(), end: trunkTop, startRadius: ( 0.17 + random() * 0.05 ) * Math.sqrt( height ), endRadius: 0.12 * Math.sqrt( height ) } );
	const mainCount = 3 + Math.floor( random() * 2 );
	for ( let m = 0; m < mainCount; m ++ ) {

		const azimuth = ( m + random() * 0.6 ) / mainCount * Math.PI * 2;
		const tilt = ( 35 + random() * 22 ) * degree / Math.sqrt( height );
		const mainLength = ( 1.5 + random() * 0.8 ) * height;
		const direction = new THREE.Vector3( Math.sin( tilt ) * Math.cos( azimuth ), Math.cos( tilt ), Math.sin( tilt ) * Math.sin( azimuth ) );
		const mainEnd = trunkTop.clone().addScaledVector( direction, mainLength );
		segments.push( { start: trunkTop, end: mainEnd, startRadius: 0.1, endRadius: 0.06 } );
		const sideCount = 2 + Math.floor( random() * 2 );
		for ( let s = 0; s < sideCount; s ++ ) {

			const from = trunkTop.clone().lerp( mainEnd, 0.45 + s / sideCount * 0.55 );
			const sideDirection = direction.clone().add( new THREE.Vector3( ( random() - 0.5 ) * 1.4, random() * 0.6 - 0.1, ( random() - 0.5 ) * 1.4 ) ).normalize();
			const sideLength = 0.9 + random() * 0.7;
			const sideEnd = from.clone().addScaledVector( sideDirection, sideLength );
			segments.push( { start: from, end: sideEnd, startRadius: 0.045, endRadius: 0.025 } );
			for ( let t = 0; t < 2; t ++ ) {

				const twigFrom = from.clone().lerp( sideEnd, 0.5 + t * 0.4 );
				const twigDirection = sideDirection.clone().add( new THREE.Vector3( ( random() - 0.5 ) * 1.6, random() * 0.8, ( random() - 0.5 ) * 1.6 ) ).normalize();
				const twigEnd = twigFrom.clone().addScaledVector( twigDirection, 0.5 + random() * 0.4 );
				segments.push( { start: twigFrom, end: twigEnd, startRadius: 0.02, endRadius: 0.01 } );
				blossoms.push( twigEnd.clone(), twigFrom.clone().lerp( twigEnd, 0.5 ) );

			}

			blossoms.push( sideEnd.clone(), from.clone().lerp( sideEnd, 0.6 ) );

		}

		blossoms.push( mainEnd.clone() );

	}

	return { segments, blossoms, crownHeight: 2.6 * height };

}

// 树枝段 → 五棱的锥管，合成一个几何体
export function branchGeometry( template ) {

	const sides = 5;
	const positions = [];
	const normals = [];
	const indices = [];
	const axis = new THREE.Vector3();
	const helper = new THREE.Vector3();
	const sideA = new THREE.Vector3();
	const sideB = new THREE.Vector3();
	for ( const segment of template.segments ) {

		axis.subVectors( segment.end, segment.start ).normalize();
		helper.set( 0, 1, 0 );
		if ( Math.abs( axis.y ) > 0.9 ) helper.set( 1, 0, 0 );
		sideA.crossVectors( axis, helper ).normalize();
		sideB.crossVectors( axis, sideA ).normalize();
		const first = positions.length / 3;
		for ( let ring = 0; ring < 2; ring ++ ) {

			const center = ring === 0 ? segment.start : segment.end;
			const radius = ring === 0 ? segment.startRadius : segment.endRadius;
			for ( let k = 0; k < sides; k ++ ) {

				const angle = k / sides * Math.PI * 2;
				const nx = sideA.x * Math.cos( angle ) + sideB.x * Math.sin( angle );
				const ny = sideA.y * Math.cos( angle ) + sideB.y * Math.sin( angle );
				const nz = sideA.z * Math.cos( angle ) + sideB.z * Math.sin( angle );
				positions.push( center.x + nx * radius, center.y + ny * radius, center.z + nz * radius );
				normals.push( nx, ny, nz );

			}

		}

		for ( let k = 0; k < sides; k ++ ) {

			const a = first + k;
			const b = first + ( k + 1 ) % sides;
			indices.push( a, b, a + sides, b, b + sides, a + sides );

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
	geometry.setIndex( indices );
	geometry.computeBoundingSphere();
	return geometry;

}

// 树干：每个模板一个 InstancedMesh，补到 4096 个实例（three r186 实例数 ≤ 1024 时每挂进一个新场景生成一份新着色器）。
// trees：[{ x, y, z, yaw, scale, template }]
export function instanceTrunks( templates, trees, material, name ) {

	const meshes = [];
	const geometries = [];
	templates.forEach( ( template, templateIndex ) => {

		const mine = trees.filter( ( tree ) => tree.template === templateIndex );
		if ( mine.length === 0 ) return;
		const geometry = branchGeometry( template );
		const capacity = Math.max( 4096, mine.length );
		const mesh = new THREE.InstancedMesh( geometry, material, capacity );
		mesh.name = name;
		mesh.frustumCulled = false;
		const matrix = new THREE.Matrix4();
		const rotation = new THREE.Quaternion();
		const scale = new THREE.Vector3();
		const position = new THREE.Vector3();
		for ( let i = 0; i < capacity; i ++ ) {

			const tree = mine[ i ];
			if ( tree ) {

				rotation.setFromAxisAngle( worldUp, - tree.yaw );
				scale.setScalar( tree.scale );
				matrix.compose( position.set( tree.x, tree.y, tree.z ), rotation, scale );

			} else {

				matrix.makeScale( 0, 0, 0 );

			}

			mesh.setMatrixAt( i, matrix );

		}

		mesh.instanceMatrix.needsUpdate = true;
		meshes.push( mesh );
		geometries.push( geometry );

	} );
	return { meshes, geometries };

}

// 花团：每个开花位置周围撒一把花枝卡片（朝向随机、偏向树冠外），片元里画成一簇五瓣的花。
// options：random 随机数函数；perCluster( tree ) → 这棵树每团几张（远处的树少一些）；sizeScale( tree ) → 卡片放大（远处大一点补密度）
export function blossomCards( trees, templates, options ) {

	const random = options.random;
	const corners = [ [ - 0.5, - 0.5 ], [ 0.5, - 0.5 ], [ 0.5, 0.5 ], [ - 0.5, 0.5 ] ];
	const positions = [];
	const cardData = [];      // 卡片角（xy）、种子（z）、离树心多远（w，0 里面 1 外面）
	const normals = [];
	const indices = [];
	const center = new THREE.Vector3();
	const normal = new THREE.Vector3();
	const tangent = new THREE.Vector3();
	const bitangent = new THREE.Vector3();
	const crownCenter = new THREE.Vector3();
	const outward = new THREE.Vector3();
	let seed = 0;
	for ( const tree of trees ) {

		const template = templates[ tree.template ];
		const perCluster = Math.max( 2, Math.round( options.perCluster( tree ) ) );
		const sizeScale = options.sizeScale ? options.sizeScale( tree ) : 1;
		const cosine = Math.cos( tree.yaw );
		const sine = Math.sin( tree.yaw );
		crownCenter.set( tree.x, tree.y + template.crownHeight * tree.scale, tree.z );
		for ( const blossom of template.blossoms ) {

			const baseX = tree.x + ( blossom.x * cosine - blossom.z * sine ) * tree.scale;
			const baseY = tree.y + blossom.y * tree.scale;
			const baseZ = tree.z + ( blossom.x * sine + blossom.z * cosine ) * tree.scale;
			for ( let c = 0; c < perCluster; c ++ ) {

				center.set( baseX + ( random() - 0.5 ) * 0.9, baseY + ( random() - 0.5 ) * 0.6, baseZ + ( random() - 0.5 ) * 0.9 );
				outward.subVectors( center, crownCenter ).normalize();
				normal.set( random() - 0.5, random() - 0.5, random() - 0.5 ).normalize().addScaledVector( outward, 0.9 ).normalize();
				tangent.set( 0, 1, 0 ).cross( normal );
				if ( tangent.lengthSq() < 1e-4 ) tangent.set( 1, 0, 0 );
				tangent.normalize();
				bitangent.crossVectors( normal, tangent );
				const size = ( 0.42 + random() * 0.35 ) * tree.scale * sizeScale;
				const roll = random() * Math.PI * 2;
				const first = positions.length / 3;
				const outer = Math.min( 1, center.distanceTo( crownCenter ) / ( template.crownHeight * 0.92 * tree.scale ) );
				for ( const [ cornerX, cornerY ] of corners ) {

					const rx = cornerX * Math.cos( roll ) - cornerY * Math.sin( roll );
					const ry = cornerX * Math.sin( roll ) + cornerY * Math.cos( roll );
					positions.push(
						center.x + ( tangent.x * rx + bitangent.x * ry ) * size,
						center.y + ( tangent.y * rx + bitangent.y * ry ) * size,
						center.z + ( tangent.z * rx + bitangent.z * ry ) * size,
					);
					normals.push( normal.x, normal.y, normal.z );
					cardData.push( cornerX + 0.5, cornerY + 0.5, seed, outer );

				}

				indices.push( first, first + 1, first + 2, first, first + 2, first + 3 );
				seed ++;

			}

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'cardData', new THREE.Float32BufferAttribute( cardData, 4 ) );
	geometry.setIndex( positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute( indices, 1 ) : new THREE.Uint16BufferAttribute( indices, 1 ) );
	geometry.computeBoundingSphere();
	return { geometry, cards: seed };

}

// 花的材质。options：time、windAmount（uniform）；shadeThin( albedo, normal, position, toViewer )；
// colors { heart 花心, inner 花瓣里, outer 花瓣边 }（sRGB 字符串）；name
export function createBlossomMaterial( options ) {

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = options.name || '花';
	material.side = THREE.DoubleSide;
	material.fog = false;
	material.lights = false;
	const card = attribute( 'cardData', 'vec4' );
	const seed = card.z;
	const colors = options.colors;

	// 风：整团花枝轻轻晃（外圈晃得多）
	const random = hash33( vec3( seed, 11, 3 ) );
	const time = options.time;
	const sway = vec3(
		sin( time.mul( 1.3 ).add( random.x.mul( 6.28 ) ).add( positionGeometry.x.mul( 0.3 ) ) ),
		sin( time.mul( 1.7 ).add( random.y.mul( 6.28 ) ) ).mul( 0.4 ),
		cos( time.mul( 1.1 ).add( random.z.mul( 6.28 ) ).add( positionGeometry.z.mul( 0.3 ) ) ),
	).mul( card.w.mul( 0.035 ).add( 0.01 ) ).mul( options.windAmount );
	material.positionNode = positionGeometry.add( sway );

	material.colorNode = Fn( () => {

		// 一张卡片 3×3 格，每格一朵花（有的没有、有的是花苞）：五瓣，r < 0.5·(0.72 + 0.28·cos(5θ)) 的极坐标花形
		const uv = card.xy.mul( 3 );
		const cell = floor( uv );
		const local = fract( uv ).sub( 0.5 );
		const flowerRandom = hash33( vec3( cell, seed ) );
		const offset = flowerRandom.xy.sub( 0.5 ).mul( 0.35 );
		const point = local.sub( offset );
		const radius = length( point );
		const angle = select( radius.greaterThan( 1e-4 ), vec2( point.x, point.y ).normalize(), vec2( 1, 0 ) );
		const theta = atan( angle.y, angle.x ).add( flowerRandom.z.mul( 6.28 ) );
		const bloom = flowerRandom.x.greaterThan( 0.22 );
		const flowerSize = mix( float( 0.26 ), float( 0.42 ), flowerRandom.y ).mul( select( flowerRandom.z.greaterThan( 0.85 ), float( 0.5 ), float( 1 ) ) );
		const petalEdge = flowerSize.mul( cos( theta.mul( 5 ) ).mul( 0.28 ).add( 0.72 ) );
		const inside = select( bloom, float( 1 ).sub( smoothstep( petalEdge.mul( 0.9 ), petalEdge, radius ) ), float( 0 ) );
		Discard( inside.lessThan( 0.5 ) );

		// 颜色：花心深，往外淡到近白；每朵、每棵树略有不同
		const heart = smoothstep( 0, flowerSize.mul( 0.45 ), radius );
		const petalTone = mix( color( colors.inner ), color( colors.outer ), flowerRandom.y.mul( 0.5 ).add( heart.mul( 0.5 ) ) );
		const albedo = mix( color( colors.heart ), petalTone, heart ).mul( mix( float( 0.82 ), float( 1 ), card.w ) );
		const normal = normalize( normalGeometry );
		const toViewer = normalize( cameraPosition.sub( positionWorld ) );
		const facing = select( dot( normal, toViewer ).greaterThan( 0 ), normal, normal.negate() );
		return vec4( options.shadeThin( albedo, facing, positionWorld, toViewer ), 1 );

	} )();

	return material;

}

// 树皮：深褐，按高度拉长的噪声纹理。options：noiseTexture、shade( albedo, normal, position, settings )、name
export function createBarkMaterial( options ) {

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = options.name || '树干';
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		// 树干是实例化的：法线要用转过实例旋转的 normalWorld（normalGeometry 是没转的）
		const point = positionWorld;
		const normal = normalize( normalWorld );
		const grain = texture( options.noiseTexture, vec2( point.x.add( point.z ), point.y.mul( 3 ) ).div( 1.3 ) ).r;
		const albedo = mix( color( '#2e211c' ), color( '#4d3a31' ), grain );
		return options.shade( albedo, normal, point, { skyView: float( 0.75 ), wrap: 0.4 } );

	} )();
	return material;

}
