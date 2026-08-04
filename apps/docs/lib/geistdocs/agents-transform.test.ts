import { describe, expect, it } from "vitest";
import { transformAgentsMarkdown } from "./agents-transform";

const input = `# eve

## Documentation Surfaces

- Page-level Markdown: append .md or .mdx to a documentation URL

- To create an agent, get it as Markdown from /llms.mdx/getting-started (or via /llms.txt).
`;

describe("transformAgentsMarkdown", () => {
  it("describes canonical HTML and route-specific Markdown accurately", () => {
    const output = transformAgentsMarkdown(input, { origin: "https://eve.dev", templates: [] });

    expect(output).toContain(
      "Canonical HTML pages use `/docs/...`, `/integrations/...`, and `/templates/...`",
    );
    expect(output).toContain("Docs and integration pages expose alternate Markdown");
    expect(output).toContain("Template pages are HTML discovery pages");
    expect(output).toContain("/docs/getting-started.md (or via /llms.txt)");
    expect(output).not.toContain("/llms.mdx/getting-started");
    expect(output).not.toContain("append .md or .mdx to a documentation URL");
  });

  it("adds concise canonical template discovery entries", () => {
    const output = transformAgentsMarkdown(input, {
      origin: "https://eve.dev",
      templates: [{ slug: "chat", title: "Chat", description: "A persisted chat agent." }],
    });

    expect(output).toContain(
      "- [Chat template](https://eve.dev/templates/chat): A persisted chat agent.",
    );
  });

  it("fails loudly if the upstream generic guidance changes", () => {
    expect(() =>
      transformAgentsMarkdown("# eve", { origin: "https://eve.dev", templates: [] }),
    ).toThrow("Geistdocs agents.md Markdown guidance changed");
  });
});
