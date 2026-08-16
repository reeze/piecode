import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  filterUsableModelCatalog,
  getModelQueryFromInput,
  inferModelSuggestionProvider,
  isModelProviderConfigured,
} from "../src/lib/modelInput.js";

// A Codex home with stored login state, so codex counts as a usable provider.
const CODEX_HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-home");
const CODEX_ENV = { CODEX_HOME };

describe("model input parsing", () => {
  test("exact /model remains a status command instead of opening picker", () => {
    expect(getModelQueryFromInput("/model")).toBeNull();
    expect(getModelQueryFromInput("  /model")).toBeNull();
  });

  test("model picker opens only after a model argument boundary", () => {
    expect(getModelQueryFromInput("/model ")).toBe("");
    expect(getModelQueryFromInput("/model codex:gpt-5.5")).toBe("codex:gpt-5.5");
    expect(getModelQueryFromInput("/model list")).toBeNull();
    expect(getModelQueryFromInput("/models")).toBeNull();
  });

  test("infers provider ownership for picker suggestions", () => {
    expect(inferModelSuggestionProvider("openrouter:moonshotai/kimi-k2.5")).toBe("openrouter");
    expect(inferModelSuggestionProvider("moonshotai/kimi-k2.5")).toBe("openrouter");
    expect(inferModelSuggestionProvider("seed:doubao-seed-code-preview-latest")).toBe("seed");
    expect(inferModelSuggestionProvider("codex:gpt-5.3-codex")).toBe("codex");
    expect(inferModelSuggestionProvider("claude-3-5-sonnet-latest")).toBe("anthropic");
  });

  test("filters unavailable provider suggestions from probed model catalog", () => {
    const catalog = [
      "codex:gpt-5.3-codex",
      "openrouter:moonshotai/kimi-k2.5",
      "seed:doubao-seed-code-preview-latest",
      "anthropic:claude-3-5-sonnet-latest",
    ];
    expect(filterUsableModelCatalog(catalog, {}, CODEX_ENV, [])).toEqual(["codex:gpt-5.3-codex"]);
    expect(
      filterUsableModelCatalog(catalog, {}, { ...CODEX_ENV, OPENROUTER_API_KEY: "or-key" }, [])
    ).toEqual(["codex:gpt-5.3-codex", "openrouter:moonshotai/kimi-k2.5"]);
    expect(
      filterUsableModelCatalog(catalog, { providers: { seed: { apiKey: "seed-key" } } }, CODEX_ENV, [])
    ).toEqual(["codex:gpt-5.3-codex", "seed:doubao-seed-code-preview-latest"]);
  });

  test("hides codex models when there is no codex login or CLI", () => {
    const catalog = ["codex:gpt-5.3-codex", "openrouter:moonshotai/kimi-k2.5"];
    expect(filterUsableModelCatalog(catalog, {}, { CODEX_HOME: "/nonexistent/codex-home" }, [])).toEqual([]);
    expect(isModelProviderConfigured("codex", {}, CODEX_ENV)).toBe(true);
    expect(isModelProviderConfigured("codex", {}, { CODEX_HOME: "/nonexistent/codex-home" })).toBe(false);
  });

  test("always keeps explicitly configured current models visible", () => {
    const catalog = ["openrouter:moonshotai/kimi-k2.5"];
    expect(filterUsableModelCatalog(catalog, {}, {}, ["openrouter:moonshotai/kimi-k2.5"])).toEqual([
      "openrouter:moonshotai/kimi-k2.5",
    ]);
    expect(isModelProviderConfigured("openrouter", {}, {})).toBe(false);
  });

  test("deduplicates equivalent prefixed and bare model aliases", () => {
    expect(filterUsableModelCatalog(["codex:gpt-5.3-codex", "gpt-5.3-codex"], {}, CODEX_ENV, [])).toEqual([
      "codex:gpt-5.3-codex",
    ]);
    expect(
      filterUsableModelCatalog(
        ["openrouter:moonshotai/kimi-k2.5", "moonshotai/kimi-k2.5"],
        {},
        { OPENROUTER_API_KEY: "or-key" },
        []
      )
    ).toEqual(["openrouter:moonshotai/kimi-k2.5"]);
  });
});
