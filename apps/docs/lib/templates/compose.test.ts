import { describe, expect, it } from "vitest";

import { composeTemplateEntries, type GeneratedTemplatesInput } from "./compose";
import type { TemplateManifestEntry } from "./manifest";

const manifestEntry: TemplateManifestEntry = {
  slug: "example",
  title: "Example agent template",
  description: "An example template.",
  demoHref: "https://example.vercel.app",
  category: "Example",
  integrations: ["HTTP API"],
  model: "anthropic/claude-sonnet-5",
  source: "GitHub",
  sourceHref: "https://github.com/vercel-labs/example/tree/main",
  setupPrompt: "Set up the example template.",
  github: { owner: "vercel-labs", repo: "example", ref: "main" },
  files: ["agent/agent.ts"],
};

const generated: GeneratedTemplatesInput = {
  templates: {
    example: {
      readme: "# Example\n\nAn example template.\n",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      files: [
        {
          contents: "export default {};\n",
          language: "typescript",
          relativePath: "agent/agent.ts",
        },
      ],
    },
  },
};

describe("composeTemplateEntries", () => {
  it("merges curated metadata with generated files and revision", () => {
    const [entry] = composeTemplateEntries([manifestEntry], generated);

    expect(entry.slug).toBe("example");
    expect(entry.title).toBe("Example agent template");
    expect(entry.demoHref).toBe("https://example.vercel.app");
    expect(entry.sourceRevision).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(entry.sourceRevisionHref).toBe(
      "https://github.com/vercel-labs/example/tree/0123456789abcdef0123456789abcdef01234567",
    );
    expect(entry.githubOwner).toBe("vercel-labs");
    expect(entry.githubRepo).toBe("example");
    expect(entry.readme).toBe(generated.templates.example.readme);
    expect(entry.files).toEqual(generated.templates.example.files);
    expect(entry).not.toHaveProperty("github");
  });

  it("includes a monorepo path in the pinned source URL", () => {
    const monorepoEntry: TemplateManifestEntry = {
      ...manifestEntry,
      github: {
        owner: "vercel",
        repo: "eve-examples",
        ref: "main",
        pathPrefix: "example-template",
      },
    };

    const [entry] = composeTemplateEntries([monorepoEntry], generated);

    expect(entry.sourceRevisionHref).toBe(
      "https://github.com/vercel/eve-examples/tree/0123456789abcdef0123456789abcdef01234567/example-template",
    );
  });

  it("throws when a manifest slug has no generated data", () => {
    expect(() => composeTemplateEntries([manifestEntry], { templates: {} })).toThrow(
      /No generated data for template "example"/,
    );
  });

  it("throws when generated data has no manifest entry", () => {
    expect(() => composeTemplateEntries([], generated)).toThrow(/no manifest entry: example/);
  });

  it("throws when the generated files diverge from the manifest file list", () => {
    const drifted = { ...manifestEntry, files: ["agent/agent.ts", "agent/instructions.md"] };
    expect(() => composeTemplateEntries([drifted], generated)).toThrow(/do not match its manifest/);
  });

  it("throws on unknown languages in generated data", () => {
    const bad: GeneratedTemplatesInput = {
      templates: {
        example: {
          readme: "# Example\n",
          sourceRevision: "0123456789abcdef0123456789abcdef01234567",
          files: [{ contents: "{}", language: "json", relativePath: "agent/agent.ts" }],
        },
      },
    };
    const jsonManifest = { ...manifestEntry, files: ["agent/agent.ts"] };
    expect(() => composeTemplateEntries([jsonManifest], bad)).toThrow(/Unknown language "json"/);
  });

  it("throws when generated README content is empty", () => {
    const emptyReadme = {
      templates: { example: { ...generated.templates.example, readme: "" } },
    };
    expect(() => composeTemplateEntries([manifestEntry], emptyReadme)).toThrow(
      /Generated README is empty/,
    );
  });
});
