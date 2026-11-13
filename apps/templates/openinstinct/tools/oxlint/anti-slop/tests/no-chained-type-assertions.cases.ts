import { typescriptRuleTester as tester } from "./rule-tester.ts";

import { noChainedTypeAssertionsRule } from "@tools/oxlint/anti-slop/rules/no-chained-type-assertions.ts";

const error = { messageId: "chained" };

tester.run("anti-slop/no-chained-type-assertions", noChainedTypeAssertionsRule, {
  valid: [
    "const user = input as User;",
    "const user = <User>input;",
    "const values = [1, 2] as const;",
    "const result = transform(input as Source) as Result;",
    "const nested = { value: input as Source } as Container;",
    "const values = (([1, 2] as const)) as const;",
  ],
  invalid: [
    {
      name: "as assertion chain",
      code: "const user = input as object as User;",
      errors: [{ ...error, line: 1, column: 13 }],
    },
    {
      name: "parenthesized assertion chain",
      code: "const user = ((input as object)) as User;",
      errors: [error],
    },
    {
      name: "angle-bracket assertion chain",
      code: "const user = <User><object>input;",
      errors: [error],
    },
    {
      name: "mixed const and non-const chain",
      code: "const values = ([1, 2] as const) as readonly number[];",
      errors: [error],
    },
    {
      name: "reports a long chain once",
      code: "const user = input as unknown as object as User;",
      errors: 1,
    },
  ],
});
