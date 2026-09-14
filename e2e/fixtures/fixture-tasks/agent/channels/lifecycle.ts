import { defineChannel, POST } from "eve/channels";
import { getHookByToken, getRun, getWorld, resumeHook } from "workflow/api";
import { z } from "zod";
import { lifecycleNamespace, type LifecycleControlEvent } from "../lib/lifecycle-control.js";

const bodySchema = z.object({
  key: z.string().uuid(),
  index: z.number().int().min(0).max(20).optional(),
  token: z.string().min(1).max(512).optional(),
  marker: z.enum(["A", "B"]).optional(),
});

// Fixture-only capability routes: a per-eval random key addresses only its own
// control stream. Only fixture gate tokens are exposed, never runtime routing credentials.
export default defineChannel({
  routes: [
    POST("/eve/v1/task-lifecycle/:sessionId/:action", async (request, { params }) => {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
      const body = bodySchema.parse(JSON.parse(await boundedBody(request)));
      const sessionId = params.sessionId;
      const read = async (index: number) => {
        const reader = getRun(sessionId)
          .getReadable<LifecycleControlEvent>({
            namespace: lifecycleNamespace(body.key),
            startIndex: index,
          })
          .getReader();
        const abort = () => {
          void reader.cancel("Lifecycle observation aborted");
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) throw new Error("Lifecycle control stream ended before acknowledgment.");
          return next.value;
        } finally {
          signal.removeEventListener("abort", abort);
          await reader.cancel();
          reader.releaseLock();
        }
      };
      // Reading this namespace proves that this eval key was registered by the
      // addressed parent. Unknown keys cannot inspect or release another eval.
      const first = await read(0);
      if (first.kind !== "owner" || first.sessionId !== sessionId)
        return new Response(null, { status: 403 });
      if (params.action === "next") return Response.json(await read(body.index ?? 0));
      if ((params.action === "release" || params.action === "active") && body.token !== undefined) {
        const hook = await getHookByToken(body.token);
        const metadata = await hook.metadata;
        if (
          metadata === null ||
          typeof metadata !== "object" ||
          Reflect.get(metadata, "key") !== body.key ||
          Reflect.get(metadata, "parentSessionId") !== sessionId
        )
          return new Response(null, { status: 403 });
        if (params.action === "active")
          return Response.json({ status: await getRun(hook.runId).status });
        await resumeHook(body.token, undefined);
        return Response.json({ released: true });
      }
      if (params.action === "settled" && body.marker !== undefined) {
        for (let index = 0; index < 6; index += 1) {
          const event = index === 0 ? first : await read(index);
          if (event.kind !== "owner" || event.marker !== body.marker) continue;
          const run = getRun(event.runId);
          signal.throwIfAborted();
          let rejectWait: ((reason: Error) => void) | undefined;
          const aborted = new Promise<never>((_, reject) => {
            rejectWait = reject;
          });
          const abort = () => rejectWait?.(new Error("Task owner did not settle."));
          signal.addEventListener("abort", abort, { once: true });
          try {
            await Promise.race([run.returnValue, aborted]);
          } finally {
            signal.removeEventListener("abort", abort);
          }
          return Response.json({
            marker: event.marker,
            status: await run.status,
            deliveries: await ownerDeliveries(event.runId),
          });
        }
      }
      return new Response(null, { status: 400 });
    }),
  ],
});

async function ownerDeliveries(runId: string) {
  const world = await getWorld();
  const [steps, events] = await Promise.all([
    world.steps.list({ runId, pagination: { limit: 100 }, resolveData: "none" }),
    world.events.list({
      runId,
      pagination: { limit: 100, sortOrder: "asc" },
      resolveData: "none",
    }),
  ]);
  if (steps.hasMore || events.hasMore) throw new Error("Lifecycle owner audit exceeded its bound.");
  const names = new Map(steps.data.map((step) => [step.stepId, step.stepName.split("//").at(-1)]));
  return events.data.flatMap((event) => {
    if (event.eventType !== "step_completed") return [];
    const name = names.get(event.correlationId);
    return name === "wakeTaskAgentRequestParentStep"
      ? ["agent-request"]
      : name === "wakeTaskParentStep"
        ? ["completed"]
        : [];
  });
}

async function boundedBody(request: Request) {
  const reader = request.body?.getReader();
  if (reader === undefined) throw new Error("Missing lifecycle request.");
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return text + decoder.decode();
      bytes += next.value.byteLength;
      if (bytes > 4096) throw new Error("Lifecycle request exceeds 4096 bytes.");
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
