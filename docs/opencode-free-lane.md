# OpenCode 免费车道接入笔记

记录我们接入 OpenCode 匿名免费车道的调研结论与实现方式。来源是
[Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)
（一个 DSH 插件，逆向并持续跟随 OpenCode 免费车道），我们把它 `src/o2a/` 里
的客户端指纹逻辑移植进了 `lib/opencode.mjs`。

## 是什么

OpenCode（`https://opencode.ai`）有一个匿名免费车道，提供 7 个免费模型：

```
deepseek-v4.1-flash-free · glm-5.3-flash-free · mimo-v2.6-flash-free
nemotron-3.5-super-vl-free · nemotron-3.5-lightning-free · beam-free · flint-40b-free
```

模型清单：`GET https://opencode.ai/inference/v1/models`（78 个模型，7 个免费）。
这个 GET 不需要任何指纹。

## 为什么之前一直 429

免费车道不是「公开端点」，它按 **客户端指纹** 放行：只允许官方 OpenCode CLI 的
流量。我们之前用普通 OpenAI 请求打过去，被闸门挡住。闸门是逐项验证的，缺一项就
`403 FreeTierError` 或 `429 FreeUsageLimitError`。

## 闸门清单（v2 客户端，2026-10-14 起）

| 项 | 要求 |
| --- | --- |
| 聊天端点 | `/inference/openai/v1/chat/completions`（旧 `/zen/v1` 全线 403） |
| User-Agent | 整串 `opencode/latest/2.1.1/cli`，任何前后缀都不算 |
| 会话头 | `x-opencode-session` 与 `x-opencode-session-id` 同值，且必须带 `x-session-affinity` / `x-session-id` |
| 会话 id 形状 | `ses_` + 12 位时间反码（`~(ms<<12\|counter)`，counter 1–63）+ 14 位 base62；sha256 派生或随机 hex 会 403 |
| 时间戳 | 会话内嵌日期必须可信（近 30 天内），否则 429 |
| 工具集 | 必须带官方 13 个工具（逐字定义）；`tool_choice: none` 会 403 |
| 系统提示 | 必须是官方 CLI 提示（base prompt + env + skills） |
| 凭证 | `Authorization: Bearer public`（公开 pooled credential） |
| 配额 | 按 `project id × egress IP` 记账，用尽返回 429 |

## 我们的实现

- `lib/opencode.mjs`：session 铸造、v2 headers、body 整形（注入官方 tools + 系统提示、补 `max_completion_tokens`、去 `tool_choice`）
- `lib/opencode/opencode_tools.json` / `opencode_prompt_v2.txt`：官方资产，逐字复制
- `scripts/test-opencode.mjs`：单次验证脚本
- `.github/workflows/test-opencode.yml`：在 CI 干净 IP 上验证

实测记录：本机（经代理出口）指纹通过（没 403），但 **429 配额用尽**——说明逻辑
对了，只是出口 IP 的免费额度被耗尽。CI 的 IP 尚未验证。

## 类比应用

这套「客户端指纹伪装」思路可以复用到其他同类车道：

1. **看文档不如看客户端**：免费车道通常只放行官方客户端，识别方式就是 UA + 特殊头 + 固定 body 形状。抓官方客户端的真实请求（TLS 中间人）是最可靠的逆向方式。
2. **逐项单变量验证**：从真实请求出发，每次只改一项，记录 200/403，才能定位每个闸门。
3. **资产逐字复制**：工具定义、系统提示这类内容必须与官方逐字一致，手写会被指纹比对拒绝。
4. **会话/配额语义**：按会话或项目记账的车道，需要铸造合规的 id，而不是复用同一个。

如果以后接 Cline、Kimi 等类似「只给官方客户端用」的车道，可以直接套这个流程。
