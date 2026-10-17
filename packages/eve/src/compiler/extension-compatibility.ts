import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";
import { formatValidationError } from "#runtime/validation.js";

/** Stable kind for an extension distribution compatibility manifest. */
export const EXTENSION_COMPATIBILITY_MANIFEST_KIND = "eve-extension";

/** Current compatibility-manifest JSON format. */
export const EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION = 2;

/** Filename emitted at the root of an extension's agent-shaped dist tree. */
export const EXTENSION_COMPATIBILITY_MANIFEST_FILENAME = "_manifest.json";

interface ExtensionCapabilityContract {
  readonly current: number;
  readonly supported: readonly number[];
  readonly dropped: Readonly<Record<number, string>>;
}

const EXTENSION_CAPABILITY_CONTRACTS = {
  extension: {
    current: 2,
    supported: [2],
    dropped: {
      1: "The unused defineExtension namespace argument was removed; rebuild the extension.",
    },
  },
  tool: {
    current: 93,
    supported: [93],
    dropped: {
      "1": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "2": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "3": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "4": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "5": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "6": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "7": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "8": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "9": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "10": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "11": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "12": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "13": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "14": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "15": "TaskExec replaces stageEffect with send",
      "16": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "17": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "18": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "19": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "20": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "21": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "22": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "23": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "24": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "25": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "26": "Background tools now use task yield descriptors",
      "27": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "28": "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      "29": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "30": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "31": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "32": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "33": "ctx.agent now accepts the subagent name as its first argument, derives invocation identity internally, and infers structured output types",
      "34": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "35": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "36": "experimental_workflow and eve/tools/workflow were removed; migrate to the workflow factory from eve/tools/workflow",
      "37": "experimental_workflow and eve/tools/workflow were removed; migrate to the workflow factory from eve/tools/workflow",
      "38": "experimental_workflow and eve/tools/workflow were removed; migrate to the workflow factory from eve/tools/workflow",
      "39": "experimental_workflow and eve/tools/workflow were removed; migrate to the workflow factory from eve/tools/workflow",
      "40": "runWorkflowProgram was made internal; use the workflow factory from eve/tools/workflow",
      "41": "workflow no longer accepts agents and its options argument is optional; use workflow() or workflow({ maxSubagents })",
      "42": "Legacy session history migration was removed; user-role messages require current provenance kinds.",
      "43": "Legacy session history migration was removed; user-role messages require current provenance kinds.",
      "44": "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      "45": "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      "46": "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      "47": "eve/experimental/evaluate was removed; import decide from eve/ai",
      "48": "eve/experimental/evaluate was removed; import decide from eve/ai",
      "49": "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      "50": "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      "51": "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      "52": "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      "53": "Sandbox sessions no longer expose core identity and mutable networking is provider-specific.",
      "54": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "55": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "56": "SandboxSession no longer exposes setNetworkPolicy; pass the configured environment to ctx.getSandbox(environment) to access network policy capabilities",
      "57": "agentRouter() no longer accepts a model-facing outputSchema; structured subagent output is requested only through ctx.agent().",
      "58": "Workflow tools no longer accept execution or return background task receipts; every call blocks until it settles.",
      "59": "Workflow tools no longer accept execution or return background task receipts, and every call blocks until it settles. ctx.ask() no longer accepts dismissible and reports a withdrawn request as cancelled, workflow tool contexts carry interruptSignal, and ctx.agent(name) returns a session handle whose send() delivers a message and whose result() resolves the turn; ctx.agent(name, { message, agentId }) and AgentInput were removed. A ctx.ask() question parks the open turn with turn.waiting instead of ending it.",
      "60": "Workflow tools define exactly one of execute(input, ctx), task(input, ctx), or serve(receive, ctx): a task() call returns a receipt and runs as a task, a serve() call reaches a resumable task through receive() and its model input gains taskId, and stream events gained task.started and task.settled. Agent tools are serve() tools with taskId in place of agentId, and the subagent.* stream events were removed. ctx.interruptSignal and WorkflowTaskContext were removed: a steering message aborts the abortSignal of an execute call the turn waits on.",
      "61": "Approval response policies now run for Cancel as well as Approve; a policy written for Approve only could reject every Cancel.",
      "62": "Approval response policies now run for Cancel as well as Approve; a policy written for Approve only could reject every Cancel.",
      "63": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "64": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "65": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "66": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "67": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "68": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "69": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "70": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "71": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "72": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "73": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "74": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "75": "eve/ai evaluate was renamed to decide and AI SDK evaluation models became decision models; import decide from eve/ai",
      "76": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "77": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "78": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "79": "Sandbox provider handle hooks were renamed to onSandboxStop and onSandboxDelete.",
      "80": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "81": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "82": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "83": 'webSearch provider "openai" was replaced by "native" before it shipped in a release',
      "84": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "85": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "86": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "87": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "88": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "89": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "90": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "91": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
      "92": "v27 tool contexts and keyed approval grants replace the previous approval and workflow result APIs; rebuild the extension.",
    },
  },
  dynamicTool: {
    current: 87,
    supported: [87],
    dropped: {
      "1": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "2": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "3": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "4": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "5": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "6": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "7": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "8": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "9": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "10": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "11": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "12": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "13": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "14": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "15": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "16": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "17": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "18": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "19": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "20": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "21": "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      "22": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "23": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "24": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "25": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "26": "Background tools now use task yield descriptors",
      "27": "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      "28": "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      "29": "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      "30": "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      "31": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "32": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "33": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "34": "Legacy session history migration was removed; user-role messages require current provenance kinds.",
      "35": "workflowMaxSubagents was removed with experimental_workflow; configure generated-program limits with the workflow factory",
      "36": "workflowMaxSubagents was removed with experimental_workflow; configure generated-program limits with the workflow factory",
      "37": "workflowMaxSubagents was removed with experimental_workflow; configure generated-program limits with the workflow factory",
      "38": "workflowMaxSubagents was removed with experimental_workflow; configure generated-program limits with the workflow factory",
      "39": "Legacy session history migration was removed; user-role messages require current provenance kinds.",
      "40": "Legacy session history migration was removed; user-role messages require current provenance kinds.",
      "41": "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      "42": "autoModel and eve/experimental/evaluate were removed; import auto from eve/models",
      "43": "autoModel and eve/experimental/evaluate were removed; import auto from eve/models",
      "44": "autoModel and eve/experimental/evaluate were removed; import auto from eve/models",
      "45": "autoModel and eve/experimental/evaluate were removed; import auto from eve/models",
      "46": "autoModel and eve/experimental/evaluate were removed; import auto from eve/models",
      "47": "autoModel and eve/experimental/evaluate were removed; import auto from eve/models",
      "48": "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      "49": "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      "50": "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      "51": "Sandbox sessions no longer expose core identity and mutable networking is provider-specific.",
      "52": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "53": "SandboxSession no longer exposes setNetworkPolicy; pass the configured environment to ctx.getSandbox(environment) to access network policy capabilities",
      "54": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "55": "Run mode was removed; sessions always park and ConversationContext no longer carries mode.",
      "56": 'Background task execution was removed: subagent results no longer carry backgroundTask and message.completed always carries text. input.resolved reports outcome "cancelled" when a workflow tool withdraws a ctx.ask() request, and stream events gained agent.started, published when a workflow run opens a ctx.agent session, and turn.waiting, which parks the open turn instead of emitting turn.completed and session.waiting.',
      "57": "Stream events gained task.started and task.settled, and input.requested, authorization events, and agent.started carry the taskId of the task they come from. The subagent.called, subagent.completed, subagent.started, and subagent.event stream events were removed; agent calls report task.started, task.settled, and agent.started.",
      "58": "Approval response policies now run for Cancel as well as Approve; a policy written for Approve only could reject every Cancel.",
      "59": "Approval response policies now run for Cancel as well as Approve; a policy written for Approve only could reject every Cancel.",
      "60": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "61": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "62": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "63": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "64": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "65": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "66": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "67": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "68": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "69": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "70": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "71": "AI SDK evaluation models became decision models; auto() accepts decision models only",
      "72": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "73": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "74": "Sandbox provider handle hooks were renamed to onSandboxStop and onSandboxDelete.",
      "75": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "76": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "77": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "78": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "79": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "80": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "81": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "82": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "83": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "84": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "85": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
      "86": "v27 dynamic tool contexts and keyed approval grants replace the previous approval APIs; rebuild the extension.",
    },
  },
  channel: {
    current: 62,
    supported: [62],
    dropped: {
      "1": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "2": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "3": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "4": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "5": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "6": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "7": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "8": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "9": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "10": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "11": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "12": "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      "13": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "14": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "15": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "16": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "17": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "18": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "19": "Continuation rekey was removed; channel extensions must use additive continuation.alias instead.",
      "20": "Continuation rekey was removed; channel extensions must use additive continuation.alias instead.",
      "21": "Continuation rekey was removed; channel extensions must use additive continuation.alias instead.",
      "22": "Continuation rekey was removed; channel extensions must use additive continuation.alias instead.",
      "23": "Task views no longer expose executor bindings; background work is owned by workflow runs.",
      "24": "Task views no longer expose executor bindings; background work is owned by workflow runs.",
      "25": "Task views no longer expose executor bindings; background work is owned by workflow runs.",
      "26": "Task views no longer expose executor bindings; background work is owned by workflow runs.",
      "27": "Sandbox sessions no longer expose core identity and mutable networking is provider-specific.",
      "28": "Sandbox sessions no longer expose core identity and mutable networking is provider-specific.",
      "29": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "30": "SandboxSession no longer exposes setNetworkPolicy; pass the configured environment to ctx.getSandbox(environment) to access network policy capabilities",
      "31": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "32": "Run mode and caller-supplied output schemas were removed from channel operations; sessions always park, and send options, audience inputs, and ConversationContext no longer carry mode, while from().send() and from().respond() no longer accept outputSchema.",
      "33": "Background task delivery was removed: sends no longer accept taskDeliveryPolicy and message.completed always carries text.",
      "34": 'Background task delivery was removed: sends no longer accept taskDeliveryPolicy and message.completed always carries text. input.resolved reports outcome "cancelled" when a workflow tool withdraws a ctx.ask() request, and stream events gained agent.started, published when a workflow run opens a ctx.agent session, and turn.waiting, which parks the open turn instead of emitting turn.completed and session.waiting.',
      "35": "Stream events gained task.started and task.settled, and input.requested, authorization events, and agent.started carry the taskId of the task they come from. The subagent.called, subagent.completed, subagent.started, and subagent.event stream events were removed; agent calls report task.started, task.settled, and agent.started.",
      "36": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "37": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "38": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "39": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "40": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "41": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "42": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "43": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "44": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "45": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "46": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "47": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "48": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "49": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "50": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "51": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "52": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "53": "Sandbox provider handle hooks were renamed to onSandboxStop and onSandboxDelete.",
      "54": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "55": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "56": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "57": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "58": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "59": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "60": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
      "61": "Channel commands now return Delivery receipts and session handles read with stream(); rebuild the extension.",
    },
  },
  schedule: {
    current: 34,
    supported: [34],
    dropped: {
      "1": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "2": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "3": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "4": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "5": "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      "6": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "7": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "8": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "9": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "10": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "11": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "12": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "13": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "14": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "15": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "16": 'Background task delivery was removed: sends no longer accept taskDeliveryPolicy and message.completed always carries text. input.resolved reports outcome "cancelled" when a workflow tool withdraws a ctx.ask() request, and stream events gained agent.started, published when a workflow run opens a ctx.agent session, and turn.waiting, which parks the open turn instead of emitting turn.completed and session.waiting.',
      "17": "Stream events gained task.started and task.settled, and input.requested, authorization events, and agent.started carry the taskId of the task they come from. The subagent.called, subagent.completed, subagent.started, and subagent.event stream events were removed; agent calls report task.started, task.settled, and agent.started.",
      "18": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "19": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "20": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "21": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "22": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "23": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "24": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "25": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "26": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "27": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "28": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "29": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "30": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "31": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "32": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
      "33": "Schedule dispatch now returns Delivery receipts rather than session handles; rebuild the extension.",
    },
  },
  subagent: {
    current: 39,
    supported: [
      3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
      34, 35, 36, 37, 38, 39,
    ],
    dropped: {
      1: "Persistent subagent sessions are now the default and the experimental opt-in was removed",
      2: "Persistent subagent sessions are now the default and the experimental opt-in was removed",
      5: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      17: "Removed experimental.instrumentationProviders; instrumentation is now always enabled for root agents.",
      18: "Removed experimental.instrumentationProviders; instrumentation is now always enabled for root agents.",
      20: "Run mode was removed and agent definitions no longer declare outputSchema; sessions always park, ConversationContext no longer carries mode, and structured output is requested per turn.",
      21: 'Background task execution was removed: subagent results no longer carry backgroundTask, message.completed always carries text, and experimental.tasks is gone. input.resolved reports outcome "cancelled" when a workflow tool withdraws a ctx.ask() request, and stream events gained agent.started, published when a workflow run opens a ctx.agent session, and turn.waiting, which parks the open turn instead of emitting turn.completed and session.waiting.',
      22: "Stream events gained task.started and task.settled, and input.requested, authorization events, and agent.started carry the taskId of the task they come from. The subagent.called, subagent.completed, subagent.started, and subagent.event stream events were removed; agent calls report task.started, task.settled, and agent.started.",
    },
  },
  connection: {
    current: 51,
    supported: [51],
    dropped: {
      "1": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "2": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "3": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "4": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "5": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "6": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "7": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "8": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "9": "Dynamic connection resolvers no longer receive conversation or channel continuation data",
      "10": "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      "11": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "12": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "13": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "14": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "15": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "16": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "17": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "18": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "19": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "20": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "21": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "22": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "23": "Sandbox sessions no longer expose core identity and mutable networking is provider-specific.",
      "24": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "25": "SandboxSession no longer exposes setNetworkPolicy; pass the configured environment to ctx.getSandbox(environment) to access network policy capabilities",
      "26": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "27": "Run mode was removed; sessions always park and ConversationContext no longer carries mode.",
      "28": 'Background task execution was removed: subagent results no longer carry backgroundTask and message.completed always carries text. input.resolved reports outcome "cancelled" when a workflow tool withdraws a ctx.ask() request, and stream events gained agent.started, published when a workflow run opens a ctx.agent session, and turn.waiting, which parks the open turn instead of emitting turn.completed and session.waiting.',
      "29": "Stream events gained task.started and task.settled, and input.requested, authorization events, and agent.started carry the taskId of the task they come from. The subagent.called, subagent.completed, subagent.started, and subagent.event stream events were removed; agent calls report task.started, task.settled, and agent.started.",
      "30": "Approval response policies now run for Cancel as well as Approve; a policy written for Approve only could reject every Cancel.",
      "31": "Approval response policies now run for Cancel as well as Approve; a policy written for Approve only could reject every Cancel.",
      "32": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "33": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "34": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "35": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "36": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "37": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "38": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "39": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "40": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "41": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "42": "Sandbox provider handle hooks were renamed to onSandboxStop and onSandboxDelete.",
      "43": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "44": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "45": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "46": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "47": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "48": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "49": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
      "50": "Connection authorization uses principalType and AuthorizationDefinition, and approval context grants changed; rebuild the extension.",
    },
  },
  hook: {
    current: 47,
    supported: [47],
    dropped: {
      "1": "Model identity moved from session.started runtime metadata to step.started call attribution.",
      "2": "Model identity moved from session.started runtime metadata to step.started call attribution.",
      "3": "Model identity moved from session.started runtime metadata to step.started call attribution.",
      "4": "Model identity moved from session.started runtime metadata to step.started call attribution.",
      "5": "Model identity moved from session.started runtime metadata to step.started call attribution.",
      "6": "Model identity moved from session.started runtime metadata to step.started call attribution.",
      "7": "Model identity moved from session.started runtime metadata to step.started call attribution.",
      "8": "Model identity moved from session.started runtime metadata to step.started call attribution.",
      "9": "Model identity moved from session.started runtime metadata to step.started call attribution.",
      "10": "The subagent.called, subagent.completed, subagent.started, and subagent.event hook events were removed; subscribe to task.started, task.settled, and agent.started.",
      "11": "The subagent.called, subagent.completed, subagent.started, and subagent.event hook events were removed; subscribe to task.started, task.settled, and agent.started.",
      "12": "The subagent.called, subagent.completed, subagent.started, and subagent.event hook events were removed; subscribe to task.started, task.settled, and agent.started.",
      "13": "The subagent.called, subagent.completed, subagent.started, and subagent.event hook events were removed; subscribe to task.started, task.settled, and agent.started.",
      "14": "The subagent.called, subagent.completed, subagent.started, and subagent.event hook events were removed; subscribe to task.started, task.settled, and agent.started.",
      "15": "The subagent.called, subagent.completed, subagent.started, and subagent.event hook events were removed; subscribe to task.started, task.settled, and agent.started.",
      "16": "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      "17": "The subagent.called, subagent.completed, subagent.started, and subagent.event hook events were removed; subscribe to task.started, task.settled, and agent.started.",
      "18": "The subagent.called, subagent.completed, subagent.started, and subagent.event hook events were removed; subscribe to task.started, task.settled, and agent.started.",
      "19": "The subagent.called, subagent.completed, subagent.started, and subagent.event hook events were removed; subscribe to task.started, task.settled, and agent.started.",
      "20": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "21": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "22": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "23": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "24": "Sandbox sessions no longer expose core identity and mutable networking is provider-specific.",
      "25": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "26": "SandboxSession no longer exposes setNetworkPolicy; pass the configured environment to ctx.getSandbox(environment) to access network policy capabilities",
      "27": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "28": "Background task execution was removed: subagent results no longer carry backgroundTask and message.completed always carries text.",
      "29": 'Background task execution was removed: subagent results no longer carry backgroundTask and message.completed always carries text. input.resolved reports outcome "cancelled" when a workflow tool withdraws a ctx.ask() request, and stream events gained agent.started, published when a workflow run opens a ctx.agent session, and turn.waiting, which parks the open turn instead of emitting turn.completed and session.waiting.',
      "30": "Stream events gained task.started and task.settled, and input.requested, authorization events, and agent.started carry the taskId of the task they come from. The subagent.called, subagent.completed, subagent.started, and subagent.event hook events were removed; subscribe to task.started, task.settled, and agent.started.",
      "31": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "32": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "33": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "34": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "35": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "36": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "37": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "38": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "39": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "40": "Sandbox provider handle hooks were renamed to onSandboxStop and onSandboxDelete.",
      "41": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "42": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "43": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "44": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "45": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
      "46": "Hooks now receive the v27 fact and session context contracts; rebuild the extension.",
    },
  },
  skill: { current: 3, supported: [1, 2, 3], dropped: {} },
  dynamicSkill: {
    current: 39,
    supported: [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 25, 26, 27, 28, 29, 30,
      31, 32, 33, 34, 35, 36, 37, 38, 39,
    ],
    dropped: {
      13: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      22: "Run mode was removed; sessions always park and ConversationContext no longer carries mode.",
      23: 'Background task execution was removed: subagent results no longer carry backgroundTask and message.completed always carries text. input.resolved reports outcome "cancelled" when a workflow tool withdraws a ctx.ask() request, and stream events gained agent.started, published when a workflow run opens a ctx.agent session, and turn.waiting, which parks the open turn instead of emitting turn.completed and session.waiting.',
      24: "Stream events gained task.started and task.settled, and input.requested, authorization events, and agent.started carry the taskId of the task they come from. The subagent.called, subagent.completed, subagent.started, and subagent.event stream events were removed; agent calls report task.started, task.settled, and agent.started.",
    },
  },
  instructions: { current: 2, supported: [1, 2], dropped: {} },
  dynamicInstructions: {
    current: 40,
    supported: [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22, 26, 27, 28, 29, 30,
      31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
    ],
    dropped: {
      14: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      23: "Run mode was removed; sessions always park and ConversationContext no longer carries mode.",
      24: 'Background task execution was removed: subagent results no longer carry backgroundTask and message.completed always carries text. input.resolved reports outcome "cancelled" when a workflow tool withdraws a ctx.ask() request, and stream events gained agent.started, published when a workflow run opens a ctx.agent session, and turn.waiting, which parks the open turn instead of emitting turn.completed and session.waiting.',
      25: "Stream events gained task.started and task.settled, and input.requested, authorization events, and agent.started carry the taskId of the task they come from. The subagent.called, subagent.completed, subagent.started, and subagent.event stream events were removed; agent calls report task.started, task.settled, and agent.started.",
    },
  },
  config: { current: 2, supported: [1, 2], dropped: {} },
  state: {
    current: 14,
    supported: [1, 2, 3, 4, 5, 7, 9, 10, 12, 13, 14],
    dropped: {
      6: "Sandbox sessions no longer expose core identity and mutable networking is provider-specific.",
      8: "SandboxSession no longer exposes setNetworkPolicy; pass the configured environment to ctx.getSandbox(environment) to access network policy capabilities",
      11: "Sandbox provider handle hooks were renamed to onSandboxStop and onSandboxDelete.",
    },
  },
} as const satisfies Record<string, ExtensionCapabilityContract>;

/** One independently versioned extension-facing contract. */
export type ExtensionCapability = keyof typeof EXTENSION_CAPABILITY_CONTRACTS;

/** Current producer contract version for each extension-facing capability. */
export const EXTENSION_CAPABILITY_VERSIONS = Object.fromEntries(
  Object.entries(EXTENSION_CAPABILITY_CONTRACTS).map(([capability, contract]) => [
    capability,
    contract.current,
  ]),
) as {
  readonly [
    TCapability in ExtensionCapability
  ]: (typeof EXTENSION_CAPABILITY_CONTRACTS)[TCapability]["current"];
};

/** Capability requirements stamped by one extension build. */
export type ExtensionCapabilityRequirements = Partial<Record<ExtensionCapability, number>>;

/**
 * Capability contract versions this eve release can consume.
 */
export const EXTENSION_CAPABILITY_SUPPORT: Readonly<
  Record<ExtensionCapability, readonly number[]>
> = (Object.keys(EXTENSION_CAPABILITY_CONTRACTS) as ExtensionCapability[]).reduce(
  (support, capability) => {
    support[capability] = EXTENSION_CAPABILITY_CONTRACTS[capability].supported;
    return support;
  },
  {} as Record<ExtensionCapability, readonly number[]>,
);

/** Consumer support table used to validate one extension distribution. */
export type ExtensionCapabilitySupport = Readonly<Record<string, readonly number[]>>;

/** Compatibility-only metadata emitted by `eve extension build`. */
export interface ExtensionCompatibilityManifest {
  readonly kind: typeof EXTENSION_COMPATIBILITY_MANIFEST_KIND;
  readonly formatVersion: 1 | typeof EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION;
  /** Diagnostic producer version; capability requirements decide compatibility. */
  readonly builtWithEve: string;
  readonly requires: Readonly<Record<string, number>>;
  readonly build?: {
    readonly externalDependencies: readonly string[];
  };
}

/** One requirement the consuming eve cannot satisfy. */
export interface UnsupportedExtensionCapability {
  readonly capability: string;
  readonly requiredVersion: number;
  readonly supportedVersions: readonly number[];
}

const extensionCompatibilityManifestV1Schema = z
  .object({
    kind: z.literal(EXTENSION_COMPATIBILITY_MANIFEST_KIND),
    formatVersion: z.literal(1),
    builtWithEve: z.string().min(1),
    requires: z.record(z.string(), z.number().int().positive()),
  })
  .strict();
const extensionCompatibilityManifestV2Schema = extensionCompatibilityManifestV1Schema.extend({
  formatVersion: z.literal(EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION),
  build: z
    .object({
      externalDependencies: z.array(z.string().min(1)).readonly(),
    })
    .strict()
    .optional(),
});
const extensionCompatibilityManifestSchema: z.ZodType<ExtensionCompatibilityManifest> = z.union([
  extensionCompatibilityManifestV1Schema,
  extensionCompatibilityManifestV2Schema,
]);

/** Serializes a compatibility manifest deterministically. */
export function serializeExtensionCompatibilityManifest(
  manifest: ExtensionCompatibilityManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Parses and validates compatibility-manifest JSON. */
export function parseExtensionCompatibilityManifest(
  raw: string,
  manifestPath: string,
): ExtensionCompatibilityManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Extension compatibility manifest "${manifestPath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = extensionCompatibilityManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Extension compatibility manifest "${manifestPath}" is invalid. ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Reads and validates an extension compatibility manifest. */
export async function readExtensionCompatibilityManifest(
  manifestPath: string,
): Promise<ExtensionCompatibilityManifest> {
  return parseExtensionCompatibilityManifest(await readFile(manifestPath, "utf8"), manifestPath);
}

/** Writes `_manifest.json` into an agent-shaped extension dist root. */
export async function writeExtensionCompatibilityManifest(
  distRoot: string,
  manifest: ExtensionCompatibilityManifest,
): Promise<void> {
  await writeFile(
    join(distRoot, EXTENSION_COMPATIBILITY_MANIFEST_FILENAME),
    serializeExtensionCompatibilityManifest(manifest),
    "utf8",
  );
}

/** Finds unknown or unsupported capability requirements without executing extension code. */
export function findUnsupportedExtensionCapabilities(
  manifest: ExtensionCompatibilityManifest,
  support: ExtensionCapabilitySupport = EXTENSION_CAPABILITY_SUPPORT,
): UnsupportedExtensionCapability[] {
  return Object.entries(manifest.requires)
    .flatMap(([capability, requiredVersion]) => {
      // Manifest keys are untrusted; "toString" must fail closed, not resolve
      // through the prototype chain.
      const supportedVersions = Object.hasOwn(support, capability)
        ? (support[capability] ?? [])
        : [];
      return supportedVersions.includes(requiredVersion)
        ? []
        : [{ capability, requiredVersion, supportedVersions }];
    })
    .sort((left, right) => left.capability.localeCompare(right.capability));
}
