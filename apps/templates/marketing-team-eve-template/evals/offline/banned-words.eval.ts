import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { findBannedWords } from "../../agent/lib/content/config.js";

const BANNED = ["leverage", "synergy", "click here"];

export default defineEval({
  description: "findBannedWords matches whole words, case-insensitively.",
  test(t) {
    t.check(
      findBannedWords("We LEVERAGE synergy to ship faster.", BANNED),
      equals(["leverage", "synergy"])
    );
    t.check(
      findBannedWords("The leveraged buyout closed.", BANNED),
      equals([])
    );
    t.check(
      findBannedWords("Click here to read more.", BANNED),
      equals(["click here"])
    );
    t.check(
      findBannedWords("Export reports in one click.", BANNED),
      equals([])
    );
  },
});
