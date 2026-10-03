import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import fs from 'node:fs';
import path from 'node:path';

// 大块二进制素材不进 JS 包，写成 HTML 末尾的数据块：
// 每个文件一个 <script type="application/octet-stream" id="data-<套>-<编号>" data-mime="...">BASE64</script>，
// 浏览器不执行、只当文本存着，用到时 src/core/assets.js 才去读、才解码（全景只在画质判成 pano 时才读）。
// 每套素材的清单是 assets/opt/<套>/manifest.json，里面 files: [{ id, file, mime, bytes }]：
//   pano      全景图、遮罩、夜空渐变、飞行视频（scripts/bake-pano.mjs）
//   terrain   世界地形烘焙（scripts/bake-terrain.mjs）
//   models    模型 glb（scripts/opt.mjs）
//   textures  地表 / 树皮贴图组 WebP（scripts/opt.mjs）
//   foliage   远处树的替身图集（scripts/bake-foliage.mjs）
//   forest    树林布点（scripts/bake-forest.mjs）
// 某一套没有清单 = 还没生成，整套跳过不报；清单里列了但磁盘上没有的文件打印中文警告、跳过这一块，不让构建失败
const dataSets = [ 'pano', 'terrain', 'models', 'textures', 'foliage', 'forest' ];

function inlineDataBlocks() {

	return {
		name: 'inline-data-blocks',
		transformIndexHtml: {
			order: 'post',
			handler( html ) {

				const blocks = [];
				for ( const set of dataSets ) {

					const directory = path.resolve( 'assets/opt', set );
					const manifestPath = path.join( directory, 'manifest.json' );
					if ( ! fs.existsSync( manifestPath ) ) continue;

					let manifest;
					try {

						manifest = JSON.parse( fs.readFileSync( manifestPath, 'utf8' ) );

					} catch ( error ) {

						console.warn( `\n[数据块] ${ set } 的清单不是合法 JSON，整套跳过：${ error.message }` );
						continue;

					}

					for ( const item of manifest.files || [] ) {

						const filePath = path.join( directory, item.file || '' );
						if ( ! item.id || ! item.file || ! fs.existsSync( filePath ) ) {

							console.warn( `\n[数据块] ${ set } 清单里的文件不存在，跳过：${ item.file || '（没写 file）' }（重跑生成这一套的脚本）` );
							continue;

						}

						const mime = item.mime || 'application/octet-stream';
						blocks.push( `<script type="application/octet-stream" id="data-${ set }-${ item.id }" data-mime="${ mime }">${ fs.readFileSync( filePath ).toString( 'base64' ) }</script>` );

					}

				}

				return blocks.length ? html.replace( '</body>', blocks.join( '\n' ) + '\n</body>' ) : html;

			},
		},
	};

}

// 成品：正式构建（输出到 dist/）完成后，把 dist/index.html 复制一份到仓库根目录，起礼物的名字。
// 截图、烘焙脚本仍然认 dist/index.html；输出到别的目录的试验构建（--outDir）不复制，免得把半成品当成品
const giftFileName = '桃源一日.html';

function copyGiftFile() {

	let outDir = '';
	return {
		name: 'copy-gift-file',
		apply: 'build',
		configResolved( resolved ) {

			outDir = path.resolve( resolved.root, resolved.build.outDir );

		},
		closeBundle() {

			if ( outDir !== path.resolve( 'dist' ) ) return;
			const built = path.join( outDir, 'index.html' );
			if ( ! fs.existsSync( built ) ) {

				console.warn( `\n[成品] 没找到 ${ built }，这次不复制 ${ giftFileName }` );
				return;

			}

			fs.copyFileSync( built, path.resolve( giftFileName ) );
			console.log( `\n[成品] 已复制到 ${ giftFileName }（${ ( fs.statSync( built ).size / 1048576 ).toFixed( 1 ) } MB）` );

		},
	};

}

// 目标只有一个：产出一个能在 file:// 下双击打开的 dist/index.html，所有资源全部内联（再复制成根目录的 桃源一日.html）
export default defineConfig( {
	plugins: [
		viteSingleFile( { removeViteModuleLoader: true } ),
		inlineDataBlocks(),
		copyGiftFile(),
	],
	resolve: {
		// 插件（GLTFLoader、BufferGeometryUtils……）内部写的是 from 'three'，指到 three/webgpu，和官方 webgpu 示例的 importmap 一样，
		// 整个包只有一份 three。必须用正则：写字符串 'three' 会把 'three/webgpu' 也改成 'three/webgpu/webgpu'
		alias: [ { find: /^three$/, replacement: 'three/webgpu' } ],
	},
	// 让 .glb / 音频也走资源管线（会被 assetsInlineLimit 内联成 data URI）
	assetsInclude: [ '**/*.glb', '**/*.opus', '**/*.ogg', '**/*.wasm' ],
	build: {
		target: 'esnext',
		assetsInlineLimit: 100000000,   // 超大，确保所有资源都内联
		chunkSizeWarningLimit: 50000,   // 单文件本来就大，关掉大小警告
		cssCodeSplit: false,
		minify: 'esbuild',
		sourcemap: false,
		reportCompressedSize: false,
	},
	server: {
		// 预览面板会通过 PORT 环境变量分配端口（5173 可能被别的会话占着）；没给就用 5173
		port: Number( process.env.PORT ) || 5173,
		open: false,
	},
} );
