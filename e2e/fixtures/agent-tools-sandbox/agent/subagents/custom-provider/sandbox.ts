import { randomUUID } from "node:crypto";

import { defineSandbox } from "eve/sandbox";
import {
  defineSandboxProvider,
  SandboxSessionGoneError,
  type SandboxConnection,
} from "eve/sandbox/provider";

export const CUSTOM_PROVIDER_TOKEN = "custom-provider-session-ok-P7M";
/** The machine keeps its working files outside eve's default `/workspace`. */
export const CUSTOM_WORKSPACE_ROOT = "/srv/app";

/**
 * One in-memory machine per session, standing in for a remote sandbox
 * service. A machine lives in this process only, so a step that runs in
 * another process finds it gone and continues in a fresh one, as it would
 * after the service reclaimed it.
 */
interface Machine {
  readonly files: Map<string, Uint8Array>;
  readonly id: string;
}

type CustomExtensions = {
  /** Returns the session marker the selector writes into each new machine. */
  probe(): Promise<string>;
  /** The machine backing this sandbox; a fresh sandbox has a new one. */
  machineId(): string;
  /** Removes the machine from the service, as maintenance would. */
  retireForMaintenance(): Promise<void>;
};

const machines = new Map<string, Machine>();

const CustomSandbox = defineSandboxProvider({
  name: "custom-provider-session",
  environment() {
    return {
      async prepare(ctx) {
        return { templateKey: ctx.templateKey({ machine: "memory", version: 1 }) };
      },
      async start(ctx) {
        // An upsert on the session id: a live machine is returned unchanged.
        let machine = machines.get(ctx.session.id);
        if (machine === undefined) {
          machine = { files: new Map(), id: randomUUID() };
          machines.set(ctx.session.id, machine);
        }
        return {
          connection: connect(ctx.session.id, machine),
          state: { machineId: machine.id, version: 1 },
        };
      },
      async resume(ctx, _artifact, state) {
        const machine = machines.get(ctx.session.id);
        if (machine?.id !== state.machineId) {
          throw new SandboxSessionGoneError(`Machine "${state.machineId}" no longer exists.`);
        }
        return connect(ctx.session.id, machine);
      },
      async onSessionEnd(ctx) {
        machines.delete(ctx.session.id);
      },
    };
  },
});

export const environment = CustomSandbox.environment();

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  await sandbox.writeTextFile({ content: await sandbox.probe(), path: "probe.txt" });
  return sandbox;
});

function connect(sessionId: string, machine: Machine): SandboxConnection<CustomExtensions> {
  return {
    async spawn() {
      return {
        kill: async () => {},
        stderr: new Blob(["This fixture machine runs no commands.\n"]).stream(),
        stdout: new Blob([]).stream(),
        wait: async () => ({ exitCode: 127 }),
      };
    },
    async readFile({ path }) {
      return machine.files.get(path) ?? null;
    },
    async writeFiles({ files }) {
      for (const file of files) machine.files.set(file.path, file.content);
    },
    async removePath({ force, path, recursive }) {
      const removed = [...machine.files.keys()].filter(
        (file) => file === path || (recursive === true && file.startsWith(`${path}/`)),
      );
      if (removed.length === 0 && force !== true) throw new Error(`No such path: ${path}`);
      for (const file of removed) machine.files.delete(file);
    },
    async stop() {},
    workspaceRoot: CUSTOM_WORKSPACE_ROOT,
    extensions: {
      machineId: () => machine.id,
      probe: async () => `${CUSTOM_PROVIDER_TOKEN}:${sessionId}`,
      async retireForMaintenance() {
        if (machines.get(sessionId) === machine) machines.delete(sessionId);
      },
    },
  };
}
