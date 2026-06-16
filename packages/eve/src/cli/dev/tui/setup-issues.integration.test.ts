import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { detectSetupIssues } from "./setup-issues.js";

async function linkedAppRoot(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-boot-detect-"));
  await mkdir(join(appRoot, ".vercel"), { recursive: true });
  await writeFile(join(appRoot, ".vercel", "project.json"), "{}", "utf8");
  return appRoot;
}

describe("BOOT_DETECTIONS against a real directory", () => {
  it("stays quiet when linked with a credential present", async () => {
    const appRoot = await linkedAppRoot();
    const issues = await detectSetupIssues({ appRoot, env: { AI_GATEWAY_API_KEY: "k" } });
    expect(issues).toEqual([]);
  });

  it("diagnoses missing credentials (not the link) when the directory is linked", async () => {
    const appRoot = await linkedAppRoot();
    const issues = await detectSetupIssues({ appRoot, env: {} });
    expect(issues).toEqual([{ label: "AI Gateway credentials missing", command: "/model" }]);
  });
});
