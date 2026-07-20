import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import { getHostApi, promptAgentNamespace, type PromptAgentHostApi } from "../bridge";

const targetSchema = Type.Optional(Type.Union([
  Type.Literal("active"),
  Type.Literal("txt2img"),
  Type.Literal("img2img"),
]));
const promptFieldSchema = Type.Union([
  Type.Literal("positive"),
  Type.Literal("negative"),
]);

const patchSchema = Type.Object({
  operation: Type.Optional(Type.Union([
    Type.Literal("append"),
    Type.Literal("prepend"),
    Type.Literal("replace"),
    Type.Literal("replace_all"),
    Type.Literal("replace_n"),
    Type.Literal("delete"),
    Type.Literal("insert_after"),
    Type.Literal("insert_before"),
  ])),
  find: Type.Optional(Type.String({ maxLength: 20_000 })),
  replace: Type.Optional(Type.String({ maxLength: 20_000 })),
  text: Type.Optional(Type.String({ maxLength: 20_000 })),
  replacement: Type.Optional(Type.String({ maxLength: 20_000 })),
  separator: Type.Optional(Type.String({ maxLength: 32 })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  allow_multiple: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const promptEditSchema = Type.Object({
  target: targetSchema,
  field: promptFieldSchema,
  base_hash: Type.String({ minLength: 1, maxLength: 128 }),
  prompt: Type.Optional(Type.String({ maxLength: 50_000 })),
  diff: Type.Optional(Type.String({ maxLength: 50_000 })),
  patches: Type.Optional(Type.Array(patchSchema, { maxItems: 32 })),
  return_prompt: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const resourceKindSchema = Type.Union([
  Type.Literal("wildcard"),
  Type.Literal("style"),
  Type.Literal("lora"),
  Type.Literal("model"),
  Type.Literal("embedding"),
]);

const resourceListSchema = Type.Object({
  kind: resourceKindSchema,
  query: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  cursor: Type.Optional(Type.String({ maxLength: 256 })),
}, { additionalProperties: false });

const resourceMetadataSchema = Type.Object({
  kind: resourceKindSchema,
  id: Type.String({ minLength: 1, maxLength: 512 }),
  query: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ maxLength: 256 })),
}, { additionalProperties: false });

const danbooruSearchSchema = Type.Object({
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  queries: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 12 })),
  category: Type.Optional(Type.String({ maxLength: 32 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
}, { additionalProperties: false });

const danbooruInspectBatchSchema = Type.Object({
  names: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 12 }),
  include_wiki: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const danbooruRelatedSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 160 }),
  category: Type.Optional(Type.String({ maxLength: 32 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
}, { additionalProperties: false });

const generationParameterSchema = Type.Object({
  steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 150 })),
  sampler_name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  scheduler: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  cfg_scale: Type.Optional(Type.Number({ minimum: 0, maximum: 50 })),
  seed: Type.Optional(Type.Integer({ minimum: -1, maximum: 2_147_483_647 })),
  width: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })),
  height: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })),
  denoising_strength: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  batch_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
  batch_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
  enable_hr: Type.Optional(Type.Boolean()),
  hr_scale: Type.Optional(Type.Number({ minimum: 1, maximum: 4 })),
  hr_upscaler: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
}, { additionalProperties: false });

const readGenerationSchema = Type.Object({
  target: targetSchema,
}, { additionalProperties: false });

const applyGenerationSchema = Type.Object({
  target: targetSchema,
  context_hash: Type.String({ minLength: 1, maxLength: 128 }),
  parameters: generationParameterSchema,
}, { additionalProperties: false });

export const FORGE_TOOL_SCHEMAS = {
  read_prompt: Type.Object({ target: targetSchema, field: promptFieldSchema }, { additionalProperties: false }),
  edit_prompt: promptEditSchema,
  read_generation_parameters: readGenerationSchema,
  apply_generation_parameters: applyGenerationSchema,
  search_resources: resourceListSchema,
  inspect_resource: resourceMetadataSchema,
  search_danbooru_tags: danbooruSearchSchema,
  inspect_danbooru_tags: danbooruInspectBatchSchema,
  related_danbooru_tags: danbooruRelatedSchema,
} as const;

export type ForgeToolName = keyof typeof FORGE_TOOL_SCHEMAS;
export type ForgeToolPermission = "read" | "write";

export interface ForgeToolErrorDetails {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
  result?: unknown;
}

export class ForgeToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: ForgeToolErrorDetails;

  constructor(code: string, message: string, retryable = false, result?: unknown) {
    super(message);
    this.name = "ForgeToolError";
    this.code = code;
    this.retryable = retryable;
    this.details = {
      ok: false,
      error: { code, message, retryable },
      ...(result === undefined ? {} : { result }),
    };
  }
}

export interface ForgeToolFactoryOptions {
  host?: () => PromptAgentHostApi | null;
  timeoutMs?: number;
  allowWrites?: () => boolean;
}

export interface ForgeAgentTool<TSchemaValue extends TSchema = TSchema> extends AgentTool<TSchemaValue, unknown> {
  readonly permission: ForgeToolPermission;
}

const TOOL_TIMEOUTS: Record<ForgeToolName, number> = {
  read_prompt: 10_000,
  edit_prompt: 15_000,
  read_generation_parameters: 10_000,
  apply_generation_parameters: 15_000,
  search_resources: 15_000,
  inspect_resource: 15_000,
  search_danbooru_tags: 30_000,
  inspect_danbooru_tags: 30_000,
  related_danbooru_tags: 20_000,
};

const WRITE_TOOLS = new Set<ForgeToolName>([
  "edit_prompt",
  "apply_generation_parameters",
]);

const defaultHost = (): PromptAgentHostApi | null => (
  typeof window === "undefined" ? null : getHostApi(promptAgentNamespace(window))
);

function abortException(): DOMException {
  return new DOMException("The Forge tool request was cancelled.", "AbortError");
}

function resultMessage(result: unknown): string {
  if (!result || typeof result !== "object") return "Forge returned an invalid tool response.";
  const value = result as Record<string, unknown>;
  const error = value.error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") {
    return String((error as Record<string, unknown>).message);
  }
  return "The Forge tool request failed.";
}

function isFailedResult(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as Record<string, unknown>).ok === false);
}

async function invokeForgeTool(
  name: ForgeToolName,
  args: Record<string, unknown>,
  permission: ForgeToolPermission,
  signal: AbortSignal | undefined,
  options: ForgeToolFactoryOptions,
): Promise<unknown> {
  if (signal?.aborted) throw abortException();
  const host = (options.host ?? defaultHost)();
  if (!host || !host.isForgeAvailable()) {
    throw new ForgeToolError("forge_unavailable", "Forge is not ready, so this tool cannot run.", true);
  }
  if (permission === "write" && options.allowWrites && !options.allowWrites()) {
    throw new ForgeToolError("permission_denied", "This Forge change requires write permission.", false);
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeoutMs = Math.max(1_000, Math.min(60_000, options.timeoutMs ?? TOOL_TIMEOUTS[name]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const operation = Promise.resolve().then(() => host.executeAssistantTool({ tool: name, arguments: args }, controller.signal));
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ForgeToolError("forge_tool_timeout", `Forge tool "${name}" timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`, true));
    }, timeoutMs);
  });
  const aborted = new Promise<never>((_, reject) => {
    if (signal?.aborted) {
      controller.abort();
      reject(abortException());
      return;
    }
    signal?.addEventListener("abort", () => {
      controller.abort();
      reject(abortException());
    }, { once: true });
  });
  try {
    const result = await Promise.race([operation, timeout, aborted]);
    if (isFailedResult(result)) throw new ForgeToolError("forge_tool_failed", resultMessage(result), false, result);
    if (result === undefined) throw new ForgeToolError("invalid_forge_response", "Forge returned no result for this tool.", true);
    return result;
  } catch (error) {
    if (timedOut || error instanceof ForgeToolError || error instanceof DOMException) throw error;
    if (signal?.aborted) throw abortException();
    throw new ForgeToolError("forge_tool_failed", error instanceof Error ? error.message : "The Forge tool failed.", true, error);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

function textResult(result: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    details: result,
  };
}

function createForgeTool<T extends TSchema>(
  name: ForgeToolName,
  label: string,
  description: string,
  parameters: T,
  permission: ForgeToolPermission,
  options: ForgeToolFactoryOptions,
  prepareArguments?: (args: Static<T>) => Record<string, unknown>,
): ForgeAgentTool<T> {
  return {
    name,
    label,
    description,
    parameters,
    permission,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const args = prepareArguments ? prepareArguments(params) : params as Record<string, unknown>;
      const result = await invokeForgeTool(name, args, permission, signal, options);
      return textResult(result);
    },
  };
}

export function createForgeAgentTools(options: ForgeToolFactoryOptions = {}): ForgeAgentTool[] {
  return [
    createForgeTool("read_prompt", "Read prompt", "Read the current Forge positive or negative prompt and its latest hash. Set field to positive or negative.", FORGE_TOOL_SCHEMAS.read_prompt, "read", options),
    createForgeTool(
      "edit_prompt",
      "Edit prompt",
      "Edit the positive or negative prompt after read_prompt. Use patches/diff when non-empty; full prompt overwrite only when empty.",
      FORGE_TOOL_SCHEMAS.edit_prompt,
      "write",
      options,
    ),
    createForgeTool("read_generation_parameters", "Read generation parameters", "Read the visible allowlisted Forge generation controls and context hash.", FORGE_TOOL_SCHEMAS.read_generation_parameters, "read", options),
    createForgeTool("apply_generation_parameters", "Apply generation parameters", "Apply visible allowlisted Forge generation controls with a fresh context hash.", FORGE_TOOL_SCHEMAS.apply_generation_parameters, "write", options),
    createForgeTool("search_resources", "Search Forge resources", "Search styles, wildcards, LoRAs, checkpoints, or embeddings by logical ID.", FORGE_TOOL_SCHEMAS.search_resources, "read", options),
    createForgeTool("inspect_resource", "Inspect Forge resource", "Inspect one logical Forge resource without exposing filesystem paths.", FORGE_TOOL_SCHEMAS.inspect_resource, "read", options),
    createForgeTool("search_danbooru_tags", "Search Danbooru tags", "Search live Danbooru tag candidates for one or more short visual concepts.", FORGE_TOOL_SCHEMAS.search_danbooru_tags, "read", options),
    createForgeTool("inspect_danbooru_tags", "Inspect Danbooru tags", "Inspect up to 12 selected Danbooru tags in parallel.", FORGE_TOOL_SCHEMAS.inspect_danbooru_tags, "read", options),
    createForgeTool("related_danbooru_tags", "Related Danbooru tags", "Expand one verified Danbooru seed with related tag candidates.", FORGE_TOOL_SCHEMAS.related_danbooru_tags, "read", options),
  ];
}

export function forgeToolPermission(name: string): ForgeToolPermission | null {
  return name in FORGE_TOOL_SCHEMAS ? (WRITE_TOOLS.has(name as ForgeToolName) ? "write" : "read") : null;
}
