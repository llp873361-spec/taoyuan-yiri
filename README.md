# 一天五景

送给她的单文件 3D 网页礼物：清晨白银花园城堡 → 黄昏落日海 → 入夜哥特城堡 → 深夜梵高星空 → 凌晨极光雪原。
产物只有一个 `dist/index.html`，双击就能离线打开（Chrome / Edge / Safari）。规格和进度见 `CLAUDE.md`。

## 怎么构建

需要 Node 20 以上。

```bash
npm install
npm run build
```

产物在 `dist/index.html`，所有代码、贴图、模型都内联在里面，不联网。

## 怎么看

- 双击 `dist/index.html`，点"点击开启"。
- 场景里：WASD 走路，Shift 跑；按住鼠标左键拖动转头。
- 空格 暂停 / 继续；← → 上一个 / 下一个场景；F 全屏；H 隐藏界面。

地址后面可以加参数（在浏览器地址栏里 `index.html` 后面加）：

| 参数 | 作用 |
|---|---|
| `?debug` | 打开调试面板：帧率、内存、时间轴、画质、自由相机、每层效果开关 |
| `?q=hi` / `?q=mid` / `?q=lo` | 强制画质档位 |
| `?webgl=1` | 强制走 WebGL2（测兜底路径） |

参数可以组合，比如 `index.html?debug&q=lo`。

## 截图验收

用本机装的 Chrome 无头截图，断网，同时收集控制台报错和内存泄漏：

```bash
npm run shot
```

常用选项：

```bash
node scripts/shot.mjs --backend=webgpu --scene=aurora --layers
```

- `--backend=webgpu|webgl|both`：截哪个后端（默认两个都截）
- `--scene=aurora`：只截一个场景
- `--layers`：额外截逐层对比图（每个机位全开一张，再每次只关一层）
- `--query=q=lo`：给页面加参数
- `--software`：用软件渲染模拟没显卡的电脑

截图在 `shots/`，报告在 `shots/report.json`。有报错、外部请求或泄漏时退出码为 1。

## 素材

手动下载的模型、贴图、音频放进 `assets/raw/`，然后：

```bash
npm run opt
```

处理结果输出到 `assets/opt/`。每个外部素材都要在 `assets/credits.json` 里登记标题、作者、许可、链接、用途，缺字段脚本会报错。

## 可调参数

所有文字和数字都在 `src/config.js`：开场和结尾文字、各场景时长、调色、转场、画质三档、后期、音频、雪原的月亮 / 雾 / 极光 / 闪光等。改完重新 `npm run build`。
