# mwi-fastsim

Milky Way Idle（牛牛放置）的战斗模拟与整队优化工具。

**在线使用：https://wow121.github.io/mwi-fastsim/** （先安装 [油猴脚本](https://github.com/wow121/mwi-fastsim/raw/main/userscript/mwi-fastsim.user.js)，再打开一次游戏页面）

*A fast combat simulator and team optimizer for Milky Way Idle. The engine is written in Rust and runs either
natively behind a small local server or as WebAssembly entirely in the browser. The UI is in Chinese.*

- **快**：战斗引擎用 Rust 重写，单线程约为原版 JS 引擎的 12 倍（WebAssembly 约 7 倍），并且多线程并行。
- **整队优化**：不用一个角色一个角色地调，技能、触发条件、药品、装备提升都按整个队伍一起搜索。
- **两种用法，同一份网页**：本机运行一个小服务（原生引擎，最快）；或者把网页放到任意静态网站，打开即用，计算在访问者自己的浏览器里完成。
- **数据来自游戏本身**：油猴脚本在游戏页面读取角色、队友和游戏数据，不用手动录入。所有数据只保存在你自己的电脑或浏览器里。

## 功能

| 页面 | 做什么 |
|---|---|
| 队伍 | 从游戏同步的队伍，可以编辑装备、技能、食物饮料、触发条件，保存成配装方案 |
| 模拟 | 用多个随机种子模拟，给出每人每天的利润、经验、死亡次数，以及收入和支出明细 |
| 刷图推荐 | 所有区域、地下城和难度一起跑，按利润或经验排序 |
| 技能与触发优化 | 整队的技能组合、施放顺序和触发阈值，按职业的可用技能搜索 |
| 药水触发优化 | 整队的食物、饮料种类（同类食物互斥）和触发条件 |
| 整队提升规划 | 每人用自己的现金，在 30 天、60 天等规划期内怎么买装备收益最高，算上过渡装备的差价和卖出税 |
| 目标区域提升 | 想去现在打不动的区域或难度时，装备、技能书、等级、药品怎么提升，最快能做到不死并且比现在赚得多 |
| 装备获取成本 | 某件装备的某个强化等级：直接买、贤者之镜合成、买普通版自己精炼、拿手上的装备当主件或垫子，哪种最便宜，并列出要买的东西 |
| 批量队列 / 任务 | 排队跑多组模拟；所有优化都在后台运行，可以查看进度和历史结果 |

利润按游戏市场价计算（掉落按最高买价、消耗按最低卖价），市场价每 30 分钟自动刷新一次。

## 快速开始

### 方式一：本地服务（推荐，最快）

需要 [Rust](https://rustup.rs/) 和 [Node.js](https://nodejs.org/) 20 或以上。

```sh
git clone https://github.com/wow121/mwi-fastsim.git
cd mwi-fastsim
./rebuild.sh              # Windows：双击 rebuild.cmd
node/start-server.sh      # Windows：双击 node/start-server.cmd
```

然后：

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)，再点 [安装脚本](https://github.com/wow121/mwi-fastsim/raw/main/userscript/mwi-fastsim.user.js)（之后会自动更新）。
2. 打开游戏页面（队伍里任意一个号都可以）。左下角显示「已同步」就说明读取成功。
   队友的数据来自游戏里的队伍资料，缺哪个队友，就在游戏里点开对方的资料，脚本会自动补上。
3. 打开 http://127.0.0.1:8765 。

### 方式二：网页版（纯浏览器）

直接打开 https://wow121.github.io/mwi-fastsim/ 即可（同样需要先装油猴脚本，并打开一次游戏页面）。
这个网页由 GitHub Actions 在每次推送到 `main` 后自动构建发布（`.github/workflows/pages.yml`）。

也可以自己部署：构建后，把 `web/dist` 整个目录上传到任意静态网站即可。nginx、对象存储、GitHub Pages 都可以，放在子目录也行，不需要后端，也不用配置重写规则。

页面打开后如果发现没有本地服务，就自动在浏览器里运行：
- 引擎以 WebAssembly 形式在多个 Web Worker 里并行计算，每个 CPU 核一个。
- 队伍、任务、游戏数据、市场价都存在浏览器的 IndexedDB 里。

部署在自己的域名上时，要在油猴脚本头部照着已有的 `@match` 加上你的域名，例如：

```js
// @match        https://mwi.example.com/*
```

在游戏页面读到的数据会先存在油猴里，打开网页时自动导入。

两种方式算出的结果完全一致（`node/browser-test.mjs` 会逐项比对）。

## 构建

`rebuild.sh` / `rebuild.cmd` 依次做四件事：

1. 编译 Rust 引擎的原生版（`engine/target/release/mwi-fastsim`）。
2. 编译 WebAssembly 版（会自动安装 `wasm32-unknown-unknown` 编译目标）。
3. 安装本地服务的依赖（`node/`）。
4. 安装网页依赖并构建到 `web/dist`，构建前会把 wasm 引擎复制进去。

更新代码后重新运行一次即可。本地服务需要重启；部署的网页则重新上传 `web/dist`。

## 项目结构

```
engine/            Rust 战斗引擎
  src/sim.rs         事件驱动的战斗模拟
  src/main.rs        原生程序：JSON-lines 多线程服务，供本地服务调用
  src/wasm.rs        WebAssembly 接口，供浏览器调用
node/
  server.mjs         本地服务：/api/* 接口、网页、模拟网站加速（/simulate）
  app/               共享逻辑（本地服务和浏览器版共用，不依赖 Node API）
    game.mjs           游戏数据、角色构建（装备、房屋、公会、成就、区域和社区加成）
    engine-core.mjs    队伍配置 → 引擎输入
    import.mjs         游戏数据 → 队伍配置
    metrics.mjs        利润计算
    opt-*.mjs          各优化器
    gear-cost.mjs      装备获取成本
    routes-core.mjs    接口处理
web/               网页（Vue 3 + Element Plus）
  src/local/         浏览器版的接口实现（IndexedDB + WebAssembly Worker 池）
userscript/        油猴脚本
```

游戏数据（物品、怪物、技能、区域等）用的是游戏自己的客户端数据，由油猴脚本在游戏页面读取。
本地服务把它保存在 `node/data/envelope.json`，浏览器版保存在 IndexedDB。第一次使用前需要先打开一次游戏页面。

## 测试

在 `node/` 目录下运行。需要先同步过一次游戏，测试会用到 `data/envelope.json` 和 `data/team.json`。

| 命令 | 检查什么 |
|---|---|
| `node wasm-check.mjs` | WebAssembly 引擎与原生引擎的结果逐项一致 |
| `node test-import.mjs` | 游戏数据导入的往返测试 |
| `node browser-test.mjs` | 用无头 Edge / Chrome 运行浏览器版，和本地服务的结果比对 |
| `node check-prims.mjs` | Rust 的随机数和 `pow` 与 V8 逐位比对 |
| `node smoke.mjs` 等 | 接口和各优化器的端到端测试（另有 `test-upgrades.mjs`、`test-goal.mjs`、`test-gear-cost.mjs`） |

## 致谢与声明

- 战斗引擎移植自[新战斗模拟](https://combat.43.167.210.211.sslip.io)网站的模拟引擎（`combat-events-2.3.0`），
  逐个函数翻译成 Rust，同一随机种子下结果与原版一致。技能优化的候选规则也参考了该网站的技能优化器。感谢原作者。
- 本项目与 Milky Way Idle 官方无关。游戏数据和市场价来自游戏本身，版权归游戏开发者所有。
- 模拟结果仅供参考，游戏更新后可能与实际情况有差异。
