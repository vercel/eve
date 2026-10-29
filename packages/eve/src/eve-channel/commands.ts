import type { Session } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import { sessionCommandErrorResponse } from "#eve-channel/support.js";
import { createLogger, logError } from "#internal/logging.js";
import type { CommandControl, CommandInfo, CommandRunResult } from "#protocol/commands.js";
import {
  CommandNeedsSessionError,
  type CommandDefinitions,
  type CommandResult,
  type CommandSession,
  findCommand,
  runCommand,
} from "#public/definitions/command.js";

const log = createLogger("eve.channel.commands");

/** `GET /eve/v1/commands`: discovery metadata only, never the handlers. */
export function listEveCommandsResponse(commands: CommandDefinitions | undefined): Response {
  const listed = Object.entries(commands ?? {}).map(([name, command]) => {
    const entry: { -readonly [K in keyof CommandInfo]: CommandInfo[K] } = {
      name,
      description: command.description,
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
 * command, in the addressed session when there is one, and returns its client-facing result.
 */
export async function runEveCommandResponse(input: {
  readonly commands: CommandDefinitions | undefined;
  readonly name: string;
  readonly argument: string;
  readonly caller: SessionAuthContext | null;
  readonly session?: Session;
}): Promise<Response> {
  const found = findCommand(input.commands, input.name);
  if (found === undefined) {
    return Response.json(
      { error: `Unknown command "/${input.name}".`, ok: false },
      { status: 404 },
    );
  }
  const controls: CommandControl[] = [];
  const session =
    input.session === undefined
      ? undefined
      : bindCommandSession(input.session, input.caller, controls);
  let result: CommandResult;
  try {
    result = await runCommand(found, {
      argument: input.argument,
      caller: input.caller,
      ...(session !== undefined && { session }),
    });
  } catch (error) {
    if (error instanceof CommandNeedsSessionError) {
      return Response.json({ error: error.message, ok: false }, { status: 409 });
    }
    const sessionError = sessionCommandErrorResponse(error);
    if (sessionError !== undefined) return sessionError;
    const errorId = logError(log, "eve channel command failed", error, { command: found.name });
    return Response.json(
      { error: `The /${found.name} command failed.`, errorId, ok: false },
      { status: 500 },
    );
  }
  const body: { ok: true } & { -readonly [K in keyof CommandRunResult]: CommandRunResult[K] } = {
    ok: true,
    ...result,
  };
  if (controls.length > 0) body.controls = controls;
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}

/** Binds the caller's auth to each control and records what the command applied. */
function bindCommandSession(
  session: Session,
  auth: SessionAuthContext | null,
  controls: CommandControl[],
): CommandSession {
  const control = async (kind: CommandControl, apply: () => Promise<unknown>) => {
    await apply();
    if (!controls.includes(kind)) controls.push(kind);
  };
  return {
    id: session.id,
    cancel: () => control("cancel", () => session.cancel({ auth })),
    clear: () => control("clear", () => session.clear({ auth })),
    compact: () => control("compact", () => session.compact({ auth })),
    end: () => control("end", () => session.end({ auth })),
  };
}
