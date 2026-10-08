import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelSetupAwaitChoice, ChannelSetupLog } from "#setup/cli/index.js";
import { openUrl } from "#setup/primitives/open-url.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { updateSlackChannelConnectorUid } from "#setup/scaffold/update/update-slack-channel.js";

import {
  parseCreatedSlackConnector,
  parseSlackConnectorDetails,
  type SlackTriggerDestination,
} from "./slack-connect.js";
import { provisionSlackbot, reconcileSlackUid } from "./slackbot.js";

vi.mock("#setup/primitives/run-vercel.js", () => ({
  captureVercel: vi.fn(),
  runVercel: vi.fn(),
  runVercelCaptureStdout: vi.fn(),
}));

vi.mock("#setup/primitives/open-url.js", () => ({ openUrl: vi.fn() }));

vi.mock("#setup/scaffold/update/update-slack-channel.js", () => ({
  updateSlackChannelConnectorUid: vi.fn(),
}));

const mockedCaptureVercel = vi.mocked(captureVercel);
const mockedRunVercel = vi.mocked(runVercel);
const mockedRunVercelCaptureStdout = vi.mocked(runVercelCaptureStdout);
const mockedUpdateSlackChannelConnectorUid = vi.mocked(updateSlackChannelConnectorUid);
const mockedOpenUrl = vi.mocked(openUrl);

const INSTALL_URL =
  /^https:\/\/vercel\.com\/api\/v1\/connect\/install\/scl_my_agent\?teamId=team_demo&request_code=[\w-]{43}$/;

/** `vercel connect create slack … -F json` stdout payload on CLI 54.x. */
function createSlackConnectorJson(uid: string, id = "scl_my_agent"): string {
  return JSON.stringify({ uid, id, type: "slack", name: "my-agent" });
}

function connectedSlackConnectorJson(
  uid: string,
  id = "scl_my_agent",
  workspaceName?: string,
): string {
  return JSON.stringify({
    uid,
    id,
    type: "slack",
    name: "my-agent",
    data: {
      appId: "A0",
      slackTeam: { id: "T0", name: workspaceName },
    },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * A `connect create` that reached the browser flow, so the run may have
 * created a connector even when its stdout names none.
 */
function browserCreate<T>(result: T | (() => Promise<T>)) {
  return async (
    _args: string[],
    options: { onOutput?: (line: { stream: "stderr"; text: string }) => void },
  ) => {
    options.onOutput?.({ stream: "stderr", text: "Opening browser for slack app setup…" });
    return typeof result === "function" ? await (result as () => Promise<T>)() : result;
  };
}

function createTestLog(): ChannelSetupLog {
  return {
    message: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    commandOutput: vi.fn(),
  };
}

const ROOT = "/tmp/eve-agent";
const PROJECT = "prj_demo";
const ROUTE = "/eve/v1/slack";
const LINK = { projectId: PROJECT, orgId: "team_demo" };

/** Provisioning deps over the mocked Vercel CLI, linked to {@link LINK}. */
function linkedDeps() {
  return {
    captureVercel: mockedCaptureVercel,
    runVercel: mockedRunVercel,
    runVercelCaptureStdout: mockedRunVercelCaptureStdout,
    readProjectLink: async () => LINK,
  };
}

const FAILURE = {
  ok: false as const,
  failure: { code: 1, stdout: "", stderr: "", message: "failed" },
};
const NOT_FOUND = {
  ok: false as const,
  failure: { code: 1, stdout: "", stderr: "Error: Not Found (404)", message: "failed" },
};

interface ListedConnector {
  uid: string;
  id: string;
  createdAt?: number;
  projects?: { id: string; name?: string }[];
}

/** One page of `GET /v1/connect/connectors?include=projects`. */
function listPage(connectors: readonly ListedConnector[], next?: string) {
  return {
    ok: true as const,
    stdout: JSON.stringify({
      clients: connectors.map((entry) => ({
        uid: entry.uid,
        id: entry.id,
        type: "slack",
        createdAt: entry.createdAt ?? 1,
        includes: {
          projects: {
            items: (entry.projects ?? [{ id: PROJECT }]).map((project) => ({
              projectId: project.id,
              project,
            })),
          },
        },
      })),
      pagination: { next: next ?? null },
    }),
  };
}

const isListCall = (args: readonly string[]): boolean =>
  args[0] === "api" && (args[1] ?? "").startsWith("/v1/connect/connectors?");
const isUidLookup = (args: readonly string[]): boolean =>
  args[0] === "api" && /^\/v1\/connect\/connectors\/slack%2F[^/?]*\?/.test(args[1] ?? "");

/** The reads before a create when nothing exists yet: an empty project list and free UIDs. */
function emptyInspection(args: readonly string[]) {
  if (isListCall(args)) return listPage([]);
  if (isUidLookup(args)) return NOT_FOUND;
  return undefined;
}

/** Mocks the full new-connector path: nothing existing, completed browser verifier, routing. */
function mockHappyPathProvision(): void {
  mockedRunVercelCaptureStdout.mockResolvedValue({
    ok: true,
    stdout: createSlackConnectorJson("slack/my-agent"),
  });
  mockedRunVercel.mockResolvedValue(true);
  mockedCaptureVercel.mockImplementation(
    async (args) =>
      emptyInspection(args) ?? {
        ok: true,
        stdout: connectedSlackConnectorJson("slack/my-agent"),
      },
  );
}

interface FakeConnector {
  uid: string;
  id: string;
  createdAt: number;
  projects: { id: string; name?: string }[];
  installed: boolean;
  destinations: SlackTriggerDestination[];
}

function connector(input: Partial<FakeConnector> & { uid: string }): FakeConnector {
  return {
    id: `scl_${input.uid.slice("slack/".length).replaceAll("-", "_")}`,
    createdAt: 1,
    projects: [{ id: PROJECT }],
    installed: true,
    destinations: [],
    ...input,
  };
}

/**
 * In-memory Vercel Connect behind the mocked CLI. It applies attach, create,
 * and trigger-destination replacement the way Connect does, so tests assert
 * the commands eve issued and the destinations they leave behind.
 */
function fakeConnect(initial: FakeConnector[]) {
  const state = new Map(initial.map((entry) => [entry.uid, structuredClone(entry)]));
  const commands: string[] = [];
  const details = (entry: FakeConnector) =>
    JSON.stringify({
      id: entry.id,
      uid: entry.uid,
      type: "slack",
      data: entry.installed
        ? { appId: "A0", slackTeam: { id: "T0", name: "Vercel" } }
        : { appId: null, slackTeam: null },
      triggerDestinations: entry.destinations,
    });
  const attachProject = (entry: FakeConnector, projectId: string) => {
    if (!entry.projects.some((project) => project.id === projectId)) {
      entry.projects.push({ id: projectId });
    }
  };
  const fake = {
    state,
    commands,
    pageSize: Number.POSITIVE_INFINITY,
    fail: (_args: readonly string[]): boolean => false,
    /** Every command that changes Connect state, in order; detach included. */
    mutations: () =>
      commands.filter(
        (command) =>
          /^connect (attach|detach|remove|create)\b/.test(command) ||
          command.includes("--method PATCH"),
      ),
    deps: linkedDeps(),
  };
  mockedCaptureVercel.mockImplementation(async (args, options) => {
    commands.push(args.join(" "));
    if (fake.fail(args)) return FAILURE;
    if (args[0] !== "api") throw new Error(`Unexpected: ${args.join(" ")}`);
    const url = new URL(args[1]!, "https://api.vercel.com");
    if (url.pathname === "/v1/connect/connectors") {
      const projectId = url.searchParams.get("projectId");
      const attached = [...state.values()].filter((entry) =>
        entry.projects.some((project) => project.id === projectId),
      );
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const end = start + fake.pageSize;
      return listPage(attached.slice(start, end), end < attached.length ? String(end) : undefined);
    }
    const match = /^\/v1\/connect\/connectors\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match === null) throw new Error(`Unexpected: ${args.join(" ")}`);
    const key = decodeURIComponent(match[1]!);
    const entry = [...state.values()].find(
      (candidate) => key === candidate.id || key === candidate.uid,
    );
    if (entry === undefined) return NOT_FOUND;
    const suffix = match[2];
    if (suffix === "/trigger-destinations" && args.includes("PATCH")) {
      entry.destinations = (
        JSON.parse(options.stdin!) as { destinations: SlackTriggerDestination[] }
      ).destinations;
      for (const destination of entry.destinations) attachProject(entry, destination.projectId);
      return { ok: true, stdout: details(entry) };
    }
    if (suffix === "/projects") {
      const projects = entry.projects.map((project) => ({ projectId: project.id, project }));
      return { ok: true, stdout: JSON.stringify({ projects }) };
    }
    return { ok: true, stdout: details(entry) };
  });
  mockedRunVercel.mockImplementation(async (args) => {
    commands.push(args.join(" "));
    if (fake.fail(args)) return false;
    if (args[1] === "attach") {
      const entry = state.get(args[2]!)!;
      attachProject(entry, PROJECT);
      const path = args[args.indexOf("--trigger-path") + 1]!;
      if (
        !entry.destinations.some((d) => d.projectId === PROJECT && d.path === path && !d.branch)
      ) {
        entry.destinations.push({ projectId: PROJECT, path });
      }
      return true;
    }
    if (args[1] === "remove") return state.delete(args[2]!);
    if (args[1] === "detach") return true;
    throw new Error(`Unexpected: ${args.join(" ")}`);
  });
  mockedRunVercelCaptureStdout.mockImplementation(async (args) => {
    commands.push(args.join(" "));
    const name = args[args.indexOf("--name") + 1]!;
    const created = connector({
      uid: `slack/${name}`,
      createdAt: 100,
      destinations: [{ projectId: PROJECT, path: "/triggers/slack" }],
    });
    state.set(created.uid, created);
    return { ok: true, stdout: createSlackConnectorJson(created.uid, created.id) };
  });
  return fake;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("parseSlackConnectorDetails", () => {
  it("derives workspace metadata from the live connector detail payload", () => {
    expect(
      parseSlackConnectorDetails({
        id: "scl_1",
        uid: "slack/my-agent",
        data: {
          appId: "A0",
          slackTeam: { id: "T0", name: "Vercel" },
        },
      }),
    ).toEqual({
      ref: { id: "scl_1", uid: "slack/my-agent" },
      workspace: {
        workspaceUrl: "https://slack.com/app_redirect?app=A0&team=T0",
        workspaceName: "Vercel",
      },
      triggerDestinations: [],
    });
  });

  it("reads trigger destinations, dropping null branch and environment fields", () => {
    expect(
      parseSlackConnectorDetails({
        id: "scl_1",
        uid: "slack/my-agent",
        triggerDestinations: [
          { projectId: "prj_1", path: "/eve/v1/slack", branch: null, customEnvironmentId: null },
          { projectId: "prj_1", path: "/x", branch: "preview" },
        ],
      })?.triggerDestinations,
    ).toEqual([
      { projectId: "prj_1", path: "/eve/v1/slack" },
      { projectId: "prj_1", path: "/x", branch: "preview" },
    ]);
  });

  it("keeps a valid connector ref while workspace metadata is incomplete", () => {
    expect(
      parseSlackConnectorDetails({
        id: "scl_1",
        uid: "slack/my-agent",
        data: { appId: null, slackTeam: null },
      }),
    ).toEqual({ ref: { id: "scl_1", uid: "slack/my-agent" }, triggerDestinations: [] });
  });

  it("rejects malformed connector references", () => {
    expect(parseSlackConnectorDetails({ uid: "slack/my-agent" })).toBeUndefined();
    expect(parseSlackConnectorDetails(null)).toBeUndefined();
  });
});

describe("parseCreatedSlackConnector", () => {
  it("reads uid and id from `vercel connect create slack -F json` stdout", () => {
    expect(parseCreatedSlackConnector(createSlackConnectorJson("slack/my-agent", "scl_1"))).toEqual(
      {
        uid: "slack/my-agent",
        id: "scl_1",
      },
    );
  });

  it("returns undefined for empty, non-JSON, or shape-mismatched stdout", () => {
    expect(parseCreatedSlackConnector("")).toBeUndefined();
    expect(parseCreatedSlackConnector("Vercel CLI 54.9.1")).toBeUndefined();
    expect(parseCreatedSlackConnector(JSON.stringify({ uid: "slack/x" }))).toBeUndefined();
  });
});

describe("provisionSlackbot", () => {
  it("makes no changes when the channel's connector is already configured", async () => {
    const connect = fakeConnect([
      connector({ uid: "slack/my-agent", destinations: [{ projectId: PROJECT, path: ROUTE }] }),
    ]);

    await expect(
      provisionSlackbot(createTestLog(), ROOT, "my-agent", connect.deps, {
        channelConnectorUid: "slack/my-agent",
      }),
    ).resolves.toEqual({
      state: "already-configured",
      connectorUid: "slack/my-agent",
      chatUrl: "https://slack.com/app_redirect?app=A0&team=T0",
      workspaceName: "Vercel",
    });
    expect(connect.mutations()).toEqual([]);
  });

  it("reuses an unattached connector no other project uses with one additive attach", async () => {
    const connect = fakeConnect([
      connector({ uid: "slack/my-agent", projects: [], destinations: [] }),
    ]);

    await expect(
      provisionSlackbot(createTestLog(), ROOT, "my-agent", connect.deps),
    ).resolves.toMatchObject({ state: "attached", connectorUid: "slack/my-agent" });
    expect(connect.mutations()).toEqual([
      `connect attach slack/my-agent --triggers --trigger-path ${ROUTE} --yes --scope team_demo`,
    ]);
    expect(connect.state.get("slack/my-agent")?.destinations).toEqual([
      { projectId: PROJECT, path: ROUTE },
    ]);
  });

  it("reads only connectors attached here or named for this agent", async () => {
    const connect = fakeConnect([
      connector({ uid: "slack/someone-elses", id: "scl_orphan", projects: [] }),
      connector({ uid: "slack/prod", id: "scl_prod", projects: [{ id: "prj_prod" }] }),
      connector({ uid: "slack/attached", id: "scl_attached" }),
      connector({ uid: "slack/my-agent", id: "scl_named", projects: [] }),
    ]);
    const offered: string[] = [];
    const selectConnector = async (candidates: readonly { uid: string }[]) => {
      offered.push(...candidates.map((entry) => entry.uid));
      return "create" as const;
    };

    await provisionSlackbot(createTestLog(), ROOT, "my-agent", connect.deps, { selectConnector });

    expect(connect.commands.slice(0, 4)).toEqual([
      "api /v1/connect/connectors?projectId=prj_demo&type=slack&include=projects&limit=100&teamId=team_demo --scope team_demo",
      "api /v1/connect/connectors/scl_attached?teamId=team_demo --scope team_demo",
      "api /v1/connect/connectors/slack%2Fmy-agent?teamId=team_demo --scope team_demo",
      "api /v1/connect/connectors/scl_named/projects?teamId=team_demo --scope team_demo",
    ]);
    expect(connect.commands.join("\n")).not.toMatch(/orphan|someone-elses|prod/);
    expect(offered).toEqual(["slack/my-agent", "slack/attached"]);
  });

  it("never offers or attaches a connector another project uses", async () => {
    const log = createTestLog();
    const connect = fakeConnect([
      connector({
        uid: "slack/my-agent",
        projects: [{ id: "prj_prod", name: "chief-prod" }],
        destinations: [{ projectId: "prj_prod", path: ROUTE }],
      }),
      // Only a destination ties this one to another project.
      connector({ uid: "slack/routed", projects: [], destinations: [{ projectId: "prj_prod" }] }),
    ]);
    const selectConnector = vi.fn(async () => ({ uid: "slack/my-agent", id: "scl_my_agent" }));

    await expect(
      provisionSlackbot(log, ROOT, "my-agent", connect.deps, { selectConnector }),
    ).resolves.toEqual({
      state: "connector-in-use",
      connectorUid: "slack/my-agent",
      projects: [{ id: "prj_prod", name: "chief-prod" }],
    });
    expect(selectConnector).toHaveBeenCalledWith([], undefined);
    expect(connect.mutations()).toEqual([]);
    expect(log.warning).toHaveBeenCalledWith(expect.stringContaining("is used by chief-prod"));
  });

  it("fixes a stale destination with one replacement that keeps other entries", async () => {
    const preview = { projectId: PROJECT, branch: "preview", path: "/custom" };
    const connect = fakeConnect([
      connector({
        uid: "slack/my-agent",
        projects: [{ id: PROJECT }, { id: "prj_prod" }],
        destinations: [
          { projectId: "prj_prod", path: ROUTE },
          { projectId: PROJECT, path: "/triggers/slack" },
          preview,
        ],
      }),
    ]);

    await expect(
      provisionSlackbot(createTestLog(), ROOT, "my-agent", connect.deps),
    ).resolves.toMatchObject({ state: "attached", connectorUid: "slack/my-agent" });
    expect(connect.mutations()).toEqual([
      "api /v1/connect/connectors/scl_my_agent/trigger-destinations?teamId=team_demo --method PATCH --input - --scope team_demo",
    ]);
    expect(connect.state.get("slack/my-agent")?.destinations).toEqual([
      { projectId: "prj_prod", path: ROUTE },
      preview,
      { projectId: PROJECT, path: ROUTE },
    ]);
  });

  it("adds a missing destination without re-attaching an attached project", async () => {
    const connect = fakeConnect([connector({ uid: "slack/my-agent", destinations: [] })]);

    await provisionSlackbot(createTestLog(), ROOT, "my-agent", connect.deps);

    expect(connect.mutations()).toEqual([
      expect.stringContaining("/trigger-destinations?teamId=team_demo --method PATCH"),
    ]);
    expect(connect.state.get("slack/my-agent")?.destinations).toEqual([
      { projectId: PROJECT, path: ROUTE },
    ]);
  });

  it("replaces a new connector's default destination with the eve route", async () => {
    const connect = fakeConnect([]);

    await expect(
      provisionSlackbot(createTestLog(), ROOT, "my-agent", connect.deps),
    ).resolves.toEqual({
      state: "attached",
      connectorUid: "slack/my-agent",
      chatUrl: "https://slack.com/app_redirect?app=A0&team=T0",
      workspaceName: "Vercel",
    });
    expect(connect.commands[0]).toBe(
      "api /v1/connect/connectors?projectId=prj_demo&type=slack&include=projects&limit=100&teamId=team_demo --scope team_demo",
    );
    expect(connect.mutations()).toEqual([
      "connect create slack --triggers --name my-agent -F json",
      expect.stringContaining("/trigger-destinations?teamId=team_demo --method PATCH"),
    ]);
    expect(connect.state.get("slack/my-agent")?.destinations).toEqual([
      { projectId: PROJECT, path: ROUTE },
    ]);
  });

  it("reports a full connector without changing anything", async () => {
    const destinations = [
      { projectId: "prj_a", path: ROUTE },
      { projectId: "prj_b", path: ROUTE },
      { projectId: "prj_c", path: ROUTE },
    ];
    const log = createTestLog();
    const connect = fakeConnect([
      connector({
        uid: "slack/my-agent",
        projects: [{ id: PROJECT }, { id: "prj_a", name: "alpha" }],
        destinations,
      }),
    ]);

    await expect(provisionSlackbot(log, ROOT, "my-agent", connect.deps)).resolves.toEqual({
      state: "trigger-limit-reached",
      connectorUid: "slack/my-agent",
      destinations,
    });
    expect(connect.mutations()).toEqual([]);
    expect(log.warning).toHaveBeenCalledWith(
      expect.stringContaining("alpha (production) /eve/v1/slack"),
    );
  });

  it("follows every page of the project's connector list", async () => {
    const connect = fakeConnect([
      connector({ uid: "slack/first", id: "scl_first", createdAt: 1 }),
      connector({ uid: "slack/my-agent", destinations: [{ projectId: PROJECT, path: ROUTE }] }),
    ]);
    connect.pageSize = 1;

    await expect(
      provisionSlackbot(createTestLog(), ROOT, "my-agent", connect.deps),
    ).resolves.toMatchObject({ state: "already-configured", connectorUid: "slack/my-agent" });
    expect(connect.commands).toContain(
      "api /v1/connect/connectors?projectId=prj_demo&type=slack&include=projects&limit=100&cursor=1&teamId=team_demo --scope team_demo",
    );
  });

  it("creates a new connector when the caller requests one", async () => {
    const connect = fakeConnect([connector({ uid: "slack/other", id: "scl_other" })]);

    await expect(
      provisionSlackbot(createTestLog(), ROOT, "my-agent", connect.deps, {
        selectConnector: async () => "create",
      }),
    ).resolves.toMatchObject({ state: "attached", connectorUid: "slack/my-agent" });
    expect(connect.mutations()[0]).toBe("connect create slack --triggers --name my-agent -F json");
  });

  it.each([
    ["the project's connector list", isListCall],
    ["a connector's details", (args: readonly string[]) => args[0] === "api"],
  ])("never creates when %s cannot be read", async (_name, fails) => {
    const connect = fakeConnect([connector({ uid: "slack/my-agent" })]);
    connect.fail = fails;

    await expect(
      provisionSlackbot(createTestLog(), ROOT, "my-agent", connect.deps),
    ).resolves.toEqual({
      state: "connector-lookup-failed",
    });
    expect(connect.mutations()).toEqual([]);
  });

  it("never creates without a linked project to scope connectors", async () => {
    const connect = fakeConnect([]);

    await expect(
      provisionSlackbot(createTestLog(), ROOT, "my-agent", {
        ...connect.deps,
        readProjectLink: async () => undefined,
      }),
    ).resolves.toEqual({ state: "connector-lookup-failed" });
    expect(connect.commands).toEqual([]);
  });

  it("keeps a created connector when routing fails", async () => {
    const connect = fakeConnect([]);
    connect.fail = (args) => args.includes("PATCH");

    await expect(
      provisionSlackbot(createTestLog(), ROOT, "my-agent", connect.deps),
    ).resolves.toEqual({
      state: "attach-failed",
      connectorUid: "slack/my-agent",
    });
    expect(connect.state.has("slack/my-agent")).toBe(true);
  });

  it("reports Vercel's error when create fails before the browser flow starts", async () => {
    const connect = fakeConnect([]);
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "Vercel CLI 62.7.0\nSetting up…\nError: Connect is not available for this team.\n",
    });
    const log = createTestLog();

    await expect(provisionSlackbot(log, ROOT, "my-agent", connect.deps)).resolves.toEqual({
      state: "create-failed",
      detail: "Error: Connect is not available for this team.",
    });
    // Nothing could exist, so there is no browser warning and no ownership lookup.
    expect(log.warning).not.toHaveBeenCalled();
    expect(connect.commands.filter((command) => command.includes("slack%2F"))).toHaveLength(1);
  });

  it("names a new connector around one another project already uses", async () => {
    const connect = fakeConnect([
      connector({ uid: "slack/my-agent", projects: [{ id: "prj_other", name: "other" }] }),
      connector({ uid: "slack/my-agent-2", projects: [{ id: "prj_more" }] }),
    ]);
    const log = createTestLog();

    const result = await provisionSlackbot(log, ROOT, "my-agent", connect.deps, {
      selectConnector: async () => "create",
    });

    expect(result).toMatchObject({ state: "attached", connectorUid: "slack/my-agent-3" });
    expect(connect.mutations()).toContainEqual(
      expect.stringContaining("connect create slack --triggers --name my-agent-3"),
    );
    expect(log.info).toHaveBeenCalledWith(
      "`slack/my-agent` is already used by another project (other), so eve will create `slack/my-agent-3` for this project.",
    );
  });

  it("fails closed when creation succeeds without an exact connector ref", async () => {
    const connect = fakeConnect([]);
    mockedRunVercelCaptureStdout.mockImplementation(browserCreate({ ok: true, stdout: "" }));

    await expect(
      provisionSlackbot(createTestLog(), ROOT, "my-agent", connect.deps),
    ).resolves.toEqual({
      state: "cleanup-failed",
      connectorUids: [],
    });
  });

  it("finishes a parked create when connector details prove the workspace connection", async () => {
    const createClose = deferred<{ ok: boolean; stdout: string }>();
    const workspaceLookup = deferred<{ ok: true; stdout: string }>();
    let workspaceLookups = 0;
    let createSignal: AbortSignal | undefined;
    const close = vi.fn();
    const awaitChoice: ChannelSetupAwaitChoice = vi.fn(() => ({
      choice: new Promise<string | undefined>(() => {}),
      close,
    }));
    mockedRunVercelCaptureStdout.mockImplementationOnce((_args, options) => {
      createSignal = options.signal;
      options.onOutput?.({
        stream: "stderr",
        text: "Connector created: scl_partial",
      });
      return createClose.promise;
    });
    mockedRunVercel.mockResolvedValue(true);
    let connectorLookups = 0;
    mockedCaptureVercel.mockImplementation(async (args) => {
      const inspection = emptyInspection(args);
      if (inspection !== undefined) return inspection;
      if (args.includes("PATCH")) return { ok: true, stdout: "{}" };
      if (
        args[1] === "/v1/connect/connectors/scl_partial?teamId=team_demo" &&
        args[2] === "--scope" &&
        args[3] === "team_demo"
      ) {
        connectorLookups += 1;
        if (connectorLookups === 1) {
          return {
            ok: true,
            stdout: createSlackConnectorJson("slack/my-agent", "scl_partial"),
          };
        }
        workspaceLookups += 1;
        return workspaceLookups === 1
          ? {
              ok: true,
              stdout: createSlackConnectorJson("slack/my-agent", "scl_partial"),
            }
          : workspaceLookup.promise;
      }
      throw new Error(`Unexpected vercel command: ${args.join(" ")}`);
    });
    const phases: { message: string; stopped: boolean }[] = [];
    const log: ChannelSetupLog = {
      ...createTestLog(),
      spinner(message) {
        const phase = { message, stopped: false };
        phases.push(phase);
        return {
          stop() {
            phase.stopped = true;
          },
        };
      },
    };

    const provisioning = provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => LINK,
        delay: async () => {},
      },
      { awaitChoice },
    );

    await vi.waitFor(() => expect(workspaceLookups).toBe(2));
    expect(createSignal?.aborted).toBe(false);
    expect(mockedRunVercel).not.toHaveBeenCalled();
    workspaceLookup.resolve({
      ok: true,
      stdout: connectedSlackConnectorJson("slack/my-agent", "scl_partial", "Vercel"),
    });
    await vi.waitFor(() => expect(createSignal?.aborted).toBe(true));
    expect(mockedRunVercel).not.toHaveBeenCalled();
    createClose.resolve({ ok: false, stdout: "" });
    await expect(provisioning).resolves.toEqual({
      state: "attached",
      connectorUid: "slack/my-agent",
      chatUrl: "https://slack.com/app_redirect?app=A0&team=T0",
      workspaceName: "Vercel",
    });
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["api", "/v1/connect/connectors/scl_partial?teamId=team_demo", "--scope", "team_demo"],
      expect.objectContaining({ cwd: "/tmp/eve-agent" }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(phases).toEqual([
      { message: "Checking for an existing Slackbot...", stopped: true },
      { message: "Waiting for Slack setup to finish...", stopped: true },
      { message: "Configuring Slack event delivery for this agent...", stopped: true },
    ]);
  });

  it("retries the exact connector lookup while connect create remains parked", async () => {
    let createSignal: AbortSignal | undefined;
    mockedRunVercelCaptureStdout.mockImplementationOnce(
      (_args, options) =>
        new Promise((resolve) => {
          createSignal = options.signal;
          options.onOutput?.({
            stream: "stderr",
            text: "Connector created: scl_partial",
          });
          options.signal?.addEventListener("abort", () => resolve({ ok: false, stdout: "" }), {
            once: true,
          });
        }),
    );
    mockedRunVercel.mockResolvedValue(true);
    let connectorLookups = 0;
    mockedCaptureVercel.mockImplementation(async (args) => {
      const inspection = emptyInspection(args);
      if (inspection !== undefined) return inspection;
      if (args.includes("PATCH")) return { ok: true, stdout: "{}" };
      if (
        args[1] === "/v1/connect/connectors/scl_partial?teamId=team_demo" &&
        args[2] === "--scope" &&
        args[3] === "team_demo"
      ) {
        connectorLookups += 1;
        return connectorLookups === 1
          ? {
              ok: false,
              failure: {
                code: 1,
                stdout: "",
                stderr: "not visible yet",
                message: "vercel api failed",
              },
            }
          : connectorLookups === 2
            ? {
                ok: true,
                stdout: createSlackConnectorJson("slack/my-agent", "scl_partial"),
              }
            : {
                ok: true,
                stdout: connectedSlackConnectorJson("slack/my-agent", "scl_partial", "Vercel"),
              };
      }
      throw new Error(`Unexpected vercel command: ${args.join(" ")}`);
    });
    let now = 0;

    const provisioning = provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent", {
      captureVercel: mockedCaptureVercel,
      runVercel: mockedRunVercel,
      runVercelCaptureStdout: mockedRunVercelCaptureStdout,
      readProjectLink: async () => LINK,
      delay: async (ms) => {
        now += ms;
      },
      now: () => now,
    });

    await expect(provisioning).resolves.toMatchObject({ state: "attached" });
    // Three lookups until the workspace connects, then one fresh routing read.
    expect(connectorLookups).toBe(4);
    expect(createSignal?.aborted).toBe(true);
  });

  it("retains exact connector ownership when create fails before its lookup settles", async () => {
    const connectorLookup = deferred<{ ok: true; stdout: string }>();
    mockedRunVercelCaptureStdout.mockImplementationOnce(async (_args, options) => {
      options.onOutput?.({
        stream: "stderr",
        text: "Connector created: scl_partial",
      });
      return { ok: false, stdout: "" };
    });
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel.mockImplementation(async (args) => {
      const inspection = emptyInspection(args);
      if (inspection !== undefined) return inspection;
      if (args[1] === "/v1/connect/connectors/scl_partial?teamId=team_demo") {
        return connectorLookup.promise;
      }
      throw new Error(`Unexpected vercel command: ${args.join(" ")}`);
    });

    const provisioning = provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent", {
      captureVercel: mockedCaptureVercel,
      runVercel: mockedRunVercel,
      runVercelCaptureStdout: mockedRunVercelCaptureStdout,
      readProjectLink: async () => LINK,
    });
    await vi.waitFor(() =>
      expect(mockedCaptureVercel).toHaveBeenCalledWith(
        ["api", "/v1/connect/connectors/scl_partial?teamId=team_demo", "--scope", "team_demo"],
        expect.anything(),
      ),
    );
    connectorLookup.resolve({
      ok: true,
      stdout: createSlackConnectorJson("slack/my-agent", "scl_partial"),
    });

    await expect(provisioning).resolves.toEqual({ state: "create-failed" });
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["connect", "remove", "slack/my-agent", "--disconnect-all", "--yes"],
      expect.objectContaining({ cwd: "/tmp/eve-agent" }),
    );
  });

  it("runs progress phases as ephemeral spinners, never persisted via log.message", async () => {
    mockHappyPathProvision();

    const phases: { message: string; stopped: boolean }[] = [];
    const log: ChannelSetupLog = {
      ...createTestLog(),
      spinner(message) {
        const phase = { message, stopped: false };
        phases.push(phase);
        return {
          stop() {
            phase.stopped = true;
          },
        };
      },
    };

    await provisionSlackbot(log, ROOT, "my-agent", linkedDeps());

    expect(phases).toEqual([
      { message: "Checking for an existing Slackbot...", stopped: true },
      { message: "Waiting for Slack setup to finish...", stopped: true },
      { message: "Configuring Slack event delivery for this agent...", stopped: true },
    ]);
    // Phases are spinner-only; outcomes still persist on their own channels.
    expect(log.message).not.toHaveBeenCalled();
    expect(log.success).not.toHaveBeenCalled();
  });

  it("persists progress phases as messages when the log has no spinner", async () => {
    mockHappyPathProvision();
    const log = createTestLog();

    await provisionSlackbot(log, ROOT, "my-agent", linkedDeps());

    expect(vi.mocked(log.message).mock.calls.map(([text]) => text)).toEqual([
      "Checking for an existing Slackbot...",
      "Waiting for Slack setup to finish...",
      "Configuring Slack event delivery for this agent...",
    ]);
  });

  type ChoiceLog = ChannelSetupLog & { awaitChoice: ChannelSetupAwaitChoice };

  /** A test harness that resolves its interactive wait with a scripted choice sequence. */
  function choiceLog(choices: readonly (string | undefined | "never")[]): ChoiceLog {
    let call = 0;
    return Object.assign(createTestLog(), {
      awaitChoice: vi.fn(() => {
        const next = call < choices.length ? choices[call++] : "never";
        const choice =
          next === "never"
            ? new Promise<string | undefined>(() => {})
            : Promise.resolve(next as string | undefined);
        return { choice, close: vi.fn() };
      }),
    });
  }

  /**
   * A fresh fake clock per test: `delay` advances the deadline so an unraced
   * poll is bounded (no busy-loop), while a racing choice still settles first.
   */
  function makeClock(): { delay: (ms: number) => Promise<void>; now: () => number } {
    let now = 0;
    return {
      delay: async (ms: number) => {
        now += ms;
      },
      now: () => now,
    };
  }

  it("removes the connector it created and reports cancelled when the user cancels the wait", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createSlackConnectorJson("slack/my-agent"),
    });
    mockedRunVercel.mockResolvedValue(true);
    // The existing-check sees nothing; cancellation removes the UID returned by
    // the create command.
    mockedCaptureVercel.mockImplementation(
      async (args) =>
        emptyInspection(args) ?? { ok: true, stdout: createSlackConnectorJson("slack/my-agent") },
    );

    const log = choiceLog(["cancel"]);
    const result = await provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => LINK,
        ...makeClock(),
      },
      { awaitChoice: log.awaitChoice },
    );

    expect(result).toEqual({ state: "cancelled" });
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["connect", "remove", "slack/my-agent", "--disconnect-all", "--yes"],
      expect.objectContaining({ cwd: "/tmp/eve-agent" }),
    );
    expect(log.success).not.toHaveBeenCalled();
  });

  it("fails closed when removing the created connector fails", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createSlackConnectorJson("slack/my-agent"),
    });
    mockedRunVercel.mockImplementation(async (args) => args[1] !== "remove");
    mockedCaptureVercel.mockImplementation(
      async (args) => emptyInspection(args) ?? { ok: true, stdout: "{}" },
    );
    const log = choiceLog(["cancel"]);

    const result = await provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => LINK,
        ...makeClock(),
      },
      { awaitChoice: log.awaitChoice },
    );

    expect(result).toEqual({
      state: "cleanup-failed",
      connectorUids: ["slack/my-agent"],
    });
    expect(log.warning).toHaveBeenCalledWith(
      "Could not remove the abandoned Slack connector. Run `vercel connect remove slack/my-agent --disconnect-all --yes` to clean it up.",
    );
    expect(mockedRunVercelCaptureStdout).toHaveBeenCalledTimes(1);
  });

  it("cleans up before propagating an outer abort", async () => {
    const create = deferred<{ ok: boolean; stdout: string }>();
    const controller = new AbortController();
    mockedRunVercelCaptureStdout.mockImplementationOnce(browserCreate(() => create.promise));
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel.mockImplementation(
      async (args) => emptyInspection(args) ?? { ok: true, stdout: "{}" },
    );

    const provisioning = provisionSlackbot(
      createTestLog(),
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => LINK,
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(mockedRunVercelCaptureStdout).toHaveBeenCalledOnce());

    controller.abort();
    create.resolve({
      ok: true,
      stdout: createSlackConnectorJson("slack/my-agent"),
    });

    await expect(provisioning).rejects.toMatchObject({ name: "AbortError" });
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["connect", "remove", "slack/my-agent", "--disconnect-all", "--yes"],
      expect.objectContaining({ cwd: "/tmp/eve-agent" }),
    );
  });

  it("warns when an outer abort has no exact connector ownership proof", async () => {
    const create = deferred<{ ok: boolean; stdout: string }>();
    const controller = new AbortController();
    const log = createTestLog();
    mockedRunVercelCaptureStdout.mockImplementationOnce(browserCreate(() => create.promise));
    mockedCaptureVercel.mockImplementation(
      async (args) => emptyInspection(args) ?? { ok: true, stdout: "{}" },
    );

    const provisioning = provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => LINK,
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(mockedRunVercelCaptureStdout).toHaveBeenCalledOnce());

    controller.abort();
    create.resolve({ ok: true, stdout: "" });

    await expect(provisioning).rejects.toMatchObject({ name: "AbortError" });
    expect(log.warning).toHaveBeenCalledWith(
      "eve couldn't confirm the Slack request in your browser was cancelled. Wait for it to expire before retrying.",
    );
  });

  it("reports the requested UID when create returns no exact ref and that UID now exists", async () => {
    mockedRunVercelCaptureStdout.mockImplementation(browserCreate({ ok: true, stdout: "" }));
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel.mockImplementation(async (args) => {
      const created = mockedRunVercelCaptureStdout.mock.calls.length > 0;
      if (!created) return emptyInspection(args)!;
      return isUidLookup(args)
        ? { ok: true, stdout: createSlackConnectorJson("slack/my-agent", "scl_new") }
        : NOT_FOUND;
    });

    const log = choiceLog(["cancel"]);
    const result = await provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => LINK,
        ...makeClock(),
      },
      { awaitChoice: log.awaitChoice },
    );

    expect(result).toEqual({
      state: "cleanup-failed",
      connectorUids: ["slack/my-agent"],
    });
    expect(mockedRunVercel).not.toHaveBeenCalled();
  });

  it("does not retry an aborted request when no exact connector ref was returned", async () => {
    mockedRunVercelCaptureStdout.mockImplementation(browserCreate({ ok: true, stdout: "" }));
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel.mockImplementation(
      async (args) => emptyInspection(args) ?? { ok: true, stdout: "{}" },
    );

    const log = choiceLog(["cancel"]);
    const result = await provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => LINK,
        ...makeClock(),
      },
      { awaitChoice: log.awaitChoice },
    );

    expect(result).toEqual({
      state: "cleanup-failed",
      connectorUids: [],
    });
    expect(mockedRunVercelCaptureStdout).toHaveBeenCalledTimes(1);
  });

  it("removes the abandoned connector and mints a fresh one on Try again", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createSlackConnectorJson("slack/my-agent"),
    });
    mockedRunVercel.mockResolvedValue(true);
    // The install only lands on the second attempt (after one create + retry).
    mockedCaptureVercel.mockImplementation(async (args) => {
      const inspection = emptyInspection(args);
      if (inspection !== undefined) return inspection;
      const installed = mockedRunVercelCaptureStdout.mock.calls.length >= 2;
      return {
        ok: true,
        stdout: installed
          ? connectedSlackConnectorJson("slack/my-agent", "scl_my_agent", "Vercel")
          : createSlackConnectorJson("slack/my-agent"),
      };
    });

    const log = choiceLog(["retry"]);
    const result = await provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => LINK,
        ...makeClock(),
      },
      { awaitChoice: log.awaitChoice },
    );

    expect(result.state).toBe("attached");
    // Two attempts created two connectors; the first was removed before retrying.
    expect(mockedRunVercelCaptureStdout).toHaveBeenCalledTimes(2);
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["connect", "remove", "slack/my-agent", "--disconnect-all", "--yes"],
      expect.objectContaining({ cwd: "/tmp/eve-agent" }),
    );
  });

  it("waits for the aborted attempt to settle before cleaning up and retrying", async () => {
    const firstCreate = deferred<{ ok: boolean; stdout: string }>();
    mockedRunVercelCaptureStdout
      .mockImplementationOnce(() => firstCreate.promise)
      .mockResolvedValueOnce({
        ok: true,
        stdout: createSlackConnectorJson("slack/my-agent-2", "scl_second"),
      });
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel.mockImplementation(
      async (args) =>
        emptyInspection(args) ?? {
          ok: true,
          stdout: connectedSlackConnectorJson("slack/my-agent-2", "scl_second", "Vercel"),
        },
    );

    const log = choiceLog(["retry", "never"]);
    const provisioning = provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => LINK,
        ...makeClock(),
      },
      { awaitChoice: log.awaitChoice },
    );

    await vi.waitFor(() =>
      expect(mockedRunVercelCaptureStdout.mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    const createCallsBeforeFirstSettled = mockedRunVercelCaptureStdout.mock.calls.length;
    firstCreate.resolve({
      ok: true,
      stdout: createSlackConnectorJson("slack/my-agent", "scl_first"),
    });

    await expect(provisioning).resolves.toMatchObject({ state: "attached" });
    expect(createCallsBeforeFirstSettled).toBe(1);
    const removeCall = mockedRunVercel.mock.invocationCallOrder.find(
      (_, index) => mockedRunVercel.mock.calls[index]?.[0][1] === "remove",
    );
    expect(removeCall).toBeDefined();
    expect(removeCall!).toBeLessThan(mockedRunVercelCaptureStdout.mock.invocationCallOrder[1]!);
  });

  it("does not retry when the abandoned connector cannot be removed", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createSlackConnectorJson("slack/my-agent"),
    });
    mockedRunVercel.mockImplementation(async (args) => args[1] !== "remove");
    mockedCaptureVercel.mockImplementation(
      async (args) =>
        emptyInspection(args) ?? { ok: true, stdout: createSlackConnectorJson("slack/my-agent") },
    );

    const log = choiceLog(["retry", "cancel"]);
    const result = await provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => LINK,
        ...makeClock(),
      },
      { awaitChoice: log.awaitChoice },
    );

    expect(result).toEqual({
      state: "cleanup-failed",
      connectorUids: ["slack/my-agent"],
    });
    expect(mockedRunVercelCaptureStdout).toHaveBeenCalledTimes(1);
  });

  it("opens the install page for an existing connector and finishes once it is installed", async () => {
    const connect = fakeConnect([connector({ uid: "slack/my-agent", installed: false })]);
    mockedOpenUrl.mockImplementation(() => {
      connect.state.get("slack/my-agent")!.installed = true;
    });

    const result = await provisionSlackbot(createTestLog(), ROOT, "my-agent", {
      ...connect.deps,
      ...makeClock(),
    });

    expect(result).toMatchObject({ state: "attached", connectorUid: "slack/my-agent" });
    expect(mockedOpenUrl).toHaveBeenCalledOnce();
    expect(mockedOpenUrl.mock.calls[0]![0]).toMatch(INSTALL_URL);
    expect(connect.mutations()).not.toContainEqual(
      expect.stringMatching(/^connect (create|remove)/),
    );
  });

  it("opens a fresh install page when the user asks to try again", async () => {
    fakeConnect([connector({ uid: "slack/my-agent", installed: false })]);
    const log = choiceLog(["retry", "cancel"]);

    const result = await provisionSlackbot(
      log,
      ROOT,
      "my-agent",
      { ...linkedDeps(), ...makeClock() },
      { awaitChoice: log.awaitChoice },
    );

    expect(result).toEqual({ state: "existing-not-installed", connectorUid: "slack/my-agent" });
    const urls = mockedOpenUrl.mock.calls.map(([url]) => url);
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(url).toMatch(INSTALL_URL);
    expect(urls[0]).not.toBe(urls[1]);
  });

  it("reports an existing connector that never installs without removing it", async () => {
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel.mockImplementation(async (args) => {
      if (!isListCall(args)) {
        return { ok: true, stdout: createSlackConnectorJson("slack/my-agent") };
      }
      return listPage([{ uid: "slack/my-agent", id: "scl_my_agent" }]);
    });

    const log = choiceLog(["never"]);
    const result = await provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => LINK,
        ...makeClock(),
      },
      { awaitChoice: log.awaitChoice },
    );

    expect(result).toEqual({
      state: "existing-not-installed",
      connectorUid: "slack/my-agent",
    });
    expect(log.awaitChoice).toHaveBeenCalledWith({
      status: "Waiting for the Slack workspace install...",
      context: "Install the Slack app in your browser, then wait while eve verifies it",
      actions: [
        { value: "retry", label: "Did your browser not open? Try again" },
        { value: "cancel", label: "Stop waiting" },
      ],
    });
    expect(mockedRunVercelCaptureStdout).not.toHaveBeenCalled();
    expect(mockedRunVercel).not.toHaveBeenCalledWith(
      ["connect", "remove", "slack/my-agent", "--disconnect-all", "--yes"],
      expect.anything(),
    );
    expect(log.warning).toHaveBeenCalledWith(
      'The Slack connector `slack/my-agent` is not installed in a Slack workspace yet. Re-run `eve add channel/slack` to open its install page again, or choose "Create a new Slack app" instead.',
    );
  });

  it("propagates an outer abort without claiming an existing connector is disconnected", async () => {
    const workspace = deferred<{ ok: true; stdout: string }>();
    const controller = new AbortController();
    mockedRunVercel.mockResolvedValue(true);
    let detailCalls = 0;
    mockedCaptureVercel.mockImplementation(async (args) => {
      // The snapshot sees no workspace; park the next lookup so the wait is
      // in flight when we abort.
      if (!isListCall(args)) {
        detailCalls += 1;
        return detailCalls === 1
          ? { ok: true, stdout: createSlackConnectorJson("slack/my-agent") }
          : workspace.promise;
      }
      return listPage([{ uid: "slack/my-agent", id: "scl_my_agent" }]);
    });
    const log = choiceLog(["never"]);

    const provisioning = provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => LINK,
        ...makeClock(),
      },
      { awaitChoice: log.awaitChoice, signal: controller.signal },
    );
    await vi.waitFor(() => expect(detailCalls).toBe(2));

    controller.abort();
    workspace.resolve({ ok: true, stdout: createSlackConnectorJson("slack/my-agent") });

    // The wait was interrupted, not concluded: the abort propagates and eve never
    // claims the connector is disconnected (it never finished checking).
    await expect(provisioning).rejects.toMatchObject({ name: "AbortError" });
    expect(log.warning).not.toHaveBeenCalledWith(
      expect.stringContaining("is not installed in a Slack workspace"),
    );
  });

  it("attaches and dismisses the prompt when the browser verifier finishes first", async () => {
    mockHappyPathProvision();
    const close = vi.fn();
    const log: ChoiceLog = Object.assign(createTestLog(), {
      awaitChoice: vi.fn(() => ({ choice: new Promise<string | undefined>(() => {}), close })),
    });

    const result = await provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => LINK,
        ...makeClock(),
      },
      { awaitChoice: log.awaitChoice },
    );

    expect(result.state).toBe("attached");
    // The completed verifier won the race, so the prompt is torn down and nothing is removed.
    expect(close).toHaveBeenCalled();
    expect(mockedRunVercel).not.toHaveBeenCalledWith(
      ["connect", "remove", "slack/my-agent", "--disconnect-all", "--yes"],
      expect.anything(),
    );
  });

  it("keeps polling an existing connector until workspace metadata appears", async () => {
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel
      .mockResolvedValueOnce(listPage([{ uid: "slack/my-agent", id: "scl_my_agent" }]))
      .mockResolvedValueOnce({
        ok: true,
        stdout: createSlackConnectorJson("slack/my-agent"),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: createSlackConnectorJson("slack/my-agent"),
      })
      .mockResolvedValue({
        ok: true,
        stdout: connectedSlackConnectorJson("slack/my-agent"),
      });

    const result = await provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent", {
      captureVercel: mockedCaptureVercel,
      runVercel: mockedRunVercel,
      runVercelCaptureStdout: mockedRunVercelCaptureStdout,
      readProjectLink: async () => LINK,
      delay: async () => {},
    });

    expect(result).toMatchObject({
      state: "attached",
      chatUrl: "https://slack.com/app_redirect?app=A0&team=T0",
    });
    // Inventory, snapshot, two polls, then the destination replacement.
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(5);
    expect(mockedCaptureVercel.mock.calls.at(-1)?.[0]).toContain("PATCH");
    expect(mockedRunVercelCaptureStdout).not.toHaveBeenCalled();
  });

  it("reports an existing connector detail lookup failure instead of calling it pending", async () => {
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel
      .mockResolvedValueOnce(listPage([{ uid: "slack/my-agent", id: "scl_my_agent" }]))
      .mockResolvedValueOnce({
        ok: true,
        stdout: createSlackConnectorJson("slack/my-agent"),
      })
      .mockResolvedValueOnce({
        ok: false,
        failure: {
          code: 1,
          stdout: "",
          stderr: "service unavailable",
          message: "vercel api failed",
        },
      });

    const result = await provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent", {
      captureVercel: mockedCaptureVercel,
      runVercel: mockedRunVercel,
      runVercelCaptureStdout: mockedRunVercelCaptureStdout,
      readProjectLink: async () => LINK,
      delay: async () => {},
    });

    expect(result).toEqual({
      state: "installation-check-failed",
      connectorUid: "slack/my-agent",
    });
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(3);
  });

  it("never creates when a connector detail response is malformed", async () => {
    const connect = fakeConnect([connector({ uid: "slack/my-agent" })]);
    mockedCaptureVercel.mockImplementation(async (args) =>
      isListCall(args)
        ? listPage([{ uid: "slack/my-agent", id: "scl_my_agent" }])
        : { ok: true, stdout: JSON.stringify({ uid: "slack/my-agent" }) },
    );

    await expect(
      provisionSlackbot(createTestLog(), ROOT, "my-agent", connect.deps),
    ).resolves.toEqual({
      state: "connector-lookup-failed",
    });
    expect(connect.mutations()).toEqual([]);
  });

  it("enforces one five-minute deadline across existing connector detail requests", async () => {
    mockedRunVercel.mockResolvedValue(true);
    let now = 0;
    mockedCaptureVercel.mockImplementation(async (args, options) => {
      if (isListCall(args)) return listPage([{ uid: "slack/my-agent", id: "scl_my_agent" }]);
      now += options.timeoutMs ?? 0;
      return { ok: true, stdout: createSlackConnectorJson("slack/my-agent") };
    });

    const result = await provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent", {
      captureVercel: mockedCaptureVercel,
      runVercel: mockedRunVercel,
      runVercelCaptureStdout: mockedRunVercelCaptureStdout,
      readProjectLink: async () => LINK,
      delay: async (ms) => {
        now += ms;
      },
      now: () => now,
    });

    expect(result.state).toBe("existing-not-installed");
    // One snapshot read, then five polls inside the five-minute deadline.
    expect(now).toBe(6 * 60_000);
    const detailCalls = mockedCaptureVercel.mock.calls.filter(([args]) => !isListCall(args));
    expect(detailCalls).toHaveLength(6);
  });
});

describe("reconcileSlackUid", () => {
  it("does not patch or redeploy when trigger attachment failed", async () => {
    mockedUpdateSlackChannelConnectorUid.mockResolvedValue({ patched: true });

    const result = await reconcileSlackUid(
      createTestLog(),
      "/tmp/eve-agent",
      {
        state: "attach-failed",
        connectorUid: "slack/my-agent-1",
      },
      "slack/my-agent",
    );

    expect(result).toBe(true);
    expect(mockedUpdateSlackChannelConnectorUid).not.toHaveBeenCalled();
  });

  it("patches an assigned connector UID without deploying", async () => {
    mockedUpdateSlackChannelConnectorUid.mockResolvedValue({ patched: true });

    await expect(
      reconcileSlackUid(
        createTestLog(),
        "/tmp/eve-agent",
        {
          state: "attached",
          connectorUid: "slack/assigned-by-connect",
        },
        "slack/my-agent",
      ),
    ).resolves.toBe(true);

    expect(mockedUpdateSlackChannelConnectorUid).toHaveBeenCalledWith(
      "/tmp/eve-agent/agent/channels/slack.ts",
      "slack/assigned-by-connect",
    );
  });

  it("blocks deployment when an assigned connector UID cannot be patched", async () => {
    mockedUpdateSlackChannelConnectorUid.mockResolvedValue({ patched: false });

    await expect(
      reconcileSlackUid(
        createTestLog(),
        "/tmp/eve-agent",
        {
          state: "attached",
          connectorUid: "slack/assigned-by-connect",
        },
        "slack/my-agent",
      ),
    ).resolves.toBe(false);
  });
});
