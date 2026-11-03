import { describe, expect, it } from "vitest";

import type { ApprovalPolicy } from "#approval/definition.js";
import { SessionKey } from "#context/keys.js";
import { resolveAgentApproval } from "#execution/effective-agent-config.js";
import { decideApproval } from "#harness/tools.js";
import {
  catalogContext,
  connectionTool,
  fakeConnection,
  inlineTool,
  subagentTool,
  workflowTool,
} from "#internal/testing/catalog-fixtures.js";
import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { always } from "#tools/approval/policies.js";

/** Alice's session over `input`, with the session context approval policies read. */
function session(input: Parameters<typeof catalogContext>[0]) {
  const context = catalogContext(input);
  context.ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "catalog-session",
    turn: { id: "turn-1", sequence: 0 },
  });
  const decide = (name: string) =>
    context.run(() =>
      decideApproval(context.catalog.get(name)!, { callId: `call-${name}`, input: {} }),
    );
  return { ...context, decide };
}

const ASKS = { awaitsPerson: true, denied: false };
// A call the gate lets run carries its clearance.
const RUNS = { clearance: { callId: "call-get_weather" }, denied: false };

describe("agent approval in the step catalog", () => {
  it("covers authored, workflow, subagent, and connection entries from one policy", async () => {
    const seen: { annotations?: unknown; tool: string }[] = [];
    const approval: ApprovalPolicy = (ctx) => {
      seen.push({ annotations: ctx.toolAnnotations, tool: ctx.toolName });
      return ctx.toolName === "get_weather" ? undefined : "user-approval";
    };
    const crm = fakeConnection({
      name: "crm",
      tools: [{ ...connectionTool("delete_account"), annotations: { destructiveHint: true } }],
    });
    const { decide } = session({
      approval,
      connections: [crm],
      tools: [
        inlineTool("bash"),
        inlineTool("get_weather"),
        workflowTool("export_report"),
        subagentTool("researcher"),
      ],
    });

    expect(await decide("bash")).toEqual(ASKS);
    expect(await decide("get_weather")).toEqual(RUNS);
    expect(await decide("export_report")).toEqual(ASKS);
    expect(await decide("researcher")).toEqual(ASKS);
    expect(await decide("crm__delete_account")).toEqual(ASKS);
    expect(seen).toEqual([
      { tool: "bash" },
      { tool: "get_weather" },
      { tool: "export_report" },
      { tool: "researcher" },
      { annotations: { destructiveHint: true }, tool: "crm__delete_account" },
    ]);
  });

  it("denies a connection call the connection itself approves", async () => {
    const crm = fakeConnection({
      approval: () => "approved",
      name: "crm",
      tools: [connectionTool("delete_account")],
    });
    const { decide } = session({
      approval: ({ toolName }) =>
        toolName.endsWith("__delete_account")
          ? { type: "denied", reason: "No deletes." }
          : undefined,
      connections: [crm],
    });

    expect(await decide("crm__delete_account")).toEqual({ denied: true, reason: "No deletes." });
  });

  it("can't loosen an entry's own gate", async () => {
    const { decide } = session({
      approval: () => "approved",
      tools: [inlineTool("deploy", { approval: always() })],
    });

    expect(await decide("deploy")).toEqual(ASKS);
  });

  it("leaves task controls and connection sign-in ungated", () => {
    const { catalog } = session({
      approval: () => "user-approval",
      connections: [fakeConnection({ name: "crm", tools: [connectionTool("search")] })],
      tools: [workflowTool("crawl", "task")],
    });

    expect(catalog.get(TASK_WAIT_TOOL_NAME)?.approval).toBeUndefined();
    expect(catalog.get(TASK_CANCEL_TOOL_NAME)?.approval).toBeUndefined();
    expect(catalog.get("crm")?.approval).toBeUndefined();
  });

  it("leaves interaction-only executors ungated, but not tools that merely share their names", () => {
    const { catalog } = session({
      approval: () => "user-approval",
      tools: [
        inlineTool("no_reply", { frameworkTool: true, interactionOnly: true }),
        // A framework-marked tool named like a built-in, such as a remote agent named `sleep`.
        inlineTool("sleep", { frameworkTool: true }),
        subagentTool("ask_question", { frameworkTool: true }),
      ],
    });

    expect(catalog.get("no_reply")?.approval).toBeUndefined();
    expect(catalog.get("sleep")?.approval).toBeDefined();
    expect(catalog.get("ask_question")?.approval).toBeDefined();
  });

  it("changes nothing for an agent without a policy", () => {
    const tool = inlineTool("bash");
    const { catalog } = catalogContext({ tools: [tool] });

    expect(catalog.get("bash")).toBe(tool);
  });
});

describe("resolveAgentApproval", () => {
  const bundle = (root?: ApprovalPolicy, own?: ApprovalPolicy, nodeId?: string) =>
    ({
      graph: {
        nodesByNodeId: new Map([
          [ROOT_RUNTIME_AGENT_NODE_ID, { agent: { config: { approval: root } } }],
        ]),
      },
      nodeId,
      resolvedAgent: { config: { approval: own } },
    }) as never;
  const status = (policy: ApprovalPolicy | undefined) => policy?.({} as never);
  const CHILD_NODE = "subagents/reviewer";

  it("runs the root's policy once in the root session", () => {
    const root: ApprovalPolicy = () => "user-approval";
    // A copy of the root's agent object must not make the root's policy run twice.
    expect(resolveAgentApproval(bundle(root, () => "user-approval"))).toBe(root);
  });

  it("applies the root's policy in a subagent session without its own", async () => {
    const root: ApprovalPolicy = () => "user-approval";
    expect(resolveAgentApproval(bundle(root, undefined, CHILD_NODE))).toBe(root);
  });

  it("doesn't let a subagent's own policy loosen the root's", async () => {
    const root: ApprovalPolicy = () => "user-approval";
    expect(await status(resolveAgentApproval(bundle(root, () => "approved", CHILD_NODE)))).toBe(
      "user-approval",
    );
    expect(
      await status(resolveAgentApproval(bundle(root, () => ({ type: "denied" }), CHILD_NODE))),
    ).toEqual({ type: "denied" });
  });
});
