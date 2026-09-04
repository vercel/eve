import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { dataset } from "../src/data";
import { concurrentBalances, parseAnswer } from "../src/checks";
import { audit } from "./shared";

export default defineEval({
  tags: ["real-model"],
  description: "The model overlaps independent reads and retains successes when one source fails.",
  timeoutMs: 180_000,
  async test(t) {
    const turn = await t.send(
      "Get the current USD balances for every account in the treasury portfolio as quickly as possible. If a service is unavailable, include the other accounts and identify the unavailable account. Return JSON with totalAvailableCents (integer cents) and unavailableAccounts (array of account ids).",
    );
    const calls = await audit(t, turn);
    const { accounts } = dataset(turn.sessionId);
    const unavailable = accounts.filter((account) => !account.available).map(({ id }) => id);
    t.check(
      concurrentBalances(
        calls,
        accounts.map(({ id }) => id),
        unavailable[0]!,
      ),
      equals(true),
    ).label("all account reads overlap, with two successes and one failure");
    t.check(
      parseAnswer(turn.message),
      equals({
        totalAvailableCents: accounts
          .filter((account) => account.available)
          .reduce((total, account) => total + account.cents, 0),
        unavailableAccounts: unavailable,
      }),
    ).label("the answer preserves successful balances and identifies the failed source");
  },
});
