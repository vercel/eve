import { RuleTester } from "oxlint/plugins-dev";
import { describe, test } from "vitest";

RuleTester.describe = describe;
RuleTester.it = test;
RuleTester.itOnly = test.only;

export const typescriptRuleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
