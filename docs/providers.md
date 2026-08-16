# Providers and models

Everything piecode knows about model providers lives in one place:
[`src/lib/modelCatalog.js`](../src/lib/modelCatalog.js). It owns the provider
specs, a curated model catalog, credential resolution, and live model discovery.
The CLI, the TUI picker, and the web console all read from it, so adding a
provider once makes it visible everywhere.

## Quick start

```bash
piecode --doctor          # what is configured, what is active, what to fix
piecode --list-providers  # readiness + the exact setup step for each provider
piecode --list-models     # selectable models grouped by provider
```

Inside a session:

| Command | Does |
| --- | --- |
| `/model` | Show the active model and open the picker |
| `/model <provider>:<model>` | Switch directly, e.g. `/model deepseek:deepseek-reasoner` |
| `/models` | List selectable models, grouped by provider |
| `/provider` | Provider table with readiness and setup steps |
| `/provider <id>` | Switch to that provider's default model |
| `/doctor` | Diagnose providers, model, MCP and extensions |

## Supported providers

| id | Provider | Auth | Default endpoint |
| --- | --- | --- | --- |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1` |
| `openai` | OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| `codex` | Codex | `codex login` | ChatGPT backend |
| `codex-local` | Codex against a local server | none | `CODEX_LOCAL_BASE_URL` or `~/.codex/config.toml` |
| `openrouter` | OpenRouter (aggregator) | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` |
| `moonshot` | Moonshot / Kimi | `MOONSHOT_API_KEY` | `https://api.moonshot.cn/v1` |
| `zhipu` | Z.ai / GLM | `ZHIPU_API_KEY` | `https://open.bigmodel.cn/api/paas/v4` |
| `dashscope` | Qwen (Alibaba) | `DASHSCOPE_API_KEY` | DashScope OpenAI-compatible mode |
| `minimax` | MiniMax | `MINIMAX_API_KEY` | `https://api.minimaxi.com/v1` |
| `google` | Gemini | `GEMINI_API_KEY` | Gemini OpenAI-compatibility endpoint |
| `xai` | Grok | `XAI_API_KEY` | `https://api.x.ai/v1` |
| `groq` | Groq | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` |
| `mistral` | Mistral | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1` |
| `siliconflow` | SiliconFlow (aggregator) | `SILICONFLOW_API_KEY` | `https://api.siliconflow.cn/v1` |
| `together` | Together AI (aggregator) | `TOGETHER_API_KEY` | `https://api.together.xyz/v1` |
| `seed` | Volcengine Ark (Doubao/Seed) | `SEED_API_KEY` | Ark coding endpoint |
| `ollama` | Ollama (local) | none | `http://127.0.0.1:11434/v1` |
| `lmstudio` | LM Studio (local) | none | `http://127.0.0.1:1234/v1` |
| `vllm` | vLLM (local) | none | `http://127.0.0.1:8000/v1` |

Aliases are accepted where they are unambiguous: `kimi` → `moonshot`, `z-ai` and
`glm` → `zhipu`, `qwen` → `dashscope`, `gemini` → `google`, `grok` → `xai`,
`doubao` and `ark` → `seed`.

Every provider's endpoint can be overridden — with `--base-url`, with its
`*_BASE_URL` environment variable, or with `providers.<id>.endpoint` in
settings — so a corporate gateway or proxy works without code changes.

## Model references

A model reference is either `provider:model` or a bare model id:

```bash
piecode --model deepseek:deepseek-reasoner   # explicit
piecode --model glm-4.6                      # inferred → zhipu
piecode --model moonshotai/kimi-k2.5         # a `vendor/model` id → openrouter
```

Bare ids are resolved by the registry: an exact catalog match wins, then vendor
prefixes (`claude-*`, `gpt-*`, `deepseek*`, `kimi*`, `glm*`, `qwen*`,
`gemini*`, `grok*`, …), then `vendor/model` shapes, which belong to aggregators.
An id the registry cannot place falls back to the active provider, so an
endpoint serving a private model still works.

## Local runtimes

Local servers need no API key, but they are never auto-selected — piecode would
otherwise pick a server that is not running. Opt in explicitly:

```bash
export OLLAMA_BASE_URL="http://127.0.0.1:11434/v1"
piecode --model "ollama:qwen3-coder:30b"
```

or in `~/.piecode/settings.json`:

```json
{ "providers": { "ollama": { "model": "qwen3-coder:30b" } } }
```

### Local Codex

`codex-local` reuses whatever endpoint the Codex CLI is already configured
against, so a local Codex setup needs no second configuration in piecode.
piecode reads the `[model_providers.*]` tables and the active `model_provider`
from `~/.codex/config.toml`:

```toml
model = "gpt-oss:20b"
model_provider = "ollama"

[model_providers.ollama]
name = "Ollama"
base_url = "http://localhost:11434/v1"
wire_api = "chat"
```

```bash
piecode --provider codex-local
```

To point at a server directly instead, set `CODEX_LOCAL_BASE_URL` (and
`CODEX_LOCAL_MODEL`). The plain `codex` provider also falls back to a local
endpoint when no ChatGPT login and no CLI session is available.

## Model discovery

Providers that expose an OpenAI-style `/models` endpoint are queried on startup
and whenever you run `/models`, so newly released models appear without a
piecode upgrade. Discovery is best effort: it never blocks startup, and being
offline just leaves the curated catalog in place. Disable it with
`PIECODE_MODEL_PROBE=0`.

Discovered context windows override the curated ones, since they come from the
provider itself.

## Adding a model the registry does not know

Two options, neither requiring a code change.

Per-provider, in `~/.piecode/settings.json`:

```json
{
  "providers": {
    "deepseek": { "model": "deepseek-v4-pro", "models": ["deepseek-v4-pro"] }
  }
}
```

Or as a catalog file at `~/.piecode/models.json`, which is merged into the
built-in catalog:

```json
{
  "models": [
    { "id": "my-private-model", "provider": "vllm", "context": 131072, "tags": ["coding"] }
  ]
}
```

## Reasoning effort

`--thinking-effort` / `/think` only applies where the provider accepts it.
The registry records this per provider, so piecode never sends
`reasoning_effort` to APIs that reject unknown request fields (DeepSeek,
Moonshot, GLM, and others). Codex and OpenAI reasoning models accept the
extended scale (`minimal`…`xhigh`); Anthropic's direct API exposes no effort
knob and reports the setting as unsupported.

Override the accepted values per provider if an API changes:

```json
{ "providers": { "deepseek": { "reasoningEfforts": ["low", "high"] } } }
```

## Context windows

The status bar's `ctx:` readout resolves in this order: live discovery,
`contextWindow` in settings (per provider or global), the curated catalog, then
a heuristic from the model name.
