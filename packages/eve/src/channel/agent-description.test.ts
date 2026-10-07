import { describe, expect, it } from "vitest";

import {
  createAgentDescriptionRouteArgs,
  describeCompiledAgent,
  loadDescribedAgent,
} from "#channel/agent-description.js";
import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { withBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import {
  getActiveRuntimeSession,
  setRuntimeSessionCompiledArtifacts,
} from "#runtime/sessions/runtime-session.js";

it("describes only the tools invokeTool can run, sorted by name", () => {
  const tool = (name: string, extra: Record<string, unknown> = {}) => ({
    description: `${name} description`,
    hasExecute: true,
    inputSchema: { type: "object" },
    name,
    requiresApproval: false,
    sourceId: `source:${name}`,
    ...extra,
  });
  const manifest = {
    bindings: {
      "source:deploy": { owner: { kind: "application" } },
      "source:lookup": { owner: { kind: "extension" } },
      "source:load_skill": { owner: { feature: "skills", kind: "framework" } },
      "source:plan": { owner: { kind: "application" } },
      "source:remote": { owner: { kind: "application" } },
    },
    config: { description: "Runs the kennel.", name: "kennel" },
    skills: [
      { description: "Second.", files: [], name: "b" },
      { description: "First.", name: "a" },
    ],
    tools: [
      tool("lookup", { outputSchema: { type: "object" } }),
      tool("deploy", { requiresApproval: true }),
      tool("load_skill"),
      tool("plan", { behavior: { handling: { kind: "workflow-tool" } } }),
      tool("remote", { hasExecute: false }),
    ],
  };

  // Skills carry their name and description only; files come from `listSkillFiles`.
  expect(describeCompiledAgent(manifest as never)).toEqual({
    description: "Runs the kennel.",
    name: "kennel",
    tools: [
      {
        approval: true,
        description: "deploy description",
        inputSchema: { type: "object" },
        name: "deploy",
      },
      {
        approval: false,
        description: "lookup description",
        inputSchema: { type: "object" },
        name: "lookup",
        outputSchema: { type: "object" },
      },
    ],
    skills: [
      { description: "First.", name: "a" },
      { description: "Second.", name: "b" },
    ],
  });
});

describe("loadDescribedAgent", () => {
  const source = createBundledRuntimeCompiledArtifactsSource();
  const compile = async (name: string, skills: readonly string[] = []) => {
    const { manifest, moduleMap } = await compileFromMemory({
      agentRoot: "/tmp/app/agent",
      appRoot: "/tmp/app",
      model: "openai/gpt-5.4",
      name,
      skills: skills.map((skill) => ({
        description: `About ${skill}.`,
        markdown: `# ${skill}\n`,
        name: skill,
      })),
    });
    return {
      manifest: {
        ...manifest,
        skills: manifest.skills.map(({ files: _files, ...skill }) => skill),
      },
      moduleMap,
    };
  };

  it("describes without touching skill files, and lists them only on request", async () => {
    const compiled = await compile("kennel", ["handbook"]);
    await withBundledCompiledArtifacts(compiled, async () => {
      const { args } = createAgentDescriptionRouteArgs(() => source);
      // A bundled build without `eve build`'s skill assets has no skill storage.
      await expect(args.describe()).resolves.toMatchObject({
        name: "kennel",
        skills: [{ description: "About handbook.", name: "handbook" }],
      });
      await expect(args.listSkillFiles("handbook")).rejects.toMatchObject({
        code: "unavailable",
      });
      await expect(args.listSkillFiles("other")).rejects.toMatchObject({ code: "unknown-skill" });
      await expect(args.readSkill("other")).rejects.toMatchObject({ code: "unknown-skill" });
    });
  });

  it("caches per runtime session and reloads when the installed snapshot changes", async () => {
    const [first, second, third] = await Promise.all([
      compile("first"),
      compile("second"),
      compile("third"),
    ]);
    await withBundledCompiledArtifacts(first, async () => {
      const described = await loadDescribedAgent(source);
      expect(described.description.name).toBe("first");
      expect(await loadDescribedAgent(source)).toBe(described);

      await withBundledCompiledArtifacts(second, async () => {
        expect((await loadDescribedAgent(source)).description.name).toBe("second");
      });
      expect(await loadDescribedAgent(source)).toBe(described);

      // Replace the snapshot inside this scoped session, as a redeploy would.
      setRuntimeSessionCompiledArtifacts(getActiveRuntimeSession(), third);
      expect((await loadDescribedAgent(source)).description.name).toBe("third");
    });
  });
});
