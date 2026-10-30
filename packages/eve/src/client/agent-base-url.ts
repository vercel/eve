const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const EVE_NAMED_AGENT_ROUTE_PREFIX = "/eve";

export function resolveEveAgentBaseUrl(input: {
  readonly agent?: string;
  readonly baseUrl?: string;
}): string {
  if (input.agent === undefined) {
    return input.baseUrl ?? "";
  }

  if (input.baseUrl !== undefined) {
    throw new Error("useEveAgent cannot combine agent and baseUrl. Use one target option.");
  }

  assertValidAgentName(input.agent);
  return `${EVE_NAMED_AGENT_ROUTE_PREFIX}/${input.agent}`;
}

function assertValidAgentName(name: string): void {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error(
      `eve agent name ${JSON.stringify(
        name,
      )} is invalid. Use lowercase letters, numbers, underscores, or hyphens, starting with a letter or number.`,
    );
  }
}
