import { assertNotConnectionOwned } from "#connections/ownership.js";

export function assertSubscriptionSourceNamesDistinct(input: {
  readonly channelNames: ReadonlySet<string>;
  readonly connectionNames: readonly string[];
}): void {
  const shared = input.connectionNames.filter((name) => input.channelNames.has(name));
  if (shared.length > 0)
    throw new Error(
      `A channel and a connection are both named ${shared.map((name) => `"${name}"`).join(", ")} and both offer subscriptions, so a subscription's source name would be ambiguous. Rename one.`,
    );
}

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
      const owners =
        names === connectionNames
          ? connectionNames.filter((other) => other !== name)
          : connectionNames;
      assertNotConnectionOwned({ connectionNames: owners, name, remedy, subject });
    }
  }
}
