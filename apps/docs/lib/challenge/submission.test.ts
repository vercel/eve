import { describe, expect, it } from "vitest";
import { buildSubmission } from "./submission";

const entry = {
  repository: "https://github.com/example/weather-agent",
  description: "My agent posts tomorrow’s forecast in Slack.",
  video: "",
};

describe("challenge post draft", () => {
  it("opens an editable X draft that tags @eve and names the Builder Challenge without requiring a video", () => {
    const result = buildSubmission(entry);
    const url = new URL(result.intent ?? "");
    expect(url.origin + url.pathname).toBe("https://x.com/intent/tweet");
    expect(url.searchParams.get("text")).toBe(
      "My agent posts tomorrow’s forecast in Slack.\n\nBuilder Challenge with @eve.\n\nhttps://github.com/example/weather-agent",
    );
    expect(result.preview.media).toEqual({ kind: "github", path: "/example/weather-agent" });
  });

  it("previews the YouTube demo instead of the repository and drops unrelated link parameters", () => {
    const result = buildSubmission({
      ...entry,
      video: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
    });
    expect(result.preview.media).toEqual({ kind: "youtube", id: "dQw4w9WgXcQ" });
    expect(new URL(result.intent ?? "").searchParams.get("text")).toContain(
      "\nhttps://github.com/example/weather-agent\nhttps://youtu.be/dQw4w9WgXcQ",
    );
  });

  it("fits X's standard post limit with 100 CJK characters and both links", () => {
    const description = "猫".repeat(100);
    const video = "https://youtu.be/dQw4w9WgXcQ";
    const result = buildSubmission({ ...entry, description, video });
    const text = new URL(result.intent ?? "").searchParams.get("text") ?? "";
    expect(text).toContain(description);
    expect(text).toContain(entry.repository);
    expect(text).toContain(video);

    const withShortenedLinks = text
      .replace(entry.repository, "x".repeat(23))
      .replace(video, "x".repeat(23));
    expect(withShortenedLinks.length + description.length).toBeLessThanOrEqual(280);
  });

  it("accepts repositories hosted outside GitHub without a GitHub preview card", () => {
    const result = buildSubmission({
      ...entry,
      repository: "https://gitlab.com/example/weather-agent.git",
    });
    expect(result.preview.media).toBeNull();
    expect(new URL(result.intent ?? "").searchParams.get("text")).toContain(
      "\nhttps://gitlab.com/example/weather-agent",
    );
  });

  it.each([
    ["repository", "http://gitlab.com/example/weather-agent"],
    ["repository", "https://codeberg.org/example"],
    ["repository", "https://github.com/example/weather-agent/issues"],
    ["description", "   "],
    ["video", "https://www.youtube.com/@example"],
  ])("does not open a draft with invalid %s: %s", (field, value) => {
    const result = buildSubmission({ ...entry, [field]: value });
    expect(result.intent).toBeNull();
    expect(result.errors).toHaveProperty(field);
  });
});
