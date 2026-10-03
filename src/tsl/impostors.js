// 远处的树：替身卡片（规格书阶段 12 CP3 返工"树替身"）。
// 原来远处是一团团变形的二十面体，远看是棒棒糖；现在是同一棵 3D 树从 8 个方位烘出来的图（scripts/bake-foliage.mjs），
// 每棵树一张竖直、绕竖轴朝着镜头的卡片：按镜头绕树的方位（扣掉树自己的朝向）取相邻两帧、按角度混；
// 法线图是树自己坐标系里的，转到世界坐标再吃远景的日月光照，所以早晚、夜里都对。
// 和近处 3D 树的交接、按距离稀疏的规则和原来的树团一样（同一个随机数 cull），一棵树要么是 3D、要么是卡片。

import * as THREE from 'three/webgpu';
import {
	Fn, If, Discard, float, vec2, vec3, vec4, attribute, varying, texture,
	positionGeometry, normalize, length, max, min, mix, step, floor, fract, atan, sin, cos, mod, dFdx, dFdy, log2,
} from 'three/tsl';

// items：[{ x, y, z, size, yaw, tint, cull, species, variant }]（y 是树根海拔）；manifest：bake-foliage 写的清单；
// textures：{ color, normal }（线性、翻过 Y 的 WebP）；options：
//   viewer（镜头世界坐标节点）、place( 世界坐标节点 ) → 位置节点（远景的深度压缩）、
//   keep( base, cull, distance ) → 0/1 节点（交接、稀疏、开关）、
//   shadowsAt( base ) → vec2 节点（太阳、月亮的地形阴影）、atmosphere( surface, base ) → 颜色节点（大气透视，必须是 surface 的仿射函数）：
//     这两样每棵树不变，在顶点里按树根算一次（会在 Fn 里调用，里面可以写 If）；
//   shade( albedo, normal, shadows ) → 颜色节点（不含大气的光照）
// 返回 { mesh, count, missing }：missing 是清单里没有的树种（这些树不画，调用方自己兜底）
export function createImpostorForest( { items, manifest, textures, viewer, place, keep, shadowsAt, atmosphere, shade, minAllocated = 4096 } ) {

	const rows = manifest.templates.length;
	const views = manifest.views;
	const rowOf = new Map( manifest.templates.map( ( item, index ) => [ item.species + '/' + item.variant, index ] ) );
	const usable = [];
	const missing = new Set();
	for ( const item of items ) {

		const row = rowOf.get( item.species + '/' + item.variant );
		if ( row === undefined ) missing.add( item.species );
		else usable.push( [ item, row ] );

	}

	const count = usable.length;
	const allocated = Math.max( count, minAllocated );
	// 卡片：x −0.5~0.5、y 0~1 的方片（底边在树根下面 root 那么多，见顶点里）
	const geometry = new THREE.PlaneGeometry( 1, 1 );
	geometry.translate( 0, 0.5, 0 );
	const base = new Float32Array( allocated * 3 );
	const info = new Float32Array( allocated * 4 );   // 行号、朝向、大小、色相随机数
	const extra = new Float32Array( allocated * 4 );  // 远近随机数 cull、格子边长（米）、树根在格子里的高度、没用
	for ( let index = count; index < allocated; index ++ ) base[ index * 3 + 1 ] = - 10000;
	usable.forEach( ( [ item, row ], index ) => {

		const template = manifest.templates[ row ];
		base.set( [ item.x, item.y, item.z ], index * 3 );
		info.set( [ row, item.yaw, item.size, item.tint ], index * 4 );
		extra.set( [ item.cull, template.size, template.root, item.nearScale ?? 1 ], index * 4 );

	} );
	geometry.setAttribute( 'impostorBase', new THREE.InstancedBufferAttribute( base, 3 ) );
	geometry.setAttribute( 'impostorInfo', new THREE.InstancedBufferAttribute( info, 4 ) );
	geometry.setAttribute( 'impostorExtra', new THREE.InstancedBufferAttribute( extra, 4 ) );

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '远景树林·替身';
	material.fog = false;
	material.lights = false;
	material.side = THREE.DoubleSide;

	const baseNode = attribute( 'impostorBase', 'vec3' );
	const infoNode = attribute( 'impostorInfo', 'vec4' );
	const extraNode = attribute( 'impostorExtra', 'vec4' );
	const toViewer = viewer.sub( baseNode );
	const distance = length( toViewer );
	const flat = normalize( vec3( toViewer.x, 0, toViewer.z ).add( vec3( 1e-4, 0, 0 ) ) );
	// 卡片的右方向 = 竖轴 × 朝镜头的水平方向
	const right = vec3( flat.z, 0, flat.x.negate() );
	const meters = extraNode.y.mul( infoNode.z );
	// 卡片的角坐标要取几何体原始的 positionGeometry：positionLocal 在顶点着色器里会被 positionNode 的结果覆盖，
	// 传到片元的 varying 变成了世界坐标，采样落到图集外面（全透明），远处的替身一棵都没画出来（2026-10-02 审查发现 mid 档整片没树，查到这里）
	const corner = positionGeometry.xy;
	const worldPoint = baseNode.add( right.mul( corner.x.mul( meters ) ) ).add( vec3( 0, corner.y.sub( extraNode.z ).mul( meters ), 0 ) );
	const visible = keep( baseNode, extraNode.x, distance, extraNode.w );
	material.positionNode = place( worldPoint ).mul( visible ).add( viewer.mul( float( 1 ).sub( visible ) ) );

	// 镜头在树自己坐标系里的方位（烘焙时第 k 帧的相机在方位 k·45°，方向 (sin, cos)）：世界方位扣掉树的朝向
	const localAzimuth = atan( flat.x, flat.z ).sub( infoNode.y );
	const frame = mod( localAzimuth.div( Math.PI * 2 / views ), views ).add( views );
	const frameVarying = varying( frame, 'impostorFrame' );
	const rowVarying = varying( infoNode.x, 'impostorRow' );
	const yawVarying = varying( infoNode.y, 'impostorYaw' );
	const tintVarying = varying( infoNode.w, 'impostorTint' );
	const cornerVarying = varying( corner, 'impostorCorner' );
	// 每棵树不变的量（地形阴影、大气透视）在顶点里按树根算、平直插值传给片元：一张卡 4 个顶点，原来每个像素都查一遍地平线图、算一遍雾（2026-10-02 核显性能）。
	// 大气透视是颜色的仿射变换 A( c ) = c·k + b，传 A( 0 ) 和 A( 1 ) 两个颜色，片元里 c·( A( 1 ) − A( 0 ) ) + A( 0 ) 还原；看不见的卡（交给 3D 的、按距离稀疏掉的）跳过不算
	const perInstance = ( compute, fallback, name ) => varying( Fn( () => {

		const result = fallback.toVar();
		If( visible.greaterThan( 0.5 ), () => {

			result.assign( compute() );

		} );
		return result;

	} )(), name ).setInterpolation( THREE.InterpolationSamplingType.FLAT, THREE.InterpolationSamplingMode.EITHER );
	const shadowsVarying = perInstance( () => shadowsAt( baseNode ), vec2( 1, 1 ), 'impostorShadows' );
	const atmosphereZero = perInstance( () => atmosphere( vec3( 0 ), baseNode ), vec3( 0 ), 'impostorAtmosphereZero' );
	const atmosphereOne = perInstance( () => atmosphere( vec3( 1 ), baseNode ), vec3( 1 ), 'impostorAtmosphereOne' );

	material.colorNode = Fn( () => {

		const first = mod( floor( frameVarying ), views );
		const second = mod( first.add( 1 ), views );
		const blend = fract( frameVarying );
		// 图集：一行一个模板（第 0 行在图的最上面，贴图翻过 Y 以后在 v 的最上面），一列一个方位
		const local = vec2( cornerVarying.x.add( 0.5 ), cornerVarying.y );
		const v = float( 1 ).sub( rowVarying.add( 1 ).div( rows ) ).add( local.y.div( rows ) );
		const uvFirst = vec2( first.add( local.x ).div( views ), v ).toVar();
		const uvSecond = vec2( second.add( local.x ).div( views ), v ).toVar();
		// mip 级别自己算、最多取到 2.5 级：图集一格 128 像素、四周只留 4 像素边，再往上的 mip 相邻的格子互相渗，整张卡变成一块方板；
		// 保留覆盖率的 alpha 测试：取到的 mip 越高透明度被平均得越低，按级别把 alpha 放大（每级 +30%），
		// 不然远处（或核显档低分辨率）整棵树被丢掉（2026-10-02 审查：mid 档花园四周的树林整片没了）。
		// 屏幕导数在下面的分支外面先算成变量
		const texelCoordinate = uvFirst.mul( vec2( textures.color.image.width, textures.color.image.height ) );
		const footprint = max( length( dFdx( texelCoordinate ) ), length( dFdy( texelCoordinate ) ) );
		const mipLevel = min( max( log2( max( footprint, 1e-4 ) ), 0 ), 2.5 ).toVar();
		const colorSample = mix( texture( textures.color, uvFirst ).level( mipLevel ), texture( textures.color, uvSecond ).level( mipLevel ), blend ).toVar();
		const discarded = colorSample.a.mul( mipLevel.mul( 0.3 ).add( 1 ) ).lessThan( 0.5 ).toVar();
		Discard( discarded );
		// 丢掉的片元后面的法线、光照整段跳过（同近处树的叶卡）
		const outColor = vec4( 0, 0, 0, 1 ).toVar();
		If( discarded.not(), () => {

			const normalSample = mix( texture( textures.normal, uvFirst ).level( mipLevel ), texture( textures.normal, uvSecond ).level( mipLevel ), blend ).xyz.mul( 2 ).sub( 1 );
			// 树自己坐标系 → 世界：绕竖轴转树的朝向（和实例矩阵的 rotation.y 一样）
			const cosine = cos( yawVarying );
			const sine = sin( yawVarying );
			const normal = normalize( vec3( normalSample.x.mul( cosine ).add( normalSample.z.mul( sine ) ), normalSample.y, normalSample.z.mul( cosine ).sub( normalSample.x.mul( sine ) ) ) );
			// 每棵树亮一点暗一点（和近处 3D 树的 tint 一样的幅度）
			// 图集是直通 alpha、透明处扩过色（bake-foliage 的 bleed），两帧直接混 RGB 就行
			const albedo = colorSample.rgb.mul( tintVarying.sub( 0.5 ).mul( 0.3 ).add( 1 ) );
			const lit = shade( albedo, normal, shadowsVarying );
			outColor.assign( vec4( lit.mul( atmosphereOne.sub( atmosphereZero ) ).add( atmosphereZero ), 1 ) );

		} );
		return outColor;

	} )();

	const mesh = new THREE.InstancedMesh( geometry, material, allocated );
	mesh.name = '远景树林·替身';
	mesh.frustumCulled = false;
	mesh.count = allocated;
	return { mesh, geometry, material, count, missing: [ ...missing ] };

}
