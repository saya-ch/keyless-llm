#!/usr/bin/env python3
"""Build models.catalog.json: live anon model list + metadata from embedded providers.json."""
import json

RAW = r"C:/workspace/keyless-llm/raw"
OUT = r"C:/workspace/keyless-llm/models.catalog.json"

# live anonymous model ids (probed 2026-10-25)
ANON_LIVE = [
    "big-pickle", "beam-free", "flint-40b-free", "mimo-v2.6-flash-free",
    "nemotron-3.5-super-vl-free", "nemotron-3.5-lightning-free", "jev-1.13-free",
    "deepseek-v4.1-flash-free", "glm-5.3-flash-free", "test", "claude-fable-5",
    "jev-1.13", "claude-fable-5-1", "claude-haiku-4-5", "claude-haiku-5-5",
    "claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8",
    "claude-opus-5", "claude-opus-5-5", "claude-opus-5-5-backup", "claude-sonnet-4-5",
    "claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5", "deepseek-v4-flash",
    "deepseek-v4.1-flash", "deepseek-v4-pro", "gemini-3-flash", "gemini-3.1-pro",
    "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash",
    "gemini-3.8-flash", "gemini-4-argon", "glm-5", "glm-5.1", "glm-5.2", "glm-5.3",
    "glm-5.3-flash", "gpt-5", "gpt-5-codex", "gpt-5-nano", "gpt-5.1", "gpt-5.1-codex",
    "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex",
    "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
    "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-luna", "gpt-5.6-sol",
    "gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-terra",
    "grok-4.5", "grok-4.6", "grok-4.7", "grok-build-0.1", "kimi-k2.5", "kimi-k2.6",
    "kimi-k2.7-code", "kimi-k3", "minimax-m2.5", "minimax-m2.7", "minimax-m3",
    "muse-spark-1.2", "muse-spark-1.3", "muse-wonder-1.0", "mistral-large-4",
    "qwen3.5-plus", "qwen3.6-plus", "qwen3.8-flash", "qwen3.8-max",
]

# free without -free suffix (from embedded zen catalog cost=0)
FREE_NOSUFFIX = {"big-pickle", "beam-free", "grok-code"}

providers = json.load(open(f"{RAW}/providers.json", encoding="utf-8"))
zen_models = providers["opencode"]["models"]

catalog = []
for mid in ANON_LIVE:
    is_free = mid.endswith("-free") or mid in FREE_NOSUFFIX
    meta = zen_models.get(mid, {})
    entry = {
        "id": mid,
        "free": is_free,
        "name": meta.get("name", mid),
        "context": (meta.get("limit") or {}).get("context"),
        "output": (meta.get("limit") or {}).get("output"),
        "reasoning": meta.get("reasoning"),
        "tool_call": meta.get("tool_call"),
        "attachment": meta.get("attachment"),
        "modalities": (meta.get("modalities") or {}).get("input"),
    }
    catalog.append(entry)

free_count = sum(1 for c in catalog if c["free"])
out = {
    "generated_at": "2026-10-25",
    "source": "live:/inference/v1/models + embedded:opencode-ai@1.18.35 zen catalog",
    "anon_models_total": len(catalog),
    "anon_free_total": free_count,
    "models": catalog,
}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print(f"catalog: {len(catalog)} models, {free_count} free")
for c in catalog:
    if c["free"]:
        print(f"  FREE {c['id']:32s} ctx={c['context']} out={c['output']} meta={'embedded' if c['context'] else 'live-only'}")
