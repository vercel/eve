import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { captureVercel } from "#setup/primitives/run-vercel.js";
import { WizardCancelledError } from "#setup/step.js";

import { offerTraceSampling } from "./vercel-trace-sampling.js";

vi.mock("#setup/primitives/run-vercel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#setup/primitives/run-vercel.js")>()),
  captureVercel: vi.fn(),
}));

const capture = vi.mocked(captureVercel);
const roots: string[] = [];

async function projectRoot(projectId = "prj_existing"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-trace-offer-"));
  roots.push(root);
  await mkdir(join(root, ".vercel"));
  await writeFile(
    join(root, ".vercel", "project.json"),
    JSON.stringify({ orgId: "team_1", projectId }),
  );
  return root;
}

beforeEach(() => capture.mockReset());
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("offers to enable 100% sampling when an existing project has no rules", async () => {
  const root = await projectRoot();
  capture
    .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ rules: [] }) })
    .mockResolvedValueOnce({ ok: true, stdout: "{}" });
  const { prompter, selectMessages } = createFakePrompter({
    single: (options) => {
      expect(options.initialValue).toBe("decline");
      expect(options.description).toContain("all project traffic");
      expect(options.metadata).toEqual([{ label: "Vercel project", value: "prj_existing" }]);
      return "enable";
    },
  });

  await offerTraceSampling(root, "prj_existing", prompter);

  expect(selectMessages).toEqual(["Enable tracing for Agent Runs?"]);
  expect(capture).toHaveBeenNthCalledWith(
    1,
    ["traces", "config", "ls", "--json", "--project", "prj_existing", "--scope", "team_1"],
    expect.objectContaining({ cwd: root, nonInteractive: true, timeoutMs: 15_000 }),
  );
  expect(capture).toHaveBeenNthCalledWith(
    2,
    [
      "traces",
      "config",
      "set",
      "any",
      "100",
      "--json",
      "--project",
      "prj_existing",
      "--scope",
      "team_1",
    ],
    expect.objectContaining({ cwd: root, nonInteractive: true, timeoutMs: 15_000 }),
  );
  expect(prompter.log.warning).not.toHaveBeenCalled();
});

it.each([
  JSON.stringify([{ environment: "production", sampleRate: 50 }]),
  JSON.stringify({ rules: [{}] }),
])("leaves existing sampling rules unchanged", async (stdout) => {
  const root = await projectRoot();
  capture.mockResolvedValue({ ok: true, stdout });
  const { prompter, selectMessages } = createFakePrompter();

  await offerTraceSampling(root, "prj_existing", prompter);

  expect(selectMessages).toEqual([]);
  expect(capture).toHaveBeenCalledOnce();
});

it("remembers a decline for the linked project, then offers again if the link changes", async () => {
  const root = await projectRoot();
  capture.mockResolvedValue({ ok: true, stdout: "[]" });
  const first = createFakePrompter({ single: () => "decline" });

  await offerTraceSampling(root, "prj_existing", first.prompter);
  expect(JSON.parse(await readFile(join(root, ".eve", "trace-sampling.json"), "utf8"))).toEqual({
    version: 1,
    orgId: "team_1",
    projectId: "prj_existing",
    decision: "declined",
  });

  await offerTraceSampling(root, "prj_existing", createFakePrompter().prompter);
  expect(capture).toHaveBeenCalledOnce();
  await writeFile(
    join(root, ".vercel", "project.json"),
    JSON.stringify({ orgId: "team_1", projectId: "prj_other" }),
  );
  const next = createFakePrompter({ single: () => "decline" });
  await offerTraceSampling(root, "prj_other", next.prompter);
  expect(next.selectMessages).toEqual(["Enable tracing for Agent Runs?"]);
  expect(capture).toHaveBeenCalledTimes(2);
});

it.each([
  { stdout: "not-json", ok: true },
  { stdout: "{}", ok: true },
  { stdout: "", ok: false },
])(
  "does not prompt or mutate settings when the rule lookup is uncertain",
  async ({ stdout, ok }) => {
    const root = await projectRoot();
    capture.mockResolvedValue(
      ok
        ? { ok: true, stdout }
        : { ok: false, failure: { message: "Unavailable", stdout, stderr: "" } },
    );
    const { prompter, selectMessages } = createFakePrompter();

    await offerTraceSampling(root, "prj_existing", prompter);

    expect(selectMessages).toEqual([]);
    expect(prompter.log.warning).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
  },
);

it("leaves a failed enablement retryable and treats prompt cancellation as a deployed outcome", async () => {
  const root = await projectRoot();
  capture
    .mockResolvedValueOnce({ ok: true, stdout: "[]" })
    .mockResolvedValueOnce({
      ok: false,
      failure: { message: "Forbidden", stdout: "", stderr: "" },
    })
    .mockResolvedValueOnce({ ok: true, stdout: "[]" });
  const enable = createFakePrompter({ single: () => "enable" });

  await offerTraceSampling(root, "prj_existing", enable.prompter);
  expect(enable.prompter.log.warning).toHaveBeenCalledOnce();

  const cancel = createFakePrompter({
    single: () => Promise.reject(new WizardCancelledError()),
  });
  await expect(offerTraceSampling(root, "prj_existing", cancel.prompter)).resolves.toBeUndefined();
  expect(cancel.selectMessages).toEqual(["Enable tracing for Agent Runs?"]);
  expect(capture).toHaveBeenCalledTimes(3);
});

it("does not act on a link that differs from the deployed project", async () => {
  const root = await projectRoot();
  await offerTraceSampling(root, "prj_other", createFakePrompter().prompter);
  expect(capture).not.toHaveBeenCalled();
});
