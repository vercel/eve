import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { templateManifest } from "./manifest";

// The tool or skill name a manifest file defines: `agent/tools/<name>.ts`,
// `agent/skills/<name>.md`, or `agent/skills/<name>/SKILL.md`.
const definedName = (path: string) =>
  /^agent\/(?:tools\/([^/]+)\.tsx?|skills\/([^/]+)\.md|skills\/([^/]+)\/SKILL\.md)$/
    .exec(path)
    ?.slice(1)
    .find(Boolean) ?? [];

describe("template previews", () => {
  it.each(
    templateManifest
      .filter((entry) => !entry.unlisted)
      .map((entry) => [entry.slug, entry.tagline] as const),
  )("%s has a one-line tagline", (_slug, tagline) => {
    expect(tagline?.length).toBeGreaterThan(0);
    expect(tagline?.length).toBeLessThanOrEqual(40);
  });

  const withPreview = templateManifest.filter((entry) => entry.preview);

  it.each(withPreview.map((entry) => [entry.slug, entry] as const))(
    "%s only shows tools listed in its files",
    (_slug, entry) => {
      const names = new Set(entry.files.flatMap(definedName));
      const tools = entry.preview?.messages.flatMap((message) => message.tools ?? []) ?? [];
      expect(tools.filter((tool) => !names.has(tool))).toEqual([]);
    },
  );

  it.each(
    withPreview
      .filter(
        (entry) => entry.preview?.surface === "slack" || entry.preview?.surface === "imessage",
      )
      .map((entry) => [entry.slug, entry] as const),
  )("%s sets no tools on a surface that hides tool calls", (_slug, entry) => {
    expect(entry.preview?.messages.filter((message) => message.tools)).toEqual([]);
  });

  it.each(
    withPreview
      .filter((entry) => entry.preview?.icon)
      .map((entry) => [entry.slug, entry.preview?.icon ?? ""] as const),
  )("%s icon exists in public/", (_slug, icon) => {
    expect(existsSync(fileURLToPath(new URL(`../../public${icon}`, import.meta.url)))).toBe(true);
  });

  it.each(
    withPreview
      .filter((entry) => entry.preview?.surface !== "slack" && entry.preview?.surface !== "github")
      .map((entry) => [entry.slug, entry] as const),
  )("%s has no Slack or GitHub formatting", (_slug, entry) => {
    const texts = entry.preview?.messages.map((message) => message.text) ?? [];
    expect(texts.filter((text) => /`|\]\(/.test(text))).toEqual([]);
  });

  it.each(
    withPreview
      .filter((entry) => entry.preview?.surface !== "slack")
      .map((entry) => [entry.slug, entry] as const),
  )("%s has no Slack attachments", (_slug, entry) => {
    expect(entry.preview?.messages.filter((message) => message.attachment)).toEqual([]);
  });

  it.each(
    withPreview
      .filter((entry) => entry.preview?.surface !== "github")
      .map((entry) => [entry.slug, entry] as const),
  )("%s has no GitHub-only fields", (_slug, entry) => {
    expect(entry.preview?.thread).toBeUndefined();
    expect(entry.preview?.review).toBeUndefined();
    expect(entry.preview?.messages.filter((message) => message.event)).toEqual([]);
  });

  it.each(
    withPreview
      .filter((entry) => entry.preview?.surface === "github")
      .map((entry) => [entry.slug, entry] as const),
  )("%s names the GitHub thread it happens on", (_slug, entry) => {
    expect(entry.preview?.thread?.title.length).toBeGreaterThan(0);
    if (entry.preview?.thread?.draft) expect(entry.preview.thread.kind).toBe("pull");
  });

  it.each(
    withPreview
      .filter((entry) =>
        entry.preview?.messages.some((message) => message.attachment?.type === "tasks"),
      )
      .map((entry) => [entry.slug, entry] as const),
  )("%s only shows a task card when it has subagents", (_slug, entry) => {
    expect(entry.files.some((path) => path.startsWith("agent/subagents/"))).toBe(true);
  });
});
