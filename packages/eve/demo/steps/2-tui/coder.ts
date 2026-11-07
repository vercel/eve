// Step 2b: a coding agent for the directory you start it in, in eve's terminal UI, with its
// sessions kept on disk. `node coder.ts` starts a session, `node coder.ts -c` continues the latest,
// and `node coder.ts --resume <id>` a given one, including a turn a crash or Ctrl-C cut off.
import { homedir } from "node:os";
import { join } from "node:path";

import {
  defineAgent,
  eve,
  hostSandbox,
  listSessions,
  localWorld,
  vercelWorld,
} from "eve/experimental/embed";
import { runTerminal } from "eve/experimental/embed/terminal";
import { always } from "eve/tools/approval";

const coder = defineAgent({
  name: "coder",
  model: "anthropic/claude-sonnet-4.5",
  instructions:
    "You are a careful coding assistant working in the user's current directory. Read before you edit, keep changes small, and say what you changed.",
  definitions: eve.defaults({
    // The shell and file tools run here, on your machine, kept inside this directory.
    sandbox: hostSandbox({ confine: true }),
    // You approve each command and each file it writes.
    approval: { bash: always(), write_file: always() },
    without: ["web_search"],
  }),
});

// Sessions live in ~/.coder (Workflow's local World, as files), or with CODER_WORLD=vercel in the
// Vercel project `vercel link` linked this directory to, so `-c` continues them on any machine.
const world =
  process.env.CODER_WORLD === "vercel"
    ? vercelWorld()
    : localWorld({ dataDir: join(homedir(), ".coder") });
const args = process.argv.slice(2);
const sessions = args.includes("-c") ? await listSessions(world) : [];
const resume = args.includes("-c")
  ? sessions[0]?.id
  : args.includes("--resume")
    ? args[args.indexOf("--resume") + 1]
    : undefined;
if (args.includes("-c") && resume === undefined) console.log("No saved session yet: starting one.");
if (sessions[0]?.open === true)
  console.log(`Continuing ${sessions[0].id}: its last turn was cut off, so it goes on from there.`);

await runTerminal(coder, { name: "coder", world, ...(resume !== undefined && { resume }) });
