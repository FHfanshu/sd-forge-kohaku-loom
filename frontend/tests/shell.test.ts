import { afterEach, describe, expect, it } from "vitest";
import { mountSvelteUi, unmountSvelteUi, UI_READY } from "../src/bootstrap";

describe("Svelte cutover shell", () => {
  afterEach(async () => {
    await unmountSvelteUi();
  });

  it("publishes and mounts the released atomic cutover UI once", () => {
    expect(UI_READY).toBe(true);
    expect(mountSvelteUi()).not.toBeNull();
    expect(mountSvelteUi()).not.toBeNull();
    expect(document.querySelectorAll("#prompt-agent-svelte-mount")).toHaveLength(1);
    expect(document.querySelector('[data-prompt-agent-surface="true"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Open Prompt Agent"]')).not.toBeNull();
  });
});
