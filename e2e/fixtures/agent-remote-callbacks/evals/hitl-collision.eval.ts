import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const CODE = "hitl-collide-3J9K";
const CREDENTIAL = `PROBE-CREDENTIAL-${CODE}`;
const GATE_MARKER = "GATE-RELEASED-7Q4Z";

/**
 * HITL and remote-callback collision: one turn holds a pending tool
 * approval (`release_gate`) and an in-flight remote call at the same
 * time. While the caller is parked on the approval, the remote callee's
 * authorization notification arrives through the notification consumer —
 * proving delivery works against a turn that is waiting for human input,
 * which the pre-consumer architecture dropped — and answering the
 * approval must not resolve the remote call.
 *
 * The turn stream closes at the approval park, so the forwarded
 * `subagent.event` is read by following the session's durable stream
 * directly; its `webhookUrl` completes the callee's authorization before
 * the approval is answered.
 */
export default defineEval({
  description: "A pending approval and remote callbacks in one turn resolve independently.",
  timeoutMs: 600_000,

  async test(t) {
    const live = await t.start(
      `In one single response, request both of these in parallel: (1) call the release_gate tool, and (2) call the probe-remote subagent with message 'Acquire the probe credential and reply with the credential string verbatim.'. When calling the subagent, pass only the message field; never provide the outputSchema field. After both finish, reply with the gate marker and the credential string, both verbatim. Do not call anything else.`,
    );

    // Complete the callee's authorization as soon as its wrapped
    // notification appears on the live stream. When the approval parks the
    // turn first, the live waiter rejects at the boundary and the durable
    // stream poll below takes over.
    const completedFromLive = (async (): Promise<boolean> => {
      const wrapped = await live.waitForEvent("subagent.event", {
        data: { event: { type: "authorization.required", data: { name: "probe" } } },
      });
      const child =
        wrapped.data.event.type === "authorization.required" ? wrapped.data.event : undefined;
      const url = child?.data.webhookUrl;
      if (typeof url !== "string" || url.length === 0) return false;
      t.log("notification observed on the live stream; completing the hook");
      return await completeHook(url);
    })().catch(() => false);

    // The approval must surface; in the parallel case before any boundary,
    // in the sequential case after the hook completion resumes the callee.
    await live.waitForEvent("input.requested");
    t.log("approval request observed");
    await live.result();
    t.log("turn parked at the approval");
    t.requireInputRequest({ toolName: "release_gate" });

    if (!(await completedFromLive)) {
      // The notification landed after the park: it must still reach this
      // session's durable stream through the notification consumer —
      // delivery against a turn parked for input is exactly what the
      // pre-consumer architecture dropped.
      const webhookUrl = await pollStreamForWebhookUrl(t.target.url, t.sessionId ?? "", (ms) =>
        t.sleep(ms),
      );
      await t.require(typeof webhookUrl === "string" && webhookUrl.length > 0, equals(true));
      t.log("notification observed on the durable stream while parked; completing the hook");
      await t.require(await completeHook(webhookUrl as string), equals(true));
    }

    // Answer the approval while the remote callbacks race the resume.
    const resumed = await t.respondAll("approve");
    t.check(resumed.inputRequests, equals([]));

    t.succeeded();
    t.noFailedActions();
    t.calledSubagent("probe-remote", { output: new RegExp(CREDENTIAL), count: 1 });
    t.calledTool("release_gate", { output: new RegExp(GATE_MARKER) });
    t.messageIncludes(CREDENTIAL);
    t.messageIncludes(GATE_MARKER);
    t.check(t.pendingInputRequests, equals([]));
  },
});

const HOOK_CODE_PARAM = "code";

/** Completes the callee's authorization hook with the eval's code. */
async function completeHook(webhookUrl: string): Promise<boolean> {
  const hook = new URL(webhookUrl);
  hook.searchParams.set(HOOK_CODE_PARAM, CODE);
  const response = await fetch(hook, { redirect: "manual" });
  return response.ok;
}

/**
 * Reads the session's durable stream until the notification consumer's
 * wrapped `authorization.required` for the `probe` connection appears,
 * returning its `webhookUrl`. Plain fetch: the stream route accepts
 * loopback traffic locally and the poll re-opens the stream per attempt.
 */
async function pollStreamForWebhookUrl(
  baseUrl: string,
  sessionId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  const streamUrl = new URL(`/eve/v1/session/${encodeURIComponent(sessionId)}/stream`, baseUrl);
  streamUrl.searchParams.set("startIndex", "0");

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(streamUrl, { signal: controller.signal });
      if (response.ok && response.body !== null) {
        const found = await scanForWebhookUrl(response.body, controller);
        if (found !== undefined) return found;
      }
    } catch {
      // Aborted reads and transient failures fall through to the next poll.
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    await sleep(1_000);
  }
  return undefined;
}

async function scanForWebhookUrl(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
): Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return undefined;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (line.length === 0) continue;
        try {
          const event = JSON.parse(line) as {
            type?: string;
            data?: { event?: { type?: string; data?: { name?: string; webhookUrl?: string } } };
          };
          if (
            event.type === "subagent.event" &&
            event.data?.event?.type === "authorization.required" &&
            event.data.event.data?.name === "probe" &&
            typeof event.data.event.data.webhookUrl === "string"
          ) {
            controller.abort();
            return event.data.event.data.webhookUrl;
          }
        } catch {
          // Ignore non-JSON lines.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
