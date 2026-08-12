import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";

export const VercelProjectLinkSchema = z.object({
  projectId: z.string().min(1),
  orgId: z.string().min(1),
  projectName: z.string().min(1).optional(),
});

/** Validated Vercel owner and project identifiers from Vercel link metadata. */
export type VercelProjectLink = z.infer<typeof VercelProjectLinkSchema>;

/** Reads a validated Vercel project link without mutating local project state. */
export async function readVercelProjectLink(
  projectPath: string,
): Promise<VercelProjectLink | undefined> {
  for (const fileName of ["project.json", "repo.json"]) {
    try {
      const raw = await readFile(join(projectPath, ".vercel", fileName), "utf8");
      const parsed = VercelProjectLinkSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {}
  }
  return undefined;
}
