# eve step by step

Small demos of one agent, each in its own folder: a script and a terminal UI. They share no code,
and the agent is defined the same way in both:

```ts
const chat = defineAgent({
  name: "chat",
  model: "anthropic/claude-haiku-4.5",
  instructions: "You are a friendly assistant with a shell. Keep answers short.",
  definitions: eve.defaults({ sandbox: memorySandbox() }),
});
```

`eve.defaults()` gives the agent eve's default tools: a shell (`bash`), `read_file` and `write_file`,
web fetch and search, and `agent`, which hands a task to a copy of itself. `memorySandbox()` runs the shell and the file tools in memory (just-bash),
so nothing touches your disk. What changes from step to step is only what's in front of the agent.

## Requirements

- Node.js 24 or newer (it runs the `.ts` files directly).
- An AI Gateway key: `export AI_GATEWAY_API_KEY=...` ([vercel.com/ai-gateway](https://vercel.com/ai-gateway)).

Each folder installs on its own from the eve package in this folder (`eve-*.tgz`).

## 1. A script

```sh
cd 1-script
npm install
node chat.ts "Make a file called notes.txt with three facts about octopuses, then show it to me."
```

The script sends one message, streams the reply, and shows each tool call as one line, such as
`[bash] {"command":"cat notes.txt"}`. Without a message it asks for today's date. Run it again and
`notes.txt` is gone: the sandbox lives in memory, and the session ends with the script.

## 2. A terminal UI

```sh
cd ../2-tui
npm install
node chat.ts
```

The same agent behind eve's terminal UI, the one `eve dev` shows. `runTerminal(chat, { name })` is
all it takes.

Things to try:

- Ask it to run a few shell commands and watch each call and its result in the transcript.
- `/info` shows the agent's model, tools and sandbox. `/help` lists the commands.
- Esc cancels a turn that's running. Ctrl-C twice quits.

### 2b. A coding agent that keeps its sessions

```sh
node coder.ts            # a new session, in the directory you run it from
node coder.ts -c         # continues the latest session
node coder.ts --resume <session id>
```

`coder.ts` is a coding agent for the current directory: eve's shell and file tools run on your
machine (`hostSandbox({ confine: true })` keeps file paths inside the directory), and you approve
each command and each file write. Its sessions are kept in `~/.coder` with `localWorld()`, Workflow's
local World: each step is saved as it runs, so quit (or kill the process) mid-turn and `-c` picks
the turn up again from its last step.

With `CODER_WORLD=vercel`, sessions are kept in a Vercel project's World instead (`vercelWorld()`:
the project `vercel link` linked the directory to, and your `vercel login`), so `-c` on another
machine continues the same conversation. The agent still runs on the machine you're on, and its
files are that machine's: only the session travels.
