import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import fs from 'node:fs';
import path from 'node:path';

// 全景模式的素材（全景图、遮罩、夜空渐变、飞行视频，见 scripts/bake-pano.mjs）不进 JS 包：
// 每个文件写成 HTML 末尾的一个 <script type="application/octet-stream"> 数据块（base64），浏览器不执行、只当文本存着，
// 只有画质判成 pano 时 src/scenes/panorama.js 才去读、才解码。没烘焙过（清单为空）就什么都不加
function inlinePanorama() {

	return {
		name: 'inline-panorama',
		transformIndexHtml: {
			order: 'post',
			handler( html ) {

				const directory = path.resolve( 'assets/opt/pano' );
				const manifestPath = path.join( directory, 'manifest.json' );
				if ( ! fs.existsSync( manifestPath ) ) return html;
				const manifest = JSON.parse( fs.readFileSync( manifestPath, 'utf8' ) );
				const blocks = ( manifest.files || [] ).map( ( item ) => {

					const filePath = path.join( directory, item.file );
					if ( ! fs.existsSync( filePath ) ) throw new Error( `全景清单里的文件不存在：${ item.file }（重跑 node scripts/bake-pano.mjs）` );
					return `<script type="application/octet-stream" id="pano-data-${ item.id }" data-mime="${ item.mime }">${ fs.readFileSync( filePath ).toString( 'base64' ) }</script>`;

				} );
				return blocks.length ? html.replace( '</body>', blocks.join( '\n' ) + '\n</body>' ) : html;

			},
		},
	};

}

// 目标只有一个：产出一个能在 file:// 下双击打开的 dist/index.html，所有资源全部内联
export default defineConfig( {
	plugins: [
		viteSingleFile( { removeViteModuleLoader: true } ),
		inlinePanorama(),
	],
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
		port: 5173,
		open: false,
	},
} );
