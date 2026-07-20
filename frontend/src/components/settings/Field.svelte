<script lang="ts">
  import type { Snippet } from "svelte";
  let { label, wide = false, children }: { label: string; wide?: boolean; children: Snippet } = $props();
</script>
<label class:is-wide={wide} class="pa-profile-field"><span>{label}</span>{@render children()}</label>
