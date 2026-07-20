<script lang="ts">
  import { onMount } from "svelte";
  import { useI18nStore } from "../stores/i18n";
  import Surface from "./Surface.svelte";

  onMount(() => { void useI18nStore.getState().preload(); });
</script>

<section id="prompt-agent-svelte-ui">
  <Surface />
</section>
