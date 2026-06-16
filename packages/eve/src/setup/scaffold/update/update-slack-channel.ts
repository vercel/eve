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
