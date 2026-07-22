import type {
  LoopTypes,
  SessionBackend,
  SessionProgramInput,
  TerminalOutcome,
} from "#core/types.js";

/**
 * Drives one session: dispatch a turn per delivery until a turn completes
 * the session, then publish the terminal outcome exactly once through
 * `finish`. A waiting or cancelled turn parks the session; the next
 * delivery arrives through `park`, which owns buffering, coalescing,
 * cancellation settlement, authorization waits, and descendant routing
 * below the port.
 */
export async function runSession<Types extends LoopTypes>(
  backend: SessionBackend<Types>,
  input: SessionProgramInput<Types>,
): Promise<TerminalOutcome<Types>> {
  let state = input.state;
  let delivery: Types["delivery"] = input.initialDelivery;
  let turnOrdinal = 0;

  while (true) {
    const turn = await backend
      .spawnTurn(
        {
          capabilities: input.capabilities,
          delivery,
          mode: input.mode,
          state,
        },
        turnOrdinal++,
      )
      .wait();
    state = turn.state;

    if (turn.kind === "done") {
      const outcome: TerminalOutcome<Types> = {
        isError: turn.isError,
        output: turn.output,
        usage: turn.usage,
      };
      await backend.finish(turn);
      return outcome;
    }

    const advance = await backend.park(turn);
    if (advance.kind === "closed") return advance.outcome;
    delivery = advance.delivery;
    state = advance.state;
  }
}
