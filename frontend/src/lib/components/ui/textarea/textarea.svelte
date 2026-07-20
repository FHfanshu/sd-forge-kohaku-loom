<script lang="ts">
  import type { HTMLTextareaAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";
  let { class: className, value = $bindable(), ...rest }: HTMLTextareaAttributes = $props();
</script>
  <textarea data-slot="textarea" bind:value class={cn("pa-flex pa-min-h-20 pa-w-full pa-rounded-md pa-border pa-border-input pa-bg-background pa-px-3 pa-py-2 pa-text-sm focus-visible:pa-outline-none focus-visible:pa-ring-2 focus-visible:pa-ring-ring disabled:pa-opacity-50", className)} {...rest}></textarea>
