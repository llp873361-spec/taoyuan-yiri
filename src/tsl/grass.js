// 草（开场、花园共用，规格书 10.2）：参考 SimonDev 的 Quick_Grass（MIT，复现《对马岛之魂》的草地）的做法自己写——
// 每根草是一条贝塞尔弯曲的细三角带，所有草合成一个网格一次画完；风分三层（整体摆动 + 滚动的阵风 + 单株扰动），全在顶点着色器里；
// 视线和叶面接近平行时在横向加宽，叶片侧着也不会细成一条线消失。
// 只画相机周围 radius 米的一块：草根按 spacing 的网格对齐到场景坐标（相机移动时草不跟着滑），网格再加随机抖动；
// 地面高度、密度由场景给（field(xz) → vec2(地面高度, 密度 0~1)），密度低于这根草的随机数就收成一个点。

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, uniform, attribute, cameraPosition, positionWorld,
	normalize, length, dot, max, mix, smoothstep, sin, cos, abs, floor, pow, select,
} from 'three/tsl';
import { hash22, hash33, valueNoise2D } from './noise.js';

const segments = 3;   // 每根草 3 节：7 个顶点（两边各 3 个 + 尖）

// options：
//   radius 画多大一块（米）；spacing 草根网格间距（米）；height [最矮, 最高]；width 根部宽（米）；
//   field( xz ) → vec2( 地面高度, 密度 )；colors { base, tip, dry }（sRGB 字符串）；
//   shade( albedo, normal, position, toViewer ) → 着色后的颜色；wind 风向（场景坐标，水平单位向量 [x, z]）；name
export function createGrass( options ) {

	const cellsPerSide = Math.max( 2, Math.ceil( options.radius * 2 / options.spacing ) );
	const blades = cellsPerSide * cellsPerSide;
	const verticesPerBlade = segments * 2 + 1;
	const params = new Float32Array( blades * verticesPerBlade * 2 );
	const bladeIndex = new Float32Array( blades * verticesPerBlade );
	const positions = new Float32Array( blades * verticesPerBlade * 3 );
	const indices = new Uint32Array( blades * ( segments * 6 - 3 ) );
	let indexCursor = 0;
	for ( let blade = 0; blade < blades; blade ++ ) {

		const first = blade * verticesPerBlade;
		for ( let k = 0; k < verticesPerBlade; k ++ ) {

			// 参数：x 是左右（−1 / 1，尖是 0），y 是沿叶片 0~1
			const row = Math.floor( k / 2 );
			const tip = k === verticesPerBlade - 1;
			params[ ( first + k ) * 2 ] = tip ? 0 : ( k % 2 === 0 ? - 1 : 1 );
			params[ ( first + k ) * 2 + 1 ] = tip ? 1 : row / segments;
			bladeIndex[ first + k ] = blade;

		}

		for ( let row = 0; row < segments - 1; row ++ ) {

			const a = first + row * 2;
			indices.set( [ a, a + 1, a + 2, a + 1, a + 3, a + 2 ], indexCursor );
			indexCursor += 6;

		}

		const last = first + ( segments - 1 ) * 2;
		indices.set( [ last, last + 1, first + verticesPerBlade - 1 ], indexCursor );
		indexCursor += 3;

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'bladeParam', new THREE.BufferAttribute( params, 2 ) );
	geometry.setAttribute( 'bladeIndex', new THREE.BufferAttribute( bladeIndex, 1 ) );
	geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );

	const uniforms = {
		time: uniform( 0 ),
		center: uniform( new THREE.Vector2() ),       // 相机的水平位置（场景坐标）
		amount: uniform( 1 ),                         // 0 全部收起（调试开关）
		windDirection: uniform( new THREE.Vector2( options.wind[ 0 ], options.wind[ 1 ] ) ),
		windStrength: uniform( 1 ),
		heightMin: uniform( options.height[ 0 ] ),
		heightMax: uniform( options.height[ 1 ] ),
		width: uniform( options.width ),
		baseColor: uniform( new THREE.Color( options.colors.base ) ),
		tipColor: uniform( new THREE.Color( options.colors.tip ) ),
		dryColor: uniform( new THREE.Color( options.colors.dry ) ),
	};

	const spacing = options.spacing;
	const radius = options.radius;
	const param = attribute( 'bladeParam', 'vec2' );
	const index = attribute( 'bladeIndex', 'float' );

	// 草根：网格对齐到场景坐标；网格的原点跟着相机按整格挪
	const cellX = index.mod( cellsPerSide );
	const cellZ = floor( index.div( cellsPerSide ) );
	const anchor = floor( uniforms.center.div( spacing ) );
	const worldCell = anchor.add( vec2( cellX, cellZ ) ).sub( cellsPerSide / 2 );
	const jitter = hash22( worldCell );
	const rootXZ = worldCell.add( jitter ).mul( spacing ).toVar( 'grassRoot' );
	const random = hash33( vec3( worldCell, 7 ) );
	const field = options.field( rootXZ );
	const groundY = field.x;
	const density = field.y;

	// 离相机越远越稀、越矮，radius 的 85% 以外收完（地面颜色接上）
	const distance = length( rootXZ.sub( uniforms.center ) );
	const distanceFade = float( 1 ).sub( smoothstep( radius * 0.55, radius * 0.85, distance ) );
	const alive = select( random.x.lessThan( density.mul( mix( float( 0.35 ), float( 1 ), distanceFade ) ) ), float( 1 ), float( 0 ) ).mul( uniforms.amount );
	const bladeHeight = mix( uniforms.heightMin, uniforms.heightMax, random.y.mul( random.y ) ).mul( smoothstep( 0, 0.35, distanceFade ).mul( 0.6 ).add( 0.4 ) ).mul( alive );

	// 叶片朝向（叶面的法线方向，水平）和它的左右方向
	const yaw = random.z.mul( 6.2832 );
	const facing = vec3( sin( yaw ), 0, cos( yaw ) );
	const side = vec3( facing.z, 0, facing.x.negate() );

	// 风：整体摆动 + 滚动的阵风（沿风向平移的噪声）+ 单株扰动；合成"往风那边弯多少"（0~1.2）
	const time = uniforms.time;
	const sway = sin( time.mul( 0.9 ).add( dot( rootXZ, uniforms.windDirection ).mul( 0.12 ) ) ).mul( 0.18 ).add( 0.22 );
	const gust = valueNoise2D( rootXZ.mul( 0.045 ).sub( uniforms.windDirection.mul( time.mul( 0.35 ) ) ) );
	const flutter = sin( time.mul( 3.1 ).add( random.x.mul( 40 ) ) ).mul( 0.06 );
	const bend = sway.add( smoothstep( 0.45, 0.9, gust ).mul( 0.55 ) ).add( flutter ).mul( uniforms.windStrength ).add( random.y.mul( 0.25 ) ).toVar( 'grassBend' );
	const windVector = vec3( uniforms.windDirection.x, 0, uniforms.windDirection.y );
	// 草本身有一点随机的倾斜方向（不全朝风）
	const leanDirection = normalize( windVector.mul( 0.8 ).add( facing.mul( random.x.sub( 0.5 ) ) ) );

	// 二次贝塞尔：根 → 控制点（竖直往上 0.6 高）→ 尖（往倾斜方向弯，弯得越多越矮，叶长不变）
	const along = param.y;
	const tipDrop = bend.mul( bend ).mul( 0.35 ).clamp( 0, 0.6 );
	const tipOffset = leanDirection.mul( bend.mul( 0.75 ) ).add( vec3( 0, float( 1 ).sub( tipDrop ), 0 ) ).mul( bladeHeight );
	const control = vec3( 0, bladeHeight.mul( 0.6 ), 0 );
	const oneMinus = float( 1 ).sub( along );
	const curve = control.mul( oneMinus.mul( along ).mul( 2 ) ).add( tipOffset.mul( along.mul( along ) ) );
	const tangent = normalize( control.mul( oneMinus.mul( 2 ) ).add( tipOffset.sub( control ).mul( along.mul( 2 ) ) ).add( vec3( 0, 1e-4, 0 ) ) );

	// 宽：根部 width，往尖收；侧对相机时加宽（叶面法线和视线越垂直越宽，最多 2.5 倍）
	const toCamera = normalize( vec3( cameraPosition.x.sub( rootXZ.x ), 0, cameraPosition.z.sub( rootXZ.y ) ).add( vec3( 1e-4, 0, 0 ) ) );
	const edgeOn = float( 1 ).sub( abs( dot( facing, toCamera ) ) );
	const halfWidth = uniforms.width.mul( 0.5 ).mul( pow( float( 1 ).sub( along ).max( 0 ), 0.8 ) ).mul( edgeOn.mul( 1.5 ).add( 1 ) ).mul( random.y.mul( 0.5 ).add( 0.75 ) );
	const root = vec3( rootXZ.x, groundY, rootXZ.y );

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = options.name || '草';
	material.side = THREE.DoubleSide;
	material.fog = false;
	material.lights = false;
	material.positionNode = root.add( curve ).add( side.mul( param.x.mul( halfWidth ) ) );

	material.colorNode = Fn( () => {

		// 法线：叶面法线往左右各偏一些（叶片是微微卷起来的，侧光下不会整片一样亮），再和叶片的切向正交
		const rounded = normalize( facing.add( side.mul( param.x.mul( 0.6 ) ) ) );
		const normal = normalize( rounded.sub( tangent.mul( dot( rounded, tangent ) ) ) ).toVar();
		const toViewer = normalize( cameraPosition.sub( positionWorld ) );
		normal.assign( select( dot( normal, toViewer ).greaterThan( 0 ), normal, normal.negate() ) );
		// 颜色：根暗尖亮；每根随机偏黄一点；根部再压暗（草丛里的遮蔽）
		const tint = mix( uniforms.baseColor, uniforms.tipColor, pow( along, 0.8 ) );
		const albedo = mix( tint, uniforms.dryColor, random.z.mul( random.x ).mul( 0.5 ) ).mul( mix( float( 0.45 ), float( 1 ), smoothstep( 0, 0.5, along ) ) );
		return vec4( options.shade( albedo, normal, positionWorld, toViewer ), 1 );

	} )();

	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = options.name || '草';
	mesh.frustumCulled = false;

	return {
		mesh,
		uniforms,
		blades,
		dispose() {

			geometry.dispose();
			material.dispose();

		},
	};

}
