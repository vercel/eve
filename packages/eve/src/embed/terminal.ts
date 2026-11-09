import { codeAgentOf } from "#embed/agent.js";
import type { DefinedAgent } from "#public/definitions/agent.js";
import { promptCommandsFor } from "#cli/dev/tui/prompt-commands.js";
import { EveTUIRunner } from "#cli/dev/tui/runner.js";
import { Client } from "#client/index.js";
import type { ClientSessionState } from "#client/types.js";
import { createInProcessChannelFetch } from "#eve-channel/in-process.js";
import { createInProcessRuntime, type InProcessRuntime } from "#execution/in-process/runtime.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { holdSessionAgent } from "#runtime/sessions/session-agent.js";
import { describeAgent } from "./describe-agent.js";
import { localUser } from "./local-user.js";

// `eve dev`'s terminal UI for an agent defined in code, in this process: the TUI drives the eve
// channel through `eve/client`, whose `fetch` serves the channel here. No server, no build.

export interface TerminalOptions {
  /** The agent's name in the UI's header. */
  readonly name: string;
  /**
   * The World each session is kept on as it runs (`localWorld({ dataDir })` for a directory), so
   * quitting (or a crash) leaves it to `resume`, a turn that was cut off included. Without one,
   * sessions end with the process.
   */
  readonly world?: RuntimeWorld;
  /** The id of a session `world` keeps, to continue. */
  readonly resume?: string;
}

/** Runs `eve dev`'s terminal UI on the agent `defineAgent` returned, until the user quits. */
export async function runTerminal(defined: DefinedAgent, options: TerminalOptions): Promise<void> {
  const agent = codeAgentOf(defined);
  const { world } = options;
  if (options.resume !== undefined && world === undefined)
    throw new Error("runTerminal's `resume` continues a session from its `world`; pass both.");
  // The session's steps find the agent by id; the TUI holds it until it quits.
  const release = holdSessionAgent(agent);
  const runtime = createInProcessRuntime({ agent }, world === undefined ? {} : { world });
  try {
    const client = new Client({
      baseUrl: `http://${options.name}.in-process.invalid`,
      fetch: createInProcessChannelFetch({ agentName: options.name, caller: localUser(), runtime }),
    });
    await new EveTUIRunner({
      availablePromptCommands: promptCommandsFor("embedded"),
      // No app on disk to inspect, no deployment to link: the boot checks are for `eve dev`'s app.
      bootDetections: [],
      client,
      describeApplication: () => describeAgent(agent),
      initialSession: await resumed(runtime, options.resume),
      name: options.name,
    }).run();
  } finally {
    // A World keeps its sessions as they are, for `resume`; without one, they end here.
    await runtime.dispose();
    release();
  }
}

/** The saved session `resume` names, restored into `runtime` for the TUI to continue. */
async function resumed(
  runtime: InProcessRuntime,
  resume: string | undefined,
): Promise<ClientSessionState | undefined> {
  if (resume === undefined) return undefined;
  const saved = await runtime.load(resume);
  if (saved === undefined) throw new Error(`No saved session "${resume}" in the world.`);
  const { sessionId } = await runtime.restore(saved);
  return { sessionId, streamIndex: 0 };
}
