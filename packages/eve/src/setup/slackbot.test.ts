import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelSetupAwaitChoice, ChannelSetupLog } from "#setup/cli/index.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { updateSlackChannelConnectorUid } from "#setup/scaffold/update/update-slack-channel.js";

import {
  parseCreatedSlackConnector,
  parseSlackConnectorDetails,
  pickSlackConnector,
  provisionSlackbot,
  reconcileSlackUid,
} from "./slackbot.js";

vi.mock("#setup/primitives/run-vercel.js", () => ({
  captureVercel: vi.fn(),
  runVercel: vi.fn(),
  runVercelCaptureStdout: vi.fn(),
}));

vi.mock("#setup/scaffold/update/update-slack-channel.js", () => ({
  updateSlackChannelConnectorUid: vi.fn(),
}));

const mockedCaptureVercel = vi.mocked(captureVercel);
const mockedRunVercel = vi.mocked(runVercel);
const mockedRunVercelCaptureStdout = vi.mocked(runVercelCaptureStdout);
const mockedUpdateSlackChannelConnectorUid = vi.mocked(updateSlackChannelConnectorUid);

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

/** Mocks the full new-connector path: inventory, completed browser verifier, attachment. */
function mockHappyPathProvision(): void {
  mockedRunVercelCaptureStdout.mockResolvedValue({
    ok: true,
    stdout: createSlackConnectorJson("slack/my-agent"),
  });
  mockedRunVercel.mockResolvedValue(true);
  mockedCaptureVercel.mockResolvedValueOnce({
    ok: true,
    stdout: JSON.stringify({ connectors: [] }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("pickSlackConnector", () => {
  const projectId = "prj_demo";

  it("reads the `connectors` key emitted by `vercel connect list -F json` (CLI 54+)", () => {
    const json = {
      connectors: [
        {
          uid: "slack/my-agent",
          id: "scl_my_agent",
          type: "slack",
          createdAt: 1,
          projects: [{ id: projectId }],
        },
      ],
    };

    expect(pickSlackConnector(json, projectId, undefined)).toEqual({
      uid: "slack/my-agent",
      id: "scl_my_agent",
    });
  });

  it("prefers the expected Slack connector UID attached to the project", () => {
    const json = {
      clients: [
        {
          uid: "slack/expected",
          id: "scl_expected",
          type: "slack",
          createdAt: 1,
          projects: [{ id: projectId }],
        },
        {
          uid: "slack/project-match",
          id: "scl_project",
          type: "slack",
          createdAt: 100,
          projects: [{ id: projectId }],
        },
      ],
    };

    expect(pickSlackConnector(json, projectId, "slack/expected")).toEqual({
      uid: "slack/expected",
      id: "scl_expected",
    });
  });

  it("does not adopt the expected UID from another project", () => {
    const json = {
      clients: [
        {
          uid: "slack/expected",
          id: "scl_expected",
          type: "slack",
          createdAt: 100,
          projects: [{ id: "prj_other" }],
        },
        {
          uid: "slack/project-match",
          id: "scl_project",
          type: "slack",
          createdAt: 1,
          projects: [{ id: projectId }],
        },
      ],
    };

    expect(pickSlackConnector(json, projectId, "slack/expected")).toEqual({
      uid: "slack/project-match",
      id: "scl_project",
    });
  });

  it("does not adopt any connector when the linked project is unknown", () => {
    const json = {
      connectors: [
        {
          uid: "slack/expected",
          id: "scl_expected",
          type: "slack",
          projects: [{ id: projectId }],
        },
      ],
    };

    expect(pickSlackConnector(json, undefined, "slack/expected")).toBeUndefined();
  });

  it("returns the newest Slack connector attached to the project", () => {
    const json = {
      clients: [
        {
          uid: "github/unrelated",
          id: "scl_github",
          type: "github",
          createdAt: 5,
          projects: [{ id: projectId }],
        },
        {
          uid: "slack/older",
          id: "scl_older",
          type: "slack",
          createdAt: 10,
          projects: [{ id: projectId }],
        },
        {
          uid: "slack/newer",
          id: "scl_newer",
          type: "slack",
          createdAt: 20,
          projects: [{ id: projectId }],
        },
      ],
    };

    expect(pickSlackConnector(json, projectId, undefined)).toEqual({
      uid: "slack/newer",
      id: "scl_newer",
    });
  });

  it("does not fall back to an unrelated newest Slack connector", () => {
    const json = {
      clients: [
        {
          uid: "slack/older",
          id: "scl_a",
          type: "slack",
          createdAt: 1,
          projects: [{ id: "prj_other" }],
        },
        { uid: "slack/newer", id: "scl_b", type: "slack", createdAt: 9, projects: [] },
      ],
    };

    expect(pickSlackConnector(json, projectId, undefined)).toBeUndefined();
  });

  it("requires both uid and id to be strings", () => {
    expect(
      pickSlackConnector({ clients: [{ type: "slack", uid: "slack/x" }] }, projectId, undefined),
    ).toBeUndefined();
    expect(
      pickSlackConnector({ clients: [{ type: "slack", id: "scl_x" }] }, projectId, undefined),
    ).toBeUndefined();
  });

  it("returns undefined for malformed input rather than throwing", () => {
    expect(pickSlackConnector(null, projectId, undefined)).toBeUndefined();
    expect(pickSlackConnector({}, projectId, undefined)).toBeUndefined();
    expect(pickSlackConnector({ clients: "nope" }, projectId, undefined)).toBeUndefined();
  });
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
    });
  });

  it("keeps a valid connector ref while workspace metadata is incomplete", () => {
    expect(
      parseSlackConnectorDetails({
        id: "scl_1",
        uid: "slack/my-agent",
        data: { appId: null, slackTeam: null },
      }),
    ).toEqual({ ref: { id: "scl_1", uid: "slack/my-agent" } });
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
  it("adopts an existing project connector instead of creating a duplicate", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          connectors: [
            {
              uid: "slack/my-agent",
              id: "scl_existing",
              type: "slack",
              createdAt: 1,
              projects: [{ id: "prj_demo" }],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: connectedSlackConnectorJson("slack/my-agent", "scl_existing"),
      });
    mockedRunVercel.mockResolvedValue(true);

    await expect(
      provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent", {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => ({ projectId: "prj_demo", orgId: "team_demo" }),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        state: "attached",
        connectorUid: "slack/my-agent",
      }),
    );

    expect(mockedRunVercelCaptureStdout).not.toHaveBeenCalled();
  });

  it("recognizes Slack workspace metadata from the connector detail payload", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          connectors: [
            {
              uid: "slack/my-agent",
              id: "scl_existing",
              type: "slack",
              createdAt: 1,
              projects: [{ id: "prj_demo" }],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          id: "scl_existing",
          uid: "slack/my-agent",
          data: {
            appId: "A0",
            slackTeam: { id: "T0", name: "Vercel" },
          },
        }),
      });
    mockedRunVercel.mockResolvedValue(true);

    await expect(
      provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent", {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
        readProjectLink: async () => ({ projectId: "prj_demo", orgId: "team_demo" }),
      }),
    ).resolves.toEqual({
      state: "attached",
      connectorUid: "slack/my-agent",
      chatUrl: "https://slack.com/app_redirect?app=A0&team=T0",
      workspaceName: "Vercel",
    });
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      ["api", "/v1/connect/connectors/scl_existing?teamId=team_demo", "--scope", "team_demo"],
      expect.objectContaining({ cwd: "/tmp/eve-agent" }),
    );
  });

  it("fails closed when creation succeeds without an exact connector ref", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({ ok: true, stdout: "" });
    mockedCaptureVercel.mockResolvedValue({ ok: true, stdout: JSON.stringify({ clients: [] }) });

    const result = await provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent");

    expect(result).toEqual({
      state: "cleanup-failed",
      connectorUids: [],
    });
  });

  it("preserves creation success when trigger attachment fails", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({ connectors: [] }),
      })
      .mockResolvedValue({
        ok: true,
        stdout: connectedSlackConnectorJson("slack/my-agent", "scl_my_agent", "Vercel"),
      });
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createSlackConnectorJson("slack/my-agent"),
    });
    mockedRunVercel.mockImplementation(async (args) => {
      const command = args.join(" ");
      if (command.startsWith("connect detach slack/my-agent")) return true;
      if (command.startsWith("connect attach slack/my-agent")) return false;
      throw new Error(`Unexpected vercel command: ${command}`);
    });

    const result = await provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent");

    expect(result).toEqual({
      state: "attach-failed",
      connectorUid: "slack/my-agent",
    });
  });

  it("does not attach when the existing trigger destination cannot be detached", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({ connectors: [] }),
      })
      .mockResolvedValue({
        ok: true,
        stdout: connectedSlackConnectorJson("slack/my-agent", "scl_my_agent", "Vercel"),
      });
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createSlackConnectorJson("slack/my-agent"),
    });
    mockedRunVercel.mockImplementation(async (args) => {
      const command = args.join(" ");
      if (command.startsWith("connect detach slack/my-agent")) return false;
      throw new Error(`Unexpected vercel command: ${command}`);
    });

    const result = await provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent");

    expect(result).toEqual({
      state: "detach-failed",
      connectorUid: "slack/my-agent",
    });
    expect(mockedRunVercel).toHaveBeenCalledTimes(1);
  });

  it("resolves the UID from create JSON, then attaches the eve trigger route", async () => {
    mockHappyPathProvision();

    await expect(provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent")).resolves.toEqual(
      {
        state: "attached",
        connectorUid: "slack/my-agent",
      },
    );

    // Created with --triggers, the slug name, and JSON output for deterministic UID capture.
    expect(mockedRunVercelCaptureStdout).toHaveBeenCalledWith(
      ["connect", "create", "slack", "--triggers", "--name", "my-agent", "-F", "json"],
      expect.objectContaining({ cwd: "/tmp/eve-agent", nonInteractive: true }),
    );
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["connect", "list", "-F", "json", "--all-projects"],
      expect.objectContaining({ cwd: "/tmp/eve-agent" }),
    );
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(1);
    expect(mockedRunVercel).toHaveBeenNthCalledWith(
      1,
      ["connect", "detach", "slack/my-agent", "--yes"],
      expect.objectContaining({ cwd: "/tmp/eve-agent", nonInteractive: true }),
    );
    expect(mockedRunVercel).toHaveBeenNthCalledWith(
      2,
      [
        "connect",
        "attach",
        "slack/my-agent",
        "--triggers",
        "--trigger-path",
        "/eve/v1/slack",
        "--yes",
      ],
      expect.objectContaining({ cwd: "/tmp/eve-agent", nonInteractive: true }),
    );
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
      if (args[0] === "connect") {
        return { ok: true, stdout: JSON.stringify({ connectors: [] }) };
      }
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
        readProjectLink: async () => ({ projectId: "prj_demo", orgId: "team_demo" }),
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
      if (args[0] === "connect") {
        return { ok: true, stdout: JSON.stringify({ connectors: [] }) };
      }
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
      readProjectLink: async () => ({ projectId: "prj_demo", orgId: "team_demo" }),
      delay: async (ms) => {
        now += ms;
      },
      now: () => now,
    });

    await expect(provisioning).resolves.toMatchObject({ state: "attached" });
    expect(connectorLookups).toBe(3);
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
      if (args[0] === "connect") {
        return { ok: true, stdout: JSON.stringify({ connectors: [] }) };
      }
      if (args[1] === "/v1/connect/connectors/scl_partial") {
        return connectorLookup.promise;
      }
      throw new Error(`Unexpected vercel command: ${args.join(" ")}`);
    });

    const provisioning = provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent", {
      captureVercel: mockedCaptureVercel,
      runVercel: mockedRunVercel,
      runVercelCaptureStdout: mockedRunVercelCaptureStdout,
    });
    await vi.waitFor(() =>
      expect(mockedCaptureVercel).toHaveBeenCalledWith(
        ["api", "/v1/connect/connectors/scl_partial"],
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

    await provisionSlackbot(log, "/tmp/eve-agent", "my-agent");

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

    await provisionSlackbot(log, "/tmp/eve-agent", "my-agent");

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
    let listCalls = 0;
    mockedCaptureVercel.mockImplementation(async (args) => {
      if (args[0] === "api") {
        return { ok: true, stdout: createSlackConnectorJson("slack/my-agent") };
      }
      listCalls += 1;
      const connectors =
        listCalls === 1
          ? []
          : [
              {
                uid: "slack/my-agent",
                id: "scl_my_agent",
                type: "slack",
                createdAt: 1,
                projects: [],
              },
            ];
      return { ok: true, stdout: JSON.stringify({ connectors }) };
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

  it("fails closed when remove fails even if one inventory read omits the connector", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createSlackConnectorJson("slack/my-agent"),
    });
    mockedRunVercel.mockImplementation(async (args) => args[1] !== "remove");
    mockedCaptureVercel.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ connectors: [] }),
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
    mockedRunVercelCaptureStdout.mockImplementationOnce(() => create.promise);
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ connectors: [] }),
    });

    const provisioning = provisionSlackbot(
      createTestLog(),
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
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
    mockedRunVercelCaptureStdout.mockImplementationOnce(() => create.promise);
    mockedCaptureVercel.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ connectors: [] }),
    });

    const provisioning = provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(mockedRunVercelCaptureStdout).toHaveBeenCalledOnce());

    controller.abort();
    create.resolve({ ok: true, stdout: "" });

    await expect(provisioning).rejects.toMatchObject({ name: "AbortError" });
    expect(log.warning).toHaveBeenCalledWith(
      "Vercel returned no connector UID for the abandoned Slack Connect request, so eve cannot prove that request was cancelled. No connector was removed; do not retry until the browser request is no longer usable.",
    );
  });

  it("fails closed when create returns no exact connector ref and the inventory changed", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({ ok: true, stdout: "" });
    mockedRunVercel.mockResolvedValue(true);
    let listCalls = 0;
    mockedCaptureVercel.mockImplementation(async () => {
      listCalls += 1;
      return {
        ok: true,
        stdout: JSON.stringify({
          connectors:
            listCalls === 1
              ? [
                  {
                    uid: "slack/my-agent-legacy",
                    id: "scl_legacy",
                    type: "slack",
                    projects: [],
                  },
                ]
              : [
                  {
                    uid: "slack/my-agent-legacy",
                    id: "scl_legacy",
                    type: "slack",
                    projects: [],
                  },
                  {
                    uid: "slack/my-agent-2",
                    id: "scl_new",
                    type: "slack",
                    projects: [],
                  },
                ],
        }),
      };
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
        readProjectLink: async () => ({ projectId: "prj_demo", orgId: "team_demo" }),
        ...makeClock(),
      },
      { awaitChoice: log.awaitChoice },
    );

    expect(result).toEqual({
      state: "cleanup-failed",
      connectorUids: ["slack/my-agent-2"],
    });
    expect(mockedRunVercel).not.toHaveBeenCalledWith(
      ["connect", "remove", "slack/my-agent-2", "--disconnect-all", "--yes"],
      expect.anything(),
    );
    expect(mockedRunVercel).not.toHaveBeenCalledWith(
      ["connect", "remove", "slack/my-agent-legacy", "--disconnect-all", "--yes"],
      expect.anything(),
    );
  });

  it("does not retry an aborted request when no exact connector ref was returned", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({ ok: true, stdout: "" });
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ connectors: [] }),
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
      if (args[0] === "api") {
        const installed = mockedRunVercelCaptureStdout.mock.calls.length >= 2;
        return {
          ok: true,
          stdout: installed
            ? connectedSlackConnectorJson("slack/my-agent", "scl_my_agent", "Vercel")
            : createSlackConnectorJson("slack/my-agent"),
        };
      }
      return { ok: true, stdout: JSON.stringify({ connectors: [] }) };
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
    mockedCaptureVercel.mockImplementation(async (args) =>
      args[0] === "api"
        ? {
            ok: true,
            stdout: connectedSlackConnectorJson("slack/my-agent-2", "scl_second", "Vercel"),
          }
        : { ok: true, stdout: JSON.stringify({ connectors: [] }) },
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
    let listCalls = 0;
    mockedCaptureVercel.mockImplementation(async () => {
      listCalls += 1;
      return {
        ok: true,
        stdout: JSON.stringify({
          connectors:
            listCalls === 1
              ? []
              : [
                  {
                    uid: "slack/my-agent",
                    id: "scl_my_agent",
                    type: "slack",
                    projects: [],
                  },
                ],
        }),
      };
    });

    const log = choiceLog(["retry", "cancel"]);
    const result = await provisionSlackbot(
      log,
      "/tmp/eve-agent",
      "my-agent",
      {
        captureVercel: mockedCaptureVercel,
        runVercel: mockedRunVercel,
        runVercelCaptureStdout: mockedRunVercelCaptureStdout,
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

  it("blocks recovery of a pre-existing connector without a workspace connection", async () => {
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel.mockImplementation(async (args) => {
      if (args[0] === "api") {
        return { ok: true, stdout: createSlackConnectorJson("slack/my-agent") };
      }
      return {
        ok: true,
        stdout: JSON.stringify({
          connectors: [
            {
              uid: "slack/my-agent",
              id: "scl_my_agent",
              type: "slack",
              createdAt: 1,
              projects: [{ id: "prj_demo" }],
            },
          ],
        }),
      };
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
        readProjectLink: async () => ({ projectId: "prj_demo", orgId: "team_demo" }),
        ...makeClock(),
      },
      { awaitChoice: log.awaitChoice },
    );

    expect(result).toEqual({
      state: "existing-not-installed",
      connectorUid: "slack/my-agent",
    });
    expect(log.awaitChoice).toHaveBeenCalledWith({
      status: "Waiting for the existing Slack workspace connection...",
      context: "Complete the original setup in the browser",
      actions: [{ value: "cancel", label: "Stop waiting" }],
    });
    expect(mockedRunVercelCaptureStdout).not.toHaveBeenCalled();
    expect(mockedRunVercel).not.toHaveBeenCalledWith(
      ["connect", "remove", "slack/my-agent", "--disconnect-all", "--yes"],
      expect.anything(),
    );
    expect(log.warning).toHaveBeenCalledWith(
      "The existing Slack connector `slack/my-agent` is not connected to a Slack workspace. eve did not remove it because this run did not create it. If its original browser request is still open, complete it; otherwise run `vercel connect remove slack/my-agent --disconnect-all --yes` before trying again.",
    );
  });

  it("propagates an outer abort without claiming an existing connector is disconnected", async () => {
    const workspace = deferred<{ ok: true; stdout: string }>();
    const controller = new AbortController();
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel.mockImplementation(async (args) => {
      // Park the workspace lookup so the wait is in-flight when we abort.
      if (args[0] === "api") return workspace.promise;
      return {
        ok: true,
        stdout: JSON.stringify({
          connectors: [
            {
              uid: "slack/my-agent",
              id: "scl_my_agent",
              type: "slack",
              createdAt: 1,
              projects: [{ id: "prj_demo" }],
            },
          ],
        }),
      };
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
        readProjectLink: async () => ({ projectId: "prj_demo", orgId: "team_demo" }),
        ...makeClock(),
      },
      { awaitChoice: log.awaitChoice, signal: controller.signal },
    );
    await vi.waitFor(() =>
      expect(mockedCaptureVercel).toHaveBeenCalledWith(
        ["api", "/v1/connect/connectors/scl_my_agent?teamId=team_demo", "--scope", "team_demo"],
        expect.anything(),
      ),
    );

    controller.abort();
    workspace.resolve({ ok: true, stdout: createSlackConnectorJson("slack/my-agent") });

    // The wait was interrupted, not concluded: the abort propagates and eve never
    // claims the connector is disconnected (it never finished checking).
    await expect(provisioning).rejects.toMatchObject({ name: "AbortError" });
    expect(log.warning).not.toHaveBeenCalledWith(
      expect.stringContaining("is not connected to a Slack workspace"),
    );
  });

  it("attaches and dismisses the prompt when the browser verifier finishes first", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createSlackConnectorJson("slack/my-agent"),
    });
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel.mockResolvedValueOnce({
      ok: true,
      stdout: JSON.stringify({ connectors: [] }),
    });
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
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          connectors: [
            {
              uid: "slack/my-agent",
              id: "scl_my_agent",
              type: "slack",
              createdAt: 1,
              projects: [{ id: "prj_demo" }],
            },
          ],
        }),
      })
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
      readProjectLink: async () => ({ projectId: "prj_demo", orgId: "team_demo" }),
      delay: async () => {},
    });

    expect(result).toMatchObject({
      state: "attached",
      chatUrl: "https://slack.com/app_redirect?app=A0&team=T0",
    });
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(4);
    expect(mockedRunVercelCaptureStdout).not.toHaveBeenCalled();
  });

  it("reports an existing connector detail lookup failure instead of calling it pending", async () => {
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          connectors: [
            {
              uid: "slack/my-agent",
              id: "scl_my_agent",
              type: "slack",
              createdAt: 1,
              projects: [{ id: "prj_demo" }],
            },
          ],
        }),
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
      readProjectLink: async () => ({ projectId: "prj_demo", orgId: "team_demo" }),
      delay: async () => {},
    });

    expect(result).toEqual({
      state: "installation-check-failed",
      connectorUid: "slack/my-agent",
    });
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(2);
  });

  it("reports a malformed connector detail response instead of calling it pending", async () => {
    mockedRunVercel.mockResolvedValue(true);
    mockedCaptureVercel
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          connectors: [
            {
              uid: "slack/my-agent",
              id: "scl_my_agent",
              type: "slack",
              createdAt: 1,
              projects: [{ id: "prj_demo" }],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({ uid: "slack/my-agent" }),
      });

    const result = await provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent", {
      captureVercel: mockedCaptureVercel,
      runVercel: mockedRunVercel,
      runVercelCaptureStdout: mockedRunVercelCaptureStdout,
      readProjectLink: async () => ({ projectId: "prj_demo", orgId: "team_demo" }),
    });

    expect(result.state).toBe("installation-check-failed");
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(2);
  });

  it("never creates when the existing-connector lookup fails", async () => {
    mockedCaptureVercel.mockResolvedValue({
      ok: false,
      failure: {
        code: 1,
        stdout: "",
        stderr: "service unavailable",
        message: "vercel connect list failed",
      },
    });

    await expect(provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent")).resolves.toEqual(
      {
        state: "connector-lookup-failed",
      },
    );
    expect(mockedRunVercelCaptureStdout).not.toHaveBeenCalled();
  });

  it("never creates when project ownership is unknown and Slack connectors already exist", async () => {
    mockedCaptureVercel.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        connectors: [
          {
            uid: "slack/my-agent",
            id: "scl_other_project",
            type: "slack",
            projects: [{ id: "prj_other" }],
          },
        ],
      }),
    });
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createSlackConnectorJson("slack/my-agent-2"),
    });

    await expect(provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent")).resolves.toEqual(
      {
        state: "connector-lookup-failed",
      },
    );
    expect(mockedRunVercelCaptureStdout).not.toHaveBeenCalled();
  });

  it("enforces one five-minute deadline across existing connector detail requests", async () => {
    mockedRunVercel.mockResolvedValue(true);
    let now = 0;
    mockedCaptureVercel.mockImplementation(async (args, options) => {
      if (args[0] === "connect") {
        return {
          ok: true,
          stdout: JSON.stringify({
            connectors: [
              {
                uid: "slack/my-agent",
                id: "scl_my_agent",
                type: "slack",
                createdAt: 1,
                projects: [{ id: "prj_demo" }],
              },
            ],
          }),
        };
      }
      now += options.timeoutMs ?? 0;
      return { ok: true, stdout: createSlackConnectorJson("slack/my-agent") };
    });

    const result = await provisionSlackbot(createTestLog(), "/tmp/eve-agent", "my-agent", {
      captureVercel: mockedCaptureVercel,
      runVercel: mockedRunVercel,
      runVercelCaptureStdout: mockedRunVercelCaptureStdout,
      readProjectLink: async () => ({ projectId: "prj_demo", orgId: "team_demo" }),
      delay: async (ms) => {
        now += ms;
      },
      now: () => now,
    });

    expect(result.state).toBe("existing-not-installed");
    expect(now).toBe(5 * 60_000);
    const detailCalls = mockedCaptureVercel.mock.calls.filter(([args]) => args[0] === "api");
    expect(detailCalls).toHaveLength(5);
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
