// 先窄后豁然开朗（规格书 5.3，阶段 12）：每段航线到达前穿过的窄处，常驻在远景里（飞行和地点里都看得见，换场景时窄处不变）。
//   岩丘裂隙 cleft：海边一座岩丘被溪水切开的口子（花园 → 落日；口子是地形 terrainShape.knolls / notches + 远景的地形补丁，这里放落石、卵石和小溪）
//   林间小路 trail：西岸老林里一条弯弯的土路（落日 → 哥特；林子是树林布点本来就种的，这里给路两边加密成老林、种几棵歪向路的树、铺路面、摆苔石）
//   冰碛岗鞍部 moraine：冰瀑崖脚一道弧形的土石岗（哥特 → 星月夜；岗是地形 terrainShape.moraines，这里在岗上摆乱石，岗上的松由树林布点加密）
//   融水冰槽 trough：冰瀑上口融水冲出来的槽（星月夜 → 雪原；槽是地形 notches 里 ice 的那条，槽壁由地形着色画成冰，这里挂冰凌、堆雪檐、放几块冰、一道融水）
// 窄处的中线就是 config.world.legs[].frame.path（世界坐标，顺着飞行方向）。
// 阶段 12 CP2 是毛坯（崖缝的噪声墙、林荫隧道、两座圆锥小丘、冰岩团）；CP3 返工全部改成地形和植被里本来就有的（规格书 5.3）。

import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, color, attribute, texture, positionWorld, normalWorld, positionGeometry, cameraPosition, cameraViewMatrix, cameraProjectionMatrix,
	mix, smoothstep, dot, abs, pow, max, min, exp, length, sin } from 'three/tsl';
import { mergeVertices, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { jsFbm2D, valueNoise3D } from '../tsl/noise.js';
import { daySkyColor } from '../tsl/sky.js';
import { loadModel } from '../core/assets.js';
import config from '../config.js';

function createRandom( seed ) {

	let value = ( seed >>> 0 ) || 1;
	return function next() {

		value = ( value + 0x6D2B79F5 ) | 0;
		let mixed = Math.imul( value ^ ( value >>> 15 ), 1 | value );
		mixed = ( mixed + Math.imul( mixed ^ ( mixed >>> 7 ), 61 | mixed ) ) ^ mixed;
		return ( ( mixed ^ ( mixed >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

function smoothJs( edge0, edge1, value ) {

	const amount = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return amount * amount * ( 3 - 2 * amount );

}

// 中线（世界坐标的点列）按水平距离重采样：返回 [{ x, y, z, along（米）, sideX, sideZ（往右的水平单位方向）}]，
// 入口前伸出 extend[0] 米、出口后伸出 extend[1] 米（传一个数就两头一样）
function resampleLine( points, step, extendBoth ) {

	const [ extendBefore, extendAfter ] = Array.isArray( extendBoth ) ? extendBoth : [ extendBoth, extendBoth ];

	const lengths = [ 0 ];
	for ( let i = 1; i < points.length; i ++ ) lengths.push( lengths[ i - 1 ] + Math.hypot( points[ i ][ 0 ] - points[ i - 1 ][ 0 ], points[ i ][ 2 ] - points[ i - 1 ][ 2 ] ) );
	const total = lengths[ lengths.length - 1 ];
	const result = [];
	const count = Math.max( 2, Math.ceil( ( total + extendBefore + extendAfter ) / step ) + 1 );
	for ( let k = 0; k < count; k ++ ) {

		const along = - extendBefore + ( total + extendBefore + extendAfter ) * k / ( count - 1 );
		const clamped = Math.min( total, Math.max( 0, along ) );
		let segment = 0;
		while ( segment < points.length - 2 && lengths[ segment + 1 ] < clamped ) segment ++;
		const span = Math.max( 1e-6, lengths[ segment + 1 ] - lengths[ segment ] );
		const t = ( clamped - lengths[ segment ] ) / span;
		const from = points[ segment ];
		const to = points[ segment + 1 ];
		const directionX = ( to[ 0 ] - from[ 0 ] ) / span;
		const directionZ = ( to[ 2 ] - from[ 2 ] ) / span;
		const overshoot = along - clamped;
		result.push( {
			x: from[ 0 ] + ( to[ 0 ] - from[ 0 ] ) * t + directionX * overshoot,
			y: from[ 1 ] + ( to[ 1 ] - from[ 1 ] ) * t,
			z: from[ 2 ] + ( to[ 2 ] - from[ 2 ] ) * t + directionZ * overshoot,
			along,
			sideX: - directionZ,
			sideZ: directionX,
		} );

	}

	return { samples: result, length: total };

}

// 几个几何体（属性一致、都带索引）合成一个
function mergeIndexed( parts ) {

	let vertexCount = 0;
	let indexCount = 0;
	for ( const part of parts ) {

		vertexCount += part.attributes.position.count;
		indexCount += part.index.count;

	}

	const names = Object.keys( parts[ 0 ].attributes );
	const arrays = {};
	for ( const name of names ) arrays[ name ] = new Float32Array( vertexCount * parts[ 0 ].attributes[ name ].itemSize );
	const indices = new Uint32Array( indexCount );
	let vertexOffset = 0;
	let indexOffset = 0;
	for ( const part of parts ) {

		for ( const name of names ) arrays[ name ].set( part.attributes[ name ].array, vertexOffset * part.attributes[ name ].itemSize );
		for ( let i = 0; i < part.index.count; i ++ ) indices[ indexOffset + i ] = part.index.array[ i ] + vertexOffset;
		vertexOffset += part.attributes.position.count;
		indexOffset += part.index.count;
		part.dispose();

	}

	const geometry = new THREE.BufferGeometry();
	for ( const name of names ) geometry.setAttribute( name, new THREE.BufferAttribute( arrays[ name ], parts[ 0 ].attributes[ name ].itemSize ) );
	geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );
	geometry.computeBoundingSphere();
	return geometry;

}

// 中线上离起点 along 米处（水平距离）的点和往右的方向
function sampleLine( line, along ) {

	const samples = line.samples;
	let k = 0;
	while ( k < samples.length - 2 && samples[ k + 1 ].along < along ) k ++;
	const from = samples[ k ];
	const to = samples[ k + 1 ];
	const t = Math.min( 1, Math.max( 0, ( along - from.along ) / Math.max( 1e-6, to.along - from.along ) ) );
	return { x: from.x + ( to.x - from.x ) * t, y: from.y + ( to.y - from.y ) * t, z: from.z + ( to.z - from.z ) * t, sideX: from.sideX, sideZ: from.sideZ };

}

function createRockMaterial( name, palette, lighting, atmosphere, sky ) {

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = name;
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const point = positionWorld;
		const occlusion = attribute( 'occlusion', 'float' );
		const bump = vec3(
			valueNoise3D( point.mul( 0.21 ).add( 3.1 ) ).add( valueNoise3D( point.mul( 0.83 ).add( 7.7 ) ).mul( 0.5 ) ),
			valueNoise3D( point.mul( 0.21 ).add( 11.3 ) ).add( valueNoise3D( point.mul( 0.83 ).add( 1.9 ) ).mul( 0.5 ) ),
			valueNoise3D( point.mul( 0.21 ).add( 5.4 ) ).add( valueNoise3D( point.mul( 0.83 ).add( 9.2 ) ).mul( 0.5 ) ),
		).sub( 0.75 ).mul( palette.bump );
		const normal = normalWorld.add( bump ).normalize();
		const strata = valueNoise3D( vec3( point.x.mul( 0.05 ), point.y.mul( 0.6 ), point.z.mul( 0.05 ) ) );
		const blotch = valueNoise3D( point.mul( 0.11 ) ).mul( 0.6 ).add( valueNoise3D( point.mul( 0.47 ) ).mul( 0.4 ) );
		const rock = mix( color( palette.dark ), color( palette.light ), strata.mul( 0.5 ).add( blotch.mul( 0.5 ) ) );
		const cover = smoothstep( palette.coverFrom, palette.coverTo, normal.y.add( blotch.sub( 0.5 ).mul( 0.3 ) ) );
		const albedo = mix( rock, color( palette.cover ), cover );
		const lit = lighting( albedo, normal, point, { skyView: occlusion, wrap: 0.3 } ).mul( occlusion.mul( 0.5 ).add( 0.5 ) );
		const fill = albedo.mul( mix( sky.horizonColor, sky.zenithColor, 0.4 ) ).mul( sky.skyIntensity ).mul( occlusion ).mul( palette.fill );
		return vec4( atmosphere( lit.add( fill ), point ), 1 );

	} )();
	return material;

}

// ===================== 林间小路（落日 → 哥特，阶段 12 CP3 返工）=====================
// 路面：一条踩出来的土路（buildCreekRibbon 的带子，贴地 4 厘米），中间是压实的土和车辙一样的两道浅色，边上被草和落叶吃进去、毛的；
// 路两边：歪向路的树（远景的树林去种，见 extraTrees）、苔石（rock_moss_set_01）；林子本身由树林布点在路两边 boostRadius 米里加密
// lanterns：[Vector3]（灯的位置）、sky（世界天空，windowLights 入夜才亮）；路面上灯下一圈暖光（半径约 4 米）
function createTrailMaterial( name, { lighting, atmosphere, lanterns = [], sky = null } ) {

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = name;
	material.fog = false;
	material.lights = false;
	material.transparent = true;
	material.depthWrite = false;
	material.colorNode = Fn( () => {

		const point = positionWorld;
		const flow = attribute( 'creekFlow', 'vec3' );
		const across = abs( flow.y );
		// 土：两级噪声的深浅（0.6 米、0.2 米），踩得多的两道（离中线 0.45 倍半宽）亮一点、实一点
		const soil = valueNoise3D( vec3( point.x.mul( 1.7 ), point.z.mul( 1.7 ), 0.3 ) ).mul( 0.6 ).add( valueNoise3D( vec3( point.x.mul( 5.2 ), point.z.mul( 5.2 ), 2.1 ) ).mul( 0.4 ) );
		const worn = float( 1 ).sub( smoothstep( 0.1, 0.32, abs( across.sub( 0.45 ) ) ) );
		// 踩实的土比林地浅一档（夜里路是一条淡的带子；原来比两边还暗，两盏灯之间像一个个黑洞，2026-10-02 用户："灯光和杆没弄好"）
		const dirt = mix( color( '#6a5946' ), color( '#9a866e' ), smoothstep( 0.3, 0.75, soil ).mul( 0.7 ).add( worn.mul( 0.3 ) ) );
		// 落叶：一片片深棕、赭黄的斑（0.15 米一格），路中间少、边上多
		const leafNoise = valueNoise3D( vec3( point.x.mul( 7.5 ), point.z.mul( 7.5 ), 5.5 ) );
		const leaves = smoothstep( 0.62, 0.7, leafNoise ).mul( smoothstep( 0.2, 0.8, across ).mul( 0.7 ).add( 0.3 ) );
		const leafColor = mix( color( '#5a3a1e' ), color( '#9a7a3a' ), valueNoise3D( vec3( point.x.mul( 3.1 ), point.z.mul( 3.1 ), 8.8 ) ) );
		const albedo = mix( dirt, leafColor, leaves.mul( 0.5 ) );
		const lit = lighting( albedo, vec3( 0, 1, 0 ), point, { skyView: float( 0.7 ), wrap: 0.3 } ).toVar();
		if ( lanterns.length && sky ) {

			// 灯下的暖光：每个顶点离各盏灯的高斯和在 JS 里算好放进 lanternWarm 属性（buildTrailDressing）。
			// 原来在片元里用 uniformArray 循环，数组的缓冲名每次建都不一样，每进一个地点就多编一份着色器（程序数每轮 +2）
			const warm = attribute( 'lanternWarm', 'float' );
			// 2026-10-02 起地上另有一层光池（路面、路边一起亮），这里只留一点，不然路面整条是橙的
			lit.addAssign( albedo.mul( color( '#ffb066' ) ).mul( warm.mul( 0.15 ) ).mul( sky.windowLights ) );

		}

		// 边：草和落叶吃进来，按噪声咬碎（不是一条直边）
		const ragged = valueNoise3D( vec3( point.x.mul( 1.3 ), point.z.mul( 1.3 ), 4.4 ) ).sub( 0.5 ).mul( 0.5 ).add( valueNoise3D( vec3( point.x.mul( 4.7 ), point.z.mul( 4.7 ), 6.1 ) ).sub( 0.5 ).mul( 0.25 ) );
		const edge = float( 1 ).sub( smoothstep( 0.55, 0.95, across.add( ragged ) ) );
		return vec4( atmosphere( lit, point ), edge.mul( flow.z ).mul( 0.92 ) );

	} )();
	return material;

}

// 路边的灯（2026-10-02 审查 R3：落日 → 哥特这一段是 20:30，月亮刚出山，林子里一片黑）。
// 2026-10-02 用户："灯光和杆没弄好"——原来是一根细黑棍顶着一团大光球，路面整条被染成橙色。现在：
//   灯：路边的弯头木杆（杆顶朝路伸出一截横臂），臂端用一小段链子挂一盏铁框玻璃灯（底板、四面玻璃、四角铁框、四棱锥顶、顶上一个小钮）；
//       玻璃按 UV 画出铁框和窗格，里面透出暖光（HDR），铁框、木杆按世界光照画（夜里只是暗的剪影）；
//   光晕：灯芯处一个小的朝镜头光斑（交给泛光出柔光），比原来小一半多、收得紧；
//   地上的光池：每盏灯下一块贴着地形的圆片，加法混合一圈暖光（路面、路边的地一起亮，不再只有路面一条橙带）。
// 两边交替每 spacing 米一盏，入夜才亮（世界的 windowLights），轻轻跳动
function buildTrailLanterns( frame, line, groundAt, random, sky ) {

	const settings = frame.lanterns;
	const height = settings.height;
	const lanterns = [];   // 灯芯的位置（光晕、光池按它）
	const parts = [];      // 杆、臂、链、灯的几何体（合成一个）
	let side = 1;
	for ( let along = settings.spacing * 0.5; along < line.length; along += settings.spacing * ( 0.85 + random() * 0.3 ) ) {

		const sample = pointAlongLine( line, along );
		const offset = frame.trailHalfWidth + 0.75;
		const x = sample.x + sample.sideX * offset * side;
		const z = sample.z + sample.sideZ * offset * side;
		const ground = groundAt( x, z );
		// 横臂朝路那边伸出去
		const toPathX = - sample.sideX * side;
		const toPathZ = - sample.sideZ * side;
		const yaw = Math.atan2( toPathX, toPathZ );
		const lean = ( random() - 0.5 ) * 0.05;
		const pieces = [];
		const add = ( geometry, glow, x0, y0, z0 ) => {

			geometry.translate( x0, y0, z0 );
			const count = geometry.attributes.position.count;
			geometry.setAttribute( 'lanternGlow', new THREE.BufferAttribute( new Float32Array( count ).fill( glow ), 1 ) );
			pieces.push( geometry );

		};
		// 杆：方木 0.1 米，底下埋 0.3 米
		add( new THREE.BoxGeometry( 0.1, height + 0.3, 0.1 ), 0, 0, ( height + 0.3 ) / 2 - 0.3, 0 );
		// 横臂和斜撑
		add( new THREE.BoxGeometry( 0.07, 0.07, settings.arm + 0.05 ), 0, 0, height - 0.04, settings.arm / 2 );
		const brace = new THREE.BoxGeometry( 0.045, 0.045, 0.34 );
		brace.rotateX( Math.PI / 4 );
		add( brace, 0, 0, height - 0.16, 0.12 );
		// 链子（细的一根）
		add( new THREE.BoxGeometry( 0.02, 0.1, 0.02 ), 0, 0, height - 0.12, settings.arm - 0.02 );
		// 灯：底板、玻璃身（lanternGlow = 1，UV 画铁框）、四棱锥顶、顶钮
		const body = settings.lamp;
		const bodyCenter = height - 0.17 - body[ 1 ] / 2 - 0.03;
		add( new THREE.BoxGeometry( body[ 0 ] + 0.05, 0.03, body[ 0 ] + 0.05 ), 0, 0, bodyCenter - body[ 1 ] / 2 - 0.015, settings.arm - 0.02 );
		add( new THREE.BoxGeometry( body[ 0 ], body[ 1 ], body[ 0 ] ), 1, 0, bodyCenter, settings.arm - 0.02 );
		const roof = new THREE.ConeGeometry( body[ 0 ] * 0.85, 0.12, 4, 1 );
		roof.rotateY( Math.PI / 4 );
		add( roof, 0, 0, bodyCenter + body[ 1 ] / 2 + 0.06, settings.arm - 0.02 );
		add( new THREE.SphereGeometry( 0.025, 6, 4 ), 0, 0, bodyCenter + body[ 1 ] / 2 + 0.14, settings.arm - 0.02 );
		// 整盏转到朝路、稍微歪一点，放到地上
		const matrix = new THREE.Matrix4().makeRotationY( yaw ).multiply( new THREE.Matrix4().makeRotationX( lean ) ).setPosition( x, ground, z );
		for ( const piece of pieces ) {

			if ( piece.getAttribute( 'uv' ) === undefined ) piece.setAttribute( 'uv', new THREE.BufferAttribute( new Float32Array( piece.attributes.position.count * 2 ), 2 ) );
			piece.applyMatrix4( matrix );
			parts.push( piece );

		}

		const wick = new THREE.Vector3( 0, bodyCenter, settings.arm - 0.02 ).applyMatrix4( matrix );
		lanterns.push( wick );
		side = - side;

	}

	const lampGeometry = mergeGeometries( parts.map( ( part ) => part.index ? part.toNonIndexed() : part ) );
	for ( const part of parts ) part.dispose();

	// ---------- 灯的材质：铁框、木杆按世界光照；玻璃透出暖光、按 UV 画窗格 ----------
	const lampMaterial = new THREE.MeshBasicNodeMaterial();
	lampMaterial.name = `窄处·${ frame.name }·路灯`;
	lampMaterial.fog = false;
	lampMaterial.lights = false;

	// ---------- 光晕 ----------
	const haloPositions = [];
	const haloData = [];
	const haloIndices = [];
	lanterns.forEach( ( point, index ) => {

		for ( const [ u, v ] of [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ] ) {

			haloPositions.push( point.x, point.y, point.z );
			haloData.push( u, v, random(), 0 );

		}

		haloIndices.push( index * 4, index * 4 + 1, index * 4 + 2, index * 4, index * 4 + 2, index * 4 + 3 );

	} );
	const haloGeometry = new THREE.BufferGeometry();
	haloGeometry.setAttribute( 'position', new THREE.Float32BufferAttribute( haloPositions, 3 ) );
	haloGeometry.setAttribute( 'lanternData', new THREE.Float32BufferAttribute( haloData, 4 ) );
	haloGeometry.setIndex( haloIndices );
	haloGeometry.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e5 );
	const haloMaterial = new THREE.MeshBasicNodeMaterial();
	haloMaterial.name = `窄处·${ frame.name }·灯晕`;
	haloMaterial.transparent = true;
	haloMaterial.depthWrite = false;
	haloMaterial.blending = THREE.AdditiveBlending;
	haloMaterial.fog = false;
	haloMaterial.lights = false;
	const lanternData = attribute( 'lanternData', 'vec4' );
	// 往镜头挪 0.3 米（不被灯自己的玻璃挡住）；屏幕上至少 2 个像素，近处 0.55 米见方
	const viewCenter = cameraViewMatrix.mul( vec4( positionGeometry, 1 ) ).xyz;
	const pulled = viewCenter.mul( max( length( viewCenter ).sub( 0.3 ), 0.05 ).div( max( length( viewCenter ), 1e-3 ) ) );
	const pixelAngle = float( 2 ).div( cameraProjectionMatrix[ 1 ][ 1 ].mul( 900 ) );
	const haloSize = max( float( 0.55 ), pixelAngle.mul( length( viewCenter ) ).mul( 2 ) );
	haloMaterial.vertexNode = cameraProjectionMatrix.mul( vec4( pulled.add( vec3( lanternData.xy.sub( 0.5 ).mul( haloSize ), 0 ) ), 1 ) );
	const flickerOf = ( seed ) => sin( time.mul( seed.mul( 4 ).add( 6 ) ).add( seed.mul( 30 ) ) ).mul( 0.06 ).add( 0.94 );
	haloMaterial.colorNode = Fn( () => {

		const centered = lanternData.xy.sub( 0.5 ).mul( 2 );
		const glow = exp( dot( centered, centered ).mul( - 9 ) );
		return vec4( color( settings.color ).mul( glow.mul( flickerOf( lanternData.z ) ).mul( settings.haloIntensity ) ).mul( sky.windowLights ), 1 );

	} )();
	const halos = new THREE.Mesh( haloGeometry, haloMaterial );
	halos.name = haloMaterial.name;
	halos.frustumCulled = false;
	halos.renderOrder = 6;

	// ---------- 地上的光池：每盏灯一块贴地的圆片（9 × 9 个点，半径 poolRadius 米），加法混合 ----------
	const poolPositions = [];
	const poolData = [];
	const poolIndices = [];
	const grid = 9;
	lanterns.forEach( ( wick ) => {

		const first = poolPositions.length / 3;
		for ( let j = 0; j < grid; j ++ ) {

			for ( let i = 0; i < grid; i ++ ) {

				const u = i / ( grid - 1 ) * 2 - 1;
				const v = j / ( grid - 1 ) * 2 - 1;
				const x = wick.x + u * settings.poolRadius;
				const z = wick.z + v * settings.poolRadius;
				poolPositions.push( x, groundAt( x, z ) + 0.09, z );
				// 离灯芯的水平距离（米）、灯芯离地多高
				poolData.push( Math.hypot( x - wick.x, z - wick.z ), wick.y - groundAt( wick.x, wick.z ) );

			}

		}

		for ( let j = 0; j < grid - 1; j ++ ) {

			for ( let i = 0; i < grid - 1; i ++ ) {

				const a = first + j * grid + i;
				poolIndices.push( a, a + grid, a + 1, a + 1, a + grid, a + grid + 1 );

			}

		}

	} );
	const poolGeometry = new THREE.BufferGeometry();
	poolGeometry.setAttribute( 'position', new THREE.Float32BufferAttribute( poolPositions, 3 ) );
	poolGeometry.setAttribute( 'poolData', new THREE.Float32BufferAttribute( poolData, 2 ) );
	poolGeometry.setIndex( poolIndices );
	poolGeometry.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e5 );
	const poolMaterial = new THREE.MeshBasicNodeMaterial();
	poolMaterial.name = `窄处·${ frame.name }·灯下光池`;
	poolMaterial.transparent = true;
	poolMaterial.depthWrite = false;
	poolMaterial.blending = THREE.AdditiveBlending;
	poolMaterial.fog = false;
	poolMaterial.lights = false;
	poolMaterial.polygonOffset = true;
	poolMaterial.polygonOffsetFactor = - 2;
	poolMaterial.polygonOffsetUnits = - 2;
	const poolInfo = attribute( 'poolData', 'vec2' );
	poolMaterial.colorNode = Fn( () => {

		// 点光源照到地上：照度 ∝ 高 / (距离² + 高²)^1.5（斜着照、平方反比），再在半径边上收到 0
		const distance = poolInfo.x;
		const lampHeight = poolInfo.y;
		const irradiance = lampHeight.mul( lampHeight ).div( pow( distance.mul( distance ).add( lampHeight.mul( lampHeight ) ), 1.5 ) ).mul( lampHeight );
		const edge = float( 1 ).sub( smoothstep( settings.poolRadius * 0.55, settings.poolRadius, distance ) );
		// 夜里的地面反照率大约 0.15~0.3：加的暖光按这个量级乘进去
		return vec4( color( settings.color ).mul( irradiance.mul( edge ).mul( settings.poolIntensity ) ).mul( sky.windowLights ), 1 );

	} )();
	const pools = new THREE.Mesh( poolGeometry, poolMaterial );
	pools.name = poolMaterial.name;
	pools.frustumCulled = false;
	pools.renderOrder = 2;

	return { lanterns, lampGeometry, lampMaterial, halos, haloGeometry, haloMaterial, pools, poolGeometry, poolMaterial };

}

let time = null;

async function buildTrailDressing( frame, line, { groundAt, lighting, atmosphere, sky, seed } ) {

	const random = createRandom( seed );
	const meshes = [];
	const disposables = [];
	const extraTrees = [];

	// ---------- 路边的灯笼 ----------
	let lanterns = [];
	if ( frame.lanterns && time ) {

		const built = buildTrailLanterns( frame, line, groundAt, random, sky );
		lanterns = built.lanterns;
		// 灯的材质：木杆、铁框按世界光照（暗的剪影）；玻璃（lanternGlow = 1）按 UV 画铁框和十字窗格，格子里透出暖光
		const glowFlag = attribute( 'lanternGlow', 'float' );
		const lampUv = attribute( 'uv', 'vec2' );
		built.lampMaterial.colorNode = Fn( () => {

			const frameColor = mix( color( '#3b2a1f' ), color( '#26231f' ), glowFlag );
			const lit = atmosphere( lighting( frameColor, normalWorld, positionWorld, { skyView: float( 0.5 ), wrap: 0.3 } ), positionWorld );
			// 窗格：边上 12% 是铁框，中间一道十字
			const edge = max( abs( lampUv.x.sub( 0.5 ) ), abs( lampUv.y.sub( 0.5 ) ) );
			const cross = min( abs( lampUv.x.sub( 0.5 ) ), abs( lampUv.y.sub( 0.5 ) ) );
			const pane = float( 1 ).sub( smoothstep( 0.36, 0.4, edge ) ).mul( smoothstep( 0.025, 0.045, cross ) );
			const warm = color( frame.lanterns.color ).mul( frame.lanterns.glassIntensity ).mul( sky.windowLights ).mul( pane ).mul( glowFlag );
			return vec4( lit.add( warm ), 1 );

		} )();
		const lamps = new THREE.Mesh( built.lampGeometry, built.lampMaterial );
		lamps.name = built.lampMaterial.name;
		lamps.frustumCulled = false;
		meshes.push( lamps, built.pools, built.halos );
		disposables.push( built.lampGeometry, built.lampMaterial, built.haloGeometry, built.haloMaterial, built.poolGeometry, built.poolMaterial );

	}

	// ---------- 路面 ----------
	// 中线每 3 米一个点再加密成 1 米（灯下的暖光按顶点插值，3 米一格会是一块块菱形）
	const points = [];
	line.samples.forEach( ( sample, index ) => {

		points.push( { x: sample.x, z: sample.z } );
		const next = line.samples[ index + 1 ];
		if ( next ) for ( const fraction of [ 1 / 3, 2 / 3 ] ) points.push( { x: sample.x + ( next.x - sample.x ) * fraction, z: sample.z + ( next.z - sample.z ) * fraction } );

	} );
	const ribbon = buildCreekRibbon( points, groundAt, { halfWidth: frame.trailHalfWidth, fadeIn: 8, fadeOut: 10, lift: 0.04, startAlong: line.samples[ 0 ].along } );
	// 灯下一圈暖光（半径约 4 米的高斯，几盏叠起来最多 1.5）
	{

		const position = ribbon.attributes.position;
		const warmth = new Float32Array( position.count );
		for ( let v = 0; v < position.count; v ++ ) {

			let sum = 0;
			for ( const lantern of lanterns ) {

				const dx = position.getX( v ) - lantern.x;
				const dz = position.getZ( v ) - lantern.z;
				sum += Math.exp( - ( dx * dx + dz * dz ) / 9 );

			}

			warmth[ v ] = Math.min( 1.5, sum );

		}

		ribbon.setAttribute( 'lanternWarm', new THREE.BufferAttribute( warmth, 1 ) );

	}
	const trailMaterial = createTrailMaterial( `窄处·${ frame.name }·路面`, { lighting, atmosphere, lanterns, sky } );
	const trail = new THREE.Mesh( ribbon, trailMaterial );
	trail.name = `窄处·${ frame.name }·路面`;
	trail.frustumCulled = false;
	trail.renderOrder = 1;
	meshes.push( trail );
	disposables.push( ribbon, trailMaterial );

	// ---------- 路边歪向路的树：两边各一排，离中线 offset 米，每隔 spacing 米一棵，往路上歪 lean 度（树冠在头顶合拢）----------
	const edge = frame.edgeTrees;
	for ( const side of [ - 1, 1 ] ) {

		for ( let along = - 6; along <= line.length + 6; along += edge.spacing[ 0 ] + random() * ( edge.spacing[ 1 ] - edge.spacing[ 0 ] ) ) {

			const sample = pointAlongLine( line, along );
			const offset = edge.offset[ 0 ] + random() * ( edge.offset[ 1 ] - edge.offset[ 0 ] );
			const x = sample.x + sample.sideX * offset * side;
			const z = sample.z + sample.sideZ * offset * side;
			// 往路这边歪：歪的方向是从树指向路的水平方向（方位角，从北顺时针，和 extraTrees 的约定一样）
			const towardX = - sample.sideX * side;
			const towardZ = - sample.sideZ * side;
			const leanAngle = Math.atan2( towardX, - towardZ ) * 180 / Math.PI;
			extraTrees.push( {
				x, z,
				size: edge.size[ 0 ] + random() * ( edge.size[ 1 ] - edge.size[ 0 ] ),
				leanAngle,
				leanDegrees: edge.lean[ 0 ] + random() * ( edge.lean[ 1 ] - edge.lean[ 0 ] ),
				species: random() < 0.2 ? 'pine' : 'broadleaf',
			} );

		}

	}

	// ---------- 路边的苔石 ----------
	const spots = [];
	for ( let k = 0; k < frame.edgeRocks; k ++ ) {

		const along = random() * line.length;
		const sample = pointAlongLine( line, along );
		const side = random() < 0.5 ? - 1 : 1;
		const offset = frame.trailHalfWidth + 0.6 + random() * 2.2;
		spots.push( { x: sample.x + sample.sideX * offset * side, z: sample.z + sample.sideZ * offset * side, scale: 0.35 + random() * 0.55, bury: 0.3 + random() * 0.15, tilt: 0.4 } );

	}

	const rocks = await placeMossRocks( spots, groundAt, `窄处·${ frame.name }·苔石`, cleftRockPalette, { lighting, atmosphere, sky, random } );
	meshes.push( ...rocks.meshes );
	disposables.push( ...rocks.disposables );
	return { meshes, disposables, extraTrees };

}

// ===================== 冰碛岗鞍部（哥特 → 星月夜，阶段 12 CP3 返工）=====================
// 岗是地形；这里沿岗撒冰川带下来的乱石（大大小小，半埋，鞍部两边多一些），岗上的松由树林布点加密种
async function buildMoraineDressing( frame, moraines, { groundAt, lighting, atmosphere, sky, seed } ) {

	const random = createRandom( seed );
	const spots = [];
	for ( const moraine of moraines ) {

		const points = moraine.points;
		const lengths = [ 0 ];
		for ( let i = 1; i < points.length; i ++ ) lengths.push( lengths[ i - 1 ] + Math.hypot( points[ i ][ 0 ] - points[ i - 1 ][ 0 ], points[ i ][ 1 ] - points[ i - 1 ][ 1 ] ) );
		const total = lengths[ lengths.length - 1 ];
		for ( let k = 0; k < frame.boulders; k ++ ) {

			// 沿岗：鞍部附近（离鞍部 60 米内）放一半
			const nearSaddle = random() < 0.5 && moraine.saddle;
			let along = random() * total;
			if ( nearSaddle ) {

				let best = 0;
				let bestDistance = Infinity;
				for ( let s = 0; s <= total; s += 2 ) {

					const point = pointOnPolyline( points, lengths, s );
					const distance = Math.hypot( point.x - moraine.saddle.point[ 0 ], point.z - moraine.saddle.point[ 1 ] );
					if ( distance < bestDistance ) {

						bestDistance = distance;
						best = s;

					}

				}

				along = best + ( random() - 0.5 ) * 120;

			}

			along = Math.min( total * 0.92, Math.max( total * 0.08, along ) );
			const point = pointOnPolyline( points, lengths, along );
			const lateral = ( random() * 2 - 1 ) * moraine.width * 0.85;
			const x = point.x + point.sideX * lateral;
			const z = point.z + point.sideZ * lateral;
			// 鞍底飞过的那一条不放大石头
			if ( Math.hypot( x - moraine.saddle.point[ 0 ], z - moraine.saddle.point[ 1 ] ) < frame.clearHalfWidth ) continue;
			const big = random() < 0.2;
			spots.push( { x, z, scale: big ? 1.6 + random() * 1.4 : 0.5 + random() * 0.8, bury: 0.25 + random() * 0.2, tilt: 0.6 } );

		}

	}

	return placeMossRocks( spots, groundAt, `窄处·${ frame.name }·乱石`, moraineRockPalette, { lighting, atmosphere, sky, random } );

}

// 折线上离起点 along 米的点和往右的方向（points 是 [x, z]）
function pointOnPolyline( points, lengths, along ) {

	let i = 1;
	while ( i < points.length - 1 && lengths[ i ] < along ) i ++;
	const [ ax, az ] = points[ i - 1 ];
	const [ bx, bz ] = points[ i ];
	const span = Math.max( 1e-6, lengths[ i ] - lengths[ i - 1 ] );
	const t = Math.min( 1, Math.max( 0, ( along - lengths[ i - 1 ] ) / span ) );
	return { x: ax + ( bx - ax ) * t, z: az + ( bz - az ) * t, sideX: - ( bz - az ) / span, sideZ: ( bx - ax ) / span };

}

// 冰碛岗的乱石：冷灰、带一点褐，朝天的面长苔（夜里看是灰蓝的一块块）
const moraineRockPalette = { dark: '#3a3b3e', light: '#7d7b77', keepHue: 0.1, moss: '#56663e', mossFrom: 0.5, mossTo: 0.8, fill: 0.5 };

// ===================== 融水冰槽（星月夜 → 雪原，阶段 12 CP3 返工）=====================
// 槽是地形（terrainShape.notches 里 ice 的那条，远景和雪原的地形在槽壁上画冰）。这里：
//   槽沿：两边的雪檐（一串压扁的雪团连成一道往槽里探出去的檐）、檐下挂冰凌（细长的锥，长短不一，聚成一簇簇）；
//   槽底：几块冻住的冰块、一道冻住一半的融水
function createIceMaterial( name, { lighting, atmosphere, sky } ) {

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = name;
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const point = positionWorld;
		const normal = normalWorld.normalize();
		const toViewer = cameraPosition.sub( point ).normalize();
		// 冰：里面偏青蓝、边缘（掠射）发白；竖着的融水纹
		const streak = valueNoise3D( vec3( point.x.mul( 3 ), point.y.mul( 0.4 ), point.z.mul( 3 ) ) );
		const facing = max( dot( normal, toViewer ), 0 );
		const albedo = mix( color( '#6f9fcf' ), color( '#d6e8f8' ), pow( float( 1 ).sub( facing ), 2 ).mul( 0.7 ).add( streak.mul( 0.3 ) ) );
		const lit = lighting( albedo, normal, point, { skyView: float( 0.8 ), wrap: 0.5 } );
		// 冰里透出来的一点天光（夜里也不是死黑）
		const fill = albedo.mul( mix( sky.horizonColor, sky.zenithColor, 0.5 ) ).mul( sky.skyIntensity ).mul( 0.9 );
		const rim = sky.moonLightColor.mul( pow( float( 1 ).sub( facing ), 4 ) ).mul( 0.6 );
		return vec4( atmosphere( lit.add( fill ).add( rim ), point ), 1 );

	} )();
	return material;

}

function buildTroughDressing( frame, notch, { groundAt, lighting, atmosphere, sky, time, toWorldDirection, seed } ) {

	const random = createRandom( seed );
	const meshes = [];
	const disposables = [];
	const line = resampleLine( notch.points, 1.5, 0 );
	const iceMaterial = createIceMaterial( `窄处·${ frame.name }·冰`, { lighting, atmosphere, sky } );
	disposables.push( iceMaterial );

	// 槽沿：从中线往外找地面不再升高的地方（离底 halfBottom 米起，每 0.5 米看一次，升得比 0.15 米 / 0.5 米慢了就是沿）
	const rims = [];
	for ( const sample of line.samples ) {

		const floor = groundAt( sample.x, sample.z );
		for ( const side of [ - 1, 1 ] ) {

			let offset = notch.halfBottom;
			let previous = floor;
			let found = null;
			for ( ; offset < notch.halfBottom + 18; offset += 0.5 ) {

				const height = groundAt( sample.x + sample.sideX * offset * side, sample.z + sample.sideZ * offset * side );
				if ( height - floor > 2.2 && height - previous < 0.15 ) {

					found = { x: sample.x + sample.sideX * offset * side, y: height, z: sample.z + sample.sideZ * offset * side, depth: height - floor, sideX: sample.sideX * side, sideZ: sample.sideZ * side, along: sample.along };
					break;

				}

				previous = height;

			}

			if ( found ) rims.push( found );

		}

	}

	// ---------- 雪檐：沿上零星的几堆（三成的沿点），又长又扁、往槽里探一点；原来每个沿点一团，连成一串像香肠（2026-10-02 自查）。
	// frame.cornice = 0 就不堆（审查 R8：从雪原出生点看过去，扁平的雪团一片片浮在槽沿上像栈桥的木板）----------
	const corniceParts = [];
	for ( const rim of rims ) {

		if ( ! ( frame.cornice > 0 ) || random() > 0.3 ) continue;
		const blob = new THREE.IcosahedronGeometry( 1, 2 );
		blob.deleteAttribute( 'uv' );
		const reach = frame.cornice * ( 0.2 + random() * 0.4 );
		blob.scale( frame.cornice * ( 2 + random() * 1.5 ), frame.cornice * ( 0.22 + random() * 0.12 ), frame.cornice * ( 0.7 + random() * 0.4 ) );
		blob.rotateY( Math.atan2( rim.sideX, rim.sideZ ) );
		blob.translate( rim.x - rim.sideX * reach, rim.y - 0.15, rim.z - rim.sideZ * reach );
		corniceParts.push( blob );

	}

	if ( corniceParts.length ) {

		const geometry = mergeVertices( mergeGeometries( corniceParts ) );
		for ( const part of corniceParts ) part.dispose();
		geometry.computeVertexNormals();
		geometry.setAttribute( 'occlusion', new THREE.BufferAttribute( new Float32Array( geometry.attributes.position.count ).fill( 0.95 ), 1 ) );
		const snowMaterial = createRockMaterial( `窄处·${ frame.name }·雪檐`, { dark: '#c9d6ee', light: '#eef3fb', cover: '#f2f6fc', coverFrom: - 1, coverTo: 0, bump: 0.15, fill: 0.7 }, lighting, atmosphere, sky );
		const mesh = new THREE.Mesh( geometry, snowMaterial );
		mesh.name = `窄处·${ frame.name }·雪檐`;
		mesh.frustumCulled = false;
		meshes.push( mesh );
		disposables.push( geometry, snowMaterial );

	}

	// ---------- 冰凌：檐下一簇簇往下挂的细锥 ----------
	const icicle = new THREE.ConeGeometry( 1, 1, 6, 1 );
	icicle.rotateX( Math.PI );
	icicle.translate( 0, - 0.5, 0 );
	const matrices = [];
	const dummy = new THREE.Object3D();
	for ( let k = 0; k < frame.icicles && rims.length; k ++ ) {

		const rim = rims[ Math.floor( random() * rims.length ) ];
		const clusterCount = 1 + Math.floor( random() * 4 );
		for ( let c = 0; c < clusterCount; c ++ ) {

			const length = frame.icicleLength[ 0 ] + Math.pow( random(), 1.6 ) * ( frame.icicleLength[ 1 ] - frame.icicleLength[ 0 ] );
			const radius = 0.05 + length * 0.05 + random() * 0.04;
			const tangentX = rim.sideZ;
			const tangentZ = - rim.sideX;
			const slide = ( random() - 0.5 ) * 1.4;
			const inset = 0.2 + random() * 0.5;
			dummy.position.set( rim.x - rim.sideX * inset + tangentX * slide, rim.y - 0.25, rim.z - rim.sideZ * inset + tangentZ * slide );
			dummy.rotation.set( ( random() - 0.5 ) * 0.12, random() * Math.PI, ( random() - 0.5 ) * 0.12 );
			dummy.scale.set( radius, Math.min( length, rim.depth * 0.6 ), radius );
			dummy.updateMatrix();
			matrices.push( dummy.matrix.clone() );

		}

	}

	if ( matrices.length ) {

		const mesh = createInstances( icicle, iceMaterial, matrices );
		mesh.name = `窄处·${ frame.name }·冰凌`;
		mesh.frustumCulled = false;
		meshes.push( mesh );

	}

	disposables.push( icicle );

	// ---------- 槽底的冰块：棱角分明的块（二十面体不细分，压扁、拉长），半埋 ----------
	const blockParts = [];
	for ( let k = 0; k < frame.iceBlocks; k ++ ) {

		const sample = pointAlongLine( line, random() * line.length );
		const side = random() < 0.5 ? - 1 : 1;
		const offset = 0.8 + random() * ( notch.halfBottom - 0.6 );
		const x = sample.x + sample.sideX * offset * side;
		const z = sample.z + sample.sideZ * offset * side;
		const size = 0.4 + random() * 1.1;
		// 冻住的碎冰块：细分一级、每个顶点往里外推一点（审查 R9：原来是不细分的二十面体，像一颗颗宝石），再压扁拉长
		const block = mergeVertices( ( () => {

			const shape = new THREE.IcosahedronGeometry( 1, 1 );
			shape.deleteAttribute( 'uv' );
			shape.deleteAttribute( 'normal' );
			return shape;

		} )() );
		const corners = block.attributes.position;
		for ( let v = 0; v < corners.count; v ++ ) {

			const push = 0.8 + random() * 0.35;
			corners.setXYZ( v, corners.getX( v ) * push, corners.getY( v ) * push, corners.getZ( v ) * push );

		}

		block.scale( size * ( 0.8 + random() * 0.6 ), size * ( 0.45 + random() * 0.35 ), size * ( 0.8 + random() * 0.6 ) );
		block.rotateY( random() * Math.PI );
		block.rotateX( ( random() - 0.5 ) * 0.5 );
		block.translate( x, groundAt( x, z ) + size * 0.15, z );
		blockParts.push( block );

	}

	if ( blockParts.length ) {

		const geometry = mergeGeometries( blockParts );
		for ( const part of blockParts ) part.dispose();
		geometry.computeVertexNormals();
		const mesh = new THREE.Mesh( geometry, iceMaterial );
		mesh.name = `窄处·${ frame.name }·冰块`;
		mesh.frustumCulled = false;
		meshes.push( mesh );
		disposables.push( geometry );

	}

	// ---------- 融水：槽底一道（冻住一半，水流细、慢）----------
	const water = buildCreekRibbon( line.samples.map( ( sample ) => ( { x: sample.x, z: sample.z } ) ), groundAt, { halfWidth: frame.creekHalfWidth, fadeIn: 6, fadeOut: 4, lift: 0.06 } );
	const waterMaterial = createCreekMaterial( `窄处·${ frame.name }·融水`, { lighting, atmosphere, sky, time, toWorldDirection } );
	const waterMesh = new THREE.Mesh( water, waterMaterial );
	waterMesh.name = `窄处·${ frame.name }·融水`;
	waterMesh.frustumCulled = false;
	meshes.push( waterMesh );
	disposables.push( water, waterMaterial );
	return { meshes, disposables };

}

// ===================== 岩丘裂隙（花园 → 落日，阶段 12 CP3 返工）=====================
// 原来是平草地上立着两堵噪声墙（用户："为了刻意而弄出来的"），后来换成岩石扫描贴壁，被夕照染成一团团粉色的海绵（用户："沙滩这个窄道合理性你没有修"）。
// 现在裂隙整个是地形：config.world.terrainShape.knolls / notches 是一座海边长条岩丘被溪水切开的口子，壁上一级级岩坎，
// 远景在这里铺一块 0.6 米一格的地形补丁（backdrop.js 的 buildTerrainPatch）画出陡壁；这里只摆壁脚塌下来的石头、溪边的卵石、
// 泉眼边的几块苔石和一条小溪。丘顶的松由远景的树林按 frame.pines 种

// 模型（loadModel 的结果）里所有网格合成一份几何体：属性先转成 32 位浮点再乘子网格的变换（量化的属性直接变换会被截断成方块），
// 只留位置、法线、uv；返回 { geometry, map }（map 是第一张漫反射贴图）
export function flattenModel( object ) {

	const parts = [];
	let map = null;
	object.updateMatrixWorld( true );
	object.traverse( ( child ) => {

		if ( ! child.isMesh ) return;
		const source = child.geometry;
		const geometry = new THREE.BufferGeometry();
		for ( const name of [ 'position', 'normal', 'uv' ] ) {

			const attribute = source.getAttribute( name );
			if ( ! attribute ) continue;
			const values = new Float32Array( attribute.count * attribute.itemSize );
			for ( let i = 0; i < attribute.count; i ++ ) for ( let k = 0; k < attribute.itemSize; k ++ ) values[ i * attribute.itemSize + k ] = attribute.getComponent( i, k );
			geometry.setAttribute( name, new THREE.BufferAttribute( values, attribute.itemSize ) );

		}

		if ( source.index ) geometry.setIndex( Array.from( source.index.array ) );
		geometry.applyMatrix4( child.matrixWorld );
		if ( ! geometry.getAttribute( 'normal' ) ) geometry.computeVertexNormals();
		if ( ! geometry.getAttribute( 'uv' ) ) geometry.setAttribute( 'uv', new THREE.BufferAttribute( new Float32Array( geometry.getAttribute( 'position' ).count * 2 ), 2 ) );
		parts.push( geometry );
		if ( ! map && child.material && child.material.map ) map = child.material.map;

	} );
	if ( parts.length === 0 ) return null;
	const geometry = parts.length === 1 ? parts[ 0 ] : mergeGeometries( parts );
	if ( parts.length > 1 ) for ( const part of parts ) part.dispose();
	geometry.computeBoundingBox();
	return { geometry, map };

}

// 岩石扫描的材质（绘本化）：照片贴图只取明暗，颜色按调色板（冷灰的岩、一点暖），保留一点原来的色相；
// 朝天的面长一层苔绿，走远景同一套光照和大气，再加一点天光补光（缝里不会死黑）
function createScanMaterial( name, map, palette, lighting, atmosphere, sky ) {

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = name;
	material.fog = false;
	material.lights = false;
	material.colorNode = Fn( () => {

		const point = positionWorld;
		const normal = normalWorld.normalize();
		const sample = map ? texture( map ).rgb : vec3( 0.5 );
		const brightness = dot( sample, vec3( 0.2126, 0.7152, 0.0722 ) ).mul( 2.2 ).clamp( 0.15, 1.6 );
		const blotch = valueNoise3D( point.mul( 0.13 ) ).mul( 0.6 ).add( valueNoise3D( point.mul( 0.51 ) ).mul( 0.4 ) );
		const rock = mix( color( palette.dark ), color( palette.light ), blotch ).mul( brightness );
		const tinted = mix( rock, sample.mul( 1.6 ), palette.keepHue );
		const moss = smoothstep( palette.mossFrom, palette.mossTo, normal.y.add( blotch.sub( 0.5 ).mul( 0.35 ) ) );
		const albedo = mix( tinted, color( palette.moss ).mul( brightness.mul( 0.4 ).add( 0.6 ) ), moss );
		const lit = lighting( albedo, normal, point, { skyView: float( 0.75 ), wrap: 0.3 } );
		const fill = albedo.mul( mix( sky.horizonColor, sky.zenithColor, 0.4 ) ).mul( sky.skyIntensity ).mul( palette.fill );
		return vec4( atmosphere( lit.add( fill ), point ), 1 );

	} )();
	return material;

}

// 小溪的水带：points 是顺流的中线 [{ x, z }]（场景坐标），按 1.2 米重采样，两边各一个顶点贴着 groundAt 抬 lift 米。
// 属性 creekFlow = (沿流的米数, 横向 −1~1, 淡入淡出 0~1)：开头 fadeIn 米、结尾 fadeOut 米淡掉；halfWidth 按噪声 ±15% 宽窄
export function buildCreekRibbon( points, groundAt, { halfWidth, fadeIn = 3, fadeOut = 4, lift = 0.1, startAlong = 0 } ) {

	const samples = [];
	let along = startAlong;
	for ( let i = 0; i < points.length - 1; i ++ ) {

		const from = points[ i ];
		const to = points[ i + 1 ];
		const length = Math.hypot( to.x - from.x, to.z - from.z );
		const steps = Math.max( 1, Math.ceil( length / 1.2 ) );
		for ( let k = 0; k < steps; k ++ ) {

			const t = k / steps;
			samples.push( { x: from.x + ( to.x - from.x ) * t, z: from.z + ( to.z - from.z ) * t, along: along + length * t } );

		}

		along += length;

	}

	const last = points[ points.length - 1 ];
	samples.push( { x: last.x, z: last.z, along } );
	const total = along;
	const positions = [];
	const flow = [];
	const indices = [];
	for ( let k = 0; k < samples.length; k ++ ) {

		const sample = samples[ k ];
		const previous = samples[ Math.max( 0, k - 1 ) ];
		const next = samples[ Math.min( samples.length - 1, k + 1 ) ];
		const directionLength = Math.hypot( next.x - previous.x, next.z - previous.z ) || 1;
		const sideX = - ( next.z - previous.z ) / directionLength;
		const sideZ = ( next.x - previous.x ) / directionLength;
		const fade = smoothJs( startAlong, startAlong + fadeIn, sample.along ) * ( 1 - smoothJs( total - fadeOut, total, sample.along ) );
		const width = halfWidth * ( 0.85 + 0.3 * jsFbm2D( sample.along / 9, 3.1, 2 ) );
		for ( const side of [ - 1, 1 ] ) {

			const x = sample.x + sideX * width * side;
			const z = sample.z + sideZ * width * side;
			// 两边各取自己脚下的地面，再和中线的取低的：水面是平的，不会顺着岸坡翘起来
			const ground = Math.min( groundAt( x, z ), groundAt( sample.x, sample.z ) + 0.05 );
			positions.push( x, ground + lift, z );
			flow.push( sample.along, side, fade );

		}

		if ( k > 0 ) {

			const p = ( k - 1 ) * 2;
			const c = k * 2;
			indices.push( p, p + 1, c + 1, p, c + 1, c );

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'creekFlow', new THREE.Float32BufferAttribute( flow, 3 ) );
	geometry.setIndex( indices );
	geometry.computeBoundingSphere();
	return geometry;

}

// 小溪的水：浅，看得见底下的卵石；水面有顺流而下的细波，掠射时反出统一天空（菲涅耳），对着太阳的地方一粒粒闪；
// 中间深一点偏青，边上浅、半透明。lighting / atmosphere / sky 同远景；time 是秒的 uniform；
// toWorldDirection：场景方向 → 世界方向（天空、太阳都在世界坐标里）
export function createCreekMaterial( name, { lighting, atmosphere, sky, time, toWorldDirection } ) {

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = name;
	material.fog = false;
	material.lights = false;
	material.side = THREE.DoubleSide;
	material.transparent = true;
	material.depthWrite = false;
	material.colorNode = Fn( () => {

		const point = positionWorld;
		const flow = attribute( 'creekFlow', 'vec3' );
		const toViewer = cameraPosition.sub( point ).normalize();

		// 细波：两层值噪声（0.4 米、0.17 米一格），随时间翻动；差分当斜率（溪水是活的，不是一面镜子）
		const coarse = vec3( point.x.mul( 2.5 ), point.z.mul( 2.5 ), time.mul( 0.9 ) );
		const fine = vec3( point.x.mul( 5.8 ).add( 3.1 ), point.z.mul( 5.8 ), time.mul( 1.7 ) );
		const coarseCenter = valueNoise3D( coarse );
		const fineCenter = valueNoise3D( fine );
		const slopeX = valueNoise3D( coarse.add( vec3( 0.2, 0, 0 ) ) ).sub( coarseCenter ).mul( 0.9 ).add( valueNoise3D( fine.add( vec3( 0.2, 0, 0 ) ) ).sub( fineCenter ).mul( 0.5 ) );
		const slopeZ = valueNoise3D( coarse.add( vec3( 0, 0.2, 0 ) ) ).sub( coarseCenter ).mul( 0.9 ).add( valueNoise3D( fine.add( vec3( 0, 0.2, 0 ) ) ).sub( fineCenter ).mul( 0.5 ) );
		const normal = vec3( slopeX.negate(), 1, slopeZ.negate() ).normalize();

		// 倒影：反射方向（往下的压到贴着地平线）转到世界，取统一天空（不画太阳圆盘和星星，太阳单独算闪点）
		const facing = dot( normal, toViewer ).max( 0.02 );
		const bounced = normal.mul( facing.mul( 2 ) ).sub( toViewer );
		const reflected = toWorldDirection( vec3( bounced.x, bounced.y.max( 0.02 ), bounced.z ).normalize() );
		const skyColor = daySkyColor( reflected, sky, time, { sunDisc: false, stars: false } );
		// 菲涅耳：Schlick 近似（水 F0 ≈ 0.02）
		const fresnel = float( 0.02 ).add( float( 0.98 ).mul( float( 1 ).sub( facing ).pow( 5 ) ) );
		// 太阳的闪点：反射方向对着太阳时很窄很亮的瓣（HDR，交给泛光），太阳落到山后就没有
		const glint = dot( reflected, sky.sunDirection ).max( 0 ).pow( 900 ).mul( 24 ).mul( smoothstep( - 0.02, 0.03, sky.sunDirection.y ) );

		// 水底：卵石（两级噪声，深浅不一的棕灰）；中线那里深一点、偏青
		const pebble = valueNoise3D( vec3( point.x.mul( 3.3 ), point.z.mul( 3.3 ), 0.5 ) ).mul( 0.65 ).add( valueNoise3D( vec3( point.x.mul( 9.1 ), point.z.mul( 9.1 ), 1.7 ) ).mul( 0.35 ) );
		const bed = mix( color( '#3f3a33' ), color( '#7a705f' ), smoothstep( 0.3, 0.75, pebble ) );
		const depth = float( 1 ).sub( flow.y.abs() ).mul( 0.7 );
		const water = mix( bed, color( '#203f3f' ), depth );
		const under = lighting( water, vec3( 0, 1, 0 ), point, { skyView: float( 0.8 ), wrap: 0.2 } );

		// 顺流的碎白：沿流向拉长的噪声，往下游走，只在水急、底下有石头的地方冒一点
		const streak = smoothstep( 0.68, 0.85, valueNoise3D( vec3( flow.x.sub( time.mul( 1.1 ) ).mul( 1.3 ), flow.y.mul( 2.6 ), 4.2 ) ) ).mul( smoothstep( 0.45, 0.7, pebble ) ).mul( 0.5 );
		const foam = lighting( color( '#e9ece6' ), vec3( 0, 1, 0 ), point, { skyView: float( 1 ), wrap: 0.3 } );

		const surface = mix( mix( under, skyColor, fresnel ), foam, streak ).add( sky.sunLightColor.mul( glint ) );
		// 边上浅、透明一点（底下的地面透上来）；两头淡掉
		const edge = float( 1 ).sub( smoothstep( 0.6, 1, flow.y.abs() ) );
		return vec4( atmosphere( surface, point ), edge.mul( 0.25 ).add( 0.65 ).mul( edge.mul( 0.7 ).add( 0.3 ) ).mul( flow.z ) );

	} )();
	return material;

}

// 实例网格：按至少 1100 个实例分配，mesh.count 设成实际的数量（多出来的不画）。
// three r186 的实例矩阵总共不超过 uniform 缓冲上限（约 1024 个）时放进一个名字带唯一编号的 uniform 缓冲，
// 每挂进一个新的地点场景就编一份新着色器、旧的一直留着（renderer.info 的程序数每换一次地点涨 7 个）；超过上限改走实例属性，没有这个问题
function createInstances( geometry, material, matrices ) {

	const mesh = new THREE.InstancedMesh( geometry, material, Math.max( matrices.length, 1100 ) );
	matrices.forEach( ( matrix, index ) => mesh.setMatrixAt( index, matrix ) );
	mesh.count = matrices.length;
	mesh.instanceMatrix.needsUpdate = true;
	return mesh;

}

// 一组长苔的石头（rock_moss_set_01 的六块轮流用）：spots = [{ x, z, scale, bury, tilt }]，石头底面按模型的包围盒落到地上再往下埋 bury 倍高度。
// 同一块石头的实例合成一个实例网格；返回 { meshes, disposables }
async function placeMossRocks( spots, groundAt, label, palette, { lighting, atmosphere, sky, random } ) {

	const meshes = [];
	const disposables = [];
	const groups = [ [], [], [], [], [], [] ];
	spots.forEach( ( spot, index ) => groups[ index % 6 ].push( spot ) );
	for ( let variant = 1; variant <= 6; variant ++ ) {

		const group = groups[ variant - 1 ];
		if ( group.length === 0 ) continue;
		const model = await loadModel( 'models', 'rock_moss_set_01-rock0' + variant );
		const shape = model ? flattenModel( model ) : null;
		if ( ! shape ) {

			if ( variant === 1 ) console.warn( `${ label }：长苔的石头（rock_moss_set_01）没读到，不放石头` );
			disposeModelGeometry( model );
			continue;

		}

		const box = shape.geometry.boundingBox;
		const modelHeight = Math.max( 0.01, box.max.y - box.min.y );
		const dummy = new THREE.Object3D();
		const placements = [];
		for ( const spot of group ) {

			// 几个角里取最低的地面：石头坐在坡上时低的那边不悬空
			const reach = Math.max( box.max.x - box.min.x, box.max.z - box.min.z ) * spot.scale * 0.35;
			let ground = groundAt( spot.x, spot.z );
			for ( const [ offsetX, offsetZ ] of [ [ reach, 0 ], [ - reach, 0 ], [ 0, reach ], [ 0, - reach ] ] ) ground = Math.min( ground, groundAt( spot.x + offsetX, spot.z + offsetZ ) );
			dummy.position.set( spot.x, ground - ( box.min.y + modelHeight * spot.bury ) * spot.scale, spot.z );
			dummy.rotation.set( ( random() - 0.5 ) * spot.tilt, random() * Math.PI * 2, ( random() - 0.5 ) * spot.tilt );
			dummy.scale.set( spot.scale * ( 0.9 + random() * 0.25 ), spot.scale * ( 0.8 + random() * 0.3 ), spot.scale * ( 0.9 + random() * 0.25 ) );
			dummy.updateMatrix();
			placements.push( dummy.matrix.clone() );

		}

		const material = createScanMaterial( `${ label } ${ variant }`, shape.map, palette, lighting, atmosphere, sky );
		const mesh = createInstances( shape.geometry, material, placements );
		mesh.name = `${ label } ${ variant }`;
		mesh.frustumCulled = false;
		meshes.push( mesh );
		disposables.push( shape.geometry, material );
		if ( shape.map ) disposables.push( shape.map );
		disposeModelGeometry( model );

	}

	return { meshes, disposables };

}

// 石头的颜色：冷灰的岩、一点暖，朝天的面长苔（原来的暖赭色在夕照里成了粉色）
const cleftRockPalette = { dark: '#3f4042', light: '#8a8882', keepHue: 0.12, moss: '#5f7a3c', mossFrom: 0.35, mossTo: 0.7, fill: 0.55 };
// 岩壁扫描：mountainside 的照片本身是偏红的砂岩，夕照一打成了粉色；只取贴图的明暗，颜色换成冷灰，朝天的台面长苔
const wallPalette = { dark: '#36383b', light: '#85837d', keepHue: 0.08, moss: '#56703a', mossFrom: 0.55, mossTo: 0.85, fill: 0.5 };

// 裂隙的布置：壁脚塌下来的石头（沿两壁的脚，大小不一，半埋）+ 溪边的卵石 + 泉眼边一圈苔石 + 小溪。
// 石头只放在口子真的有壁的地方（壁脚 wallFoot 米处往外 4 米地面高出 2 米以上），口子外的草地上不放（放了就是"平地上立着石头"）
async function buildCleftDressing( frame, line, { groundAt, lighting, atmosphere, sky, time, toWorldDirection, seed } ) {

	const random = createRandom( seed );
	const meshes = [];
	const disposables = [];
	const spots = [];

	// ---------- 壁脚的落石 ----------
	for ( const side of [ - 1, 1 ] ) {

		for ( let along = - frame.extend[ 0 ]; along <= line.length; along += frame.rockSpacing * ( 0.6 + random() * 0.8 ) ) {

			const sample = pointAlongLine( line, along );
			const footOffset = frame.wallFoot + ( random() - 0.3 ) * 2;
			const floor = groundAt( sample.x, sample.z );
			const shelf = groundAt( sample.x + sample.sideX * ( footOffset + 4 ) * side, sample.z + sample.sideZ * ( footOffset + 4 ) * side );
			if ( shelf - floor < 2 ) continue;
			const big = random() < 0.35;
			spots.push( {
				x: sample.x + sample.sideX * footOffset * side,
				z: sample.z + sample.sideZ * footOffset * side,
				scale: big ? frame.rockScale[ 1 ] * ( 0.8 + random() * 0.4 ) : frame.rockScale[ 0 ] * ( 0.6 + random() * 0.8 ),
				bury: 0.25 + random() * 0.15,
				tilt: 0.5,
			} );
			// 大石头脚下再滚落一两块小的
			if ( big ) {

				for ( let k = 0; k < 2; k ++ ) {

					const offset = footOffset - 1.5 - random() * 2;
					const shift = ( random() - 0.5 ) * 3;
					const at = pointAlongLine( line, along + shift );
					spots.push( { x: at.x + at.sideX * offset * side, z: at.z + at.sideZ * offset * side, scale: frame.rockScale[ 0 ] * ( 0.35 + random() * 0.35 ), bury: 0.2, tilt: 0.8 } );

				}

			}

		}

	}

	// ---------- 溪边的卵石 ----------
	for ( let k = 0; k < frame.creekStones; k ++ ) {

		const along = frame.creekFrom + random() * ( frame.creekTo - frame.creekFrom );
		const sample = pointAlongLine( line, along );
		const side = random() < 0.5 ? - 1 : 1;
		const offset = frame.creekHalfWidth * ( 0.9 + random() * 1.4 );
		spots.push( { x: sample.x + sample.sideX * offset * side, z: sample.z + sample.sideZ * offset * side, scale: 0.25 + random() * 0.3, bury: 0.35, tilt: 0.6 } );

	}

	// ---------- 泉眼：小溪开头那里一圈苔石，水从石头底下冒出来 ----------
	const spring = pointAlongLine( line, frame.creekFrom );
	for ( let k = 0; k < 5; k ++ ) {

		const angle = Math.PI * ( 0.35 + k * 0.32 ) + ( random() - 0.5 ) * 0.3;
		const radius = 1.8 + random() * 1.2;
		// 围在上游那一侧（沿中线往回的方向）
		const backX = - sample0Direction( line ).x;
		const backZ = - sample0Direction( line ).z;
		const x = spring.x + ( backX * Math.sin( angle ) + spring.sideX * Math.cos( angle ) ) * radius;
		const z = spring.z + ( backZ * Math.sin( angle ) + spring.sideZ * Math.cos( angle ) ) * radius;
		spots.push( { x, z, scale: 0.5 + random() * 0.6, bury: 0.3, tilt: 0.4 } );

	}

	// ---------- 岩丘四周：崖脚的落石、丘顶的松 ----------
	// 在补丁那块范围里随机撒点，按地形找位置：自己脚下平缓、往上坡 4 米处很陡的，是崖脚，堆一小簇落石（大的一块带两三块小的）；
	// 比口子底高出 crestHeight 米以上、又平缓的，是丘顶，种被海风吹歪的松（彼此隔开 7 米以上）；丘脚平地上再稀稀拉拉种几棵
	const slopeAt = ( x, z ) => {

		const dx = groundAt( x + 1, z ) - groundAt( x - 1, z );
		const dz = groundAt( x, z + 1 ) - groundAt( x, z - 1 );
		return { slope: Math.hypot( dx, dz ) / 2, dx: dx / 2, dz: dz / 2 };

	};
	const pines = [];
	const scatter = frame.knollScatter;
	if ( scatter ) {

		const floorAt = ( along ) => groundAt( pointAlongLine( line, along ).x, pointAlongLine( line, along ).z );
		let footClusters = 0;
		let footPines = 0;
		let crestPines = 0;
		let shrubs = 0;
		let outcrops = 0;
		for ( let k = 0; k < scatter.candidates; k ++ ) {

			const along = - frame.patch.extend[ 0 ] + random() * ( line.length - frame.extend[ 0 ] - frame.extend[ 1 ] + frame.patch.extend[ 0 ] + frame.patch.extend[ 1 ] );
			const across = ( random() * 2 - 1 ) * ( frame.patch.halfWidth - 6 );
			const sample = pointAlongLine( line, along );
			const x = sample.x + sample.sideX * across;
			const z = sample.z + sample.sideZ * across;
			const here = slopeAt( x, z );
			if ( here.slope < 0.35 && footClusters < scatter.footClusters ) {

				// 往上坡方向 4 米
				const length = Math.max( 1e-3, here.slope );
				const upX = here.dx / length;
				const upZ = here.dz / length;
				const above = slopeAt( x + upX * 4, z + upZ * 4 );
				if ( here.slope > 0.02 && above.slope > 0.9 ) {

					footClusters ++;
					spots.push( { x, z, scale: frame.rockScale[ 1 ] * ( 0.6 + random() * 0.6 ), bury: 0.25, tilt: 0.5 } );
					const smallCount = 1 + Math.floor( random() * 3 );
					for ( let s = 0; s < smallCount; s ++ ) {

						const angle = random() * Math.PI * 2;
						const reach = 2 + random() * 3;
						spots.push( { x: x - upX * reach * 0.6 + Math.cos( angle ) * reach * 0.6, z: z - upZ * reach * 0.6 + Math.sin( angle ) * reach * 0.6, scale: frame.rockScale[ 0 ] * ( 0.35 + random() * 0.5 ), bury: 0.2, tilt: 0.8 } );

					}

					continue;

				}

			}

			const rise = groundAt( x, z ) - floorAt( along );
			// 岩丘侧面的岩头：坡上（0.3~0.9）半埋的大块苔石，一处两三块挤在一起，从草里拱出来（规格书 5.3"两侧有圆有陡、露岩"）
			if ( here.slope > 0.3 && here.slope < 0.9 && rise > 3 && outcrops < ( scatter.outcrops || 0 ) && Math.abs( across ) > frame.width / 2 + 4 ) {

				outcrops ++;
				const count = 2 + Math.floor( random() * 2 );
				for ( let s = 0; s < count; s ++ ) {

					const angle = random() * Math.PI * 2;
					const reach = s === 0 ? 0 : 1.5 + random() * 2;
					spots.push( { x: x + Math.cos( angle ) * reach, z: z + Math.sin( angle ) * reach, scale: ( s === 0 ? 1.6 : 0.9 ) * ( 0.8 + random() * 0.6 ), bury: 0.45 + random() * 0.15, tilt: 0.7 } );

				}

				continue;

			}

			if ( here.slope < 0.3 && crestPines < scatter.pines && rise > scatter.crestHeight ) {

				if ( pines.some( ( pine ) => Math.hypot( pine.x - x, pine.z - z ) < scatter.pineSpacing ) ) continue;
				crestPines ++;
				pines.push( { x, z, size: 0.75 + random() * 0.55, leanAngle: 65 + random() * 25, leanDegrees: 5 + random() * 10 } );

			} else if ( here.slope > 0.1 && here.slope < 0.75 && rise > 1.5 && rise < scatter.crestHeight + 4 && shrubs < ( scatter.shrubs || 0 ) && Math.abs( across ) > frame.width / 2 + 5 ) {

				// 坡上的灌丛（审查 R19：岩丘是光秃秃的一个包，像摆上去的）：矮的阔叶树当灌丛，一丛丛隔开，顺着海风往东歪
				if ( pines.some( ( pine ) => Math.hypot( pine.x - x, pine.z - z ) < scatter.shrubSpacing ) ) continue;
				shrubs ++;
				pines.push( { x, z, size: 0.28 + random() * 0.22, leanAngle: 70 + random() * 30, leanDegrees: 4 + random() * 8, species: 'broadleaf' } );

			} else if ( here.slope < 0.25 && footPines < scatter.footPines && rise < 6 && Math.abs( across ) > frame.width / 2 + 10 ) {

				// 丘脚一圈稀稀拉拉的松（岩丘不是孤零零摆在草地上的一个包），一棵棵隔开
				if ( pines.some( ( pine ) => Math.hypot( pine.x - x, pine.z - z ) < scatter.pineSpacing * 1.4 ) ) continue;
				footPines ++;
				pines.push( { x, z, size: 0.85 + random() * 0.5, leanAngle: 65 + random() * 25, leanDegrees: 2 + random() * 6 } );

			}

		}

		console.log( `窄处·${ frame.name }：崖脚落石 ${ footClusters } 簇，侧面岩头 ${ outcrops } 处，丘顶的松 ${ crestPines } 棵、丘脚 ${ footPines } 棵，坡上灌丛 ${ shrubs } 丛` );

	}

	const rocks = await placeMossRocks( spots, groundAt, `窄处·${ frame.name }·石头`, cleftRockPalette, { lighting, atmosphere, sky, random } );
	meshes.push( ...rocks.meshes );
	disposables.push( ...rocks.disposables );

	// ---------- 两壁：岩石扫描（Poly Haven mountainside，CC0）----------
	// 每块按那里壁的高度缩放（顶比丘顶低一点，藏在草下面），正面朝缝里，正面放在壁脚往外 wallInset 米处（中心再往壁里推半个进深），
	// 随机偏转 ±12°、往后仰 0~6°，前后两块互相咬住。颜色按扫描贴图本身（冷灰），朝天的面长苔
	const wallModel = await loadModel( 'models', 'mountainside-lod1' );
	const wallShape = wallModel ? flattenModel( wallModel ) : null;
	if ( ! wallShape ) console.warn( `窄处·${ frame.name }：岩石扫描 mountainside 没读到，口子两壁只有地形` );
	else {

		const box = wallShape.geometry.boundingBox;
		const modelHeight = box.max.y - box.min.y;
		const modelWidth = box.max.x - box.min.x;
		const modelDepth = box.max.z - box.min.z;
		const dummy = new THREE.Object3D();
		const placements = [];
		for ( const side of [ - 1, 1 ] ) {

			let along = - 6 + random() * 4;
			while ( along <= line.length + 6 ) {

				const sample = pointAlongLine( line, along );
				const floor = groundAt( sample.x, sample.z );
				const rimDistance = frame.wallFoot + 12;
				const rim = groundAt( sample.x + sample.sideX * rimDistance * side, sample.z + sample.sideZ * rimDistance * side );
				const wallHeight = rim - floor;
				if ( wallHeight < 3 ) {

					along += 2;
					continue;

				}

				const scale = Math.min( frame.wallScale[ 1 ], Math.max( frame.wallScale[ 0 ], ( wallHeight - 0.8 + frame.wallBury ) / modelHeight ) ) * ( 0.92 + random() * 0.16 );
				const offset = frame.wallFoot + frame.wallInset + modelDepth * scale * 0.5;
				const inwardX = - sample.sideX * side;
				const inwardZ = - sample.sideZ * side;
				dummy.position.set( sample.x + sample.sideX * offset * side, floor - frame.wallBury, sample.z + sample.sideZ * offset * side );
				dummy.rotation.set( 0, Math.atan2( inwardX, inwardZ ) + ( random() - 0.5 ) * 0.42, 0, 'YXZ' );
				dummy.rotateX( - random() * 0.1 );
				dummy.scale.set( scale * ( 0.9 + random() * 0.2 ), scale, scale );
				dummy.updateMatrix();
				placements.push( dummy.matrix.clone() );
				along += modelWidth * scale * ( 0.55 + random() * 0.2 );

			}

		}

		if ( placements.length > 0 ) {

			const material = createScanMaterial( `窄处·${ frame.name }·岩壁`, wallShape.map, wallPalette, lighting, atmosphere, sky );
			const mesh = createInstances( wallShape.geometry, material, placements );
			mesh.name = `窄处·${ frame.name }·岩壁`;
			mesh.frustumCulled = false;
			meshes.push( mesh );
			disposables.push( wallShape.geometry, material );
			if ( wallShape.map ) disposables.push( wallShape.map );
			console.log( `窄处·${ frame.name }：岩壁扫描 ${ placements.length } 块` );

		}

		disposeModelGeometry( wallModel );

	}

	// ---------- 小溪 ----------
	const creekPoints = [];
	for ( let along = frame.creekFrom; along < frame.creekTo; along += 3 ) creekPoints.push( pointAlongLine( line, along ) );
	creekPoints.push( pointAlongLine( line, frame.creekTo ) );
	const creekGeometry = buildCreekRibbon( creekPoints, groundAt, { halfWidth: frame.creekHalfWidth, fadeIn: 2.5, fadeOut: 4, lift: 0.08 } );
	const creekMaterial = createCreekMaterial( `窄处·${ frame.name }·小溪`, { lighting, atmosphere, sky, time, toWorldDirection } );
	const creek = new THREE.Mesh( creekGeometry, creekMaterial );
	creek.name = `窄处·${ frame.name }·小溪`;
	creek.frustumCulled = false;
	creek.renderOrder = 2;
	meshes.push( creek );
	disposables.push( creekGeometry, creekMaterial );
	return { meshes, disposables, pines };

}

// 中线开头那一段的水平方向（单位向量）
function sample0Direction( line ) {

	const [ first, second ] = line.samples;
	const length = Math.hypot( second.x - first.x, second.z - first.z ) || 1;
	return { x: ( second.x - first.x ) / length, z: ( second.z - first.z ) / length };

}

// 中线上沿线距离 along 处的点（超出两头时取两头的点）
function pointAlongLine( line, along ) {

	const samples = line.samples;
	if ( along <= samples[ 0 ].along ) return samples[ 0 ];
	for ( let k = 1; k < samples.length; k ++ ) {

		if ( samples[ k ].along >= along ) {

			const previous = samples[ k - 1 ];
			const next = samples[ k ];
			const t = ( along - previous.along ) / Math.max( 1e-6, next.along - previous.along );
			return {
				x: previous.x + ( next.x - previous.x ) * t,
				y: previous.y + ( next.y - previous.y ) * t,
				z: previous.z + ( next.z - previous.z ) * t,
				along,
				sideX: previous.sideX,
				sideZ: previous.sideZ,
			};

		}

	}

	return samples[ samples.length - 1 ];

}

// 模型里的几何体已经合进实例网格，原来的释放（贴图实例网格还在用，不放）
function disposeModelGeometry( object ) {

	if ( ! object ) return;
	object.traverse( ( child ) => {

		if ( child.isMesh && child.geometry ) child.geometry.dispose();
		if ( child.isMesh && child.material ) {

			const materials = Array.isArray( child.material ) ? child.material : [ child.material ];
			for ( const material of materials ) material.dispose();

		}

	} );

}

// ===================== 剔除（性能，perf.scenesB.narrowsCull）=====================
// 原来窄处所有网格都不做视锥剔除、在每个地点、每段飞行都画（有倒影的地点倒影里再画一遍），岩丘裂隙的岩壁和六组石头一帧约 0.9 M 三角。
// 现在：网格（摆好的东西顶点都是世界坐标、不在着色器里挪）按自己的包围球做视锥剔除；实例网格（石头、岩壁、冰块）再按离镜头的距离藏：
// 最大的一块（模型半径 × 最大的实例缩放）在画面上小于 narrowsHidePixels 个像素（按 narrowsReferenceHeight 高的画面、画它的那台相机的视场换算），
// 这一组才藏。灯晕（顶点着色器里挪成朝镜头的方片）、光池（包围球故意给大）不动，它们很便宜。
// 按距离藏是渲染器投影那一步做的：外面包一个物体，标成 isLOD，渲染器每画一遍（主画面、倒影、地面底稿）都先按那一台相机调它的 update( camera )。
// 预编译、热身（pipeline.compileScene / warmUp）会把所有物体临时设成可见、不剔除（frustumCulled = false）：这时 update 不藏，照常编到
const cullCenter = new THREE.Vector3();
const cullEye = new THREE.Vector3();
const cullScale = new THREE.Vector3();

function prepareCulling( mesh ) {

	const material = mesh.material;
	const geometry = mesh.geometry;
	if ( ! mesh.isMesh || material.vertexNode || material.positionNode ) return mesh;
	if ( geometry.boundingSphere && geometry.boundingSphere.radius >= 1e4 ) return mesh;
	geometry.computeBoundingSphere();
	mesh.frustumCulled = true;
	if ( ! mesh.isInstancedMesh || mesh.count === 0 ) return mesh;

	mesh.computeBoundingSphere();
	const bounds = mesh.boundingSphere;
	let largestScale = 0;
	const instanceMatrix = new THREE.Matrix4();
	for ( let i = 0; i < mesh.count; i ++ ) {

		mesh.getMatrixAt( i, instanceMatrix );
		largestScale = Math.max( largestScale, instanceMatrix.getMaxScaleOnAxis() );

	}

	const pieceRadius = geometry.boundingSphere.radius * largestScale;
	const settings = config.perf.scenesB;
	// 默认视场下多远开始藏（只给建好时打的那一行日志看）
	const pixelAngleDefault = THREE.MathUtils.degToRad( config.camera.fov ) / settings.narrowsReferenceHeight;
	mesh.userData.hideDistance = 2 * pieceRadius / ( pixelAngleDefault * settings.narrowsHidePixels );
	const holder = new THREE.Object3D();
	holder.name = mesh.name + '·按距离藏';
	holder.isLOD = true;
	holder.autoUpdate = true;
	// 所有层都开：哪台相机画它都先过 update（层不对时渲染器不调 update，但孩子照样往下走）
	holder.layers.enableAll();
	holder.userData.narrowsKind = mesh.userData.narrowsKind;
	holder.add( mesh );
	holder.update = ( camera ) => {

		if ( holder.frustumCulled === false || ! camera.isPerspectiveCamera ) {

			mesh.visible = true;
			return;

		}

		cullScale.setFromMatrixScale( holder.matrixWorld );
		const scale = Math.max( cullScale.x, cullScale.y, cullScale.z );
		cullCenter.copy( bounds.center ).applyMatrix4( holder.matrixWorld );
		cullEye.setFromMatrixPosition( camera.matrixWorld );
		const gap = Math.max( 0, cullEye.distanceTo( cullCenter ) - bounds.radius * scale );
		// 一个像素对多大角度：竖直视场 / 参考画面高
		const pixelAngle = THREE.MathUtils.degToRad( camera.fov ) / ( camera.zoom || 1 ) / settings.narrowsReferenceHeight;
		mesh.visible = gap * pixelAngle * settings.narrowsHidePixels < 2 * pieceRadius * scale;

	};
	return holder;

}

// ===================== 建 =====================
// legs：config.world.legs；groundAt( x, z )：世界地形高度；lighting、atmosphere 见上；sky：world.uniforms（天光补光用）；time：时间 uniform（小溪流动）；
// toWorldDirection：场景方向 → 世界方向的节点函数（小溪的倒影要查统一天空）
// 返回 { meshes, disposables, corridors（[x, z, 半径] 一串圆，远景的树林要让开）, extraTrees（窄处要种的树：[{ x, z, size, leanAngle, leanDegrees }]）}
// 返回 { meshes, disposables, corridors（不种树的圆 [x, z, 半径]）, extraTrees（照位置种的树）,
//   boosts（树林加密：{ samples: [{ x, z }], radius, species }，见 src/core/forest.js）, paths（路面上不撒林下：{ samples, halfWidth }）}
export async function buildNarrows( { legs, terrainShape, groundAt, lighting, atmosphere, sky, time: timeUniform, toWorldDirection } ) {

	time = timeUniform;
	const meshes = [];
	const disposables = [];
	const corridors = [];
	const extraTrees = [];
	const boosts = [];
	const paths = [];
	for ( let index = 0; index < legs.length; index ++ ) {

		const leg = legs[ index ];
		const frame = leg.frame;
		if ( ! frame || ! Array.isArray( frame.path ) || frame.path.length < 2 ) continue;
		const line = resampleLine( frame.path, 3, frame.extend || 12 );
		const seed = 17 + index * 31;
		// 走廊（不种树）：林间小路、冰碛岗只空出路面和飞过的那一条（clearHalfWidth），其余的窄处空出 width / 2 + 10 米
		const clearHalfWidth = frame.clearHalfWidth ?? frame.width / 2 + 10;
		for ( const sample of line.samples ) corridors.push( [ sample.x, sample.z, clearHalfWidth ] );
		const approach = [ ...( leg.waypoints || [] ).slice( - 2 ), frame.path[ 0 ] ];
		for ( let i = 1; i < approach.length; i ++ ) {

			const from = approach[ i - 1 ];
			const to = approach[ i ];
			const steps = Math.ceil( Math.hypot( to[ 0 ] - from[ 0 ], to[ 2 ] - from[ 2 ] ) / 10 );
			for ( let k = 0; k <= steps; k ++ ) corridors.push( [ from[ 0 ] + ( to[ 0 ] - from[ 0 ] ) * k / steps, from[ 2 ] + ( to[ 2 ] - from[ 2 ] ) * k / steps, 25 ] );

		}

		if ( frame.kind === 'cleft' ) {

			const dressing = await buildCleftDressing( frame, line, { groundAt, lighting, atmosphere, sky, time, toWorldDirection, seed } );
			meshes.push( ...dressing.meshes );
			disposables.push( ...dressing.disposables );
			for ( const [ x, z, size, leanAngle, leanDegrees ] of frame.pines || [] ) extraTrees.push( { x, z, size, leanAngle, leanDegrees } );
			extraTrees.push( ...dressing.pines );

		} else if ( frame.kind === 'trail' ) {

			const dressing = await buildTrailDressing( frame, line, { groundAt, lighting, atmosphere, sky, seed } );
			meshes.push( ...dressing.meshes );
			disposables.push( ...dressing.disposables );
			extraTrees.push( ...dressing.extraTrees );
			boosts.push( { samples: line.samples, radius: frame.boostRadius, species: null } );
			paths.push( { samples: line.samples, halfWidth: frame.trailHalfWidth + 0.6 } );

		} else if ( frame.kind === 'moraine' ) {

			const moraines = ( terrainShape && terrainShape.moraines ) || [];
			if ( moraines.length === 0 ) console.warn( `窄处「${ frame.name }」：地形里没有冰碛岗（terrainShape.moraines），只按航线走` );
			const dressing = await buildMoraineDressing( frame, moraines, { groundAt, lighting, atmosphere, sky, seed } );
			meshes.push( ...dressing.meshes );
			disposables.push( ...dressing.disposables );
			// 岗上加密成松林：沿岗脊、半径 boostRadius
			for ( const moraine of moraines ) boosts.push( { samples: resampleLine( moraine.points.map( ( [ x, z ] ) => [ x, 0, z ] ), 6, 0 ).samples, radius: frame.boostRadius, species: 'pine' } );

		} else if ( frame.kind === 'trough' ) {

			const notch = ( ( terrainShape && terrainShape.notches ) || [] ).find( ( item ) => item.ice );
			if ( ! notch ) {

				console.warn( `窄处「${ frame.name }」：地形里没有冰槽（terrainShape.notches 里 ice 的那条），只按航线走` );
				continue;

			}

			const dressing = buildTroughDressing( frame, notch, { groundAt, lighting, atmosphere, sky, time, toWorldDirection, seed } );
			// 记下是冰槽的：雪原的内容显出来以后藏起来（雪原自己的地形在槽沿上和远景差一点，冰凌、冰块会浮着）
			for ( const mesh of dressing.meshes ) mesh.userData.narrowsKind = 'trough';
			meshes.push( ...dressing.meshes );
			disposables.push( ...dressing.disposables );

		} else {

			console.warn( `窄处「${ frame.name }」：不认识的种类「${ frame.kind }」，只按航线走` );

		}

	}

	// 剔除（见 prepareCulling）：返回的是挂进远景的物体（实例网格外面包了一层按距离藏的），远景的开关、冰槽的显隐照旧按它们设
	const placed = config.perf.scenesB.narrowsCull ? meshes.map( prepareCulling ) : meshes;
	const distances = meshes.filter( ( mesh ) => mesh.userData.hideDistance ).map( ( mesh ) => mesh.userData.hideDistance );
	if ( distances.length ) console.log( `窄处：${ distances.length } 组实例网格离远了按距离藏（默认视场下 ${ Math.min( ...distances ).toFixed( 0 ) }~${ Math.max( ...distances ).toFixed( 0 ) } 米外），其余网格做视锥剔除` );
	return { meshes: placed, disposables, corridors, extraTrees, boosts, paths };

}
