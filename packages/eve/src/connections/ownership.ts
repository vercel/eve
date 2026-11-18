export function connectionToolName(connectionName: string, toolName: string): string {
  return `${connectionName}__${toolName}`;
}

function owningConnection(name: string, connectionNames: Iterable<string>): string | undefined {
  for (const connection of connectionNames) {
    if (name === connection || name.startsWith(connectionToolName(connection, ""))) {
      return connection;
    }
  }
  return undefined;
}

export function assertNotConnectionOwned(input: {
  readonly connectionNames: Iterable<string>;
  readonly name: string;
  readonly remedy: string;
  readonly subject: string;
}): void {
  const connection = owningConnection(input.name, input.connectionNames);
  if (connection === undefined) return;
  const conflict =
    input.name === connection
      ? `has the same name as connection "${connection}"`
      : `starts with "${connection}__", which belongs to connection "${connection}"`;
  throw new Error(`${input.subject} "${input.name}" ${conflict}. ${input.remedy}`);
}
