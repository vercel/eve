/** Which kind of loop a turn is in. */
export type LoopPattern = "repeated-result" | "alternating-calls" | "repeated-call";

/** One settled call, reduced to what the checks compare. */
export interface CallRecord {
  readonly name: string;
  /** Fingerprint of the tool name and its canonical input. */
  readonly call: string;
  /** Fingerprint of the call's outcome and its canonical output or error. */
  readonly result: string;
}

/** A loop found in the turn's recent calls. */
export interface DetectedLoop {
  readonly pattern: LoopPattern;
  /** The tools involved: one, or two for `alternating-calls`. */
  readonly toolNames: readonly string[];
  /** Calls for `repeated-call` and `repeated-result`, A-B cycles for `alternating-calls`. */
  readonly count: number;
  /** What happened, in one sentence. */
  readonly summary: string;
}

export interface LoopLimits {
  /** How many of the turn's most recent calls the checks look at. */
  readonly window: number;
  /** The same call made this many times within `window`. `false` turns the check off. */
  readonly repeatedCall: number | false;
  /** The same call returning the same result this many times in a row. */
  readonly repeatedResult: number | false;
  /** Two different calls made in turn, A-B-A-B, for this many cycles. */
  readonly alternatingCalls: number | false;
  /** Loops a turn is nudged about before the next one stops it. */
  readonly maxNudges: number;
}

/** What the extension keeps for the running turn. */
export interface LoopState {
  readonly turnId: string;
  /** The turn's most recent calls, oldest first, at most `window` of them. */
  readonly records: readonly CallRecord[];
  readonly nudges: number;
  /** The latest nudge, shown to the model for the rest of the turn. */
  readonly nudge?: string;
}

export type Observation =
  | { readonly action: "none"; readonly state: LoopState }
  | { readonly action: "nudge" | "stop"; readonly state: LoopState; readonly loop: DetectedLoop };

/**
 * Records a settled call and checks the turn for a loop. A loop's calls are then forgotten, so
 * the same loop has to build up again before it counts a second time.
 */
export function observe(state: LoopState, record: CallRecord, limits: LoopLimits): Observation {
  const records = [...state.records, record].slice(-limits.window);
  const loop = detect(records, limits);
  if (loop === undefined) return { action: "none", state: { ...state, records } };
  if (state.nudges >= limits.maxNudges) {
    return { action: "stop", loop, state: { ...state, records: [] } };
  }
  return {
    action: "nudge",
    loop,
    state: { ...state, nudge: nudgeFor(loop), nudges: state.nudges + 1, records: [] },
  };
}

/** The first loop the newest call completes, checked in the order the patterns are declared. */
export function detect(
  records: readonly CallRecord[],
  limits: Omit<LoopLimits, "maxNudges">,
): DetectedLoop | undefined {
  const recent = records.slice(-limits.window);
  const last = recent.at(-1);
  if (last === undefined) return undefined;
  const name = label(last.name);

  if (limits.repeatedResult !== false) {
    let count = 0;
    for (const record of recent.toReversed()) {
      if (record.call !== last.call) continue;
      if (record.result !== last.result) break;
      count++;
    }
    if (count >= limits.repeatedResult) {
      return {
        count,
        pattern: "repeated-result",
        summary: `The last ${count} calls to ${name} used the same input and returned the same result.`,
        toolNames: [last.name],
      };
    }
  }

  if (limits.alternatingCalls !== false) {
    const previous = recent.at(-2);
    if (previous !== undefined && previous.call !== last.call) {
      let cycles = 0;
      while (
        recent.at(-2 * cycles - 1)?.call === last.call &&
        recent.at(-2 * cycles - 2)?.call === previous.call
      ) {
        cycles++;
      }
      if (cycles >= limits.alternatingCalls) {
        return {
          count: cycles,
          pattern: "alternating-calls",
          summary: `The last ${cycles * 2} calls alternated between ${label(previous.name)} and ${name} with the same inputs.`,
          toolNames: [previous.name, last.name],
        };
      }
    }
  }

  if (limits.repeatedCall !== false) {
    const count = recent.filter((record) => record.call === last.call).length;
    if (count >= limits.repeatedCall) {
      return {
        count,
        pattern: "repeated-call",
        summary: `${count} of the last ${recent.length} calls were to ${name} with the same input.`,
        toolNames: [last.name],
      };
    }
  }

  return undefined;
}

export function nudgeFor(loop: DetectedLoop): string {
  return `${loop.summary} Repeating it will not change the outcome. Change your approach, or explain what is blocking you.`;
}

/** A tool name the model reads as a name, never as an instruction. */
function label(name: string): string {
  return `\`${name.replaceAll(/[^\w-]/gu, "_")}\``;
}

/**
 * A short, stable fingerprint of a JSON value: object keys are sorted, so key order never makes
 * two calls look different.
 */
export function fingerprint(value: unknown): string {
  return hash(canonical(value));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 53-bit cyrb53, enough to tell apart the few calls a window holds. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
