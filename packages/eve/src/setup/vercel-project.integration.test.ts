import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { createPromptCommandOutput } from "#setup/cli/index.js";
import { captureVercel, runVercel } from "#setup/primitives/index.js";

import { readProjectLink } from "./project-resolution.js";
import { linkProject } from "./vercel-project.js";

vi.mock("#setup/primitives/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#setup/primitives/index.js")>()),
  captureVercel: vi.fn(),
  runVercel: vi.fn(),
}));

const mockedCaptureVercel = vi.mocked(captureVercel);
const mockedRunVercel = vi.mocked(runVercel);
const roots: string[] = [];

beforeEach(() => {
  mockedCaptureVercel.mockReset();
  mockedRunVercel.mockReset();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("linkProject", () => {
  it("rejects a legacy .now link before any remote mutation", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "eve-vercel-project-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".now"));
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        projectRoot,
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
      ),
    ).rejects.toThrow(
      "Legacy Vercel link directory `.now` is not supported. Remove `.now` before linking this project.",
    );
    expect(mockedCaptureVercel).not.toHaveBeenCalled();
    expect(mockedRunVercel).not.toHaveBeenCalled();
  });
});

describe("readProjectLink", () => {
  it("rejects legacy .now metadata instead of treating the directory as unlinked", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "eve-vercel-project-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".now"));
    await writeFile(
      join(projectRoot, ".now", "project.json"),
      JSON.stringify({ projectId: "prj_legacy", orgId: "team_legacy" }),
    );

    await expect(readProjectLink(projectRoot)).rejects.toThrow(
      "Legacy Vercel link directory `.now` is not supported. Remove `.now` before linking this project.",
    );
  });
});
