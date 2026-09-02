import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Returns one deterministic ~2,500-token page of catalog rows. The payload
 * is intentionally large: the prompt-cache eval measures whether these tool
 * results are cached in the same request that first carries them, and small
 * results would drown the signal in per-request framing tokens.
 */
export default defineTool({
  description:
    "Returns one page of the observatory catalog. Call once per page number and wait for the result before requesting the next page.",
  inputSchema: z.object({
    page: z.number().int().min(1).max(9).describe("Catalog page number to fetch."),
  }),
  async execute({ page }) {
    const rows: string[] = [];
    for (let row = 1; row <= 220; row++) {
      rows.push(
        `page ${page} row ${String(row).padStart(3, "0")}: sector ${((page * 7 + row) % 40) + 1} ` +
          `luminosity ${(page * 31 + row * 13) % 200} flux, elevation ${(page * 17 + row * 11) % 100} deg`,
      );
    }
    return { page, rowCount: rows.length, content: rows.join("\n") };
  },
});
