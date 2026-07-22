import { Compile } from "typebox/compile";
import { parseHybridPrompt } from "../src/prompts/prompt-parser";
import { diffPromptText } from "../src/prompts/prompt-diff";
import { roundTripPrompt, runPromptToolkit } from "../src/prompts/prompt-operations";
import { createPromptToolkitTool, PROMPT_TOOLKIT_SCHEMA } from "../src/tools/prompt-toolkit";
import { acceptanceTest } from "./acceptance";

describe("hybrid prompt toolkit", () => {
  acceptanceTest("PROMPT-TOOLKIT-001@1", "hybrid-preservation", "round trips mixed syntax without changing bytes", () => {
    const source = "A woman stands beneath neon signs, 1girl, (blue eyes:1.2), <lora:film:0.8>, __weather__, artist\\,name, BREAK, AND, low quality";
    expect(roundTripPrompt(source)).toBe(source);
    const document = parseHybridPrompt(source);
    expect(document.pools.naturalLanguage.map((item) => item.text)).toEqual(["A woman stands beneath neon signs"]);
    expect(document.pools.tags.map((item) => item.canonicalKey)).toContain("blue eyes");
    expect(document.pools.special.map((item) => item.specialType)).toEqual(["lora", "wildcard", "break", "and"]);
  });

  it("keeps comma-linked natural-language clauses in one independent block", () => {
    const source = "A woman stands beneath neon signs, wearing a red coat and looking over her shoulder, 1girl, red coat";
    const document = parseHybridPrompt(source);
    expect(roundTripPrompt(source)).toBe(source);
    expect(document.pools.naturalLanguage.map((item) => item.text)).toEqual([
      "A woman stands beneath neon signs, wearing a red coat and looking over her shoulder",
    ]);
    expect(document.pools.tags.map((item) => item.canonicalKey)).toEqual(["1girl", "red coat"]);
  });

  it("does not split a natural-language clause internally or rewrite it during tag sort", () => {
    const source = "A woman stands beside a rain-soaked window, masterpiece, 1girl, cinematic lighting";
    const result = runPromptToolkit("sort", source, "tags", { promptField: "positive" });
    expect(result.output.startsWith("A woman stands beside a rain-soaked window")).toBe(true);
    expect(result.output).toContain("1girl, cinematic lighting, masterpiece");
    expect(result.changes.every((change) => change.pool === "tags")).toBe(true);
  });

  acceptanceTest("PROMPT-TOOLKIT-001@1", "deterministic-operations", "deduplicates canonical tags within a group and keeps the stronger weight", () => {
    const source = "1girl, blue_eyes, (blue eyes:1.2), BREAK, blue eyes";
    const result = runPromptToolkit("deduplicate", source, "tags", { weightPolicy: "highest", preserveGroups: true });
    expect(result.output).toBe("1girl, (blue eyes:1.2), BREAK, blue eyes");
    expect(result.summary.removed).toBe(1);
    expect(result.summary.normalized).toBe(1);
    expect(result.recommended_patch).toEqual({ operation: "replace", find: source, replace: result.output, allow_multiple: false });
  });

  it("preserves uncertain fragments and reports malformed syntax", () => {
    const source = "A very elaborate phrase whose exact role remains unclear; perhaps, [broken";
    const result = runPromptToolkit("validate", source);
    expect(result.output).toBe(source);
    expect(result.diagnostics.some((item) => item.code === "unbalanced_delimiter")).toBe(true);
    expect(result.changed).toBe(false);
  });

  it("normalizes only the selected pool and preserves natural-language bytes", () => {
    const source = "  A woman stands beside the window  ,   blue_eyes  ";
    const result = runPromptToolkit("normalize", source, "tags");
    expect(result.output).toBe("  A woman stands beside the window  ,   blue_eyes");
    expect(result.changes.every((change) => change.pool === "tags")).toBe(true);
  });

  it("uses the negative category order without moving BREAK groups", () => {
    const source = "low quality, bad hands, blurry, BREAK, watermark, bad anatomy";
    const result = runPromptToolkit("sort", source, "tags", { promptField: "negative" });
    expect(result.output).toContain("BREAK");
    expect(result.output.split("BREAK")).toHaveLength(2);
  });

  it("returns semantic additions, removals, normalization, and moves", () => {
    const result = diffPromptText("masterpiece, blue_eyes, 1girl", "1girl, (blue eyes:1.2), cinematic lighting");
    expect(result.changes.some((item) => item.kind === "removed" && item.before === "masterpiece")).toBe(true);
    expect(result.changes.some((item) => item.kind === "added" && item.after === "cinematic lighting")).toBe(true);
    expect(result.changes.some((item) => item.kind === "normalized" && item.before === "blue_eyes")).toBe(true);
    expect(result.changes.some((item) => item.kind === "moved" && item.before === "1girl")).toBe(true);
  });

  it("exposes one bounded local Agent tool and honors abort", async () => {
    const validator = Compile(PROMPT_TOOLKIT_SCHEMA);
    expect(validator.Check({ action: "deduplicate", prompt: "1girl, 1girl", pool: "tags" })).toBe(true);
    expect(validator.Check({ action: "unknown", prompt: "x" })).toBe(false);
    const tool = createPromptToolkitTool();
    const result = await tool.execute("tool-1", { action: "deduplicate", prompt: "1girl, 1girl", pool: "tags" }, new AbortController().signal);
    expect(result.details).toMatchObject({ ok: true, output: "1girl", changed: true });
    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute("tool-2", { action: "analyze", prompt: "1girl" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("enforces the bounded prompt input size", () => {
    expect(() => parseHybridPrompt("界".repeat(50_000))).not.toThrow();
    expect(() => parseHybridPrompt("界".repeat(50_001))).toThrow(/50000/);
  });
});
