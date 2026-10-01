import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 目标只有一个：产出一个能在 file:// 下双击打开的 dist/index.html，所有资源全部内联
export default defineConfig( {
	plugins: [
		viteSingleFile( { removeViteModuleLoader: true } ),
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
