import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { classifySelfModificationConfig } from "#self-modification/setup.js";
import { headlessAsker, withAnswers } from "#setup/ask.js";
import { setupIntegration } from "../registry.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applySelfModificationSetup, prepareSelfModificationSetup } from "./setup.js";

const docsRoot = new URL("../../../../../../apps/docs/", import.meta.url);

it("configures the hidden deployed registry scaffold without treating it as authored", async () => {
  const registry = JSON.parse(await readFile(new URL("registry.json", docsRoot), "utf8"));
  const item = registry.items.find(
    (entry: { name: string }) => entry.name === "experimental/self-modification/remote",
  );
  expect(item.meta.eve.hidden).toBe(true);
  expect(item.files[0].target).toBe("agent/extensions/self-modification-remote/extension.ts");
  const [setup] = item.meta.eve.setup;
  expect(setupIntegration(setup.args[2]).kind).toBe("self-modification-remote");
  const source = await readFile(new URL(item.files[0].path, docsRoot), "utf8");
  expect(classifySelfModificationConfig(source)).toBe("generated");
  expect(source).toContain('from "eve/self-modification/remote"');
  expect(source).toContain("authorize: () => false");

  const contexts = createSetupContexts({
    appRoot: "/project",
    asker: withAnswers({
      "self-modification-mode": "deployed",
      "self-modification-repository-owner": "acme",
      "self-modification-repository-name": "agents",
      "self-modification-repository-directory": "apps/support",
      "self-modification-target-branch": "release",
      "self-modification-confirm": true,
    })(headlessAsker()),
    environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
  });
  const operations = {
    readConfig: async () => source,
    readLocalConfig: vi.fn(),
    detectGitRepository: async () => ({ remoteKind: "missing" as const }),
    findOrCreateConnector: async () => "github/selfmod-acme-agents",
    attachConnector: vi.fn(),
    writeConfig: vi.fn(),
  };
  const plan = await prepareSelfModificationSetup(contexts.prepare, operations);
  expect(plan.kind).toBe("deployed");
  await applySelfModificationSetup(plan, contexts.apply, operations, {
    ensurePackageDependencies: async () => [],
    installScaffoldDependencies: async () => {},
  });
  const configured = operations.writeConfig.mock.calls[0]?.[0];
  expect(configured).toContain('repository: "acme/agents"');
  expect(configured).toContain('connector: "github/selfmod-acme-agents"');
  expect(configured).toContain('directory: "apps/support"');
  expect(configured).toContain('baseBranch: "release"');
  expect(classifySelfModificationConfig(configured)).toBe("generated");
  expect(operations.readLocalConfig).not.toHaveBeenCalled();

  const edited = { ...operations, readConfig: async () => `${source}\n// Custom policy\n` };
  expect(await prepareSelfModificationSetup(contexts.prepare, edited)).toMatchObject({
    kind: "authored",
  });
});
