import { describe, expect, it } from "vitest";

import { defineSchedule } from "#public/definitions/schedule.js";
import { defineSkill } from "#public/definitions/skill.js";
import {
  lowerInstructionsMarkdown,
  lowerScheduleMarkdown,
  lowerSkillMarkdown,
} from "#internal/helpers/markdown.js";

describe("markdown helpers", () => {
  it("lowers instructions markdown into the same shape as a module-authored instructions definition", () => {
    const markdown = "You are a weather-focused assistant.";

    expect(lowerInstructionsMarkdown(markdown)).toEqual({ markdown });
  });

  it("lowers skill markdown frontmatter into the same shape as a module-authored skill definition", () => {
    const markdown = `---
description: Use the weather tool before answering forecast questions.
license: MIT
metadata:
  audience: forecast
---
When the user asks about weather, call the weather tool before answering.`;

    expect(lowerSkillMarkdown(markdown)).toEqual(
      defineSkill({
        description: "Use the weather tool before answering forecast questions.",
        license: "MIT",
        metadata: {
          audience: "forecast",
        },
        markdown: "When the user asks about weather, call the weather tool before answering.",
      }),
    );
  });

  it("lowers flat skill markdown by deriving the file-backed defaults", () => {
    const markdown = `---
description: Research complex weather questions before replying.
---
Research complex weather questions before replying.`;

    expect(
      lowerSkillMarkdown(markdown, {
        slug: "weather-research",
      }),
    ).toEqual(
      defineSkill({
        description: "Research complex weather questions before replying.",
        markdown: "Research complex weather questions before replying.",
      }),
    );
  });

  it("silently ignores authored name fields in skill markdown frontmatter", () => {
    // SKILL.md files in the broader Agent Skills ecosystem typically declare
    // `name`; eve derives identity from the file path, so we accept and drop
    // the field rather than rejecting otherwise-valid skill markdown.
    const markdown = `---
name: get-weather
description: Use the weather tool before answering forecast questions.
---
When the user asks about weather, call the weather tool before answering.`;

    expect(lowerSkillMarkdown(markdown)).toEqual(
      defineSkill({
        description: "Use the weather tool before answering forecast questions.",
        markdown: "When the user asks about weather, call the weather tool before answering.",
      }),
    );
  });

  it("silently ignores authored name fields in flat skill markdown frontmatter", () => {
    const markdown = `---
name: weather-research
description: Research complex weather questions before replying.
---
Research complex weather questions before replying.`;

    expect(
      lowerSkillMarkdown(markdown, {
        slug: "weather-research",
      }),
    ).toEqual(
      defineSkill({
        description: "Research complex weather questions before replying.",
        markdown: "Research complex weather questions before replying.",
      }),
    );
  });

  it("rejects unsupported frontmatter fields in skills instead of silently dropping them", () => {
    expect(() =>
      lowerSkillMarkdown(`---
description: Use the weather tool before answering forecast questions.
category: routing
---
When the user asks about weather, call the weather tool before answering.`),
    ).toThrow("Expected authored skill markdown to match the public eve shape.");
  });

  it("derives flat skill metadata from plain markdown when no frontmatter is present", () => {
    expect(
      lowerSkillMarkdown("Use the weather tool before answering forecast questions.", {
        slug: "get-weather",
      }),
    ).toEqual(
      defineSkill({
        description: "Use the weather tool before answering forecast questions.",
        markdown: "Use the weather tool before answering forecast questions.",
      }),
    );
  });

  it("accepts skill markdown that derives identity entirely from the filesystem", () => {
    const result = lowerSkillMarkdown(`---
description: Use the weather tool before answering forecast questions.
---
When the user asks about weather, call the weather tool before answering.`);

    expect(result.description).toBe("Use the weather tool before answering forecast questions.");
    expect(result.markdown).toBe(
      "When the user asks about weather, call the weather tool before answering.",
    );
  });

  it("requires skill markdown to declare the description field", () => {
    expect(() =>
      lowerSkillMarkdown(`---
license: MIT
---
When the user asks about weather, call the weather tool before answering.`),
    ).toThrow('Missing required "description" frontmatter.');
  });

  it("lowers schedule markdown into the canonical schedule definition shape", () => {
    const markdown = `---
cron: "*/5 * * * *"
---
What's the temp in NYC?`;

    expect(lowerScheduleMarkdown(markdown)).toEqual(
      defineSchedule({
        cron: "*/5 * * * *",
        markdown: "What's the temp in NYC?",
      }),
    );
  });

  it("requires schedule markdown to declare frontmatter", () => {
    expect(() => lowerScheduleMarkdown("just a body")).toThrow(
      'Schedule markdown must start with YAML frontmatter declaring "cron".',
    );
  });

  it("requires schedule markdown to declare cron", () => {
    expect(() =>
      lowerScheduleMarkdown(`---
description: nope
---
body`),
    ).toThrow("Expected authored schedule markdown to match the public eve shape.");
  });

  it("rejects run frontmatter in schedule markdown", () => {
    expect(() =>
      lowerScheduleMarkdown(`---
cron: "*/5 * * * *"
run: "some-handler"
---
body`),
    ).toThrow(
      'Markdown-form schedules do not support the "run" frontmatter key. Use a TypeScript schedule (`<name>.ts`) to author a handler.',
    );
  });

  it("rejects unsupported frontmatter fields in schedule markdown", () => {
    expect(() =>
      lowerScheduleMarkdown(`---
cron: "*/5 * * * *"
name: not-allowed
---
body`),
    ).toThrow("Expected authored schedule markdown to match the public eve shape.");
  });

  it("rejects skill markdown frontmatter without a closing delimiter", () => {
    expect(() =>
      lowerSkillMarkdown(`---
description: test
plain markdown`),
    ).toThrow("Markdown frontmatter is missing a closing delimiter.");
  });

  it("requires skill markdown frontmatter to parse into an object", () => {
    expect(() =>
      lowerSkillMarkdown(`---
[]
---
plain markdown`),
    ).toThrow("Markdown frontmatter must parse to an object.");
  });

  it("rejects JavaScript frontmatter in skill markdown instead of evaluating it", () => {
    // gray-matter's built-in `javascript` engine would `eval()` the frontmatter
    // body, so a `---javascript` fence must throw rather than execute code.
    const malicious = `---javascript
globalThis.__eveMarkdownRce = true
---
When the user asks about weather, call the weather tool before answering.`;

    expect(() => lowerSkillMarkdown(malicious)).toThrow("JavaScript frontmatter is not supported.");
    expect(Reflect.get(globalThis, "__eveMarkdownRce")).toBeUndefined();
  });

  it("rejects JavaScript frontmatter in schedule markdown instead of evaluating it", () => {
    const malicious = `---js
globalThis.__eveScheduleRce = true
---
body`;

    expect(() => lowerScheduleMarkdown(malicious)).toThrow(
      "JavaScript frontmatter is not supported.",
    );
    expect(Reflect.get(globalThis, "__eveScheduleRce")).toBeUndefined();
  });
});
