import { canonicalPromptTag, clonePromptItem, composeHybridPrompt, composePromptItems, parseHybridPrompt } from "./prompt-parser";
import type {
  HybridPromptDocument,
  PromptChange,
  PromptDocumentItem,
  PromptPool,
  PromptTag,
  PromptTagCategory,
  PromptToolkitAction,
  PromptToolkitOptions,
  PromptToolkitResult,
} from "./prompt-types";
import { summarizePromptChanges } from "./prompt-types";

const POSITIVE_ORDER: PromptTagCategory[] = [
  "identity", "subject", "composition", "camera", "pose", "action", "appearance", "clothing",
  "environment", "lighting", "color", "style", "quality", "other",
];
const NEGATIVE_ORDER: PromptTagCategory[] = [
  "appearance", "pose", "composition", "camera", "other", "quality", "style", "environment", "lighting", "color", "identity", "subject", "action", "clothing",
];

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Prompt toolkit operation was cancelled.", "AbortError");
}

function selectedPool(item: PromptDocumentItem, pool: PromptPool | "all"): boolean {
  return pool === "all" || item.pool === pool;
}

function normalizedResult(
  action: PromptToolkitAction,
  source: string,
  items: PromptDocumentItem[],
  changes: PromptChange[],
): PromptToolkitResult {
  const output = composePromptItems(items);
  const document = parseHybridPrompt(output);
  const changed = output !== source;
  return {
    ok: true,
    action,
    document,
    output,
    changed,
    changes,
    diagnostics: document.diagnostics,
    summary: summarizePromptChanges(changes, document.pools.unknown.length),
    ...(changed ? { recommended_patch: { operation: "replace" as const, find: source, replace: output, allow_multiple: false as const } } : {}),
  };
}

function analyze(action: "analyze" | "split_pools" | "validate", prompt: string): PromptToolkitResult {
  const document = parseHybridPrompt(prompt);
  const diagnostics = [...document.diagnostics];
  const seen = new Map<string, PromptTag>();
  for (const tag of document.pools.tags) {
    const key = `${tag.group}:${tag.canonicalKey}`;
    const previous = seen.get(key);
    if (previous) diagnostics.push({ code: "duplicate_tag", severity: "warning", message: `Duplicate tag: ${tag.canonicalKey}.`, itemId: tag.id });
    else seen.set(key, tag);
  }
  return {
    ok: true,
    action,
    document: { ...document, diagnostics },
    output: prompt,
    changed: false,
    changes: [],
    diagnostics,
    summary: summarizePromptChanges([], document.pools.unknown.length),
  };
}

function deduplicate(prompt: string, pool: PromptPool | "all", options: PromptToolkitOptions): PromptToolkitResult {
  const document = parseHybridPrompt(prompt);
  if (pool !== "all" && pool !== "tags") return normalizedResult("deduplicate", prompt, document.items, []);
  const items = [...document.items];
  const keepByKey = new Map<string, { index: number; tag: PromptTag }>();
  const remove = new Set<number>();
  const changes: PromptChange[] = [];
  const preserveGroups = options.preserveGroups !== false;

  items.forEach((item, index) => {
    if (item.pool !== "tags") return;
    const key = `${preserveGroups ? item.group : 0}:${item.canonicalKey}`;
    const kept = keepByKey.get(key);
    if (!kept) {
      keepByKey.set(key, { index, tag: item });
      return;
    }
    const keepHighest = options.weightPolicy !== "first";
    const previousWeight = kept.tag.weight ?? 1;
    const nextWeight = item.weight ?? 1;
    if (keepHighest && nextWeight > previousWeight) {
      items[kept.index] = clonePromptItem(kept.tag, item.text);
      changes.push({ kind: "normalized", pool: "tags", before: kept.tag.text, after: item.text, reason: "Kept the stronger duplicate weight." });
      kept.tag = items[kept.index] as PromptTag;
    }
    remove.add(index);
    changes.push({ kind: "removed", pool: "tags", before: item.text, reason: "Removed a duplicate tag in the same prompt group." });
  });

  const retained = items.filter((_item, index) => !remove.has(index));
  repairSeparators(retained);
  return normalizedResult("deduplicate", prompt, retained, changes);
}

function sort(prompt: string, pool: PromptPool | "all", options: PromptToolkitOptions): PromptToolkitResult {
  const document = parseHybridPrompt(prompt);
  if (pool !== "all" && pool !== "tags") return normalizedResult("sort", prompt, document.items, []);
  const items = [...document.items];
  const changes: PromptChange[] = [];
  const order = options.promptField === "negative" ? NEGATIVE_ORDER : POSITIVE_ORDER;
  const rank = new Map(order.map((category, index) => [category, index]));
  const groups = new Map<number, number[]>();

  items.forEach((item, index) => {
    if (item.pool !== "tags") return;
    const indices = groups.get(item.group) ?? [];
    indices.push(index);
    groups.set(item.group, indices);
  });

  for (const indices of groups.values()) {
    const original = indices.map((index) => items[index] as PromptTag);
    const sorted = original
      .map((tag, originalIndex) => ({ tag, originalIndex }))
      .sort((left, right) => (rank.get(left.tag.category) ?? 99) - (rank.get(right.tag.category) ?? 99) || left.originalIndex - right.originalIndex);
    indices.forEach((targetIndex, sortedIndex) => {
      const replacement = sorted[sortedIndex];
      const target = original[sortedIndex];
      items[targetIndex] = clonePromptItem(target, replacement.tag.text);
      if (replacement.originalIndex !== sortedIndex) {
        changes.push({
          kind: "moved",
          pool: "tags",
          before: replacement.tag.text,
          after: replacement.tag.text,
          reason: `Moved into the ${replacement.tag.category} group.`,
          fromIndex: replacement.originalIndex,
          toIndex: sortedIndex,
        });
      }
    });
  }
  return normalizedResult("sort", prompt, items, changes);
}

function normalize(prompt: string, pool: PromptPool | "all"): PromptToolkitResult {
  const document = parseHybridPrompt(prompt);
  const items = document.items.filter((item) => item.text || item.pool !== "unknown" || !selectedPool(item, pool));
  const changes: PromptChange[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!selectedPool(item, pool)) continue;
    const normalizedText = item.pool === "tags" ? item.text.replace(/\s+/g, " ").trim() : item.text.trim();
    if (normalizedText !== item.text || item.raw !== item.text) {
      items[index] = { ...item, text: normalizedText, raw: normalizedText };
      changes.push({ kind: "normalized", pool: item.pool, before: item.text, after: normalizedText, reason: "Normalized surrounding whitespace." });
    }
  }
  for (let index = 0; index < items.length - 1; index += 1) {
    if (selectedPool(items[index], pool) && items[index].separator !== ", ") {
      changes.push({ kind: "normalized", pool: items[index].pool, before: items[index].separator, after: ", ", reason: "Normalized the prompt separator." });
      items[index] = { ...items[index], separator: ", " };
    }
  }
  if (items.length) items[items.length - 1] = { ...items[items.length - 1], separator: "" };
  return normalizedResult("normalize", prompt, items, changes);
}

function compose(prompt: string, pool: PromptPool | "all", options: PromptToolkitOptions): PromptToolkitResult {
  const document = parseHybridPrompt(prompt);
  const layout = options.preferredLayout ?? "preserve";
  if (layout === "preserve" || pool !== "all") return normalizedResult("compose", prompt, document.items, []);
  const movable = document.items.filter((item) => item.pool === "natural_language" || item.pool === "tags");
  const anchored = document.items.filter((item) => item.pool !== "natural_language" && item.pool !== "tags");
  if (anchored.length) {
    return normalizedResult("compose", prompt, document.items, []);
  }
  const natural = movable.filter((item) => item.pool === "natural_language");
  const tags = movable.filter((item) => item.pool === "tags");
  const ordered = layout === "nl_then_tags" ? [...natural, ...tags, ...anchored] : [...tags, ...natural, ...anchored];
  const changes: PromptChange[] = [];
  ordered.forEach((item, index) => {
    const previousIndex = document.items.indexOf(item);
    if (previousIndex !== index) changes.push({ kind: "moved", pool: item.pool, before: item.text, after: item.text, reason: `Applied ${layout} layout.`, fromIndex: previousIndex, toIndex: index });
  });
  const normalized = ordered.map((item, index) => ({ ...item, raw: item.text, separator: index === ordered.length - 1 ? "" : ", " }));
  return normalizedResult("compose", prompt, normalized, changes);
}

function repairSeparators(items: PromptDocumentItem[]): void {
  if (!items.length) return;
  for (let index = 0; index < items.length - 1; index += 1) {
    if (!items[index].separator) items[index] = { ...items[index], separator: ", " };
  }
  items[items.length - 1] = { ...items[items.length - 1], separator: "" };
}

export function runPromptToolkit(
  action: PromptToolkitAction,
  prompt: string,
  pool: PromptPool | "all" = "all",
  options: PromptToolkitOptions = {},
  signal?: AbortSignal,
): PromptToolkitResult {
  abortIfNeeded(signal);
  let result: PromptToolkitResult;
  if (action === "analyze" || action === "split_pools" || action === "validate") result = analyze(action, prompt);
  else if (action === "deduplicate") result = deduplicate(prompt, pool, options);
  else if (action === "sort") result = sort(prompt, pool, options);
  else if (action === "normalize") result = normalize(prompt, pool);
  else result = compose(prompt, pool, options);
  abortIfNeeded(signal);
  return result;
}

export function canonicalTagForDiff(value: string): string {
  return canonicalPromptTag(value);
}

export function roundTripPrompt(prompt: string): string {
  return composeHybridPrompt(parseHybridPrompt(prompt));
}
