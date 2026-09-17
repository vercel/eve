import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { SelfModificationSetupOperations } from "#self-modification/setup.js";
import { headlessAsker, interactiveAsker, withAnswers } from "#setup/ask.js";
import { integrationSetupEnvironment } from "#setup/integrations/shared/environment.js";
import { createSetupContexts } from "#setup/integrations/shared/ui.js";
import {
  applySelfModificationSetup,
  prepareLocalSelfModificationSetup,
} from "#setup/integrations/self-modification/setup.js";

import {
  detectLegacySelfModificationScaffold,
  removeLegacySelfModificationScaffold,
} from "./migration.js";

const roots: string[] = [];
const legacy = {
  "agent.ts":
    'import { defineSelfModificationAgent } from "eve/self-modification/agent";\n\nimport config from "./config";\n\nexport default defineSelfModificationAgent({\n  config,\n\n  // To use a specific model instead of eve\'s default, add:\n  // model: "provider/model",\n});\n',
  "config.ts":
    'import { defineSelfModificationConfig } from "eve/self-modification/config";\n\nexport default defineSelfModificationConfig({});\n',
  "sandbox.ts":
    'import { defineSelfModificationSandbox } from "eve/self-modification/sandbox";\n\nimport config from "./config";\n\nexport default defineSelfModificationSandbox({ config });\n',
  "extensions/selfmod.ts":
    'import selfModification from "eve/self-modification";\nimport config from "../config";\n\nexport default selfModification(config);\n',
};

async function scaffold(custom = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-self-modification-migration-"));
  roots.push(root);
  for (const [path, source] of Object.entries(legacy)) {
    await mkdir(join(root, "agent/subagents/self-modification", path, ".."), { recursive: true });
    await writeFile(
      join(root, "agent/subagents/self-modification", path),
      custom && path === "config.ts" ? `${source}// custom\n` : source,
      "utf8",
    );
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function setupOperations(): SelfModificationSetupOperations {
  return {
    attachConnector: vi.fn(),
    detectChannelNames: vi.fn(async () => []),
    detectGitRepository: vi.fn(async () => ({ remoteKind: "missing" as const })),
    findOrCreateConnector: vi.fn(async () => "github/example"),
    readConfig: vi.fn(async () => undefined),
    writeConfig: vi.fn(),
  };
}

describe("self-modification scaffold migration", () => {
  it("recognizes the default scaffold without evaluating consumer code", async () => {
    const root = await scaffold();
    await expect(detectLegacySelfModificationScaffold(root)).resolves.toMatchObject({
      customized: false,
    });
  });

  it("marks changed configuration and extra files as customized", async () => {
    const root = await scaffold(true);
    await writeFile(join(root, "agent/subagents/self-modification/notes.md"), "custom", "utf8");
    await expect(detectLegacySelfModificationScaffold(root)).resolves.toMatchObject({
      customized: true,
    });
  });

  it("rechecks and removes the scaffold without writing the extension", async () => {
    const root = await scaffold();
    const detected = await detectLegacySelfModificationScaffold(root);
    if (detected === undefined) throw new Error("Expected legacy scaffold");
    await removeLegacySelfModificationScaffold(root, detected);
    await expect(
      readFile(join(root, "agent/extensions/self-modification/extension.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(detectLegacySelfModificationScaffold(root)).resolves.toBeUndefined();
  });

  it("defaults to removing a legacy scaffold without reporting customizations", async () => {
    const root = await scaffold(true);
    const fake = createFakePrompter({
      single: (options) => {
        expect(options).toMatchObject({
          message: `A legacy self-modification scaffold was found at ${relative(root, join(root, "agent/subagents/self-modification"))}. This scaffold format is no longer supported. Do you want to remove it?`,
          initialValue: "yes",
          options: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ],
        });
        return "yes";
      },
    });
    const contexts = createSetupContexts({
      appRoot: root,
      asker: interactiveAsker(fake.prompter),
      environment: integrationSetupEnvironment("unavailable", { kind: "unresolved" }),
      prompter: fake.prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });

    const plan = await prepareLocalSelfModificationSetup(contexts.prepare, setupOperations());
    await applySelfModificationSetup(plan, contexts.apply, setupOperations());

    await expect(detectLegacySelfModificationScaffold(root)).resolves.toBeUndefined();
    expect(fake.prompter.log.success).toHaveBeenCalledWith(
      "Removed the retired self-modification scaffold.",
    );
  });

  it("keeps a declined legacy scaffold while continuing setup", async () => {
    const root = await scaffold();
    const contexts = createSetupContexts({
      appRoot: root,
      asker: withAnswers({ "self-modification-cleanup": false })(headlessAsker()),
      environment: integrationSetupEnvironment("unavailable", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });

    const plan = await prepareLocalSelfModificationSetup(contexts.prepare, setupOperations());
    await applySelfModificationSetup(plan, contexts.apply, setupOperations());

    await expect(detectLegacySelfModificationScaffold(root)).resolves.toBeDefined();
  });

  it("rejects concurrent changes", async () => {
    const root = await scaffold();
    const detected = await detectLegacySelfModificationScaffold(root);
    if (detected === undefined) throw new Error("Expected legacy scaffold");
    await writeFile(join(root, "agent/subagents/self-modification/config.ts"), "changed", "utf8");
    await expect(removeLegacySelfModificationScaffold(root, detected)).rejects.toThrow(
      /changed while setup/,
    );
  });
});
