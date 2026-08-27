import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPromptCommandOutput } from "#setup/cli/index.js";
import { captureVercel, type VercelCaptureResult } from "#setup/primitives/index.js";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { readProjectLink } from "./project-resolution.js";
import { resolveVercelHostFrameworkPreset } from "./scaffold/index.js";
import { syncHostFrameworkPreset } from "./vercel-project-framework.js";

vi.mock("#setup/primitives/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#setup/primitives/index.js")>();
  return { ...original, captureVercel: vi.fn() };
});

vi.mock("./project-resolution.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./project-resolution.js")>();
  return { ...original, readProjectLink: vi.fn() };
});

vi.mock("./scaffold/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./scaffold/index.js")>();
  return { ...original, resolveVercelHostFrameworkPreset: vi.fn() };
});

const mockedCaptureVercel = vi.mocked(captureVercel);
const mockedReadProjectLink = vi.mocked(readProjectLink);
const mockedResolvePreset = vi.mocked(resolveVercelHostFrameworkPreset);

const captured = (value: unknown): VercelCaptureResult => ({
  ok: true,
  stdout: typeof value === "string" ? value : JSON.stringify(value),
});

const LINK = { orgId: "team_demo", projectId: "prj_demo", projectName: "demo" };

/** True when `captureVercel` received a project-framework PATCH to `framework`. */
function patchedFrameworkTo(framework: string): boolean {
  return mockedCaptureVercel.mock.calls.some(
    ([args]) =>
      Array.isArray(args) &&
      args.includes("--method") &&
      args.includes("PATCH") &&
      args.includes(`framework=${framework}`),
  );
}

const failed = (message: string): VercelCaptureResult => ({
  ok: false,
  failure: { stdout: "", stderr: message, message },
});

/** Answer the framework GET with `current`; succeed any PATCH. */
function stubCurrentFramework(current: string | undefined): void {
  mockedCaptureVercel.mockImplementation(async (args) => {
    if (Array.isArray(args) && args.includes("--method")) return captured("{}");
    return captured(current === undefined ? {} : { framework: current });
  });
}

beforeEach(() => {
  mockedCaptureVercel.mockReset();
  mockedReadProjectLink.mockReset();
  mockedResolvePreset.mockReset();
  mockedReadProjectLink.mockResolvedValue(LINK);
  stubCurrentFramework("eve");
});

describe("syncHostFrameworkPreset", () => {
  it("no-ops when the project declares no host framework", async () => {
    mockedResolvePreset.mockResolvedValue(undefined);
    const { prompter, selectMessages } = createFakePrompter();

    await syncHostFrameworkPreset(prompter, "/app", createPromptCommandOutput(prompter.log), {});

    expect(mockedCaptureVercel).not.toHaveBeenCalled();
    expect(selectMessages).toEqual([]);
  });

  it("no-ops when the directory is not linked to a Vercel project", async () => {
    mockedResolvePreset.mockResolvedValue("nextjs");
    mockedReadProjectLink.mockResolvedValue(undefined);
    const { prompter, selectMessages } = createFakePrompter();

    await syncHostFrameworkPreset(prompter, "/app", createPromptCommandOutput(prompter.log), {});

    expect(mockedCaptureVercel).not.toHaveBeenCalled();
    expect(selectMessages).toEqual([]);
  });

  it("no-ops when the linked preset already matches the host framework", async () => {
    mockedResolvePreset.mockResolvedValue("nextjs");
    stubCurrentFramework("nextjs");
    const { prompter, selectMessages } = createFakePrompter();

    await syncHostFrameworkPreset(prompter, "/app", createPromptCommandOutput(prompter.log), {});

    expect(selectMessages).toEqual([]);
    expect(patchedFrameworkTo("nextjs")).toBe(false);
  });

  it("switches a stale preset directly, without prompting, and notes the change", async () => {
    mockedResolvePreset.mockResolvedValue("nextjs");
    const { prompter, selectMessages } = createFakePrompter();

    await syncHostFrameworkPreset(prompter, "/app", createPromptCommandOutput(prompter.log), {});

    expect(selectMessages).toEqual([]);
    expect(patchedFrameworkTo("nextjs")).toBe(true);
    expect(prompter.log.info).toHaveBeenCalledWith(expect.stringContaining("Next.js"));
    expect(prompter.log.warning).not.toHaveBeenCalled();
  });

  it("warns instead of throwing when the framework lookup fails", async () => {
    mockedResolvePreset.mockResolvedValue("nextjs");
    mockedCaptureVercel.mockResolvedValue(failed("network exploded"));
    const { prompter, selectMessages } = createFakePrompter();

    await expect(
      syncHostFrameworkPreset(prompter, "/app", createPromptCommandOutput(prompter.log), {}),
    ).resolves.toBeUndefined();

    expect(selectMessages).toEqual([]);
    expect(patchedFrameworkTo("nextjs")).toBe(false);
    expect(prompter.log.warning).toHaveBeenCalledWith(expect.stringContaining("Framework Preset"));
  });

  it("re-throws instead of warning when the operation was aborted", async () => {
    mockedResolvePreset.mockResolvedValue("nextjs");
    mockedCaptureVercel.mockRejectedValue(new Error("The operation was aborted"));
    const controller = new AbortController();
    controller.abort();
    const { prompter } = createFakePrompter();

    await expect(
      syncHostFrameworkPreset(prompter, "/app", createPromptCommandOutput(prompter.log), {
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");

    expect(prompter.log.warning).not.toHaveBeenCalled();
  });

  it("warns instead of throwing when applying the preset fails", async () => {
    mockedResolvePreset.mockResolvedValue("nextjs");
    mockedCaptureVercel.mockImplementation(async (args) => {
      if (Array.isArray(args) && args.includes("--method")) return failed("patch denied");
      return captured({ framework: "eve" });
    });
    const { prompter } = createFakePrompter();

    await expect(
      syncHostFrameworkPreset(prompter, "/app", createPromptCommandOutput(prompter.log), {}),
    ).resolves.toBeUndefined();

    expect(prompter.log.info).not.toHaveBeenCalled();
    expect(prompter.log.warning).toHaveBeenCalledWith(expect.stringContaining("Framework Preset"));
  });
});
