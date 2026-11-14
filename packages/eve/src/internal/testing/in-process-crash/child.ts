// One process of the in-process crash scenario. It runs Alice's deploy agent in process, kept on
// Workflow's local World under `<dir>/world`, and dies by SIGKILL (a real `kill -9`, so nothing gets
// to save) at the point `<crash>` names:
//   after-tool          once `deploy`'s result is in the stream, before the step that ran it is saved
//   mid-tool            while `deploy` runs, after it recorded its run
//   awaiting-approval   once the turn waiting on `deploy`'s approval is saved
// `resume` continues the session the World holds, approves what it waits on, and follows it until
// its turn settles; `<dir>/<command>.events.jsonl` gets the whole stream once its steps are done.
//   child.ts <dir> start <crash>   |   child.ts <dir> resume <crash>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { asRuntimeWorld } from "#execution/world/world-fit.js";
import { faultyWorld } from "#internal/testing/world-faults.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import {
  emptySessionView,
  foldEvents,
  openInteractions,
} from "#protocol/session-projection/public-view.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ALICE_ASKS, crashAgent } from "./agent.js";

const [dir = ".", command = "start", crash = "after-tool"] = process.argv.slice(2);
const die = (): never => {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
};

/** The entries a session's save writes: its whole state, or a change from the one before. */
const SAVES = new Set(["eve.state", "eve.delta"]);

/** The World, with the process killing itself where `crash` says. */
function crashing(world: RuntimeWorld): RuntimeWorld {
  let saves = 0;
  let toolSettled = false;
  return faultyWorld(world, {
    after(write) {
      if (write.kind === "line" && write.line.includes('"call.settled"')) toolSettled = true;
      if (write.kind === "entry" && SAVES.has(write.entry)) {
        // A whole state, or a change whose `state` is the rest of it.
        const saved = write.value as { readonly state?: unknown };
        const state = (write.entry === "eve.delta" ? saved.state : saved) as {
          readonly sessionId: string;
          readonly open?: { at: string };
        };
        if (saves === 1) writeFileSync(join(dir, "session"), state.sessionId);
        if (crash === "awaiting-approval" && state.open?.at === "pause") die();
      }
    },
    before(write) {
      if (write.kind !== "entry" || !SAVES.has(write.entry)) return;
      saves += 1;
      if (crash === "after-tool" && toolSettled) die();
    },
  });
}

async function recorded(runtime: Runtime, sessionId: string): Promise<SessionStreamEvent[]> {
  const reader = (await runtime.getEventStream(sessionId, { follow: false })).getReader();
  const events: SessionStreamEvent[] = [];
  for (let next = await reader.read(); !next.done; next = await reader.read())
    events.push(next.value);
  return events;
}

const kept = asRuntimeWorld(createWorld({ dataDir: join(dir, "world"), recoverActiveRuns: false }));
const world = command === "start" ? crashing(kept) : kept;
const harness = await createTestRuntime(
  crashAgent(dir, {
    approval: crash === "awaiting-approval",
    ...(command === "start" && crash === "mid-tool" && { deploying: die }),
  }),
);
await harness.run(async () => {
  const runtime = createInProcessRuntime(
    { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
    { world },
  );
  const alice = createChannelAddress({
    adapter: { kind: "http" },
    channelName: "http",
    continuationToken: "alice",
    runtime,
  });
  let sessionId: string;
  if (command === "start") {
    sessionId = (await alice.send(ALICE_ASKS, { auth: null })).sessionId;
  } else {
    sessionId = readFileSync(join(dir, "session"), "utf8");
    const saved = await runtime.load(sessionId);
    if (saved === undefined) throw new Error(`No session "${sessionId}" is stored.`);
    await runtime.restore(saved);
    const waiting = openInteractions(
      foldEvents(emptySessionView(), await recorded(runtime, sessionId)),
    );
    if (waiting.length > 0)
      await alice.deliver(
        {
          answers: waiting.map(({ interactionId }) => ({ interactionId, optionId: "approve" })),
        },
        { auth: null },
      );
  }
  const reader = (await runtime.getEventStream(sessionId)).getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read())
    if (next.value.type === "turn.settled") break;
  await reader.cancel();
  await runtime.idle(sessionId);
  const events = (await recorded(runtime, sessionId)).map(({ data, type }) =>
    JSON.stringify({ data, type }),
  );
  writeFileSync(join(dir, `${command}.events.jsonl`), `${events.join("\n")}\n`);
  await runtime.dispose();
});
