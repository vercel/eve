import { disposeHook } from "#execution/hook-ownership.js";
import {
  deriveWorkflowToolRunOwner,
  workflowToolRunOutcomeHook,
  workflowToolRunReportHook,
  workflowToolRunRequestHook,
  type WorkflowToolRunOutcomeMessage,
  type WorkflowToolRunReport,
  type WorkflowToolRunRequestMessage,
} from "#execution/tools/workflow/messages.js";
import {
  type ChannelReader,
  createChannelReader,
} from "#execution/tools/workflow/owner-channels.js";

/** In read priority: what a workflow tool run said before its outcome lands first. */
export type WorkflowToolRunOwnerReaders = readonly [
  ChannelReader<"report", WorkflowToolRunReport>,
  ChannelReader<"request", WorkflowToolRunRequestMessage>,
  ChannelReader<"outcome", WorkflowToolRunOutcomeMessage>,
];

export interface WorkflowToolRunOwnerChannels {
  readonly readers: WorkflowToolRunOwnerReaders;
  dispose(): Promise<void>;
}

export function openWorkflowToolRunOwnerChannels(inboxToken: string): WorkflowToolRunOwnerChannels {
  const owner = deriveWorkflowToolRunOwner(inboxToken);
  const report = workflowToolRunReportHook.create({ token: owner.report });
  const request = workflowToolRunRequestHook.create({ token: owner.request });
  const outcome = workflowToolRunOutcomeHook.create({ token: owner.outcome });
  return {
    readers: [
      createChannelReader("report", report),
      createChannelReader("request", request),
      createChannelReader("outcome", outcome),
    ],
    async dispose() {
      await disposeHook(report);
      await disposeHook(request);
      await disposeHook(outcome);
    },
  };
}
