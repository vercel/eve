import type { DeliverPayload } from "#channel/types.js";
import type { InitialSessionSeed } from "#execution/turn/types.js";
import { holdingWorkflow } from "#execution/session/holding-workflow.js";
import { sessionDirectory } from "#execution/session/directory.js";
import { sessionEvents } from "#execution/session/events.js";
import { waitForTurnReceipt } from "#execution/turn/admission.js";
import { dispatchSessionCommand } from "#execution/session/ingress.js";
import { getRun, start } from "#internal/workflow/runtime.js";

/** Starts the production holder with an explicit context for integration fixtures. */
export async function startTestSession(
  input: InitialSessionSeed & { readonly input: DeliverPayload },
) {
  const { input: payload, ...initial } = input;
  const token = input.serializedContext["eve.continuationToken"];
  const holder = await start(holdingWorkflow, [
    {
      initialToken: typeof token === "string" ? token : undefined,
      firstTurn: {
        eventId: crypto.randomUUID(),
        command: { kind: "send", payload },
        initial,
      },
    },
  ]);
  const resources = await sessionDirectory.resolveHolder(holder.runId);
  const encoder = new TextEncoder();
  return {
    sessionId: resources.sessionId,
    resources,
    readable: sessionEvents.read(resources.events).pipeThrough(
      new TransformStream({
        transform(event, controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        },
      }),
    ),
    async cancel() {
      const { run } = await dispatchSessionCommand(resources.sessionId, { kind: "reset" });
      await waitForTurnReceipt(run.runId);
      const owner = getRun(resources.holderRunId);
      if ((await owner.status) === "running") await owner.cancel();
    },
  };
}
