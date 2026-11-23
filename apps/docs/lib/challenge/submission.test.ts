import { describe, expect, it } from "vitest";
import { buildSubmission } from "./submission";

const entry = {
  repository: "https://github.com/example/weather-agent",
  description: "My agent posts tomorrow’s forecast in Slack.",
  video: "",
};

describe("challenge post draft", () => {
  it("opens an editable X draft containing the preview and hashtag without requiring a video", () => {
    const result = buildSubmission(entry);
    const url = new URL(result.intent ?? "");
    expect(url.origin + url.pathname).toBe("https://x.com/intent/tweet");
    expect(url.searchParams.get("text")).toBe(
      "My agent posts tomorrow’s forecast in Slack.\n\nhttps://github.com/example/weather-agent\n\n#eveAgentShowcase",
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
      "\nhttps://youtu.be/dQw4w9WgXcQ\n\n#eveAgentShowcase",
    );
  });

  it.each([
    ["repository", "https://github.com.example/weather-agent"],
    ["repository", "https://github.com/example/weather-agent/issues"],
    ["description", "   "],
    ["video", "https://www.youtube.com/@example"],
  ])("does not open a draft with invalid %s: %s", (field, value) => {
    const result = buildSubmission({ ...entry, [field]: value });
    expect(result.intent).toBeNull();
    expect(result.errors).toHaveProperty(field);
  });
});
