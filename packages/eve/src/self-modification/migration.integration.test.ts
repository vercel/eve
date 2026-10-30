import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { SelfModificationSetupOperations } from "#self-modification/setup.js";
import { headlessAsker, withAnswers } from "#setup/ask.js";
import { integrationSetupEnvironment } from "#setup/integrations/shared/environment.js";
import { createSetupContexts } from "#setup/integrations/shared/ui.js";
import { prepareLocalSelfModificationSetup } from "#setup/integrations/self-modification/setup.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("rejects the retired layout with mount guidance without deleting authored files", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-retired-self-modification-"));
  roots.push(root);
  const directory = join(root, "agent/subagents/self-modification");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "agent.ts"),
    'import { defineSelfModificationAgent } from "eve/self-modification/agent";\n',
  );
  const notes = "Alice's authored deployment notes";
  await writeFile(join(directory, "notes.md"), notes);
  const contexts = createSetupContexts({
    appRoot: root,
    asker: withAnswers({ "self-modification-cleanup": true })(headlessAsker()),
    environment: integrationSetupEnvironment("unavailable", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
  });
  const operations: SelfModificationSetupOperations = {
    attachConnector: vi.fn(),
    detectChannelNames: vi.fn(async () => []),
    detectGitRepository: vi.fn(async () => ({ remoteKind: "missing" as const })),
    findOrCreateConnector: vi.fn(async () => "github/example"),
    readConfig: vi.fn(async () => undefined),
    readLocalConfig: vi.fn(async () => undefined),
    writeConfig: vi.fn(),
  };
  await expect(prepareLocalSelfModificationSetup(contexts.prepare, operations)).rejects.toThrow(
    /agent\/subagents\/self-modification.*eve\/extensions\/self-modification\/local/,
  );
  expect(await readFile(join(directory, "notes.md"), "utf8")).toBe(notes);
  expect(operations.writeConfig).not.toHaveBeenCalled();
});
