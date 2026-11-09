import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

// Must match the fixture's `agent/channels/eve.ts`.
const REPLACE_CLIENT_CONTEXT_MARKER = "e2e:replace-client-context";
const SERVER_CONTEXT_TOKEN = "serverctx-K3M8";
const CLIENT_CONTEXT_TOKEN = "clientctx-replaced-T5N1";
const CONTEXT_TOKEN_PATTERN = /\b(?:clientctx|serverctx)-[A-Za-z0-9-]+\b/g;

/**
 * The eve channel's `onMessage` replaces a turn's client context. The fixture
 * channel swaps the client's entries for its own token when the marker entry
 * is present, so the model should see the server's token and none of the
 * client's.
 */
export default defineEval({
  tags: ["real-model"],
  description: "Session runtime smoke: onMessage replaces a turn's client context.",

  async test(t) {
    const turn = await t.send(
      "Reply with every token beginning with clientctx- or serverctx- that is visible anywhere in your model input, one per line, and nothing else.",
      {
        clientContext: [
          REPLACE_CLIENT_CONTEXT_MARKER,
          `The client context token is ${CLIENT_CONTEXT_TOKEN}.`,
        ],
      },
    );

    t.succeeded();
    const tokens = turn.reply?.match(CONTEXT_TOKEN_PATTERN) ?? [];
    await t.require(
      tokens,
      satisfies<readonly string[]>(
        (observed) => observed.includes(SERVER_CONTEXT_TOKEN),
        "contains the channel's context token",
      ),
    );
    await t.require(
      tokens,
      satisfies<readonly string[]>(
        (observed) => !observed.includes(CLIENT_CONTEXT_TOKEN),
        "does not contain the replaced client context token",
      ),
    );
  },
});
