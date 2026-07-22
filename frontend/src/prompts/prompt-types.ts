export type PromptPool = "natural_language" | "tags" | "special" | "unknown";

export type PromptTagCategory =
  | "identity"
  | "subject"
  | "composition"
  | "camera"
  | "pose"
  | "action"
  | "appearance"
  | "clothing"
  | "environment"
  | "lighting"
  | "color"
  | "style"
  | "quality"
  | "other";

export type NaturalLanguageRole =
  | "subject"
  | "scene"
  | "action"
  | "composition"
  | "lighting"
  | "atmosphere"
  | "style"
  | "other";

export interface PromptSourceItem {
  id: string;
  text: string;
  raw: string;
  sourceRange: [number, number];
  confidence: number;
  group: number;
  separator: string;
}

export interface NaturalLanguageBlock extends PromptSourceItem {
  pool: "natural_language";
  role: NaturalLanguageRole;
  enabled: boolean;
}

export interface PromptTag extends PromptSourceItem {
  pool: "tags";
  canonicalKey: string;
  weight?: number;
  category: PromptTagCategory;
}

export interface SpecialPromptToken extends PromptSourceItem {
  pool: "special";
  specialType: "lora" | "embedding" | "wildcard" | "break" | "and" | "weighted" | "syntax";
}

export interface UnknownPromptFragment extends PromptSourceItem {
  pool: "unknown";
  reason: string;
}

export type PromptDocumentItem = NaturalLanguageBlock | PromptTag | SpecialPromptToken | UnknownPromptFragment;

export interface PromptDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  itemId?: string;
}

export interface HybridPromptDocument {
  version: 1;
  source: string;
  items: PromptDocumentItem[];
  pools: {
    naturalLanguage: NaturalLanguageBlock[];
    tags: PromptTag[];
    special: SpecialPromptToken[];
    unknown: UnknownPromptFragment[];
  };
  diagnostics: PromptDiagnostic[];
}

export type PromptChangeKind = "added" | "removed" | "moved" | "normalized";

export interface PromptChange {
  kind: PromptChangeKind;
  pool: PromptPool;
  before?: string;
  after?: string;
  reason: string;
  fromIndex?: number;
  toIndex?: number;
}

export interface PromptChangeSummary {
  added: number;
  removed: number;
  moved: number;
  normalized: number;
  preservedUnknown: number;
}

export interface PromptToolkitOptions {
  mode?: "safe" | "stable";
  preferredLayout?: "nl_then_tags" | "tags_then_nl" | "preserve";
  promptField?: "positive" | "negative";
  preserveGroups?: boolean;
  weightPolicy?: "highest" | "first";
}

export type PromptToolkitAction =
  | "analyze"
  | "split_pools"
  | "deduplicate"
  | "sort"
  | "normalize"
  | "validate"
  | "compose";

export interface PromptToolkitResult {
  ok: true;
  action: PromptToolkitAction;
  document: HybridPromptDocument;
  output: string;
  changed: boolean;
  changes: PromptChange[];
  diagnostics: PromptDiagnostic[];
  summary: PromptChangeSummary;
  recommended_patch?: {
    operation: "replace";
    find: string;
    replace: string;
    allow_multiple: false;
  };
}

export interface PromptMutationEvidence {
  version: 1;
  target: "active" | "txt2img" | "img2img";
  field: "positive" | "negative";
  beforeHash: string;
  afterHash: string;
  fieldEnabled: boolean | null;
  effective: boolean | null;
  inactiveReason?: string;
  changes: PromptChange[];
  summary: PromptChangeSummary;
  truncated?: boolean;
  undone?: boolean;
}

export const emptyPromptChangeSummary = (preservedUnknown = 0): PromptChangeSummary => ({
  added: 0,
  removed: 0,
  moved: 0,
  normalized: 0,
  preservedUnknown,
});

export function summarizePromptChanges(changes: PromptChange[], preservedUnknown = 0): PromptChangeSummary {
  const summary = emptyPromptChangeSummary(preservedUnknown);
  for (const change of changes) summary[change.kind] += 1;
  return summary;
}
