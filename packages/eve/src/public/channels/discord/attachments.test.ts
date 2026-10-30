import { describe, expect, it } from "vitest";

import { createDiscordFetchFile, discordCommandContent } from "./attachments.js";

const OVER_LIMIT = 25 * 1024 * 1024 + 1;
const CDN_URL = "https://cdn.discordapp.com/attachments/C1/A1/report.pdf?ex=signed";

describe("discord attachments", () => {
  it("notes a file Discord reports as over the upload limit without downloading it", () => {
    expect(
      discordCommandContent("", [
        {
          contentType: "application/pdf",
          filename: "report.pdf",
          id: "A1",
          size: OVER_LIMIT,
          url: CDN_URL,
        },
      ]),
    ).toEqual([
      {
        text: "Attachment report.pdf was not retrieved: it is over the upload limit.",
        type: "text",
      },
    ]);
  });

  it("stops a download that turns out larger than the upload limit", async () => {
    const fetchFile = createDiscordFetchFile(async () => new Response(new Uint8Array(OVER_LIMIT)));
    await expect(fetchFile(CDN_URL)).rejects.toThrow("it is over the 25 MB upload limit.");
  });
});
