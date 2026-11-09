import { describe, expect, it } from "vitest";
import { transformAgentsMarkdown } from "./agents-transform";

const input = `# eve

## Documentation Surfaces

- Page-level Markdown: append .md or .mdx to a documentation URL

- [Full documentation context](https://eve.dev/llms.txt): All configured documentation as Markdown

- To create an agent, get it as Markdown from /llms.mdx/getting-started (or via /llms.txt).
`;

describe("transformAgentsMarkdown", () => {
  it("describes canonical HTML and route-specific Markdown accurately", () => {
    const output = transformAgentsMarkdown(input, { origin: "https://eve.dev" });

    expect(output).toContain("Canonical HTML pages use `/docs/...` and `/integrations/...`");
    expect(output).toContain("Docs and integration pages expose alternate Markdown");
    expect(output).not.toContain("Template pages are HTML discovery pages");
    expect(output).toContain("/docs/getting-started.md (or via /llms.txt)");
    expect(output).not.toContain("/llms.mdx/getting-started");
    expect(output).not.toContain("append .md or .mdx to a documentation URL");
    expect(output).toContain(
      "[Documentation index](https://eve.dev/llms.txt): Curated task-oriented map",
    );
    expect(output).toContain(
      "[Full documentation context](https://eve.dev/llms-full.txt): All configured documentation",
    );
    expect(output).not.toContain(
      "[Full documentation context](https://eve.dev/llms.txt): All configured documentation",
    );
  });

  it("directs template discovery to Vercel rather than retired local pages", () => {
    const output = transformAgentsMarkdown(input, {
      origin: "https://eve.dev",
    });

    expect(output).toContain(
      "- [eve templates](https://vercel.com/templates/eve): Browse example projects on Vercel.",
    );
  });

  it("fails loudly if the upstream generic guidance changes", () => {
    expect(() => transformAgentsMarkdown("# eve", { origin: "https://eve.dev" })).toThrow(
      "Geistdocs agents.md Markdown guidance changed",
    );
  });
});
