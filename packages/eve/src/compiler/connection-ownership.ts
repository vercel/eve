import { assertNotConnectionOwned } from "#connections/ownership.js";

/** Rejects static names that fall under a static connection's name or `__` prefix. */
export function assertStaticConnectionOwnership(input: {
  readonly connectionNames: readonly string[];
  readonly subagentNames: readonly string[];
  readonly toolNames: readonly string[];
}): void {
  const { connectionNames } = input;
  const checks = [
    ["Connection", connectionNames, "Rename one of the connections."],
    ["Tool", input.toolNames, "Rename the tool file."],
    ["Subagent", input.subagentNames, "Rename the subagent directory."],
  ] as const;
  for (const [subject, names, remedy] of checks) {
    for (const name of names) {
      // A connection owns its own name.
      const owners =
        names === connectionNames
          ? connectionNames.filter((other) => other !== name)
          : connectionNames;
      assertNotConnectionOwned({ connectionNames: owners, name, remedy, subject });
    }
  }
}
