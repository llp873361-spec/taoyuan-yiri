// 所有可调参数和文字都在这里。改完重新 npm run build 即可，不用动别的文件。

const config = {

	// ===== 开场卡文字（自己填）=====
	openingTitle: '桃源一日',
	openingSubtitle: '',
	clickToStart: '点击开启',
	openingHints: [ '插上电源效果更好', '按 F 全屏' ],

	// ===== 结尾（自己填）=====
	endingText: '',
	creditsLabel: '致谢',
	replayLabel: '再走一遍',
	// ===== 小提示（2026-10-02 审查：她不知道能拖动、能走，就会对着一个方向看完整段）=====
	// 在某个地点停留到第 at 秒时，如果她在这个地点还没拖过、没走过，屏幕下方淡入一行小字，duration 秒后淡出；每一轮只出一次
	hints: [
		{ scene: 'garden', at: 15, duration: 5, text: '拖动看看四周 · W A S D 走走' },
		{ scene: 'gothic', at: 7, duration: 6, text: '左边的石桥通到城堡脚下 · 按住 Shift 走得快' },
		{ scene: 'aurora', at: 9, duration: 6, text: '转过身，看看身后' },
	],

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
			duration: 90,          // 原来 75 秒；2026-10-02 加了跨湖的石桥（走到城堡脚下要四五十秒），多给 15 秒
			arrival: 'flight',
			grading: { exposure: 1.3, contrast: 1.1, saturation: 1.05, tint: '#b8c8f0', tintAmount: 0.05, toneMapping: 'agx' },
			shots: [ 5, 40, 70 ],
		},
		{
			key: 'starry',
			name: '深夜 · 星月夜',
			duration: 70,
			arrival: 'canvas',
			// 原画是很深、很饱和的群青和钴蓝：AgX 会把亮的颜色冲淡，所以曝光压低、饱和拉高
			grading: { exposure: 0.8, contrast: 1.18, saturation: 1.5, tint: '#2c5aa0', tintAmount: 0.04, toneMapping: 'agx', grain: 0.004 },   // 油画不要胶片颗粒
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
		boatFreeboard: 0.22,          // 船沿高出水面多少（米）：船底吃水 10 厘米，船里的底板在水面以上 6 厘米
		caveEyeHeight: 1.4,           // 洞里眼睛离地面（米）：洞只有 2 米多高
		boatStopFromSource: 40,       // 船停在离源头（崖脚石缝）多远（米），林尽处
		handoffSpeed: 4,              // 在洞里交给花园时的速度（米/秒），花园接着这个速度走
		caveAdaptation: 3.2,          // 洞里眼睛适应暗处，曝光最多抬几倍（出洞时花园再落回 1）
		treeSpacing: 5.4,             // 桃树的网格间距（米，再随机抖动、按坡度和离溪远近稀疏）
		treeReach: 78,                // 离溪中线多远以内种（米）
		treeTemplates: 6,             // 几种树形
		// 桃树用的樱花模型（2026-10-02 换掉程序化桃树）：模型约 9 米高乘 blossomTreeSize（再乘每棵的随机）是 4~6 米的桃树；
		// 花簇聚团的格子（米，模型尺度）、每团最多几张花卡（按画质内容档）、三调（桃花的粉）
		blossomTreeSize: 0.5,
		blossomCell: 1.6,
		blossomCards: { hi: 12, mid: 8, lo: 8 },
		blossomColors: [ '#c96f8e', '#ee9fb8', '#fcd9e5' ],
		cardsPerCluster: 7,           // 每团花多少张花枝卡片（近处；远处的树少一些）
		// 草（三环见下面的 grassField）：叶长 [短, 长]（米，再乘成片长短 0.8~1.2、秃斑 0.9~1）、根部宽、密度倍数、地面的草色（校正调色板用）、
		// 枯草阈值（0~1，越大枯草越多，0 没有）、风向
		grass: { length: [ 0.28, 0.62 ], width: 0.035, density: 1, groundColor: '#6f8c4a', dry: 0.12, wind: [ 0.3, 0.95 ] },
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
		blossomTreeSize: 0.62,               // 花树用的樱花模型约 9 米高，乘这个（再乘每棵 0.85~1.25 的随机）：花园的花树 5~7 米
		blossomColors: [ '#d98aa5', '#f6c9d7', '#fff0f4' ],   // 花园花树的三调（白里透粉，比远处林子里的花树淡）
		cardsPerCluster: 7,
		// 草：正式花园里的草坪短（lawnLength 倍，约 0.13~0.3 米），gardenHalf 以外的草甸长（约 0.3~0.7 米）；草坪是这里的主角，密度 ×1.2（规格书 10.2）
		grass: { length: [ 0.36, 0.6 ], lawnLength: 0.45, width: 0.032, density: 1.2, groundColor: '#7f9c63', dry: 0.08, wind: [ 0.2, - 0.98 ] },
		petals: { count: { hi: 2400, mid: 1600, lo: 1000 }, box: 28 },
		// 倒影水池的平面倒影分辨率（hi、mid、lo 内容档）：规格书表里"低"是关，但这个场景的验收就是城堡完整清晰的倒影，
		// 所以 mid 档（用"低"那一列）也留着，降到 0.25 倍
		reflectionScale: { hi: 0.5, mid: 0.35, lo: 0.25 },
		// 晨雾：城堡（330 米外）盖两成左右，城堡和天空、雾分得开层次（规格书 10.3）；原来 0.0012，城堡脚下被一团白雾吃掉（审查 R22）
		fog: { density: 0.0008, falloff: 14, brightness: 1.0 },
		shafts: { amount: 0.35 },            // 光束强度
		walk: { minX: - 120, maxX: 120, maxZ: 50 },
	},

	// ===== 场景 3：哥特城堡（CLAUDE.md 第 11 节）=====
	gothic: {
		terrainRect: { minX: - 110, maxX: 110, minZ: - 60, maxZ: 90 },   // 机位周围自己画的湖岸（局部坐标）
		castleScale: 1.45,                   // 程序化兜底城堡的整体放大（模型没读到时用）
		modelScale: 1.9,                     // 零件包拼的城堡模型（84 米高）放大，连尖顶约 160 米（2026-10-02 用户："整体大一点"；远景的替身也按它放大）
		walk: { minX: - 100, maxX: 100, minZ: - 50, maxZ: 80 },
		// 窗灯：亮起时刻 = start + 楼层比例 × floorDelay + 房间组的随机延迟（0~groupSpread）+ 每扇的抖动（0~windowJitter）秒；
		// 亮度 HDR intensity[0]~[1]，2700K 暖黄；倒影光柱拖多长（米，按镜像点的距离算）
		// darkRooms：整晚不亮的房间比例（规格书 11.2：35%~45%）
		// 阶段 12 收尾：亮度 3~8 → 5~12、整晚不亮的房间 40% → 35%（审查 R13：默认距离只数得到十几格亮窗）
		windows: { start: 2, floorDelay: 14, groupSpread: 9, windowJitter: 1.5, intensity: [ 5, 12 ], color: '#ffb35c', columnLength: 26, darkRooms: 0.35 },
		reflectionScale: { hi: 0.5, mid: 0.35, lo: 0.25 },
		// 草：夜里的湖岸，近处内环稀一点（×0.75），月光下一根根的草尖不会密成一片噪点
		grass: { length: [ 0.25, 0.55 ], width: 0.035, density: 1, innerDensity: 0.75, groundColor: '#56683f', dry: 0.1, wind: [ 0.6, 0.8 ] },
		fireflies: { hi: 420, mid: 300, lo: 200 },
		// 夜雾：原来贴着湖面（衰减 9 米）一条灰带，把崖整个盖住、上沿是一道直线（2026-10-02 用户："仔细看会有缝"）。
		// 改成往上慢慢淡掉的月光薄霭：衰减 45 米，崖脚浓、崖顶淡；远山隔得远、霭更厚，比城堡亮一层，尖塔的剪影分得出来
		// 阶段 12 CP4：远山被雾和补光照成一片灰白、比岩台还亮，城堡和岩台从背景里分不出来，雾和补光都压一点
		fog: { density: 0.00045, falloff: 45, brightness: 0.62, moonScatter: 0.38 },
		// 石桥（2026-10-02 用户：在看城堡的那条视线上建一座桥，走过去近看）：从机位旁的湖岸跨湖到崖脚石阶小路的起点。
		// width 桥面宽（米）；deckHeight 桥面高出湖面；ramp 两头坡道长；landBack 起点从湖边往岸上退多少；quay 终点从石阶起点往湖里伸出多少（码头）；
		// sideOffset 桥头在机位左手边多远（不从脚下起，不挡湖和倒影）；arc 中段往左弯多少；span 一跨多长；pier 桥墩厚；archCrown 拱顶到桥面的厚度；parapet 胸墙高；lampEvery 每隔几个桥墩一对灯；
		// lampPost 灯杆高；lampColor、glassIntensity、haloIntensity 灯的颜色、玻璃和灯晕的 HDR 亮度；poolLength、poolIntensity 桥面光池的长度（米）和亮度；
		// speedScale 桥上的步速倍数（桥将近 500 米，停留只有 75 秒）
		bridge: { width: 4.6, deckHeight: 6.5, ramp: 40, landBack: 6, quay: 5, arc: 38, sideOffset: 34, span: 17, pier: 2.4, archCrown: 1.3, parapet: 1.0,
			lampEvery: 2, lampPost: 1.2, lampColor: '#ffb066', glassIntensity: 4, haloIntensity: 2.2, poolLength: 6, poolIntensity: 0.5, speedScale: 3.2 },
		nightFill: 1.3,                      // 月光补光倍数：背月的崖面、城堡不是死黑（原来城堡像悬在半空）
		lakeBounce: 0.32,                    // 湖面反到朝湖崖面上的月光（月光的倍数）：朝湖的面亮、侧面暗，石柱、冲沟看得出
		// 崖上点灯的石阶小路（从湖边的小码头一路折上去到城堡门口）：灯隔几米一盏、HDR 亮度、折几次、每折横着走多远（米）
		lanterns: { spacing: 7, intensity: 5, switchbacks: 7, sweep: 26, color: '#ffb066' },
	},

	// ===== 场景 4：星月夜（CLAUDE.md 第 9 节；阶段 12 CP3 返工重做：整幅画都是笔触）=====
	starry: {
		skyResolution: { hi: [ 2048, 920 ], lo: [ 1280, 576 ] },   // 天空底稿（天空坐标里按原画画的大色块，不做 LIC；几乎不变，30 帧重画一次）
		flowResolution: { hi: [ 1024, 448 ], lo: [ 768, 336 ] },   // 流场贴图（RG16F）；hi 每帧画，lo 隔帧画。没写 mid 的表 mid 按 lo 取
		groundGuideScale: { hi: 0.5, mid: 0.4, lo: 0.4 },          // 地面底稿（远景画进去给地面的笔取颜色）的边长是画布的几倍
		paintLevel: 0.7,                     // 颜料亮度（线性空间的倍数）：所有笔触、底稿的颜色都乘它
		// 画地面底稿时远景的补光：月光补光倍数；从镜头身后打过去的淡光（月光的倍数），朝着镜头的墙、坡看得清（原画村子的墙是亮的）
		guideLight: { nightFill: 2.6, bounce: 0.35 },
		walkRadius: 12,                      // 能走动的范围：出生点周围多少米（2026-10-02 用户要能走；再远地上的细笔淡掉、柏树不跟着近大远小）
		fov: 56,                             // 视场（度）：原画的构图整个在画面里、下面露出小镇（原来固定机位时还会推近到 47°、抬头看月亮 40°，现在能走了不推）
		// 流动速度。speed 是总倍率（所有速度都乘它，0.6~1.5 之间调手感）；phaseRate 卷流波形和 curl 噪声的变化（弧度/秒）；
		// curlAmplitude / curlDrift 是 curl 噪声的振幅和漂移（漂移 = 相位 × curlDrift）；
		// strokeSpeed：笔触沿流线走多快（弧度/秒）= clamp(|流速| × scale, min, max)，1080p 上约 10~55 像素/秒；particleSpeed 流光比笔触快几倍；
		// ringSpin 星环、月晕每圈的角速度（弧度/秒，隔圈正反转）
		flow: {
			speed: 1, phaseRate: 0.06, curlAmplitude: 0.06, curlDrift: 0.6,
			strokeSpeed: { scale: 0.035, min: 0.008, max: 0.045 }, particleSpeed: 1.6,
			ringSpin: [ 0.08, 0.18 ],
		},
		// 各层笔数（没写 mid 的按 lo 取）：天空底层（均匀铺满、不动）、中层流线（Floyd–Steinberg，主画面密）、高光细笔（卷流、亮带、光晕里）、
		// 流光（卷流和星晕里的小亮点）、地面（钉在地形上，均匀铺）、地面细笔（小镇、湖、城堡那一片密）、柏树、柏树的赭褐勾线；
		// 星环、星芯、月盘、月晕不在这里：按星的大小一圈圈排，两档一样（约 2500 笔）；窗灯按远景窗户表（约 300 笔）
		strokeLayers: {
			base: { hi: 11000, lo: 7000 },
			middle: { hi: 23000, lo: 12000 },
			highlight: { hi: 8000, lo: 4000 },
			particle: { hi: 3000, lo: 1500 },
			ground: { hi: 16000, lo: 10000 },
			groundDetail: { hi: 11000, lo: 7000 },
			cypress: { hi: 1400, lo: 1000 },
			cypressLine: { hi: 900, lo: 600 },
		},
		// 每层笔的样子（宽、长都是弧度，1080p 上 1 像素约 0.0008；原画的笔约 20~45 像素长、7~12 像素宽）：opacity 不透明度；
		// intensity HDR 亮度（颜料亮度的倍数）；trail 流光的拖影是点宽的几倍；window 窗灯的宽、长、亮度
		strokeShapes: {
			base: { width: [ 0.011, 0.016 ], length: [ 0.045, 0.08 ], opacity: [ 0.92, 1 ] },
			middle: { width: [ 0.005, 0.0085 ], length: [ 0.03, 0.06 ], opacity: [ 0.9, 1 ] },
			highlight: { width: [ 0.0035, 0.0055 ], length: [ 0.022, 0.04 ], opacity: [ 0.9, 1 ], intensity: [ 1.25, 1.9 ] },
			ring: { width: [ 0.005, 0.0068 ], length: [ 0.016, 0.032 ], opacity: [ 0.9, 1 ], intensity: [ 0.9, 1.6 ] },
			particle: { width: [ 0.0028, 0.004 ], trail: [ 2, 3.5 ], intensity: [ 2, 4 ] },
			ground: { width: [ 0.009, 0.014 ], length: [ 0.025, 0.045 ], opacity: [ 0.92, 1 ] },
			groundDetail: { width: [ 0.005, 0.008 ], length: [ 0.014, 0.026 ], opacity: [ 0.9, 1 ] },
			window: { width: 0.0065, length: 0.009, intensity: 4 },
			cypress: { width: [ 0.007, 0.011 ], length: [ 0.035, 0.07 ], opacity: [ 0.95, 1 ] },
			cypressLine: { width: [ 0.0028, 0.0042 ], length: [ 0.05, 0.1 ], opacity: [ 0.85, 1 ] },
		},
		strokeLife: [ 3.5, 6 ],                       // 流动的笔寿命（秒）：开头一成"画上去"、结尾一成"抹掉"
		meteor: { interval: [ 3, 7 ], burst: 0.35 },  // 流星间隔（秒）、连着来两三颗的概率（规格书 4~10 秒；用户要"几个星星流下来"看得见，缩短一点）
		cypressSway: 0.004,                           // 柏树尖左右摆的幅度（弧度）
		// 油画滤镜（只在 hi 档的原生链上起作用）：重做以后画面全是笔触，Kuwahara 只会把笔触的边抹糊，0 = 关（原来 1）
		kuwahara: 0,
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
		// 倍数 r = 每帧时间 / baselineMs：r ≤ hiFactor → hi，≤ midFactor → mid，否则 pano；第一帧超过 firstFrameLimitMs 直接 pano。
		// hi 里再按 r 定帧目标：r ≤ hi60Factor 按 60 帧（预算 dynamic.gpuBudgetMs.hi），其余按 30 帧（dynamic.target30）。
		// hiFactor 9：Iris Xe 一类核显（约 7.5 倍）也进 hi，靠 30 帧目标 + 放大撑住（2026-10-02 性能返工；原来 5，核显都判成 mid）。
		// baselineMs 是开发机（RTX 5060）上量到的值；没插电源时测出来的时间乘 batteryPenalty（判定更保守）
		benchmark: { width: 1280, height: 720, warmupFrames: 4, frames: 10, firstFrameLimitMs: 120, baselineMs: 2.7, hiFactor: 12, hi60Factor: 2.5, midFactor: 25, batteryPenalty: 1.35 },
		dynamic: {
			// 有显卡时间戳（WebGPU 大多有）：每帧显卡干活的时间超过这一档的预算才降，有余量就升回去。hi 是 60 帧目标的预算
			gpuBudgetMs: { hi: 14, mid: 22 },
			// hi 档 30 帧目标：显卡预算、场景比例下限、第一步从 1 直接降到 1 − firstStep、升比例要求预测低于预算的 raiseMargin 倍；
			// pixelBudget 是场景像素预算（1920×1200 ≈ 2.3 MP）：高分屏开局的场景比例 = √(pixelBudget / 画布像素)，夹在 [下限, 1]
			target30: { budgetMs: 27, minScale: 0.55, firstStep: 0.2, raiseMargin: 0.8, pixelBudget: 1920 * 1200 },
			raiseMargin: 0.85,     // 60 帧目标（和 mid）升比例要求预测低于预算的这么多倍，免得来回抖
			jumpRatio: 1.3,        // 显卡时间超过预算这么多倍：不一格一格降，一步跳到 比例 × √(jumpHeadroom × 预算 / 显卡时间)
			jumpHeadroom: 0.9,
			vertexBoundRatio: 0.4, // 降比例以后实测省下的显卡时间不到预测（按像素数）的这么多：判成顶点瓶颈，下一步先降顶点压力
			// hi → mid：比例到底、顶点压力到 0.6、连续 tierDropSeconds 秒低于 tierDropFps 帧，才在下一次起飞时降（不在地点中途硬切）
			tierDropFps: 24,
			tierDropSeconds: 5,
			// 没有显卡计时（WebGL2）：帧间隔超过 max(slowFrameMs, 刷新间隔 × 1.45, 目标帧时长 × intervalSlowRatio) 才算掉帧
			// （被垂直同步或浏览器限帧卡住不算；30 帧目标时 33 ms 的帧不算慢）
			slowFrameMs: 20,
			intervalSlowRatio: 1.2,
			// 30 帧目标升比例：最近 intervalRaiseFrames 帧的平均帧间隔 < 目标帧时长 × intervalRaiseRatio（60 帧目标还是"连续两倍 fastFrames 帧跟得上刷新"）
			intervalRaiseFrames: 240,
			intervalRaiseRatio: 0.75,
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
		// 花园晨雾的光束：径向模糊的采样次数（规格书 10.2 允许 32~64）。衰减和权重按原来 48 次的 decay 0.965、weight 0.9 换算，
		// 沿光线的衰减曲线和总亮度不变（pipeline.js 里算）
		lightShafts: { samples: 32 },
		// 实验开关：hi 档 30 帧目标（核显）时场景不开 MSAA，原生链只靠 FXAA。默认 false（开 4 倍 MSAA）。
		// 只能在开场卡判完档、预编译之前定（采样数是管线的一部分，中途改要全部重编）；?msaa=0 / ?msaa=4 强制
		msaaOffForSlowHi: false,
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
				// 俯仰、视场和实时档一样：抬头 10.9°、视场 56°（原画的构图整个在画面里，见 starry.js 文件头）
				views: [ { time: 0, yaw: 0, pitch: 10.9, fov: 56 }, { time: 52, yaw: 0, pitch: 10.9, fov: 47 }, { time: 70, yaw: 28, pitch: 26, fov: 40 } ],
				off: [], sparkleLayer: null,
			},
			aurora: {
				points: [ { position: 'spawn', time: 5 }, { position: [ - 4, - 200 ], time: 45, switchAt: 36 }, { position: [ 4, - 389 ], time: 85, switchAt: 66 } ],
				views: [ { time: 0, yaw: 180, pitch: - 10, fov: 50 }, { time: 10, yaw: 180, pitch: - 8, fov: 50 }, { time: 15, yaw: 270, pitch: - 1, fov: 50 }, { time: 20, yaw: 360, pitch: 5, fov: 50 }, { time: 60, yaw: 356, pitch: 6, fov: 46 }, { time: 76, yaw: 361, pitch: 14, fov: 44 }, { time: 90, yaw: 361, pitch: 28, fov: 38 } ],
				off: [ '闪光', '极光', '飘雪', '地吹雪' ], sparkleLayer: '闪光', overlays: [ 'aurora', 'snow', 'sparkles' ],
			},
		},
	},

	// ===== 引路（规格书 5.3，阶段 12）：一股花瓣和光点领着走 =====
	// 停留最后 gatherSeconds 秒花瓣在身边聚起（围着打旋），再朝下一段航线的方向飘；起飞时离镜头 keepDistance 米以内的不被薄雾吞掉；
	// 巡航时沿航线往前流（比镜头快 flightFlowSpeed 米/秒），近处 nearSpread 米宽、远处 farSpread 米宽；到达时收拢钻进窄处，穿出后散开淡出。
	// 白天是暖白的花瓣和光点，入夜花瓣收起来换萤火虫色的光点，雪原附近换蓝白的雪光
	guide: {
		petalCount: { hi: 2400, mid: 1400, lo: 1400 },
		moteCount: { hi: 1600, mid: 900, lo: 900 },
		petalColors: [ '#ffdfe8', '#f3a8c0' ],    // 比开场、花园飘落的花瓣粉一点：起飞时在白茫茫的薄雾里也看得出来
		petalSize: [ 0.05, 0.085 ],         // 花瓣长（米）
		dayMoteColor: '#fff0d2',
		nightMoteColor: '#d8ff7a',          // 萤火虫
		snowMoteColor: '#cfe2ff',           // 雪光
		moteIntensity: 7,                   // 光点 HDR 亮度
		moteSize: 0.03,                     // 光点直径（米）
		moteMinPixels: 2.2,                 // 远处至少画几个像素
		nearSpread: 2.5,
		farSpread: 10,
		keepDistance: 5,
		gatherSeconds: 8,
		gatherRadius: 3.2,
		stayFlowSpeed: 3,                   // 停留时朝出发方向飘的速度（米/秒）
		staySpacing: 2,                     // 停留时路径点间距（米）：40 个点约 80 米
		flightFlowSpeed: 22,
		flightSpacing: 8,                   // 飞行时路径点间距（米）：40 个点约 310 米
		behind: 12,                         // 路径从镜头身后几米开始（粒子从身后涌上来超过镜头，换位发生在看不见的身后）
		scatterSeconds: 2.5,                // 穿出窄处后散开淡出的秒数
		stormSeconds: 2.4,                  // "再走一遍"先起一阵花瓣风暴的秒数
		overtureFrom: 38,                   // 开场从第几秒起引路（林尽水源，花瓣顺着溪、领进山洞）
		gardenIntroUntil: 12,               // 花园出洞后几秒散开淡出
		snowAltitude: [ 430, 520 ],         // 镜头海拔在这个范围里从萤火虫换成雪光
	},

	// ===== 草（阶段 12 CP3 返工，src/tsl/grass.js，规格书 10.2；参考 reference/notes/grass-target.webp）=====
	// 三环：近内环 size 米见方、每平方米 density 根（7 顶点）；近外环（5 顶点）和内环交叉淡化；远环 count 根、从 inner 米到 outer 米，
	// 半透明、越远越稀越长。mid 档用 lo 这一列（核显）。各地点的密度倍数在各自的 grass 里
	grassField: {
		rings: {
			hi: { inner: { size: 18, density: 300 }, outer: { size: 52, density: 85 }, far: { count: 240000, inner: 22, outer: 120 } },
			lo: { inner: { size: 14, density: 110 }, outer: { size: 36, density: 30 }, far: { count: 60000, inner: 12, outer: 70 } },
		},
		// 调色板（文档 5.9）：根、中段、叶尖、枯；再按各地点地面的草色校正（近环 0.7、远环 0.3）
		palette: { root: '#16220f', mid: '#3c6b20', tip: '#6c9c38', dry: '#958d5f' },
	},

	// ===== 地面贴图（规格书阶段 12 CP3，src/tsl/terrain.js）=====
	// 四层（顺序固定：草甸、林地、岩石、沙土）：texture 是 assets/opt/textures 里的名字，meters 一张贴图铺多少米，normalStrength 法线强度。
	// 颜色还是各场景按调色板算的，贴图只给明暗（contrast：亮度比的次方，小于 1 更平、更像绘本）和一点色相（colorAmount）；
	// near：多远以内采样；hexContrast：六角平铺三个格点混合的锐度（越大越不糊，太大会看出格子）
	ground: {
		textureSize: 1024,
		layers: [
			{ texture: 'rocky_terrain_02', meters: 6, normalStrength: 0.8 },    // 草甸：带碎石的草地
			{ texture: 'forrest_ground_01', meters: 4, normalStrength: 0.7 },   // 林地：落叶、枯枝
			{ texture: 'aerial_grass_rock', meters: 9, normalStrength: 1.0 },   // 岩石：长苔的岩面
			{ texture: 'coast_sand_01', meters: 5, normalStrength: 0.6 },       // 沙土：沙滩、土路、干坡
		],
		near: { hi: 160, mid: 90, lo: 90 },
		hexContrast: 4,
		contrast: 0.85,
		colorAmount: 0.25,
	},

	// ===== 树（规格书阶段 12 CP3，src/tsl/trees.js）=====
	// near：多远以内画 3D 树（再往外是远景的树团）；band：交接带宽（每棵树在 near − band ~ near 之间随机定，不是一刀切）；
	// refreshDistance：镜头挪多远重挑一次近处的树；maxPerMesh：每个树种变体最多画几棵；variants：每个树种几个变体；
	// firAltitude：针叶树在这个海拔以上是冷杉、以下是松。
	// 树种：form 树形（round 圆冠、tiered 分层的松、conical 冷杉、column 柏）；height 高（米，size = 1 时）；trunkReach 树干长到全高的几成；
	// branches 主枝（或层、圈）数；branchStart 从树干几成高开始分枝；branchLength 枝长；branchUp 枝往上翘的角度（弧度）；branchBend 枝往上弯；
	// clumpRadius 树冠团半径；clumpSquash 团上下压扁；cards 每团叶片卡数（最大的团）；cardScale 卡边长 / 团半径；colors 暗、中、亮三调；bark 树皮色
	trees: {
		// 3D 树画到多远（米），再往外是替身卡片。核显档（mid 画质用 lo 这一列）收到 130 米：林子加密以后飞过老林时 3D 树太多（RTX 5060 上 mid 1.05 → 2.75 ms）
		near: { hi: 420, mid: 200, lo: 130 },
		band: 60,
		refreshDistance: 12,
		maxPerMesh: 4096,
		variants: 3,
		firAltitude: 330,
		coniferAltitude: [ 120, 300 ],   // 针叶从这个海拔开始多起来、到这个海拔几乎全是针叶（米）
		meadowChance: 0.025,             // 草甸上（不成林的地方）每个候选格种一棵孤树的概率
		// 各地点脚下不种树的地方（米）：数字是整圈的半径；{ around, ahead, halfAngle } 是脚下一圈 + 朝向的扇形（身后留林，规格书 5.3）。
		// 花园另外让开正式园林那一条（backdrop.treeClearings）
		clearRadius: { overture: 150, garden: 40, sunset: 70, gothic: { around: 22, ahead: 220, halfAngle: 75 }, starry: { around: 45, ahead: 200, halfAngle: 80 }, aurora: 150 },
		species: {
			// 阔叶（阶段 12 CP3 返工）：分级树冠（trees.js buildCrown），原来的 round 形远看是棒棒糖
			broadleaf: { form: 'crown', height: [ 10, 13 ], trunkReach: 0.38, trunkRadius: 0.34, lean: 0.1, trunkLean: 0.06, flare: 1.5, primaries: [ 4, 6 ], primaryUp: [ 0.45, 0.95 ], primaryLength: [ 0.3, 0.42 ], primaryBend: 0.2,
				secondaries: [ 2, 4 ], secondaryLength: [ 0.4, 0.62 ], secondarySpread: 0.75, droop: 0.05, twigs: [ 0, 1 ], clumpRadius: [ 1.9, 2.6 ], clumpSquash: 0.8, cards: 32, cardScale: 0.62,
				colors: [ '#253f20', '#466b30', '#86a84e' ], bark: '#4f4036' },
			pine: { form: 'tiered', height: [ 13, 17 ], trunkReach: 0.95, trunkRadius: 0.3, lean: 0.18, branches: [ 6, 8 ], branchStart: 0.38, branchLength: [ 2.4, 3.8 ], branchUp: [ - 0.05, 0.25 ], branchBend: 0.08, clumpRadius: [ 1.8, 2.6 ], clumpSquash: 0.45, cards: 36, cardScale: 0.7, colors: [ '#1b3426', '#355437', '#69874c' ], bark: '#5a4636' },
			fir: { form: 'conical', height: [ 13, 17 ], trunkReach: 1.0, trunkRadius: 0.28, lean: 0.06, branches: [ 9, 12 ], branchStart: 0.12, branchLength: [ 2.6, 3.2 ], branchUp: [ 0, 0 ], branchBend: 0, clumpRadius: [ 0.5, 0.7 ], clumpSquash: 0.6, cards: 22, cardScale: 0.8, colors: [ '#172e24', '#2e4c39', '#587552' ], bark: '#3f3530' },
			peach: { form: 'round', height: [ 5, 6.5 ], trunkReach: 0.5, trunkRadius: 0.22, lean: 0.25, branches: [ 5, 7 ], branchStart: 0.3, branchLength: [ 2, 3 ], branchUp: [ 0.2, 0.6 ], branchBend: 0.3, clumpRadius: [ 1.4, 2.0 ], clumpSquash: 0.75, cards: 40, cardScale: 0.62, colors: [ '#c96f8e', '#ee9fb8', '#fcd9e5' ], bark: '#4a3833' },
			// 花树（桃樱，阶段 12 CP3 返工，规格书 §12.1 的 6 种树形）：一个树种、一套材质，forms 里每种树形是一个变体。
			// 卡片画成五瓣花簇（cardStyle: 'blossom'）；颜色在樱的淡粉和桃的粉之间，每棵按色相随机数再偏白或偏粉
			blossom: {
				cardStyle: 'blossom', colors: [ '#d7869f', '#f3b9cb', '#fde4ec' ], bark: '#3b2c29', cards: 30, cardScale: 0.55,
				// 2026-10-02 用户："这种树全部换掉"（程序化的枝干又直又硬、花一点一点散着）：整个树种改用樱花模型的树干（RosticOstafi 两棵，
				// sakura-forest-* 是树干减到约 2800 三角的那一份）+ 程序化花簇（聚团格子 cell 米、每团最多 cards 张花卡）；
				// near 是画 3D 的距离比例（近处的树的 near 乘它；花园四周几百米内一千多棵，全画 3D 太重，再远是替身卡片）。
				// 下面的 forms 只在模型读不到时当兜底，变体数（6）也照它
				models: { ids: [ 'sakura-forest-a', 'sakura-forest-b' ], cell: 1.25, cards: 16, near: 0.4 },
				forms: [
					// 开心形：矮干、主枝斜得开、树冠宽
					{ form: 'crown', style: '开心形', height: [ 6, 7.5 ], trunkReach: 0.3, trunkRadius: 0.3, trunkLean: 0.08, flare: 1.5, primaries: [ 4, 5 ], primaryUp: [ 0.35, 0.7 ], primaryLength: [ 0.42, 0.55 ], primaryBend: 0.15,
						secondaries: [ 3, 4 ], secondaryLength: [ 0.45, 0.65 ], secondarySpread: 0.7, droop: 0.08, twigs: [ 1, 2 ], clumpRadius: [ 1.0, 1.5 ], clumpSquash: 0.72 },
					// 垂枝：干高一些，侧枝往下垂，团挂在枝梢下面
					{ form: 'crown', style: '垂枝', height: [ 7.5, 9 ], trunkReach: 0.62, trunkRadius: 0.3, trunkLean: 0.05, flare: 1.4, primaries: [ 6, 7 ], primaryUp: [ 0.75, 1.1 ], primaryLength: [ 0.3, 0.38 ], primaryBend: - 1.2,
						secondaries: [ 3, 4 ], secondaryLength: [ 1.1, 1.5 ], secondarySpread: 0.45, droop: 2.4, twigs: [ 0, 1 ], clumpRadius: [ 0.75, 1.0 ], clumpSquash: 0.9, hang: 0.35, clumpsAlong: 6, cards: 16, branchThinning: 0.6 },
					// 伞形：主枝几乎水平、团压扁，顶是平的
					{ form: 'crown', style: '伞形', height: [ 5, 6.5 ], trunkReach: 0.42, trunkRadius: 0.26, trunkLean: 0.05, flare: 1.4, primaries: [ 5, 6 ], primaryUp: [ 0.08, 0.3 ], primaryLength: [ 0.45, 0.6 ], primaryBend: 0.05,
						secondaries: [ 2, 4 ], secondaryLength: [ 0.4, 0.6 ], secondarySpread: 0.65, droop: 0.15, twigs: [ 1, 2 ], clumpRadius: [ 1.0, 1.4 ], clumpSquash: 0.5, topClump: false },
					// 斜干：树干歪 15~25°，树冠偏到一边
					{ form: 'crown', style: '斜干', height: [ 5.5, 7 ], trunkReach: 0.45, trunkRadius: 0.26, trunkLean: 0.36, flare: 1.6, primaries: [ 3, 5 ], primaryUp: [ 0.3, 0.8 ], primaryLength: [ 0.36, 0.5 ], primaryBend: 0.1,
						secondaries: [ 2, 4 ], secondaryLength: [ 0.45, 0.65 ], secondarySpread: 0.7, droop: 0.1, twigs: [ 1, 2 ], clumpRadius: [ 0.95, 1.4 ], clumpSquash: 0.72 },
					// 双干：从根上分成两根往两边歪的干
					{ form: 'crown', style: '双干', trunks: 2, height: [ 6.5, 8 ], trunkReach: 0.42, trunkRadius: 0.32, trunkLean: 0.05, flare: 1.5, primaries: [ 5, 6 ], primaryUp: [ 0.4, 0.85 ], primaryLength: [ 0.3, 0.42 ], primaryBend: 0.15,
						secondaries: [ 2, 4 ], secondaryLength: [ 0.45, 0.65 ], secondarySpread: 0.7, droop: 0.08, twigs: [ 1, 2 ], clumpRadius: [ 0.95, 1.4 ], clumpSquash: 0.72 },
					// 老桩：干粗、枝少、团稀，枝干露得多
					{ form: 'crown', style: '老桩', height: [ 5, 6.5 ], trunkReach: 0.36, trunkRadius: 0.48, trunkLean: 0.14, flare: 1.8, primaries: [ 3, 4 ], primaryUp: [ 0.25, 0.75 ], primaryLength: [ 0.4, 0.55 ], primaryBend: 0.05,
						secondaries: [ 2, 3 ], secondaryLength: [ 0.5, 0.7 ], secondarySpread: 0.8, droop: 0.12, twigs: [ 1, 2 ], clumpRadius: [ 0.75, 1.1 ], clumpSquash: 0.7, topClump: false, cards: 18 },
				],
			},
		},
		// 焦点樱花树（RosticOstafi 的两棵，CC BY；只用树干，花是程序化花卡，聚团按原模型叶片卡的位置）：
		// models 两个模型；places 种在哪（地点本地坐标 x、z，model 第几个模型，yaw 朝向度，size 缩放）；花卡的样子用花树（blossom）那一套，cell 花位聚团的格子（米）
		focal: {
			models: [ 'sakura-focal-a', 'sakura-focal-b' ], cell: 1.15,
			places: [
				// 花园出生点前面左右两棵，框住看城堡的那一眼（池子两边的柏树、花圃外面的草地上）
				{ location: 'garden', x: - 30, z: - 46, model: 1, yaw: 30, size: 1.0 },
				{ location: 'garden', x: 34, z: - 58, model: 0, yaw: 200, size: 1.05 },
				// 出洞那段坡上一棵（出洞第一眼看到的花树）
				{ location: 'garden', x: 120, z: 128, model: 0, yaw: 80, size: 1.1 },
			],
		},
		// 林下（Quaternius Stylized Nature MegaKit，CC0）：near 多远以内撒；kinds 每种的模型、调色（贴图只取明暗）、
		// keepHue 保留原贴图色相的程度（花要留）、upright 法线往上掰的程度；rules 每个树种树根周围撒什么：
		// count 平均几丛、radius 离树根多远（米，乘树的大小）、scale 大小
		understory: {
			near: { hi: 160, mid: 90, lo: 80 },
			kinds: {
				灌木: { model: 'bush_common', tint: '#46703a', keepHue: 0, upright: 0.5 },     // 原贴图是秋天的橙叶，色相全换掉
				花灌木: { model: 'bush_common_flowers', tint: '#4f7a3a', keepHue: 0.6, upright: 0.5 },
				蕨: { model: 'fern_1', tint: '#3f6e35', keepHue: 0.15, upright: 0.4 },
				花丛: { model: 'flower_3_group', tint: '#5d8a3f', keepHue: 0.75, upright: 0.5 },
				草丛: { model: 'grass_wispy_tall', tint: '#5a7e3e', keepHue: 0.1, upright: 0.7 },
			},
			rules: {
				broadleaf: [ { kind: '灌木', count: 1.2, radius: [ 2, 6 ], scale: [ 0.9, 1.6 ] }, { kind: '蕨', count: 1.5, radius: [ 1, 5 ], scale: [ 0.8, 1.3 ] }, { kind: '草丛', count: 1.5, radius: [ 3, 8 ], scale: [ 0.8, 1.2 ] } ],
				pine: [ { kind: '蕨', count: 1.5, radius: [ 1, 5 ], scale: [ 0.8, 1.2 ] }, { kind: '草丛', count: 1, radius: [ 3, 8 ], scale: [ 0.7, 1 ] } ],
				fir: [ { kind: '灌木', count: 0.6, radius: [ 2, 5 ], scale: [ 0.7, 1.1 ] } ],
				peach: [ { kind: '花丛', count: 1.5, radius: [ 1.5, 5 ], scale: [ 0.7, 1.1 ] }, { kind: '花灌木', count: 0.6, radius: [ 2, 5 ], scale: [ 0.8, 1.2 ] }, { kind: '草丛', count: 1.5, radius: [ 2, 6 ], scale: [ 0.7, 1 ] } ],
				blossom: [ { kind: '花丛', count: 2, radius: [ 1.5, 6 ], scale: [ 0.8, 1.2 ] }, { kind: '花灌木', count: 0.8, radius: [ 2, 6 ], scale: [ 0.8, 1.3 ] }, { kind: '草丛', count: 1, radius: [ 2, 6 ], scale: [ 0.7, 1 ] } ],
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
			// 阶段 12：城堡挪到崖沿（离朝湖的崖边约 30 米），崖顶 145 米（原来 (520, 95, −225)，退在崖边 30 多米后面、崖只高出湖面 40 米）
			gothic: { name: '哥特城堡', origin: [ - 37, 57, - 44 ], yaw: 72, contentRadius: 700, landmark: [ 524, 145, - 226.5 ], time: [ 20.75, 21.5 ] },
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
			nightExposureBoost: 0.6,      // 天黑透了再多抬几成（落日 → 哥特原来约 20 秒近乎黑屏）
			nightFill: 2.2,               // 夜里飞行时远景的月光补光倍数
			nightAmbient: 4,              // 夜里飞行时远景天光环境项的倍数（月亮还没升高时地面只有天光）
			canvasSeconds: 3.5,           // 进星月夜画布从四周蔓延、离开时退去的秒数
			// 同色薄雾交接：出发时 A 化进雾里（in）、停一下（hold，在正中间切到只画远景）、雾散开（out）；到达时反过来
			veil: { departIn: 2.2, departHold: 0.3, departOut: 2.5, arriveIn: 2.2, arriveHold: 0.3, arriveOut: 2.5, clearBeforeEnd: 0.8, near: 5, far: 400 },
			// 先窄后豁然开朗的默认参数（每段的 frame 里可以单独改）：
			//   speed 穿过窄处的速度（米/秒）；slowLead 离入口多远就要减到这个速度；slowTime 从巡航减到它用几秒；
			//   approachRelax 入口前多远开始不强制巡航离地高度；adaptation 窄处里眼睛适应抬高曝光的倍数（白天 / 夜里）；
			//   adaptationRise 进窄处后几秒抬到顶；adaptationFall 出口过曝以后几秒落回来；contentIn 换场景以后地点内容从雾里显出来的秒数；
			//   dragYawMax / dragPitchMax 到达前最后 dragLimitSeconds 秒拖动转头的限制（度）
			frameDefaults: { speed: 16, slowLead: 70, slowTime: 3.5, approachRelax: 420, adaptation: [ 2.2, 1.7 ], adaptationRise: 1.6, adaptationFall: 1.4, contentIn: 1.2, skyIn: 2.6, dragYawMax: 10, dragPitchMax: 8, dragLimitSeconds: 6 },
		},
		// 四段航线：只写巡航和进场的航点（世界坐标，y 是海拔），起点（她当时站的地方）和终点（下一个地点的出生点）由程序补上。
		// duration 秒；departTurnDirection / arriveTurnDirection：起飞、降落转身往哪边转（shortest / clockwise / counterclockwise）
		// frame：先窄后豁然开朗（规格书 5.3，阶段 12）的窄处。path 是窄处的中线（顺着飞行方向，世界坐标，y 是镜头的海拔），
		//   航线接在 waypoints 后面穿过它；kind：cleft 岩丘裂隙、trail 林间小路、moraine 冰碛岗鞍部、trough 融水冰槽（都是地形和林子里本来就有的，narrows.js 只摆路面、乱石、冰凌这些）、
		//   width 中间留出的宽（米）；switchAt 在窄处的哪里换场景（0 入口 ~ 1 出口）；
		//   其余是各种窄处自己的形状参数。窄处对不上（太靠终点、航线不经过）时中文警告，这一段退回原来的薄雾到达
		legs: [
			{ from: 'garden', to: 'sunset', duration: 30, arriveTurn: 4,
				waypoints: [ [ - 650, 125, 1275 ], [ - 860, 120, 960 ], [ - 920, 105, 640 ], [ - 860, 65, 400 ], [ - 830, 42, 270 ], [ - 960, 22, 202 ] ],
				// 落日出生点身后那座海边岩丘被溪水切开的口子（地形 terrainShape.knolls / notches，本地 z 190 → 110），出口正对太阳：
				// 口子里背光是暗的，出口过曝；顺着一条小溪进去（溪从口子东边 40 米的泉眼冒出来，穿过口子、草甸和沙丘的口子流进海里）。
				// 远景网格画不出口子的陡壁，沿中线铺一块细的地形补丁（patch：半宽、沿中线往前 / 往后多铺几米、各档一格多大、边上接回远景的宽度、
				// 和远景重叠的宽度，见 backdrop.js 的 buildTerrainPatch）。出了口子按 glide 的几个点（世界坐标，y 是镜头海拔）滑到出生点
				frame: { kind: 'cleft', name: '岩丘裂隙', path: [ [ - 1062.9, 11.8, 183 ], [ - 1102.3, 9.3, 176 ], [ - 1141.7, 9, 169.1 ] ], width: 10, floorBelow: 3.8, switchAt: 0.55, speed: 18, slowLead: 50, slowTime: 3,
					glide: [ [ - 1165.4, 6.8, 165.4 ], [ - 1195.1, 6.0, 161.2 ] ],
					patch: { halfWidth: 66, extend: [ 30, 16 ], spacing: { hi: 0.6, mid: 0.9, lo: 1.2 }, blend: 10, overlap: 1.5 },
					// 壁脚的落石：壁脚离中线 wallFoot 米（和 notches 的 halfBottom 一样），沿壁每 rockSpacing 米上下一块，小的、大的缩放 rockScale（模型约 2.5 米宽）；
					// 溪边的卵石几块；小溪从 creekFrom 到 creekTo（沿中线的米数，可以是负的；结尾接落日自己的那段溪）、半宽
					wallFoot: 5, rockSpacing: 5, rockScale: [ 0.8, 1.6 ], creekStones: 18, creekFrom: - 40, creekTo: 86, creekHalfWidth: 1.1,
					// 两壁的岩石扫描（模型 10.5 米高）：缩放夹在 wallScale 之间、往地下埋 wallBury 米、正面在壁脚往外 wallInset 米
					wallScale: [ 0.5, 1.9 ], wallBury: 1.5, wallInset: 0.5,
					// 岩丘四周按地形找位置（见 narrows.js）：撒 candidates 个点，崖脚落石最多 footClusters 簇；
					// 比口子底高 crestHeight 米以上的平缓处种松（最多 pines 棵），丘脚平地上再种 footPines 棵，彼此隔 pineSpacing 米，被海风吹得往东歪；
					// 坡上 shrubs 丛矮灌丛（矮阔叶树），彼此隔 shrubSpacing 米
					knollScatter: { candidates: 3600, footClusters: 26, pines: 26, footPines: 10, crestHeight: 11, pineSpacing: 7, outcrops: 34, shrubs: 70, shrubSpacing: 4.5 },
					extend: [ 40, 10 ] } },
			{ from: 'sunset', to: 'gothic', duration: 30, decelTime: 4.5, departTurnDirection: 'clockwise', arriveTurn: 3,
				waypoints: [ [ - 950, 115, 100 ], [ - 640, 105, 80 ], [ - 480, 80, 70 ], [ - 365, 64, 52 ] ],
				// 西岸老林里一条弯弯的林间小路（阶段 12 CP3 返工：原来是两排电线杆一样的树干顶一块树冠"天花板"，用户说刻意）。
				// 林子是树林布点（src/core/forest.js）本来就种在那里的，小路两边 boostRadius 米里加密成老林、树冠往路上倾；
				// 路面是一条踩出来的土路（地上一条带，边上毛的），路边有苔石、蕨。镜头离路面约 3 米，沿路拐两个弯，穿出去是湖、崖上的城堡和窗灯
				frame: { kind: 'trail', name: '西岸林间小路', path: [ [ - 292, 56.8, 40 ], [ - 255, 56.2, 20 ], [ - 214, 55.9, 14 ], [ - 172, 56.0, - 6 ], [ - 130, 56.4, - 9 ], [ - 92, 57.3, - 27 ] ],
					width: 5, switchAt: 0.62, speed: 15, slowLead: 60, slowTime: 3.5, extend: 10,
					// 路面半宽、路边空出来不种树的半宽、两边老林加密的半径、路边歪向路的树（离中线多远、每隔几米一棵、歪几度）
					trailHalfWidth: 1.3, clearHalfWidth: 3.2, boostRadius: 38,
					edgeTrees: { offset: [ 4.2, 7.5 ], spacing: [ 6, 9 ], lean: [ 7, 15 ], size: [ 0.95, 1.3 ] },
					edgeRocks: 22,
					// 路边的灯（弯头木杆挂铁框玻璃灯）：每隔几米一盏（两边交替）、杆高、横臂长、灯身宽和高（米）、颜色、
					// 玻璃的 HDR 亮度、灯晕亮度、地上光池的半径（米）和亮度
					lanterns: { spacing: 11, height: 1.9, arm: 0.42, lamp: [ 0.17, 0.24 ], color: '#ffb066', glassIntensity: 4, haloIntensity: 2.2, poolRadius: 4.5, poolIntensity: 0.42 } } },
			// 沿小镇溪谷上来、过了小镇绕到出生点身后，从冰碛岗的鞍部翻过来（规格书 5.2：约 28~30 秒）；画布在鞍部里开始蔓延。
			// 岗是地形里的（terrainShape.moraines），岗上的松是树林布点种的（鞍部两边 boostRadius 米里加密、全是松），坡上的乱石在 narrows.js 摆
			{ from: 'gothic', to: 'starry', duration: 32, arriveTurnDirection: 'clockwise', arriveTurn: 4,
				waypoints: [ [ 120, 140, - 400 ], [ 215, 190, - 800 ], [ 235, 250, - 1150 ], [ 205, 258, - 1420 ], [ 125, 242, - 1470 ] ],
				frame: { kind: 'moraine', name: '冰碛岗鞍部', path: [ [ 93.7, 212, - 1405.3 ], [ 109, 217, - 1363 ], [ 119.2, 208, - 1334.8 ] ], width: 26, switchAt: 0.6, speed: 22, slowLead: 50, slowTime: 3,
					boostRadius: 70, clearHalfWidth: 9, boulders: 90 } },
			// 先在冰瀑前面的空中爬升，从冰瀑的水雾里钻进崖沿上融水冲出来的冰槽（terrainShape.notches 里 ice 的那条），
			// 顺着槽底往上翻上台地：先朝北看见台地和极光，再往左转身朝南（阶段 12 CP3 返工：原来是两串蓝色的冰岩团夹出来的"冰缝"，像葡萄）
			{ from: 'starry', to: 'aurora', duration: 24, decelTime: 5, rampEndDistance: 450, arriveTurnDirection: 'counterclockwise', arriveTurn: 5, lookPitchLimit: 20, lookPitchBias: 0,
				waypoints: [ [ 150, 300, - 1420 ], [ 152, 420, - 1560 ], [ 158, 515, - 1640 ], [ 165, 547, - 1700 ] ],
				// 冰槽在冰瀑东边 15 米（再往西会挡住雪原出生点朝南看的视线）；槽壁是冰（远景和雪原的地形在槽里都画成冰），槽沿挂冰凌、堆雪檐，槽底一道冻住一半的融水
				frame: { kind: 'trough', name: '融水冰槽', path: [ [ 165, 547.5, - 1732 ], [ 165, 546.5, - 1756 ], [ 164, 552, - 1776 ], [ 161, 558, - 1796 ], [ 158, 564.5, - 1814 ] ], width: 8, switchAt: 0.5, speed: 15,
					patch: { halfWidth: 34, extend: [ 22, 12 ], spacing: { hi: 0.7, mid: 1.0, lo: 1.4 }, blend: 8, overlap: 1.5 },
					icicles: 140, icicleLength: [ 0.6, 2.8 ], cornice: 0, iceBlocks: 14, creekHalfWidth: 0.9, extend: 8 } },
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
		// 阶段 12 地形形状（烘焙前的解析形状；改了这里要重跑 node scripts/bake-terrain.mjs，见 assets/opt/terrain/manifest.json 里的哈希）
		terrainShape: {
			riverCrease: 18,       // 河谷坡和原来山坡的交线做多大的圆角（米，平滑取小）；原来是硬折痕
			// 地点脚下的压平：按地点朝向的圆角矩形（本地坐标，盖住地点自己的地形块再多 margin 米），外面 falloff 米里缓缓回到原地形
			// （原来是 260 米的圆盘、里面一半完全平，花园四周"平地突然接 50° 的墙"）
			locationPlates: {
				garden: { rect: { minX: - 150, maxX: 150, minZ: - 400, maxZ: 60 }, margin: 20, corner: 70, falloff: 320 },
			},
			// 南岭北麓（花园南边）先是一级缓缓的山脚台地（升到岭高的 terraceHeight 倍，带小丘），再接主坡
			southFoothills: { start: 1330, terraceEnd: 1560, terraceHeight: 0.25, mainStart: 1540, mainEnd: 1770 },
			// 两条伸进海里的长条岬角（原来是两个高斯鼓包，其中一个被河岸削成圆锥）：脊线从陆上 from 到海里 to（世界 x, z），半宽、最高（米）
			headlands: [
				{ from: [ - 1060, - 690 ], to: [ - 1480, - 730 ], width: 240, height: 255 },
				{ from: [ - 1040, 980 ], to: [ - 1450, 930 ], width: 220, height: 230 },
			],
			// 东岭往东 3.3 千米以后、外圈山往南 4 千米以后不再无限延伸，交给外圈的层叠远山
			eastRidgeEnd: [ 2600, 3300 ],
			outerSouthEnd: [ 3300, 4100 ],
			// 外圈层叠远山：离盆地中心的距离、宽、脊高（米）；azimuthScale 是方位角（从盆地中心量，度）→ 高度比例：
			// 花园日出、哥特月出的东边（约 60~100°）压低，西边是海（0），北边压低（雪原上的极光和落月要露出来）
			outerRanges: {
				center: [ 100, 200 ],
				ranges: [ { distance: 3600, width: 650, height: 540 }, { distance: 6200, width: 950, height: 880 }, { distance: 9300, width: 1350, height: 1280 } ],
				azimuthScale: [ [ 0, 0.2 ], [ 25, 0.35 ], [ 45, 0.85 ], [ 60, 0.3 ], [ 100, 0.3 ], [ 120, 0.9 ], [ 160, 1 ], [ 225, 1 ], [ 250, 0.25 ], [ 262, 0 ], [ 318, 0 ], [ 335, 0.2 ], [ 360, 0.2 ] ],
			},
			// 哥特城堡的崖：湖东岸一块平顶的岩台，崖顶高出湖面约 90 米（湖 55 米 → 崖顶 145 米），朝湖那面被湖岸切成陡崖；
			// 中心、平顶半径、往外落下去的宽度（米），边缘按噪声进退，不是正圆
			// shelf：岩台两侧落下去时中间一层平台的高度（台高的比例，0 = 不要平台），平台上长松（阶段 12 CP4：原来一整面崖像桌子）
			gothicMesa: { center: [ 552, - 236 ], radius: 108, falloff: 90, top: 145, edgeWander: 18, shelf: 0.58 },
			// 不在窄处的地形补丁（远景网格 8 米一格画不出的细地形，见 backdrop.js 的 buildTerrainPatch）：
			// from → to 是补丁的长轴（世界 x, z），半宽、各档一格多大、边上接回远景的宽度、和远景重叠的宽度。
			// 哥特岩台朝湖（朝机位）那一面崖：竖的石肋、岩层台阶、崖脚碎石坡要 1.5 米一格才画得出来
			patches: [
				{ name: '哥特岩台朝湖的崖', from: [ 399.3, - 364.7 ], to: [ 504.7, - 41.3 ], halfWidth: 78, spacing: { hi: 1.5, mid: 2.5, lo: 3.5 }, blend: 14, overlap: 2 },
			],
			// 小丘（阶段 12 窄处原来在星月夜身后放了两座圆锥小丘当"山坳"，用户说像摆上去的；换成下面的冰碛岗，这里空着）
			hills: [],
			// 冰碛岗：冰川退下去留在前面的一道弧形土石岗，凸向下游（南）；朝冰川那面（北，proximalSide 1）陡、背面缓。
			// 星月夜出生点身后 110 米；鞍部在岗中间偏东，哥特 → 星月夜到达前从鞍部翻过来（离鞍底约 7 米）。东头在小镇溪西边收住，不挡溪
			moraines: [
				{ points: [ [ - 70, - 1440 ], [ - 10, - 1388 ], [ 55, - 1362 ], [ 109, - 1356 ], [ 165, - 1366 ], [ 205, - 1398 ] ], width: 42, height: 30, proximalSide: 1,
					saddle: { point: [ 109, - 1360 ], width: 20, depth: 0.72 } },
			],
			// 落日身后的海边岩丘（阶段 12 CP3 返工：原来是平草地上立着两块巨岩，用户说"为了刻意而弄出来的"）：
			// 脊线从 from 到 to（世界 x, z），半宽、最高（米）。两头落在落日出生点方位 83°、124° 附近，不挡 78° 的哥特城堡和 135° 的花园城堡；
			// 西脚落在落日自己的地形块外面（本地 z ≥ 121），岩丘整个在远景里
			knolls: [
				{ from: [ - 1083.7, 133.9 ], to: [ - 1102.7, 242.3 ], width: 40, height: 20, shoulder: 0.42, tails: [ 110, 22 ], terrace: 0.32, rise: [ 0.68, 1.05 ] },
			],
			// 岩丘被溪水切开的口子（花园 → 落日到达前从口子里穿出来，出口正对太阳）：points 是口子底的中线（世界 x、底的海拔、z），
			// 往海那边一路低下去；底宽 2 × halfBottom 米，壁 wallSlope 米 / 米，壁按噪声进退 wallWander 米，每 ledgeStep 米一级岩坎；溪槽深、半宽
			notches: [
				{ points: [ [ - 1023, 9.6, 190 ], [ - 1062.9, 8.0, 183 ], [ - 1102.3, 5.5, 176 ], [ - 1141.7, 5.2, 169.1 ] ], halfBottom: 5, wallSlope: 2.2, wallWander: 3, ledgeStep: 2.6, creekDepth: 0.35, creekHalfWidth: 2 },
				// 冰瀑上口的融水冰槽（星月夜 → 雪原的窄处）：从台地上一道浅沟开始，往南越切越深，到崖沿深约 9 米，冲出崖沿就是冰瀑。
				// ice：槽壁画成冰（远景地形、雪原自己的地形都认它）；壁陡、按噪声进退，不分岩坎
				{ ice: true, points: [ [ 165, 541, - 1744 ], [ 165, 543, - 1756 ], [ 164, 548, - 1776 ], [ 161, 554, - 1796 ], [ 158, 560.5, - 1814 ] ], halfBottom: 3.5, wallSlope: 3.2, wallWander: 2, creekDepth: 0.3, creekHalfWidth: 1 },
			],
			// 烘焙时不许动的地方（地点自己的地形块，本地坐标；再往外 margin 米慢慢放开）
			protect: [
				{ location: 'overture', rect: { minX: - 95, maxX: 95, minZ: - 200, maxZ: 45 }, margin: 30 },   // 只护溪谷（泉眼以南）；洞口那面崖、崖顶、朝花园的北坡都可以侵蚀（洞口、溪床、洞顶另有保护）
				{ location: 'garden', rect: { minX: - 150, maxX: 150, minZ: - 400, maxZ: 60 }, margin: 40 },
				{ location: 'sunset', rect: { minX: - 110, maxX: 110, minZ: - 100, maxZ: 120 }, margin: 60 },
				{ location: 'gothic', rect: { minX: - 110, maxX: 110, minZ: - 60, maxZ: 90 }, margin: 40 },
				{ location: 'aurora', rect: { minX: - 350, maxX: 350, minZ: - 550, maxZ: 150 }, margin: 80 },
			],
		},
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
		// 阶段 12：hi 档核心区 8.33 米一格（烘焙的地形 4.17 米一格，正好隔一个取一个）、外圈 50 米；外圈间距要能整除核心区的长宽、
		// 也要是核心区间距的整数倍，两块网格的边才对得齐
		terrain: { coreSize: [ 4200, 4800 ], coreCenter: [ 100, 200 ], coreSpacing: { hi: 25 / 3, mid: 12.5, lo: 12.5 }, outerSize: 20000, outerSpacing: { hi: 50, mid: 75, lo: 75 } },
		biomeSpacing: 4,           // 地表图（河、桃林、花海、天光遮蔽）的像素间距（米）
		horizonSpacing: 25,        // 地形阴影用的地平线图间距（米），16 个方向
		hazeFalloff: 1500,         // 大气透视的高度衰减（米）：越高空气越干净
		mistDensity: 0.0005,       // 贴地薄雾在海拔 0 处的密度（每米，再乘 mist）；薄雾最多盖一半，远处地点的剪影还认得出
		mistFalloff: 55,           // 薄雾的衰减高度（米）：只贴着盆地底和湖面
		// 谷雾（阶段 12 CP5）：盆地上空的几层水平薄雾片。height 海拔（米）、density 最浓处的不透明度（再乘一天的 mist）、
		// coverage 成团的噪声阈值（越高越零碎）、drift 顺风飘的速度（米/秒）、brightness 颜色比大气色亮几成、seed 噪声偏移；
		// minAmount：一天里 mist 最少按多少算（入夜后、凌晨从高处往下看也有几缕）
		valleyMist: {
			minAmount: 0.18,
			layers: [
				{ height: 78, density: 0.75, coverage: [ 0.42, 0.62 ], drift: 1.2, brightness: 1.05, seed: 0 },
				{ height: 130, density: 0.5, coverage: [ 0.5, 0.68 ], drift: 2.0, brightness: 1.12, seed: 3100 },
			],
		},
		clouds: { height: 4500, coverage: 0.4, scale: 2400, speed: 7, direction: 70, octaves: { hi: 5, mid: 4, lo: 3 } },
		// 云团（阶段 12 CP5）：几团朝镜头的公告板积云。count 团数；azimuth 放在盆地中心的哪个方位扇形里（度，从北顺时针：东、南两面的山上空，
		// 西边海和落日、北边极光都不放）；radius 离盆地中心多远（米）；spacing 团和团至少隔多远；altitude 团底的海拔；width 一团多长；puffs 一团几片；size 一片多大（米）
		cloudClusters: { count: { hi: 16, mid: 12, lo: 12 }, azimuth: [ 55, 215 ], radius: [ 3200, 7800 ], spacing: 1400, altitude: [ 1500, 2400 ],
			width: [ 700, 1500 ], puffs: [ 9, 15 ], size: [ 200, 480 ] },   // 薄云：高度（米）、覆盖率、尺度（米）、风速（米/秒）、风往哪个方位吹（度）
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
		windSpeed: 7.4,              // 风速（米/秒，规格 5~8；审查 R17 从 6.5 调高，光路宽一点、中段连起来）：Cox–Munk 斜率方差按它算；风小于约 5.8 时浪和波纹会自动跟着变小
		windDirection: 100,          // 浪的主方向（度）：90 = 朝 +z，也就是朝岸边推过来
		waveScale: 1,                // 大浪整体振幅倍数（再大会被 Cox–Munk 的 σ² 压回来，想要更大的浪请同时调大风速）
		waveChoppiness: 0.85,        // Gerstner 的 Q（尖峰程度），陡度总和会自动压到 1 以下
		waterColor: '#1d2b4a',       // 海水暗部
		shallowColor: '#2e5d5a',     // 礁石边浅水
		sssColor: '#3fbfa0',         // 浪尖逆光透出的绿
		sssStrength: 0.5,
		foamColor: '#fff4ea',
		pathIntensity: 3.6,          // 金色光路（Cox–Munk 高光瓣，平均亮度）的倍数；近处的碎光主要靠闪点
		sparkleIntensity: 3.2,       // 光路闪点的亮度倍数（审查 R17 从 2.5 调高）（峰值约 F·L_太阳 × 它，进 HDR 让 bloom 出星芒）
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
		backdropGain: 1.6,           // 站在这里时远景（世界的地形、树、替身）的亮度倍数：雪原的月光是统一天空月光的约 9 倍，盆地不压暗也不能太亮（原来 2.5，凌晨三点的盆地像白天的绿沙盘，2026-10-02 降）
		holeDepth: 60,               // 雪原地形底下的远景压低多少米（让开，不和雪原地形互相穿插）
	},

	// 性能（核显上 hi 档 30 帧的那一轮）：各项省法的开关和参数。开关关掉就回到原来的画法（自查时同一个构建里前后对比用）
	perf: {
		// 开场、花园、哥特
		scenesA: {
			reflectionCull: true,        // 花园、哥特的倒影里不画草和花圃：从眼睛高度看，它们的反射交点都落在水外（被池边、湖岸挡住）
			// 倒影里的城堡用 lod1（规格书 10.2：倒影用 6 万那一级）。哥特关着：lod1 的窗玻璃和近处级逐顶点一样（192 间屋的房间号、格号、
			// 楼层、随机数都对得上），但石头减面后窗框、窗花少了，倒影里露出来的亮窗明显多、更亮（截图对比几万个像素差到 200 以上），
			// 而倒影里也只省 4.7 万三角
			reflectionLod: { garden: true, gothic: false },
			reflectionFollowScale: true, // 放大模式（场景按 renderScale 画）下倒影分辨率跟着乘 renderScale；满分辨率时不变
			skipHiddenShading: true,     // 着色器里跳过算了也被盖掉的部分：平面倒影开着时的天空色，开场溪水的假倒影、漂花、白沫，开场岸上的岩石
			overtureGrassReflection: { inner: 0.3, outer: 0.2, far: 0 }, // 开场倒影里三环的草各画几成（原来 0.3 / 0.3 / 0.3；远环在倒影里几乎看不到）
			caveHide: true,              // 开场进洞以后藏起开场自己的草、溪水，倒影也不画（飘落的花瓣跟着镜头，洞里也看得见，不藏）
			caveHideDistance: 10,        // 进洞多少米以后藏（洞口在身后，"初极狭"那段洞壁挡住了外面）
		},
		// 树（近处的 3D 树、地点的花树、林下）
		trees: {
			viewCulling: true,           // 按镜头朝向挑：视锥水平投影的半张角 + dragAngle + marginAngle 以外的不画（closeRadius 米以内全收）
			closeRadius: 40,             // 米
			dragAngle: 30,               // 度：飞行里拖动转头的上限
			marginAngle: 25,             // 度：树冠的宽、转头到重挑之间的偏差
			turnAngle: 10,               // 度：朝向偏了这么多（加上低头、抬头时视锥变宽的量）就重挑
			// 度：花园的花树进不进池面倒影按镜头位置算（倒影可能落进池面的才画，见 trees.js mayReflect），这是池面微波把倒影采样错开的最大角度
			// （花园池面的采样偏移约 0.01 个画面）。原来按离池中轴 70 米一刀切，站在池边往对岸看时对岸的花树倒影没了（自查截图 garden 花圃）。
			// 开场的桃林不分（镜头贴水、溪面微波大，保守地算几乎每棵都可能落进溪面，见 overture.js）
			reflectSlack: { garden: 1 },
		},
		// 草（src/tsl/grass.js，开场、花园、哥特共用）
		grass: {
			cheapCull: true,             // 顶点着色器开头先用便宜的必要条件判死（环形淡出 × 存活随机数、开关、草地图里存的附近最大密度），死叶不算丛簇、地面、风、光照
			sortBlades: true,            // 实例按空间小格排（格里再按存活随机数排），同一组顶点一起死、一起跳过
			sortFar: true,               // 远环也排（按半径带、角度扇区）。远环半透明，叠在一起的叶片先后画的次序变了，远草那一条带里有零点几的像素差几个色阶
			// 近内环、近外环（26 米内）算不算大气。关掉（false）省一截顶点着色，但花园、开场的晨雾近处也有，草会变得又绿又硬：
			// 实测开场 52 秒 18% 的像素差 16 个色阶以上，看得出来，保持 true
			nearAtmosphere: true,
			noiseTexture: true,          // 秃斑、成片长短、阵风的 4 个值噪声改取噪声贴图（每个顶点省 32 次整数哈希；斑块、阵风的位置换了一套，样子不变）
			clumpSearch: 2,              // 找最近丛心的格子：3 = 3×3（原来的），2 = 按格内象限只找 2×2（少数叶子归到第二近的丛，实测不到 0.5% 的像素有差）
			bakeNoise: true,             // 秃斑、成片长短烘进地点草地图（块里离边 10 米以上不现算；便宜判死的上界也乘上秃斑）
		},
		// 落日、雪原、星月夜、窄处（着色器里的省法建材质时读，改了要重新进那个地点才生效）
		scenesB: {
			// 雪原的极光贴图：视野（半对角视场 + auroraViewMargin 弧度）里的纹素每帧算，视野外按方位分 auroraSlices 片轮流算
			// （混合比按隔几帧折算，时间常数不变），地平线以下不算；给雪地"极光照明"取平均色的那 64 个点每帧照算
			auroraViewOnly: true,
			auroraViewMargin: 0.3,
			auroraSlices: 8,
			auroraSheetSkip: true,       // 离帘幕中线 2.6 个厚度以外（sheet < 0.001）这一层这条帘幕不算光线、分段、下缘那四个噪声
			grainSkip: true,             // 雪的颗粒：最粗一级也小到淡没了（像素足迹 × 频率 ≥ 0.8）就整段不算（结果本来就是 0）
			driftSkip: true,             // 地吹雪：边缘、近处淡出、崖外乘出来是 0 的地方不算 fbm，卷流是 0 的地方丢掉
			sparkleSkip: true,           // 闪光（雪、海共用）：超过 fadeEnd 只算统计补偿，两级网格混合比正好是 0 时不算第二级
			glitterPathOnly: true,       // 落日海面：单颗闪点只在光路附近算（海面法线和半程向量差得比"锥角 + glitterMargin 度"还多时闪点看不出来）
			glitterMargin: 12,
			foamSkip: true,              // 落日海面：泡沫覆盖度 ≤ 0.02 的地方（最后乘的 smoothstep 正好是 0）不算泡沫图案
			shadowOnDemand: true,        // 雪原、落日的阴影图：中心按 shadowSnap 米吸附、对齐纹素，中心换格或光转了才重画（落日的太阳一直在落，至少隔 sunsetShadowFrames 帧）
			shadowSnap: 4,
			sunsetShadowFrames: 4,
			sunsetReflectionFollowScale: true,   // 放大模式下落日倒影的分辨率跟着乘场景比例
			starrySkyOnChange: true,     // 星月夜的天空底稿只在用到的开关（大漩涡、星、月、颜料亮度）变了才重画，进地点时画一次
			starryViewCull: true,        // 星月夜的笔：锚点离镜头前向超过 半对角视场 + starryViewMargin 弧度 + 这一笔能走出去的角度，整笔不画、顶点里不算
			starryViewMargin: 0.3,
			starryBaseStill: true,       // 底层的笔不动：不做沿流线的积分（行程本来就乘 0）
			starryFlowEveryOther: true,  // hi 的流场贴图也隔帧画（原来 hi 每帧画）
			narrowsCull: true,           // 窄处：网格按自己的包围球做视锥剔除；离镜头远到最大的一块在画面上不到 narrowsHidePixels 个像素才藏
			narrowsHidePixels: 1.5,
			narrowsReferenceHeight: 1600,  // 按多高的画面（像素）换算"几个像素"（竖直视场用画它的那台相机的；取比 1200 高的，高分屏上也不提前藏）
		},
	},

};

export default config;
