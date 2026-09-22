import { defineSandbox, type SandboxSession } from "eve/sandbox";
import { defineSandboxProvider } from "eve/sandbox/provider";

export const CUSTOM_PROVIDER_TOKEN = "custom-provider-session-ok-P7M";

type CustomSession = SandboxSession & { probe(): Promise<string> };
type CustomState = { readonly marker: string; readonly version: 1 };

const provider = defineSandboxProvider<undefined, undefined, null, CustomState, CustomSession>({
  name: "custom-provider-session",
  environment() {
    return {
      async prepare() {
        return null;
      },
      async resume(_context, _artifact, state) {
        return createHandle(state.marker);
      },
      async start(context) {
        const marker = `${CUSTOM_PROVIDER_TOKEN}:${context.session.id}`;
        return {
          handle: createHandle(marker),
          state: { marker, version: 1 },
        };
      },
    };
  },
});

export const environment = provider.environment();

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  await sandbox.writeTextFile({ content: await sandbox.probe(), path: "/workspace/probe.txt" });
  return sandbox;
});

function createHandle(marker: string) {
  const files = new Map<string, Uint8Array>([["/workspace/probe.txt", Buffer.from(marker)]]);
  const resolvePath = (path: string) =>
    path.startsWith("/") ? path : `/workspace/${path.replace(/^\.\//u, "")}`;
  const session = {
    async probe() {
      return marker;
    },
    async readBinaryFile({ path }: { path: string }) {
      const content = files.get(resolvePath(path));
      if (content === undefined) throw new Error(`Missing fixture file: ${path}`);
      return content;
    },
    async readFile({ path }: { path: string }) {
      const content = files.get(resolvePath(path));
      if (content === undefined) throw new Error(`Missing fixture file: ${path}`);
      return new Blob([Buffer.from(content)]).stream();
    },
    async readTextFile({ path }: { path: string }) {
      const content = files.get(resolvePath(path));
      if (content === undefined) throw new Error(`Missing fixture file: ${path}`);
      return Buffer.from(content).toString("utf8");
    },
    async removePath({ path }: { path: string }) {
      files.delete(resolvePath(path));
    },
    resolvePath,
    async run() {
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async spawn() {
      throw new Error("spawn is not used by this fixture.");
    },
    async writeBinaryFile({ content, path }: { content: Uint8Array; path: string }) {
      files.set(resolvePath(path), content);
    },
    async writeFile({ content, path }: { content: ReadableStream<Uint8Array>; path: string }) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of content) chunks.push(chunk);
      files.set(resolvePath(path), Buffer.concat(chunks));
    },
    async writeTextFile({ content, path }: { content: string; path: string }) {
      files.set(resolvePath(path), Buffer.from(content));
    },
  } satisfies CustomSession;
  return {
    sandbox: Object.freeze(session),
    async onRuntimeShutdown() {},
    async onSessionDelete() {},
    async onSessionStop() {},
  };
}
