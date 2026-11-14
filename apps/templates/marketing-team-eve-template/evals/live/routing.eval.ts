import { defineEval } from "eve/evals";

/**
 * Confirms the lead routes on the specialists' descriptions with a real model.
 *
 * @remarks
 * Nothing in the lead's instructions names a specialist, so routing depends entirely on each
 * `description` and on the model. One unambiguous request is enough to catch a broken model id or
 * a lead that stopped delegating. It asserts the delegation only, not the specialist's output.
 */
export default defineEval({
  description: "the lead routes a schema markup request to the SEO specialist.",
  async test(t) {
    await t.send(
      "Routing test, so skip brand context and don't ask me anything. I need the JSON-LD " +
        "schema markup for a FAQ page with one question, 'What is Acme?', answered 'A CRM for " +
        "startups.' Route it to the right specialist with a one-line brief."
    );
    t.succeeded();
    t.calledAgent("seo");
  },
});
