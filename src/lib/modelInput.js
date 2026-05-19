import process from "node:process";

export function getModelQueryFromInput(line) {
  const raw = String(line || "").trimStart();
  if (!/^\/model(?:\s|$)/i.test(raw)) return null;
  const restRaw = raw.slice("/model".length);
  if (restRaw.length === 0) return null;
  const rest = restRaw.trim();
  if (rest.toLowerCase() === "list") return null;
  return rest;
}

export function parseModelTargetForInput(target) {
  const raw = String(target || "").trim();
  const match = raw.match(/^(anthropic|openai|openrouter|codex|seed)\s*:\s*(.+)$/i);
  if (match) {
    return {
      provider: match[1].toLowerCase(),
      model: match[2].trim(),
    };
  }
  return { provider: "", model: raw };
}

export function inferModelSuggestionProvider(modelId) {
  const raw = String(modelId || "").trim();
  if (!raw) return "";
  const parsed = parseModelTargetForInput(raw);
  if (parsed.provider) return parsed.provider;
  const lower = raw.toLowerCase();
  if (lower.includes("doubao-seed") || lower.startsWith("seed-")) return "seed";
  if (lower.includes("codex") || lower.startsWith("gpt-5")) return "codex";
  if (raw.includes("/")) return "openrouter";
  if (lower.startsWith("claude-")) return "anthropic";
  if (lower.startsWith("gpt-")) return "openai";
  return "";
}

export function isModelProviderConfigured(provider, settings = {}, env = process.env) {
  const key = String(provider || "").trim().toLowerCase();
  if (!key) return true;
  if (key === "codex") return true;
  const providers =
    settings?.providers && typeof settings.providers === "object" && !Array.isArray(settings.providers)
      ? settings.providers
      : {};
  const providerSettings = providers[key] && typeof providers[key] === "object" ? providers[key] : {};
  const topLevelProvider = String(settings?.provider || "").trim().toLowerCase();
  const topLevelApiKey = topLevelProvider === key ? settings?.apiKey : "";
  if (key === "openrouter") {
    return Boolean(env.OPENROUTER_API_KEY || providerSettings.apiKey || topLevelApiKey);
  }
  if (key === "seed") {
    return Boolean(env.SEED_API_KEY || env.ARK_API_KEY || providerSettings.apiKey || topLevelApiKey);
  }
  if (key === "openai") {
    return Boolean(env.OPENAI_API_KEY || providerSettings.apiKey || topLevelApiKey);
  }
  if (key === "anthropic") {
    return Boolean(env.ANTHROPIC_API_KEY || providerSettings.apiKey || topLevelApiKey);
  }
  return true;
}

export function filterUsableModelCatalog(catalog, settings = {}, env = process.env, alwaysInclude = []) {
  const source = Array.isArray(catalog) ? catalog : [];
  const keep = new Set((Array.isArray(alwaysInclude) ? alwaysInclude : []).map((item) => String(item || "").trim()).filter(Boolean));
  const out = [];
  const seen = new Set();
  const seenTargets = new Set();
  const targetKey = (modelId) => {
    const value = String(modelId || "").trim();
    const parsed = parseModelTargetForInput(value);
    const provider = parsed.provider || inferModelSuggestionProvider(value);
    const model = parsed.model || value;
    return provider && model ? `${provider}:${model}`.toLowerCase() : value.toLowerCase();
  };
  const push = (modelId) => {
    const value = String(modelId || "").trim();
    if (!value || seen.has(value)) return;
    const key = targetKey(value);
    if (seenTargets.has(key)) return;
    seen.add(value);
    seenTargets.add(key);
    out.push(value);
  };
  for (const modelId of source) {
    const value = String(modelId || "").trim();
    if (!value) continue;
    const provider = inferModelSuggestionProvider(value);
    if (keep.has(value) || isModelProviderConfigured(provider, settings, env)) {
      push(value);
    }
  }
  for (const modelId of keep) push(modelId);
  return out;
}
