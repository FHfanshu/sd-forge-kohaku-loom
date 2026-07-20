<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";

  type Variant = "default" | "outline" | "secondary" | "ghost" | "destructive";
  type Size = "default" | "sm" | "icon";
  let { variant = "default", size = "default", class: className, type = "button", children, ...rest }: HTMLButtonAttributes & { variant?: Variant; size?: Size; children?: Snippet } = $props();
  const variants: Record<Variant, string> = {
    default: "pa-bg-primary pa-text-primary-foreground hover:pa-bg-accent",
    outline: "pa-border pa-border-border pa-bg-background hover:pa-bg-accent",
    secondary: "pa-bg-secondary pa-text-secondary-foreground hover:pa-bg-accent",
    ghost: "hover:pa-bg-accent hover:pa-text-accent-foreground",
    destructive: "pa-bg-destructive pa-text-destructive-foreground hover:pa-bg-accent",
  };
  const sizes: Record<Size, string> = { default: "pa-h-9 pa-px-3", sm: "pa-h-8 pa-px-2.5 pa-text-xs", icon: "pa-size-8" };
</script>

<button data-slot="button" {type} class={cn("pa-inline-flex pa-items-center pa-justify-center pa-gap-1.5 pa-rounded-md pa-text-sm pa-font-medium pa-transition-colors focus-visible:pa-outline-none focus-visible:pa-ring-2 focus-visible:pa-ring-ring disabled:pa-pointer-events-none disabled:pa-opacity-50 [&_svg]:pa-size-4", variants[variant], sizes[size], className)} {...rest}>{@render children?.()}</button>
