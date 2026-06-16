import { readFile, writeFile } from "node:fs/promises";

/**
 * Matches the connector UID literal inside the `connect("…")` call emitted by
 * the connection scaffolder. `connect` is only ever called with a single string
 * argument in generated connection files, so a narrow anchored match is safe.
 */
const CONNECT_CONNECTOR_REGEX = /(\bconnect\(\s*)(["'`])([^"'`]+)\2/;

/**
 * Replaces the connector UID literal in a scaffolded Connect connection
 * definition (`auth: connect("…")`). Returns `{ patched: false }` when the file
 * is missing or contains no `connect("…")` call to rewrite.
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

  if (!CONNECT_CONNECTOR_REGEX.test(source)) {
    return { patched: false };
  }

  const next = source.replace(
    CONNECT_CONNECTOR_REGEX,
    (_match, prefix: string, quote: string) => `${prefix}${quote}${connectorUid}${quote}`,
  );
  await writeFile(connectionFilePath, next, "utf8");
  return { patched: true };
}
