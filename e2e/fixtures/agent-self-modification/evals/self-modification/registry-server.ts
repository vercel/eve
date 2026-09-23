import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const docsRoot = resolve(process.cwd(), "../../../apps/docs");
const addresses = new Set(["extension/agent-browser", "channel/slack"]);

/** Serve checkout-owned official manifests without depending on eve.dev or a deployed registry. */
export async function startRegistryServer(): Promise<() => Promise<void>> {
  const registry = JSON.parse(await readFile(resolve(docsRoot, "registry.json"), "utf8")) as {
    items: { name: string; files?: { path: string }[] }[];
  };
  const items = registry.items.filter((item) => addresses.has(item.name));
  if (items.length !== addresses.size) throw new Error("Registry eval item missing from checkout.");
  const manifests = new Map<string, unknown>(
    await Promise.all(
      items.map(
        async (item) =>
          [
            `/r/${item.name}.json`,
            {
              ...item,
              files:
                item.files === undefined
                  ? undefined
                  : await Promise.all(
                      item.files.map(async (file) => ({
                        ...file,
                        content: await readFile(resolve(docsRoot, file.path), "utf8"),
                      })),
                    ),
            },
          ] as const,
      ),
    ),
  );
  const server = createServer((request, response) => {
    const body =
      request.url === "/r/registry.json"
        ? { ...registry, items }
        : manifests.get(request.url ?? "");
    response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? { error: "Not found" }));
  });
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No registry port.");
  const previous = process.env.EVE_DEV_OFFICIAL_REGISTRY_URL;
  process.env.EVE_DEV_OFFICIAL_REGISTRY_URL = `http://127.0.0.1:${address.port}/r`;
  return async () => {
    if (previous === undefined) delete process.env.EVE_DEV_OFFICIAL_REGISTRY_URL;
    else process.env.EVE_DEV_OFFICIAL_REGISTRY_URL = previous;
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  };
}
