import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";

export const VercelProjectLinkSchema = z.object({
  projectId: z.string().min(1),
  orgId: z.string().min(1),
  projectName: z.string().min(1).optional(),
});

/** Validated Vercel owner and project identifiers from `.vercel/project.json`. */
export type VercelProjectLink = z.infer<typeof VercelProjectLinkSchema>;

/** Reads a validated Vercel project link without mutating local project state. */
export async function readVercelProjectLink(
  projectPath: string,
): Promise<VercelProjectLink | undefined> {
  try {
    const raw = await readFile(join(projectPath, ".vercel", "project.json"), "utf8");
    const parsed = VercelProjectLinkSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
