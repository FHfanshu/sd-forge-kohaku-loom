<script lang="ts">
  import { NativeSelect } from "$lib/components/ui/native-select";
  import type { Profile } from "../../contracts";
  let { label, value, profiles, onchange }: { label: string; value: string; profiles: Profile[]; onchange(value: string): void } = $props();
</script>
<label class="pa-profile-route-card"><span><strong>{label}</strong></span><NativeSelect {value} onchange={(event) => onchange(event.currentTarget.value)}>{#each profiles as profile}<option value={profile.id}>{profile.displayName}</option>{/each}</NativeSelect></label>
