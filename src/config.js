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
	// duration：停留秒数；arrival：怎么到这里（flight 飞过来，canvas 飞过来、最后画布从四周蔓延，cave 在山洞里原地交接）
	// grading 是每个场景一套的调色（飞行途中两套插值）；shots 是截图脚本在该场景里截图的时间点（秒）
	scenes: [
		{
			key: 'overture',
			name: '黎明 · 桃花溪',
			duration: 62,
			arrival: 'start',
			grading: { exposure: 1.9, contrast: 1.04, saturation: 1.12, tint: '#f3c9d4', tintAmount: 0.05, toneMapping: 'agx' },
			shots: [ 3, 20, 42, 52, 60 ],
		},
		{
			key: 'garden',
			name: '清晨 · 白银花园城堡',
			duration: 75,
			arrival: 'cave',
			grading: { exposure: 0.92, contrast: 1.14, saturation: 1.1, tint: '#ffd9c2', tintAmount: 0.06, toneMapping: 'agx' },
			shots: [ 5, 35, 65 ],
		},
		{
			key: 'sunset',
			name: '黄昏 · 落日与海',
			duration: 70,
			arrival: 'flight',
			grading: { exposure: 1.0, contrast: 1.08, saturation: 1.1, tint: '#ff9a4d', tintAmount: 0.06, toneMapping: 'agx', grain: 0.006 },
			shots: [ 5, 35, 60 ],
		},
		{
			key: 'gothic',
			name: '入夜 · 哥特城堡',
			duration: 75,
			arrival: 'flight',
			grading: { exposure: 1.3, contrast: 1.1, saturation: 1.05, tint: '#b8c8f0', tintAmount: 0.05, toneMapping: 'agx' },
			shots: [ 5, 40, 70 ],
		},
		{
			key: 'starry',
			name: '深夜 · 星月夜',
			duration: 70,
			arrival: 'canvas',
			grading: { exposure: 1.0, contrast: 1.12, saturation: 1.15, tint: '#2c5aa0', tintAmount: 0.05, toneMapping: 'agx', grain: 0.004 },   // 油画不要胶片颗粒
			shots: [ 5, 35, 60 ],
		},
		{
			key: 'aurora',
			name: '凌晨 · 极光雪原',
			duration: 90,
			arrival: 'flight',
			grading: { exposure: 1.0, contrast: 1.08, saturation: 1.05, tint: '#4a5f8c', tintAmount: 0.06, toneMapping: 'agx' },
			shots: [ 5, 45, 85 ],
		},
	],

	// ===== 开场序列（CLAUDE.md 5.1.1）=====
	overture: {
		eyeHeight: 1.1,               // 坐在船上，眼睛离水面（米）
		caveEyeHeight: 1.4,           // 洞里眼睛离地面（米）：洞只有 2 米多高
		boatStopFromSource: 40,       // 船停在离源头（崖脚石缝）多远（米），林尽处
		handoffSpeed: 4,              // 在洞里交给花园时的速度（米/秒），花园接着这个速度走
		caveAdaptation: 3.2,          // 洞里眼睛适应暗处，曝光最多抬几倍（出洞时花园再落回 1）
		treeSpacing: 5.4,             // 桃树的网格间距（米，再随机抖动、按坡度和离溪远近稀疏）
		treeReach: 78,                // 离溪中线多远以内种（米）
		treeTemplates: 6,             // 几种树形
		cardsPerCluster: 7,           // 每团花多少张花枝卡片（近处；远处的树少一些）
		grass: { radius: 28, spacing: { hi: 0.15, mid: 0.19, lo: 0.24 }, height: [ 0.16, 0.5 ], width: 0.035 },
		petals: { count: { hi: 3200, mid: 2200, lo: 1400 }, box: 26 },
		fog: { density: 0.0055, falloff: 2.6, brightness: 1.1 }, // 贴水的晨雾：水面处每米的密度、衰减高度（米）、颜色亮度（60 米外盖一成多）
		spring: { halfWidth: 1.5, widenTo: 45 },                  // 源头的泉眼：半宽 1.5 米，往下游 45 米内慢慢放宽到溪的半宽
		dawnGlow: 0.9,                // 东边天上的晨光照到朝东的崖面上多少（0 关掉）
		mouthGlow: 0.55,              // 洞口里透出来的暖光（"仿佛若有光"）亮度
	},

	// ===== 场景 1：白银花园城堡（CLAUDE.md 第 10 节）=====
	garden: {
		pool: { start: - 16, halfWidth: 6.5, waterDepth: 0.35 },   // 水池从出生点前 16 米开始，一直到台基脚下；半宽、水面比地面低多少（米）
		castleScale: 1.22,                   // 城堡整体放大（台基 117 米见方、顶尖约 113 米高）
		paths: { outer: 12.5 },              // 池边步道外沿离中轴多远（米）
		beds: { inner: 13.5, outer: 21 },    // 花圃
		gardenHalf: 95,                      // 正式花园的半宽（再往外是有起伏的草地和花树）
		terrainRect: { minX: - 150, maxX: 150, minZ: - 400, maxZ: 60 },   // 花园自己的地面（局部坐标），远景在里面压低
		cypressSpacing: 10, cypressOffset: 10,   // 柏树：沿水池每 10 米一棵，离中轴 10 米
		flowerDensity: { hi: 16, mid: 11, lo: 7 }, // 花圃每平方米几朵（叶丛另外按七成撒）
		blossomTrees: 70,                    // 开花的树
		cardsPerCluster: 7,
		grass: { radius: 26, spacing: { hi: 0.16, mid: 0.2, lo: 0.26 }, height: [ 0.1, 0.3 ], width: 0.03 },
		petals: { count: { hi: 2400, mid: 1600, lo: 1000 }, box: 28 },
		// 倒影水池的平面倒影分辨率（hi、mid、lo 内容档）：规格书表里"低"是关，但这个场景的验收就是城堡完整清晰的倒影，
		// 所以 mid 档（用"低"那一列）也留着，降到 0.25 倍
		reflectionScale: { hi: 0.5, mid: 0.35, lo: 0.25 },
		fog: { density: 0.0012, falloff: 14, brightness: 1.0 },   // 晨雾：城堡（330 米外）盖三成左右，城堡和天空、雾分得开层次（规格书 10.3）
		shafts: { amount: 0.35 },            // 光束强度
		walk: { minX: - 120, maxX: 120, maxZ: 50 },
	},

	// ===== 场景 3：哥特城堡（CLAUDE.md 第 11 节）=====
	gothic: {
		terrainRect: { minX: - 110, maxX: 110, minZ: - 60, maxZ: 90 },   // 机位周围自己画的湖岸（局部坐标）
		castleScale: 1.45,                   // 城堡整体放大（远景的替身也按它放大，从别的地点看过来是同一座）
		walk: { minX: - 100, maxX: 100, minZ: - 50, maxZ: 80 },
		// 窗灯：亮起时刻 = start + 楼层比例 × floorDelay + 房间组的随机延迟（0~groupSpread）+ 每扇的抖动（0~windowJitter）秒；
		// 亮度 HDR intensity[0]~[1]，2700K 暖黄；倒影光柱拖多长（米，按镜像点的距离算）
		windows: { start: 2, floorDelay: 14, groupSpread: 9, windowJitter: 1.5, intensity: [ 3, 8 ], color: '#ffb35c', columnLength: 26 },
		reflectionScale: { hi: 0.5, mid: 0.35, lo: 0.25 },
		grass: { radius: 24, spacing: { hi: 0.17, mid: 0.21, lo: 0.27 }, height: [ 0.15, 0.45 ], width: 0.035 },
		fireflies: { hi: 420, mid: 300, lo: 200 },
		fog: { density: 0.0014, falloff: 9, brightness: 1.0, moonScatter: 0.35 },
	},

	// ===== 场景 4：星月夜（CLAUDE.md 第 9 节）=====
	starry: {
		skyResolution: { hi: [ 2560, 1100 ], mid: [ 1792, 770 ], lo: [ 1280, 550 ] },   // 天空贴图（天空坐标里的 LIC + 配色；屏幕上放大不超过 2 倍）
		licSteps: { hi: 22, mid: 16, lo: 11 },        // LIC 正反各积分多少步（规格书 16~32；低档少一些）
		strokes: { hi: 13000, mid: 9000, lo: 6000 },  // 天空上的笔触（Floyd–Steinberg 布点）
		cypress: { position: [ - 26, - 46 ], height: 34, radius: 3.4 },   // 柏树（局部坐标）、高、半径（米）
		kuwahara: 1,                                  // 油画滤镜（只在 hi 档的原生链上起作用）
	},

	// ===== 时间线：预加载、起飞、方向键跳转（CLAUDE.md 5.3、5.5）=====
	timeline: {
		preloadDelay: 8,            // 停留这么多秒、而且她没在动，就开始在后台加载下一个地点
		preloadIdle: 1,             // "没在动"要持续多少秒
		preloadLatestFraction: 0.5, // 最迟停留到一半必须开始加载
		departIdle: 3,              // 到点时她正在走：等她停下这么多秒再起飞
		departMaxWait: 15,          // 最多多等这么多秒
		loadMaxWait: 20,            // 下一个地点还没准备好，最多多停留这么多秒（超过只报一次，继续等，不能飞去没编好的地点）
		jumpVeilSeconds: 1.2,       // 方向键跳到上 / 下一个地点：同色薄雾淡出淡入的总时长
		restartVeilSeconds: 2.0,    // "再走一遍"的薄雾淡出淡入
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
		// 三档（规格书 6.1）：hi 实时原生 / mid 实时放大（fsr1）/ pano 全景。显卡名只作先验（不分大小写，WebGPU 下多半只有厂商和架构）
		softwareKeywords: [ 'SwiftShader', 'llvmpipe', 'lavapipe', 'Basic Render', 'Software' ],     // 软件渲染：直接 pano，不测
		discreteKeywords: [ 'NVIDIA', 'GeForce', 'RTX', 'GTX', 'Radeon RX', 'Radeon Pro', 'Arc(TM) A', 'Arc A' ],   // 独显：至少 mid
		recentIntegratedKeywords: [ 'Iris Xe', 'Iris(R) Xe', 'Intel(R) Arc', 'Arc(TM) Graphics', 'xe-lpg', 'gen-12lp', '680M', '760M', '780M', '880M', '890M', 'Apple M' ],   // 先验 mid
		oldIntegratedKeywords: [ 'HD Graphics', 'UHD Graphics 6', 'UHD Graphics 7', 'Iris(R) Plus', 'Iris Plus', 'Vega 3', 'Vega 6', 'Vega 8', 'gen-9', 'gen-11' ],   // 先验 pano
		tierContent: { hi: 'hi', mid: 'lo', pano: 'lo' },   // 每档用 tiers 里的哪一列效果参数（mid 用"低"）
		sceneScale: { hi: [ 0.67, 1 ], mid: [ 0.5, 0.77 ], pano: [ 1, 1 ] },   // 场景按画布的多少倍画 [最低, 最高]；小于 1 时用 fsr1 放大回原生
		panoPixelRatio: 0.5,          // pano 档画布的像素比（相对 CSS 像素）：全景图本身已经很柔，按一半分辨率画再拉伸看不出差别，软件渲染下快四倍
		// 基准测试：离屏 width×height 的重负载着色器，预热 warmupFrames 帧再画 frames 帧，每帧读回 1 个像素等显卡做完。
		// 中位数 ≤ baselineMs × hiFactor → hi，≤ × midFactor → mid，否则 pano；第一帧超过 firstFrameLimitMs 直接 pano。
		// baselineMs 是开发机（RTX 5060）上量到的值；没插电源时测出来的时间乘 batteryPenalty（判定更保守）
		benchmark: { width: 1280, height: 720, warmupFrames: 4, frames: 10, firstFrameLimitMs: 120, baselineMs: 2.7, hiFactor: 5, midFactor: 25, batteryPenalty: 1.35 },
		dynamic: {
			// 有显卡时间戳（WebGPU 大多有）：每帧显卡干活的时间超过这一档的预算才降，有余量就升回去
			gpuBudgetMs: { hi: 14, mid: 22 },
			// 没有显卡计时：帧间隔比"刷新间隔"长 45% 以上、且超过 slowFrameMs 才算掉帧（被垂直同步或浏览器限帧卡住不算）
			slowFrameMs: 20,
			slowFrames: 30,        // 连续这么多帧超预算 → 渲染比例降 0.1
			fastFrames: 120,       // 连续这么多帧有余量 → 升 0.1（没有显卡计时时要两倍这么多帧，且离上次降至少 raiseCooldown 秒）
			raiseCooldown: 20,     // 没有显卡计时时，降比例以后至少等这么多秒才试着升回去
			step: 0.1,             // 场景比例每次升降多少；降到这一档的最低比例（sceneScale）还超预算就降一档
		},
		tiers: {
			hi:  { pixelRatioCap: 2.0, pixelRatio: 1.5, volumeFullRes: true,  volumeSteps: 40, instanceRatio: 1.0, reflectionScale: 0.5,  kuwahara: 'on',   sparkleLayers: 3, shadowSize: 2048 },
			mid: { pixelRatioCap: 1.0, pixelRatio: 1.0, volumeFullRes: false, volumeSteps: 28, instanceRatio: 0.6, reflectionScale: 0.35, kuwahara: 'half', sparkleLayers: 2, shadowSize: 1024 },
			lo:  { pixelRatioCap: 1.25, pixelRatio: 1.25, volumeFullRes: false, volumeSteps: 16, instanceRatio: 0.3, reflectionScale: 0,    kuwahara: 'off',  sparkleLayers: 2, shadowSize: 0 },
		},
	},

	// ===== 后期 =====
	post: {
		bloom: { strength: 0.35, radius: 0.4, threshold: 0.9 },
		vignette: { amount: 0.32, softness: 0.55 },
		grain: 0.025,            // 胶片颗粒强度，0 关闭
		canvasRevealTiles: 180,  // 场景 4 画布纹理的经纱密度（越大越细）
		fsrSharpness: 0.25,      // fsr1 放大后 RCAS 锐化的程度（0 最锐，越大越柔；AMD 默认 0.2）
	},

	// ===== 音频（阶段 0 全程序化合成，素材到位后替换）=====
	audio: {
		masterVolume: 0.5,
		crossfade: 3,   // 场景切换时交叉淡入淡出秒数
		music: { volume: 0.12, chordSeconds: 9 },   // 贯穿全程的轻音乐（程序化的和声垫 + 八音盒单音）：音量、每个和弦几秒
		scenes: {
			flight: { kind: 'wind',  volume: 0.3,  cutoff: 1200, lfoRate: 0.15 },   // 飞行途中的风
			overture: { kind: 'stream', volume: 0.32, cutoff: 700, lfoRate: 0.1 },    // 溪流 + 船桨（离船以后停）
			garden: { kind: 'birds', volume: 0.22, cutoff: 900,  lfoRate: 0.12 },    // 鸟鸣微风
			sunset: { kind: 'waves', volume: 0.45, cutoff: 500,  lfoRate: 0.08 },
			gothic: { kind: 'night', volume: 0.2,  cutoff: 400,  lfoRate: 0.05 },
			starry: { kind: 'quiet', volume: 0.05, cutoff: 300,  lfoRate: 0.03 },
			aurora: { kind: 'wind',  volume: 0.35, cutoff: 700,  lfoRate: 0.07 },
		},
	},

	// ===== 全景模式（pano 档，规格书 6.5）=====
	// 烘焙（node scripts/bake-pano.mjs）：每个地点沿路线几个烘焙点，在开发机上用最高画质渲立方体六面（每面 faceFov 度，
	// 含每边 15° 余量，faceSize 像素），拼成 width 宽的等距柱状全景图；遮罩、夜空高精度渐变、每段飞行的视频一起烘。
	// 播放：镜头固定在烘焙点，按 views 的关键帧慢慢转向、推近（视场 50° → 38°），按 points 的 switchAt 在相邻烘焙点之间
	// 交叉淡化，看起来像慢慢往前走；拖动能转一整圈，松手 6 秒后回正
	panorama: {
		faceSize: 2880,
		faceFov: 120,
		width: 8192,                 // 全景图宽（高是一半）
		maskWidth: 2048,             // 遮罩宽：R 天空、G 闪光密度、B 窗户编号、A 水面
		skyWidth: 512,               // 夜空高精度渐变宽（半精度，消色带）
		webpQuality: 90,
		cssWidth: 6144,              // CSS 3D 兜底用的"全开"全景宽（只给有实时叠加层的地点另存一张，叠加层烘进去）
		crossfade: 5,                // 烘焙点之间交叉淡化的秒数
		dragYawMax: 180, dragPitchMax: 50, dragReturnDelay: 6, dragReturnDamping: 0.6,
		video: { width: 1920, height: 1080, fps: 30, crf: 23 },
		// 每个地点：points 烘焙点（position 'spawn' = 出生点，或本地 [x, z]，高度取地面 + 眼高，或 { route: 秒 } 取镜头路线上那一刻的位置；
		//   time 烘焙时的停留秒数；switchAt 从上一个点淡到这一个点的时刻）
		//   views 视角关键帧（停留秒数、偏航 yaw（度，0 = 本地 −z，往右为正）、俯仰、视场）
		//   off 烘焙时关掉、播放时实时叠加的层；sparkleLayer 闪点那一层（烘焙时开关两次求差，得到闪光密度遮罩）
		locations: {
			overture: {
				// 开场的烘焙点取镜头路线上某个时刻的位置（route：秒），船上的眼高
				points: [ { position: { route: 3 }, time: 3 }, { position: { route: 22 }, time: 22, switchAt: 19 }, { position: { route: 40 }, time: 40, switchAt: 36 }, { position: { route: 51 }, time: 51, switchAt: 47 } ],
				views: [ { time: 0, yaw: 0, pitch: 9, fov: 50 }, { time: 12, yaw: 0, pitch: 2, fov: 50 }, { time: 40, yaw: - 2, pitch: 4, fov: 48 }, { time: 50, yaw: - 3, pitch: 14, fov: 44 }, { time: 62, yaw: - 3, pitch: 10, fov: 40 } ],
				off: [], sparkleLayer: null, overlays: [ 'petals' ],
			},
			garden: {
				points: [ { position: 'spawn', time: 5 }, { position: [ 0, - 60 ], time: 35, switchAt: 32 }, { position: [ 0, - 130 ], time: 65, switchAt: 62 } ],
				views: [ { time: 0, yaw: 0, pitch: - 2, fov: 50 }, { time: 75, yaw: 0, pitch: 1, fov: 40 } ],
				off: [], sparkleLayer: null, overlays: [ 'petals' ],
			},
			sunset: {
				points: [ { position: 'spawn', time: 5 }, { position: [ - 3, 34 ], time: 35, switchAt: 30 }, { position: [ - 9, 3 ], time: 60, switchAt: 55 } ],
				views: [ { time: 0, yaw: 0, pitch: 4, fov: 50 }, { time: 28, yaw: 0, pitch: 3, fov: 44 }, { time: 50, yaw: - 8, pitch: 2, fov: 46 }, { time: 70, yaw: - 3, pitch: 4, fov: 38 } ],
				off: [ '闪点', '海鸥' ], sparkleLayer: '闪点', overlays: [ 'sparkles', 'seagulls' ],
			},
			gothic: {
				// 哥特：都在岸上（再往前就是湖了）；窗灯按停留时间亮，烘焙点的时刻越晚亮得越多
				points: [ { position: 'spawn', time: 12 }, { position: [ 12, 6 ], time: 40, switchAt: 34 }, { position: [ - 30, 26 ], time: 70, switchAt: 62 } ],
				views: [ { time: 0, yaw: 0, pitch: 3, fov: 50 }, { time: 75, yaw: 2, pitch: 5, fov: 40 } ],
				off: [], sparkleLayer: null, overlays: [ 'fireflies' ],
			},
			starry: {
				points: [ { position: 'spawn', time: 35 } ],
				// 俯仰和实时档一样微微抬头（实时档看小镇上方 72 米，约 8°），下面不露一大片山坡
				views: [ { time: 0, yaw: 0, pitch: 8, fov: 50 }, { time: 56, yaw: 1, pitch: 9, fov: 44 }, { time: 70, yaw: 12, pitch: 18, fov: 38 } ],
				off: [], sparkleLayer: null,
			},
			aurora: {
				points: [ { position: 'spawn', time: 5 }, { position: [ - 4, - 200 ], time: 45, switchAt: 36 }, { position: [ 4, - 389 ], time: 85, switchAt: 66 } ],
				views: [ { time: 0, yaw: 180, pitch: - 10, fov: 50 }, { time: 10, yaw: 180, pitch: - 8, fov: 50 }, { time: 15, yaw: 270, pitch: - 1, fov: 50 }, { time: 20, yaw: 360, pitch: 5, fov: 50 }, { time: 60, yaw: 356, pitch: 6, fov: 46 }, { time: 76, yaw: 361, pitch: 14, fov: 44 }, { time: 90, yaw: 361, pitch: 28, fov: 38 } ],
				off: [ '闪光', '极光', '飘雪', '地吹雪' ], sparkleLayer: '闪光', overlays: [ 'aurora', 'snow', 'sparkles' ],
			},
		},
	},

	// ===== 场景细节开关 =====
	footprintsReveal: true,   // 雪原脚印随人往前走一个一个出现在前方

	// ===== 秘境：世界地图和一天的天空（CLAUDE.md 5.0）=====
	// 坐标：+x 东、−z 北、y 海拔（米）；方位角从北顺时针量（度）。时刻用小时（5.75 = 05:45），24 小时循环
	world: {
		// 每个地点：原点（本地 0,0,0 在世界里的位置）、yaw（本地 −z 在世界里的方位角）、内容半径（米，这个范围里是地点自己的细节）、
		//   time：停留期间的时刻 [开始, 结束]（小时，规格书 5.0 的时刻表；结束可以超过 24）
		//   view：停留时相机远近（米，默认 0.1 / 30000）、远景要不要压缩深度（compressStart → compressEnd，默认不压）、
		//         远景里这个地点自己的替身藏不藏（hideProxy，默认藏；简版地点直接用替身当城堡和小镇）
		locations: {
			// 开场原点在桃花溪上、洞口南边约 215 米（阶段 7 定：62 秒里船走 130 米再上岸进洞，原来的 (−480, 10, 2150) 离洞 510 米到不了）
			overture: { name: '溪口桃花林', origin: [ - 496, 20.8, 1855 ], yaw: 355, contentRadius: 300, time: [ 5.0, 5.75 ] },
			garden: { name: '白银花园', origin: [ - 430, 24, 1380 ], yaw: 75, contentRadius: 350, landmark: [ - 110, 24, 1295 ], time: [ 5.75, 6 + 40 / 60 ] },
			sunset: { name: '落日海湾', origin: [ - 1250, 0, 150 ], yaw: 280, contentRadius: 2000, time: [ 18 + 50 / 60, 19 ] },
			// 哥特机位离湖边 4 米（原来 18 米，画面下面三成是一片黑的草坡；挪到水边，下半幅是湖、城堡和灯的倒影）
			gothic: { name: '哥特城堡', origin: [ - 37, 57, - 44 ], yaw: 72, contentRadius: 700, landmark: [ 520, 95, - 225 ], time: [ 20.75, 21.5 ] },
			starry: { name: '星月夜', origin: [ 150, 210, - 1250 ], yaw: 160, contentRadius: 500, landmark: [ 235, 175, - 1015 ], time: [ 23 + 40 / 60, 24.5 ], view: { hideProxy: false } },
			aurora: { name: '极光雪原', origin: [ 100, 560, - 1775 ], yaw: 0, contentRadius: 1100, time: [ 3 + 40 / 60, 4 + 40 / 60 ] },   // 原点在崖边：先朝南看秘境，再往北走
		},
		// 飞行（规格书 5.3）：巡航离地 80~150 米、不超过 80 米/秒、侧倾不超过 8°；拖动转头最多 ±30°，松手很快回正
		flight: {
			near: 1, far: 30000,          // 飞行时只画远景，相机远近和俯瞰模式一样，不压缩
			maxSpeed: 80,                 // 米/秒：航线太长（她走远了）就自动拉长飞行时间
			minClearance: 80,             // 巡航最低离地（米）
			rampDistance: 250,            // 起飞、降落这么长（米）的航段里离地要求从 0 慢慢升到巡航
			accelTime: 4, decelTime: 5.5, // 起步加速、降落减速的秒数
			liftHeight: 40,               // 起飞先往上升多少米、同时往第一个航点那边飘多少米
			liftDrift: 40,
			maxBank: 8,                   // 转弯侧倾上限（度）
			lookPitchFollow: 0.5,         // 视线俯仰跟着航线升降的比例
			lookPitchLimit: 10,           // 视线俯仰最多跟到 ±10°
			lookPitchBias: - 5,           // 巡航时略微低头看地面（度）
			departTurn: 4.5,              // 起飞后多少秒内视线从她原来的朝向转到航线方向
			arriveTurn: 6,                // 降落前多少秒开始转到出生点的朝向
			dragYawMax: 30, dragPitchMax: 20, dragReturnDamping: 5,
			autoExposure: 1,              // 夜里飞行按天空亮度抬曝光的程度（0 不抬，1 和俯瞰模式一样）
			canvasSeconds: 3.5,           // 进星月夜画布从四周蔓延、离开时退去的秒数
			// 同色薄雾交接：出发时 A 化进雾里（in）、停一下（hold，在正中间切到只画远景）、雾散开（out）；到达时反过来
			veil: { departIn: 2.2, departHold: 0.3, departOut: 2.5, arriveIn: 2.2, arriveHold: 0.3, arriveOut: 2.5, clearBeforeEnd: 0.8, near: 5, far: 400 },
		},
		// 四段航线：只写巡航和进场的航点（世界坐标，y 是海拔），起点（她当时站的地方）和终点（下一个地点的出生点）由程序补上。
		// duration 秒；departTurnDirection / arriveTurnDirection：起飞、降落转身往哪边转（shortest / clockwise / counterclockwise）
		legs: [
			{ from: 'garden', to: 'sunset', duration: 28, waypoints: [ [ - 650, 125, 1275 ], [ - 930, 125, 930 ], [ - 1030, 175, 660 ], [ - 1080, 120, 400 ], [ - 1132, 45, 171 ] ] },
			{ from: 'sunset', to: 'gothic', duration: 22, departTurnDirection: 'clockwise', waypoints: [ [ - 950, 115, 100 ], [ - 600, 140, 40 ], [ - 300, 150, 0 ], [ - 193, 100, 6 ] ] },
			{ from: 'gothic', to: 'starry', duration: 24, arriveTurnDirection: 'clockwise', waypoints: [ [ 120, 150, - 300 ], [ 235, 210, - 650 ], [ 240, 280, - 1000 ], [ 185, 250, - 1165 ] ] },
			// 沿冰瀑爬升：离崖面保持 110 米以上、抬头看冰瀑和崖顶上的夜空（离崖太近整屏是背光的崖壁），过崖顶后往右转身朝南；
			// 崖面前离地会超过 150 米，这是规格书写明的例外
			{ from: 'starry', to: 'aurora', duration: 20, decelTime: 6.5, rampEndDistance: 450, arriveTurnDirection: 'clockwise', lookPitchLimit: 20, lookPitchBias: 0, waypoints: [ [ 150, 300, - 1420 ], [ 150, 380, - 1520 ], [ 148, 480, - 1580 ], [ 140, 575, - 1640 ], [ 125, 600, - 1720 ] ] },
		],
		// 山洞（规格书 5.0、5.1.1）：outer / inner 是两个洞口（洞外的平台按它压平）；path 是洞地面的中线（外口 → 内口，世界坐标，
		// 两头各伸出洞口一点），中间轻轻拐两下；widths / heights 是 [沿洞的比例, 宽或高（米）]，"初极狭，才通人"：前半段只有 1.2 米宽；
		// handoff 是开场在洞里哪个位置（比例）原地交给花园
		cave: {
			outer: [ - 520, 26, 1645 ], inner: [ - 520, 30, 1570 ],
			path: [ [ - 520.4, 26.2, 1649.4 ], [ - 520.3, 26.3, 1644 ], [ - 521, 26.5, 1626 ], [ - 518, 27.6, 1605 ], [ - 519.5, 29.2, 1585 ], [ - 520, 30, 1567 ] ],
			widths: [ [ 0, 1.7 ], [ 0.06, 1.3 ], [ 0.42, 1.2 ], [ 0.62, 2.0 ], [ 0.86, 3.2 ], [ 1, 4.6 ] ],
			heights: [ [ 0, 2.3 ], [ 0.08, 2.05 ], [ 0.45, 2.15 ], [ 0.7, 3.0 ], [ 1, 4.3 ] ],
			handoff: 0.4,
		},
		lake: { center: [ 230, - 130 ], radiusX: 270, radiusZ: 200, level: 55 },
		// 河：湖南端 → 花园 → 西边入海；小镇溪：冰瀑脚 → 湖北端；桃花溪：洞外口 → 往南出山（渔人从这里来）
		// key 是程序里认的名字（不要改）；name 只是给人看的。控制点之间按曲线重采样、加一点蜿蜒（地点附近不蜿蜒）
		rivers: [
			{ key: 'river', name: '河', width: 26, points: [ [ 200, 54.5, 60 ], [ 140, 46, 380 ], [ - 40, 36, 780 ], [ - 210, 28, 1120 ], [ - 300, 24, 1300 ], [ - 620, 14, 1260 ], [ - 930, 6, 930 ], [ - 1300, 0, 640 ], [ - 1560, 0, 560 ] ] },
			{ key: 'townStream', name: '小镇溪', width: 9, points: [ [ 150, 210, - 1690 ], [ 230, 190, - 1420 ], [ 260, 165, - 1030 ], [ 270, 110, - 650 ], [ 250, 56, - 320 ] ] },
			// 桃花溪：源头就在洞口正下方的崖脚石缝（22.2 米，溪的头墙就是洞口所在的那面崖），一小段急流落到 21.15 米，船走的那 180 米几乎是平的（好倒影），弯两次；再往南才急下去
			{ key: 'peachStream', name: '桃花溪', width: 10, bankSlope: 0.08, bankCurve: 0.0042, headWallSlope: 1.8,
				// 头墙的起伏：溪轴线两边 6 米内不动；墙脚前后进退 ±3.5 米，墙面竖棱 ±1.2 米，墙脚圆角约 4 米；谷坡和山坡交线的圆角 10 米
				headWallShape: { innerCalm: 6, footWander: 3.5, ribDepth: 1.2, footRadius: 4, creaseSoftness: 10 },
				points: [ [ - 520.5, 22.2, 1649 ], [ - 517, 21.15, 1681 ], [ - 512, 21.05, 1702 ], [ - 502, 21.0, 1735 ], [ - 514, 20.95, 1782 ], [ - 499, 20.85, 1825 ], [ - 496, 20.8, 1855 ], [ - 491, 17.5, 1960 ], [ - 480, 10, 2150 ], [ - 450, 6, 2500 ], [ - 380, 3, 2900 ] ] },
		],
		// 一天的天空关键帧（按时刻插值）。sun / moon 是 [方位角, 仰角]（度）；颜色是 sRGB；intensity 是天空整体亮度（HDR 倍数）
		//   zenith 天顶；horizon 地平线（侧面）；sunHorizon 太阳那边的地平线；earthShadow 背着太阳的地平线；
		//   belt 维纳斯带颜色和强度；glow 太阳周围的光晕颜色和强度；mist 贴地薄雾（0~1）；stars / moonLight 星星、月光的强度
		skyKeys: [
			{ time: 0.5, sun: [ 0, - 40 ], moon: [ 185, 35 ], intensity: 0.07, zenith: '#03060f', horizon: '#101a38', sunHorizon: '#101a38', earthShadow: '#0b1530', belt: '#1a2448', beltAmount: 0, glow: '#000000', glowAmount: 0, mist: 0.3, stars: 1, moonLight: 1 },
			{ time: 3.6, sun: [ 45, - 15 ], moon: [ 322, 15 ], intensity: 0.06, zenith: '#03060f', horizon: '#0d1730', sunHorizon: '#1a2550', earthShadow: '#0a1228', belt: '#1a2448', beltAmount: 0, glow: '#000000', glowAmount: 0, mist: 0.35, stars: 1, moonLight: 1 },
			{ time: 4.75, sun: [ 45, - 15 ], moon: [ 322, 15 ], intensity: 0.06, zenith: '#03060f', horizon: '#0d1730', sunHorizon: '#1a2550', earthShadow: '#0a1228', belt: '#1a2448', beltAmount: 0, glow: '#000000', glowAmount: 0, mist: 0.35, stars: 1, moonLight: 1 },
			{ time: 5.0, sun: [ 75, - 8 ], moon: [ 344, 29 ], intensity: 0.22, zenith: '#14204a', horizon: '#3b4a7e', sunHorizon: '#9a7a9a', earthShadow: '#26305a', belt: '#5a4a78', beltAmount: 0.3, glow: '#c08080', glowAmount: 0.2, mist: 0.7, stars: 0.35, moonLight: 0.6 },
			{ time: 5.75, sun: [ 77, - 0.5 ], moon: [ 335, 4 ], intensity: 0.75, zenith: '#8fa6d6', horizon: '#e6c9c4', sunHorizon: '#ffcfae', earthShadow: '#9aa2c8', belt: '#e8b6c0', beltAmount: 0.4, glow: '#ffd9c2', glowAmount: 0.9, mist: 0.7, stars: 0, moonLight: 0.2 },
			{ time: 6.6, sun: [ 82, 7 ], moon: [ 340, - 5 ], intensity: 1.0, zenith: '#bcd3ee', horizon: '#f3e3df', sunHorizon: '#ffe6cc', earthShadow: '#c8d2ea', belt: '#f0d0d4', beltAmount: 0.1, glow: '#fff0dc', glowAmount: 1.0, mist: 0.5, stars: 0, moonLight: 0 },
			{ time: 9.0, sun: [ 110, 32 ], moon: [ 0, - 40 ], intensity: 1.15, zenith: '#5d8fd8', horizon: '#d6e6f4', sunHorizon: '#eef4fa', earthShadow: '#cfdff0', belt: '#ffffff', beltAmount: 0, glow: '#fff6e8', glowAmount: 0.6, mist: 0.15, stars: 0, moonLight: 0 },
			{ time: 12.5, sun: [ 180, 52 ], moon: [ 60, - 50 ], intensity: 1.2, zenith: '#4a82d4', horizon: '#d2e4f4', sunHorizon: '#e8f0fa', earthShadow: '#cfe0f2', belt: '#ffffff', beltAmount: 0, glow: '#fff8ec', glowAmount: 0.5, mist: 0, stars: 0, moonLight: 0 },
			{ time: 16.5, sun: [ 255, 22 ], moon: [ 90, - 30 ], intensity: 1.1, zenith: '#5a86cc', horizon: '#e4dccc', sunHorizon: '#f6e0bc', earthShadow: '#cad6e8', belt: '#ffffff', beltAmount: 0, glow: '#ffe8c8', glowAmount: 0.7, mist: 0, stars: 0, moonLight: 0 },
			{ time: 18 + 50 / 60, sun: [ 280, 2.6 ], moon: [ 70, - 12 ], intensity: 0.9, zenith: '#8f6fbf', horizon: '#f27b8a', sunHorizon: '#ff9a4d', earthShadow: '#4c5276', belt: '#c47a92', beltAmount: 1, glow: '#ffb27a', glowAmount: 1.2, mist: 0.12, stars: 0, moonLight: 0 },
			{ time: 19.0, sun: [ 280, 1.0 ], moon: [ 68, - 8 ], intensity: 0.7, zenith: '#5a4a90', horizon: '#c86a80', sunHorizon: '#ff8a4a', earthShadow: '#3c4268', belt: '#a86a88', beltAmount: 1, glow: '#ff9a5a', glowAmount: 1.0, mist: 0.18, stars: 0, moonLight: 0 },
			{ time: 20.0, sun: [ 290, - 8 ], moon: [ 60, 3 ], intensity: 0.22, zenith: '#18204a', horizon: '#3a3a6c', sunHorizon: '#a05a6a', earthShadow: '#20284c', belt: '#4a3a62', beltAmount: 0.3, glow: '#a05a5a', glowAmount: 0.25, mist: 0.35, stars: 0.4, moonLight: 0.6 },
			{ time: 21.0, sun: [ 300, - 13 ], moon: [ 72, 12 ], intensity: 0.12, zenith: '#0b1636', horizon: '#1d2c5c', sunHorizon: '#2a2e5c', earthShadow: '#141f44', belt: '#1d2c5c', beltAmount: 0, glow: '#000000', glowAmount: 0, mist: 0.45, stars: 0.8, moonLight: 1 },
			{ time: 23.9, sun: [ 340, - 35 ], moon: [ 172, 33 ], intensity: 0.1, zenith: '#0b1a4a', horizon: '#1b3a8c', sunHorizon: '#1b3a8c', earthShadow: '#14286a', belt: '#1b3a8c', beltAmount: 0, glow: '#000000', glowAmount: 0, mist: 0.35, stars: 1, moonLight: 1 },
		],
		sunDiscRadius: 1.2,        // 太阳圆盘角半径（度），和落日一致
		sunDiscIntensity: 28,      // 太阳圆盘 HDR 亮度
		moonDiscRadius: 0.9,       // 月亮圆盘角半径（度）
		hazeDistance: 9000,        // 远景的大气透视：海拔 0 处这么远混一半地平线雾霭（越高空气越干净，见 hazeFalloff）
		// 远景地形：核心区（盆地和四周的山）网格细，外圈粗；核心区网格间距按档位（lo 给软件渲染和老核显）
		terrain: { coreSize: [ 4200, 4800 ], coreCenter: [ 100, 200 ], coreSpacing: { hi: 12.5, mid: 12.5, lo: 12.5 }, outerSize: 20000, outerSpacing: 75 },   // 外圈间距要能整除核心区的长宽，两块网格的边才对得齐
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
		// 太阳的方位和仰角按世界的时刻走（world.skyKeys 里 18:50 和 19:00 两帧：2.6° → 1.0°，正对出生点）
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
		backdropGain: 0.55,          // 站在这里时远景（世界的地形、树、替身）的亮度倍数：落日自己的物理光照只有统一天空阳光的一半左右，压下来接缝才对得上
	},

	// ===== 场景 5：极光雪原 =====
	aurora: {
		terrainSize: 700,            // 地形边长（米）
		terrainCenterZ: - 200,       // 地形中心的 z（路径从 z=0 往 -z 走 400 米）
		pathLength: 400,             // 脚印路径长度（米）
		// 月亮的方位和仰角按世界的时刻走（world.skyKeys 里 03:36~04:45 钉在 322°/15°：偏左、偏低，有长影子和逆光轮廓）
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
		rimClearance: 4,             // 走到崖前多少米为止
		backdropGain: 2.5,           // 站在这里时远景（世界的地形、树、替身）的亮度倍数：雪原的月光是统一天空月光的约 9 倍，盆地不压暗也不能太亮
		holeDepth: 60,               // 雪原地形底下的远景压低多少米（让开，不和雪原地形互相穿插）
	},

};

export default config;
