import {
  filterUsableModelCatalog,
  getModelQueryFromInput,
  inferModelSuggestionProvider,
  isModelProviderConfigured,
} from "../src/lib/modelInput.js";

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
    expect(filterUsableModelCatalog(catalog, {}, {}, [])).toEqual(["codex:gpt-5.3-codex"]);
    expect(filterUsableModelCatalog(catalog, {}, { OPENROUTER_API_KEY: "or-key" }, [])).toEqual([
      "codex:gpt-5.3-codex",
      "openrouter:moonshotai/kimi-k2.5",
    ]);
    expect(
      filterUsableModelCatalog(catalog, { providers: { seed: { apiKey: "seed-key" } } }, {}, [])
    ).toEqual(["codex:gpt-5.3-codex", "seed:doubao-seed-code-preview-latest"]);
  });

  test("always keeps explicitly configured current models visible", () => {
    const catalog = ["openrouter:moonshotai/kimi-k2.5"];
    expect(filterUsableModelCatalog(catalog, {}, {}, ["openrouter:moonshotai/kimi-k2.5"])).toEqual([
      "openrouter:moonshotai/kimi-k2.5",
    ]);
    expect(isModelProviderConfigured("openrouter", {}, {})).toBe(false);
  });

  test("deduplicates equivalent prefixed and bare model aliases", () => {
    expect(filterUsableModelCatalog(["codex:gpt-5.3-codex", "gpt-5.3-codex"], {}, {}, [])).toEqual([
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
