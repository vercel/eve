import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import {
  judgeRules,
  toVerdict,
  UNCERTAIN_HIGH,
  UNCERTAIN_LOW,
} from "../../agent/lib/decisions/config.js";

export default defineEval({
  description:
    "toVerdict reads the band edges conservatively, and judgeRules fails open offline.",
  async test(t) {
    t.check(toVerdict(UNCERTAIN_HIGH + 0.01), equals("pass"));
    t.check(toVerdict(UNCERTAIN_HIGH), equals("unsure"));
    t.check(toVerdict(UNCERTAIN_LOW + 0.01), equals("unsure"));
    t.check(toVerdict(UNCERTAIN_LOW), equals("fail"));
    t.check(toVerdict(Number.NaN), equals("unsure"));
    t.check(
      await judgeRules({ polite: "Is the text polite?" }, { text: "Thanks." }),
      equals(null)
    );
  },
});
