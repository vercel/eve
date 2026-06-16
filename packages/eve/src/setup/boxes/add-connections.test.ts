import { describe, expect, test, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { headlessAsker, interactiveAsker } from "../ask.js";
import type { Prompter } from "../prompter.js";
import { createDefaultSetupState, snapshotSetupState, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless, runInteractive } from "../runner.js";
import { addConnections, type AddConnectionsDeps } from "./add-connections.js";
import {
  buildCatalogOptions,
  selectConnections,
  type SelectConnectionsOptions,
} from "./select-connections.js";

const silentSink: OutputSink = { write: () => {} };
const snapshot = { snapshot: snapshotSetupState };

function createPrompter(): Prompter {
  return createFakePrompter().prompter;
}

/**
 * Composes the selection and execution boxes the way the onboarding site does:
 * selection resolves the picker and custom sub-questions into plans on the
 * state, execution runs the effects. The ask channel pairs the headless base
 * with the selection box's `headless` flag, or an interactive base over the
 * test prompter.
 */
function makeBoxes(
  options: Omit<SelectConnectionsOptions, "asker" | "headless"> & {
    prompter: Prompter;
    headless?: boolean;
    deps?: AddConnectionsDeps;
  },
): [ReturnType<typeof selectConnections>, ReturnType<typeof addConnections>] {
  const headless = options.headless ?? false;
  return [
    selectConnections({
      presetConnections: options.presetConnections,
      asker: headless ? headlessAsker() : interactiveAsker(options.prompter),
      headless,
    }),
    addConnections({ prompter: options.prompter, deps: options.deps }),
  ];
}

function createDeps() {
  return {
    ensureConnection: vi.fn<AddConnectionsDeps["ensureConnection"]>(async (options) => ({
      slug: options.slug ?? options.entry.slug,
      protocol: options.protocol,
      action: "created",
      filePath: `/tmp/project/agent/connections/${options.slug ?? options.entry.slug}.ts`,
      filesWritten: [`/tmp/project/agent/connections/${options.slug ?? options.entry.slug}.ts`],
      filesSkipped: [],
      packageJsonUpdated: [],
      envKeysAdded: [],
      envKeysRequired: [],
    })),
    setupConnectionConnector: vi.fn<AddConnectionsDeps["setupConnectionConnector"]>(async () => ({
      kind: "patched",
      created: true,
      connectorUid: "oauth/connector-1",
    })),
  };
}

function resolvedState(): SetupState {
  const state = createDefaultSetupState();
  state.projectPath = { kind: "resolved", inPlace: false, path: "/tmp/project" };
  state.vercelProject = { kind: "new", project: "project", team: "team" };
  state.project = { kind: "linked", projectId: "prj_demo" };
  return state;
}

/** A flow that chose not to deploy to Vercel: no project planned or linked. */
function noVercelState(): SetupState {
  const state = createDefaultSetupState();
  state.projectPath = { kind: "resolved", inPlace: false, path: "/tmp/project" };
  return state;
}

describe("selectConnections + addConnections boxes", () => {
  test("scaffolds a preset slug headlessly and prints the connector command hint", async () => {
    const deps = createDeps();
    const prompter = createPrompter();
    const boxes = makeBoxes({ prompter, presetConnections: ["linear"], headless: true, deps });

    await runHeadless(boxes, resolvedState(), silentSink, snapshot);

    expect(deps.ensureConnection).toHaveBeenCalledWith({
      projectRoot: "/tmp/project",
      slug: "linear",
      protocol: "mcp",
      entry: expect.objectContaining({ slug: "linear" }),
    });
    // Headless runs surface the connector command instead of provisioning,
    // since `vercel connect create` opens a browser.
    expect(deps.setupConnectionConnector).not.toHaveBeenCalled();
    expect(prompter.log.info).toHaveBeenCalledWith(
      "Run `vercel connect create mcp.linear.app --name linear`, then set the connector UID in agent/connections/linear.ts.",
    );
  });

  test("provisions the Connect connector for a preset slug interactively", async () => {
    const deps = createDeps();
    const boxes = makeBoxes({
      prompter: createPrompter(),
      presetConnections: ["linear"],
      deps,
    });

    await runInteractive(boxes, resolvedState(), silentSink, snapshot);

    expect(deps.setupConnectionConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "linear",
        service: "mcp.linear.app",
        connectionFilePath: "/tmp/project/agent/connections/linear.ts",
        projectRoot: "/tmp/project",
      }),
    );
  });

  test("uses the picker selection when no preset is given", async () => {
    const deps = createDeps();
    let presented: { value: string | number | boolean; label: string }[] = [];
    const prompter = createFakePrompter({
      multiple: (opts) => {
        presented = opts.options;
        return ["notion"];
      },
    }).prompter;
    const boxes = makeBoxes({ prompter, deps });

    await runInteractive(boxes, resolvedState(), silentSink, snapshot);

    expect(deps.ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "notion", protocol: "mcp" }),
    );
    expect(deps.setupConnectionConnector).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "notion", service: "mcp.notion.com" }),
    );
    // The interactive picker offers only curated catalog entries.
    expect(presented.length).toBeGreaterThan(0);
    expect(presented.some((option) => option.value === "custom")).toBe(false);
  });

  test("marks blocked catalog rows disabled with the reason", () => {
    const options = buildCatalogOptions({ linear: "already defined" });

    const linear = options.find((option) => option.value === "linear");
    expect(linear?.disabled).toBe(true);
    expect(linear?.disabledReason).toBe("already defined");
    const others = options.filter((option) => option.value !== "linear");
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((option) => option.disabled !== true)).toBe(true);
  });

  test("builds a custom MCP plan from interactive prompts, deriving the service host", async () => {
    const deps = createDeps();
    const text = vi
      .fn<(opts: { message: string }) => string>()
      .mockReturnValueOnce("Internal tools") // description
      .mockReturnValueOnce("https://mcp.mycorp.dev/sse"); // url
    const prompter = createFakePrompter({ text }).prompter;
    // A valid slug that is not in the catalog routes to the custom planner, the
    // only production path to it: the picker offers catalog rows only, so the
    // channel (which now enforces the offered option ids, unlike the old raw
    // prompter.select) would refuse a "custom" sentinel the picker never showed.
    // The slug comes from the preset, so only the description and URL are asked.
    const boxes = makeBoxes({ prompter, presetConnections: ["mycorp"], deps });

    await runInteractive(boxes, resolvedState(), silentSink, snapshot);

    expect(text.mock.calls.map(([opts]) => opts.message)).toEqual([
      "Description for mycorp",
      "MCP server URL for mycorp",
    ]);
    expect(deps.ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "mycorp",
        protocol: "mcp",
        entry: expect.objectContaining({
          slug: "mycorp",
          mcp: { url: "https://mcp.mycorp.dev/sse" },
          auth: { kind: "connect", connector: "mycorp" },
        }),
      }),
    );
    // The custom MCP host becomes the Connect service.
    expect(deps.setupConnectionConnector).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "mycorp", service: "mcp.mycorp.dev" }),
    );
  });

  test("rejects an unknown preset slug headlessly without touching files", async () => {
    const deps = createDeps();
    const boxes = makeBoxes({
      prompter: createPrompter(),
      presetConnections: ["mystery"],
      headless: true,
      deps,
    });

    await expect(runHeadless(boxes, resolvedState(), silentSink, snapshot)).rejects.toThrow(
      /requires interactive input/,
    );
    expect(deps.ensureConnection).not.toHaveBeenCalled();
  });

  test("rejects a malformed preset slug with the catalog listing", async () => {
    const deps = createDeps();
    const boxes = makeBoxes({
      prompter: createPrompter(),
      presetConnections: ["Not_A_Slug"],
      headless: true,
      deps,
    });

    await expect(runHeadless(boxes, resolvedState(), silentSink, snapshot)).rejects.toThrow(
      /Unknown connection "Not_A_Slug"/,
    );
    expect(deps.ensureConnection).not.toHaveBeenCalled();
  });

  test("selection records fully-specified plans on the state without running any effect", async () => {
    const deps = createDeps();
    const [selectBox] = makeBoxes({
      prompter: createPrompter(),
      presetConnections: ["linear"],
      headless: true,
      deps,
    });

    const next = await runHeadless([selectBox], resolvedState(), silentSink, snapshot);

    expect(next.connectionSelection).toEqual([
      {
        slug: "linear",
        protocol: "mcp",
        entry: expect.objectContaining({ slug: "linear" }),
        provision: { kind: "command-hint", service: "mcp.linear.app" },
      },
    ]);
    expect(deps.ensureConnection).not.toHaveBeenCalled();
    expect(deps.setupConnectionConnector).not.toHaveBeenCalled();
  });

  test("the execution box skips entirely when nothing was selected", () => {
    const box = addConnections({ prompter: createPrompter(), deps: createDeps() });

    expect(box.shouldRun?.(snapshotSetupState(resolvedState()))).toBe(false);
    expect(
      box.shouldRun?.(
        snapshotSetupState({
          ...resolvedState(),
          connectionSelection: [
            {
              slug: "linear",
              protocol: "mcp",
              entry: { slug: "linear" } as never,
              provision: { kind: "none" },
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  test("skips provisioning when the connection file already exists", async () => {
    const deps = createDeps();
    deps.ensureConnection.mockResolvedValueOnce({
      slug: "linear",
      protocol: "mcp",
      action: "skipped",
      filePath: "/tmp/project/agent/connections/linear.ts",
      filesWritten: [],
      filesSkipped: ["/tmp/project/agent/connections/linear.ts"],
      packageJsonUpdated: [],
      envKeysAdded: [],
      envKeysRequired: [],
    });
    const prompter = createPrompter();
    const boxes = makeBoxes({ prompter, presetConnections: ["linear"], deps });

    await runInteractive(boxes, resolvedState(), silentSink, snapshot);

    expect(deps.setupConnectionConnector).not.toHaveBeenCalled();
    expect(prompter.log.warning).toHaveBeenCalledWith(
      "Skipped linear (already exists; pass --force to overwrite).",
    );
  });

  test("is skipped in headless mode when no connections are requested", async () => {
    const deps = createDeps();
    const boxes = makeBoxes({ prompter: createPrompter(), headless: true, deps });

    const next = await runHeadless(boxes, resolvedState(), silentSink, snapshot);

    expect(deps.ensureConnection).not.toHaveBeenCalled();
    expect(next.project).toEqual({ kind: "linked", projectId: "prj_demo" });
  });

  test("offers the full catalog before the deployment decision (no Vercel plan yet)", async () => {
    // The deployment question now comes after the connections picker, so no
    // row is disabled here; the provisioning box resolves Connect-backed
    // selections to Vercel instead.
    const deps = createDeps();
    let presented: { value: string | number | boolean; disabled?: boolean }[] = [];
    const prompter = createFakePrompter({
      multiple: (opts) => {
        presented = opts.options;
        return [];
      },
    }).prompter;
    const boxes = makeBoxes({ prompter, deps });

    await runInteractive(boxes, noVercelState(), silentSink, snapshot);

    expect(presented.length).toBeGreaterThan(0);
    expect(presented.every((option) => option.disabled !== true)).toBe(true);
    expect(deps.ensureConnection).not.toHaveBeenCalled();
  });

  test("throws when reusing an unresolved project while deploying to Vercel", async () => {
    const state = resolvedState();
    // project stays unresolved: the link box did not record a resolution.
    state.project = { kind: "unresolved" };
    const deps = createDeps();
    deps.setupConnectionConnector.mockImplementation(async (opts) => {
      await opts.linkProject?.();
      return { kind: "patched", created: true, connectorUid: "oauth/linear-1" };
    });
    const boxes = makeBoxes({
      prompter: createPrompter(),
      presetConnections: ["linear"],
      deps,
    });

    await expect(runInteractive(boxes, state, silentSink, snapshot)).rejects.toThrow(
      /none was resolved/,
    );
  });

  test("hands the linked project id to the connector provisioning step", async () => {
    const deps = createDeps();
    let linkedProjectId: string | undefined;
    deps.setupConnectionConnector.mockImplementation(async (opts) => {
      linkedProjectId = await opts.linkProject?.();
      return { kind: "patched", created: true, connectorUid: "oauth/linear-1" };
    });
    const boxes = makeBoxes({
      prompter: createPrompter(),
      presetConnections: ["linear"],
      deps,
    });

    await runInteractive(boxes, resolvedState(), silentSink, snapshot);

    expect(linkedProjectId).toBe("prj_demo");
  });
});
