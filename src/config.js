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
		// 呼吸感和行走感（幅度都很小，不能晕；enabled 改 false 整个关掉）
		sway: {
			enabled: true,
			breathPeriod: 4,       // 呼吸一次多少秒
			breathHeight: 0.012,   // 呼吸的上下起伏（米）
			breathPitch: 0.15,     // 呼吸带的俯仰（度）
			breathRoll: 0.08,      // 呼吸带的横滚（度）
			stepLength: 0.78,      // 一步多长（米）：步行 1.4 米/秒时约每秒 1.8 步
			bobHeight: 0.028,      // 每一步的上下颠（米）
			bobSide: 0.015,        // 两步一个来回的左右晃（米）
			bobRoll: 0.25,         // 左右晃带的横滚（度）
			bobPitch: 0.08,        // 每一步带的点头（度）
			runExtra: 0.6,         // 跑起来晃动最多再加多少（相对步行）
			blendSpeed: 5,         // 起步停步时晃动的过渡快慢
			floatPeriod: 7,        // 坐船、飞行时漂浮一次多少秒
			floatHeight: 0.035,    // 漂浮的上下幅度（米）
			floatRoll: 0.2,        // 漂浮的横滚（度）
		},
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
			// 有显卡时间戳（WebGPU 大多有）：每帧显卡干活的时间超过这一档的预算才降，有余量就升回去
			gpuBudgetMs: { hi: 14, mid: 22, lo: 28 },
			// 没有显卡计时：帧间隔比"刷新间隔"长 45% 以上、且超过 slowFrameMs 才算掉帧（被垂直同步或浏览器限帧卡住不算）
			slowFrameMs: 20,
			slowFrames: 30,        // 连续这么多帧超预算 → 渲染比例降 0.1
			fastFrames: 120,       // 连续这么多帧有余量 → 升 0.1（没有显卡计时时要两倍这么多帧，且离上次降至少 raiseCooldown 秒）
			raiseCooldown: 20,     // 没有显卡计时时，降比例以后至少等这么多秒才试着升回去
			minScale: 0.5,         // 降到底了还超预算就降一档
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

	// ===== 秘境：世界地图和一天的天空（CLAUDE.md 5.0）=====
	// 坐标：+x 东、−z 北、y 海拔（米）；方位角从北顺时针量（度）。时刻用小时（5.75 = 05:45），24 小时循环
	world: {
		// 每个地点：原点（本地 0,0,0 在世界里的位置）、yaw（本地 −z 在世界里的方位角）、内容半径（米，这个范围里是地点自己的细节）
		locations: {
			overture: { name: '溪口桃花林', origin: [ - 480, 10, 2150 ], yaw: 355, contentRadius: 450 },
			garden: { name: '白银花园', origin: [ - 430, 24, 1380 ], yaw: 75, contentRadius: 350, landmark: [ - 110, 24, 1295 ] },
			sunset: { name: '落日海湾', origin: [ - 1250, 0, 150 ], yaw: 280, contentRadius: 2000 },
			gothic: { name: '哥特城堡', origin: [ - 50, 57, - 40 ], yaw: 72, contentRadius: 700, landmark: [ 520, 95, - 225 ] },
			starry: { name: '星月夜', origin: [ 150, 210, - 1250 ], yaw: 160, contentRadius: 500, landmark: [ 235, 175, - 1015 ] },
			aurora: { name: '极光雪原', origin: [ 100, 560, - 1900 ], yaw: 0, contentRadius: 1100 },
		},
		cave: { outer: [ - 520, 26, 1640 ], inner: [ - 520, 30, 1570 ] },
		lake: { center: [ 230, - 130 ], radiusX: 270, radiusZ: 200, level: 55 },
		// 河：湖南端 → 花园 → 西边入海；小镇溪：冰瀑脚 → 湖北端；桃花溪：洞外口 → 往南出山（渔人从这里来）
		// key 是程序里认的名字（不要改）；name 只是给人看的。控制点之间按曲线重采样、加一点蜿蜒（地点附近不蜿蜒）
		rivers: [
			{ key: 'river', name: '河', width: 26, points: [ [ 200, 54.5, 60 ], [ 140, 46, 380 ], [ - 40, 36, 780 ], [ - 210, 28, 1120 ], [ - 300, 24, 1300 ], [ - 620, 14, 1260 ], [ - 930, 6, 930 ], [ - 1300, 0, 640 ], [ - 1560, 0, 560 ] ] },
			{ key: 'townStream', name: '小镇溪', width: 9, points: [ [ 150, 210, - 1690 ], [ 230, 190, - 1420 ], [ 260, 165, - 1030 ], [ 270, 110, - 650 ], [ 250, 56, - 320 ] ] },
			{ key: 'peachStream', name: '桃花溪', width: 10, points: [ [ - 520, 25, 1660 ], [ - 500, 18, 1880 ], [ - 480, 10, 2150 ], [ - 450, 6, 2500 ], [ - 380, 3, 2900 ] ] },
		],
		// 一天的天空关键帧（按时刻插值）。sun / moon 是 [方位角, 仰角]（度）；颜色是 sRGB；intensity 是天空整体亮度（HDR 倍数）
		//   zenith 天顶；horizon 地平线（侧面）；sunHorizon 太阳那边的地平线；earthShadow 背着太阳的地平线；
		//   belt 维纳斯带颜色和强度；glow 太阳周围的光晕颜色和强度；mist 贴地薄雾（0~1）；stars / moonLight 星星、月光的强度
		skyKeys: [
			{ time: 0.5, sun: [ 0, - 40 ], moon: [ 185, 35 ], intensity: 0.07, zenith: '#03060f', horizon: '#101a38', sunHorizon: '#101a38', earthShadow: '#0b1530', belt: '#1a2448', beltAmount: 0, glow: '#000000', glowAmount: 0, mist: 0.3, stars: 1, moonLight: 1 },
			{ time: 4.0, sun: [ 45, - 15 ], moon: [ 322, 15 ], intensity: 0.06, zenith: '#03060f', horizon: '#0d1730', sunHorizon: '#1a2550', earthShadow: '#0a1228', belt: '#1a2448', beltAmount: 0, glow: '#000000', glowAmount: 0, mist: 0.35, stars: 1, moonLight: 1 },
			{ time: 5.0, sun: [ 75, - 8 ], moon: [ 328, 10 ], intensity: 0.22, zenith: '#14204a', horizon: '#3b4a7e', sunHorizon: '#9a7a9a', earthShadow: '#26305a', belt: '#5a4a78', beltAmount: 0.3, glow: '#c08080', glowAmount: 0.2, mist: 0.7, stars: 0.35, moonLight: 0.6 },
			{ time: 5.75, sun: [ 77, - 0.5 ], moon: [ 335, 4 ], intensity: 0.75, zenith: '#8fa6d6', horizon: '#e6c9c4', sunHorizon: '#ffcfae', earthShadow: '#9aa2c8', belt: '#e8b6c0', beltAmount: 0.4, glow: '#ffd9c2', glowAmount: 0.9, mist: 0.7, stars: 0, moonLight: 0.2 },
			{ time: 6.6, sun: [ 82, 7 ], moon: [ 340, - 5 ], intensity: 1.0, zenith: '#bcd3ee', horizon: '#f3e3df', sunHorizon: '#ffe6cc', earthShadow: '#c8d2ea', belt: '#f0d0d4', beltAmount: 0.1, glow: '#fff0dc', glowAmount: 1.0, mist: 0.5, stars: 0, moonLight: 0 },
			{ time: 9.0, sun: [ 110, 32 ], moon: [ 0, - 40 ], intensity: 1.15, zenith: '#5d8fd8', horizon: '#d6e6f4', sunHorizon: '#eef4fa', earthShadow: '#cfdff0', belt: '#ffffff', beltAmount: 0, glow: '#fff6e8', glowAmount: 0.6, mist: 0.15, stars: 0, moonLight: 0 },
			{ time: 12.5, sun: [ 180, 52 ], moon: [ 60, - 50 ], intensity: 1.2, zenith: '#4a82d4', horizon: '#d2e4f4', sunHorizon: '#e8f0fa', earthShadow: '#cfe0f2', belt: '#ffffff', beltAmount: 0, glow: '#fff8ec', glowAmount: 0.5, mist: 0, stars: 0, moonLight: 0 },
			{ time: 16.5, sun: [ 255, 22 ], moon: [ 90, - 30 ], intensity: 1.1, zenith: '#5a86cc', horizon: '#e4dccc', sunHorizon: '#f6e0bc', earthShadow: '#cad6e8', belt: '#ffffff', beltAmount: 0, glow: '#ffe8c8', glowAmount: 0.7, mist: 0, stars: 0, moonLight: 0 },
			{ time: 18.85, sun: [ 280, 2.6 ], moon: [ 70, - 12 ], intensity: 0.9, zenith: '#8f6fbf', horizon: '#f27b8a', sunHorizon: '#ff9a4d', earthShadow: '#4c5276', belt: '#c47a92', beltAmount: 1, glow: '#ffb27a', glowAmount: 1.2, mist: 0.12, stars: 0, moonLight: 0 },
			{ time: 19.0, sun: [ 281, 1.0 ], moon: [ 68, - 8 ], intensity: 0.7, zenith: '#5a4a90', horizon: '#c86a80', sunHorizon: '#ff8a4a', earthShadow: '#3c4268', belt: '#a86a88', beltAmount: 1, glow: '#ff9a5a', glowAmount: 1.0, mist: 0.18, stars: 0, moonLight: 0 },
			{ time: 20.0, sun: [ 290, - 8 ], moon: [ 60, 3 ], intensity: 0.22, zenith: '#18204a', horizon: '#3a3a6c', sunHorizon: '#a05a6a', earthShadow: '#20284c', belt: '#4a3a62', beltAmount: 0.3, glow: '#a05a5a', glowAmount: 0.25, mist: 0.35, stars: 0.4, moonLight: 0.6 },
			{ time: 21.0, sun: [ 300, - 13 ], moon: [ 72, 12 ], intensity: 0.12, zenith: '#0b1636', horizon: '#1d2c5c', sunHorizon: '#2a2e5c', earthShadow: '#141f44', belt: '#1d2c5c', beltAmount: 0, glow: '#000000', glowAmount: 0, mist: 0.45, stars: 0.8, moonLight: 1 },
			{ time: 23.9, sun: [ 340, - 35 ], moon: [ 172, 33 ], intensity: 0.1, zenith: '#0b1a4a', horizon: '#1b3a8c', sunHorizon: '#1b3a8c', earthShadow: '#14286a', belt: '#1b3a8c', beltAmount: 0, glow: '#000000', glowAmount: 0, mist: 0.35, stars: 1, moonLight: 1 },
		],
		sunDiscRadius: 1.2,        // 太阳圆盘角半径（度），和落日一致
		sunDiscIntensity: 28,      // 太阳圆盘 HDR 亮度
		moonDiscRadius: 0.9,       // 月亮圆盘角半径（度）
		hazeDistance: 9000,        // 远景的大气透视：海拔 0 处这么远混一半地平线雾霭（越高空气越干净，见 hazeFalloff）
		// 远景地形：核心区（盆地和四周的山）网格细，外圈粗；核心区网格间距按档位（lo 给软件渲染和老核显）
		terrain: { coreSize: [ 4200, 4800 ], coreCenter: [ 100, 200 ], coreSpacing: { hi: 12.5, mid: 12.5, lo: 25 }, outerSize: 20000, outerSpacing: 75 },   // 外圈间距要能整除核心区的长宽，两块网格的边才对得齐
		biomeSpacing: 4,           // 地表图（河、桃林、花海、天光遮蔽）的像素间距（米）
		horizonSpacing: 25,        // 地形阴影用的地平线图间距（米），16 个方向
		hazeFalloff: 1500,         // 大气透视的高度衰减（米）：越高空气越干净
		mistDensity: 0.0005,       // 贴地薄雾在海拔 0 处的密度（每米，再乘 mist）；薄雾最多盖一半，远处地点的剪影还认得出
		mistFalloff: 55,           // 薄雾的衰减高度（米）：只贴着盆地底和湖面
		clouds: { height: 4500, coverage: 0.4, scale: 2400, speed: 7, direction: 70, octaves: { hi: 5, mid: 4, lo: 3 } },   // 薄云：高度（米）、覆盖率、尺度（米）、风速（米/秒）、风往哪个方位吹（度）
		windowLights: { gothic: 260, starry: 120 },   // 远景里的窗灯数量
		windowIntensity: 6,        // 窗灯 HDR 亮度（3~8）
		windowColor: '#ffb35c',
		// 秘境俯瞰（?world=1）：只看远景，自由飞行，调时刻
		overview: {
			near: 1,
			far: 30000,
			moveSpeed: 150,         // 米/秒，按住 Shift 乘 4
			startTime: 6.2,
			grading: { exposure: 1.0, contrast: 1.04, saturation: 1.05, tint: '#ffffff', tintAmount: 0, toneMapping: 'agx', grain: 0.004 },
			aerial: { position: [ 100, 3000, 3600 ], lookAt: [ 100, 0, - 300 ] },   // 3 公里高空，从南往北斜着看整个盆地
			map: { position: [ 100, 6200, 201 ], lookAt: [ 100, 0, 200 ] },        // 正上方往下看，核对地图
			// 环视时每个地点用的时刻（规格书 5.0 的时刻表取中间）
			locationTimes: { overture: 5.3, garden: 6.2, sunset: 18.9, gothic: 21.1, starry: 0.0, aurora: 4.2 },
		},
	},

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
