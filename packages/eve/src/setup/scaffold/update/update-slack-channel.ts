import { readFile, writeFile } from "node:fs/promises";

const CONNECT_SLACK_CREDENTIALS_REGEX = /(connectSlackCredentials\(\s*)(["'`])([^"'`]+)\2/;

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

export type SlackChannelFileState =
  | { kind: "absent" }
  | { kind: "connect"; connectorUid: string }
  | { kind: "environment" }
  | { kind: "custom" };

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
