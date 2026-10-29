import type { Session } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import { sessionCommandErrorResponse } from "#eve-channel/support.js";
import { createLogger, logError } from "#internal/logging.js";
import type { CommandInfo, CommandRunResult } from "#protocol/commands.js";
import {
  CommandNeedsSessionError,
  CommandTakesNoArgumentError,
  type CommandDefinitions,
  type CommandResult,
  type CommandSession,
  findCommand,
  runCommand,
} from "#public/definitions/command.js";
import type { DeliveryReceipt } from "#protocol/delivery.js";

const log = createLogger("eve.channel.commands");

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** `GET /eve/v1/commands`: discovery metadata only, never the handlers. */
export function listEveCommandsResponse(commands: CommandDefinitions | undefined): Response {
  const listed = Object.entries(commands ?? {}).map(([name, command]) => {
    const entry: Mutable<CommandInfo> = {
      name,
      description: command.description,
      arguments: command.arguments ?? "none",
      session: command.session ?? "optional",
    };
    if (command.argumentHint !== undefined) entry.argumentHint = command.argumentHint;
    if (command.aliases !== undefined && command.aliases.length > 0)
      entry.aliases = command.aliases;
    return entry;
  });
  return Response.json(
    { ok: true, commands: listed },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * `POST /eve/v1/commands/:name` and `POST /eve/v1/session/:sessionId/commands/:name`: runs one
 * command, in the addressed session when there is one. A `send` the command returns goes into
 * that session through `deliver`, the same `onMessage` path a typed message takes.
 */
export async function runEveCommandResponse(input: {
  readonly commands: CommandDefinitions | undefined;
  readonly name: string;
  readonly argument: string;
  readonly caller: SessionAuthContext | null;
  readonly session?: {
    readonly handle: Session;
    readonly deliver: (message: string) => Promise<DeliveryReceipt | Response>;
  };
}): Promise<Response> {
  const found = findCommand(input.commands, input.name);
  if (found === undefined) {
    return Response.json(
      { error: `Unknown command "/${input.name}".`, ok: false },
      { status: 404 },
    );
  }
  const ended = { value: false };
  const session =
    input.session === undefined
      ? undefined
      : bindCommandSession(input.session.handle, input.caller, ended);
  let result: CommandResult;
  try {
    result = await runCommand(found, {
      argument: input.argument,
      caller: input.caller,
      ...(session !== undefined && { session }),
    });
  } catch (error) {
    return commandFailure(found.name, error);
  }
  const body: { ok: true } & Mutable<CommandRunResult> = { ok: true };
  if (result.message !== undefined) body.message = result.message;
  if (ended.value) body.ended = true;
  if (result.send !== undefined && input.session !== undefined) {
    let receipt: DeliveryReceipt | Response;
    try {
      receipt = await input.session.deliver(result.send);
    } catch (error) {
      return commandFailure(found.name, error);
    }
    if (receipt instanceof Response) return receipt;
    body.delivery = { sessionId: receipt.sessionId, deliveryId: receipt.deliveryId };
  }
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}

function commandFailure(name: string, error: unknown): Response {
  if (error instanceof CommandNeedsSessionError) {
    return Response.json({ error: error.message, ok: false }, { status: 409 });
  }
  if (error instanceof CommandTakesNoArgumentError) {
    return Response.json({ error: error.message, ok: false }, { status: 400 });
  }
  const sessionError = sessionCommandErrorResponse(error);
  if (sessionError !== undefined) return sessionError;
  const errorId = logError(log, "eve channel command failed", error, { command: name });
  return Response.json(
    { error: `The /${name} command failed.`, errorId, ok: false },
    { status: 500 },
  );
}

/** Binds the caller's auth to each control, and notes when the command ended the session. */
function bindCommandSession(
  session: Session,
  auth: SessionAuthContext | null,
  ended: { value: boolean },
): CommandSession {
  return {
    id: session.id,
    cancel: async () => void (await session.cancel({ auth })),
    clear: async () => void (await session.clear({ auth })),
    compact: async () => void (await session.compact({ auth })),
    async end() {
      await session.end({ auth });
      ended.value = true;
    },
  };
}
