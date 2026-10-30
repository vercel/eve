// Regenerates expected.json from durable-harness's own code, so the
// conformance test (scripts/eval-metrics/standard.test.mjs) checks our
// derivation against what /compare computes, not against a port of it.
//
// For each recorded eve stream it adds a synthetic client clock in the shape
// /compare drives eve (a prewarmed session, then the prompt, which may wait
// on `session_not_ready`, then any steer; and per-event arrival times with
// varying delivery lag), feeds the stream through durable-harness's `EveTranslator`,
// and records the marks and the /compare breakdown (`turnView` +
// `breakdown`) of the turn.
//
// Usage, from a durable-harness checkout with dependencies installed:
//   pnpm --dir <durable-harness> exec tsx \
//     scripts/eval-metrics/fixtures/durable-harness/generate.mjs <durable-harness>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(process.argv[2] ?? ".");
const load = (path) => import(pathToFileURL(join(checkout, path)).href);
const { EveTranslator } = await load("packages/bench/src/eve.ts");
const { turnView } = await load("packages/demo-ui/src/compare-model.ts");
const { breakdown } = await load("packages/demo-ui/src/compare-breakdown.ts");
const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

const STEER_DELIVERY = "47831cfb-8adc-462f-bbf6-c9f0ce02b1ac";
const fixtures = {
  "eve-tool-turn": { notReadyMs: 0 },
  "eve-steer": { notReadyMs: 150, steer: STEER_DELIVERY },
};

const expected = { source: "vercel-labs/durable-harness", commit, fixtures: {} };
for (const [name, { notReadyMs, steer }] of Object.entries(fixtures)) {
  const events = readFileSync(join(here, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const at = (event) => Date.parse(event.meta.at);
  const turnStarted = events.find((event) => event.type === "turn.started");
  const promptDelivery = turnStarted.meta.deliveryIds[0];
  // Delivery lag between 5 and 15 ms, so the offset rule (smallest lag) matters.
  const receivedAt = events.map((event, index) => at(event) + 5 + ((index * 7) % 11));
  const acceptedAttemptAt = at(turnStarted) - 40;
  const sends = [
    {
      kind: "prewarm",
      startedAt: acceptedAttemptAt - notReadyMs - 400,
      notReadyMs: 0,
      acceptedAt: acceptedAttemptAt - notReadyMs - 380,
    },
    {
      kind: "message",
      deliveryId: promptDelivery,
      startedAt: acceptedAttemptAt - notReadyMs,
      notReadyMs,
      acceptedAt: acceptedAttemptAt + 12,
    },
  ];
  if (steer !== undefined) {
    const received = events.find(
      (event) => event.type === "message.received" && event.meta.deliveryIds.includes(steer),
    );
    sends.push({
      kind: "message",
      deliveryId: steer,
      startedAt: at(received) - 30,
      notReadyMs: 0,
      acceptedAt: at(received) - 18,
    });
  }

  const translator = new EveTranslator(new Set(steer === undefined ? [] : [steer]));
  const arrivals = events.flatMap((event, index) =>
    translator.feed(event).map((out) => ({ at: receivedAt[index], e: out })),
  );
  const sentAt = sends[1].startedAt + sends[1].notReadyMs;
  const endAt = arrivals.find((arrival) => arrival.e.type === "idle").at;
  const view = turnView(sentAt, arrivals, endAt, endAt);
  const result = breakdown(view, arrivals);
  expected.fixtures[name] = {
    clock: { receivedAt, sends },
    marks: arrivals
      .filter((arrival) => arrival.e.type === "mark")
      .map(({ e }) => ({ name: e.name, key: e.key ?? null, t: e.t })),
    turn: {
      firstOutputMs: view.ttft,
      firstOutputModelMs: result.modelMs,
      firstOutputOverheadMs: result.overheadMs,
      turnMs: view.turn,
      turnModelMs: result.turnModelMs,
      turnToolMs: result.turnToolMs,
      turnOverheadMs: result.turnOverheadMs,
      tools: result.tools.map(({ execMs, oursMs, overheadMs, nextModelMs, from }) => ({
        execMs,
        oursMs,
        overheadMs,
        nextModelMs,
        from,
      })),
    },
  };
}
writeFileSync(join(here, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
console.error(`Wrote expected.json from durable-harness ${commit}.`);
