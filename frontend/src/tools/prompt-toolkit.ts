import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { runPromptToolkit } from "../prompts/prompt-operations";

export const PROMPT_TOOLKIT_SCHEMA = Type.Object({
  action: Type.Union([
    Type.Literal("analyze"),
    Type.Literal("split_pools"),
    Type.Literal("deduplicate"),
    Type.Literal("sort"),
    Type.Literal("normalize"),
    Type.Literal("validate"),
    Type.Literal("compose"),
  ]),
  prompt: Type.String({ maxLength: 50_000 }),
  pool: Type.Optional(Type.Union([
    Type.Literal("natural_language"),
    Type.Literal("tags"),
    Type.Literal("special"),
    Type.Literal("unknown"),
    Type.Literal("all"),
  ])),
  options: Type.Optional(Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal("safe"), Type.Literal("stable")])),
    preferred_layout: Type.Optional(Type.Union([Type.Literal("nl_then_tags"), Type.Literal("tags_then_nl"), Type.Literal("preserve")])),
    prompt_field: Type.Optional(Type.Union([Type.Literal("positive"), Type.Literal("negative")])),
    preserve_groups: Type.Optional(Type.Boolean()),
    weight_policy: Type.Optional(Type.Union([Type.Literal("highest"), Type.Literal("first")])),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

type PromptToolkitParameters = Static<typeof PROMPT_TOOLKIT_SCHEMA>;

function textResult(details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

export function createPromptToolkitTool(): AgentTool<typeof PROMPT_TOOLKIT_SCHEMA, unknown> & { permission: "read" } {
  return {
    name: "prompt_toolkit",
    label: "Prompt toolkit",
    description: "Analyze or safely transform hybrid prompts that may contain both natural-language blocks and Danbooru-style tags. Use deduplicate/sort/normalize to produce recommended_patch, then pass that exact patch to edit_prompt with the latest base_hash. The toolkit never writes Forge state.",
    parameters: PROMPT_TOOLKIT_SCHEMA,
    permission: "read",
    executionMode: "sequential",
    execute: async (_toolCallId, params: PromptToolkitParameters, signal) => {
      const options = params.options;
      const result = runPromptToolkit(params.action, params.prompt, params.pool ?? "all", {
        mode: options?.mode,
        preferredLayout: options?.preferred_layout,
        promptField: options?.prompt_field,
        preserveGroups: options?.preserve_groups,
        weightPolicy: options?.weight_policy,
      }, signal);
      return textResult(result);
    },
  };
}
