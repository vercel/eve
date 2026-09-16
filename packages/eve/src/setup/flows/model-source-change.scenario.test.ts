import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  changeAgentModel,
  changeValidatedAgentModel,
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

it.each([false, true])(
  "applies catalog-validated selections while preserving source guards (dynamic: %s)",
  async (dynamic) => {
    const root = await mkdtemp(join(tmpdir(), "eve-model-validated-"));
    roots.push(root);
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const file = join(root, "agent.ts");
    const source = dynamic
      ? 'import { defineAgent } from "eve"; export default defineAgent({model: getModel()});'
      : 'import { defineAgent } from "eve"; export default defineAgent({model: "openai/gpt-5.6-luna-fast"});';
    await writeFile(file, source);
    const fetch = vi.fn(() => {
      throw new Error("Unexpected catalog request");
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const result = await changeValidatedAgentModel({
        appRoot: root,
        slug: "openai/catalog-validated-model",
      });
      expect(result.kind).toBe(dynamic ? "rejected" : "changed");
      expect(fetch).not.toHaveBeenCalled();
      const edited = await readFile(file, "utf8");
      if (dynamic) expect(edited).toBe(source);
      else expect(edited).toContain('"openai/catalog-validated-model"');
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
