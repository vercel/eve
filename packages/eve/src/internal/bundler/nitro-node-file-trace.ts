import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

interface NodeFileTraceResult {
  readonly fileList: ReadonlySet<string>;
  readonly warnings: ReadonlySet<Error>;
}

type NodeFileTrace = (
  files: string[],
  options: {
    readonly base: string;
    readonly conditions: string[];
    readonly processCwd: string;
  },
) => Promise<NodeFileTraceResult>;

interface NodeFileTraceModule {
  readonly nodeFileTrace: NodeFileTrace;
}

let nodeFileTraceModulePromise: Promise<NodeFileTraceModule> | undefined;

async function loadNitroNodeFileTrace(): Promise<NodeFileTraceModule> {
  nodeFileTraceModulePromise ??= (async () => {
    const require = createRequire(import.meta.url);
    const nitroRequire = createRequire(require.resolve("nitro/package.json"));
    const modulePath = nitroRequire.resolve("@vercel/nft");
    return (await import(pathToFileURL(modulePath).href)) as NodeFileTraceModule;
  })();

  return await nodeFileTraceModulePromise;
}

// Traces under `node` + `import` conditions: the runtime loads materialized
// externals with ESM `import()`, so tracing through `require` conditions
// would materialize files the runtime never resolves.
export async function traceNodeEsmFiles(input: {
  readonly base: string;
  readonly entries: readonly string[];
  readonly processCwd: string;
}): Promise<NodeFileTraceResult> {
  const { nodeFileTrace } = await loadNitroNodeFileTrace();
  return await nodeFileTrace([...input.entries], {
    base: input.base,
    conditions: ["node", "import"],
    processCwd: input.processCwd,
  });
}
