import { describe, expect, it } from "vitest";

import type { TemplateGitHubSource } from "./manifest";
import {
  commitUrl,
  contentsUrl,
  decodeContentsResponse,
  languageForPath,
  sortTemplateFiles,
} from "./sync-core";

const source: TemplateGitHubSource = {
  owner: "vercel-labs",
  repo: "eve-chat-template",
  ref: "main",
};

describe("languageForPath", () => {
  it("maps markdown and typescript extensions", () => {
    expect(languageForPath("agent/instructions.md")).toBe("markdown");
    expect(languageForPath("agent/skills/intro.mdx")).toBe("markdown");
    expect(languageForPath("agent/agent.ts")).toBe("typescript");
    expect(languageForPath("agent/ui/panel.tsx")).toBe("typescript");
  });

  it("throws for unknown extensions", () => {
    expect(() => languageForPath("agent/config.yaml")).toThrow(/No language mapping/);
  });
});

describe("commitUrl", () => {
  it("targets the commits endpoint for the manifest ref", () => {
    expect(commitUrl(source)).toBe(
      "https://api.github.com/repos/vercel-labs/eve-chat-template/commits/main",
    );
  });
});

describe("contentsUrl", () => {
  it("pins the file to the resolved sha", () => {
    expect(contentsUrl(source, "abc123", "agent/agent.ts")).toBe(
      "https://api.github.com/repos/vercel-labs/eve-chat-template/contents/agent/agent.ts?ref=abc123",
    );
  });

  it("joins the pathPrefix for monorepo sources", () => {
    const monorepo: TemplateGitHubSource = {
      owner: "vercel",
      repo: "eve",
      ref: "main",
      pathPrefix: "apps/fixtures/weather-agent",
    };
    expect(contentsUrl(monorepo, "abc123", "agent/agent.ts")).toBe(
      "https://api.github.com/repos/vercel/eve/contents/apps/fixtures/weather-agent/agent/agent.ts?ref=abc123",
    );
  });
});

describe("decodeContentsResponse", () => {
  it("decodes base64 content with embedded newlines", () => {
    const contents = 'import { defineAgent } from "eve";\n\nexport default defineAgent({});\n';
    const base64 = Buffer.from(contents, "utf8").toString("base64");
    const wrapped = `${base64.slice(0, 20)}\n${base64.slice(20)}\n`;

    expect(
      decodeContentsResponse("agent/agent.ts", { content: wrapped, encoding: "base64" }),
    ).toEqual({ contents, language: "typescript", relativePath: "agent/agent.ts" });
  });

  it("throws for files above the contents API 1 MB limit", () => {
    expect(() =>
      decodeContentsResponse("agent/huge.ts", { content: "", encoding: "none", size: 2_000_000 }),
    ).toThrow(/1 MB limit/);
  });

  it("throws for non-base64 responses", () => {
    expect(() => decodeContentsResponse("agent/agent.ts", { encoding: "utf8" })).toThrow(
      /Unexpected contents API response/,
    );
  });
});

describe("sortTemplateFiles", () => {
  it("orders files by relativePath without mutating the input", () => {
    const files = [
      { contents: "", language: "typescript" as const, relativePath: "agent/tools/b.ts" },
      { contents: "", language: "typescript" as const, relativePath: "agent/agent.ts" },
    ];
    const sorted = sortTemplateFiles(files);

    expect(sorted.map((file) => file.relativePath)).toEqual(["agent/agent.ts", "agent/tools/b.ts"]);
    expect(files[0].relativePath).toBe("agent/tools/b.ts");
  });
});
