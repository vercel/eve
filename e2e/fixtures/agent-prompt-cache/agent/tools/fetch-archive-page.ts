import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Returns one deterministic ~2,500-token page of archive rows. The payload
 * is intentionally large: the prompt-cache eval measures whether these tool
 * results are cached in the same request that first carries them, and small
 * results would drown the signal in per-request framing tokens.
 */
export default defineTool({
  description:
    "Returns one page of the district archive. Call once per page number and wait for the result before requesting the next page.",
  inputSchema: z.object({
    page: z.number().int().min(1).max(9).describe("Archive page number to fetch."),
  }),
  async execute({ page }) {
    const rows: string[] = [];
    for (let row = 1; row <= 220; row++) {
      rows.push(
        `page ${page} row ${String(row).padStart(3, "0")}: district ${((page * 7 + row) % 40) + 1} ` +
          `rainfall ${(page * 31 + row * 13) % 200} mm, reservoir ${(page * 17 + row * 11) % 100}% full`,
      );
    }
    return { page, rowCount: rows.length, content: rows.join("\n") };
  },
});
