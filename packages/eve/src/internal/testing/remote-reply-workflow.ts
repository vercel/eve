import { workflowRunHost } from "#execution/tools/workflow/workflow-run-host.js";

export async function remoteReplyWorkflow() {
  "use workflow";

  const reply = await workflowRunHost.createRemoteReplyHook<unknown>();
  try {
    for await (const payload of reply) return { payload, token: reply.token };
  } finally {
    await reply.dispose();
  }
}
