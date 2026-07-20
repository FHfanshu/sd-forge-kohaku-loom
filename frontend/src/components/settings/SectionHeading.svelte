<script lang="ts">
  let { title, hint }: { title: string; hint: string } = $props();
</script>
<div class="pa-profile-section-heading"><h3>{title}</h3><p>{hint}</p></div>
