import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  changeAgentModel,
  changeAgentModelSettings,
  readAuthoredModelSelection,
} from "./model-source-change.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it.each(["flat", "nested", "agent-directory"])(
  "rewrites models and settings from a %s starting path",
  async (layout) => {
    const root = await mkdtemp(join(tmpdir(), "eve-model-layout-"));
    roots.push(root);
    const agentRoot = layout === "flat" ? root : join(root, "agent");
    await mkdir(agentRoot, { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const file = join(agentRoot, "agent.ts");
    await writeFile(
      file,
      'import { defineAgent } from "eve"; export default defineAgent({model: "openai/gpt-5.6-luna-fast"});',
    );
    const startPath = layout === "agent-directory" ? agentRoot : root;
    await expect(
      changeAgentModel({ appRoot: startPath, slug: "openai-api/gpt-5.6-luna-fast" }),
    ).resolves.toMatchObject({ kind: "changed" });
    await expect(readAuthoredModelSelection(startPath)).resolves.toBe(
      "openai-api/gpt-5.6-luna-fast",
    );
    await expect(
      changeAgentModelSettings({
        appRoot: startPath,
        patch: {
          model: { kind: "set", value: "anthropic-api/claude-sonnet-5" },
          reasoning: { kind: "keep" },
          gatewayServiceTier: { kind: "keep" },
        },
      }),
    ).resolves.toMatchObject({ kind: "changed" });
    expect(await readFile(file, "utf8")).toContain('anthropic("claude-sonnet-5")');
  },
);
