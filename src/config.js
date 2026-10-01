// 所有可调参数和文字都在这里。改完重新 npm run build 即可，不用动别的文件。

const config = {

	// ===== 开场卡文字（自己填）=====
	openingTitle: '一天五景',
	openingSubtitle: '',
	clickToStart: '点击开启',
	openingHints: [ '插上电源效果更好', '按 F 全屏' ],

	// ===== 结尾（自己填）=====
	endingText: '',
	creditsLabel: '致谢',
	replayLabel: '再走一遍',

	// ===== 五个场景，按播放顺序 =====
	// key 必须和 src/scenes/<key>.js 里导出的 key 一致
	// duration 秒；mainColor 是转场白光里交叉过渡用的主色
	// grading 是每个场景一套的调色；shots 是截图脚本在该场景里截图的时间点（秒）
	scenes: [
		{
			key: 'garden',
			name: '清晨 · 白银花园城堡',
			duration: 75,
			mainColor: '#f3e3df',
			transitionStyle: 'flash',
			grading: { exposure: 1.0, contrast: 1.05, saturation: 1.05, tint: '#ffd9c2', tintAmount: 0.08, toneMapping: 'agx' },
			shots: [ 5, 35, 65 ],
		},
		{
			key: 'sunset',
			name: '黄昏 · 落日与海',
			duration: 70,
			mainColor: '#ff9a4d',
			transitionStyle: 'flash',
			grading: { exposure: 1.0, contrast: 1.08, saturation: 1.1, tint: '#ff9a4d', tintAmount: 0.06, toneMapping: 'agx', grain: 0.006 },
			shots: [ 5, 35, 60 ],
		},
		{
			key: 'gothic',
			name: '入夜 · 哥特城堡',
			duration: 75,
			mainColor: '#1d2c5c',
			transitionStyle: 'flash',
			grading: { exposure: 1.0, contrast: 1.1, saturation: 1.0, tint: '#b8c8f0', tintAmount: 0.05, toneMapping: 'agx' },
			shots: [ 5, 40, 70 ],
		},
		{
			key: 'starry',
			name: '深夜 · 星月夜',
			duration: 70,
			mainColor: '#1b3a8c',
			transitionStyle: 'canvas',
			grading: { exposure: 1.0, contrast: 1.12, saturation: 1.15, tint: '#2c5aa0', tintAmount: 0.05, toneMapping: 'agx' },
			shots: [ 5, 35, 60 ],
		},
		{
			key: 'aurora',
			name: '凌晨 · 极光雪原',
			duration: 90,
			mainColor: '#3dffa0',
			transitionStyle: 'flash',
			grading: { exposure: 1.0, contrast: 1.08, saturation: 1.05, tint: '#4a5f8c', tintAmount: 0.06, toneMapping: 'agx' },
			shots: [ 5, 45, 85 ],
		},
	],

	// ===== 转场 =====
	transition: {
		duration: 3.5,      // 秒
		peakAt: 0.5,        // 进度到多少时最亮并切换场景
		bloomBoost: 2.5,    // 最亮时 bloom 强度在基础值上额外加多少
		whiteness: 0.75,    // 闪光颜色向纯白靠多少（0 全是主色，1 全是白）
	},

	// ===== 结尾时序 =====
	ending: {
		textDelay: 5,       // 最后一个场景停稳后几秒淡入结尾文字
		creditsDelay: 8,    // 结尾文字出现后几秒淡入致谢按钮
		fadeDuration: 2.5,  // 文字淡入秒数
	},

	// ===== 镜头与交互 =====
	camera: {
		fov: 50,
		near: 0.1,
		far: 2000,
		dragYawMax: 60,          // 拖动转头：水平最大角度（度）
		dragPitchMax: 25,        // 垂直最大角度（度）
		dragSensitivity: 0.25,   // 每像素多少度
		dragReturnDamping: 2.5,  // 松手回正的阻尼（越大回得越快）
		idleCursorHide: 3,       // 鼠标几秒不动就隐藏光标
		freeMoveSpeed: 8,        // 自由相机 WASD 速度（米/秒），按住 Shift 乘 4
		// 步行漫游（场景里 WASD 走、拖动转头）
		eyeHeight: 1.65,         // 眼睛离地高度（米）
		walkSpeed: 1.4,          // 步行速度（米/秒）
		runMultiplier: 3,        // 按住 Shift 的倍数
		walkSmoothing: 6,        // 起步停步的缓动（越大越跟手）
		walkPitchMax: 80,        // 步行时抬头低头的最大角度（度）
	},

	// ===== 画质分档 =====
	quality: {
		// 显卡名字里出现这些词就认为是核显，从"中"起步
		integratedKeywords: [ 'Intel', 'UHD', 'Iris', 'Radeon Graphics', 'Radeon(TM) Graphics', 'Apple M1', 'Apple M2', 'Apple M3', 'Vega', 'Adreno', 'Mali', 'SwiftShader', 'llvmpipe', 'Microsoft Basic Render' ],
		webglMaxTier: 'mid',          // WebGL2 兜底路径最高给到哪一档
		benchmarkSeconds: 2,          // 开场页基准测试时长
		benchmarkDowngradeMs: 16.7,   // 基准测试平均帧时间超过这个就降一档
		dynamic: {
			slowFrameMs: 20,       // 连续 slowFrames 帧超过这个毫秒数 → 降 0.1
			slowFrames: 30,
			fastFrameMs: 12,       // 连续 fastFrames 帧低于这个毫秒数 → 升 0.1
			fastFrames: 120,
			minScale: 0.5,         // 降到底了还卡就降一档
			step: 0.1,
		},
		tiers: {
			hi:  { pixelRatioCap: 2.0, pixelRatio: 1.5, volumeFullRes: true,  volumeSteps: 40, instanceRatio: 1.0, reflectionScale: 0.5,  kuwahara: 'on',   sparkleLayers: 3, shadowSize: 2048 },
			mid: { pixelRatioCap: 1.0, pixelRatio: 1.0, volumeFullRes: false, volumeSteps: 28, instanceRatio: 0.6, reflectionScale: 0.35, kuwahara: 'half', sparkleLayers: 2, shadowSize: 1024 },
			lo:  { pixelRatioCap: 0.75, pixelRatio: 0.75, volumeFullRes: false, volumeSteps: 16, instanceRatio: 0.3, reflectionScale: 0,    kuwahara: 'off',  sparkleLayers: 1, shadowSize: 0 },
		},
	},

	// ===== 后期 =====
	post: {
		bloom: { strength: 0.35, radius: 0.4, threshold: 0.9 },
		vignette: { amount: 0.32, softness: 0.55 },
		grain: 0.025,            // 胶片颗粒强度，0 关闭
		canvasRevealTiles: 180,  // 场景 4 画布纹理的经纱密度（越大越细）
	},

	// ===== 音频（阶段 0 全程序化合成，素材到位后替换）=====
	audio: {
		masterVolume: 0.5,
		crossfade: 3,   // 场景切换时交叉淡入淡出秒数
		scenes: {
			garden: { kind: 'wind',  volume: 0.25, cutoff: 900,  lfoRate: 0.12 },
			sunset: { kind: 'waves', volume: 0.45, cutoff: 500,  lfoRate: 0.08 },
			gothic: { kind: 'night', volume: 0.2,  cutoff: 400,  lfoRate: 0.05 },
			starry: { kind: 'quiet', volume: 0.05, cutoff: 300,  lfoRate: 0.03 },
			aurora: { kind: 'wind',  volume: 0.35, cutoff: 700,  lfoRate: 0.07 },
		},
	},

	// ===== 场景细节开关 =====
	footprintsReveal: true,   // 雪原脚印随人往前走一个一个出现在前方

	// ===== 场景 2：落日与海 =====
	sunset: {
		sunAzimuth: 0,               // 太阳方位角（度）：0 = 出生点正前方（-z）
		sunElevationStart: 2.6,      // 开场时太阳仰角（度），规格 1~3°
		sunElevationEnd: 1.0,        // 场景结束时的仰角：整场缓慢下沉一点点（圆盘下缘已经碰到海平线）
		sunAngularRadius: 1.2,       // 太阳圆盘角半径（度）：真实约 0.27°，放大到 1~2° 好看，光路也按它算
		sunColor: '#fff1c9',
		sunDiscIntensity: 28,        // 太阳圆盘 HDR 亮度（20~50）
		sunLightColor: '#ffb27a',    // 照在礁石上的阳光：贴着地平线穿过厚大气，偏橙
		sunLightIntensity: 2.6,
		skyTurbidity: 4.5,           // SkyMesh（Preetham 天空）的浑浊度
		skyRayleigh: 2.6,            // 瑞利散射系数，调高（2~3）天空更红更紫
		skyMieCoefficient: 0.005,
		skyMieDirectionalG: 0.8,
		skyExposure: 0.11,           // SkyMesh 输出的量级很大，先乘这个再进后期
		skyPaletteAmount: 0.6,       // 天空往配色表（下面三色）拉的程度，0 = 原样 Preetham
		horizonGlow: 0.35,           // 贴着海平线的橙金色光带亮度
		twilightStrength: 1,         // 背着太阳那半边天的暮光（地球影子 + 维纳斯带 + 蓝紫天顶）整体亮度
		earthShadowColor: '#4c5276', // 背着太阳的地平线：地球影子那条灰紫蓝
		beltColor: '#c47a92',        // 维纳斯带：地球影子上面那条粉色
		zenithColor: '#3b3a73',      // 头顶的蓝紫
		cloudAwayColor: '#9c6f8c',   // 背着太阳的晚霞是淡粉紫
		coastShadowColor: '#252238', // 远岸山脚（在影子里）
		coastGlowColor: '#c98577',   // 远岸山脊上的余晖
		skyHorizon: '#ff9a4d',
		skyMid: '#f27b8a',
		skyHigh: '#8f6fbf',
		cloudCoverage: 0.42,         // 晚霞覆盖率（0~1，越大云越多）
		cloudBrightness: 0.55,       // 晚霞亮度
		cloudShadowColor: '#4a3352', // 云厚处的暗紫色
		endDarken: 0.45,             // 最后 20 秒天空和光变暗的程度，给入夜铺垫
		windSpeed: 6.5,              // 风速（米/秒，规格 5~8）：Cox–Munk 斜率方差按它算；风小于约 5.8 时浪和波纹会自动跟着变小
		windDirection: 100,          // 浪的主方向（度）：90 = 朝 +z，也就是朝岸边推过来
		waveScale: 1,                // 大浪整体振幅倍数（再大会被 Cox–Munk 的 σ² 压回来，想要更大的浪请同时调大风速）
		waveChoppiness: 0.85,        // Gerstner 的 Q（尖峰程度），陡度总和会自动压到 1 以下
		waterColor: '#1d2b4a',       // 海水暗部
		shallowColor: '#2e5d5a',     // 礁石边浅水
		sssColor: '#3fbfa0',         // 浪尖逆光透出的绿
		sssStrength: 0.5,
		foamColor: '#fff4ea',
		pathIntensity: 3,            // 金色光路（Cox–Munk 高光瓣，平均亮度）的倍数；近处的碎光主要靠闪点
		sparkleIntensity: 2.5,       // 光路闪点的亮度倍数（峰值约 F·L_太阳 × 它，进 HDR 让 bloom 出星芒）
		sparkleTwinkleRate: 2.5,     // 闪点每秒换几轮
		fogDensity: 0.002,           // 海面上的薄雾（每米）
		fogFalloff: 25,              // 雾的衰减高度（米）
		fogColor: '#7a4a52',         // 雾的底色（背着太阳看到的颜色），暗玫瑰色
		fogScatter: 0.1,             // 朝太阳看时雾里的前向散射强度
		seagullCount: 2,
		oceanSegments: { hi: 512, mid: 384, lo: 256 },    // 海面环形网格的角向分段
		terrainSegments: { hi: 320, mid: 240, lo: 170 },  // 礁石岸地形网格分段
		environmentInterval: 0.15,   // 太阳每沉多少度重新生成一次环境光贴图
		environmentIntensity: 2.0,   // 天空光（环境光贴图）照在沙滩、礁石上的强度，背光面和影子靠它提亮
	},

	// ===== 场景 5：极光雪原 =====
	aurora: {
		terrainSize: 700,            // 地形边长（米）
		terrainCenterZ: - 200,       // 地形中心的 z（路径从 z=0 往 -z 走 400 米）
		pathLength: 400,             // 脚印路径长度（米）
		moonAzimuth: - 38,           // 月亮方位角（度）：0 = 正前方（-z），负数偏左
		moonElevation: 15,           // 月亮仰角（度），偏低才有长影子和逆光轮廓
		moonColor: '#cfdcff',
		moonIntensity: 2.2,          // 月光强度（雪的受光面亮度主要靠它）
		skyHorizon: '#0d1730',
		skyZenith: '#03060f',
		shadowSkyColor: '#22336a',   // 阴影里的天空半球色（深蓝）
		groundBounceColor: '#3a4d7e',// 雪面反弹到背光面的颜色
		ambientIntensity: 0.75,
		snowAlbedo: [ 0.85, 0.88, 0.92 ], // 雪的反照率（线性，0.85~0.92），不能是 1，带一点蓝
		wrapAmount: 0.4,             // 包裹光照的 w
		sheenColor: '#e4ecff',
		sheenRoughness: 0.65,
		scatterColor: '#9fc2ff',     // 前向散射 / 棱线透光的颜色
		forwardScatter: 0.3,
		ridgeGlow: 1.4,
		sparkleIntensity: 14,        // 闪点 HDR 亮度倍数
		auroraBrightness: 1.6,       // 极光整体亮度
		auroraDrift: 0.035,          // 极光竖向光线的横向漂移（单位/秒）
		auroraBreathPeriod: 11,      // 极光呼吸周期（秒）
		auroraLightStrength: 0.15,   // 极光照亮雪地的强度（0.05~0.2）
		fogDensity: 0.012,           // 贴地雾在海拔 0 处的密度（每米）
		fogFalloff: 5,               // 雾的衰减高度（米）
		fogColor: '#121f40',     // 贴近地平线天色，远山和远处雪面才能溶进天空
		fogScatterColor: '#3d5590',
		windDirection: 30,           // 风向（度）：风纹和地吹雪都沿这个方向
		windSpeed: 4,                // 地吹雪流速（米/秒）
		snowCount: { hi: 20000, mid: 12000, lo: 5000 }, // 飘雪粒子数
		footprintRevealLead: 30,     // 脚印提前出现在人前方多远（米）
		pomSteps: { hi: 16, mid: 12, lo: 8 },             // 脚印视差步数
		terrainSegments: { hi: 511, mid: 383, lo: 255 },  // 地形网格分段
	},

};

export default config;
