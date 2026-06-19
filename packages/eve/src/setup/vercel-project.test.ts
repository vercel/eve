import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPromptCommandOutput, WHIMSY_POOLS } from "#setup/cli/index.js";
import { captureVercel, runVercel, type VercelCaptureResult } from "#setup/primitives/index.js";

import { HumanActionRequiredError } from "#setup/human-action.js";
import type { Prompter, PrompterValue, SingleSelectOptions } from "./prompter.js";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import {
  assertNewProjectNameAvailable,
  getVercelAuthStatus,
  linkProject,
  linkResolvedVercelProject,
  listProjects,
  listTeams,
  pickNewProjectName,
  pickProject,
  pickTeam,
  requireAuth,
  searchProjects,
  validateTeam,
} from "./vercel-project.js";

vi.mock("#setup/primitives/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#setup/primitives/index.js")>();
  return {
    ...original,
    captureVercel: vi.fn(),
    runVercel: vi.fn(),
  };
});

const { mockedReadProjectLink, mockedWriteProjectLink } = vi.hoisted(() => ({
  mockedReadProjectLink: vi.fn(),
  mockedWriteProjectLink: vi.fn(),
}));

vi.mock("./project-resolution.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./project-resolution.js")>();
  return {
    ...original,
    readProjectLink: mockedReadProjectLink,
    writeProjectLink: mockedWriteProjectLink,
  };
});

const mockedCaptureVercel = vi.mocked(captureVercel);
const mockedRunVercel = vi.mocked(runVercel);

/** Wraps stdout as a successful capture result for the mocked `captureVercel`. */
const captured = (stdout: string): VercelCaptureResult => ({ ok: true, stdout });

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
  mockedWriteProjectLink.mockReset();
  mockedWriteProjectLink.mockResolvedValue(undefined);
  mockedReadProjectLink.mockReset();
});

describe("listTeams", () => {
  it("returns team entries from Vercel CLI JSON output", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(
        JSON.stringify({
          teams: [
            { id: "team_current", slug: "current-team", name: "Current Team", current: true },
            { id: "team_other", slug: "other-team", name: "Other Team", current: false },
          ],
          pagination: {},
        }),
      ),
    );

    await expect(listTeams("/tmp/eve-agent")).resolves.toEqual([
      { slug: "current-team", name: "Current Team", current: true },
      { slug: "other-team", name: "Other Team", current: false },
    ]);
    expect(mockedCaptureVercel).toHaveBeenCalledWith(["teams", "ls", "--format", "json"], {
      cwd: "/tmp/eve-agent",
    });
  });

  it("drains every team page and deduplicates by team slug", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        captured(
          JSON.stringify({
            teams: [
              { id: "team_a", slug: "team-a", name: "Team A", current: true },
              { id: "team_shared", slug: "shared", name: "Shared", current: false },
            ],
            pagination: { next: 123 },
          }),
        ),
      )
      .mockResolvedValueOnce(
        captured(
          JSON.stringify({
            teams: [
              { id: "team_shared", slug: "shared", name: "Shared", current: false },
              { id: "team_b", slug: "team-b", name: "Team B", current: false },
            ],
            pagination: { next: null },
          }),
        ),
      );

    await expect(listTeams("/tmp/eve-agent")).resolves.toEqual([
      { slug: "team-a", name: "Team A", current: true },
      { slug: "shared", name: "Shared", current: false },
      { slug: "team-b", name: "Team B", current: false },
    ]);
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      ["teams", "ls", "--format", "json", "--next", "123"],
      { cwd: "/tmp/eve-agent", signal: undefined },
    );
  });

  it("rejects a repeated team cursor", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(
        JSON.stringify({
          teams: [{ id: "team_a", slug: "team-a", name: "Team A", current: true }],
          pagination: { next: 123 },
        }),
      ),
    );

    await expect(listTeams("/tmp/eve-agent")).rejects.toThrow(
      "repeated pagination cursor for Vercel teams",
    );
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(2);
  });

  it("rejects an entire team page when one entry is invalid", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(
      captured(
        JSON.stringify({
          teams: [
            { id: "team_valid", slug: "valid-team", name: "Valid Team", current: true },
            { id: "team_invalid", slug: "invalid-team", name: "Invalid Team" },
          ],
        }),
      ),
    );
    await expect(listTeams("/tmp/eve-agent")).rejects.toThrow(
      "Could not read teams from Vercel CLI JSON output.",
    );

    mockedCaptureVercel.mockResolvedValueOnce(captured("not json"));
    await expect(listTeams("/tmp/eve-agent")).rejects.toThrow(
      "Could not parse teams JSON from Vercel CLI output.",
    );
  });

  it("rejects a failed team capture", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(failedCapture("", "team lookup failed"));
    await expect(listTeams("/tmp/eve-agent")).rejects.toThrow("Could not list Vercel teams.");
  });
});

describe("listProjects", () => {
  it("returns project entries from Vercel CLI JSON output", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(
        JSON.stringify({
          projects: [
            {
              name: "eve-agent",
              id: "prj_eve",
              latestProductionUrl: "https://eve-agent.vercel.app",
              updatedAt: 1,
              nodeVersion: null,
              deprecated: false,
            },
          ],
          pagination: {},
          contextName: "current-team",
          elapsed: "1ms",
        }),
      ),
    );

    await expect(listProjects("/tmp/eve-agent", "current-team")).resolves.toEqual([
      { name: "eve-agent", id: "prj_eve", updatedAt: 1 },
    ]);
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["api", "/v9/projects?limit=20", "--scope", "current-team", "--raw"],
      { cwd: "/tmp/eve-agent", signal: undefined, timeoutMs: 15_000 },
    );
  });

  it("returns the bounded first page without draining the pagination cursor", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        captured(
          JSON.stringify({
            projects: [{ name: "newer-project", id: "prj_newer", updatedAt: 200 }],
            pagination: { next: 1_781_736_726_064 },
          }),
        ),
      )
      .mockResolvedValueOnce(
        captured(
          JSON.stringify({
            projects: [{ name: "older-project", id: "prj_older", updatedAt: 100 }],
            pagination: { next: null },
          }),
        ),
      );

    await expect(listProjects("/tmp/eve-agent", "current-team")).resolves.toEqual([
      { name: "newer-project", id: "prj_newer", updatedAt: 200 },
    ]);
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(1);
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["api", "/v9/projects?limit=20", "--scope", "current-team", "--raw"],
      { cwd: "/tmp/eve-agent", timeoutMs: 15_000 },
    );
  });

  it("performs a scoped server-side name search for a specific query", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(
        JSON.stringify({
          projects: [{ name: "inbound-agent", id: "prj_inbound", updatedAt: 1 }],
          pagination: { next: null },
        }),
      ),
    );

    await expect(
      searchProjects("/tmp/eve-agent", "current-team", "inbound agent"),
    ).resolves.toEqual([{ name: "inbound-agent", id: "prj_inbound", updatedAt: 1 }]);
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["api", "/v9/projects?limit=20&search=inbound%20agent", "--scope", "current-team", "--raw"],
      { cwd: "/tmp/eve-agent", timeoutMs: 15_000 },
    );
  });

  it("drains every page of an explicit scoped search", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        captured(
          JSON.stringify({
            projects: [{ name: "newer-project", id: "prj_newer", updatedAt: 200 }],
            pagination: { next: 1_781_736_726_064 },
          }),
        ),
      )
      .mockResolvedValueOnce(
        captured(
          JSON.stringify({
            projects: [{ name: "older-project", id: "prj_older", updatedAt: 100 }],
            pagination: { next: null },
          }),
        ),
      );

    await expect(searchProjects("/tmp/eve-agent", "current-team", "agent")).resolves.toEqual([
      { name: "newer-project", id: "prj_newer", updatedAt: 200 },
      { name: "older-project", id: "prj_older", updatedAt: 100 },
    ]);
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      [
        "api",
        "/v9/projects?limit=20&search=agent&until=1781736726064",
        "--scope",
        "current-team",
        "--raw",
      ],
      { cwd: "/tmp/eve-agent", signal: undefined, timeoutMs: 15_000 },
    );
  });

  it("rejects a repeated project-search cursor instead of returning partial results", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(
        JSON.stringify({
          projects: [{ name: "agent", id: "prj_agent", updatedAt: 1 }],
          pagination: { next: 123 },
        }),
      ),
    );

    await expect(searchProjects("/tmp/eve-agent", "current-team", "agent")).rejects.toThrow(
      "repeated pagination cursor",
    );
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(2);
  });

  it("rejects an entire project page when one entry is invalid", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(
      captured(
        JSON.stringify({
          projects: [
            { name: "valid-project", id: "prj_valid", updatedAt: 1 },
            { name: "invalid-project" },
          ],
        }),
      ),
    );
    await expect(listProjects("/tmp/eve-agent", "current-team")).rejects.toThrow(
      "Could not read projects from Vercel CLI JSON output.",
    );
  });

  it("rejects a failed project capture", async () => {
    mockedCaptureVercel.mockResolvedValueOnce({
      ok: false,
      failure: {
        code: 1,
        stderr: "",
        stdout: "",
        message: "vercel project ls exited with code 1.",
      },
    });
    await expect(listProjects("/tmp/eve-agent", "current-team")).rejects.toThrow(
      "Could not list Vercel projects in current-team.",
    );
  });

  it("routes a 403/SSO denial to the re-auth action instead of a raw error", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(
      failedCapture(
        JSON.stringify({ error: { code: "forbidden", message: "SAML SSO required" } }),
        "Error: Not authorized",
      ),
    );
    await expect(listProjects("/tmp/eve-agent", "sso-team")).rejects.toMatchObject({
      name: "HumanActionRequiredError",
      action: { kind: "vercel-forbidden", command: "vercel login" },
    });
  });

  it("detects a forbidden scope from stderr text (no JSON body)", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(
      failedCapture("", "Error: This team requires SAML Single Sign-On."),
    );
    await expect(listProjects("/tmp/eve-agent", "sso-team")).rejects.toMatchObject({
      name: "HumanActionRequiredError",
      action: { kind: "vercel-forbidden" },
    });
  });

  it("does not treat a plain non-zero exit as forbidden", async () => {
    // `failure.code` is the child's exit code, not an HTTP status, so a bare
    // failure with no forbidden text stays a generic error — never a re-auth action.
    mockedCaptureVercel.mockResolvedValueOnce({
      ok: false,
      failure: { code: 403, stderr: "", stdout: "", message: "vercel project ls failed." },
    });
    const error = await listProjects("/tmp/eve-agent", "sso-team").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(HumanActionRequiredError);
    expect(error).toMatchObject({ message: expect.stringContaining("Could not list Vercel") });
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
    mockedCaptureVercel.mockResolvedValue(
      captured(
        JSON.stringify({
          teams: [
            { id: "t1", slug: "team-a", name: "Team A", current: true },
            { id: "t2", slug: "team-b", name: "Team B", current: false },
          ],
        }),
      ),
    );
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
  it("orders the initial page and merged search results by most recently updated", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        captured(
          JSON.stringify({
            projects: [
              { name: "initial-old", id: "prj_initial_old", updatedAt: 100 },
              { name: "initial-new", id: "prj_initial_new", updatedAt: 300 },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        captured(
          JSON.stringify({
            projects: [
              { name: "search-old", id: "prj_search_old", updatedAt: 200 },
              { name: "search-new", id: "prj_search_new", updatedAt: 400 },
            ],
          }),
        ),
      );
    const search = vi
      .fn()
      .mockResolvedValueOnce({ kind: "query", query: "search" })
      .mockResolvedValueOnce({ kind: "selected", value: "search-new" });
    const { prompter } = createFakePrompter({ search });

    await expect(pickProject(prompter, "/tmp/eve-agent", "team-a")).resolves.toEqual({
      project: "search-new",
      exists: true,
    });
    expect(search.mock.calls[0]?.[0].options).toEqual([
      { value: "initial-new", label: "initial-new" },
      { value: "initial-old", label: "initial-old" },
    ]);
    expect(search.mock.calls[1]?.[0].options).toEqual([
      { value: "search-new", label: "search-new" },
      { value: "initial-new", label: "initial-new" },
      { value: "search-old", label: "search-old" },
      { value: "initial-old", label: "initial-old" },
    ]);
  });

  it("labels the spinner with the team and stops it before selection", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(JSON.stringify({ projects: [{ name: "p1", id: "prj_p1", updatedAt: 1 }] })),
    );
    const stop = vi.fn();
    const spinner = vi.fn((_message: string) => ({ stop }));
    const prompter = createSpyPrompter({ spinner, single: async () => "p1" });

    await expect(pickProject(prompter, "/tmp/eve-agent", "team-a")).resolves.toEqual({
      project: "p1",
      exists: true,
    });
    // Randomized copy: the team name must still anchor the step.
    expect(spinner.mock.calls[0]?.[0]).toContain("team-a");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("searches the team only after the local filter has no match", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        captured(JSON.stringify({ projects: [{ name: "alpha", id: "prj_alpha", updatedAt: 1 }] })),
      )
      .mockResolvedValueOnce(
        captured(
          JSON.stringify({
            projects: [{ name: "inbound-agent", id: "prj_inbound", updatedAt: 2 }],
          }),
        ),
      );
    const search = vi
      .fn()
      .mockResolvedValueOnce({ kind: "query", query: "inbound" })
      .mockResolvedValueOnce({ kind: "selected", value: "inbound-agent" });
    const { prompter } = createFakePrompter({ search });

    await expect(pickProject(prompter, "/tmp/eve-agent", "team-a")).resolves.toEqual({
      project: "inbound-agent",
      exists: true,
    });
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      ["api", "/v9/projects?limit=20&search=inbound", "--scope", "team-a", "--raw"],
      { cwd: "/tmp/eve-agent", signal: undefined, timeoutMs: 15_000 },
    );
    expect(search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        initialQuery: "inbound",
        options: expect.arrayContaining([{ value: "inbound-agent", label: "inbound-agent" }]),
      }),
    );
  });

  it("keeps an unmatched server query editable with an inline notice", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        captured(JSON.stringify({ projects: [{ name: "alpha", id: "prj_alpha", updatedAt: 1 }] })),
      )
      .mockResolvedValueOnce(captured(JSON.stringify({ projects: [] })))
      .mockResolvedValueOnce(
        captured(
          JSON.stringify({
            projects: [{ name: "beta-agent", id: "prj_beta", updatedAt: 2 }],
          }),
        ),
      );
    const search = vi
      .fn()
      .mockResolvedValueOnce({ kind: "query", query: "missing" })
      .mockResolvedValueOnce({ kind: "query", query: "beta" })
      .mockResolvedValueOnce({ kind: "selected", value: "beta-agent" });
    const { prompter } = createFakePrompter({ search });

    const message = "Which project is https://agent.example.com/ part of?";
    await expect(pickProject(prompter, "/tmp/eve-agent", "team-a", { message })).resolves.toEqual({
      project: "beta-agent",
      exists: true,
    });
    expect(search).toHaveBeenNthCalledWith(1, expect.objectContaining({ message }));
    expect(search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        initialQuery: "missing",
        message,
        notices: [{ tone: "warning", text: 'No projects matched "missing" in team-a.' }],
      }),
    );
  });
});

describe("pickNewProjectName", () => {
  it("prompts for a replacement when the default project name already exists", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        captured(
          JSON.stringify({ id: "prj_existing", name: "my-agent", accountId: "team_account" }),
        ),
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
      captured(JSON.stringify({ id: "prj_existing", name: "my-agent", accountId: "team_account" })),
    );

    await expect(
      assertNewProjectNameAvailable("/tmp/eve-agent", "team-a", "my-agent"),
    ).rejects.toThrow(
      'Vercel project "my-agent" already exists in team-a. Pass --project my-agent to link it, or choose a different project name.',
    );
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["api", "/v9/projects/my-agent", "--scope", "team-a", "--raw"],
      { cwd: "/tmp/eve-agent" },
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

describe("linkProject", () => {
  it("links an already-resolved project without another Vercel API lookup", async () => {
    const project = { id: "prj_selected", name: "remote-agent", accountId: "team_account" };
    mockedReadProjectLink.mockResolvedValue({
      projectId: project.id,
      orgId: project.accountId,
      projectName: project.name,
    });
    const { prompter } = createFakePrompter();

    await expect(
      linkResolvedVercelProject({
        prompter,
        projectRoot: "/tmp/eve-agent",
        project,
      }),
    ).resolves.toEqual({ project });

    expect(mockedCaptureVercel).not.toHaveBeenCalled();
    expect(mockedWriteProjectLink).toHaveBeenCalledWith({
      projectRoot: "/tmp/eve-agent",
      link: {
        projectId: project.id,
        orgId: project.accountId,
        projectName: project.name,
      },
      signal: undefined,
    });
    expect(mockedReadProjectLink).toHaveBeenCalledWith("/tmp/eve-agent");
  });

  it("rejects a link receipt whose ids do not match the resolved project", async () => {
    const project = { id: "prj_selected", name: "remote-agent", accountId: "team_account" };
    mockedReadProjectLink.mockResolvedValue({
      projectId: "prj_other",
      orgId: project.accountId,
    });
    const { prompter } = createFakePrompter();

    await expect(
      linkResolvedVercelProject({
        prompter,
        projectRoot: "/tmp/eve-agent",
        project,
      }),
    ).rejects.toThrow('Linked project identity did not match Vercel project "remote-agent".');
    expect(mockedCaptureVercel).not.toHaveBeenCalled();
  });

  it("fails a new-project plan when that project name already exists", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(JSON.stringify({ id: "prj_existing", name: "my-agent", accountId: "team_account" })),
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

  it("fails an existing-project plan when the project cannot be resolved exactly", async () => {
    mockedCaptureVercel.mockResolvedValue(
      failedCapture(JSON.stringify({ error: { code: "not_found", message: "Project not found" } })),
    );
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "existing", project: "missing-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
      ),
    ).rejects.toThrow('Vercel project "missing-agent" was not found in team-a.');
    expect(mockedRunVercel).not.toHaveBeenCalled();
  });

  it("creates and links an available new project", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(
        captured(JSON.stringify({ id: "prj_new", name: "my-agent", accountId: "team_account" })),
      );
    const { prompter } = createFakePrompter();
    mockedReadProjectLink.mockResolvedValue({
      projectId: "prj_new",
      orgId: "team_account",
      projectName: "my-agent",
    });

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
      ),
    ).resolves.toBe(true);
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      1,
      ["api", "/v9/projects/my-agent", "--scope", "team-a", "--raw"],
      { cwd: "/tmp/eve-agent" },
    );
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      [
        "api",
        "/v10/projects",
        "--scope",
        "team-a",
        "--method",
        "POST",
        "--raw-field",
        "name=my-agent",
        "--raw",
      ],
      { cwd: "/tmp/eve-agent", onOutput: expect.any(Function) },
    );
    expect(mockedRunVercel).not.toHaveBeenCalled();
    expect(mockedWriteProjectLink).toHaveBeenCalledWith({
      projectRoot: "/tmp/eve-agent",
      link: { projectId: "prj_new", orgId: "team_account", projectName: "my-agent" },
      signal: undefined,
    });
  });
});

/** Stubs the `vercel` CLI lookups the provisioning prompts perform. */
function stubVercel(responses: {
  whoami?: string;
  teams?: { name: string; slug: string; current: boolean }[];
  projects?: { name: string; id: string; updatedAt: number }[];
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
    if (args[0] === "api" && args[1]?.startsWith("/v9/projects?")) {
      return responses.projects === undefined
        ? failed()
        : { ok: true, stdout: JSON.stringify({ projects: responses.projects }) };
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

  it("uses the current scope without prompting when only one team exists", async () => {
    stubVercel({ teams: [{ name: "Solo", slug: "solo", current: true }] });
    const { prompter } = answeringPrompter({});

    await expect(pickTeam(prompter, "/tmp/parent", undefined)).resolves.toBe("solo");
  });

  it("shows the single team when the caller needs an explicit project target", async () => {
    stubVercel({ teams: [{ name: "Solo", slug: "solo", current: true }] });
    const { prompter, selectMessages } = answeringPrompter({ selects: ["solo"] });

    await expect(
      pickTeam(prompter, "/tmp/parent", undefined, { promptWhenSingle: true }),
    ).resolves.toBe("solo");
    expect(selectMessages).toEqual(["Select your team"]);
  });

  it("uses a caller-supplied team question", async () => {
    stubVercel({
      teams: [
        { name: "Current", slug: "current", current: true },
        { name: "Other", slug: "other", current: false },
      ],
    });
    const { prompter, selectMessages } = answeringPrompter({ selects: ["other"] });

    await expect(
      pickTeam(prompter, "/tmp/parent", undefined, {
        message: "Which team does https://agent.example.com/ belong to?",
      }),
    ).resolves.toBe("other");
    expect(selectMessages).toEqual(["Which team does https://agent.example.com/ belong to?"]);
  });
});

describe("pickProject selection", () => {
  it("returns an existing selection as exists:true", async () => {
    stubVercel({
      projects: [
        { name: "alpha", id: "prj_a", updatedAt: 1 },
        { name: "beta", id: "prj_b", updatedAt: 2 },
      ],
    });
    const { prompter, selectMessages } = answeringPrompter({ selects: ["beta"] });

    await expect(pickProject(prompter, "/tmp/parent", "team")).resolves.toEqual({
      project: "beta",
      exists: true,
    });
    expect(selectMessages).toEqual(["Project to link"]);
  });

  it("uses a caller-supplied project question in the select fallback", async () => {
    stubVercel({
      projects: [
        { name: "alpha", id: "prj_a", updatedAt: 1 },
        { name: "beta", id: "prj_b", updatedAt: 2 },
      ],
    });
    const { prompter, selectMessages } = answeringPrompter({ selects: ["beta"] });

    await expect(
      pickProject(prompter, "/tmp/parent", "team", {
        message: "Which project is https://agent.example.com/ part of?",
      }),
    ).resolves.toEqual({ project: "beta", exists: true });
    expect(selectMessages).toEqual(["Which project is https://agent.example.com/ part of?"]);
  });

  it("returns a typed-in name as exists:false when no projects exist", async () => {
    stubVercel({ projects: [] });
    const { prompter } = answeringPrompter({ texts: ["fresh-agent"] });

    await expect(pickProject(prompter, "/tmp/parent", "team")).resolves.toEqual({
      project: "fresh-agent",
      exists: false,
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
