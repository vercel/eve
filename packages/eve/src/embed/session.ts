import { randomUUID } from "node:crypto";

import { createChannelAddress } from "#channel/channel-address.js";
import type { SessionAuthContext } from "#channel/types.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { holdSessionAgent, type SessionAgent } from "#runtime/sessions/session-agent.js";
import type { Delivery } from "#shared/delivery.js";
import type { Answer } from "#shared/input.js";

// One conversation with an agent defined in code, running in this process (internal): the same
// session loop, approvals, history, and stream a deployed agent has, held in memory. Nothing
// outlives the process, sessions don't time out, and what needs a durable run of its own (tasks,
// workflow tools, subagents) refuses.

export interface EmbeddedSessionOptions {
  /**
   * Who the session acts as, which approvals and `ctx.session.auth` read as they read a deployed
   * caller. There's no default: `null` is no one in particular.
   */
  readonly identity: SessionAuthContext | null;
}

export interface EmbeddedSession {
  /** The session's id, once its first message started it. */
  readonly id: string | undefined;
  /** Sends a message; the delivery streams the turn it starts or joins. */
  send(message: string): Promise<Delivery>;
  /** Answers the session's open requests, such as approvals. */
  respond(answers: readonly Answer[]): Promise<Delivery>;
  /** Cancels the running turn. */
  cancel(): Promise<void>;
  /** Ends the session and stops its runtime; what it recorded is gone with the process. */
  close(): Promise<void>;
}

/** Starts a conversation with `agent` in this process. */
export function createSession(
  agent: SessionAgent,
  options: EmbeddedSessionOptions,
): EmbeddedSession {
  const auth = options.identity;
  // Its steps resolve the agent by id; the session holds it until it closes.
  const release = holdSessionAgent(agent);
  const runtime = createInProcessRuntime({ agent });
  const address = createChannelAddress({
    adapter: { kind: "http" },
    channelName: "embedded",
    continuationToken: `embedded-${randomUUID()}`,
    runtime,
  });
  let sessionId: string | undefined;

  return {
    get id() {
      return sessionId;
    },
    async send(message) {
      const delivery = await address.send(message, { auth });
      sessionId = delivery.sessionId;
      return delivery;
    },
    async respond(answers) {
      return await address.deliver({ answers }, { auth });
    },
    async cancel() {
      if (sessionId === undefined) return;
      await runtime.dispatchSession({
        command: { deliveryId: `cancel-${randomUUID()}`, kind: "cancel" },
        sessionId,
      });
    },
    async close() {
      try {
        await runtime.dispose();
      } finally {
        release();
      }
    },
  };
}
