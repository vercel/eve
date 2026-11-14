import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { openInstinctContactUrl } from "@shared/chat/contact-card";
import { GET } from "../route";

async function contactUrl() {
  const { betterAuthSecret } = await getInstallationSecrets();
  return new URL(openInstinctContactUrl("+12025550123", betterAuthSecret));
}

describe("OpenInstinct contact download", () => {
  it("allows a signed provider download with the number and full logo", async () => {
    const response = await GET(new Request(await contactUrl()));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/vcard; charset=utf-8"
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="OpenInstinct.vcf"'
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const card = await response.text();
    expect(
      card.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)
    ).toBe(true);
    const unfolded = card.replace(/\r\n /g, "");
    expect(unfolded).toContain(
      "N:;OpenInstinct;;;\r\nFN:OpenInstinct\r\nTEL;TYPE=CELL:+12025550123\r\n"
    );
    const logo = await readFile(join(process.cwd(), "app/apple-icon.png"));
    expect(unfolded).toContain(
      `PHOTO;ENCODING=b;TYPE=PNG:${logo.toString("base64")}\r\n`
    );
    expect(unfolded.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n")).toBe(true);
    expect(unfolded.endsWith("END:VCARD\r\n")).toBe(true);
  });

  it.each([
    ["phone", "+12025550999"],
    ["phone", "+12025550123\r\nFN:Someone else"],
    ["expires", "0"],
    ["expires", String(Math.floor(Date.now() / 1000) + 8 * 24 * 60 * 60)],
    ["signature", "a".repeat(64)],
    ["signature", "malformed"],
  ])("rejects changed %s parameters", async (name, value) => {
    const url = await contactUrl();
    url.searchParams.set(name, value);
    expect((await GET(new Request(url))).status).toBe(404);
  });

  it("rejects an unsigned download", async () => {
    const response = await GET(
      new Request("https://example.com/contacts/openinstinct.vcf")
    );
    expect(response.status).toBe(404);
  });
});
