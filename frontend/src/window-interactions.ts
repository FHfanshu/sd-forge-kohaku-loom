import type { WindowLayout } from "./contracts";

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WindowMinimum {
  width: number;
  height: number;
}

export interface FloatingPosition {
  left: number;
  top: number;
}

export const WINDOW_MINIMUM: WindowMinimum = { width: 320, height: 360 };

export function readViewportRect(): ViewportRect {
  if (typeof window === "undefined") return { left: 0, top: 0, width: 1280, height: 800 };
  const viewport = window.visualViewport;
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

export function clampWindowLayout(
  layout: WindowLayout,
  viewport = readViewportRect(),
  minimum: WindowMinimum = WINDOW_MINIMUM,
): WindowLayout {
  const width = Math.max(minimum.width, Math.min(layout.width, Math.max(minimum.width, viewport.width - 16)));
  const height = Math.max(minimum.height, Math.min(layout.height, Math.max(minimum.height, viewport.height - 16)));
  const minLeft = viewport.left + 8;
  const minTop = viewport.top + 8;
  const maxLeft = Math.max(minLeft, viewport.left + viewport.width - width - 8);
  const maxTop = Math.max(minTop, viewport.top + viewport.height - height - 8);
  return {
    left: Math.max(minLeft, Math.min(layout.left, maxLeft)),
    top: Math.max(minTop, Math.min(layout.top, maxTop)),
    width,
    height,
  };
}

interface PointerPositionOptions {
  position?(): FloatingPosition | null;
  update(position: FloatingPosition): void;
  interacting?(active: boolean): void;
  moved?(moved: boolean): void;
}

export function pointerPosition(node: HTMLElement, options: PointerPositionOptions) {
  let current = options;
  let activePointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let moved = false;

  const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(value, maximum));

  const finish = (event: PointerEvent) => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    activePointerId = null;
    current.interacting?.(false);
    current.moved?.(moved);
    node.releasePointerCapture?.(event.pointerId);
  };

  const down = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rect = node.getBoundingClientRect();
    const stored = current.position?.();
    activePointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startLeft = stored?.left ?? rect.left;
    startTop = stored?.top ?? rect.top;
    moved = false;
    current.interacting?.(true);
    node.setPointerCapture?.(event.pointerId);
  };

  const move = (event: PointerEvent) => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    if (!moved && Math.hypot(deltaX, deltaY) < 4) return;
    moved = true;
    const viewport = readViewportRect();
    const maxLeft = Math.max(viewport.left + 8, viewport.left + viewport.width - node.offsetWidth - 8);
    const maxTop = Math.max(viewport.top + 8, viewport.top + viewport.height - node.offsetHeight - 8);
    current.update({
      left: clamp(startLeft + deltaX, viewport.left + 8, maxLeft),
      top: clamp(startTop + deltaY, viewport.top + 8, maxTop),
    });
    current.moved?.(true);
    event.preventDefault();
  };

  node.addEventListener("pointerdown", down);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", finish);
  node.addEventListener("pointercancel", finish);
  return {
    update(next: PointerPositionOptions) { current = next; },
    destroy() {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", finish);
      node.removeEventListener("pointercancel", finish);
    },
  };
}

interface PointerWindowOptions {
  mode: "drag" | "resize";
  layout(): WindowLayout;
  update(layout: WindowLayout): void;
  minimum?: WindowMinimum;
  disabled?: boolean;
  interacting?(active: boolean): void;
}

export function pointerWindow(node: HTMLElement, options: PointerWindowOptions) {
  let current = options;
  const down = (event: PointerEvent) => {
    if (current.disabled) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!node.hasAttribute("data-loom-interaction-handle") && event.target instanceof Element && event.target.closest("button, input, textarea, select, a")) return;
    event.preventDefault();
    const start = clampWindowLayout(current.layout(), readViewportRect(), current.minimum);
    const startX = event.clientX;
    const startY = event.clientY;
    current.interacting?.(true);
    node.setPointerCapture?.(event.pointerId);
    const move = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== event.pointerId) return;
      const x = nextEvent.clientX - startX;
      const y = nextEvent.clientY - startY;
      const next = current.mode === "drag"
        ? { ...start, left: start.left + x, top: start.top + y }
        : { ...start, width: start.width + x, height: start.height + y };
      current.update(clampWindowLayout(next, readViewportRect(), current.minimum));
    };
    const finish = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== event.pointerId) return;
      current.interacting?.(false);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
    };
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
  };
  node.addEventListener("pointerdown", down);
  return {
    update(options: PointerWindowOptions) { current = options; },
    destroy() { node.removeEventListener("pointerdown", down); },
  };
}

export type LayoutViewport = "desktop" | "mobilePortrait" | "mobileLandscape";

export function viewportKind(): LayoutViewport {
  if (typeof window === "undefined") return "desktop";
  const mobilePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  if (!mobilePointer && window.innerWidth >= 768) return "desktop";
  return window.innerWidth > window.innerHeight ? "mobileLandscape" : "mobilePortrait";
}
