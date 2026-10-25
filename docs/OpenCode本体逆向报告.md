# OpenCode 本体逆向报告

- 目标：`C:\Users\20655\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe`（v1.18.35，180MB，Bun 编译的 Go 二进制）
- 方法：REA 技能方法论（MCP 工具未接入 → CLI 兜底路线）。二进制内嵌 JS bundle 提取 + 静态字符串分析 + 实网端点验证
- 性质标注：**【观察】**= 二进制/实网实测字面证据；**【推断】**= 基于证据的推理
- 日期：2026-10-25

---

## 1. 二进制结构（观察）

- npm 包 `opencode-ai@1.18.35`，bin 指向平台原生 `opencode.exe`（Go + Bun 混合：Go 主体 + 内嵌 Bun 编译的 TUI/JS）
- 内嵌 JS bundle 位于偏移 `0xc29b5ae`，4.8MB，`// @bun` 头，从 `chunk-*.js` 导入 —— TUI/控制台完整源码（压缩未混淆）
- bundle 内嵌**完整 models.dev 目录**（约 500KB 的 provider/models 对象）
- Go 符号表未剥离（函数名可读）

## 2. 端点表（观察 + 实网验证）

| 通道 | 端点 | 鉴权 | 状态 |
|---|---|---|---|
| anonymous | `https://opencode.ai/inference/v1/*` | 无 | 模型列表 200；补全 429（额度耗尽） |
| zen | `https://opencode.ai/zen/v1/*` | `OPENCODE_API_KEY`（Bearer） | 模型列表匿名可拉（85 个）；补全需 key |
| go | `https://opencode.ai/zen/go/v1/*` 或 `https://opencode.ai/inference/go/v1/*` | go key（Bearer）+ `x-opencode-session` 头 | 模型列表匿名可拉（38 个）；补全需有效 key |
| 模型目录（动态） | `https://models.opencode.ai/models.json` | 无 | 200，505KB（env `OPENCODE_MODELS_URL` 可覆盖） |
| 额度 | `{origin}/v1/credits`（SDK 内 `${baseURL}/config` + `${origin}/v1/credits`） | key | 实测 404（疑已改版） |

**bundle 内 provider 定义（观察）**：
```
opencode:    api=https://opencode.ai/zen/v1     env=[OPENCODE_API_KEY]  npm=@ai-sdk/openai-compatible  models=116
opencode-go: api=https://opencode.ai/zen/go/v1  env=[OPENCODE_API_KEY]  npm=@ai-sdk/openai-compatible  models=34
```
两个通道都是 **OpenAI 兼容**（`@ai-sdk/openai-compatible`）—— 反代协议翻译层因此极薄。

## 3. 请求头（观察）

- `Authorization: Bearer <key>`（标准）
- go 通道强制 `x-opencode-session`（每个对话稳定 session ID，缺 → 400 MissingSessionID）
- `User-Agent` 建议自定义客户端名（文档明确要求，不要用 SDK 默认名）
- 响应带 `opencode.allowance` 字段报告本请求计费额度（文档）

## 4. 免费模型清单（观察，内嵌目录快照 2026-10-09）

### Zen 通道 116 个模型中 36 个免费（`cost.input=0 && cost.output=0`）

| 模型 | ctx | out | 多模态 | 备注 |
|---|---|---|---|---|
| space-bunny-free | 1M | 512K | text/image/video | 输出最大 |
| fledge-alpha-free | 1M | 128K | text/image | |
| muse-spark-1.2/1.3-contributor-free | 1M | 128K | +pdf/audio | |
| nemotron-3-ultra-free / 3.5-lightning-free | 1M/256K | 128K/256K | text | |
| mimo-v2-pro-free / v2-omni-free / v2.6-flash-free / v2.5-free / v2-flash-free | 1M/256K/200K | 64K-128K | 部分多模态 | |
| kimi-k2.5-free | 256K | 256K | text/image/video | |
| longcat-2.5-preview-free / 2.0-free | 1M | 128K | 2.5 带 image | |
| x-preview-f-free | 1M | 128K | text/image/video | |
| minimax-m3/m2.5/m2.1-free | 200K | 32K-128K | m3 带 image/video | |
| glm-5-free / glm-4.7-free | 200K | 128K | text | |
| deepseek-v4-flash-free | 200K | 128K | text | |
| grok-code | 256K | 256K | text | 名字无 free 但标价 0 |
| big-pickle | 200K | 32K | text | 同上 |
| hy3-free / hy3-preview-free / laguna-s-2.1-free / ring-2.6-1t-free / ling-* / north-mini-code-free / trinity-large-preview-free / qwen3.6-plus-free | 128K-256K | 32K-128K | 多数 text | |

### Go 通道 34 个模型中 2 个免费（快照）
- `longcat-2.5-preview-free`、`space-bunny-free`
- **实网 go 列表（10-25）实际为**：`beam-free`、`iceman-contributor-free`（快照后已换血）

### 匿名通道（`/inference/v1/models`，85 个可见）中免费子集 9 个（观察）
big-pickle、beam-free、flint-40b-free、mimo-v2.6-flash-free、nemotron-3.5-super-vl-free、nemotron-3.5-lightning-free、jev-1.13-free、deepseek-v4.1-flash-free、glm-5.3-flash-free

## 5. 额度制度（文档 + 实测）

**Go 订阅（$10/月，Go Plus $40）**：
- 每模型三级窗口：5h = 月度 20% / 周 = 50% / 月 = 100%
- 各模型月度上限 $15-$80（DeepSeek V4.1 Flash $80 最高）
- 超限可开 Extra Usage 回退 pay-as-you-go
- **Beam Free：限时免费、Unlimited**，但**地区限制：中国大陆（含港澳）不可用**（还有俄、伊、朝等）
- 达到限额后免费模型仍可用

**匿名免费（实测 2026-10-25）**：
- 9/9 全部 `429 FreeUsageLimitError`（"Free usage limit reached"）
- 与 10-19 快照（403 为主）相比执行力度在 429/403 之间波动 —— IP 级共享额度
- 历史模式（来自 opencode2api-data）：10-16 大多 429、10-19 转 403、10-25 全 429

## 6. 鉴权现状（观察）

- 本地 `~/.local/share/opencode/auth.json` 的 `opencode-go` key：`sk-BBXt9...qqwRP` → **已过期**（401 `api_key_expired`，需 console 重新创建）
- `zen_keys` 为空
- 同一 key 用于 zen 通道同样 401

## 7. 对反代的设计含义

1. **上游即 OpenAI 兼容** —— 反代核心不是协议翻译，而是：多渠道路由 + 模型轮换 + 额度-state 跟踪 + 面板
2. 三通道优先级：go（key，38 模型，2 免费）> zen（key，116 模型 36 免费）> anonymous（85 可见 9 免费，额度紧张）
3. `x-opencode-session` 必须每对话生成并保持稳定（UUID）
4. Beam Free 大陆不可用 —— 国内用户的免费路径实际是 zen 的 36 个 `*-free` + 匿名 9 个
5. 模型目录双层：内嵌快照（元数据全：pricing/ctx/模态/reasoning）+ 动态 `models.opencode.ai/models.json`（面板实时刷新用）

## 8. 未确认项

1. `/v1/credits` 404 —— SDK 里的路径疑已改版，console 页面的额度 API 待查（需登录）
2. 匿名额度的重置周期（5h？日？）—— 需持续探测
3. `iceman-contributor-free` 的额度属性（新出现，目录未收录）
4. Go 通道 `zen/go/v1` 与 `inference/go/v1` 是否为同一服务的两个别名（实测前者 400 MissingSessionID 而非 404，判定存在）
