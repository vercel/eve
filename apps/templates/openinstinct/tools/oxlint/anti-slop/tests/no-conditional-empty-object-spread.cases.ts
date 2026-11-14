import { typescriptRuleTester as tester } from "./rule-tester.ts";

import { noConditionalEmptyObjectSpreadRule } from "@tools/oxlint/anti-slop/rules/no-conditional-empty-object-spread.ts";

const error = { messageId: "avoid" };

if (noConditionalEmptyObjectSpreadRule.meta?.fixable !== undefined) {
  throw new Error("The rule must not offer an unsafe semantics-changing fix.");
}

tester.run(
  "anti-slop/no-conditional-empty-object-spread",
  noConditionalEmptyObjectSpreadRule,
  {
    valid: [
      "const result = { value };",
      "const result = { ...values };",
      "const result = condition ? { value } : {};",
    ],
    invalid: [
      "value !== undefined ? { value } : {}",
      "condition ? {} : { value }",
    ].map((conditional) => ({
      code: `const result = { ...(${conditional}) };`,
      errors: [error],
    })),
  },
);
