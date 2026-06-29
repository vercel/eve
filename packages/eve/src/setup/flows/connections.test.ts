import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { AddConnectionsDeps } from "#setup/boxes/add-connections.js";
import type { DeploymentInfo } from "#setup/project-resolution.js";
import type { PrompterValue, SingleSelectOptions } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";

import {
  CONNECTIONS_PROMPT_MESSAGE,
  runConnectionsFlow,
  type ConnectionsFlowDeps,
} from "./connections.js";

const APP_ROOT = "/app/agent";
const LINKED: DeploymentInfo = { state: "linked", projectId: "prj_1", orgId: "org_1" };

function scriptConnectionList(queue: Array<PrompterValue | "cancel">) {
  const requests: SingleSelectOptions<PrompterValue>[] = [];
  return {
    requests,
    single(options: SingleSelectOptions<PrompterValue>): PrompterValue {
      if (options.message !== CONNECTIONS_PROMPT_MESSAGE) {
        throw new Error(`Unexpected select: ${options.message}`);
      }
      requests.push(options);
      const next = queue.shift();
      if (next === undefined) throw new Error("Connection list exhausted its scripted picks.");
      if (next === "cancel") throw new WizardCancelledError();
      return next;
    },
  };
}

function addConnectionDeps(): AddConnectionsDeps {
  return {
    ensureConnection: vi.fn<AddConnectionsDeps["ensureConnection"]>(async (options) => ({
      slug: options.slug ?? options.entry.slug,
      protocol: options.protocol,
      action: "created",
      filePath: `${APP_ROOT}/agent/connections/${options.slug ?? options.entry.slug}.ts`,
      filesWritten: [`${APP_ROOT}/agent/connections/${options.slug ?? options.entry.slug}.ts`],
      filesSkipped: [],
      packageJsonUpdated: [],
      envKeysAdded: [],
      envKeysRequired: [],
    })),
    setupConnectionConnector: vi.fn<AddConnectionsDeps["setupConnectionConnector"]>(async () =>
      Object.freeze({ kind: "existing", connectorUid: "mcp.linear.app/linear" }),
    ),
    listAuthoredConnections: vi.fn(async () => []),
    readProjectLink: vi.fn(async () => ({ orgId: "org_1", projectId: "prj_1" })),
    cleanupCreatedConnectionConnector: vi.fn(async () => {}),
  };
}

function runConnectionFlow(
  list: ReturnType<typeof scriptConnectionList>,
  deps: Partial<ConnectionsFlowDeps> = {},
  disabledConnectionReasons: Readonly<Record<string, string>> = {},
) {
  const defaults: ConnectionsFlowDeps = {
    detectDeployment: vi.fn(async () => LINKED),
    detectPackageManager: vi.fn(async () => Object.freeze({ kind: "pnpm", source: "default" })),
    ensureConnectionDependencies: vi.fn(async () => []),
    getVercelAuthStatus: vi.fn(() => Promise.resolve<"authenticated">("authenticated")),
    listAuthoredConnections: vi.fn(async () => []),
    runLinkFlow: vi.fn(async () => Object.freeze({ kind: "done" })),
    runPackageManagerInstall: vi.fn(async () => true),
    addConnections: addConnectionDeps(),
  };
  return runConnectionsFlow({
    appRoot: APP_ROOT,
    prompter: createFakePrompter({ single: list.single }).prompter,
    disabledConnectionReasons,
    deps: { ...defaults, ...deps },
  });
}

describe("runConnectionsFlow", () => {
  it("returns a terminal success after adding a catalog connection", async () => {
    const listAuthoredConnections = vi
      .fn(async () => [] as string[])
      .mockResolvedValueOnce([])
      .mockResolvedValue(["linear"]);
    const list = scriptConnectionList(["linear"]);

    await expect(runConnectionFlow(list, { listAuthoredConnections })).resolves.toEqual({
      kind: "done",
      addedConnections: ["linear"],
    });

    expect(list.requests[0]).toMatchObject({
      hintLayout: "inline",
      search: true,
      placeholder: "type to search MCP servers",
    });
    expect(list.requests[0]?.options.map((row) => row.value)).toEqual([
      "linear",
      "notion",
      "datadog",
      "honeycomb",
      "done",
    ]);
    expect(list.requests).toHaveLength(1);
  });

  it("defaults to Done when every catalog connection is already authored", async () => {
    const list = scriptConnectionList(["done"]);
    await runConnectionFlow(list, {
      listAuthoredConnections: vi.fn(async () => ["linear", "notion", "datadog", "honeycomb"]),
    });

    expect(list.requests[0]?.initialValue).toBe("done");
  });

  it("blocks logged-out rows", async () => {
    const loggedOutList = scriptConnectionList(["cancel"]);
    await expect(
      runConnectionFlow(loggedOutList, {
        detectDeployment: vi.fn(() => Promise.resolve<DeploymentInfo>({ state: "unlinked" })),
        getVercelAuthStatus: vi.fn(async (): Promise<"logged-out"> => "logged-out"),
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(loggedOutList.requests[0]?.options.find((row) => row.value === "linear")).toMatchObject({
      disabled: true,
      disabledReason: "Log in to Vercel first, see /vc:login",
    });
  });

  it("disables a connection whose MCP endpoint is unreachable", async () => {
    const list = scriptConnectionList(["cancel"]);
    await expect(
      runConnectionFlow(
        list,
        {},
        {
          notion: "https://mcp.notion.com/mcp is not reachable (HTTP 404).",
        },
      ),
    ).resolves.toEqual({ kind: "cancelled" });

    expect(list.requests[0]?.options.find((row) => row.value === "notion")).toMatchObject({
      disabled: true,
      disabledReasonTone: "warning",
      disabledReason: "https://mcp.notion.com/mcp is not reachable (HTTP 404).",
    });
  });

  it("runs the shared create-or-link flow before configuring an unlinked project", async () => {
    const detectDeployment = vi
      .fn<ConnectionsFlowDeps["detectDeployment"]>()
      .mockResolvedValueOnce({ state: "unlinked" })
      .mockResolvedValueOnce(LINKED);
    const runLinkFlow = vi.fn<ConnectionsFlowDeps["runLinkFlow"]>(async () => ({ kind: "done" }));
    const listAuthoredConnections = vi
      .fn(async () => [] as string[])
      .mockResolvedValueOnce([])
      .mockResolvedValue(["linear"]);
    const list = scriptConnectionList(["linear"]);
    await expect(
      runConnectionFlow(list, {
        detectDeployment,
        listAuthoredConnections,
        runLinkFlow,
      }),
    ).resolves.toEqual({ kind: "done", addedConnections: ["linear"] });

    const linkInput = runLinkFlow.mock.calls[0]?.[0];
    expect(linkInput?.projectSelection).toBe("create-or-link");
    expect(linkInput?.teamSelectMessage?.("Acme")).toBe(
      "You need to link to a project to use Vercel Connect.\n\nSelect your team",
    );
  });

  it("returns a terminal cancellation when project linking is cancelled", async () => {
    const runLinkFlow = vi.fn(async () => Object.freeze({ kind: "cancelled" }));
    const list = scriptConnectionList(["linear"]);

    await expect(
      runConnectionFlow(list, {
        detectDeployment: vi.fn(() => Promise.resolve<DeploymentInfo>({ state: "unlinked" })),
        runLinkFlow,
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(list.requests).toHaveLength(1);
  });

  it("returns a terminal failure when connector setup fails", async () => {
    const list = scriptConnectionList(["linear"]);
    const addConnections = addConnectionDeps();
    vi.mocked(addConnections.setupConnectionConnector).mockRejectedValueOnce(
      new Error("Could not create the mcp.linear.app connector."),
    );

    await expect(runConnectionFlow(list, { addConnections })).resolves.toEqual({
      kind: "failed",
      addedConnections: [],
      message: "Could not create the mcp.linear.app connector.",
    });
    expect(list.requests).toHaveLength(1);
  });

  it("installs dependencies before provisioning a connector", async () => {
    const list = scriptConnectionList(["linear"]);
    const addConnections = addConnectionDeps();
    const runPackageManagerInstall = vi.fn(async () => false);

    await expect(
      runConnectionFlow(list, { addConnections, runPackageManagerInstall }),
    ).resolves.toEqual({
      kind: "failed",
      addedConnections: [],
      message: "Dependency installation failed. Run `pnpm install`.",
    });

    expect(addConnections.setupConnectionConnector).not.toHaveBeenCalled();
  });
});
