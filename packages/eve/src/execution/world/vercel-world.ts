import type { QueueWorld } from "./runtime-world.js";

// Vercel's World (`@workflow/world-vercel`) for sessions an in-process runtime keeps: in a Vercel
// deployment, the deployment's own; anywhere else (a laptop, a devbox, CI), the same project's
// World through api.vercel.com, so a session saved on one machine continues on another. It loads
// the first time a session uses it, so importing eve doesn't load Workflow's World.
//
// Outside a deployment, three things differ from inside one, each learned against Workflow Server:
//   - Auth is a Vercel token: Workflow Server refuses the development OIDC token `vercel env pull`
//     writes. The token is `token`, else VERCEL_TOKEN, else the Vercel CLI's login.
//   - The environment is "preview" or "production": the "development" one has no runs.
//   - There's no deployment to name runs after, so the runtime names its own (`deploymentId`).
//     Nothing routes to it: no queue delivers to an in-process runtime.

export interface VercelWorldOptions {
  /** The project's id (`prj_…`). Default: `.vercel/project.json` in the working directory. */
  readonly projectId?: string;
  /** The team's id (`team_…`). Default: `.vercel/project.json`'s `orgId`. */
  readonly teamId?: string;
  /** Default `"preview"`. Outside a deployment, `"development"` has no runs. */
  readonly environment?: "preview" | "production";
  /** Default: VERCEL_TOKEN, then the Vercel CLI's login. Unused in a deployment. */
  readonly token?: string;
  /** What runs this runtime creates are attributed to outside a deployment. */
  readonly deploymentId?: string;
}

const IN_PROCESS_DEPLOYMENT = "dpl_eve_in_process";

/** Vercel's World for this project; see the module comment. */
export function vercelWorld(options: VercelWorldOptions = {}): QueueWorld {
  let loading: Promise<{ readonly world: QueueWorld; readonly deploymentId: string }> | undefined;
  let loaded: QueueWorld | undefined;
  const opened = () =>
    (loading ??= open(options).then((open) => {
      loaded = open.world;
      return open;
    }));
  const world = async () => (await opened()).world;
  return {
    // The World's own, once a call loaded it (`getDeploymentId` does before a session's first write).
    get capabilities() {
      return loaded?.capabilities;
    },
    getDeploymentId: async () => (await opened()).deploymentId,
    events: {
      create: async (runId, data, params) =>
        await (await world()).events.create(runId, data, params),
      list: async (params) => await (await world()).events.list(params),
    },
    hooks: { getByToken: async (token) => await (await world()).hooks.getByToken(token) },
    runs: {
      list: async (params) => await (await world()).runs.list(params),
      // Workflow's Worlds have it, so the fitted one does.
      get: async (runId, params) => await (await world()).runs.get!(runId, params),
    },
    streams: {
      close: async (runId, name) => await (await world()).streams.close(runId, name),
      getChunks: async (runId, name, chunks) =>
        await (await world()).streams.getChunks(runId, name, chunks),
      getInfo: async (runId, name) => await (await world()).streams.getInfo(runId, name),
      get: async (runId, name, startIndex) => {
        const { streams } = await world();
        if (streams.get === undefined) throw new Error("This World has no live stream read.");
        return await streams.get(runId, name, startIndex);
      },
      write: async (runId, name, chunk) => await (await world()).streams.write(runId, name, chunk),
      writeMulti: async (runId, name, chunks) => {
        const streams = (await world()).streams;
        if (streams.writeMulti !== undefined) await streams.writeMulti(runId, name, chunks);
        else for (const chunk of chunks) await streams.write(runId, name, chunk);
      },
    },
    // Vercel Queues deliver to a deployment's subscribed function, not to this process: a host
    // serves `createQueueHandler`'s handler there.
    queue: async (name, message, queueOptions) =>
      await (await world()).queue(name, message, queueOptions),
    createQueueHandler(prefix, handler) {
      let made: ((request: Request) => Promise<Response>) | undefined;
      return async (request) =>
        await (made ??= (await world()).createQueueHandler(prefix, handler))(request);
    },
    close: async () => await loaded?.close?.(),
  };
}

async function open(
  options: VercelWorldOptions,
): Promise<{ readonly world: QueueWorld; readonly deploymentId: string }> {
  const { createWorld } = await import("#compiled/@workflow/world-vercel/index.js");
  const deployment = process.env.VERCEL_DEPLOYMENT_ID;
  if (deployment !== undefined && options.token === undefined && options.projectId === undefined) {
    // In a deployment: its OIDC token, its project, its environment.
    return { deploymentId: deployment, world: createWorld() };
  }
  const environment = options.environment ?? "preview";
  if ((environment as string) === "development")
    throw new Error(
      'vercelWorld: the "development" environment has no Workflow runs; use "preview" or "production".',
    );
  const project = await linkedProject(options);
  const token = options.token ?? process.env.VERCEL_TOKEN ?? (await cliToken());
  if (token === undefined)
    throw new Error(
      "vercelWorld needs a Vercel token outside a deployment: pass `token`, set VERCEL_TOKEN, or log in with `vercel login`. (Workflow Server refuses the development OIDC token `vercel env pull` writes.)",
    );
  return {
    deploymentId: options.deploymentId ?? IN_PROCESS_DEPLOYMENT,
    world: createWorld({
      projectConfig: { environment, projectId: project.projectId, teamId: project.teamId },
      token,
    }),
  };
}

/** The project `options` names, else the one `vercel link` wrote for the working directory. */
async function linkedProject(
  options: VercelWorldOptions,
): Promise<{ readonly projectId: string; readonly teamId: string }> {
  if (options.projectId !== undefined && options.teamId !== undefined)
    return { projectId: options.projectId, teamId: options.teamId };
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  let linked: { readonly projectId?: string; readonly orgId?: string } = {};
  try {
    linked = JSON.parse(await readFile(join(process.cwd(), ".vercel", "project.json"), "utf8"));
  } catch {
    // Not linked: the options must name the project.
  }
  const projectId = options.projectId ?? linked.projectId;
  const teamId = options.teamId ?? linked.orgId;
  if (projectId === undefined || teamId === undefined)
    throw new Error(
      "vercelWorld needs its project outside a deployment: pass `projectId` and `teamId`, or run `vercel link` in the working directory.",
    );
  return { projectId, teamId };
}

/** The token the Vercel CLI's login keeps, where the CLI keeps it on this platform. */
async function cliToken(): Promise<string | undefined> {
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const dataHome =
    process.env.XDG_DATA_HOME ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
        : join(homedir(), ".local", "share"));
  try {
    const auth = JSON.parse(await readFile(join(dataHome, "com.vercel.cli", "auth.json"), "utf8"));
    return typeof auth.token === "string" ? auth.token : undefined;
  } catch {
    return undefined;
  }
}
