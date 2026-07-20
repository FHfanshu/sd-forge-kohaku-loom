import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/svelte";
import "fake-indexeddb/auto";

const testRect = new DOMRect(0, 0, 120, 32);
Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => testRect,
});
Object.defineProperty(HTMLElement.prototype, "getClientRects", {
  configurable: true,
  value: () => ({ 0: testRect, length: 1, item: (index: number) => index === 0 ? testRect : null }),
});
if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => undefined;

afterEach(() => {
  cleanup();
});
