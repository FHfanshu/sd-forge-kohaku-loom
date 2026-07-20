# Frontend Foundation

This package contains the Svelte 5/TypeScript surface and headless contracts for the Forge Neo
SD Forge Neo Prompt Agent surface. `src/bootstrap.ts` publishes `UI_READY = true`, so
the Prompt Agent boot script mounts it after Forge reports that the UI is loaded.
There is no parallel legacy renderer; filename-ordered browser scripts only provide
the Forge host bridge and prompt/resource tools consumed by the Svelte runtime.

The component layer uses shadcn-svelte source components backed by Bits UI and
Tailwind CSS with the `pa-` prefix and Preflight disabled, so it remains isolated
from Forge's page styles.

The production build is an IIFE with CSS injected into generated Forge browser
asset `javascript/prompt_agent_90_ui.js`. The generated file is consumed by
Forge's filename-ordered browser loader and must never be edited by hand.
