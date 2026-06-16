import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ChannelSetupLog } from "#setup/cli/index.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";

import {
  parseCreatedConnector,
  pickConnectConnector,
  setupConnectionConnector,
} from "./connection-connector.js";

vi.mock("#setup/primitives/run-vercel.js", () => ({
  captureVercel: vi.fn(),
  runVercel: vi.fn(),
  runVercelCaptureStdout: vi.fn(),
}));

const mockedCaptureVercel = vi.mocked(captureVercel);
const mockedRunVercel = vi.mocked(runVercel);
const mockedRunVercelCaptureStdout = vi.mocked(runVercelCaptureStdout);

const SERVICE = "mcp.linear.app";

/** `vercel connect create … -F json` stdout payload on CLI 54.x. */
function createConnectorJson(uid: string, id = "scl_linear"): string {
  return JSON.stringify({ uid, id, type: "oauth", name: "linear" });
}

describe("parseCreatedConnector", () => {
  test("reads uid and id from `vercel connect create -F json` stdout", () => {
    expect(parseCreatedConnector(createConnectorJson("linear/my-agent", "scl_1"))).toEqual({
      uid: "linear/my-agent",
      id: "scl_1",
    });
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseCreatedConnector(`\n  ${createConnectorJson("linear/x")}  \n`)?.uid).toBe(
      "linear/x",
    );
  });

  test("returns undefined for empty, non-JSON, or shape-mismatched stdout", () => {
    expect(parseCreatedConnector("")).toBeUndefined();
    expect(parseCreatedConnector("   ")).toBeUndefined();
    expect(parseCreatedConnector("Vercel CLI 54.9.1")).toBeUndefined();
    expect(parseCreatedConnector(JSON.stringify({ uid: "linear/x" }))).toBeUndefined();
    expect(parseCreatedConnector(JSON.stringify({ id: "scl_1" }))).toBeUndefined();
    expect(parseCreatedConnector(JSON.stringify([1, 2, 3]))).toBeUndefined();
  });
});

describe("pickConnectConnector", () => {
  test("reads the `connectors` key emitted by `vercel connect list -F json`", () => {
    const list = {
      connectors: [{ uid: "linear/my-agent", id: "scl_1", type: "oauth", createdAt: 1 }],
    };
    expect(pickConnectConnector(list, SERVICE, undefined)?.uid).toBe("linear/my-agent");
  });

  test("prefers a connector attached to the project", () => {
    const list = {
      connectors: [
        { uid: "linear/a", id: "1", type: "oauth", createdAt: 1, projects: [] },
        { uid: "linear/b", id: "2", type: "oauth", createdAt: 2, projects: [{ id: "prj_1" }] },
      ],
    };
    expect(pickConnectConnector(list, SERVICE, "prj_1")?.uid).toBe("linear/b");
  });

  test("falls back to the newest connector when none are attached", () => {
    const list = {
      connectors: [
        { uid: "linear/a", id: "1", type: "oauth", createdAt: 1 },
        { uid: "linear/b", id: "2", type: "oauth", createdAt: 5 },
      ],
    };
    expect(pickConnectConnector(list, SERVICE, undefined)?.uid).toBe("linear/b");
  });

  test("accepts connectors whose type is not `oauth` (managed MCP connectors)", () => {
    const list = { connectors: [{ uid: "linear/mcp", id: "1", type: "mcp", createdAt: 1 }] };
    expect(pickConnectConnector(list, SERVICE, undefined)?.uid).toBe("linear/mcp");
  });

  test("defensively skips connectors whose reported service differs", () => {
    const list = {
      connectors: [
        { uid: "notion/x", id: "1", type: "oauth", service: "mcp.notion.com", createdAt: 8 },
        { uid: "linear/x", id: "2", type: "oauth", service: SERVICE, createdAt: 1 },
      ],
    };
    expect(pickConnectConnector(list, SERVICE, undefined)?.uid).toBe("linear/x");
  });

  test("falls back to the legacy `clients` key for older CLI builds", () => {
    const list = { clients: [{ uid: "linear/legacy", id: "1", type: "oauth", createdAt: 1 }] };
    expect(pickConnectConnector(list, SERVICE, undefined)?.uid).toBe("linear/legacy");
  });

  test("returns undefined for malformed input", () => {
    expect(pickConnectConnector(null, SERVICE, undefined)).toBeUndefined();
    expect(pickConnectConnector({}, SERVICE, undefined)).toBeUndefined();
    expect(pickConnectConnector({ connectors: "nope" }, SERVICE, undefined)).toBeUndefined();
  });
});

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

/** Connector list payload as emitted by `vercel connect list -F json` on CLI 54.x. */
function connectListV54(connectorUid: string, projectId: string) {
  return JSON.stringify({
    connectors: [
      {
        uid: connectorUid,
        id: "scl_linear",
        name: "linear",
        type: "oauth",
        typeName: "Linear",
        createdAt: 2,
        icon: null,
        backgroundColor: null,
        accentColor: null,
        projects: [{ id: projectId, name: "my-agent" }],
        hasMoreProjects: false,
      },
    ],
    cursor: undefined,
  });
}

describe("setupConnectionConnector (end-to-end)", () => {
  let projectRoot: string;
  let connectionFilePath: string;
  const PROJECT_ID = "prj_ExampleProjectId0000000000";

  beforeEach(async () => {
    vi.clearAllMocks();
    // The connector attach succeeds by default; failure is exercised separately.
    mockedRunVercel.mockResolvedValue(true);
    projectRoot = await mkdtemp(join(tmpdir(), "eve-setup-connection-"));
    await mkdir(join(projectRoot, ".vercel"), { recursive: true });
    await writeFile(
      join(projectRoot, ".vercel", "project.json"),
      JSON.stringify({ projectId: PROJECT_ID, orgId: "team_x" }),
      "utf8",
    );
    await mkdir(join(projectRoot, "agent", "connections"), { recursive: true });
    connectionFilePath = join(projectRoot, "agent", "connections", "linear.ts");
    // Mirrors the scaffolder's emitted `auth: connect("<slug>")` placeholder.
    await writeFile(
      connectionFilePath,
      [
        'import { defineMcpClientConnection } from "eve/connections";',
        'import { connect } from "@vercel/connect";',
        "",
        "export default defineMcpClientConnection({",
        '  url: "https://mcp.linear.app/sse",',
        '  auth: connect("linear"),',
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  test("resolves the UID from `connect create -F json` without a follow-up list", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createConnectorJson("linear/my-agent"),
    });

    const result = await setupConnectionConnector({
      log: createTestLog(),
      projectRoot,
      slug: "linear",
      service: SERVICE,
      connectionFilePath,
    });

    expect(result).toEqual({ kind: "patched", created: true, connectorUid: "linear/my-agent" });

    // Created with the catalog service identifier, slug name, and JSON output.
    expect(mockedRunVercelCaptureStdout).toHaveBeenCalledWith(
      ["connect", "create", SERVICE, "--name", "linear", "-F", "json"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    // The authoritative create payload makes the flaky list lookup unnecessary.
    expect(mockedCaptureVercel).not.toHaveBeenCalled();
    // The connector is attached to the linked project so the agent can call it.
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["connect", "attach", "linear/my-agent", "--yes"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    // The generated connect("…") UID was rewritten on disk.
    const patched = await readFile(connectionFilePath, "utf8");
    expect(patched).toContain('connect("linear/my-agent")');
    expect(patched).not.toContain('connect("linear")');
  });

  test("warns but still patches when attaching the connector to the project fails", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createConnectorJson("linear/my-agent"),
    });
    mockedRunVercel.mockResolvedValue(false);
    const log = createTestLog();

    const result = await setupConnectionConnector({
      log,
      projectRoot,
      slug: "linear",
      service: SERVICE,
      connectionFilePath,
    });

    // Attach failure is non-fatal: the connector exists and the file is patched.
    expect(result).toEqual({ kind: "patched", created: true, connectorUid: "linear/my-agent" });
    expect(log.warning).toHaveBeenCalledWith(
      expect.stringContaining("could not attach it to this project"),
    );
    expect(await readFile(connectionFilePath, "utf8")).toContain('connect("linear/my-agent")');
  });

  test("falls back to a service-scoped list when create emits no parseable JSON", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({ ok: true, stdout: "Vercel CLI 54.9.1\n" });
    mockedCaptureVercel.mockResolvedValue({
      ok: true,
      stdout: connectListV54("linear/my-agent", PROJECT_ID),
    });

    const result = await setupConnectionConnector({
      log: createTestLog(),
      projectRoot,
      slug: "linear",
      service: SERVICE,
      connectionFilePath,
    });

    expect(result).toEqual({ kind: "patched", created: true, connectorUid: "linear/my-agent" });
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["connect", "list", "-F", "json", "--all-projects", "--service", SERVICE],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(await readFile(connectionFilePath, "utf8")).toContain('connect("linear/my-agent")');
  });

  test("fallback still resolves the legacy `clients` key from older CLI builds", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({ ok: true, stdout: "" });
    mockedCaptureVercel.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        clients: [
          { uid: "linear/legacy", id: "scl_legacy", type: "oauth", createdAt: 1, projects: [] },
        ],
      }),
    });

    const result = await setupConnectionConnector({
      log: createTestLog(),
      projectRoot,
      slug: "linear",
      service: SERVICE,
      connectionFilePath,
    });

    expect(result).toEqual({ kind: "patched", created: true, connectorUid: "linear/legacy" });
    expect(await readFile(connectionFilePath, "utf8")).toContain('connect("linear/legacy")');
  });

  test("reports create-failed and leaves the file untouched when create fails", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({ ok: false, stdout: "" });

    const result = await setupConnectionConnector({
      log: createTestLog(),
      projectRoot,
      slug: "linear",
      service: SERVICE,
      connectionFilePath,
    });

    expect(result).toEqual({ kind: "create-failed", created: false });
    expect(mockedCaptureVercel).not.toHaveBeenCalled();
    expect(await readFile(connectionFilePath, "utf8")).toContain('connect("linear")');
  });

  test("links a Vercel project when none is linked yet, then attaches", async () => {
    // Start unlinked: the gateway step used an API key/local provider, or this
    // is a fresh `eve connections add` checkout.
    await rm(join(projectRoot, ".vercel", "project.json"), { force: true });
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createConnectorJson("linear/my-agent"),
    });
    // `vercel link` writes `.vercel/project.json`; everything else succeeds.
    mockedRunVercel.mockImplementation(async (args) => {
      if (args[0] === "link") {
        await writeFile(
          join(projectRoot, ".vercel", "project.json"),
          JSON.stringify({ projectId: PROJECT_ID, orgId: "team_x" }),
          "utf8",
        );
      }
      return true;
    });
    const log = createTestLog();

    const result = await setupConnectionConnector({
      log,
      projectRoot,
      slug: "linear",
      service: SERVICE,
      connectionFilePath,
    });

    expect(result).toEqual({ kind: "patched", created: true, connectorUid: "linear/my-agent" });
    // Linked first, then attached to the now-linked project.
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["link"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["connect", "attach", "linear/my-agent", "--yes"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(await readFile(connectionFilePath, "utf8")).toContain('connect("linear/my-agent")');
  });

  test("creates the connector but skips attach when linking does not complete", async () => {
    await rm(join(projectRoot, ".vercel", "project.json"), { force: true });
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createConnectorJson("linear/my-agent"),
    });
    // `vercel link` is declined/fails, so no project.json is written.
    mockedRunVercel.mockResolvedValue(false);
    mockedCaptureVercel.mockResolvedValue({ ok: true, stdout: JSON.stringify({ connectors: [] }) });
    const log = createTestLog();

    const result = await setupConnectionConnector({
      log,
      projectRoot,
      slug: "linear",
      service: SERVICE,
      connectionFilePath,
    });

    // The connector still exists and the file is patched; attach is skipped.
    expect(result).toEqual({ kind: "patched", created: true, connectorUid: "linear/my-agent" });
    expect(mockedRunVercel).not.toHaveBeenCalledWith(
      ["connect", "attach", "linear/my-agent", "--yes"],
      expect.anything(),
    );
    expect(log.warning).toHaveBeenCalledWith(
      expect.stringContaining("no Vercel project is linked"),
    );
    expect(await readFile(connectionFilePath, "utf8")).toContain('connect("linear/my-agent")');
  });

  test("reports connector-unresolved when neither create nor the list yield a UID", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({ ok: true, stdout: "" });
    mockedCaptureVercel.mockResolvedValue({ ok: true, stdout: JSON.stringify({ connectors: [] }) });

    const result = await setupConnectionConnector({
      log: createTestLog(),
      projectRoot,
      slug: "linear",
      service: SERVICE,
      connectionFilePath,
    });

    expect(result).toEqual({ kind: "connector-unresolved", created: true });
    expect(await readFile(connectionFilePath, "utf8")).toContain('connect("linear")');
  });
});
