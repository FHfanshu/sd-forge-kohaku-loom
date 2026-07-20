import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

export default {
  prefix: "pa-",
  content: ["./src/**/*.{html,js,svelte,ts}"],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        border: "var(--pa-border)",
        input: "var(--pa-input)",
        ring: "var(--pa-ring)",
        background: "var(--pa-background)",
        foreground: "var(--pa-foreground)",
        primary: {
          DEFAULT: "var(--pa-primary)",
          foreground: "var(--pa-primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--pa-secondary)",
          foreground: "var(--pa-secondary-foreground)",
        },
        destructive: {
          DEFAULT: "var(--pa-destructive)",
          foreground: "var(--pa-destructive-foreground)",
        },
        muted: {
          DEFAULT: "var(--pa-muted)",
          foreground: "var(--pa-muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--pa-accent)",
          foreground: "var(--pa-accent-foreground)",
        },
        popover: {
          DEFAULT: "var(--pa-popover)",
          foreground: "var(--pa-popover-foreground)",
        },
      },
      borderRadius: {
        lg: "var(--pa-radius-lg)",
        md: "var(--pa-radius-md)",
        sm: "var(--pa-radius-sm)",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
