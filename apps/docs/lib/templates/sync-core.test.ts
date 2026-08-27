import { describe, expect, it } from "vitest";

import type { TemplateGitHubSource } from "./manifest";
import { commitUrl, languageForPath, rawContentsUrl, sortTemplateFiles } from "./sync-core";

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

describe("rawContentsUrl", () => {
  it("pins the raw file to the resolved sha", () => {
    expect(rawContentsUrl(source, "abc123", "agent/agent.ts")).toBe(
      "https://raw.githubusercontent.com/vercel-labs/eve-chat-template/abc123/agent/agent.ts",
    );
  });

  it("joins the pathPrefix for monorepo sources", () => {
    const monorepo: TemplateGitHubSource = {
      owner: "vercel",
      repo: "eve",
      ref: "main",
      pathPrefix: "apps/fixtures/weather-agent",
    };
    expect(rawContentsUrl(monorepo, "abc123", "agent/agent.ts")).toBe(
      "https://raw.githubusercontent.com/vercel/eve/abc123/apps/fixtures/weather-agent/agent/agent.ts",
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
