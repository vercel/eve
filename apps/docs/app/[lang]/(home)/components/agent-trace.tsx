import type { CSSProperties, JSX } from "react";
import { cn } from "@/lib/utils";
import { GradientBorder } from "./gradient-border";

type SpanKind = "event" | "model" | "tool" | "approval";

interface Span {
  name: string;
  /** Authored file that handles the span, when one does. */
  file?: string;
  detail: string;
  kind: SpanKind;
  /** Timeline positions in percent. Point events have no `end`. */
  start: number;
  end?: number;
}

/** Where the session waits on Bob, in timeline percent. */
const PARKED = { start: 38, end: 63 };

const SPANS: Span[] = [
  {
    name: "message",
    file: "channels/slack.ts",
    detail: "Alice asks for a refund",
    kind: "event",
    start: 1,
  },
  { name: "model", detail: "Looks up the order", kind: "model", start: 3, end: 13 },
  {
    name: "get_order",
    file: "tools/get_order.ts",
    detail: "Order #4821, $129.00",
    kind: "tool",
    start: 13,
    end: 22,
  },
  { name: "model", detail: "Decides to refund", kind: "model", start: 22, end: 34 },
  {
    name: "refund_charge",
    file: "tools/refund_charge.ts",
    detail: "Needs a billing lead's approval",
    kind: "tool",
    start: 34,
    end: 72,
  },
  {
    name: "approval",
    file: "channels/slack.ts",
    detail: "Bob, a billing lead, approves",
    kind: "approval",
    start: PARKED.end,
  },
  { name: "model", detail: "Confirms the refund", kind: "model", start: 72, end: 92 },
  {
    name: "reply",
    file: "channels/slack.ts",
    detail: "Replies in the same thread",
    kind: "event",
    start: 96,
  },
];

/** Every span boundary is a runtime event that hooks receive. */
const HOOK_EVENTS = [
  ...new Set(SPANS.flatMap((span) => [span.start, span.end ?? span.start]).concat(PARKED.start)),
];

const AXIS = { start: "09:14:02", parked: "09:14:06", resumed: "11:55:31", end: "11:55:35" };

const BAR: Record<SpanKind, string> = {
  event: "bg-gray-1000",
  model: "bg-blue-700",
  tool: "bg-gray-900",
  approval: "bg-amber-700",
};

const HATCH: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, color-mix(in srgb, var(--ds-amber-700) 28%, transparent) 0 1px, transparent 1px 8px)",
};

const NOTES = [
  {
    title: "Channels",
    body: "The Slack channel maps the thread to a durable session and renders the approval card. Add a channel file and the same agent answers in Teams, Discord, or GitHub. The HTTP API for web apps is on by default.",
  },
  {
    title: "Durable sessions",
    body: "Every step is a checkpoint. If the process crashes or a deploy lands mid-turn, the run picks up from the last completed step instead of starting over.",
  },
  {
    title: "Human in the loop",
    body: "The tool's approval policy parks the turn and decides who may answer. A parked session holds no compute, whether the answer arrives in a minute or next week.",
  },
  {
    title: "Hooks and traces",
    body: "Each event reaches your hooks after eve records it, so you can write an audit log or page someone. The same run exports to OpenTelemetry.",
  },
];

const pct = (value: number) => `${value}%`;

function Bar({ span }: { span: Span }): JSX.Element {
  if (span.end === undefined) {
    return (
      <span
        aria-hidden
        className={cn(
          "absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] ring-4 ring-background-100",
          BAR[span.kind],
        )}
        style={{ left: pct(span.start) }}
      />
    );
  }

  const waits = span.start < PARKED.start && span.end > PARKED.end;
  if (!waits) {
    return (
      <span
        aria-hidden
        className={cn("absolute top-1/2 h-2 -translate-y-1/2 rounded-full", BAR[span.kind])}
        style={{ left: pct(span.start), width: pct(span.end - span.start) }}
      />
    );
  }

  // A span that waits draws as: requested, parked, then executed.
  return (
    <>
      <span
        aria-hidden
        className={cn("absolute top-1/2 h-2 -translate-y-1/2 rounded-l-full", BAR[span.kind])}
        style={{ left: pct(span.start), width: pct(PARKED.start - span.start) }}
      />
      <span
        aria-hidden
        className="absolute top-1/2 h-2 -translate-y-1/2 border-y border-dashed border-amber-700"
        style={{ left: pct(PARKED.start), width: pct(PARKED.end - PARKED.start) }}
      />
      <span
        aria-hidden
        className={cn("absolute top-1/2 h-2 -translate-y-1/2 rounded-r-full", BAR[span.kind])}
        style={{ left: pct(PARKED.end), width: pct(span.end - PARKED.end) }}
      />
    </>
  );
}

function Label({ name, file, detail }: { name: string; file?: string; detail: string }) {
  return (
    <div className="flex min-w-0 flex-col justify-center py-2 pr-3 sm:pr-6">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-mono text-gray-1000 text-label-13-mono">{name}</span>
        {file ? (
          <span className="hidden truncate font-mono text-gray-900 text-label-12-mono lg:inline">
            {file}
          </span>
        ) : null}
      </div>
      <span className="text-gray-900 text-copy-13 sm:truncate">{detail}</span>
    </div>
  );
}

export function AgentTrace(): JSX.Element {
  const parkedLeft = `calc(var(--trace-label) + (100% - var(--trace-label)) * ${PARKED.start / 100})`;
  const parkedWidth = `calc((100% - var(--trace-label)) * ${(PARKED.end - PARKED.start) / 100})`;

  return (
    <section className="px-4 py-24">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-heading-32 text-gray-1000 text-balance sm:text-heading-40">
          Everything around the loop
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900 text-balance">
          A production agent waits on people, survives restarts, and replies wherever your users
          are. This is one refund request, start to finish, as eve runs it.
        </p>

        <figure aria-describedby="agent-trace-summary" className="relative mt-12 rounded-xl p-px">
          <GradientBorder />
          <p className="sr-only" id="agent-trace-summary">
            Alice asks the support agent for a refund in Slack. The agent looks up the order and
            calls refund_charge, which requires a billing lead's approval. The session parks for two
            hours and forty-one minutes without using compute. Bob, a billing lead, approves in the
            thread, the refund runs, and the agent replies in the same thread. A hook receives every
            event along the way.
          </p>
          <div className="overflow-hidden rounded-xl material-small">
            <div className="flex h-12 items-center gap-3 border-b px-4">
              <span className="truncate font-mono text-gray-1000 text-label-13-mono">
                session · slack #support
              </span>
              <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-gray-1000 text-label-12">
                <span aria-hidden className="size-1.5 rounded-full bg-green-700" />
                <span className="hidden sm:inline">Turn completed in</span> 2h 41m
              </span>
            </div>

            <div
              aria-hidden
              className="px-4 pt-3 pb-4 [--trace-label:9rem] sm:[--trace-label:13rem] lg:[--trace-label:20rem]"
            >
              <div className="relative">
                {/* One band marks the parked interval across every row. */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 border-x border-dashed border-amber-700/50"
                  style={{ left: parkedLeft, width: parkedWidth, ...HATCH }}
                />

                <div className="relative grid grid-cols-[var(--trace-label)_minmax(0,1fr)]">
                  <div aria-hidden />
                  <div className="relative h-7 font-mono text-gray-900 text-label-12-mono">
                    <span className="absolute top-1 left-0">{AXIS.start}</span>
                    <span
                      className="absolute top-1 hidden -translate-x-full pr-2 sm:inline"
                      style={{ left: pct(PARKED.start) }}
                    >
                      {AXIS.parked}
                    </span>
                    <span
                      className="absolute top-1 hidden justify-center text-amber-900 sm:flex"
                      style={{ left: pct(PARKED.start), width: pct(PARKED.end - PARKED.start) }}
                    >
                      parked 2h 41m
                    </span>
                    <span
                      className="absolute top-1 hidden pl-2 sm:inline"
                      style={{ left: pct(PARKED.end) }}
                    >
                      {AXIS.resumed}
                    </span>
                    <span className="absolute top-1 right-0">{AXIS.end}</span>
                  </div>

                  {SPANS.map((span, index) => (
                    <div className="contents" key={`${span.name}-${index}`}>
                      <Label detail={span.detail} file={span.file} name={span.name} />
                      <div className="relative">
                        <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-gray-200" />
                        <Bar span={span} />
                      </div>
                    </div>
                  ))}

                  <div className="col-span-2 my-2 h-px bg-gray-200" />

                  <Label detail="Receives every event" file="hooks/audit.ts" name="hooks" />
                  <div className="relative">
                    {HOOK_EVENTS.map((at) => (
                      <span
                        aria-hidden
                        className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gray-700"
                        key={at}
                        style={{ left: pct(at) }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-3 text-gray-900 text-label-12">
                <Legend swatch="h-2 w-4 rounded-full bg-blue-700">Model step</Legend>
                <Legend swatch="h-2 w-4 rounded-full bg-gray-900">Tool call</Legend>
                <Legend swatch="size-2 rotate-45 rounded-[1px] bg-gray-1000">Channel event</Legend>
                <Legend swatch="size-2 rotate-45 rounded-[1px] bg-amber-700">Approval</Legend>
                <Legend hatch swatch="h-3 w-4 border border-dashed border-amber-700/50">
                  Parked, no compute
                </Legend>
              </div>
            </div>
          </div>
        </figure>

        <dl className="mt-12 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
          {NOTES.map((note) => (
            <div className="flex flex-col gap-2" key={note.title}>
              <dt className="text-gray-1000 text-heading-16">{note.title}</dt>
              <dd className="text-gray-900 text-copy-14">{note.body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Legend({
  swatch,
  hatch = false,
  children,
}: {
  swatch: string;
  hatch?: boolean;
  children: string;
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden
        className={cn("inline-block shrink-0", swatch)}
        style={hatch ? HATCH : undefined}
      />
      {children}
    </span>
  );
}
