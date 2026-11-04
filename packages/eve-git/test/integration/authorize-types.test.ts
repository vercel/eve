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
      authorize: ({ repository, auth }) => {
        const unscoped: null = repository;
        return unscoped === null && auth !== null;
      },
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
