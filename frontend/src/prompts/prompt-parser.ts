import type {
  HybridPromptDocument,
  NaturalLanguageRole,
  PromptDiagnostic,
  PromptDocumentItem,
  PromptTagCategory,
  SpecialPromptToken,
} from "./prompt-types";

const MAX_PROMPT_LENGTH = 50_000;
const OPEN_TO_CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set(Object.values(OPEN_TO_CLOSE));

const CATEGORY_TERMS: Partial<Record<PromptTagCategory, readonly string[]>> = {
  identity: ["1girl", "1boy", "2girls", "2boys", "solo", "multiple girls", "multiple boys", "original"],
  composition: ["portrait", "upper body", "full body", "cowboy shot", "close-up", "wide shot", "centered", "from side"],
  camera: ["looking at viewer", "from above", "from below", "depth of field", "dutch angle", "fisheye"],
  pose: ["standing", "sitting", "kneeling", "lying", "leaning", "contrapposto"],
  action: ["walking", "running", "jumping", "holding", "reaching", "smiling", "crying"],
  appearance: ["long hair", "short hair", "blue eyes", "green eyes", "red eyes", "blonde hair", "black hair", "white hair"],
  clothing: ["dress", "shirt", "skirt", "jacket", "coat", "uniform", "gloves", "boots", "hat"],
  environment: ["indoors", "outdoors", "city", "street", "forest", "beach", "sky", "night", "rain"],
  lighting: ["cinematic lighting", "rim light", "backlighting", "soft lighting", "volumetric lighting", "neon lighting"],
  color: ["monochrome", "greyscale", "colorful", "pastel colors", "vivid colors"],
  style: ["anime", "photorealistic", "realistic", "oil painting", "watercolor", "sketch", "lineart"],
  quality: ["masterpiece", "best quality", "high quality", "low quality", "worst quality", "highres", "absurdres"],
};

const CATEGORY_LOOKUP = new Map<string, PromptTagCategory>();
for (const [category, terms] of Object.entries(CATEGORY_TERMS) as Array<[PromptTagCategory, readonly string[]]>) {
  for (const term of terms) CATEGORY_LOOKUP.set(term, category);
}

interface RawPart {
  raw: string;
  text: string;
  separator: string;
  start: number;
  end: number;
}

function splitTopLevel(source: string): { parts: RawPart[]; diagnostics: PromptDiagnostic[] } {
  const parts: RawPart[] = [];
  const diagnostics: PromptDiagnostic[] = [];
  const stack: string[] = [];
  let escaped = false;
  let angleDepth = 0;
  let start = 0;

  const push = (end: number, separator: string, separatorEnd: number) => {
    const raw = source.slice(start, end);
    parts.push({ raw, text: raw.trim(), separator, start, end });
    start = separatorEnd;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "<") {
      angleDepth += 1;
      continue;
    }
    if (character === ">" && angleDepth > 0) {
      angleDepth -= 1;
      continue;
    }
    if (OPEN_TO_CLOSE[character]) {
      stack.push(OPEN_TO_CLOSE[character]);
      continue;
    }
    if (CLOSE.has(character)) {
      if (stack.at(-1) === character) stack.pop();
      else diagnostics.push({ code: "unbalanced_delimiter", severity: "warning", message: `Unexpected closing delimiter ${character}.` });
      continue;
    }
    if (character === "," && stack.length === 0 && angleDepth === 0) {
      let separatorEnd = index + 1;
      while (separatorEnd < source.length && /[ \t]/.test(source[separatorEnd])) separatorEnd += 1;
      push(index, source.slice(index, separatorEnd), separatorEnd);
      index = separatorEnd - 1;
    }
  }
  push(source.length, "", source.length);
  if (stack.length || angleDepth) diagnostics.push({ code: "unbalanced_delimiter", severity: "warning", message: "Prompt contains an unclosed delimiter." });
  return { parts, diagnostics };
}

export function canonicalPromptTag(value: string): string {
  const weighted = unwrapSimpleWeight(value);
  return (weighted?.text ?? value)
    .trim()
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\s+/g, " ");
}

function unwrapSimpleWeight(value: string): { text: string; weight: number } | null {
  const match = value.trim().match(/^\(([^()[\]]+):([+-]?(?:\d+(?:\.\d+)?|\.\d+))\)$/);
  if (!match) return null;
  const weight = Number(match[2]);
  return Number.isFinite(weight) ? { text: match[1].trim(), weight } : null;
}

function specialType(text: string): SpecialPromptToken["specialType"] | null {
  if (/^BREAK$/i.test(text)) return "break";
  if (/^AND$/i.test(text)) return "and";
  if (/^<lora:[^>]+>$/i.test(text)) return "lora";
  if (/^(?:embedding:|<embedding:)[^>]+>?$/i.test(text)) return "embedding";
  if (/^__[^\n]+__$/.test(text)) return "wildcard";
  if (/^[\[{].+[\]}]$/.test(text)) return "weighted";
  return null;
}

function naturalLanguageRole(text: string): NaturalLanguageRole {
  const folded = text.toLowerCase();
  if (/\b(light|lighting|shadow|glow|illuminat|reflection)\w*\b/.test(folded)) return "lighting";
  if (/\b(atmosphere|mood|dream|dramatic|quiet|tense|serene)\w*\b/.test(folded)) return "atmosphere";
  if (/\b(camera|view|framing|composition|focus|shot)\w*\b/.test(folded)) return "composition";
  if (/\b(stand|sit|walk|run|hold|look|reach|turn)\w*\b/.test(folded)) return "action";
  if (/\b(street|forest|room|city|beach|background|scene)\w*\b/.test(folded)) return "scene";
  if (/\b(style|rendered|painted|illustrated|photograph)\w*\b/.test(folded)) return "style";
  return /^\s*(?:a|an|the|this|that|one|two|\d+)\b/i.test(text) ? "subject" : "other";
}

function looksNaturalLanguage(text: string): boolean {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  if (/[.!?。！？]\s*$/.test(text) || words.length >= 8) return true;
  if (words.length < 3) return false;
  return /^(?:a|an|the|this|that|these|those|she|he|they|we|you|it)\b/i.test(text)
    || /\b(?:is|are|was|were|stands?|sits?|walks?|looks?|wears?|beneath|beside|behind|through|while|with\s+(?:a|the))\b/i.test(text);
}

function coalesceNaturalLanguageParts(parts: RawPart[]): RawPart[] {
  const merged: RawPart[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    let current = { ...parts[index] };
    if (looksNaturalLanguage(current.text) && !/[.!?。！？]\s*$/.test(current.text)) {
      while (index + 1 < parts.length) {
        const next = parts[index + 1];
        if (!next.text || specialType(next.text) || !looksNaturalLanguage(next.text)) break;
        current = {
          raw: `${current.raw}${current.separator}${next.raw}`,
          text: `${current.raw}${current.separator}${next.raw}`.trim(),
          separator: next.separator,
          start: current.start,
          end: next.end,
        };
        index += 1;
        if (/[.!?。！？]\s*$/.test(current.text)) break;
      }
    }
    merged.push(current);
  }
  return merged;
}

function tagCategory(key: string): PromptTagCategory {
  const exact = CATEGORY_LOOKUP.get(key);
  if (exact) return exact;
  if (/\b(?:hair|eyes?|skin|face|body|ears?|tail|wings?)\b/.test(key)) return "appearance";
  if (/\b(?:dress|shirt|skirt|jacket|coat|uniform|gloves?|boots?|hat|clothes?)\b/.test(key)) return "clothing";
  if (/\b(?:light|lighting|shadow|glow|sunset|sunrise)\b/.test(key)) return "lighting";
  if (/\b(?:background|indoors|outdoors|street|forest|city|beach|room|sky)\b/.test(key)) return "environment";
  if (/\b(?:view|shot|angle|focus|portrait|body)\b/.test(key)) return "composition";
  if (/\b(?:standing|sitting|kneeling|lying|pose)\b/.test(key)) return "pose";
  if (/\b(?:holding|walking|running|jumping|looking|smiling|crying)\b/.test(key)) return "action";
  if (/\b(?:quality|masterpiece|highres|absurdres)\b/.test(key)) return "quality";
  return "other";
}

function classifyPart(part: RawPart, index: number, group: number): PromptDocumentItem {
  const id = `prompt-item-${index}`;
  const base = { id, raw: part.raw, text: part.text, separator: part.separator, sourceRange: [part.start, part.end] as [number, number], group };
  const special = specialType(part.text);
  if (special) return { ...base, pool: "special", specialType: special, confidence: 1 };
  const weighted = unwrapSimpleWeight(part.text);
  if (weighted) {
    const key = canonicalPromptTag(weighted.text);
    return { ...base, pool: "tags", text: part.text, canonicalKey: key, weight: weighted.weight, category: tagCategory(key), confidence: 0.95 };
  }
  if (looksNaturalLanguage(part.text)) {
    return { ...base, pool: "natural_language", role: naturalLanguageRole(part.text), enabled: true, confidence: 0.85 };
  }
  const key = canonicalPromptTag(part.text);
  const wordCount = key ? key.split(" ").length : 0;
  if (key && wordCount <= 6 && !/[.!?。！？;]/.test(part.text)) {
    return { ...base, pool: "tags", canonicalKey: key, category: tagCategory(key), confidence: CATEGORY_LOOKUP.has(key) ? 1 : 0.72 };
  }
  return { ...base, pool: "unknown", reason: part.text ? "The fragment could not be classified safely." : "Empty prompt fragment.", confidence: 0 };
}

export function parseHybridPrompt(source: string): HybridPromptDocument {
  if (typeof source !== "string") throw new TypeError("Prompt must be a string.");
  if (source.length > MAX_PROMPT_LENGTH) throw new RangeError(`Prompt exceeds ${MAX_PROMPT_LENGTH} characters.`);
  const parsed = splitTopLevel(source);
  const parts = coalesceNaturalLanguageParts(parsed.parts);
  const diagnostics = parsed.diagnostics;
  let group = 0;
  const items = parts.map((part, index) => {
    const item = classifyPart(part, index, group);
    if (item.pool === "special" && (item.specialType === "break" || item.specialType === "and")) group += 1;
    return item;
  });
  for (const item of items) {
    if (item.pool === "unknown") diagnostics.push({ code: "unknown_fragment", severity: "info", message: item.reason, itemId: item.id });
  }
  return {
    version: 1,
    source,
    items,
    pools: {
      naturalLanguage: items.filter((item) => item.pool === "natural_language"),
      tags: items.filter((item) => item.pool === "tags"),
      special: items.filter((item) => item.pool === "special"),
      unknown: items.filter((item) => item.pool === "unknown"),
    },
    diagnostics,
  };
}

export function composePromptItems(items: readonly PromptDocumentItem[]): string {
  return items.map((item) => `${item.raw}${item.separator}`).join("");
}

export function composeHybridPrompt(document: HybridPromptDocument): string {
  return composePromptItems(document.items);
}

export function clonePromptItem<T extends PromptDocumentItem>(item: T, text: string): T {
  return { ...item, text, raw: replaceTrimmedText(item.raw, text) };
}

function replaceTrimmedText(raw: string, text: string): string {
  const leading = raw.match(/^\s*/)?.[0] ?? "";
  const trailing = raw.match(/\s*$/)?.[0] ?? "";
  return `${leading}${text}${trailing}`;
}
