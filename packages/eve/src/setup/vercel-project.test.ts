import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPromptCommandOutput, WHIMSY_POOLS } from "#setup/cli/index.js";
import { captureVercel, runVercel, type VercelCaptureResult } from "#setup/primitives/index.js";

import { HumanActionRequiredError } from "#setup/human-action.js";
import type { Prompter, PrompterValue, SingleSelectOptions } from "./prompter.js";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { readProjectLink } from "./project-resolution.js";
import {
  assertNewProjectNameAvailable,
  getVercelAuthStatus,
  linkProject,
  pickNewProjectName,
  pickProject,
  pickTeam,
  requireAuth,
  resolveProjectByNameOrId,
  validateTeam,
  vercelAuthBlockerReason,
} from "./vercel-project.js";

vi.mock("#setup/primitives/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#setup/primitives/index.js")>();
  return {
    ...original,
    captureVercel: vi.fn(),
    runVercel: vi.fn(),
  };
});

vi.mock("./project-resolution.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./project-resolution.js")>();
  return {
    ...original,
    readProjectLink: vi.fn(),
  };
});

const mockedCaptureVercel = vi.mocked(captureVercel);
const mockedRunVercel = vi.mocked(runVercel);
const mockedReadProjectLink = vi.mocked(readProjectLink);

/** Wraps stdout as a successful capture result for the mocked `captureVercel`. */
const captured = (value: unknown): VercelCaptureResult => ({
  ok: true,
  stdout: typeof value === "string" ? value : JSON.stringify(value),
});

const failedCapture = (stdout: string, stderr = ""): VercelCaptureResult => ({
  ok: false,
  failure: {
    code: 1,
    message: "vercel api exited with code 1.",
    stderr,
    stdout,
  },
});

/** Minimal prompter whose spinner and one chosen select can be observed. */
function createSpyPrompter(overrides: {
  spinner?: NonNullable<Prompter["log"]["spinner"]>;
  single?: (opts: SingleSelectOptions<PrompterValue>) => PrompterValue | Promise<PrompterValue>;
}): Prompter {
  const base = createFakePrompter(overrides.single ? { single: overrides.single } : {}).prompter;
  return { ...base, log: { ...base.log, spinner: overrides.spinner } };
}

beforeEach(() => {
  mockedCaptureVercel.mockReset();
  mockedRunVercel.mockReset();
  mockedRunVercel.mockResolvedValue(true);
  mockedReadProjectLink.mockReset();
});

describe("vercelAuthBlockerReason", () => {
  it("maps non-authenticated states to their setup blockers", () => {
    expect([
      vercelAuthBlockerReason("authenticated"),
      vercelAuthBlockerReason("cli-missing"),
      vercelAuthBlockerReason("logged-out"),
      vercelAuthBlockerReason("unavailable"),
    ]).toEqual([
      undefined,
      "Vercel CLI not found, see /vc:install",
      "Log in to Vercel first, see /vc:login",
      "Couldn't reach Vercel, check your connection",
    ]);
  });
});

describe("getVercelAuthStatus", () => {
  it("reports authenticated when whoami succeeds", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(captured("acme\n"));
    await expect(getVercelAuthStatus("/tmp/eve-agent")).resolves.toBe("authenticated");
  });

  it("reports logged-out when whoami ran but exited non-zero", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(failedCapture("", "Error: Not authenticated"));
    await expect(getVercelAuthStatus("/tmp/eve-agent")).resolves.toBe("logged-out");
  });

  it("reports cli-missing — not logged-out — when the binary is absent (ENOENT)", async () => {
    mockedCaptureVercel.mockResolvedValueOnce({
      ok: false,
      failure: { errno: "ENOENT", stderr: "", stdout: "", message: "Vercel CLI not found." },
    });
    await expect(getVercelAuthStatus("/tmp/eve-agent")).resolves.toBe("cli-missing");
  });

  it("reports unavailable — not logged-out — on a transient fault (DNS/network)", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(
      failedCapture("", "Error: getaddrinfo ENOTFOUND api.vercel.com"),
    );
    await expect(getVercelAuthStatus("/tmp/eve-agent")).resolves.toBe("unavailable");
  });
});

describe("requireAuth", () => {
  it("throws a CLI-missing action (not a login action) on ENOENT", async () => {
    mockedCaptureVercel.mockResolvedValueOnce({
      ok: false,
      failure: { errno: "ENOENT", stderr: "", stdout: "", message: "Vercel CLI not found." },
    });
    await expect(requireAuth("/tmp/eve-agent")).rejects.toMatchObject({
      name: "HumanActionRequiredError",
      action: { kind: "vercel-cli-missing", command: "npm i -g vercel@latest" },
    });
  });

  it("throws a login action when whoami reports no credentials", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(failedCapture("", "Error: Not authenticated"));
    await expect(requireAuth("/tmp/eve-agent")).rejects.toMatchObject({
      action: { kind: "vercel-login" },
    });
  });

  it("throws a plain error (not a login action) on a transient fault", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(
      failedCapture("", "Error: getaddrinfo ENOTFOUND api.vercel.com"),
    );
    const error = await requireAuth("/tmp/eve-agent").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(HumanActionRequiredError);
    expect(error).toMatchObject({
      message: expect.stringContaining("Couldn't verify your Vercel"),
    });
  });
});

describe("pickTeam", () => {
  it("shows a spinner around the team pull and stops it before selection", async () => {
    stubVercel({
      teams: [
        { slug: "team-a", name: "Team A", current: true },
        { slug: "team-b", name: "Team B", current: false },
      ],
    });
    const stop = vi.fn();
    const spinner = vi.fn((_message: string) => ({ stop }));
    const prompter = createSpyPrompter({ spinner, single: async () => "team-b" });

    await expect(pickTeam(prompter, "/tmp/eve-agent", undefined)).resolves.toBe("team-b");
    // The copy is randomized per run; assert pool membership, not one phrasing.
    expect(WHIMSY_POOLS.teams).toContain(spinner.mock.calls[0]?.[0]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops the spinner even when the team pull throws", async () => {
    mockedCaptureVercel.mockRejectedValue(new Error("network down"));
    const stop = vi.fn();
    const spinner = vi.fn((_message: string) => ({ stop }));
    const prompter = createSpyPrompter({ spinner });

    await expect(pickTeam(prompter, "/tmp/eve-agent", undefined)).rejects.toThrow("network down");
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("pickProject", () => {
  it("labels the spinner with the team and stops it before selection", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(JSON.stringify({ projects: [{ name: "p1", id: "prj_p1", updatedAt: 1 }] })),
    );
    const stop = vi.fn();
    const spinner = vi.fn((_message: string) => ({ stop }));
    const prompter = createSpyPrompter({ spinner, single: async () => "prj_p1" });

    await expect(pickProject(prompter, "/tmp/eve-agent", "team-a")).resolves.toEqual({
      kind: "existing",
      project: { projectId: "prj_p1", projectName: "p1" },
      team: "team-a",
    });
    // Randomized copy: the team name must still anchor the step.
    expect(spinner.mock.calls[0]?.[0]).toContain("team-a");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("falls back to one ranked project-search page when no exact project exists", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        captured({
          projects: [
            { id: "prj_old", name: "older" },
            { id: "prj_new", name: "newer" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(captured({ projects: [{ id: "prj_found", name: "found" }] }));
    const single = vi
      .fn()
      .mockImplementationOnce((options) => {
        expect(options.search).toBe(true);
        expect(options.placeholder).toBe("type to filter projects");
        expect(options.options.map((option: { label: string }) => option.label)).toEqual([
          "older",
          "newer",
        ]);
        return "\0search-project:found";
      })
      .mockImplementationOnce((options) => {
        expect(options.search).toBe(true);
        expect(options.options.map((option: { label: string }) => option.label)).toEqual([
          "found",
          "older",
          "newer",
        ]);
        return "prj_found";
      });
    const { prompter } = createFakePrompter({ single });

    await expect(pickProject(prompter, "/repo", "team-a")).resolves.toEqual({
      kind: "existing",
      project: { projectId: "prj_found", projectName: "found" },
      team: "team-a",
    });
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      ["api", "/v9/projects/found", "--scope", "team-a", "--raw"],
      { cwd: "/repo", signal: undefined, timeoutMs: 15_000 },
    );
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      3,
      ["project", "ls", "--format", "json", "--scope", "team-a", "--filter", "found"],
      { cwd: "/repo", signal: undefined, timeoutMs: 15_000 },
    );
  });

  it("loads the next search page when the first ranked page is incomplete", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(captured({ projects: [{ id: "prj_recent", name: "recent" }] }))
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(
        captured({
          projects: [{ id: "prj_infix", name: "env" }],
          pagination: { next: 7 },
        }),
      )
      .mockResolvedValueOnce(
        captured({
          projects: [{ id: "prj_prefix", name: "v-api" }],
          pagination: { next: null },
        }),
      );
    const single = vi
      .fn()
      .mockImplementationOnce(() => "\0search-project:v")
      .mockImplementationOnce((options) => {
        const more = options.options.find((option: { label: string }) =>
          option.label.startsWith("Show more matches"),
        );
        if (more === undefined) throw new Error("Expected a project-search continuation option.");
        return more.value;
      })
      .mockImplementationOnce((options) => {
        expect(options.options.map((option: { label: string }) => option.label)).toEqual([
          "v-api",
          "env",
          "recent",
        ]);
        return "prj_prefix";
      });
    const { prompter } = createFakePrompter({ single });

    await expect(pickProject(prompter, "/repo", "team-a")).resolves.toEqual({
      kind: "existing",
      project: { projectId: "prj_prefix", projectName: "v-api" },
      team: "team-a",
    });
  });

  it("promotes exact project matches in the repainting picker", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(captured({ projects: [{ id: "prj_versioned", name: "versioned" }] }))
      .mockResolvedValueOnce(captured({ id: "prj_v", name: "v" }));
    const single = vi.fn(async (options) => {
      const loaded = await options.searchAction.load("v");
      expect(loaded.map((option: { label: string }) => option.label)).toEqual(["v", "versioned"]);
      return "prj_v";
    });
    const { prompter } = createFakePrompter({ single });

    await expect(pickProject(prompter, "/repo", "team-a")).resolves.toEqual({
      kind: "existing",
      project: { projectId: "prj_v", projectName: "v" },
      team: "team-a",
    });
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(2);
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      ["api", "/v9/projects/v", "--scope", "team-a", "--raw"],
      { cwd: "/repo", signal: undefined, timeoutMs: 15_000 },
    );
  });

  it("refreshes a recent project when a search result returns it", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(captured({ projects: [{ id: "prj_recent", name: "recent" }] }))
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(
        captured({
          projects: [
            { id: "prj_recent", name: "recent-updated" },
            { id: "prj_found", name: "found" },
          ],
        }),
      );
    const single = vi
      .fn()
      .mockImplementationOnce(() => "\0search-project:found")
      .mockImplementationOnce((options) => {
        expect(options.options.map((option: { label: string }) => option.label)).toEqual([
          "found",
          "recent-updated",
        ]);
        expect(options.initialValue).toBe("prj_found");
        return "prj_found";
      });
    const { prompter } = createFakePrompter({ single });

    await expect(pickProject(prompter, "/repo", "team-a")).resolves.toEqual({
      kind: "existing",
      project: { projectId: "prj_found", projectName: "found" },
      team: "team-a",
    });
  });

  it("reports an empty project search and reopens the picker", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(captured({ projects: [{ id: "prj_recent", name: "recent" }] }))
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(captured({ projects: [] }));
    const single = vi
      .fn()
      .mockImplementationOnce((options) => {
        expect(options.search).toBe(true);
        return "\0search-project:missing";
      })
      .mockImplementationOnce((options) => {
        expect(options.options.map((option: { label: string }) => option.label)).toEqual([
          "recent",
        ]);
        expect(options.search).toBe(true);
        expect(options.initialValue).toBe("prj_recent");
        return "prj_recent";
      });
    const { prompter } = createFakePrompter({ single });

    await expect(pickProject(prompter, "/repo", "team-a")).resolves.toEqual({
      kind: "existing",
      project: { projectId: "prj_recent", projectName: "recent" },
      team: "team-a",
    });
    expect(prompter.note).toHaveBeenCalledWith('No projects matched "missing" in team-a.');
  });
});

describe("pickNewProjectName", () => {
  it("prompts for a replacement when the default project name already exists", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        captured(JSON.stringify({ id: "prj_existing", name: "my-agent", accountId: "team-a" })),
      )
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      );
    const text = vi.fn(() => "my-agent-2");
    const { prompter } = createFakePrompter({ text });

    await expect(
      pickNewProjectName(prompter, "/tmp/eve-agent", "team-a", "my-agent"),
    ).resolves.toBe("my-agent-2");
    // The collision rides the question as a notice (gone once a free name
    // lands), not a persistent log line.
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "New project name",
        notices: [
          expect.objectContaining({
            tone: "warning",
            text: expect.stringContaining("already exists in"),
          }),
        ],
      }),
    );
    expect(prompter.note).not.toHaveBeenCalled();
  });
});

describe("assertNewProjectNameAvailable", () => {
  it("uses an exact project lookup instead of a paginated list", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(JSON.stringify({ id: "prj_existing", name: "my-agent", accountId: "team-a" })),
    );

    await expect(
      assertNewProjectNameAvailable("/tmp/eve-agent", "team-a", "my-agent"),
    ).rejects.toThrow(
      'Vercel project "my-agent" already exists in team-a. Pass --project my-agent to link it, or choose a different project name.',
    );
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["api", "/v9/projects/my-agent", "--scope", "team-a", "--raw"],
      { cwd: "/tmp/eve-agent", signal: undefined, timeoutMs: 15_000 },
    );
  });

  it("treats a proven 404 as available", async () => {
    mockedCaptureVercel.mockResolvedValue(
      failedCapture(JSON.stringify({ error: { code: "not_found", message: "Project not found" } })),
    );

    await expect(
      assertNewProjectNameAvailable("/tmp/eve-agent", "team-a", "my-agent"),
    ).resolves.toBeUndefined();
  });

  it("does not turn lookup failures into availability", async () => {
    mockedCaptureVercel.mockResolvedValue(
      failedCapture(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } })),
    );

    await expect(
      assertNewProjectNameAvailable("/tmp/eve-agent", "team-a", "my-agent"),
    ).rejects.toThrow("Could not resolve project");
  });
});

describe("resolveProjectByNameOrId", () => {
  it("maps Vercel API fields to the stable project identity", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(JSON.stringify({ id: "prj_existing", name: "my-agent", accountId: "team_a" })),
    );

    await expect(resolveProjectByNameOrId("/tmp/eve-agent", "team-a", "my-agent")).resolves.toEqual(
      { projectId: "prj_existing", projectName: "my-agent" },
    );
  });

  it("bounds the direct lookup with the project request deadline", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured({ id: "prj_existing", name: "my-agent", accountId: "team_a" }),
    );

    await resolveProjectByNameOrId("/tmp/eve-agent", "team-a", "my-agent");

    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["api", "/v9/projects/my-agent", "--scope", "team-a", "--raw"],
      { cwd: "/tmp/eve-agent", signal: undefined, timeoutMs: 15_000 },
    );
  });
});

describe("linkProject", () => {
  it("links a resolved existing project through `vercel link`", async () => {
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        {
          kind: "existing",
          project: { projectId: "prj_existing", projectName: "my-agent" },
          team: "team-a",
        },
        createPromptCommandOutput(prompter.log),
      ),
    ).resolves.toEqual({ projectId: "prj_existing", projectName: "my-agent" });

    expect(mockedCaptureVercel).not.toHaveBeenCalled();
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["link", "--project", "prj_existing", "--scope", "team-a", "--yes"],
      expect.objectContaining({ cwd: "/tmp/eve-agent", nonInteractive: true }),
    );
  });

  it("surfaces a failed `vercel link` as an incomplete link", async () => {
    mockedRunVercel.mockResolvedValue(false);
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        {
          kind: "existing",
          project: { projectId: "prj_existing", projectName: "my-agent" },
          team: "team-a",
        },
        createPromptCommandOutput(prompter.log),
      ),
    ).resolves.toBeUndefined();
  });

  it("fails a new-project plan when that project name already exists", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(JSON.stringify({ id: "prj_existing", name: "my-agent", accountId: "team-a" })),
    );
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
      ),
    ).rejects.toThrow(
      'Vercel project "my-agent" already exists in team-a. Pass --project my-agent to link it, or choose a different project name.',
    );
    expect(mockedRunVercel).not.toHaveBeenCalled();
  });

  it("creates and links an available new project", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(captured({ framework: "eve" }));
    mockedReadProjectLink.mockResolvedValueOnce({
      orgId: "team-a",
      projectId: "prj_new",
      projectName: "my-agent",
    });
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
      ),
    ).resolves.toEqual({ projectId: "prj_new", projectName: "my-agent" });
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(2);
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      1,
      ["api", "/v9/projects/my-agent", "--scope", "team-a", "--raw"],
      { cwd: "/tmp/eve-agent", signal: undefined, timeoutMs: 15_000 },
    );
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      ["api", "/v9/projects/prj_new", "--scope", "team-a", "--raw"],
      { cwd: "/tmp/eve-agent", signal: undefined, timeoutMs: 15_000 },
    );
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["link", "--project", "my-agent", "--scope", "team-a", "--yes"],
      expect.objectContaining({ cwd: "/tmp/eve-agent", nonInteractive: true }),
    );
  });

  it("uses the requested project name when Vercel's link metadata omits the name", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(captured({ framework: "eve" }));
    mockedReadProjectLink.mockResolvedValueOnce({
      orgId: "team-a",
      projectId: "prj_new",
    });
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
      ),
    ).resolves.toEqual({ projectId: "prj_new", projectName: "my-agent" });
  });

  it("keeps a detected host framework when the framework-specific eve import is present", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(captured({ framework: "nextjs" }));
    mockedReadProjectLink.mockResolvedValueOnce({
      orgId: "team-a",
      projectId: "prj_new",
      projectName: "my-agent",
    });
    const detectFrameworkIntegrationImport = vi.fn(async () => true);
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
        { detectFrameworkIntegrationImport },
      ),
    ).resolves.toEqual({ projectId: "prj_new", projectName: "my-agent" });

    expect(detectFrameworkIntegrationImport).toHaveBeenCalledWith("/tmp/eve-agent", "eve/next");
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(2);
  });

  it.each([
    { framework: "nuxtjs", importSpecifier: "eve/nuxt" },
    { framework: "sveltekit", importSpecifier: "eve/sveltekit" },
  ])("keeps a detected $framework project when $importSpecifier is present", async (testCase) => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(captured({ framework: testCase.framework }));
    mockedReadProjectLink.mockResolvedValueOnce({
      orgId: "team-a",
      projectId: "prj_new",
      projectName: "my-agent",
    });
    const detectFrameworkIntegrationImport = vi.fn(async () => true);
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
        { detectFrameworkIntegrationImport },
      ),
    ).resolves.toEqual({ projectId: "prj_new", projectName: "my-agent" });

    expect(detectFrameworkIntegrationImport).toHaveBeenCalledWith(
      "/tmp/eve-agent",
      testCase.importSpecifier,
    );
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(2);
  });

  it("keeps a detected host framework when the user confirms the framework-specific eve import", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(captured({ framework: "nextjs" }));
    mockedReadProjectLink.mockResolvedValueOnce({
      orgId: "team-a",
      projectId: "prj_new",
      projectName: "my-agent",
    });
    const single = vi.fn(() => true);
    const detectFrameworkIntegrationImport = vi.fn(async () => false);
    const { prompter } = createFakePrompter({ single });

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
        { detectFrameworkIntegrationImport },
      ),
    ).resolves.toEqual({ projectId: "prj_new", projectName: "my-agent" });

    expect(single).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Vercel detected Next.js. Is this project using eve/next?",
      }),
    );
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(2);
  });

  it("sets the project framework to eve when the user rejects a detected host framework", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(captured({ framework: "nextjs" }))
      .mockResolvedValueOnce(captured({ framework: "eve" }));
    mockedReadProjectLink.mockResolvedValueOnce({
      orgId: "team-a",
      projectId: "prj_new",
      projectName: "my-agent",
    });
    const detectFrameworkIntegrationImport = vi.fn(async () => false);
    const { prompter } = createFakePrompter({ single: () => false });

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
        { detectFrameworkIntegrationImport },
      ),
    ).resolves.toEqual({ projectId: "prj_new", projectName: "my-agent" });

    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      3,
      [
        "api",
        "/v9/projects/prj_new",
        "--scope",
        "team-a",
        "--method",
        "PATCH",
        "--raw-field",
        "framework=eve",
        "--raw",
      ],
      {
        cwd: "/tmp/eve-agent",
        onOutput: expect.any(Function),
        signal: undefined,
        timeoutMs: 15_000,
      },
    );
  });

  it("sets the project framework to eve when Vercel returns no framework", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(captured({ framework: null }))
      .mockResolvedValueOnce(captured({ framework: "eve" }));
    mockedReadProjectLink.mockResolvedValueOnce({
      orgId: "team-a",
      projectId: "prj_new",
      projectName: "my-agent",
    });
    const single = vi.fn(() => {
      throw new Error("Unexpected prompt for missing framework.");
    });
    const detectFrameworkIntegrationImport = vi.fn(async () => true);
    const { prompter } = createFakePrompter({ single });

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
        { detectFrameworkIntegrationImport },
      ),
    ).resolves.toEqual({ projectId: "prj_new", projectName: "my-agent" });

    expect(single).not.toHaveBeenCalled();
    expect(detectFrameworkIntegrationImport).not.toHaveBeenCalled();
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      3,
      [
        "api",
        "/v9/projects/prj_new",
        "--scope",
        "team-a",
        "--method",
        "PATCH",
        "--raw-field",
        "framework=eve",
        "--raw",
      ],
      {
        cwd: "/tmp/eve-agent",
        onOutput: expect.any(Function),
        signal: undefined,
        timeoutMs: 15_000,
      },
    );
  });

  it("sets the project framework to eve in headless mode when a detected host framework is ambiguous", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(captured({ framework: "nextjs" }))
      .mockResolvedValueOnce(captured({ framework: "eve" }));
    mockedReadProjectLink.mockResolvedValueOnce({
      orgId: "team-a",
      projectId: "prj_new",
      projectName: "my-agent",
    });
    const single = vi.fn(() => {
      throw new Error("Unexpected prompt in headless framework resolution.");
    });
    const detectFrameworkIntegrationImport = vi.fn(async () => false);
    const { prompter } = createFakePrompter({ single });

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
        { detectFrameworkIntegrationImport, headless: true },
      ),
    ).resolves.toEqual({ projectId: "prj_new", projectName: "my-agent" });

    expect(single).not.toHaveBeenCalled();
    expect(detectFrameworkIntegrationImport).toHaveBeenCalledWith("/tmp/eve-agent", "eve/next");
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      3,
      [
        "api",
        "/v9/projects/prj_new",
        "--scope",
        "team-a",
        "--method",
        "PATCH",
        "--raw-field",
        "framework=eve",
        "--raw",
      ],
      {
        cwd: "/tmp/eve-agent",
        onOutput: expect.any(Function),
        signal: undefined,
        timeoutMs: 15_000,
      },
    );
  });

  it("sets the project framework to eve when the detected framework has no eve integration", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(captured({ framework: "hugo" }))
      .mockResolvedValueOnce(captured({ framework: "eve" }));
    mockedReadProjectLink.mockResolvedValueOnce({
      orgId: "team-a",
      projectId: "prj_new",
      projectName: "my-agent",
    });
    const single = vi.fn(() => {
      throw new Error("Unexpected prompt for unsupported framework.");
    });
    const detectFrameworkIntegrationImport = vi.fn(async () => true);
    const { prompter } = createFakePrompter({ single });

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
        { detectFrameworkIntegrationImport },
      ),
    ).resolves.toEqual({ projectId: "prj_new", projectName: "my-agent" });

    expect(single).not.toHaveBeenCalled();
    expect(detectFrameworkIntegrationImport).not.toHaveBeenCalled();
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      3,
      [
        "api",
        "/v9/projects/prj_new",
        "--scope",
        "team-a",
        "--method",
        "PATCH",
        "--raw-field",
        "framework=eve",
        "--raw",
      ],
      {
        cwd: "/tmp/eve-agent",
        onOutput: expect.any(Function),
        signal: undefined,
        timeoutMs: 15_000,
      },
    );
  });

  it("surfaces a missing Vercel link file after new project creation as an incomplete link", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(
      failedCapture(JSON.stringify({ error: { code: "not_found", message: "Project not found" } })),
    );
    mockedReadProjectLink.mockResolvedValueOnce(undefined);
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
      ),
    ).resolves.toBeUndefined();
  });
});

/** Stubs the `vercel` CLI lookups the provisioning prompts perform. */
function stubVercel(responses: {
  whoami?: string;
  teams?: { name: string; slug: string; current: boolean }[];
  projects?: { name: string; id: string; updatedAt?: number }[];
}): void {
  mockedCaptureVercel.mockImplementation(async (args): Promise<VercelCaptureResult> => {
    const failed = (): VercelCaptureResult => ({
      ok: false,
      failure: {
        code: 1,
        stdout: "",
        stderr: "",
        message: `vercel ${args.join(" ")} exited with code 1.`,
      },
    });
    if (args[0] === "whoami") return { ok: true, stdout: responses.whoami ?? "me" };
    if (args[0] === "teams" && args[1] === "ls") {
      return responses.teams === undefined
        ? failed()
        : { ok: true, stdout: JSON.stringify({ teams: responses.teams }) };
    }
    if (args[0] === "project" && args[1] === "ls") {
      return responses.projects === undefined
        ? failed()
        : {
            ok: true,
            stdout: JSON.stringify({
              projects: responses.projects,
            }),
          };
    }
    return failed();
  });
}

/**
 * A prompter that answers from queued values and records each select message.
 * `selects` answers both plain and searchable single-selects, in call order.
 */
function answeringPrompter(answers: { selects?: PrompterValue[]; texts?: string[] }): {
  prompter: Prompter;
  selectMessages: string[];
} {
  const selects = [...(answers.selects ?? [])];
  const texts = [...(answers.texts ?? [])];
  const unexpected = (): never => {
    throw new Error("Unexpected prompt in a vercel-project test.");
  };
  return createFakePrompter({
    text: () => texts.shift() ?? unexpected(),
    single: () => selects.shift() ?? unexpected(),
  });
}

describe("pickTeam selection", () => {
  it("filters and returns the chosen team slug when several exist", async () => {
    stubVercel({
      teams: [
        { name: "Current", slug: "current", current: true },
        { name: "Other", slug: "other", current: false },
      ],
    });
    const { prompter, selectMessages } = answeringPrompter({ selects: ["other"] });

    await expect(pickTeam(prompter, "/tmp/parent", undefined)).resolves.toBe("other");
    expect(selectMessages).toEqual(["Select your team"]);
  });

  it("uses a current-team-aware heading when the caller supplies one", async () => {
    stubVercel({
      teams: [
        { name: "Current", slug: "current", current: true },
        { name: "Other", slug: "other", current: false },
      ],
    });
    const { prompter, selectMessages } = answeringPrompter({ selects: ["other"] });

    await expect(
      pickTeam(prompter, "/tmp/parent", undefined, {
        selectMessage: (currentTeam) => `Host is unavailable from ${currentTeam}.`,
      }),
    ).resolves.toBe("other");

    expect(selectMessages).toEqual(["Host is unavailable from Current."]);
  });

  it("uses the current scope without prompting when only one team exists", async () => {
    stubVercel({ teams: [{ name: "Solo", slug: "solo", current: true }] });
    const { prompter } = answeringPrompter({});

    await expect(pickTeam(prompter, "/tmp/parent", undefined)).resolves.toBe("solo");
  });
});

describe("pickProject selection", () => {
  it("returns an existing project with its stable id", async () => {
    stubVercel({
      projects: [
        { name: "alpha", id: "prj_a" },
        { name: "beta", id: "prj_b" },
      ],
    });
    const { prompter, selectMessages } = answeringPrompter({ selects: ["prj_b"] });

    await expect(pickProject(prompter, "/tmp/parent", "team")).resolves.toEqual({
      kind: "existing",
      project: { projectId: "prj_b", projectName: "beta" },
      team: "team",
    });
    expect(selectMessages).toEqual(["Project to link"]);
  });

  it("returns a new-project plan when no projects exist", async () => {
    stubVercel({ projects: [] });
    const { prompter } = answeringPrompter({ texts: ["fresh-agent"] });

    await expect(pickProject(prompter, "/tmp/parent", "team")).resolves.toEqual({
      kind: "new",
      project: "fresh-agent",
      team: "team",
    });
  });

  it("refuses to create a project when the picker is existing-only", async () => {
    stubVercel({ projects: [] });
    const { prompter } = answeringPrompter({});

    await expect(
      pickProject(prompter, "/tmp/parent", "team", { allowCreateWhenEmpty: false }),
    ).rejects.toThrow("No existing Vercel projects found in team.");
  });
});

describe("validateTeam", () => {
  it("throws fast when the slug is absent from a non-empty team list", async () => {
    stubVercel({ teams: [{ name: "Other", slug: "other", current: true }] });
    const { prompter } = answeringPrompter({});

    await expect(validateTeam(prompter, "/tmp/parent", "missing")).rejects.toThrow(
      /Team "missing" was not found/,
    );
  });

  it("does not block when the readable team list is empty", async () => {
    stubVercel({ teams: [] });
    const { prompter } = answeringPrompter({});

    await expect(validateTeam(prompter, "/tmp/parent", "missing")).resolves.toBeUndefined();
  });

  it("rejects when the team list is unreadable", async () => {
    stubVercel({ teams: undefined });
    const { prompter } = answeringPrompter({});

    await expect(validateTeam(prompter, "/tmp/parent", "missing")).rejects.toThrow(
      /Could not list Vercel teams/,
    );
  });
});
