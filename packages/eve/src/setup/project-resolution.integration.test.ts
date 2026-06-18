import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readProjectLink, writeProjectLink } from "./project-resolution.js";

describe("writeProjectLink", () => {
  it("writes the Vercel link contract, README, and one gitignore entry", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "eve-project-link-"));
    try {
      await writeFile(join(projectRoot, ".gitignore"), "node_modules\n", "utf8");
      const link = {
        projectId: "prj_demo",
        orgId: "team_demo",
        projectName: "demo-agent",
      };

      await writeProjectLink({ projectRoot, link });
      await writeProjectLink({ projectRoot, link });

      await expect(readFile(join(projectRoot, ".vercel", "project.json"), "utf8")).resolves.toBe(
        `${JSON.stringify(link, null, 2)}\n`,
      );
      await expect(readProjectLink(projectRoot)).resolves.toEqual(link);
      await expect(readFile(join(projectRoot, ".vercel", "README.txt"), "utf8")).resolves.toContain(
        'The ID of the Vercel project that you linked ("projectId")',
      );
      await expect(readFile(join(projectRoot, ".gitignore"), "utf8")).resolves.toBe(
        "node_modules\n.vercel\n",
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
