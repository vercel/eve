import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/components/ui/select", () => ({
  Select: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
vi.mock("shiki", () => ({
  createHighlighter: async ({ langs }: { langs: string[] }) => ({
    getLoadedLanguages: () => langs,
    codeToTokens: (code: string, { lang }: { lang: string }) => ({
      tokens: [[{ content: code, color: lang }]],
    }),
  }),
}));

interface TokenizedCode {
  tokens: { content: string; color?: string }[][];
}

const { highlightCode } = await vi.importActual<{
  highlightCode: (
    code: string,
    language: "javascript" | "typescript",
    callback?: (result: TokenizedCode) => void,
  ) => TokenizedCode | null;
}>("../registry/channel/web/components/ai-elements/code-block");

function highlight(code: string, language: Parameters<typeof highlightCode>[1]) {
  return new Promise<TokenizedCode>((resolve) => {
    const cached = highlightCode(code, language, resolve);
    if (cached) resolve(cached);
  });
}

function text(result: TokenizedCode) {
  return result.tokens.map((line) => line.map((token) => token.content).join("")).join("\n");
}

describe("code block highlighting", () => {
  it("reuses tokens only for matching full code and language", async () => {
    const first = `${"// header\n".repeat(12)}const name = "Alice";${"\n// footer".repeat(12)}`;
    const second = first.replace("Alice", "Bobby");

    const firstTokens = await highlight(first, "javascript");
    const secondTokens = await highlight(second, "javascript");
    const otherLanguageTokens = await highlight(second, "typescript");

    expect(text(firstTokens)).toBe(first);
    expect(text(secondTokens)).toBe(second);
    expect(otherLanguageTokens.tokens[0]?.[0]?.color).toBe("typescript");
    expect(highlightCode(first, "javascript")).toBe(firstTokens);
    expect(highlightCode(second, "javascript")).toBe(secondTokens);
  });

  it("delivers each pending snippet to its own subscribers", async () => {
    const first = `${"// start\n".repeat(15)}const city = "Paris";${"\n// end".repeat(15)}`;
    const second = first.replace("Paris", "Tokyo");

    const [firstTokens, secondTokens, repeatedTokens] = await Promise.all([
      highlight(first, "javascript"),
      highlight(second, "javascript"),
      highlight(first, "javascript"),
    ]);

    expect(text(firstTokens)).toBe(first);
    expect(text(secondTokens)).toBe(second);
    expect(text(repeatedTokens)).toBe(first);
  });
});
