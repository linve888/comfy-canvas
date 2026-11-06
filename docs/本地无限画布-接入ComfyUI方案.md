# 本地无限画布 · 接入 ComfyUI 的技术方案

> 目标：做一块类似 LibTV 的无限画布，节点化编排，所有生成任务跑在本机 ComfyUI（RTX 3080 20GB）。
> 本方案的每个技术判断都基于对你本机 ComfyUI 的实测（0.43.0 / 2233 个节点 / 队列为空），实测记录见附录 A。

---

## 0 先定坐标：不要复刻 LibTV

LibTV 的产品外壳是「无限画布 + 节点工作流」，但它的护城河是**云端 30+ 模型聚合**和**面向 Agent 的 Skill 接口**。这两条你既不需要也做不到。

你的护城河是另外三条：

1. **零边际成本**：H3、Wan2.2、Qwen-Image 都在本地，跑一条视频不花钱，可以肆无忌惮地试错 20 版。
2. **素材不出门**：短剧的分镜、角色母版、剧本不上传任何第三方。
3. **批量流水线**：40 集 × 每集 30+ 镜，这是 LibTV 的通用画布不会替你解决的问题——它没有"按 EP/镜号归档"的概念。

所以定位写成一句话：

> **本地版 LibTV = 无限画布（人调）+ 串行队列（机器跑）+ 模板（沉淀你的分镜规范）**

### 明确不做（省下 3 个月）

| 功能 | 为什么不做 |
|---|---|
| 时间轴剪辑台 | LibTV 有，但那是另一个半年工程。你用剪映/达芬奇，画布只负责产出素材 |
| 3D 导演台 | 同上，独立产品 |
| 云端模型聚合 | 这是 LibTV 的生意，不是你的需求 |
| 多人协作与权限 | 单机自用。真需要时再加，见 §8 |
| Agent Skill 接口 | 你已经有 H3 提示词流水线，画布是"手工精修台"，不是自动化入口 |

---

## 1 技术选型（含被否方案的理由）

| 维度 | 选择 | 理由 | 否决了什么 |
|---|---|---|---|
| 画布 | `@xyflow/react` v12（MIT） | 你要的是 **DAG 节点图**，不是涂鸦白板。连线、框选、minimap、自定义节点、parent 分组全都自带 | tldraw：许可证带水印条款，且 DAG 语义要自己实现；Fabric/Konva：等于手写一切 |
| 前端 | Next.js 15 + TS + Tailwind + Zustand | 画布状态高频更新，Zustand 比 Redux 轻；Next 只为路由与打包 | Vue：React Flow 在 Vue 生态没有等价物 |
| 后端 | Fastify 5 + `ws`（独立进程，:7870） | ComfyUI 的 WS 必须由服务端独占一条长连接再扇出给浏览器，Next Route Handler 不适合长连接 | NestJS：这个体量过重；Python FastAPI：也能做，但**前后端同 TS 才能共享模板类型**，这是决定性差异 |
| 数据库 | SQLite（`better-sqlite3`）+ Drizzle ORM | 单机零运维，事务够用，Drizzle 直接生成前端类型 | Postgres：多一层运维，收益为零 |
| 队列 | DB 任务表 + `p-queue`（concurrency=1） | 单卡必须串行，进程内队列足够；重启后靠 DB 恢复 | BullMQ：要 Redis，单机无必要 |
| 存储 | 本地 `storage/` + sharp 缩略图 + HTTP Range 流 | 视频文件大，必须支持拖动进度条 | 直接读 ComfyUI 输出目录：见 §2.4 坑 3 |
| 包管理 | pnpm workspace | 前后端共享 `packages/shared` 的类型 | |

**架构三层**（浏览器 → 本地服务 → ComfyUI），中间那层是你唯一需要真正写代码的地方。

---

## 2 ComfyUI 对接层：唯一必须做对的地方

### 2.1 五个端点

| 端点 | 用途 | 必须注意 |
|---|---|---|
| `POST /prompt` | 提交工作流 | **只能是 API 格式**。ComfyUI 菜单 `Workflow → Export (API)`。UI 格式（含 `nodes`/`links` 数组）会被拒。请求体 `{prompt, client_id}`，返回 `{prompt_id}` |
| `GET /ws?clientId=` | 实时进度 | 消息类型见下 |
| `GET /history/{prompt_id}` | 结果兜底 | WS 掉线后靠它对账，`outputs` 里是 `{nodeId: {images\|gifs\|videos: [{filename, subfolder, type}]}}` |
| `GET /view?filename=&subfolder=&type=output` | 下载产物 | 必须走它，不能直接拼磁盘路径（`subfolder` 逻辑会变） |
| `POST /upload/image` | 参考图上传 | 返回 `{name, subfolder}`，注入 `LoadImage.image` 时要用 `subfolder/name` |
| `GET /object_info` | 模型清单与参数枚举 | 前端下拉动态化的来源，也是**版本漂移的检测点** |

WS 消息类型（服务端必须全部处理，不能只处理 progress）：

```
status              { exec_info: { queue_remaining } }
execution_start     { prompt_id }
executing           { node, prompt_id }     // node 为 null 表示结束
progress            { value, max, node }
executed            { node, output }        // 拿到 output.images / output.videos
execution_error     { exception_message, node_id }
execution_success   { prompt_id }
```

### 2.2 核心机制：把工作流当成「函数」

这是整个方案的心脏。一个工作流模板 = 一个带槽位的函数，画布节点 = 一次调用。

**槽位定义**（`packages/shared`）：

```ts
export type SlotSpec =
  | { kind: 'text';   node: string; field: string; multiline?: boolean; default?: string }
  | { kind: 'number'; node: string; field: string; min?: number; max?: number; step?: number
      grid?: { k: number; b: number }; default: number }   // 网格吸附，见下
  | { kind: 'enum';   node: string; field: string; values: string[]; default: string }
  | { kind: 'image';  node: string; field: string }         // 由连线或上传填充
  | { kind: 'seed';   node: string; field: string };

export interface Template {
  id: string;                 // 'h3/i2v'
  label: string;              // 'H3 图生视频 768p'
  kind: 'image' | 'video';
  version: number;            // 模板自身版本，用于漂移检测
  graph: ComfyGraph;          // API 格式 JSON，只读
  slots: Record<string, SlotSpec>;
  output: { node: string; type: 'image' | 'video' };
  /** 该模板与 ComfyUI 版本绑定的自检断言 */
  requires?: Array<{ node: string; fields: string[] }>;
}
```

**编译器**：

```ts
export function compile(
  tpl: Template,
  params: Record<string, unknown>,
  ctx: { prefix: string },
): ComfyGraph {
  const graph = structuredClone(tpl.graph);   // 深拷贝，模板永远只读

  for (const [key, spec] of Object.entries(tpl.slots)) {
    let v = params[key] ?? spec.default;
    if (v === undefined) throw new SlotMissing(tpl.id, key);
    if (spec.kind === 'number' && spec.grid) v = snapToGrid(v as number, spec.grid);
    if (spec.kind === 'number' && spec.step) v = quantize(v as number, spec.step);
    graph[spec.node].inputs[spec.field] = v;
  }

  // 强制注入输出前缀：否则产物全是 ComfyUI_00001，无法归档
  graph[tpl.output.node].inputs.filename_prefix = ctx.prefix;  // e.g. 'EP01/S03_h3'
  return graph;
}
```

三个必须坚持的点：

1. **`structuredClone` 深拷贝**。缓存模板被改动一次，之后所有生成都带错参数，且极难排查。
2. **`filename_prefix` 强制注入**。你现在的输出目录里全是 `AIGCTYD2_00001.mp4`、`ComfyUI_00001_.png` 这种，事后按镜号归档只能靠人工。这一行代码解决掉。
3. **参数在编译期校验**，不要等 ComfyUI 返回 `node_errors` 才告诉用户。

### 2.3 参数约束必须前置到 UI（基于你本机节点的实测）

这是最容易被跳过、但最影响手感的一步。ComfyUI 节点的参数有硬网格，UI 必须吸附：

| 节点 | 约束 | UI 该怎么呈现 |
|---|---|---|
| `MiniMaxH3ImageToVideo` | `length` 按 **24fps**，吸附到 **17k+5** 网格，默认 124（≈5.17s）；`width/height` 必须 **32 的倍数**，step 32 | 用户填「秒数」，内部换算：`frames = round((sec*24 - 5)/17)*17 + 5` |
| `MiniMaxH3ImageToVideo` | `first_frame` / `last_frame` 是 **可选输入** | 原生支持首尾帧模式，画布上给「首帧/尾帧」两个输入桩 |
| `MiniMaxH3ReferenceToVideo` | `ref_images` 是 **AUTOGROW**（数量可变）；`vae`、`audio_vae` 可选 | 参考图槽位做成「+ 添加参考」列表，不是固定 1 张 |
| `Wan22ImageToVideoLatent` | `length` 吸附 **4n+1**，默认 49（@16fps ≈3s） | 同上的秒数换算，但 k=4, b=1 |
| `SaveVideo` | `format`/`codec` 是**嵌套动态 COMBO**，不是普通字符串 | 不要开放给用户手填，模板里写死 `auto` |

如果这一层不做，用户会在滑块上拖出一个 121 帧，然后等 40 秒拿到一句 `Value not in list`。

### 2.4 一次生成的完整时序

```
浏览器                  BFF (:7870)                    ComfyUI (:8188)
  |                        |                                |
  |-- POST /api/jobs ----->|                                |
  |   {nodeId,tplId,params}|                                |
  |                        |-- compile() 注入槽位            |
  |                        |-- insert job (queued)          |
  |                        |-- p-queue (concurrency=1)     |
  |                        |-- POST /prompt {prompt,client_id} -->|
  |                        |<------------- {prompt_id} ----|
  |                        |   job.status = running         |
  |<-- SSE: queued/running |                                |
  |                        |<==== WS progress ==============|
  |<-- SSE: progress 62% --|   (按 prompt_id 归因 → job)    |
  |                        |<==== WS execution_success =====|
  |                        |-- GET /history/{id} ---------->|
  |                        |<---- outputs[].videos ---------|
  |                        |-- GET /view?filename=... ----->|
  |                        |<---- 二进制流 -----------------|
  |                        |-- 落 storage/ + sharp 缩略图   |
  |                        |   job.status = succeeded       |
  |<-- SSE: succeeded -----|   + assets 入库                |
  |   节点刷新显示产物      |                                |
```

失败路径：`execution_error` → `job.status = failed`，**把 `exception_message` 原文存进 job.error 并在 UI 上原样展示**。不要归一化成「生成失败，请重试」——ComfyUI 的报错（缺模型、OOM、显存不足）指向性很强，吃掉它等于自断排障能力。

### 2.5 四个必须提前防的坑

**坑 1：WS 断线丢消息。**
服务端持唯一 WS 连接并维护 `promptId → jobId` 映射。连接断开后重连，**不能相信内存状态**，必须用 `/queue` + `/history` 全量对账一次。用户刷新浏览器同理：SSE 重连后先拉 `/api/jobs?active=1`。

**坑 2：单卡必须串行。**
`concurrency` 只能是 1。3080 的 20GB 跑 H3 int8 已经吃满（实测当前 free VRAM 8.4GB，但那是空载状态），并行两个必然 OOM，而且 OOM 会让 ComfyUI 进程进入异常状态。排队要**显式可见**：`"前面还有 3 个，预计 6 分 20 秒"`，用同模板最近 5 次耗时的中位数估算。

**坑 3：不能依赖 ComfyUI 的输出目录。**
`D:\ComfyUI_Output` 是你的手工工作目录，ComfyUI 清理、改名、换实例都会让它变。产物必须 `/view` 拉回来存进自己的 `storage/`，DB 里只存自己的 assetId。**ComfyUI 的输出目录对画布而言只能是临时区。**

**坑 4：模板会随 ComfyUI 升级漂移。**
你用的是 0.43.0，ComfyUI 更新极频繁。`SaveVideo` 的 `format` 已经是 `COMFY_DYNAMICCOMBO_V3` 这种嵌套结构——这类节点定义几乎每个版本都在动。做法：**服务启动时跑一遍模板自检**，拿 `requires` 里的 `{node, fields}` 去比对 `/object_info`，不匹配就在 UI 顶部挂黄条「模板 h3/i2v 与当前 ComfyUI 不兼容：缺 SaveVideo.format」，而不是等用户点了生成才炸。

### 2.6 三条路线，选 L1

| 路线 | 做法 | 适用 |
|---|---|---|
| **L1 模板节点**（推荐） | 画布节点 = 一次工作流执行；节点之间传的是**产物文件** | MVP 到长期主力 |
| L2 DAG 编译 | 把画布上多个节点编译成**一张** ComfyUI 图，节点间传 latent | 同一次生成串 3+ 模型时 |
| L3 内嵌 ComfyUI 前端 | iframe 或复刻 | 不做，等于重写 ComfyUI |

**为什么 L1 就够用**：创作时你的真实动作是「这张图换个模型再试」「这段视频重跑个 seed」「把这张脸挪到下一条」。产物级串联天然支持这些；而 L2 的收益只是省一次 VAE 编解码，在 3080 上大约 2–4 秒。

**什么时候才该升 L2**：同一条生成里要串 3 个以上模型（例如 `H3 出片 → 插帧 → SeedVR2 放大`），并且你一天跑几百条。到那时再写编译器，不要提前。

---

## 3 数据模型

```sql
-- 项目：一集一个 project，或一部片一个
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 画布节点
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- text | image | video | script | group
  x REAL NOT NULL, y REAL NOT NULL, w REAL, h REAL,
  data TEXT NOT NULL,            -- JSON：{ text, templateId, params, activeAssetId }
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- 连线：语义是「把上游产物绑定到下游的某个输入槽」
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL, target TEXT NOT NULL,
  slot_key TEXT NOT NULL,        -- 对应 Template.slots 的 key，如 'image' / 'prompt'
  created_at INTEGER NOT NULL
);

-- 任务：唯一的状态真相源，进程重启后靠它恢复
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  params TEXT NOT NULL,          -- 编译前的原始参数，用于重跑
  compiled TEXT,                 -- 实际提交的图快照，用于复现
  prompt_id TEXT,                -- ComfyUI 返回
  status TEXT NOT NULL,          -- queued | running | succeeded | failed | canceled
  progress REAL DEFAULT 0,
  error TEXT,
  queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);
CREATE INDEX idx_jobs_active ON jobs(status) WHERE status IN ('queued','running');

-- 资产：所有产物的唯一入口
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL, job_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- image | video | audio
  path TEXT NOT NULL,            -- storage/ 内相对路径，绝不存绝对路径
  thumb_path TEXT,
  width INTEGER, height INTEGER, duration REAL, bytes INTEGER,
  source_filename TEXT,          -- ComfyUI 原始 filename，便于溯源
  created_at INTEGER NOT NULL
);
```

设计要点：
- `nodes.data` 存 params 而不是把参数拆成列——参数是模板相关的，拆列必然僵化。
- `edges.slot_key` 是 L1 语义的关键：一条线不是"数据流"，而是"把 A 绑到 B 的 image 槽"。
- `jobs.compiled` 存下实际提交的图快照。三个月后想复现某张图时，这是唯一可靠的东西（模板可能已经改过）。

---

## 4 单卡串行的体验设计（决定好不好用）

这一层比画布本身更影响你对工具的评价。

1. **队列面板常驻右下角**，每条显示：缩略预览 / 模板名 / 目标节点 / 状态 / 进度条 / 已耗时 / 取消按钮。
2. **区分「加载模型」与「采样」**。首次加载 H3 int8 冷启动约 40–90 秒，WS 的 `executing` 节点名能区分：如果卡在 `UNETLoader` / `VAELoader` / `CLIPLoader`，显示「加载模型中（首次较慢）」，不要显示一个 0% 卡死 90 秒。
3. **取消分两种**：当前正在跑的用 `POST /interrupt`；还没开始的直接从 DB 队列删（不要走 interrupt，会把正在跑的那个打断）。
4. **不要自动 `/free`**。`POST /free` 会卸载模型，下次生成又要冷启动 90 秒。只在用户显式点「释放显存」时调。
5. **失败可一键重跑**，且保留原 params + 原 seed。改 seed 重跑作为单独按钮。

---

## 5 目录结构

```
canvas-comfy/
├─ apps/
│  ├─ web/                        Next.js 15
│  │  └─ app/(canvas)/[projectId]/page.tsx
│  │     components/
│  │        Canvas.tsx            React Flow 容器
│  │        nodes/ImageNode.tsx
│  │        nodes/VideoNode.tsx
│  │        nodes/PromptNode.tsx
│  │        GenPanel.tsx          生成面板（槽位渲染器）
│  │        QueueDock.tsx
│  └─ server/                     Fastify
│     src/
│        routes/{jobs,assets,templates,comfy}.ts
│        comfy/client.ts          HTTP 封装
│        comfy/ws-hub.ts          单连接 + 事件扇出 + 断线对账
│        comfy/compiler.ts        槽位注入
│        comfy/selfcheck.ts       启动时模板自检
│        queue/runner.ts          p-queue(1)
│        assets/store.ts          /view 下载 + sharp 缩略图 + Range 流
├─ packages/
│  ├─ shared/                     SlotSpec、Template、DTO（前后端共用）
│  └─ templates/                  *.api.json + registry.ts
├─ storage/                       {projectId}/{assetId}.mp4
├─ data/app.db
└─ .env                           COMFY_URL=http://127.0.0.1:8188
```

---

## 6 里程碑与验收标准

每个阶段都有可验证的出口，不做完不进下一阶段。

| 阶段 | 工作量 | 内容 | 验收标准 |
|---|---|---|---|
| **M0 打通** | 1–2 天 | 脚本直连 ComfyUI 跑通一次文生图 | `pnpm smoke` 输出一张 png 到 `storage/`，且 DB 有 asset 行 |
| **M1 画布可用** | 5–7 天 | React Flow 画布、双击建节点、文本/图像节点、生成面板、SSE 进度、产物上屏 | 不刷新页面，从空白画布到出图到图片显示，全程无手动操作 |
| **M2 视频 + 队列** | 4–5 天 | H3 i2v 模板、队列面板、取消、断线恢复 | 连排 5 条视频，中途强刷浏览器，5 条状态全部正确恢复，无重复提交 |
| **M3 批量** | 3–5 天 | 脚本节点 → N 个镜头 → 批量入队 → 按 EP/镜号命名归档 | 粘贴 20 行分镜，一键生成 20 张，文件落 `storage/EP01/S01.png` … `S20.png` |
| **M4 打磨** | 持续 | 模板编辑器（丢一个 workflow json 自动推断槽位）、组节点复用、参考图框选、L2 评估 | 新增一个模型接入 ≤ 10 分钟，无需改代码 |

**M3 才是你这个项目真正的价值点**，不是画布本身。40 集的量级下，「把 20 行分镜变成 20 张已归档的图」比「无限画布」省的时间多一个数量级。如果时间紧，M3 可以提到 M2 前面。

---

## 7 风险清单

| 风险 | 影响 | 规避 |
|---|---|---|
| 单卡串行 = 排队 | 体验瓶颈，改不了 | 队列透明化 + 耗时预估 + 让长任务（视频）能后台跑、前台继续画布 |
| ComfyUI 升级导致模板失效 | 全线不能用 | 启动自检 + 模板 `version` 字段 + 保留 `compiled` 快照 |
| 节点数增长后画布卡顿 | >200 节点掉帧 | React Flow 的 `onlyRenderVisibleElements`；产物视频用 poster 图，不自动播放 |
| 视频文件撑爆磁盘 | 静默占满 | asset 表存 bytes，设置项目配额，提供「按项目/按时间清理」 |
| 端口/跨域 | 前端 3000 打后端 7870 | Next `rewrites` 代理 `/api/*` 到 7870，浏览器只认同源；无需开 CORS |
| 安全 | ComfyUI 无鉴权 | BFF 只监听 `127.0.0.1`；`COMFY_URL` 写死 localhost；绝不做公网转发 |

---

## 8 需要你拍板的三件事

这三个选择会实质改变 M1–M2 的代码结构，动手前定掉：

1. **只给自己用，还是给团队用？**
   自己用 → SQLite + 无认证，方案照上文。
   团队用 → Postgres + 简单口令或 OAuth，BFF 从本机进程变成常驻服务，存储要改成对象存储。成本大约 +1 周。

2. **视频主力模型定 H3 还是 Wan2.2？**
   H3 i2v：`length` 走 24fps/17k+5，原生支持首尾帧和参考图，画质最好，但吃显存、慢。
   Wan2.2 ti2v 5B：`4n+1` / 16fps，快，显存友好，适合先出草稿。
   建议：**Wan2.2 出草稿 → 选中满意的镜头再用 H3 精修**。这需要模板支持「同参数换模型重跑」，是 M4 的功能，但数据结构现在就要留（`nodes.data.templateId` 可切换即可）。

3. **「脚本节点批量生成分镜」要不要提到 M2？**
   按你的 40 集流水线，这个功能的价值可能超过视频节点本身。提前的代价是把 M2 拉长 2 天。

---

## 附录 A 本机环境实测记录

```
ComfyUI        0.43.0  (frontend 1.57.4, python 3.13.12, torch 2.12.1+cu130)
GPU            NVIDIA GeForce RTX 3080, 20GB VRAM (当前空闲 8.4GB)
节点总数        2233
输出目录        D:\ComfyUI_Output
输入目录        %LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared\input
队列状态        空 (queue_running=[], queue_pending=[])
/prompt 探测    返回 {"error":{"type":"no_prompt"...},"node_errors":{}}  ← 接口正常

可用扩散模型（UNETLoader, 27 个，节选）
  H3\minimax_h3_fl2va_pruned_int8_convrot
  Minimax_H3\Minimax-h3_Singularity_ref2va_v2_pruned_int8
  Minimax_H3\fasth3_omniref_8step_pruned_int8_convrot
  Wan2.2\wan2.2_ti2v_5B_fp16
  qwen\qwen_image_edit_2511_fp8_..._lightning_comfyui_4steps
  krea-2\krea2_turbo_int8_convrot
  Z_image\z-image-turbo-fp8
  seedvr2\seedvr2_3b_int8_convrot

可用 CLIP（14 个）   Minimax_H3\qwen3vl_32b_minimax_h3_int8、wan2.2\umt5_xxl_fp16 ...
可用 VAE（21 个）    Minimax_H3\minimax_h3_video_vae_fp16、minimax_h3_audio_vae_fp32 ...
H3 相关 LoRA（节选）  camera_motion_h3_lora、h3-realism-people-t2v-i2v-r2v、
                     minimax_h3_ref2v_turbo_8step_v1.1_768p、wushu_action_h3_lora

关键节点签名（实测）
  MiniMaxH3ImageToVideo
    required: clip, vae, prompt, width(step32,default1344), height(step32,default768),
              length(24fps, step17, default124, 训练区间~124-362)
    optional: first_frame, last_frame          ← 首尾帧原生支持
    output:   CONDITIONING, LATENT
  MiniMaxH3ReferenceToVideo
    required: clip, prompt, width, height, length, ref_image_size
    optional: vae, audio_vae, ref_images(AUTOGROW，数量可变)
  Wan22ImageToVideoLatent
    required: vae, width, height, length(step4,default49), batch_size
    optional: start_image
  SaveVideo    required: video, filename_prefix, format(嵌套 COMBO_V3)
  SaveImage    required: images, filename_prefix
```

注意：**模板里的 node id 取决于你自己导出哪份工作流**，上文代码中的 `'6'`、`'9'`、`'20'` 都是示意值。实际做法是：在 ComfyUI 里打开你调好的 H3 工作流 → `Workflow → Export (API)` → 把 JSON 扔进 `packages/templates/`，再按节点 id 填槽位表。
