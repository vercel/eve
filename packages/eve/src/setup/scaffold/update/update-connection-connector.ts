import { readFile, writeFile } from "node:fs/promises";

const CONNECT_CONNECTOR_REGEX = /(\bconnect\(\s*)(["'`])([^"'`]+)\2/;
const CONNECT_OBJECT_CONNECTOR_REGEX = /(\bconnector\s*:\s*)(["'`])([^"'`]+)\2/;

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

  const pattern = CONNECT_CONNECTOR_REGEX.test(source)
    ? CONNECT_CONNECTOR_REGEX
    : CONNECT_OBJECT_CONNECTOR_REGEX.test(source)
      ? CONNECT_OBJECT_CONNECTOR_REGEX
      : undefined;
  if (pattern === undefined) return { patched: false };

  const next = source.replace(
    pattern,
    (_match, prefix: string, quote: string) => `${prefix}${quote}${connectorUid}${quote}`,
  );
  await writeFile(connectionFilePath, next, "utf8");
  return { patched: true };
}
