# OpenAI 兼容 Copilot 适配层

把 OpenBB Workspace 的自定义 Copilot 接到**任意 OpenAI 兼容接口**（MiniMax /
DeepSeek / OpenAI / Ollama / LM Studio / one-api…）的本地小服务。

```
Workspace Copilot 面板
        │  POST /v1/query（带仪表盘 widget 数据）
        ▼
适配层 (FastAPI, 127.0.0.1:7777)
   · /agents.json        ← agent 清单，UI 添加时读取
   · /v1/query           ← SSE 流式对话
   · 把消息+widget 上下文翻译成 OpenAI messages 再转发
        ▼
上游模型 (默认 MiniMax M3，OPENAI_BASE_URL 可换任意家)
```

## 快速开始

```powershell
cd D:\work\trade\workspace\my_tools\copilot-adapter

# 1. 编辑 .env，填入你的 MiniMax token
notepad .env          # OPENAI_API_KEY=...（platform.minimaxi.com 申请）

# 2. 先单独验证 key 是否可用（顺便看有哪些模型）
D:\work\trade\workspace\.venv\Scripts\python.exe check_upstream.py
D:\work\trade\workspace\.venv\Scripts\python.exe list_models.py

# 3. 启动（常驻窗口，Ctrl+C 停止）
.\start.ps1
```

**Workspace 里已经添加好了**这个 agent（名称 MiniMax Copilot，指向
http://127.0.0.1:7777）。启动后必须做一步切换：打开 Copilot 面板 → 点面板
**左下角显示当前 Copilot 名字的下拉**（`Manage Copilots`）→ 选 **MiniMax Copilot**。

> ⚠️ 不切换的话，发消息会走内置的 **OpenBB Copilot**（它的云端 ai.openbb.dev
> 已下线），界面会显示 “An error has occurred”。切换一次即记住（存在浏览器
> localStorage 的 copilot store 里），换浏览器才需要再切。
>
> 若列表里没有这个 agent：LIBRARY → AI → Agents → Add Agent → URL 填
> `http://127.0.0.1:7777` → Test → Add。

> 改动 `.env` 后必须重启服务（配置在进程启动时读取）。
> `AGENT_ID` 不要随意改——改了要删掉 UI 里的旧 agent 重新添加。

## 文件说明

| 文件 | 作用 |
|---|---|
| `main.py` | FastAPI 服务：/agents.json、/v1/query（SSE）、/health、/v1/models |
| `translate.py` | 把 Workspace 的消息 + widget 上下文翻译成 OpenAI messages |
| `reasoning.py` | 把 `<think>` 思考块从答案里剥离，转成可折叠的推理步骤 |
| `settings.py` | .env 配置读取 |
| `check_upstream.py` | 填完 key 后先跑它验证上游连通性 |
| `list_models.py` | 列出 key 实际可用的模型（弹下拉清单时对照着填） |
| `selftest.py` | 离线自测（配合 mock_upstream，不花 token） |
| `mock_upstream.py` | 假 OpenAI 上游，用于无 key 演示/自测（端口 7799） |
| `start.ps1` | 启动脚本（优先用 workspace 的 venv） |

## 配置项（.env）

关键项：

- `OPENAI_BASE_URL`：上游地址。MiniMax 国内 `https://api.minimaxi.com/v1`，
  国际 `https://api.minimax.io/v1`；换 DeepSeek/Ollama 同理改这里
- `OPENAI_API_KEY`：上游密钥。也可以在 UI 添加 agent 时用 Header
  `X-Upstream-Key` 覆盖，不必写进文件
- `OPENAI_MODEL` / `OPENAI_MODELS`：默认模型 / 下拉可选清单
- `CONTEXT_MAX_CHARS`（40000）/ `WIDGET_MAX_CHARS`（6000）：注入给模型的
  仪表盘数据预算，太大会吃 token、太小模型看不到数据
- `UPSTREAM_PROXY`：上游需要代理时填（如 `http://127.0.0.1:10808`）。
  注意适配层**默认不继承系统代理环境变量**（`trust_env=False`），避免被
  终端的内部代理劫持；api.minimaxi.com 国内一般直连即可
- `REASONING_MODE`：推理模型的思考过程怎么处理。`status`（默认）折叠成
  面板里的 “Step-by-step reasoning” 步骤；`hide` 直接丢弃；`inline` 原样
  把 `<think>` 标签混在答案里（不推荐）
- `ADAPTER_HOST/PORT`：默认 127.0.0.1:7777

## 实现的能力边界

**能：**

- 流式输出（SSE `copilotMessageChunk` / `done` 事件，与官方协议一致）
- **推理过程单独成段**：MiniMax M 系列的 `<think>` 思考被拆出来，显示为
  可折叠的 “Step-by-step reasoning”，正文只留答案
- 读取仪表盘 widget 数据作为上下文：用户 @ 提及 / 点 AI 按钮选中的 widget
  全文注入，其余 dashboard widget 摘要注入（有字符预算防爆炸）
- **TradingAgents 深度分析（服务端工具）**：模型识别到“完整/深度分析”类
  请求时调用 `run_trading_agents`，适配层子进程跑完整条多智能体流水线
  （数据走本地 OpenBB），过程以状态消息流式展示，最终评级/交易计划回给
  模型组织答案。开关：
  - `.env` 的 `TA_RUNNER_ENABLED`（默认 true，重启生效）
  - 运行时热切换：`GET/POST http://127.0.0.1:7777/v1/ta/enabled`
    `{"enabled": false}` 关闭后该工具不再暴露，其余功能不受影响
- 模型切换：`models` 清单暴露给 UI 下拉，选中项直接传给上游
- 错误友好提示：401/404/429/超时/断连都会以系统消息形式显示在对话里

**不能（如实关闭了对应 feature 开关）：**

- 不执行 MCP 工具、不加/改 dashboard widget（`get_widget_data` 等函数调用
  未实现——上游模型的 function calling 循环在服务端没搭，V2 可加）
- 无 Generative UI、无 Agent 编排
- 对话标题自动生成走的是 Workspace 指向的官方云（已下线），标题保持 New Chat
- 图片/文件附件仅支持其文本部分（上游 MiniMax 文本接口）

## 自测

```powershell
# 无 token 全链路自测
python mock_upstream.py            # 窗口 1：假上游 7799
$env:OPENAI_BASE_URL="http://127.0.0.1:7799/v1"; $env:OPENAI_API_KEY="test"; $env:OPENAI_MODEL="MockModel"
python -m uvicorn main:app --port 7777   # 窗口 2
python selftest.py                 # 窗口 3：打印 SSE 帧与回复
```

2026-10-21 已做过三层验证：selftest 协议自测 ✅、前端 zod schema 校验 ✅、
真实浏览器 UI 添加 + 对话 ✅（见 `my_tools/adapter_ui_test.mjs`）。
widget 取数端到端（登录 → 加 widget 上下文 → get_widget_data 往返 → 模型读数作答）✅
（见 `my_tools/widget_data_e2e.mjs`，Playwright 真实 UI）。

### widget 数据为全 null 的坑（已修，需服务端配合）

`getExportData`（前端把 Plotly 图转表格行）要求 `trace.y` 是普通数组。
OpenBB `fig.to_json()` 会把大数组序列化成 `{dtype, bdata}` base64 二进制块，
前端不解码 → 全部变 null。已在 **OpenBB 仓库** `openbb_cboe/routers/options.py`
加 `_unpack_plotly_binary` 解码（commit `0308185`），并把该文件同步拷贝到
`.venv/Lib/site-packages/openbb_cboe/routers/options.py`（site-packages 的实体
副本优先于源码树 editable 路径，只改源码树不生效），随后重启 `openbb-api`。

另一个坑：MAX_TOOL_ROUNDS 若按整个聊天历史统计 tool 消息，几轮对话后就
永久耗尽额度、适配器不再下发 tools，模型会输出裸 `<tool_call>` 文本并称
"没有可用工具"。已改为只统计**当前一轮**（最后一条 human 消息之后）。

## 排错速查

| 现象 | 处理 |
|---|---|
| **回复永远是 “An error has occurred”** | 面板选的还是内置 **OpenBB Copilot**（云已下线）。点面板左下角 Copilot 名字下拉 → 选 **MiniMax Copilot** |
| `401` | key 错/过期，重新生成；确认 base_url 与 key 同区域（.io ↔ 国际站） |
| `404` | OPENAI_BASE_URL 少了 `/v1`，或缺 `/chat/completions` |
| `429` | 限流/欠费，看 MiniMax 控制台 |
| `无法连接上游`（国内访问 .io 站） | `.env` 设 `UPSTREAM_PROXY=http://127.0.0.1:10808` |
| UI 里 Test 一直转圈 | 适配层没启动：先跑 `start.ps1`，浏览器访问 http://127.0.0.1:7777/health |
| 回复内容空但无报错 | 看适配层窗口日志；`context 超 40000 字符` 时会被截断（调大 CONTEXT_MAX_CHARS） |
| 说“看不到仪表盘数据” | 没有 widget 被加入上下文：在 widget 上点 AI/加号把它推给 Copilot |

## 安全

- 服务只监听 `127.0.0.1`，不暴露局域网
- `.env` 已加入本目录 `.gitignore`，密钥不会进 git
- 上游 key 全程只存在本机
