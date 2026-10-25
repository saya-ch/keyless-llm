# Keyless LLM Gateway

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)

![平台](https://img.shields.io/badge/platform-Windows%20%2F%20Linux%20%2F%20macOS-lightgrey.svg)

![协议](https://img.shields.io/badge/API-OpenAI%20%2F%20Anthropic%20%2F%20Responses-blue.svg)

把**不需要 API key**的免费模型来源聚合成一个本地网关：改一个 `base_url` 就能用，任何 OpenAI / Anthropic / Responses 兼容的客户端都能接。

[为什么做这个](#为什么做这个) · [只在免鉴权场景有意义](#只在免鉴权场景有意义) · [快速开始](#快速开始) · [接口](#接口) · [客户端](#客户端) · [来源](#来源) · [模型命名](#模型命名) · [面板](#面板) · [实现](#实现) · [配置](#配置) · [安全](#安全) · [故障排查](#故障排查) · [卸载](#卸载)

免鉴权免费模型在 2026 年确实可用，但它们**分散、命名各异、且随时会死**。本项目提供的是一个**可执行的网关**：一个入口、自动发现各来源的模型、跨来源失败转移，而不是一份会过期的清单。

## 为什么做这个

现在能用的免鉴权来源（2026-10-25 实测）：

| 来源           | 端点                            | 免费模型 | 可用 | 限流           |
| ------------ | ----------------------------- | ---- | -- | ------------ |
| Kilo Code    | `api.kilo.ai/api/gateway`     | 16   | 12 | 200 次/小时/IP  |
| Pollinations | `text.pollinations.ai/openai` | 1    | 1  | 4 次/分钟       |
| BlockRun     | `blockrun.ai/api/v1`          | 5    | 4  | IP 限流，免费容量常满 |

合计 **22 个免费模型，17 个当前可调度**，其中 6 个是 1M 上下文。这些模型是 `gpt-oss`、`nemotron-3-ultra`、`beam-free`、`north-mini-code` 这类开源权重模型，跑在 NVIDIA、Poolside、Cohere 等基础设施上。

问题在于它们不能直接拼在一起用：

|        | 直连各来源                                                                           | 用本项目                |
| ------ | ------------------------------------------------------------------------------- | ------------------- |
| 接入     | 每个来源一套 base_url、一套模型名、一套 header                                                 | 一个 `base_url`，模型名统一 |
| 模型发现   | 自己去翻每个来源的 `/models`                                                             | 网关自动拉取并合并           |
| 名字     | Kilo 是 `nvidia/xxx:free`，Pollinations 是 `tier: anonymous`，OpenCode 是 `xxx-free` | `<来源>/<模型>`，或裸名自动匹配 |
| 某个模型挂掉 | 自己重试、换模型                                                                        | 同来源内换模型 → 跨来源转移     |
| 谁还活着   | 只能逐个试                                                                           | 面板一屏看清，按 `R` 轻探测刷新  |

更要命的是**它们会死**。2026 年内 Qwen Code 免费 OAuth（4/15 停）、Gemini CLI 免费层（6/18 停）、GitHub Models（关停）、Cerebras（转 30 天试用）、Roo Code（关闭）、Continue（停更）——包括本项目最早对接的 OpenCode 匿名通道，也已从 429 恶化为整体关闭。

这不是把 `curl` 包一层。真正的工作量在**按来源隔离的冷却状态机**（429 退避、403 拉黑、冷却到期重试）、**跨来源调度**、**协议翻译**和**额度感知**上。

## 只在免鉴权场景有意义

本项目只服务「**完全不需要 API key、不需要注册账号**」的公开通道。这带来三个必须知道的边界：

- **额度按 IP 共享**，不是按你个人。同一出口 IP 下的所有人共用池子，重度用户会把额度打光。
- **请求次数比 token 更稀缺**。Kilo 匿名 200 次/小时是**请求数**配额，探测和实际调用共用它。
- **上游随时可以收紧**。政策一变就 429 或 403，且不会提前通知。

它适合个人开发、试用、离线实验、给 Agent 找一个不花钱的兜底。**不适合当作生产依赖**，也不适合承载不能外泄的代码——这些来源都声明提示词可能被记录或用于训练。

## 快速开始

需要 Windows 10/11、PowerShell 5.1+、Node.js 22+。

```powershell
cd C:\workspace\keyless-llm
.\launch.ps1               # 启动；窗口开着就在跑，关窗即停
```

可选：

```powershell
.\launch.ps1 -AutoSpeed    # 启动时顺便测速（默认不测，省额度）
.\launch.ps1 -Port 8799    # 换端口
node server.mjs            # 不带面板，只跑网关
```

启动后面板会列出本地地址与各来源状态。桌面快捷方式：

```powershell
python scripts/make_lnk.py   # 生成 C:\Users\<你>\Desktop\keyless-llm.lnk
```

## 接口

| 协议                      | 本地地址                       | 说明                             |
| ----------------------- | -------------------------- | ------------------------------ |
| OpenAI Chat Completions | `http://127.0.0.1:8788/v1` | 含流式与工具调用                       |
| Anthropic Messages      | `http://127.0.0.1:8788`    | 完整事件流（`content_block_delta` 等） |
| OpenAI Responses        | `http://127.0.0.1:8788/v1` | —                              |

API Key 填 `sk-keyless-local`（本地自设，仅用于挡本机其它程序）。上游侧**不需要任何 key**。

`GET /v1/models` 列出全部可调度模型，带 `provider` 字段标明来源。

## 客户端

本项目不重写各客户端的配置文档，只把 base URL 换成本地地址即可。

| 客户端                                  | 改哪个字段                        | 值                                           |
| ------------------------------------ | ---------------------------- | ------------------------------------------- |
| Claude Code                          | `ANTHROPIC_BASE_URL`         | `http://127.0.0.1:8788`                     |
| Codex CLI                            | `base_url`                   | `http://127.0.0.1:8788/v1`                  |
| OpenCode                             | `options.baseURL`            | `http://127.0.0.1:8788/v1`                  |
| Cline / Roo Code                     | OpenAI Compatible 的 Base URL | `http://127.0.0.1:8788/v1`                  |
| Aider                                | `OPENAI_API_BASE`            | `http://127.0.0.1:8788/v1`                  |
| Continue                             | `apiBase`                    | `http://127.0.0.1:8788/v1`                  |
| Cherry Studio / LM Studio / NextChat | 自定义 OpenAI 供应商的 Base URL     | `http://127.0.0.1:8788/v1`                  |
| pi / DeepSeek Harness                | `models.json` 里的 `url`       | `http://127.0.0.1:8788/v1/chat/completions` |

### 三个会踩的坑

**OpenCode 的模型 id 不能带斜杠。** 它用 `provider/model` 寻址，斜杠会被当层级分隔符。正确做法是：provider 名填 `keyless`，model 填**不带来源前缀**的名字（如 `beam-free`），拼出来正好是 `keyless/beam-free`。不要在 model 里再写 `kilo/xxx`。

**reasoning 模型会先吃掉 token。** `beam-free`、`nemotron` 系列会输出思考内容，`max_tokens` 给小了会拿不到正文（表现为 `stop_reason: max_tokens` 但内容为空）。这类模型给到 1024 以上。

**模型名尽量写全。** 网关支持裸名匹配（`beam-free` → `kilo/reflection/beam-free`），但同名模型出现在多个来源时会有歧义，此时用完整的 `<来源>/<模型>`。

## 来源

来源定义全部在 `providers.json`，改这个文件就能加新来源，不用动代码。

| id             | 端点                            | 免费判定                  | 说明                      |
| -------------- | ----------------------------- | --------------------- | ----------------------- |
| `kilo`         | `api.kilo.ai/api/gateway`     | id 以 `:free` 结尾       | 200 次/小时/IP，模型最多        |
| `pollinations` | `text.pollinations.ai/openai` | `tier == "anonymous"` | 4 次/分钟，匿名 tier 只剩 1 个模型 |
| `blockrun`     | `blockrun.ai/api/v1`          | id 以 `nvidia/` 开头     | 免费容量经常打满，返回 503         |
| `opencode`     | `opencode.ai/inference/v1`    | id 含 `-free`          | 已停用，匿名额度整体 429          |

各来源的免费模型 id 规则完全不同（`:free` 后缀 / `tier` 字段 / 自由价），所以用 `freeRule` 区分，不要硬编码模型名。

## 模型命名

```
<来源>/<模型>
kilo/reflection/beam-free
kilo/nvidia/nemotron-3-ultra-550b-a55b:free
pollinations/openai-fast
blockrun/nvidia/gpt-oss-120b
```

也接受裸模型名，自动匹配到唯一来源：

```
beam-free                    → kilo/reflection/beam-free
nemotron-3.5-lightning:free  → kilo/nvidia/nemotron-3.5-lightning:free
```

### 失败转移

一次请求最多尝试 `KEYLESS_ATTEMPTS`（默认 2）个模型：

1. 先用你指定的模型
2. 429 / 403 / 5xx 时**同来源内换模型**
3. 同来源全废则**跨来源转移**

响应头 `x-keyless-model` 是实际使用的模型，`x-keyless-failover: 1` 表示发生过转移。

## 面板

启动后显示静态面板，不自动刷新。按键：

| 键   | 作用                                           | 额度成本         |
| --- | -------------------------------------------- | ------------ |
| `R` | 轻探测：每个模型发一次 `max_tokens=1` 请求，只判 200/429/403 | 约 1 token/模型 |
| `T` | 测速：真生成内容算 TPS                                | 数百 token/模型  |
| `E` | 出口扫描：切 Clash 节点，看不同出口 IP 下能否出结果              | 中（会切节点）      |
| `Q` | 退出并停止网关                                      | —            |

面板分四块：接入信息、**来源汇总**（每个来源的模型数 / 可用 / 限流 / 封禁）、**可用模型**（只列能调度的，带实测 TPS）、运行指标与出口扫描结果。

**探测与测速是两条独立路径**：可用性判断永远走便宜的轻探测，**测速不自动执行**——TPS 栏启动时是 `-`，按 `T` 才测。

**探测自己也会节流**：「待验证」的模型 30 分钟内不重复探测，限流/封禁中的模型等冷却到期才探。实测稳态下每轮只探 4 个，而不是全部 22 个。

## 实现

单进程、单端口，三套协议共用一套路由。协议层自研，无第三方依赖。

```
keyless-llm/
├── server.mjs            # 网关本体：provider 注册表 / 状态机 / 三协议 / 探测
├── launch.ps1            # 终端面板启动器
├── providers.json        # 来源清单（要加来源就改这个）
├── measure-speed.mjs     # TPS 测速（经本地网关）
├── egress.json           # 出口扫描结果
├── scripts/
│   ├── egress-scan.mjs   # 多出口扫描（切 Clash 节点 → 测 IP → 测模型 → 恢复）
│   ├── mock-upstream.mjs # 离线测试用的假上游
│   └── test_protocols.mjs
└── docs/
    ├── 免鉴权大模型服务清单.md
    └── OpenCode本体逆向报告.md
```

模型注册表以 `<来源>/<模型>` 为 key，状态机按 key 隔离：429 退避 10 分钟、403 拉黑 60 分钟、5xx 退避 1 分钟，其余错误码视为「无定论」，不误伤模型。

探测与请求都只读状态码；轻探测成功时直接丢弃响应体（`max_tokens=1` 且不消费内容）。

离线验证用本地 mock 上游，不需要凭据、不消耗额度、秒级完成：

```bash
node scripts/mock-upstream.mjs      # 单独启动 mock 上游
node scripts/test_protocols.mjs      # 跑协议自检
```

## 配置

来源清单 `providers.json`：

| 字段             | 说明                                                      |
| -------------- | ------------------------------------------------------- |
| `id`           | 来源标识，出现在模型名前缀                                           |
| `label`        | 面板上显示的名字                                                |
| `base`         | 上游 base URL                                             |
| `modelsPath`   | 模型列表路径，默认 `/models`                                     |
| `freeRule`     | 免费判定：`suffix` / `prefix` / `contains` / `field` / `all` |
| `extraFree`    | 强制算作免费的模型（补 freeRule 覆盖不到的情况）                           |
| `discover`     | `false` 表示不拉 `/models`，只认 `staticModels`                |
| `staticModels` | 兜底模型清单，也是 `discover:false` 时的唯一来源                       |
| `rate`         | 限流说明，显示在面板上                                             |
| `enabled`      | 是否启用                                                    |

环境变量（`KEYLESS_*` 优先，兼容改名前的 `OC2FREE_*`）：

| 变量                                | 默认               | 说明                |
| --------------------------------- | ---------------- | ----------------- |
| `PORT` / `HOST`                   | 8788 / 127.0.0.1 | 监听地址              |
| `KEYLESS_KEY`                     | sk-keyless-local | 本地 API Key        |
| `KEYLESS_PROVIDERS`               | ./providers.json | 来源清单路径            |
| `KEYLESS_PROBE`                   | 1800             | 自动轻探测间隔秒数，0 = 关   |
| `KEYLESS_PROBE_ON_START`          | 1                | 启动时做一次轻探测         |
| `KEYLESS_CD429` / `KEYLESS_CD403` | 600 / 3600       | 限流/封禁冷却秒数         |
| `KEYLESS_ATTEMPTS`                | 2                | 单请求最大尝试次数（含首次）    |
| `KEYLESS_UA`                      | keyless-llm/1.0  | 向上游发送的 User-Agent |

## 安全

- 默认只监听 `127.0.0.1`，**不要**改成 `0.0.0.0`。
- 网关不含任何上游密钥，**不需要**你提供 key。免费来源的匿名身份就是全部凭据。
- 你的请求内容会原样转发给第三方来源，**它们可能记录**。别把私有代码、密钥、生产数据发进去。
- 面板的出口扫描会临时修改本机 Clash 的代理分组并自动恢复，只影响本机，不影响任何远端。

## 故障排查

| 现象                                     | 原因                                       |
| -------------------------------------- | ---------------------------------------- |
| 面板来源汇总全是「待验证」                          | 还没探测过，按 `R`；若仍失败，多为该来源当前不可达              |
| TPS 显示 `-`                             | 尚未测速，按 `T`                               |
| TPS 显示 `429`                           | 该模型被限流，属结果不是错误，冷却结束后会自动恢复                |
| TPS 显示 `TIMEO`                         | 30 秒无响应，来源侧排队或卡住                         |
| 请求返回 `Sign up for free to continue...` | 该来源的匿名请求次数配额用尽，等下一个窗口                    |
| 返回 `503 ResourceExhausted`             | BlockRun 免费容量被打满，自动转移到别的来源               |
| 回答里没有正文只有思考                            | reasoning 模型吃掉了 `max_tokens`，调大到 1024 以上 |
| OpenCode 里模型 403 / 找不到                 | model id 里带了斜杠，见[客户端](#客户端)那节            |
| 端口被占用                                  | 启动器会接管本项目的旧实例；占用者是别的程序时用 `-Port` 换端口     |
| 面板拿不到数据                                | 网关进程没起来，看 `logs/proxy.log`               |

## 卸载

```powershell
# 停止网关：面板里按 Q，或直接关窗口
```

桌面快捷方式直接删 `keyless-llm.lnk` 即可。

删除项目目录即可。不写注册表、不装系统服务、不改 PATH、不留后台进程。

## License

[MIT](LICENSE)
