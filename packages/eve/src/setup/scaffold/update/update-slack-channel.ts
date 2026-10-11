import { readFile, writeFile } from "node:fs/promises";

const CONNECT_SLACK_CREDENTIALS_REGEX = /(connectSlackCredentials\(\s*)(["'`])([^"'`]+)\2/;

/**
 * Replaces the connector UID literal in a scaffolded Slack channel definition.
 */
export async function updateSlackChannelConnectorUid(
  slackChannelPath: string,
  connectorUid: string,
): Promise<{ patched: boolean }> {
  let source: string;
  try {
    source = await readFile(slackChannelPath, "utf8");
  } catch {
    return { patched: false };
  }

  if (!CONNECT_SLACK_CREDENTIALS_REGEX.test(source)) {
    return { patched: false };
  }

  const next = source.replace(
    CONNECT_SLACK_CREDENTIALS_REGEX,
    (_match, prefix: string, quote: string) => `${prefix}${quote}${connectorUid}${quote}`,
  );
  await writeFile(slackChannelPath, next, "utf8");
  return { patched: true };
}

/**
 * What an existing `agent/channels/slack.ts` already decides. `connect` names
 * one connector UID literal; `environment` reads the default Slack environment
 * variables; `custom` is hand-written credential wiring eve does not parse.
 */
export type SlackChannelFileState =
  | { kind: "absent" }
  | { kind: "connect"; connectorUid: string }
  | { kind: "environment" }
  | { kind: "custom" };

/** Reads the Slack channel definition without changing it. */
export async function readSlackChannelFile(
  slackChannelPath: string,
): Promise<SlackChannelFileState> {
  let source: string;
  try {
    source = await readFile(slackChannelPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  const connectorUid = CONNECT_SLACK_CREDENTIALS_REGEX.exec(source)?.[3];
  if (connectorUid !== undefined && !connectorUid.includes("${")) {
    return { kind: "connect", connectorUid };
  }
  if (/\bconnectSlackCredentials\b|\bcredentials\s*:/.test(source)) return { kind: "custom" };
  return { kind: "environment" };
}
