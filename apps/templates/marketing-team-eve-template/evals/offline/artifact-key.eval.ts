import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { artifactId, artifactKey } from "../../agent/lib/artifacts/config.js";

export default defineEval({
  description:
    "artifactKey accepts generated ids and rejects ids that reach outside the prefix.",
  test(t) {
    const id = artifactId("seo-audit", "Pricing page");
    t.check(artifactKey(id), equals(`artifacts/${id}.md`));
    t.check(artifactKey("../brand-context/brand"), equals(null));
    t.check(artifactKey("seo-audit/../../brand-context/brand"), equals(null));
    t.check(artifactKey(""), equals(null));
  },
});
