import process from "node:process";
import {
  formatModelRef,
  inferProviderForModel,
  isKnownProvider,
  normalizeProviderId,
  parseModelRef,
  resolveProviderConfig,
} from "./modelCatalog.js";

export function getModelQueryFromInput(line) {
  const raw = String(line || "").trimStart();
  if (!/^\/model(?:\s|$)/i.test(raw)) return null;
  const restRaw = raw.slice("/model".length);
  if (restRaw.length === 0) return null;
  const rest = restRaw.trim();
  if (rest.toLowerCase() === "list") return null;
  return rest;
}

/** `provider:model` for any registry provider, else a bare model id. */
export function parseModelTargetForInput(target) {
  const parsed = parseModelRef(target);
  return { provider: parsed.provider, model: parsed.model };
}

export function inferModelSuggestionProvider(modelId) {
  return inferProviderForModel(modelId);
}

export function isModelProviderConfigured(provider, settings = {}, env = process.env) {
  const key = normalizeProviderId(provider);
  if (!key) return true;
  // Unknown providers are treated as user-supplied endpoints and left visible.
  if (!isKnownProvider(key)) return true;
  return resolveProviderConfig(key, { settings, env }).configured;
}

export function filterUsableModelCatalog(catalog, settings = {}, env = process.env, alwaysInclude = []) {
  const source = Array.isArray(catalog) ? catalog : [];
  const keep = new Set(
    (Array.isArray(alwaysInclude) ? alwaysInclude : []).map((item) => String(item || "").trim()).filter(Boolean)
  );
  const out = [];
  const seen = new Set();
  const seenTargets = new Set();
  const configuredCache = new Map();

  const isConfigured = (provider) => {
    const key = normalizeProviderId(provider);
    if (!configuredCache.has(key)) {
      configuredCache.set(key, isModelProviderConfigured(key, settings, env));
    }
    return configuredCache.get(key);
  };

  const targetKey = (modelId) => {
    const value = String(modelId || "").trim();
    const parsed = parseModelTargetForInput(value);
    const provider = parsed.provider || inferModelSuggestionProvider(value);
    const model = parsed.model || value;
    return provider && model ? formatModelRef({ provider, model }).toLowerCase() : value.toLowerCase();
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
    if (keep.has(value) || isConfigured(provider)) push(value);
  }
  for (const modelId of keep) push(modelId);
  return out;
}
