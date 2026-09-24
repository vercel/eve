import { beforeEach, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { captureVercel } from "#setup/primitives/run-vercel.js";

import { configureTraceSampling } from "./vercel-trace-sampling.js";

vi.mock("#setup/primitives/run-vercel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#setup/primitives/run-vercel.js")>()),
  captureVercel: vi.fn(),
}));

const capture = vi.mocked(captureVercel);
const link = { orgId: "team_123", projectId: "prj_new" };

beforeEach(() => capture.mockReset());

it("sets 100% sampling for a new project through Vercel's project rules", async () => {
  capture.mockResolvedValue({ ok: true, stdout: "{}" });
  const { prompter } = createFakePrompter();

  await configureTraceSampling(link, "/app/my-agent", prompter);

  expect(capture).toHaveBeenCalledWith(
    [
      "traces",
      "config",
      "set",
      "any",
      "100",
      "--json",
      "--project",
      "prj_new",
      "--scope",
      "team_123",
    ],
    {
      cwd: "/app/my-agent",
      nonInteractive: true,
      signal: undefined,
      timeoutMs: 15_000,
    },
  );
  expect(prompter.log.warning).not.toHaveBeenCalled();
});

it("warns but does not fail when Vercel rejects the rule", async () => {
  capture.mockResolvedValue({
    ok: false,
    failure: { message: "Forbidden", stdout: "", stderr: "" },
  });
  const { prompter } = createFakePrompter();

  await configureTraceSampling(link, "/app/my-agent", prompter);

  expect(prompter.log.warning).toHaveBeenCalledWith(
    expect.stringContaining("100% for all environments"),
  );
});
