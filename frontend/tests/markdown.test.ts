import { readFileSync } from "node:fs";
import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Markdown from "../src/components/Markdown.svelte";

describe("Markdown code blocks", () => {
  it("provides a direct copy action and touch text selection", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { container } = render(Markdown, { content: "```text\nalpha, beta\n```" });

    const copy = await screen.findByRole("button", { name: "Copy" });
    expect(container.querySelector(".pa-code-block > pre > code")).toHaveTextContent("alpha, beta");
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith("alpha, beta\n");
    expect(copy).toHaveTextContent("Copied");

    const css = readFileSync("src/styles.css", "utf-8");
    expect(css).toMatch(/\.pa-markdown pre \{[^}]*-webkit-user-select: text; user-select: text;[^}]*touch-action: pan-x pan-y;/);
    await waitFor(() => expect(container.querySelector(".pa-code-copy")).not.toBeNull());
  });

  it("falls back when an embedded browser denies the Clipboard API", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    render(Markdown, { content: "```text\nfallback copy\n```" });

    await user.click(await screen.findByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(screen.getByRole("button", { name: "Copy" })).toHaveTextContent("Copied");
  });

  it("renders streaming Markdown only when explicitly requested", () => {
    const { container } = render(Markdown, { content: "**thinking**", streaming: true, renderStreamingMarkdown: true });
    expect(container.querySelector("strong")).toHaveTextContent("thinking");
  });
});
