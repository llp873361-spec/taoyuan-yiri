// 飘落的花瓣（开场、花园共用，规格书 5.1.1、10.2）：count 片花瓣合成一个网格，轨迹全在顶点着色器里算，JS 不逐帧更新。
// 每片：种子位置 + 风 × 时间 + 下落 + 横向正弦飘荡 + 绕自己的随机轴翻转；在相机周围 boxSize 米的盒子里取模循环
// （位置是世界锚定的，相机走动时花瓣不跟着走）。法线跟着翻转，逆光时透亮、侧光时暗。
// 盒子边上和离镜头很近的花瓣淡掉（取模换位、贴脸的大花瓣都看不出来）。

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, uniform, attribute, cameraPosition, positionWorld,
	normalize, length, dot, max, mix, smoothstep, sin, cos, abs, mod, cross, select, Discard,
} from 'three/tsl';
import { hash33 } from './noise.js';

// options：
//   count 花瓣数；boxSize 盒子边长（米）；size [最小, 最大] 花瓣长（米）；fallSpeed 下落速度（米/秒）；
//   wind 风（vec3，米/秒，世界方向）；colors 两种颜色（sRGB 字符串）；
//   shade( albedo, normal, position, toViewer ) → 着色后的颜色（场景给自己的光照）；name 网格名字
export function createPetals( options ) {

	const count = Math.max( 1, Math.round( options.count ) );
	const geometry = new THREE.BufferGeometry();
	const corners = new Float32Array( count * 4 * 2 );
	const seeds = new Float32Array( count * 4 );
	const positions = new Float32Array( count * 4 * 3 );
	const indices = new Uint32Array( count * 6 );
	const cornerList = [ [ - 0.5, - 0.5 ], [ 0.5, - 0.5 ], [ 0.5, 0.5 ], [ - 0.5, 0.5 ] ];
	for ( let i = 0; i < count; i ++ ) {

		for ( let k = 0; k < 4; k ++ ) {

			corners[ ( i * 4 + k ) * 2 ] = cornerList[ k ][ 0 ];
			corners[ ( i * 4 + k ) * 2 + 1 ] = cornerList[ k ][ 1 ];
			seeds[ i * 4 + k ] = i;

		}

		indices.set( [ i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3 ], i * 6 );

	}

	// position 只是占个数（顶点数要从它来），真正的位置在 positionNode 里算
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'petalCorner', new THREE.BufferAttribute( corners, 2 ) );
	geometry.setAttribute( 'petalSeed', new THREE.BufferAttribute( seeds, 1 ) );
	geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );

	const uniforms = {
		time: uniform( 0 ),
		center: uniform( new THREE.Vector3() ),    // 盒子中心（每帧设成相机位置，场景坐标）
		boxSize: uniform( options.boxSize ),
		fallSpeed: uniform( options.fallSpeed ),
		wind: uniform( new THREE.Vector3().copy( options.wind ) ),
		amount: uniform( 1 ),                       // 0 全部收起（调试开关、离开地点时用）
		sizeMin: uniform( options.size[ 0 ] ),
		sizeMax: uniform( options.size[ 1 ] ),
		colorA: uniform( new THREE.Color( options.colors[ 0 ] ) ),
		colorB: uniform( new THREE.Color( options.colors[ 1 ] ) ),
	};

	const corner = attribute( 'petalCorner', 'vec2' );
	const seed = attribute( 'petalSeed', 'float' );
	const random = hash33( vec3( seed, 17, 5 ) );
	const randomB = hash33( vec3( seed, 61, 29 ) );

	// 轨迹（世界锚定）：种子位置 + 风 × t + 下落；横向两组不同频率的正弦让每片飘得不一样
	const travel = Fn( () => {

		const time = uniforms.time;
		const start = random.sub( 0.5 ).mul( uniforms.boxSize );
		const fall = uniforms.fallSpeed.mul( randomB.x.mul( 0.6 ).add( 0.7 ) );
		const sway = vec3(
			sin( time.mul( randomB.y.mul( 0.8 ).add( 0.5 ) ).add( random.z.mul( 6.28 ) ) ).mul( 0.7 ),
			0,
			cos( time.mul( randomB.z.mul( 0.7 ).add( 0.4 ) ).add( random.x.mul( 6.28 ) ) ).mul( 0.7 ),
		);
		const moved = start.add( uniforms.wind.mul( time ) ).add( vec3( 0, fall.mul( time ).negate(), 0 ) ).add( sway );
		// 取模到以相机为中心的盒子里
		const half = uniforms.boxSize.mul( 0.5 );
		return mod( moved.sub( uniforms.center ).add( half ), uniforms.boxSize ).sub( half ).add( uniforms.center );

	} );
	const petalCenter = travel().toVar( 'petalCenter' );

	// 翻转：绕随机轴转，转速 1.5~4 弧度/秒（Rodrigues 公式）
	const axis = normalize( randomB.sub( 0.5 ).add( vec3( 0.001, 0.002, 0.003 ) ) );
	const angle = uniforms.time.mul( random.y.mul( 2.5 ).add( 1.5 ) ).add( random.x.mul( 6.28 ) );
	const rotate = ( vector ) => vector.mul( cos( angle ) ).add( cross( axis, vector ).mul( sin( angle ) ) ).add( axis.mul( dot( axis, vector ) ).mul( float( 1 ).sub( cos( angle ) ) ) );

	// 大小：盒子边上和离镜头 0.6 米以内缩到 0
	const size = mix( uniforms.sizeMin, uniforms.sizeMax, random.z );
	const offset = petalCenter.sub( uniforms.center );
	const edge = max( max( abs( offset.x ), abs( offset.y ) ), abs( offset.z ) ).div( uniforms.boxSize.mul( 0.5 ) );
	const nearCamera = smoothstep( 0.25, 0.6, length( petalCenter.sub( cameraPosition ) ) );
	const visible = float( 1 ).sub( smoothstep( 0.8, 1, edge ) ).mul( nearCamera ).mul( uniforms.amount );
	const local = vec3( corner.x.mul( 0.62 ), corner.y, 0 ).mul( size ).mul( visible );

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = options.name || '花瓣';
	material.side = THREE.DoubleSide;
	material.fog = false;
	material.lights = false;
	material.positionNode = petalCenter.add( rotate( local ) );

	material.colorNode = Fn( () => {

		// 花瓣形状：一头圆一头尖的椭圆，圆头那边一个小缺口（桃花瓣的样子），软边 alpha 测试
		const uv = corner.mul( 2 );
		const along = uv.y.mul( 0.5 ).add( 0.5 );
		const halfWidth = sin( along.mul( Math.PI ) ).mul( mix( float( 0.65 ), float( 1 ), along ) );
		const inside = float( 1 ).sub( smoothstep( halfWidth.mul( 0.85 ), halfWidth, abs( uv.x ) ) );
		const notch = smoothstep( 0.08, 0.16, length( vec2( uv.x, uv.y.sub( 1 ) ) ) );
		Discard( inside.mul( notch ).lessThan( 0.5 ) );

		const normal = normalize( rotate( vec3( 0, 0, 1 ) ) );
		const toViewer = normalize( cameraPosition.sub( positionWorld ) );
		const facing = select( dot( normal, toViewer ).greaterThan( 0 ), normal, normal.negate() );
		// 颜色：花瓣根部（尖头）深一点，两种粉按每片随机混
		const albedo = mix( uniforms.colorA, uniforms.colorB, randomB.x ).mul( mix( float( 0.82 ), float( 1 ), along ) );
		return vec4( options.shade( albedo, facing, positionWorld, toViewer ), 1 );

	} )();

	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = options.name || '花瓣';
	mesh.frustumCulled = false;

	return {
		mesh,
		uniforms,
		dispose() {

			geometry.dispose();
			material.dispose();

		},
	};

}
