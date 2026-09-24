import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { readVercelCliToken } from "#internal/model-auth/vercel-cli.js";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { WizardCancelledError } from "#setup/step.js";

import { offerTraceSampling } from "./vercel-trace-sampling.js";

vi.mock("#internal/model-auth/vercel-cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/model-auth/vercel-cli.js")>()),
  readVercelCliToken: vi.fn(),
}));

const token = vi.mocked(readVercelCliToken);
const roots: string[] = [];
const URL = "https://api.vercel.com/v1/drains/tracing/config?projectId=prj_existing&teamId=team_1";

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

function tracingConfig(sampling: unknown[] = [], enabled = false): Response {
  return new Response(JSON.stringify({ enabled, sampling }));
}

beforeEach(() => {
  token.mockReset();
  token.mockResolvedValue("vercel-token");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("offers to enable 100% sampling when an existing project has no rules", async () => {
  const root = await projectRoot();
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) =>
    options.method === "PUT" ? new Response(null, { status: 204 }) : tracingConfig(),
  );
  vi.stubGlobal("fetch", fetchMock);
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
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    URL,
    expect.objectContaining({
      method: "GET",
      headers: { authorization: "Bearer vercel-token" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(2, URL, expect.objectContaining({ method: "GET" }));
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    URL,
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ enabled: true, sampling: [{ type: "head_sampling", rate: 1 }] }),
      headers: {
        authorization: "Bearer vercel-token",
        "content-type": "application/json",
      },
    }),
  );
  expect(prompter.log.warning).not.toHaveBeenCalled();
});

it.each([true, false])("leaves existing sampling rules unchanged (enabled=%s)", async (enabled) => {
  const root = await projectRoot();
  const fetchMock = vi.fn(async () =>
    tracingConfig([{ type: "head_sampling", rate: 0.5 }], enabled),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { prompter, selectMessages } = createFakePrompter();

  await offerTraceSampling(root, "prj_existing", prompter);

  expect(selectMessages).toEqual([]);
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("remembers a decline for the linked project, then offers again if the link changes", async () => {
  const root = await projectRoot();
  const fetchMock = vi.fn(async () => tracingConfig());
  vi.stubGlobal("fetch", fetchMock);
  const first = createFakePrompter({ single: () => "decline" });

  await offerTraceSampling(root, "prj_existing", first.prompter);
  expect(JSON.parse(await readFile(join(root, ".eve", "trace-sampling.json"), "utf8"))).toEqual({
    version: 1,
    orgId: "team_1",
    projectId: "prj_existing",
    decision: "declined",
  });

  await offerTraceSampling(root, "prj_existing", createFakePrompter().prompter);
  expect(fetchMock).toHaveBeenCalledOnce();
  await writeFile(
    join(root, ".vercel", "project.json"),
    JSON.stringify({ orgId: "team_1", projectId: "prj_other" }),
  );
  const next = createFakePrompter({ single: () => "decline" });
  await offerTraceSampling(root, "prj_other", next.prompter);
  expect(next.selectMessages).toEqual(["Enable tracing for Agent Runs?"]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "https://api.vercel.com/v1/drains/tracing/config?projectId=prj_other&teamId=team_1",
    expect.objectContaining({ method: "GET" }),
  );
});

it.each([
  () => new Response("not-json"),
  () => new Response("{}"),
  () => new Response(null, { status: 403 }),
])("does not prompt or mutate settings when the API response is uncertain", async (response) => {
  const root = await projectRoot();
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetchMock);
  const { prompter, selectMessages } = createFakePrompter();

  await offerTraceSampling(root, "prj_existing", prompter);

  expect(selectMessages).toEqual([]);
  expect(prompter.log.warning).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("does not call the API without credentials", async () => {
  const root = await projectRoot();
  token.mockResolvedValue(undefined);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { prompter, selectMessages } = createFakePrompter();

  await offerTraceSampling(root, "prj_existing", prompter);

  expect(selectMessages).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(prompter.log.warning).toHaveBeenCalledOnce();
});

it("rechecks before writing and preserves a rule added while the prompt was open", async () => {
  const root = await projectRoot();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(tracingConfig())
    .mockResolvedValueOnce(tracingConfig([{ type: "head_sampling", rate: 0.5 }], true));
  vi.stubGlobal("fetch", fetchMock);
  const { prompter } = createFakePrompter({ single: () => "enable" });

  await offerTraceSampling(root, "prj_existing", prompter);

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(prompter.log.warning).not.toHaveBeenCalled();
});

it("leaves a failed enablement retryable and treats prompt cancellation as a deployed outcome", async () => {
  const root = await projectRoot();
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) =>
    options.method === "PUT" ? new Response(null, { status: 403 }) : tracingConfig(),
  );
  vi.stubGlobal("fetch", fetchMock);
  const enable = createFakePrompter({ single: () => "enable" });

  await offerTraceSampling(root, "prj_existing", enable.prompter);
  expect(enable.prompter.log.warning).toHaveBeenCalledOnce();

  const cancel = createFakePrompter({
    single: () => Promise.reject(new WizardCancelledError()),
  });
  await expect(offerTraceSampling(root, "prj_existing", cancel.prompter)).resolves.toBeUndefined();
  expect(cancel.selectMessages).toEqual(["Enable tracing for Agent Runs?"]);
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("does not write if the API recheck fails after consent", async () => {
  const root = await projectRoot();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(tracingConfig())
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  const { prompter } = createFakePrompter({ single: () => "enable" });

  await offerTraceSampling(root, "prj_existing", prompter);

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(prompter.log.warning).toHaveBeenCalledWith(
    expect.stringContaining("could not verify trace sampling"),
  );
});

it("does not act on a link that differs from the deployed project", async () => {
  const root = await projectRoot();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await offerTraceSampling(root, "prj_other", createFakePrompter().prompter);
  expect(fetchMock).not.toHaveBeenCalled();
});
