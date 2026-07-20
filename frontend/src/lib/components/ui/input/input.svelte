<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";
  let { class: className, value = $bindable(), ...rest }: HTMLInputAttributes = $props();
</script>
  <input data-slot="input" bind:value class={cn("pa-flex pa-h-9 pa-w-full pa-rounded-md pa-border pa-border-input pa-bg-background pa-px-3 pa-text-sm focus-visible:pa-outline-none focus-visible:pa-ring-2 focus-visible:pa-ring-ring disabled:pa-opacity-50", className)} {...rest} />
