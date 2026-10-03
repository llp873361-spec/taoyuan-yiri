// 开发用（不进礼物构建，只在 vite 开发服务器里打开 /tools/foliage.html）：
//   默认：把 config.trees 里的树种、变体排成一排看形状。?species=blossom,broadleaf 只看这几种；?focus=序号 近看一棵；?view=top 俯看
//   ?mode=atlas：远处树的替身图集烘焙（scripts/bake-foliage.mjs 调）。每个树种 × 变体从 8 个方位（仰角 15°）正交渲两遍：
//     反照率（乘上树冠里的遮蔽）和树自己坐标系里的法线，透明背景；window.__foliageBake 提供逐格取像素的接口
import * as THREE from 'three/webgpu';
import { uniform, float, vec3, dot, max, cameraPosition } from 'three/tsl';
import config from '../config.js';
import { buildSpeciesTemplates, buildModelBlossomTemplates, createLeafMaterial, createBarkMaterial, createTreeField, treeSpeciesHash } from '../tsl/trees.js';

// 和远景同一套：花树（spec.models）用樱花模型的树干 + 程序化花簇，读不到退回程序化树形
async function templatesOf( name, spec ) {

	if ( spec.models ) {

		const built = await buildModelBlossomTemplates( spec, spec.forms ? spec.forms.length : config.trees.variants );
		if ( built ) {

			if ( built.barkMap ) built.barkMap.dispose();
			return built.templates;

		}

		console.warn( `开发页：树种「${ name }」的模型读不到，用程序化树形` );

	}

	return buildSpeciesTemplates( name, spec, config.trees.variants );

}

const params = new URLSearchParams( location.search );
const bakeAtlas = params.get( 'mode' ) === 'atlas';
const wanted = ( params.get( 'species' ) || Object.keys( config.trees.species ).join( ',' ) ).split( ',' );
const width = Number( params.get( 'width' ) || 1600 );
const height = Number( params.get( 'height' ) || 900 );

const renderer = new THREE.WebGPURenderer( { antialias: true, forceWebGL: params.get( 'webgl' ) === '1' } );
renderer.setSize( width, height );
renderer.setPixelRatio( 1 );
document.body.appendChild( renderer.domElement );
await renderer.init();

const colorOf = ( hex ) => vec3( ...new THREE.Color( hex ).toArray() );
const paletteOf = ( spec ) => ( { dark: colorOf( spec.colors[ 0 ] ), mid: colorOf( spec.colors[ 1 ] ), light: colorOf( spec.colors[ 2 ] ) } );

if ( bakeAtlas ) await runAtlasBake();
else await runPreview();

// ===================== 排队看形状 =====================
async function runPreview() {

	const scene = new THREE.Scene();
	scene.background = new THREE.Color( '#b9c9dc' );
	const camera = new THREE.PerspectiveCamera( 30, width / height, 0.5, 2000 );

	// 光照：太阳包裹漫反射 + 天空半球，够看形状
	const sunDirection = uniform( new THREE.Vector3( 0.55, 0.62, 0.35 ).normalize() );
	const sunColor = uniform( new THREE.Color( 1.0, 0.95, 0.85 ) );
	const skyColor = vec3( 0.42, 0.5, 0.62 );
	const shade = ( albedo, normal, point, { skyView, wrap } ) => {

		const diffuse = max( dot( normal, sunDirection ).add( wrap ), 0 ).div( float( 1 ).add( wrap ) );
		return albedo.mul( sunColor.mul( diffuse ).add( skyColor.mul( skyView ) ) );

	};

	const uniforms = {
		time: uniform( 0 ),
		near: uniform( 5000 ),   // 每个网格第 0 个实例藏在地下一万米（trees.js），near 要比一万小，不然它会画在原点
		band: uniform( 1 ),
		sceneToWorld: uniform( new THREE.Matrix4() ),
		viewer: cameraPosition,
		toggle: uniform( 1 ),
		sunDirection,
		sunColor,
	};

	const templates = {};
	const materials = {};
	const items = [];
	let x = 0;
	let triangles = 0;
	const report = [];
	for ( const name of wanted ) {

		const spec = config.trees.species[ name ];
		if ( ! spec ) {

			console.warn( `开发页：没有树种「${ name }」` );
			continue;

		}

		templates[ name ] = await templatesOf( name, spec );
		materials[ name ] = {
			leaves: createLeafMaterial( { name: name + '·树叶', palette: paletteOf( spec ), uniforms, shade, style: spec.cardStyle || 'leaf' } ),
			bark: createBarkMaterial( { name: name + '·树皮', barkColor: colorOf( spec.bark ), barkTexture: null, uniforms, shade } ),
		};
		templates[ name ].forEach( ( template, variant ) => {

			const count = ( template.bark.index.count + template.leaves.index.count ) / 3;
			triangles += count;
			report.push( `${ name }·${ variant }：${ count.toFixed( 0 ) } 三角，高 ${ template.height.toFixed( 1 ) } 米` );
			items.push( { x, y: 0, z: 0, size: 1, yaw: 0.6, tint: ( variant + 0.5 ) / templates[ name ].length, cull: 0, species: name, variant } );
			x += 11;

		} );

	}

	const field = createTreeField( { items, templates, materials, settings: { near: uniforms.near, band: uniforms.band, refreshDistance: 1, maxPerMesh: 4096 }, uniforms } );
	scene.add( field.group );
	field.update( new THREE.Vector3( x / 2, 0, 0 ), true );

	const ground = new THREE.Mesh( new THREE.PlaneGeometry( 4000, 4000 ), new THREE.MeshBasicNodeMaterial( { color: '#7f9c63' } ) );
	ground.rotation.x = - Math.PI / 2;
	scene.add( ground );

	const span = Math.max( 11, x );
	const focus = params.has( 'focus' ) ? items[ Number( params.get( 'focus' ) ) ] : null;
	if ( focus ) {

		// 近看一棵：离 13 米、略仰
		camera.fov = 40;
		camera.updateProjectionMatrix();
		camera.position.set( focus.x + 4, 2.2, 13 );
		camera.lookAt( focus.x, 4, 0 );

	} else if ( params.get( 'view' ) === 'top' ) {

		camera.position.set( span / 2 - 5.5, span * 1.4, 30 );
		camera.lookAt( span / 2 - 5.5, 0, 0 );

	} else {

		camera.fov = 26;
		camera.updateProjectionMatrix();
		camera.position.set( span / 2 - 5.5, 6, span * 1.55 );
		camera.lookAt( span / 2 - 5.5, 5, 0 );

	}

	await renderer.compileAsync( scene, camera );
	renderer.render( scene, camera );
	console.log( `开发页：${ items.length } 棵，共 ${ triangles.toFixed( 0 ) } 三角\n` + report.join( '\n' ) );
	window.__foliageReady = true;

}

// ===================== 替身图集烘焙 =====================
async function runAtlasBake() {

	const tileSize = Number( params.get( 'tile' ) || 256 );   // 渲染的格子边长（脚本里再缩一半，等于 2×2 超采样）
	const elevation = 15 * Math.PI / 180;
	const views = 8;
	const zeroSun = uniform( new THREE.Color( 0, 0, 0 ) );     // 叶子的逆光项乘太阳色：烘焙时关掉
	const passUniform = uniform( 0 );                          // 0 反照率、1 法线
	// shade 换成输出烘焙要的东西：反照率乘树冠里的遮蔽（团里面、树冠下部暗，运行时没法再算），或者法线编码成 0~1
	const shade = ( albedo, normal, point, { skyView } ) => {

		const occluded = albedo.mul( skyView.mul( 0.55 ).add( 0.45 ) );
		const encoded = normal.mul( 0.5 ).add( 0.5 );
		return occluded.mul( float( 1 ).sub( passUniform ) ).add( encoded.mul( passUniform ) );

	};

	const uniforms = {
		time: uniform( 0 ),
		near: uniform( 5000 ),
		band: uniform( 1 ),
		sceneToWorld: uniform( new THREE.Matrix4() ),
		viewer: cameraPosition,
		toggle: uniform( 1 ),
		sunDirection: uniform( new THREE.Vector3( 0, 1, 0 ) ),
		sunColor: zeroSun,
	};

	const scene = new THREE.Scene();
	scene.background = null;
	const camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0.1, 400 );
	const target = new THREE.RenderTarget( tileSize, tileSize, { samples: 4 } );
	renderer.setClearColor( 0x000000, 0 );

	// 每个模板一对网格（树皮、树叶），实例数 1，实例数据：树根在原点、色相随机数 0.5、远近随机数 0、大小 1
	const entries = [];
	for ( const name of Object.keys( config.trees.species ) ) {

		const spec = config.trees.species[ name ];
		const templates = await templatesOf( name, spec );
		const leafMaterial = createLeafMaterial( { name: name + '·烘焙·树叶', palette: paletteOf( spec ), uniforms, shade, style: spec.cardStyle || 'leaf' } );
		const barkMaterial = createBarkMaterial( { name: name + '·烘焙·树皮', barkColor: colorOf( spec.bark ), barkTexture: null, uniforms, shade } );
		templates.forEach( ( template, variant ) => {

			const group = new THREE.Group();
			for ( const [ geometry, material ] of [ [ template.bark, barkMaterial ], [ template.leaves, leafMaterial ] ] ) {

				geometry.setAttribute( 'treeBase', new THREE.InstancedBufferAttribute( new Float32Array( [ 0, 0, 0 ] ), 3 ) );
				geometry.setAttribute( 'treeInfo', new THREE.InstancedBufferAttribute( new Float32Array( [ 0.5, 0, 1, 0.5 ] ), 4 ) );
				const mesh = new THREE.InstancedMesh( geometry, material, 1 );
				mesh.setMatrixAt( 0, new THREE.Matrix4() );
				mesh.frustumCulled = false;
				group.add( mesh );

			}

			// 包围：水平半径取所有顶点到竖轴的最远距离（转一圈都框得住），竖直范围取最高最低
			let radius = 0;
			let top = 0;
			let bottom = 0;
			for ( const geometry of [ template.bark, template.leaves ] ) {

				const position = geometry.attributes.position;
				for ( let i = 0; i < position.count; i ++ ) {

					radius = Math.max( radius, Math.hypot( position.getX( i ), position.getZ( i ) ) );
					top = Math.max( top, position.getY( i ) );
					bottom = Math.min( bottom, position.getY( i ) );

				}

			}

			entries.push( { name, variant, group, radius: radius * 1.04, top, bottom: Math.max( bottom, - 0.6 ) } );

		} );

	}

	// 一个方位的正交相机：框住包围柱（半径 r、高 bottom~top）在这个方位的投影；树根（原点）在格子里的竖直位置记下来，运行时卡片按它对齐树根
	const cameraUp = new THREE.Vector3();
	function frame( entry, view ) {

		const azimuth = view / views * Math.PI * 2;
		const center = new THREE.Vector3( 0, ( entry.top + entry.bottom ) / 2, 0 );
		const direction = new THREE.Vector3( Math.sin( azimuth ) * Math.cos( elevation ), Math.sin( elevation ), Math.cos( azimuth ) * Math.cos( elevation ) );
		camera.position.copy( center ).addScaledVector( direction, 200 );
		camera.up.set( 0, 1, 0 );
		camera.lookAt( center );
		camera.updateMatrixWorld();
		cameraUp.set( 0, 1, 0 ).applyQuaternion( camera.quaternion );
		// 柱子的竖直投影：上下两个圆在相机上方向上各自 ±r·sin(仰角)
		const halfHeight = ( entry.top - entry.bottom ) / 2 * Math.cos( elevation ) + entry.radius * Math.sin( elevation );
		const half = Math.max( entry.radius, halfHeight );
		camera.left = - half;
		camera.right = half;
		camera.top = half;
		camera.bottom = - half;
		camera.updateProjectionMatrix();
		const rootOffset = new THREE.Vector3( 0, 0, 0 ).sub( center ).dot( cameraUp );
		return { half, root: 0.5 + rootOffset / ( 2 * half ) };

	}

	const info = entries.map( ( entry ) => {

		const { half, root } = frame( entry, 0 );
		return { species: entry.name, variant: entry.variant, size: half * 2, root };

	} );

	// 预编译（compileAsync 的第三个参数是目标场景，不是渲染目标：先把渲染目标设上再编，格式对得上）
	renderer.setRenderTarget( target );
	for ( const entry of entries ) {

		scene.add( entry.group );
		frame( entry, 0 );
		await renderer.compileAsync( scene, camera );
		scene.remove( entry.group );

	}

	renderer.setRenderTarget( null );

	window.__foliageBake = {
		info,
		views,
		tileSize,
		elevation: 15,
		hash: treeSpeciesHash( config.trees.species, config.trees.variants ),
		// 第 index 个模板、第 view 个方位、第 pass 遍（0 反照率、1 法线）→ base64 的 RGBA8（tileSize²，行从下往上）
		async tile( index, view, pass ) {

			const entry = entries[ index ];
			passUniform.value = pass;
			scene.add( entry.group );
			frame( entry, view );
			renderer.setRenderTarget( target );
			renderer.clear();
			renderer.render( scene, camera );
			renderer.setRenderTarget( null );
			scene.remove( entry.group );
			const pixels = await renderer.readRenderTargetPixelsAsync( target, 0, 0, tileSize, tileSize );
			const bytes = new Uint8Array( pixels.buffer, pixels.byteOffset, pixels.byteLength );
			let binary = '';
			for ( let i = 0; i < bytes.length; i += 32768 ) binary += String.fromCharCode( ...bytes.subarray( i, i + 32768 ) );
			return btoa( binary );

		},
	};
	console.log( `替身烘焙：${ entries.length } 个模板 × ${ views } 个方位，格子 ${ tileSize } 像素` );
	window.__foliageReady = true;

}
