<script lang="ts">
  import DOMPurify from "dompurify";
  import { marked } from "marked";
  import { onDestroy, tick } from "svelte";
  import { useI18nStore } from "../stores/i18n";

  let { content, streaming = false, renderStreamingMarkdown = false }: { content: string; streaming?: boolean; renderStreamingMarkdown?: boolean } = $props();
  let markdownElement = $state<HTMLDivElement>();
  const resetTimers = new Map<HTMLButtonElement, number>();
  const html = $derived(DOMPurify.sanitize(marked.parse(content || " ", { gfm: true }) as string));

  function t(key: string, fallback: string): string {
    const value = $useI18nStore.t(key);
    return value === key ? fallback : value;
  }

  function enhanceCodeBlocks(): void {
    if (!markdownElement) return;
    const copyLabel = t("chat.copy", "Copy");
    for (const pre of markdownElement.querySelectorAll("pre")) {
      const existing = pre.closest<HTMLElement>(".kl-code-block");
      if (existing) {
        const button = existing.querySelector<HTMLButtonElement>("[data-code-copy]");
        if (button && !resetTimers.has(button)) button.textContent = copyLabel;
        continue;
      }
      const wrapper = document.createElement("div");
      const button = document.createElement("button");
      wrapper.className = "kl-code-block";
      button.type = "button";
      button.className = "kl-code-copy";
      button.dataset.codeCopy = "";
      button.textContent = copyLabel;
      button.setAttribute("aria-label", copyLabel);
      button.addEventListener("click", () => void copyCodeBlock(button));
      pre.before(wrapper);
      wrapper.append(button, pre);
    }
  }

  async function writeClipboard(text: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {
      // Fall through for embedded browsers that expose but deny Clipboard API.
    }
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(fallback);
    fallback.select();
    const copied = document.execCommand("copy");
    fallback.remove();
    if (!copied) throw new Error("Clipboard is unavailable");
  }

  async function copyCodeBlock(button: HTMLButtonElement): Promise<void> {
    const code = button.closest(".kl-code-block")?.querySelector("code");
    if (!code) return;
    try {
      await writeClipboard(code.textContent ?? "");
      button.textContent = t("chat.copied", "Copied");
    } catch {
      button.textContent = t("chat.copy_failed", "Copy failed");
    }
    window.clearTimeout(resetTimers.get(button));
    resetTimers.set(button, window.setTimeout(() => {
      resetTimers.delete(button);
      if (button.isConnected) button.textContent = t("chat.copy", "Copy");
    }, 1200));
  }

  $effect(() => {
    html;
    $useI18nStore.locale;
    if (streaming || !markdownElement) return;
    void tick().then(enhanceCodeBlocks);
  });

  onDestroy(() => {
    for (const timer of resetTimers.values()) window.clearTimeout(timer);
    resetTimers.clear();
  });
</script>

{#if streaming && !renderStreamingMarkdown}
  <div class="kl-markdown kl-markdown-streaming">{content}</div>
{:else if streaming}
  <div class="kl-markdown kl-markdown-streaming">{@html html}</div>
{:else}
  <div bind:this={markdownElement} class="kl-markdown">{@html html}</div>
{/if}
