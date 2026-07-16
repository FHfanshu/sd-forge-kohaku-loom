# Frontend Foundation

This package contains the Svelte 5/TypeScript surface and headless contracts for the Forge Neo
Kohaku Loom surface. `src/bootstrap.ts` publishes `UI_READY = true`, so
`javascript/kohaku_loom_99_boot.js` mounts it after Forge reports that the UI is loaded.
There is no parallel legacy renderer; filename-ordered browser scripts only provide
the Forge host bridge and prompt/resource tools consumed by the Svelte runtime.

The component layer uses shadcn-svelte source components backed by Bits UI and
Tailwind CSS with the `kl-` prefix and Preflight disabled, so it remains isolated
from Forge's page styles.

The production build is an IIFE with CSS injected into the bundle at
`../javascript/kohaku_loom_90_ui.js`. The generated file is consumed by Forge's
filename-ordered browser loader and must never be edited by hand.
