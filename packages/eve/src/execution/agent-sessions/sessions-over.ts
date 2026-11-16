import { NonRetryableError } from "#shared/run-errors.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import type { SessionCommand, SessionCommandResult } from "#channel/types.js";
import {
  cancelRemoteSessionTurn,
  endRemoteSession,
  sendRemoteSessionMessage,
  startRemoteSession,
} from "#execution/agent-sessions/remote-session.js";
import {
  agentSessionResetCommand,
  localAgentSendCommand,
  prepareLocalAgentSession,
  resolveAgentSessionStart,
  type LocalAgentSession,
  type OpenedAgentSession,
  type PreparedLocalAgentSession,
  type StartedAgentSession,
} from "#execution/agent-sessions/start.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { RunAgentSessions } from "#execution/run-host.js";
import { createLogger, logError } from "#internal/logging.js";
import { agentDelegation } from "#tracing/eve/delegation.js";

// The agent sessions a run opens, on any host: the one place that tells a local session from a
// remote one, says why a session can't take a message, and keeps ending and cancelling best
// effort. A host supplies how it starts and commands its local sessions, how it names
// deliveries, and whether it reaches remote agents.

const log = createLogger("execution.agent-sessions");

/** How a host starts and commands the local sessions its runs open. */
export interface LocalAgentSessions {
  /** Starts the child `prepared` describes, for the call whose `context` opens it as `key`. */
  start(
    prepared: PreparedLocalAgentSession,
    opening: { readonly context: AgentSessionContext; readonly key: string },
  ): Promise<StartedAgentSession>;
  /** Sends `command` to a session the run opened. */
  command<TCommand extends SessionCommand>(
    session: LocalAgentSession,
    command: TCommand,
  ): Promise<SessionCommandResult<TCommand>>;
  /** Sends `command` to a session that may still be booting, without waiting for it. */
  commandLate(sessionId: string, command: SessionCommand): Promise<void>;
}

/** How a host reaches remote agents: where eve's callback route is served, for their replies. */
export interface RemoteAgentAccess {
  callbackBaseUrl(): string;
}

export interface AgentSessionsHost {
  readonly local: LocalAgentSessions;
  /** Absent on a host that can't reach remote agents, which refuses one with why. */
  readonly remote: RemoteAgentAccess | undefined;
  /** Names one delivery to a session, so a retry of the call that sends it repeats it. */
  deliveryId(kind: "cancel" | "reset" | "send", sessionId: string): string;
}

/** The agent sessions of a run on the host `host` describes. */
export function agentSessionsOver(host: AgentSessionsHost): RunAgentSessions {
  const { local } = host;
  const remoteAccess = (name: string): RemoteAgentAccess => {
    if (host.remote !== undefined) return host.remote;
    throw new NonRetryableError(
      `Agent "${name}" is remote, and this host can't reach remote agents yet. Run the agent with \`eve dev\` or deploy it.`,
    );
  };
  const end = async (opened: OpenedAgentSession): Promise<void> => {
    const { address, context } = opened;
    try {
      if (address.kind === "remote") {
        await endRemoteSession(context, address);
        return;
      }
      await local.command(
        { ...opened, address },
        agentSessionResetCommand(host.deliveryId("reset", address.sessionId)),
      );
    } catch (error) {
      logError(log, "failed to end an agent session", error, {
        name: address.name,
        sessionId: address.sessionId,
      });
    }
  };
  return {
    async open(input) {
      const start = await resolveAgentSessionStart(input);
      const { target } = start;
      const execute = () =>
        target.kind === "remote"
          ? startRemoteSession(
              { ...start, target },
              {
                callbackBaseUrl: remoteAccess(start.agentName).callbackBaseUrl(),
                operationId: `agent-session:${start.key}`,
              },
            )
          : local.start(prepareLocalAgentSession({ ...start, target }), start);
      return await agentDelegation.resume(
        { context: input.context, agentName: start.agentName },
        execute,
      );
    },
    async send(input) {
      const { address } = input;
      const deliveryId = host.deliveryId("send", address.sessionId);
      if (address.kind === "remote") {
        return await sendRemoteSessionMessage({ ...input, address }, deliveryId);
      }
      const result = await local
        .command({ ...input, address }, localAgentSendCommand({ ...input, address }, deliveryId))
        .catch((error: unknown) => {
          if (!SessionStrandedError.is(error)) throw error;
          throw new Error(
            `Agent "${address.name}" can no longer receive messages: ${error.message}`,
            { cause: error },
          );
        });
      if (result.status !== "accepted") {
        throw new Error(
          `Agent "${address.name}" can no longer receive messages; its session ended.`,
        );
      }
      return { deliveryId, sessionId: result.sessionId };
    },
    async cancelTurn(opened) {
      const { address, context } = opened;
      try {
        if (address.kind === "remote") {
          await cancelRemoteSessionTurn(context, address);
          return;
        }
        await local.command(
          { ...opened, address },
          { kind: "cancel", deliveryId: host.deliveryId("cancel", address.sessionId) },
        );
      } catch (error) {
        logError(log, "failed to cancel an agent session turn", error, {
          name: address.name,
          sessionId: address.sessionId,
        });
      }
    },
    async end({ sessions }) {
      await Promise.all(sessions.map(end));
    },
    async stopLate(opened) {
      if (opened.address.kind === "remote") {
        await end(opened);
        return;
      }
      const { sessionId } = opened.address;
      try {
        await local.commandLate(
          sessionId,
          agentSessionResetCommand(host.deliveryId("reset", sessionId)),
        );
      } catch (error) {
        logError(log, "could not stop late child; cleanup is best effort", error, { sessionId });
      }
    },
  };
}
