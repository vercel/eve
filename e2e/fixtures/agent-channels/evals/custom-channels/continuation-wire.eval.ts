import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import { postChannel } from "./shared";

type MessageResponse = { ok: boolean; sessionId?: string };

const WORKFLOW_EVENTS_DIR = resolve(".eve", ".workflow-data", "events");

/**
 * A channel-address follow-up crosses the durable continuation-hook boundary,
 * and the persisted hook payload must stay on the frozen `deliver` envelope
 * with the transitional single-payload mirror (`payload` alongside
 * `payloads`) that keeps eve 0.30.3–0.30.8 parked consumers receiving
 * messages. Drop the mirror assertion together with the encoder mirror once
 * that cohort has aged out (30-day session timeout).
 *
 * The behavioral half (a same-version follow-up turn) passes even if producer
 * and consumer change the wire together — exactly how the 0.30.3 `send`
 * regression shipped. The byte-level half closes that hole: on worlds with a
 * local event log, the eval decodes the persisted `hook_received` payload and
 * fails loudly when the envelope shape drifts.
 */
export default defineEval({
  description: "Custom channel continuation preserves the durable delivery wire protocol.",

  async test(t) {
    const sessionRef = crypto.randomUUID();
    const first = await postChannel<MessageResponse>(t.target, "/webhook", {
      message: "Reply with exactly: first-turn",
      sessionRef,
    });
    await t.require(
      first,
      satisfies(
        (value: MessageResponse) => value.ok === true && typeof value.sessionId === "string",
        "initial channel delivery creates a session",
      ),
    );

    const initialTurn = await t.target.watchTurn(first.sessionId!).result();
    initialTurn.notEvent("session.failed");

    const followUpTurn = t.target.watchTurn(first.sessionId!, {
      startIndex: initialTurn.events.length,
    });
    const second = await postChannel<MessageResponse>(t.target, "/webhook", {
      message: "Reply with exactly: second-turn",
      sessionRef,
    });
    await t.require(second.sessionId, equals(first.sessionId));

    const followUp = await followUpTurn.result();
    followUp.notEvent("session.failed");
    followUp.event("message.completed");
    followUp.messageIncludes("second-turn");

    // Byte-level wire pin. Only worlds persisting a local event log expose the
    // durable payload; remote worlds (Vercel, Postgres) skip this half.
    if (!existsSync(WORKFLOW_EVENTS_DIR)) {
      t.log("No local workflow event log; skipping the persisted wire-format assertion.");
      return;
    }

    const payloads = readSessionHookPayloads(first.sessionId!);
    if (payloads.length === 0) {
      // A stale local event log can coexist with a remote world; only assert
      // when this session's continuation actually persisted locally.
      t.log("No locally persisted hook_received for this session; skipping the wire assertion.");
      return;
    }
    for (const payload of payloads) {
      await t.require(
        payload,
        satisfies(
          (text: string) => text.includes('"deliver"') && text.includes('"payloads"'),
          "the persisted continuation payload uses the frozen `deliver` envelope",
        ),
      );
      await t.require(
        payload,
        satisfies(
          // `"payload"` never matches inside `"payloads"`: the closing quote
          // pins the exact key.
          (text: string) => /"payload"/.test(text),
          "the persisted envelope mirrors `payload` for 0.30.3–0.30.8 parked consumers",
        ),
      );
    }
  },
});

/**
 * Decoded devalue text of every session-level `hook_received` payload for one
 * run. Turn-control hooks are runtime-internal and excluded; only the channel
 * continuation hook carries the cross-deployment delivery envelope.
 */
function readSessionHookPayloads(sessionId: string): string[] {
  const payloads: string[] = [];
  for (const name of readdirSync(WORKFLOW_EVENTS_DIR)) {
    if (!name.startsWith(`${sessionId}-`)) continue;
    const event = JSON.parse(readFileSync(join(WORKFLOW_EVENTS_DIR, name), "utf8")) as {
      eventType?: string;
      eventData?: { token?: string; payload?: { data?: string } };
    };
    if (event.eventType !== "hook_received") continue;
    const token = event.eventData?.token ?? "";
    if (token.includes(":turn-control:") || token.endsWith(":auth")) continue;
    const data = event.eventData?.payload?.data;
    if (data === undefined) continue;
    payloads.push(decodeSerializedPayload(Buffer.from(data, "base64")));
  }
  return payloads;
}

/** Undoes the workflow serde codec prefix: `zstd` wraps the `devl` bytes. */
function decodeSerializedPayload(bytes: Buffer): string {
  const prefix = bytes.subarray(0, 4).toString("utf8");
  const body = prefix === "zstd" ? zstdDecompressSync(bytes.subarray(4)) : bytes;
  return body.toString("utf8");
}
