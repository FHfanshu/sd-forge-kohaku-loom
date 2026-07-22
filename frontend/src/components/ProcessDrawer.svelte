<script lang="ts">
  import { ChevronRight } from "lucide-svelte";
  import type { ChatMessage } from "../contracts";
  import { useI18nStore } from "../stores/i18n";
  import Markdown from "./Markdown.svelte";
  import PromptChangeCard from "./PromptChangeCard.svelte";
  import ToolCard from "./ToolCard.svelte";

  let {
    finalMessage,
    intermediateMessages = [],
    tools = [],
    onundo,
  }: {
    finalMessage: ChatMessage;
    intermediateMessages?: ChatMessage[];
    tools?: ChatMessage[];
    onundo?: (message: ChatMessage) => void | Promise<void>;
  } = $props();

  function t(key: string, fallback: string): string {
    const value = $useI18nStore.t(key);
    return value === key ? fallback : value;
  }

  function tf(key: string, fallback: string, values: Record<string, string | number>): string {
    return Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      t(key, fallback),
    );
  }

  const assistantMessages = $derived([...intermediateMessages, finalMessage]);
  const reasoningMessages = $derived(assistantMessages.filter((message) => Boolean(message.reasoning)));
  const visibleIntermediateMessages = $derived(intermediateMessages.filter((message) => Boolean(message.content.trim())));
  const mutationTools = $derived(tools.filter((message) => Boolean(message.tool?.mutation)));
  const processTools = $derived(tools);
  const failedTools = $derived(processTools.filter((message) => message.tool?.status === "error").length);
  const turnFailed = $derived(finalMessage.status === "error");
  const usage = $derived.by(() => assistantMessages.reduce(
    (total, message) => ({
      input: total.input + (message.usage?.inputTokens ?? 0),
      output: total.output + (message.usage?.outputTokens ?? 0),
    }),
    { input: 0, output: 0 },
  ));
  const hasProcess = $derived(Boolean(processTools.length || reasoningMessages.length || visibleIntermediateMessages.length));
  const summary = $derived.by(() => {
    const parts = [t("chat.process", "Process")];
    if (processTools.length) parts.push(tf("chat.process_tools", "{count} tools", { count: processTools.length }));
    if (failedTools) parts.push(tf("chat.process_failed", "{count} failed", { count: failedTools }));
    if (turnFailed) parts.push(t("chat.process_turn_failed", "Execution failed"));
    if (!processTools.length && reasoningMessages.length) parts.push(t("chat.process_reasoning", "reasoning"));
    return parts.join(" · ");
  });
</script>

{#each mutationTools as tool (tool.id)}
  {#if tool.tool?.mutation}<PromptChangeCard evidence={tool.tool.mutation} />{/if}
{/each}

{#if hasProcess}
  <details class:pa-process-error={turnFailed} class="pa-process-drawer" data-prompt-agent-process="true">
    <summary>
      <span class="pa-process-title"><ChevronRight size={13} aria-hidden="true" /><strong>{summary}</strong></span>
      {#if usage.input || usage.output}<span class="pa-process-usage">{usage.input} in · {usage.output} out</span>{/if}
    </summary>
    <div class="pa-process-content">
      {#each visibleIntermediateMessages as message (message.id)}
        <section class="pa-process-intermediate">
          <span>{t("chat.process_intermediate", "Intermediate response")}</span>
          <Markdown content={message.content} streaming={message.status === "streaming"} />
        </section>
      {/each}
      {#each reasoningMessages as message (message.id)}
        <details class="pa-process-reasoning">
          <summary>{t("chat.reasoning_trace", "Reasoning trace")}</summary>
          <Markdown content={message.reasoning ?? ""} streaming={message.status === "streaming"} renderStreamingMarkdown={true} />
        </details>
      {/each}
      {#each processTools as tool (tool.id)}
        <ToolCard message={tool} onundo={onundo} />
      {/each}
    </div>
  </details>
{/if}
