import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { dataset } from "../src/data";
import { concurrentBalances } from "../src/checks";
import { audit } from "./shared";

export default defineEval({
  tags: ["real-model"],
  description: "The model overlaps independent reads and retains successes when one source fails.",
  timeoutMs: 180_000,
  async test(t) {
    const turn = await t.send(
      "Get the current USD balances for every account in the treasury portfolio as quickly as possible. If a service is unavailable, include the other accounts and identify the unavailable account. Save a treasury report with the available total and the unavailable account ids.",
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
      calls
        .filter((call) => call.tool === "save_report" && call.status === "completed")
        .map((call) => call.input),
      equals([
        {
          totalAvailableCents: accounts
            .filter((account) => account.available)
            .reduce((total, account) => total + account.cents, 0),
          unavailableAccounts: unavailable,
        },
      ]),
    ).label("the program saved successful balances and identified the failed source");
  },
});
