import { describe, expect, it } from "vitest";

import { composeTemplateEntries, type GeneratedTemplatesInput } from "./compose";
import generatedTemplates from "./generated/templates.json";
import { templateManifest, type TemplateManifestEntry } from "./manifest";

const manifestEntry: TemplateManifestEntry = {
  slug: "example",
  title: "Example",
  description: "An example template.",
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
    expect(entry.title).toBe("Example");
    expect(entry.sourceRevision).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(entry.files).toEqual(generated.templates.example.files);
    expect(entry).not.toHaveProperty("github");
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
          sourceRevision: "0123456789abcdef0123456789abcdef01234567",
          files: [{ contents: "{}", language: "json", relativePath: "agent/agent.ts" }],
        },
      },
    };
    const jsonManifest = { ...manifestEntry, files: ["agent/agent.ts"] };
    expect(() => composeTemplateEntries([jsonManifest], bad)).toThrow(/Unknown language "json"/);
  });
});

describe("committed generated data", () => {
  it("composes cleanly with the manifest", () => {
    const entries = composeTemplateEntries(
      templateManifest,
      generatedTemplates as GeneratedTemplatesInput,
    );

    expect(entries).toHaveLength(templateManifest.length);
    for (const entry of entries) {
      expect(entry.sourceRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.files.length).toBeGreaterThan(0);
      for (const file of entry.files) {
        expect(file.contents.length).toBeGreaterThan(0);
        expect(["markdown", "typescript"]).toContain(file.language);
      }
    }
  });
});
