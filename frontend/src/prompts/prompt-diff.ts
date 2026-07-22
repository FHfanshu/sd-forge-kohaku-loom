import { canonicalTagForDiff } from "./prompt-operations";
import { parseHybridPrompt } from "./prompt-parser";
import type { PromptChange, PromptChangeSummary } from "./prompt-types";
import { summarizePromptChanges } from "./prompt-types";

export interface PromptDiffResult {
  changes: PromptChange[];
  summary: PromptChangeSummary;
  truncated: boolean;
}

const MAX_DIFF_CHANGES = 200;

export function diffPromptText(before: string, after: string): PromptDiffResult {
  if (before === after) return { changes: [], summary: summarizePromptChanges([]), truncated: false };
  const previous = parseHybridPrompt(before);
  const next = parseHybridPrompt(after);
  const changes: PromptChange[] = [];

  const beforeTags = previous.pools.tags.map((tag, index) => ({ tag, index, key: `${tag.group}:${canonicalTagForDiff(tag.text)}` }));
  const afterTags = next.pools.tags.map((tag, index) => ({ tag, index, key: `${tag.group}:${canonicalTagForDiff(tag.text)}` }));
  const usedAfter = new Set<number>();
  for (const old of beforeTags) {
    const matchIndex = afterTags.findIndex((candidate, index) => !usedAfter.has(index) && candidate.key === old.key);
    if (matchIndex < 0) {
      changes.push({ kind: "removed", pool: "tags", before: old.tag.text, reason: "Removed from the prompt." });
      continue;
    }
    usedAfter.add(matchIndex);
    const current = afterTags[matchIndex];
    if (old.tag.text !== current.tag.text) changes.push({ kind: "normalized", pool: "tags", before: old.tag.text, after: current.tag.text, reason: "Changed tag formatting or weight." });
    if (old.index !== current.index) changes.push({ kind: "moved", pool: "tags", before: old.tag.text, after: current.tag.text, reason: "Moved within the tag pool.", fromIndex: old.index, toIndex: current.index });
  }
  afterTags.forEach((current, index) => {
    if (!usedAfter.has(index)) changes.push({ kind: "added", pool: "tags", after: current.tag.text, reason: "Added to the prompt." });
  });

  diffTextPool(previous.pools.naturalLanguage.map((item) => item.text), next.pools.naturalLanguage.map((item) => item.text), "natural_language", changes);
  diffTextPool(previous.pools.special.map((item) => item.text), next.pools.special.map((item) => item.text), "special", changes);
  diffTextPool(previous.pools.unknown.map((item) => item.text), next.pools.unknown.map((item) => item.text), "unknown", changes);

  if (!changes.length) {
    changes.push({ kind: "normalized", pool: "unknown", before, after, reason: "Prompt formatting changed." });
  }
  const truncated = changes.length > MAX_DIFF_CHANGES;
  const visible = changes.slice(0, MAX_DIFF_CHANGES);
  return { changes: visible, summary: summarizePromptChanges(visible, next.pools.unknown.length), truncated };
}

function diffTextPool(
  before: string[],
  after: string[],
  pool: "natural_language" | "special" | "unknown",
  changes: PromptChange[],
): void {
  const remaining = [...after];
  for (const value of before) {
    const index = remaining.indexOf(value);
    if (index >= 0) remaining.splice(index, 1);
    else changes.push({ kind: "removed", pool, before: value, reason: `Removed from the ${pool.replace("_", " ")} pool.` });
  }
  for (const value of remaining) changes.push({ kind: "added", pool, after: value, reason: `Added to the ${pool.replace("_", " ")} pool.` });
}
