import test from "node:test";

import git from "../../extension/extension.ts";

const broker = async () => {};

// Typechecked by `pnpm typecheck`: what `authorize` receives depends on `principalType`.
test("authorize receives owner only for app tokens", () => {
  git({
    github: {
      connector: "c",
      broker,
      principalType: "app",
      authorize: ({ owner }) => owner.toLowerCase() === "acme",
    },
  });
  git({
    github: {
      connector: "c",
      broker,
      principalType: "user",
      authorize: ({ repository }) => repository?.startsWith("acme/") ?? false,
    },
  });
  git({
    github: {
      connector: "c",
      broker,
      principalType: "user",
      // @ts-expect-error User tokens are not scoped to an owner.
      authorize: ({ owner }) => owner === "acme",
    },
  });
});
