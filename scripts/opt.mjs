// 素材处理：assets/raw 里的模型、贴图、音频 → 压缩后放到 assets/opt。规则见 CLAUDE.md 12.2，API 依据 reference/notes/assets-and-build.md 第 8 节。
//
// 两条路：
//   1. 配方表（下面的 recipes）：每个外部素材一条，按表简化、压缩，产物写进 assets/opt/models/、assets/opt/textures/
//      和它们各自的 manifest.json（{ version: 1, files: [{ id, file, mime, bytes }], items: [...] }），
//      vite.config.js 按清单把每个文件内联成数据块，运行时 src/core/assets.js 读。
//   2. 通用处理：配方表没管到的散装 glb/gltf、png/jpg（不在配方用到的目录里），照旧压到 assets/opt 下。
// 最后校验 assets/credits.json：每个配方、每个产物都要有署名，代码条目字段也要齐。
//
// 用法：node scripts/opt.mjs [--only=名字,名字] [--ratio=0.5] [--small] [--check-credits-only]
//   --only=   只跑配方表里这几项（配方的 name），清单里其他项保留上次的结果
//   --ratio=  通用处理的 simplify 保留比例（默认 0.5）；文件名含 ".keep." 的模型跳过简化
//   --small   通用处理的贴图最长边限制 1024（默认 2048）
//   --check-credits-only  只校验 credits.json

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import {
	dedup, weld, simplify, meshopt, textureCompress, prune, resample,
	cloneDocument, clearNodeParent, transformMesh, getBounds, listTextureSlots,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const projectRoot = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const rawDir = path.join( projectRoot, 'assets', 'raw' );
const optDir = path.join( projectRoot, 'assets', 'opt' );
const creditsPath = path.join( projectRoot, 'assets', 'credits.json' );

// ===================== 配方表 =====================
//
// 字段（没写的取 recipeDefaults）：
//   name             配方名，--only= 用它；模型的产物编号默认也是它
//   credit           credits.json 里署名条目的 id（同一个素材包的几个配方共用一条）
//   kind             'model'：glb 模型；'textureSet'：一组平铺贴图（diff / nor / arm 三张）
//   input            assets/raw 下的路径：模型是 .gltf / .glb 文件；贴图组是目录，里面找 *_diff_*、*_nor_gl_*、*_arm_*
//   output           产物编号：模型写成 models/<output>.glb（数据块 data-models-<output>），
//                    贴图组写成 textures/<output>-diff.webp、-nor.webp、-arm.webp（数据块 data-textures-<output>-diff ……）
//   targetTriangles  简化目标三角数（和 simplifyRatio 二选一；都不写就不简化）
//   simplifyRatio    简化保留比例（0~1）
//   simplifyError    简化允许的误差（占模型半径的比例）。到不了目标就每次放宽 3 倍，最多放到 maxSimplifyError
//   lods             额外的低模，每个数是相对 LOD0 三角数的比例，依次写成 <output>-lod1、<output>-lod2 ……；
//                    低模的贴图边长每级减半（远处用不着那么细），最小 256
//   splitNodes       按节点名拆成几个独立模型：[{ node: '节点名', output: '编号' }]，每个各自简化、各自归位
//   keepMaps         保留的贴图槽：baseColor / normal / metallicRoughness / occlusion / emissive。
//                    世界材质（assets.js 的 convertToWorldMaterial）只用底色和法线，默认只留这两个，省一半体积
//   maxTextureSize   贴图最长边上限（像素）
//   webpQuality      WebP 质量：albedo 颜色图 85、normal 法线图 92（法线图开 smartSubsample，减轻 4:2:0 色度下采样带来的法线偏差）、
//                    data 其他数据图（ARM / 粗糙度）90
//   scaleToMetres    整体缩放到米（Poly Haven、Quaternius 都已经是米，填 1）
//   recenter         'base'：包围盒底面中心挪到原点（放到地上就是贴地）；'none'：保留作者的原点
//   keepVertexColors 保留顶点色 COLOR_0。glTF 规范里顶点色乘到底色上（assets.js 也照乘）：
//                    Quaternius 的草、蕨、花茎底部是黑→白渐变，相当于烘好的根部压暗；岩石、蘑菇没有顶点色
const recipeDefaults = {
	credit: null,
	targetTriangles: null,
	simplifyRatio: null,
	simplifyError: 0.002,
	maxSimplifyError: 0.05,
	lods: [],
	splitNodes: null,
	keepMaps: [ 'baseColor', 'normal' ],
	maxTextureSize: 1024,
	webpQuality: { albedo: 85, normal: 92, data: 90 },
	scaleToMetres: 1,
	recenter: 'base',
	keepVertexColors: true,
};

// Quaternius Stylized Nature MegaKit（CC0）里用到的模型：低模，不简化，保留作者原点（模型底部故意埋进地里一点）
const quaterniusModels = [
	'Bush_Common', 'Bush_Common_Flowers', 'Fern_1', 'Flower_3_Group', 'Flower_4_Group',
	'Grass_Common_Tall', 'Grass_Wispy_Tall', 'Clover_1', 'Plant_1', 'Plant_7',
	'Pebble_Round_1', 'Pebble_Round_2', 'Pebble_Round_3',
	'Rock_Medium_1', 'Rock_Medium_2', 'Rock_Medium_3', 'RockPath_Round_Wide', 'Mushroom_Common',
];

// rock_moss_set_01 一个文件里摆了 6 块石头，按节点拆开，各自归位到原点
const mossRockNodes = [ 1, 2, 3, 4, 5, 6 ].map( ( index ) => ( {
	node: `rock_moss_set_01_rock0${ index }`,
	output: `rock_moss_set_01-rock0${ index }`,
} ) );

const recipes = [
	// ---------- Poly Haven 扫描模型（CC0）：原始几万到几十万三角，按用途减到几千到几万 ----------
	// rock_09 是一颗 7 厘米的小卵石（原尺寸），12416 三角 → 6000
	{ name: 'rock_09', credit: 'polyhaven/rock_09', kind: 'model', input: 'polyhaven/rock_09/rock_09_2k.gltf', output: 'rock_09', targetTriangles: 6000 },
	// 约 1.3 × 0.9 × 1.8 米的大石头，66122 → 10000
	{ name: 'boulder_01', credit: 'polyhaven/boulder_01', kind: 'model', input: 'polyhaven/boulder_01/boulder_01_2k.gltf', output: 'boulder_01', targetTriangles: 10000, lods: [ 0.3 ] },
	// 约 2.5 × 0.9 × 1.2 米的扁平巨石，97964 → 10000
	{ name: 'namaqualand_boulder_02', credit: 'polyhaven/namaqualand_boulder_02', kind: 'model', input: 'polyhaven/namaqualand_boulder_02/namaqualand_boulder_02_2k.gltf', output: 'namaqualand_boulder_02', targetTriangles: 10000, lods: [ 0.3 ] },
	// 约 4 × 1.3 × 3.7 米的海边礁石群，771724 → 25000（细节交给法线图）
	{ name: 'coast_rocks_05', credit: 'polyhaven/coast_rocks_05', kind: 'model', input: 'polyhaven/coast_rocks_05/coast_rocks_05_2k.gltf', output: 'coast_rocks_05', targetTriangles: 25000 },
	// 约 2.7 × 2.5 米的一面岩壁，29566 → 12000
	{ name: 'rock_face_02', credit: 'polyhaven/rock_face_02', kind: 'model', input: 'polyhaven/rock_face_02/rock_face_02_2k.gltf', output: 'rock_face_02', targetTriangles: 12000 },
	// 约 10 × 10.5 米的一段山坡崖面，153472 → 40000，外加 1/4 的远景低模
	{ name: 'mountainside', credit: 'polyhaven/mountainside', kind: 'model', input: 'polyhaven/mountainside/mountainside_2k.gltf', output: 'mountainside', targetTriangles: 40000, lods: [ 0.25 ] },
	// 6 块长苔的石头，合计 63127 三角，每块 → 3000；这套没有 ARM，粗糙度单独一张（默认也不留）
	{ name: 'rock_moss_set_01', credit: 'polyhaven/rock_moss_set_01', kind: 'model', input: 'polyhaven/rock_moss_set_01/rock_moss_set_01_2k.gltf', output: 'rock_moss_set_01', targetTriangles: 3000, splitNodes: mossRockNodes },

	// ---------- Poly Haven 平铺贴图组（CC0）：2k JPG → 1024 WebP，法线图按原值存（不做 sRGB 转换） ----------
	{ name: 'aerial_grass_rock', credit: 'polyhaven/aerial_grass_rock', kind: 'textureSet', input: 'polyhaven/aerial_grass_rock', output: 'aerial_grass_rock' },
	{ name: 'forrest_ground_01', credit: 'polyhaven/forrest_ground_01', kind: 'textureSet', input: 'polyhaven/forrest_ground_01', output: 'forrest_ground_01' },
	{ name: 'rocky_terrain_02', credit: 'polyhaven/rocky_terrain_02', kind: 'textureSet', input: 'polyhaven/rocky_terrain_02', output: 'rocky_terrain_02' },
	{ name: 'coast_sand_01', credit: 'polyhaven/coast_sand_01', kind: 'textureSet', input: 'polyhaven/coast_sand_01', output: 'coast_sand_01' },
	{ name: 'bark_willow_02', credit: 'polyhaven/bark_willow_02', kind: 'textureSet', input: 'polyhaven/bark_willow_02', output: 'bark_willow_02' },

	// ---------- 哥特城堡（CC BY 4.0 零件包，scripts/blender/gothic-castle.py 在 Blender 里拼好、减好面、烘好 AO、窗户编好号，输出到 assets/raw/built/）：
	// 只压缩、贴图转 WebP；不再简化（窗玻璃的 _WINDOW 属性要原样留着），原点就是城堡底面中心。远景替身的贴图 256 就够
	...[ 'gothic-castle', 'gothic-castle-lod1', 'gothic-castle-lod2' ].map( ( name ) => ( {
		name,
		credit: 'sketchfab/gothic-aria-kit',
		kind: 'model',
		input: `built/${ name }.glb`,
		output: name,
		recenter: 'none',
		maxTextureSize: name.endsWith( 'lod2' ) ? 256 : 1024,
	} ) ),

	// ---------- 花园城堡（Gokul.Saravanappriyan 的 Taj mahal，CC BY 4.0；scripts/blender/taj-castle.py 在 Blender 里缩放、减成三级、烘好 AO、分出银顶）：
	// 只压缩，原点就是台基底面中心；没有贴图
	...[ 'taj-castle', 'taj-castle-lod1', 'taj-castle-lod2' ].map( ( name ) => ( {
		name,
		credit: 'sketchfab/taj-gokul',
		kind: 'model',
		input: `built/${ name }.glb`,
		output: name,
		recenter: 'none',
	} ) ),

	// ---------- 焦点樱花树（RosticOstafi 的 Tree Sakura、Sakura，CC BY 4.0；scripts/blender/sakura-focal.py 取树干、把叶片卡换成花位）：
	// 只压缩，原点就是树根；树皮贴图 1024。sakura-forest-* 是树干减到约 2800 三角的那一份（同一个脚本出），远景树林里成片的花树用它
	// （2026-10-02 用户要把程序化的花树全换掉；meshopt 的简化器减不动：花位是几千个不连着的小三角形）
	...[ [ 'sakura-focal-a', 'sketchfab/sakura-rostic-tree' ], [ 'sakura-focal-b', 'sketchfab/sakura-rostic' ],
		[ 'sakura-forest-a', 'sketchfab/sakura-rostic-tree' ], [ 'sakura-forest-b', 'sketchfab/sakura-rostic' ] ].map( ( [ name, credit ] ) => ( {
		name,
		credit,
		kind: 'model',
		input: `built/${ name }.glb`,
		output: name,
		recenter: 'none',
	} ) ),

	// ---------- Quaternius Stylized Nature MegaKit（CC0）：贴图在 glTF 目录里，限制到 1024 ----------
	...quaterniusModels.map( ( name ) => ( {
		name: name.toLowerCase(),
		credit: 'quaternius/stylized-nature-megakit',
		kind: 'model',
		input: `quaternius/nature-megakit/glTF/${ name }.gltf`,
		output: name.toLowerCase(),
		recenter: 'none',
	} ) ),
];

// ===================== 命令行 =====================

const options = { ratio: 0.5, maxSize: 2048, checkCreditsOnly: false, only: null };
for ( const arg of process.argv.slice( 2 ) ) {

	if ( arg.startsWith( '--ratio=' ) ) {

		options.ratio = Number( arg.slice( '--ratio='.length ) );
		if ( ! ( options.ratio > 0 && options.ratio <= 1 ) ) {

			console.error( '--ratio 必须在 (0, 1] 之间，收到：' + arg );
			process.exit( 1 );

		}

	} else if ( arg === '--small' ) {

		options.maxSize = 1024;

	} else if ( arg === '--check-credits-only' ) {

		options.checkCreditsOnly = true;

	} else if ( arg.startsWith( '--only=' ) ) {

		options.only = new Set( arg.slice( '--only='.length ).split( ',' ).map( ( item ) => item.trim() ).filter( Boolean ) );
		const unknown = [ ...options.only ].filter( ( name ) => ! recipes.some( ( recipe ) => recipe.name === name ) );
		if ( unknown.length > 0 ) {

			console.error( '--only 里有配方表里没有的名字：' + unknown.join( '、' ) );
			process.exit( 1 );

		}

	} else {

		console.error( '不认识的参数：' + arg );
		process.exit( 1 );

	}

}

// ===================== 小工具 =====================

function walk( dir, filter, skipDirNames ) {

	const found = [];
	if ( ! fs.existsSync( dir ) ) return found;
	for ( const entry of fs.readdirSync( dir, { withFileTypes: true } ) ) {

		const full = path.join( dir, entry.name );
		if ( entry.isDirectory() ) {

			if ( skipDirNames && skipDirNames.includes( entry.name ) ) continue;
			found.push( ...walk( full, filter, skipDirNames ) );

		} else if ( filter( entry.name ) ) {

			found.push( full );

		}

	}

	return found;

}

function formatBytes( bytes ) {

	if ( bytes >= 1024 * 1024 ) return ( bytes / 1024 / 1024 ).toFixed( 2 ) + ' MB';
	return ( bytes / 1024 ).toFixed( 1 ) + ' KB';

}

function mimeOf( file ) {

	if ( /\.glb$/i.test( file ) ) return 'model/gltf-binary';
	if ( /\.webp$/i.test( file ) ) return 'image/webp';
	return 'application/octet-stream';

}

// 三角数：每个 TRIANGLES 图元的索引数 / 3，没索引就用顶点数
function countTriangles( document ) {

	let total = 0;
	for ( const mesh of document.getRoot().listMeshes() ) {

		for ( const primitive of mesh.listPrimitives() ) {

			if ( primitive.getMode() !== 4 ) continue;
			const indices = primitive.getIndices();
			const position = primitive.getAttribute( 'POSITION' );
			const count = indices ? indices.getCount() : ( position ? position.getCount() : 0 );
			total += count / 3;

		}

	}

	return Math.round( total );

}

// .gltf 连同它引用的 .bin 和贴图一共多大（处理前的体积）
function sourceBytesOf( file ) {

	let total = fs.statSync( file ).size;
	if ( ! /\.gltf$/i.test( file ) ) return total;
	const json = JSON.parse( fs.readFileSync( file, 'utf8' ) );
	const uris = new Set( [ ...( json.buffers || [] ), ...( json.images || [] ) ].map( ( item ) => item.uri ).filter( ( uri ) => uri && ! uri.startsWith( 'data:' ) ) );
	for ( const uri of uris ) {

		const resource = path.join( path.dirname( file ), decodeURIComponent( uri ) );
		if ( fs.existsSync( resource ) ) total += fs.statSync( resource ).size;

	}

	return total;

}

function readJson( file, fallback ) {

	if ( ! fs.existsSync( file ) ) return fallback;
	return JSON.parse( fs.readFileSync( file, 'utf8' ) );

}

const roundTo = ( value ) => Math.round( value * 1000 ) / 1000;

// gltf-transform 默认把每一步 prune 的结果都打出来（INFO），太吵；只留警告。复制出来的文档也要单独设
const quietLogger = new Logger( Logger.Verbosity.WARN );
const quietClone = ( document ) => cloneDocument( document ).setLogger( quietLogger );

// ===================== 模型配方 =====================

// 只留下指定名字的那个带网格的节点（拆 rock_moss_set_01 用），其余带网格的节点删掉
function isolateNode( document, nodeName ) {

	const nodes = document.getRoot().listNodes();
	if ( ! nodes.some( ( node ) => node.getName() === nodeName ) ) throw new Error( `找不到节点「${ nodeName }」` );
	for ( const node of nodes ) {

		if ( node.getMesh() && node.getName() !== nodeName ) node.dispose();

	}

}

// 把节点层级的变换（和整体缩放）烘进顶点，所有网格节点直接挂在场景下、变换归零。
// 这样归位、包围盒、简化误差都在同一个坐标系里算，运行时拿到的也是干净的模型
function bakeNodeTransforms( document, scale ) {

	const root = document.getRoot();
	const scene = root.getDefaultScene() || root.listScenes()[ 0 ];
	const meshNodes = [];
	scene.traverse( ( node ) => {

		if ( node.getMesh() ) meshNodes.push( node );

	} );

	const worldMatrices = meshNodes.map( ( node ) => node.getWorldMatrix().slice() );
	meshNodes.forEach( ( node, i ) => {

		clearNodeParent( node );
		const matrix = worldMatrices[ i ];
		// 左乘均匀缩放：列主序矩阵的前三行都乘 scale
		for ( const index of [ 0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14 ] ) matrix[ index ] *= scale;
		// 同一个网格挂在两个节点上时先复制一份，免得被变换两次
		const nodeParents = node.getMesh().listParents().filter( ( parent ) => parent.propertyType === 'Node' );
		if ( nodeParents.length > 1 ) node.setMesh( node.getMesh().clone() );
		transformMesh( node.getMesh(), matrix );
		node.setTranslation( [ 0, 0, 0 ] ).setRotation( [ 0, 0, 0, 1 ] ).setScale( [ 1, 1, 1 ] );

	} );

}

// 归位：'base' 把包围盒底面中心挪到原点
function recenterDocument( document, mode ) {

	if ( mode !== 'base' ) return;
	const scene = document.getRoot().getDefaultScene() || document.getRoot().listScenes()[ 0 ];
	const { min, max } = getBounds( scene );
	const offset = [ - ( min[ 0 ] + max[ 0 ] ) / 2, - min[ 1 ], - ( min[ 2 ] + max[ 2 ] ) / 2 ];
	const matrix = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, offset[ 0 ], offset[ 1 ], offset[ 2 ], 1 ];
	for ( const mesh of document.getRoot().listMeshes() ) transformMesh( mesh, matrix );

}

const mapSetters = {
	baseColor: ( material ) => material.setBaseColorTexture( null ),
	normal: ( material ) => material.setNormalTexture( null ),
	metallicRoughness: ( material ) => material.setMetallicRoughnessTexture( null ),
	occlusion: ( material ) => material.setOcclusionTexture( null ),
	emissive: ( material ) => material.setEmissiveTexture( null ),
};

// 扫描模型常见：同一个位置、同一个 UV 的两个顶点，法线只差小数点后几位（导出时的数值误差，boulder_01 有一半顶点是这样，夹角都不到 0.5°）。
// weld 只合并完全相同的顶点，简化器又把这种顶点当属性接缝锁死，三角数就减不下去。
// 其他属性全相同、法线夹角小于 maxAngleDegrees 的顶点统一用第一次出现的那个法线，weld 就能把它们合成一个；真正的硬边（夹角大）不动
function unifyNearlyEqualNormals( document, maxAngleDegrees ) {

	const minDot = Math.cos( maxAngleDegrees * Math.PI / 180 );
	let unified = 0;
	for ( const mesh of document.getRoot().listMeshes() ) {

		for ( const primitive of mesh.listPrimitives() ) {

			const normalAccessor = primitive.getAttribute( 'NORMAL' );
			if ( ! normalAccessor || ! ( normalAccessor.getArray() instanceof Float32Array ) ) continue;
			const normal = normalAccessor.getArray();
			const others = primitive.listSemantics().filter( ( semantic ) => semantic !== 'NORMAL' && semantic !== 'TANGENT' ).map( ( semantic ) => primitive.getAttribute( semantic ) );
			const firstIndex = new Map();
			const element = [];
			for ( let i = 0; i < normalAccessor.getCount(); i ++ ) {

				const key = others.map( ( accessor ) => accessor.getElement( i, element ).join( ',' ) ).join( '|' );
				const firstVertex = firstIndex.get( key );
				if ( firstVertex === undefined ) {

					firstIndex.set( key, i );
					continue;

				}

				const cosine = normal[ i * 3 ] * normal[ firstVertex * 3 ] + normal[ i * 3 + 1 ] * normal[ firstVertex * 3 + 1 ] + normal[ i * 3 + 2 ] * normal[ firstVertex * 3 + 2 ];
				if ( cosine < minDot ) continue;
				normal[ i * 3 ] = normal[ firstVertex * 3 ];
				normal[ i * 3 + 1 ] = normal[ firstVertex * 3 + 1 ];
				normal[ i * 3 + 2 ] = normal[ firstVertex * 3 + 2 ];
				unified ++;

			}

		}

	}

	return unified;

}

// 去掉配方不要的贴图槽和顶点色（之后的 prune 会把没人用的贴图、属性清掉）
function stripUnused( document, recipe ) {

	for ( const material of document.getRoot().listMaterials() ) {

		for ( const [ slot, clear ] of Object.entries( mapSetters ) ) {

			if ( ! recipe.keepMaps.includes( slot ) ) clear( material );

		}

	}

	if ( recipe.keepVertexColors ) return;
	for ( const mesh of document.getRoot().listMeshes() ) {

		for ( const primitive of mesh.listPrimitives() ) {

			if ( primitive.getAttribute( 'COLOR_0' ) ) primitive.setAttribute( 'COLOR_0', null );

		}

	}

}

// 简化到目标三角数：误差上限卡住就放宽 3 倍再试，最多放到 maxSimplifyError。返回简化后的新文档和用到的误差
async function simplifyToTarget( document, targetTriangles, recipe ) {

	const current = countTriangles( document );
	if ( ! targetTriangles || current <= targetTriangles ) return { document, error: 0 };
	let error = recipe.simplifyError;
	for ( ;; ) {

		const trial = quietClone( document );
		await trial.transform( simplify( { simplifier: MeshoptSimplifier, ratio: targetTriangles / current, error } ) );
		const reached = countTriangles( trial );
		if ( reached <= targetTriangles * 1.1 || error >= recipe.maxSimplifyError ) {

			if ( reached > targetTriangles * 1.1 ) console.log( `    注意：误差放到 ${ error } 还是只简化到 ${ reached } 三角（目标 ${ targetTriangles }）` );
			return { document: trial, error };

		}

		error = Math.min( error * 3, recipe.maxSimplifyError );

	}

}

// 模型里的贴图转 WebP。不用 textureCompress：要按槽位给不同质量、法线图开 smartSubsample、数据图不让 sharp 按 ICC 转色、
// 镂空贴图保留透明像素的颜色（exact，避免 mipmap 后叶子边缘发黑）
async function encodeModelTextures( document, recipe, maxSize ) {

	const root = document.getRoot();
	const textures = root.listTextures();
	if ( textures.length === 0 ) return;
	document.createExtension( EXTTextureWebP ).setRequired( true );
	for ( const texture of textures ) {

		const slots = listTextureSlots( texture );
		const isNormal = slots.some( ( slot ) => /normal/i.test( slot ) );
		const isColor = slots.some( ( slot ) => /baseColor|emissive|diffuse|sheenColor|specularColor/i.test( slot ) );
		const usesAlpha = root.listMaterials().some( ( material ) => material.getBaseColorTexture() === texture && material.getAlphaMode() !== 'OPAQUE' );
		const quality = isNormal ? recipe.webpQuality.normal : ( isColor ? recipe.webpQuality.albedo : recipe.webpQuality.data );
		let pipeline = sharp( Buffer.from( texture.getImage() ), { ignoreIcc: ! isColor } )
			.resize( { width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true } );
		if ( ! usesAlpha ) pipeline = pipeline.removeAlpha();
		const encoded = await pipeline.webp( { quality, alphaQuality: 100, smartSubsample: ! isColor, exact: usesAlpha, effort: 5 } ).toBuffer();
		const baseName = ( texture.getName() || path.basename( texture.getURI() || 'texture', path.extname( texture.getURI() || '' ) ) ).replace( /[^\w.-]+/g, '_' );
		texture.setImage( new Uint8Array( encoded ) ).setMimeType( 'image/webp' ).setURI( baseName + '.webp' );

	}

}

function textureSummary( document ) {

	return document.getRoot().listTextures().map( ( texture ) => {

		const size = texture.getSize();
		return `${ listTextureSlots( texture ).join( '/' ).replace( /Texture/g, '' ) } ${ size ? size.join( '×' ) : '?' }`;

	} );

}

// 写一个 glb（meshopt 压缩），返回清单条目
async function writeModel( io, document, recipe, info ) {

	const scene = document.getRoot().getDefaultScene() || document.getRoot().listScenes()[ 0 ];
	const { min, max } = getBounds( scene );
	const triangles = countTriangles( document );
	const maps = textureSummary( document );
	await document.transform( prune(), meshopt( { encoder: MeshoptEncoder, level: 'medium' } ) );
	const file = info.id + '.glb';
	const outPath = path.join( optDir, 'models', file );
	fs.mkdirSync( path.dirname( outPath ), { recursive: true } );
	await io.write( outPath, document );
	const bytes = fs.statSync( outPath ).size;
	return {
		id: info.id,
		file,
		recipe: recipe.name,
		credit: recipe.credit,
		source: recipe.input,
		node: info.node || null,
		lod: info.lod,
		lodOf: info.lod > 0 ? info.baseId : null,
		triangles,
		sourceTriangles: info.sourceTriangles,
		simplifyError: info.error,
		bounds: { min: min.map( roundTo ), max: max.map( roundTo ), size: max.map( ( value, i ) => roundTo( value - min[ i ] ) ) },
		maps,
		bytes,
	};

}

async function processModelRecipe( recipe, io ) {

	const inputPath = path.join( rawDir, recipe.input );
	if ( ! fs.existsSync( inputPath ) ) throw new Error( `找不到原始文件 assets/raw/${ recipe.input }` );
	const sourceBytes = sourceBytesOf( inputPath );
	const source = await io.read( inputPath );
	const sourceTrianglesAll = countTriangles( source );
	console.log( `模型配方 ${ recipe.name }：${ recipe.input }（${ formatBytes( sourceBytes ) }，${ sourceTrianglesAll } 三角）` );

	const pieces = recipe.splitNodes || [ { node: null, output: recipe.output } ];
	const items = [];
	for ( const piece of pieces ) {

		const document = quietClone( source );
		if ( piece.node ) isolateNode( document, piece.node );
		bakeNodeTransforms( document, recipe.scaleToMetres );
		stripUnused( document, recipe );
		const unified = unifyNearlyEqualNormals( document, 1 );
		if ( unified > 0 ) console.log( `  ${ piece.output }：${ unified } 个顶点的法线只差不到 1°，统一后再焊接` );
		await document.transform( dedup(), prune(), weld() );
		recenterDocument( document, recipe.recenter );
		const sourceTriangles = countTriangles( document );

		const target = recipe.targetTriangles || ( recipe.simplifyRatio ? Math.round( sourceTriangles * recipe.simplifyRatio ) : null );
		const lod0 = await simplifyToTarget( document, target, recipe );
		const lod0Triangles = countTriangles( lod0.document );
		// 低模从 LOD0 再往下减，先各复制一份（LOD0 接着要压贴图）
		const lodSources = recipe.lods.map( () => quietClone( lod0.document ) );

		await encodeModelTextures( lod0.document, recipe, recipe.maxTextureSize );
		const item = await writeModel( io, lod0.document, recipe, { id: piece.output, node: piece.node, lod: 0, sourceTriangles, error: lod0.error } );
		items.push( item );
		console.log( `  ${ item.file }：${ formatBytes( item.bytes ) }，三角 ${ sourceTriangles } → ${ item.triangles }${ lod0.error ? `（误差 ${ lod0.error }）` : '' }，贴图 ${ item.maps.join( '、' ) || '无' }` );

		for ( let level = 1; level <= recipe.lods.length; level ++ ) {

			const lodTarget = Math.max( 4, Math.round( lod0Triangles * recipe.lods[ level - 1 ] ) );
			const lod = await simplifyToTarget( lodSources[ level - 1 ], lodTarget, recipe );
			await encodeModelTextures( lod.document, recipe, Math.max( 256, recipe.maxTextureSize >> level ) );
			const lodItem = await writeModel( io, lod.document, recipe, { id: `${ piece.output }-lod${ level }`, baseId: piece.output, node: piece.node, lod: level, sourceTriangles, error: lod.error } );
			items.push( lodItem );
			console.log( `  ${ lodItem.file }：${ formatBytes( lodItem.bytes ) }，三角 ${ lod0Triangles } → ${ lodItem.triangles }（LOD${ level }），贴图 ${ lodItem.maps.join( '、' ) || '无' }` );

		}

	}

	return items;

}

// ===================== 贴图组配方 =====================

// 贴图组：目录里的 *_diff_* / *_nor_gl_* / *_arm_* → <output>-diff/-nor/-arm.webp。
// 法线、ARM 是数据：ignoreIcc（不按 ICC 转色）、不做 gamma 处理，按原值存；法线图开 smartSubsample
const textureSetMaps = [
	{ key: 'diff', pattern: /_diff_/i, kind: 'albedo' },
	{ key: 'nor', pattern: /_nor_gl_/i, kind: 'normal' },
	{ key: 'arm', pattern: /_arm_/i, kind: 'data' },
];

async function processTextureSetRecipe( recipe ) {

	const inputDir = path.join( rawDir, recipe.input );
	if ( ! fs.existsSync( inputDir ) ) throw new Error( `找不到原始目录 assets/raw/${ recipe.input }` );
	const candidates = fs.readdirSync( inputDir ).filter( ( name ) => /\.(jpe?g|png|webp|tiff?)$/i.test( name ) );
	console.log( `贴图组配方 ${ recipe.name }：${ recipe.input }` );

	const maps = {};
	const files = [];
	for ( const map of textureSetMaps ) {

		const sourceName = candidates.find( ( name ) => map.pattern.test( name ) );
		if ( ! sourceName ) throw new Error( `${ recipe.input } 里找不到 ${ map.key } 贴图（文件名要含 ${ map.pattern.source }）` );
		const sourcePath = path.join( inputDir, sourceName );
		const id = `${ recipe.output }-${ map.key }`;
		const file = id + '.webp';
		const outPath = path.join( optDir, 'textures', file );
		fs.mkdirSync( path.dirname( outPath ), { recursive: true } );
		const isColor = map.kind === 'albedo';
		await sharp( sourcePath, { ignoreIcc: ! isColor } )
			.resize( { width: recipe.maxTextureSize, height: recipe.maxTextureSize, fit: 'inside', withoutEnlargement: true } )
			.removeAlpha()
			.webp( { quality: recipe.webpQuality[ map.kind ], smartSubsample: map.kind === 'normal', effort: 5 } )
			.toFile( outPath );
		const bytes = fs.statSync( outPath ).size;
		const meta = await sharp( outPath ).metadata();
		maps[ map.key ] = id;
		files.push( { id, file, bytes } );
		console.log( `  ${ file }：${ sourceName } ${ formatBytes( fs.statSync( sourcePath ).size ) } → ${ formatBytes( bytes ) }（${ meta.width }×${ meta.height }，质量 ${ recipe.webpQuality[ map.kind ] }）` );

	}

	return [ {
		id: recipe.output,
		recipe: recipe.name,
		credit: recipe.credit,
		source: recipe.input,
		size: recipe.maxTextureSize,
		maps,
		colorSpaces: { diff: 'srgb', nor: 'linear', arm: 'linear' },
		files,
	} ];

}

// ===================== 清单 =====================

// 写 assets/opt/<套>/manifest.json。--only 时没重跑的配方保留上次的条目；完整跑一遍时顺手删掉清单里已经没有的旧文件
function writeSetManifest( set, newItems, processedRecipeNames, fullRun ) {

	const directory = path.join( optDir, set );
	const manifestPath = path.join( directory, 'manifest.json' );
	const previous = readJson( manifestPath, { items: [] } );
	const recipeOrder = new Map( recipes.map( ( recipe, index ) => [ recipe.name, index ] ) );
	const kept = ( previous.items || [] ).filter( ( item ) => ! processedRecipeNames.has( item.recipe ) && recipeOrder.has( item.recipe ) );
	const items = [ ...kept, ...newItems ].sort( ( a, b ) => ( recipeOrder.get( a.recipe ) - recipeOrder.get( b.recipe ) ) || String( a.id ).localeCompare( String( b.id ) ) );
	if ( items.length === 0 && ! fs.existsSync( manifestPath ) ) return;

	const files = [];
	for ( const item of items ) {

		const entries = set === 'textures' ? item.files.map( ( entry ) => ( { id: entry.id, file: entry.file } ) ) : [ { id: item.id, file: item.file } ];
		for ( const entry of entries ) {

			const filePath = path.join( directory, entry.file );
			if ( ! fs.existsSync( filePath ) ) {

				console.error( `清单 ${ set }：${ entry.file } 不在磁盘上（重跑配方 ${ item.recipe }）` );
				process.exitCode = 1;
				continue;

			}

			files.push( { id: entry.id, file: entry.file, mime: mimeOf( entry.file ), bytes: fs.statSync( filePath ).size } );

		}

	}

	fs.mkdirSync( directory, { recursive: true } );
	const note = set === 'models'
		? '由 scripts/opt.mjs 生成，不要手改。files 是内联进 HTML 的数据块（id → data-models-<id>）；items 是每个模型的来源、三角数、包围盒（米，归位后）'
		: '由 scripts/opt.mjs 生成，不要手改。files 是内联进 HTML 的数据块（id → data-textures-<id>）；items 是每组贴图的 diff（sRGB）、nor（线性，OpenGL 朝向）、arm（线性，R=AO G=粗糙度 B=金属度）';
	fs.writeFileSync( manifestPath, JSON.stringify( { version: 1, note, files, items }, null, '\t' ) + '\n' );
	const total = files.reduce( ( sum, entry ) => sum + entry.bytes, 0 );
	console.log( `清单 assets/opt/${ set }/manifest.json：${ files.length } 个文件，共 ${ formatBytes( total ) }` );

	if ( ! fullRun ) return;
	const listed = new Set( files.map( ( entry ) => entry.file ) );
	for ( const name of fs.readdirSync( directory ) ) {

		if ( name === 'manifest.json' || listed.has( name ) ) continue;
		fs.rmSync( path.join( directory, name ) );
		console.log( `  删掉清单里已经没有的旧文件 ${ set }/${ name }` );

	}

}

async function processRecipes() {

	const selected = recipes.filter( ( recipe ) => ! options.only || options.only.has( recipe.name ) ).map( ( recipe ) => ( {
		...recipeDefaults,
		...recipe,
		credit: recipe.credit || recipe.name,
		webpQuality: { ...recipeDefaults.webpQuality, ...( recipe.webpQuality || {} ) },
	} ) );
	if ( selected.length === 0 ) return;

	await MeshoptEncoder.ready;
	await MeshoptSimplifier.ready;
	const io = new NodeIO()
		.setLogger( quietLogger )
		.registerExtensions( ALL_EXTENSIONS )
		.registerDependencies( { 'meshopt.encoder': MeshoptEncoder } );

	const results = { models: [], textures: [] };
	const processed = { models: new Set(), textures: new Set() };
	for ( const recipe of selected ) {

		const set = recipe.kind === 'model' ? 'models' : 'textures';
		try {

			const items = recipe.kind === 'model' ? await processModelRecipe( recipe, io ) : await processTextureSetRecipe( recipe );
			results[ set ].push( ...items );
			processed[ set ].add( recipe.name );

		} catch ( error ) {

			console.error( `配方 ${ recipe.name } 处理失败：${ error && error.message || error }` );
			process.exitCode = 1;

		}

	}

	const fullRun = ! options.only && process.exitCode !== 1;
	writeSetManifest( 'models', results.models, processed.models, fullRun );
	writeSetManifest( 'textures', results.textures, processed.textures, fullRun );

}

// ===================== 通用处理（配方表以外的散装素材） =====================

// 配方用到的顶层目录（polyhaven、quaternius ……）整个不进通用处理，免得同一份素材被处理两遍
const recipeRoots = [ ...new Set( recipes.map( ( recipe ) => recipe.input.split( '/' )[ 0 ] ) ) ];

async function processModels() {

	const files = walk( rawDir, ( name ) => /\.(glb|gltf)$/i.test( name ), [ 'audio', ...recipeRoots ] );
	if ( files.length === 0 ) {

		console.log( '通用模型：配方表以外没有 glb/gltf，跳过' );
		return;

	}

	await MeshoptEncoder.ready;
	await MeshoptSimplifier.ready;

	const io = new NodeIO()
		.registerExtensions( ALL_EXTENSIONS )
		.registerDependencies( { 'meshopt.encoder': MeshoptEncoder } );

	for ( const file of files ) {

		const relative = path.relative( rawDir, file );
		const baseName = path.basename( file, path.extname( file ) );
		const outPath = path.join( optDir, baseName + '.glb' );
		const beforeBytes = sourceBytesOf( file );

		console.log( `通用模型：处理 ${ relative }` );
		const document = await io.read( file );
		const beforeTriangles = countTriangles( document );

		const keepDetail = /\.keep\./i.test( path.basename( file ) );
		const transforms = [ dedup(), prune(), weld(), resample() ];
		if ( ! keepDetail ) {

			transforms.push( simplify( { simplifier: MeshoptSimplifier, ratio: options.ratio, error: 0.001 } ) );

		}

		transforms.push(
			textureCompress( { encoder: sharp, targetFormat: 'webp', resize: [ options.maxSize, options.maxSize ], quality: 82 } ),
			prune(),
			meshopt( { encoder: MeshoptEncoder, level: 'medium' } ),
		);

		await document.transform( ...transforms );

		fs.mkdirSync( path.dirname( outPath ), { recursive: true } );
		await io.write( outPath, document );
		const afterBytes = fs.statSync( outPath ).size;
		const afterTriangles = countTriangles( document );
		const extensions = document.getRoot().listExtensionsUsed().map( ( extension ) => extension.extensionName ).join( ', ' );

		console.log( `  ${ formatBytes( beforeBytes ) } → ${ formatBytes( afterBytes ) }，三角 ${ beforeTriangles } → ${ afterTriangles }${ keepDetail ? '（未简化）' : '' }，扩展：${ extensions || '无' }` );

	}

}

async function processImages() {

	const files = walk( rawDir, ( name ) => /\.(png|jpe?g)$/i.test( name ), [ 'audio', ...recipeRoots ] );
	if ( files.length === 0 ) {

		console.log( '通用贴图：配方表以外没有 png/jpg，跳过' );
		return;

	}

	for ( const file of files ) {

		const relative = path.relative( rawDir, file );
		const outPath = path.join( optDir, relative.replace( /\.(png|jpe?g)$/i, '.webp' ) );
		fs.mkdirSync( path.dirname( outPath ), { recursive: true } );
		const beforeBytes = fs.statSync( file ).size;

		await sharp( file )
			.resize( { width: options.maxSize, height: options.maxSize, fit: 'inside', withoutEnlargement: true } )
			.webp( { quality: 82 } )
			.toFile( outPath );

		const afterBytes = fs.statSync( outPath ).size;
		console.log( `通用贴图：${ relative } ${ formatBytes( beforeBytes ) } → ${ formatBytes( afterBytes ) }` );

	}

}

function hasFfmpeg() {

	const result = spawnSync( 'ffmpeg', [ '-version' ], { stdio: 'ignore' } );
	return ! result.error && result.status === 0;

}

function processAudio() {

	const audioDir = path.join( rawDir, 'audio' );
	const files = walk( audioDir, ( name ) => /\.(wav|mp3|ogg|flac|m4a|opus)$/i.test( name ) );
	if ( files.length === 0 ) {

		console.log( '音频：assets/raw/audio 里没有文件，跳过' );
		return;

	}

	if ( ! hasFfmpeg() ) {

		console.log( '音频：系统里没有 ffmpeg，无法转 Opus，先跳过（装好 ffmpeg 再跑一次）' );
		return;

	}

	const outDir = path.join( optDir, 'audio' );
	fs.mkdirSync( outDir, { recursive: true } );

	for ( const file of files ) {

		const outPath = path.join( outDir, path.basename( file, path.extname( file ) ) + '.opus' );
		const result = spawnSync( 'ffmpeg', [ '-y', '-i', file, '-c:a', 'libopus', '-b:a', '64k', '-vbr', 'on', outPath ], { stdio: 'ignore' } );
		if ( result.status !== 0 ) {

			console.error( `音频：${ path.basename( file ) } 转码失败` );
			process.exitCode = 1;
			continue;

		}

		console.log( `音频：${ path.basename( file ) } ${ formatBytes( fs.statSync( file ).size ) } → ${ formatBytes( fs.statSync( outPath ).size ) }` );

	}

}

// ===================== 署名校验 =====================

// credits.json 的每一条：title、author、license、url、usedFor、kind 必填；kind 是 model / texture / code / audio 之一；
// license 不能是 NC（禁止商用）、ND（禁止演绎）类。配方和它的每个产物都要能按 credit 找到一条署名；
// 通用处理产出的散装 glb 按 file 字段匹配（老规则）
const creditKinds = [ 'model', 'texture', 'code', 'audio' ];

function checkCredits() {

	if ( ! fs.existsSync( creditsPath ) ) {

		console.error( '找不到 assets/credits.json' );
		return false;

	}

	let credits;
	try {

		credits = JSON.parse( fs.readFileSync( creditsPath, 'utf8' ) );

	} catch ( error ) {

		console.error( 'credits.json 不是合法 JSON：' + error.message );
		return false;

	}

	const items = Array.isArray( credits.items ) ? credits.items : null;
	if ( ! items ) {

		console.error( 'credits.json 里缺 items 数组' );
		return false;

	}

	const requiredFields = [ 'title', 'author', 'license', 'url', 'usedFor', 'kind' ];
	let ok = true;
	const byId = new Map();

	items.forEach( ( item, index ) => {

		const label = `credits.json 第 ${ index + 1 } 条（${ item.id || item.title || '无标题' }）`;
		const missing = requiredFields.filter( ( field ) => typeof item[ field ] !== 'string' || item[ field ].trim() === '' );
		if ( missing.length > 0 ) {

			console.error( `${ label } 缺字段：${ missing.join( '、' ) }` );
			ok = false;

		}

		if ( typeof item.kind === 'string' && ! creditKinds.includes( item.kind ) ) {

			console.error( `${ label } 的 kind 是「${ item.kind }」，只能是 ${ creditKinds.join( ' / ' ) }` );
			ok = false;

		}

		if ( typeof item.license === 'string' && /(^|[\s-])(NC|ND)([\s-]|$)|NonCommercial|NoDerivatives/i.test( item.license ) ) {

			console.error( `${ label } 的许可「${ item.license }」带 NC / ND，不能用` );
			ok = false;

		}

		if ( item.id ) {

			if ( byId.has( item.id ) ) {

				console.error( `${ label } 的 id「${ item.id }」重复了` );
				ok = false;

			}

			byId.set( item.id, item );

		}

	} );

	// 每个配方都要有署名，种类要对得上
	for ( const recipe of recipes ) {

		const creditId = recipe.credit || recipe.name;
		const entry = byId.get( creditId );
		const expectedKind = recipe.kind === 'model' ? 'model' : 'texture';
		if ( ! entry ) {

			console.error( `配方 ${ recipe.name } 在 credits.json 里没有署名（需要一条 id 为 "${ creditId }" 的记录）` );
			ok = false;

		} else if ( entry.kind !== expectedKind ) {

			console.error( `配方 ${ recipe.name } 的署名「${ creditId }」kind 是 ${ entry.kind }，应该是 ${ expectedKind }` );
			ok = false;

		}

	}

	// 清单里的每个产物都要能追到署名
	let creditedOutputs = 0;
	for ( const set of [ 'models', 'textures' ] ) {

		const manifest = readJson( path.join( optDir, set, 'manifest.json' ), null );
		if ( ! manifest ) continue;
		for ( const item of manifest.items || [] ) {

			if ( ! item.credit || ! byId.has( item.credit ) ) {

				console.error( `assets/opt/${ set } 的「${ item.id }」没有署名（credit：${ item.credit || '空' }）` );
				ok = false;

			} else {

				creditedOutputs ++;

			}

		}

	}

	// 通用处理产出的散装 glb（不在 models/ 等清单目录里）按 file 字段匹配
	const looseModels = walk( optDir, ( name ) => /\.glb$/i.test( name ), [ 'models', 'textures', 'pano', 'terrain' ] ).map( ( file ) => path.basename( file ) );
	const creditedFiles = new Set( items.map( ( item ) => item.file ).filter( Boolean ) );
	for ( const model of looseModels ) {

		if ( ! creditedFiles.has( model ) ) {

			console.error( `assets/opt/${ model } 在 credits.json 里没有条目（需要一条 file 为 "${ model }" 的记录）` );
			ok = false;

		}

	}

	const codeCount = items.filter( ( item ) => item.kind === 'code' ).length;
	if ( ok ) console.log( `credits.json 校验通过：${ items.length } 条署名（代码 ${ codeCount } 条），${ recipes.length } 个配方、${ creditedOutputs } 组产物、${ looseModels.length } 个散装模型都有署名` );
	return ok;

}

async function main() {

	if ( ! options.checkCreditsOnly ) {

		if ( ! fs.existsSync( rawDir ) ) {

			console.log( '没有 assets/raw 目录，没有原始素材，跳过处理' );

		} else {

			fs.mkdirSync( optDir, { recursive: true } );
			await processRecipes();
			if ( ! options.only ) {

				await processModels();
				await processImages();
				processAudio();

			}

		}

	}

	const creditsOk = checkCredits();
	if ( ! creditsOk ) process.exitCode = 1;

}

main().catch( ( error ) => {

	console.error( '素材处理出错：' + ( error && error.stack || error ) );
	process.exit( 1 );

} );
