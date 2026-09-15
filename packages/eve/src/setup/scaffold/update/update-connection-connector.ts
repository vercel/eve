import { readFile, writeFile } from "node:fs/promises";

const CONNECT_STRING_AUTH = /^(\s*auth\s*:\s*connect\(\s*)(["'`])([^"'`]+)\2/gm;
const CONNECT_OBJECT_AUTH =
  /^(\s*auth\s*:\s*connect\(\s*\{[^}\r\n]*?\bconnector\s*:\s*)(["'`])([^"'`]+)\2/gm;

/**
 * Replaces the connector UID in the one generated connection auth declaration.
 * An expected UID can make registry-authored source updates fail closed when the
 * installed source no longer matches its declared connector.
 */
export function replaceConnectionConnectorUid(
  source: string,
  connectorUid: string,
  expectedConnectorUid?: string,
): string | undefined {
  const matches = [
    ...source.matchAll(CONNECT_STRING_AUTH),
    ...source.matchAll(CONNECT_OBJECT_AUTH),
  ];
  const candidate = matches.length === 1 ? matches[0] : undefined;
  if (candidate?.index === undefined) return undefined;

  const [match, prefix, quote, currentConnectorUid] = candidate;
  if (expectedConnectorUid !== undefined && currentConnectorUid !== expectedConnectorUid) {
    return undefined;
  }
  return `${source.slice(0, candidate.index)}${prefix}${quote}${connectorUid}${quote}${source.slice(candidate.index + match.length)}`;
}

/**
 * Replaces the connector UID literal in a scaffolded Connect connection
 * definition. Returns `{ patched: false }` when the file is missing or its
 * generated auth declaration cannot be identified unambiguously.
 */
export async function updateConnectionConnectorUid(
  connectionFilePath: string,
  connectorUid: string,
): Promise<{ patched: boolean }> {
  let source: string;
  try {
    source = await readFile(connectionFilePath, "utf8");
  } catch {
    return { patched: false };
  }

  const next = replaceConnectionConnectorUid(source, connectorUid);
  if (next === undefined) return { patched: false };

  await writeFile(connectionFilePath, next, "utf8");
  return { patched: true };
}
