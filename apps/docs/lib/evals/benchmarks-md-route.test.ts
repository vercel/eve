import { describe, expect, it } from "vitest";
import { GET } from "@/app/[lang]/benchmarks.md/route";

describe("/benchmarks.md route", () => {
  it("returns Markdown with canonical Link header for supported languages", async () => {
    const response = await GET(new Request("https://eve.dev/en/benchmarks.md"), {
      params: Promise.resolve({ lang: "en" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("link")).toMatch(
      /^<https?:\/\/[^>]+\/benchmarks>; rel="canonical"$/,
    );
    const body = await response.text();
    expect(body).toContain("# eve Benchmarks");
    expect(body).toContain("### OpenAI");
    expect(body).toContain("### Anthropic");
  });

  it("returns 404 for unsupported languages", async () => {
    const response = await GET(new Request("https://eve.dev/fr/benchmarks.md"), {
      params: Promise.resolve({ lang: "fr" }),
    });
    expect(response.status).toBe(404);
  });
});
