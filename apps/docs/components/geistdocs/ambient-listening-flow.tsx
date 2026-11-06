import type { JSX } from "react";
import {
  type AmbientOutcome,
  type AmbientStage,
  ambientListeningFlow,
} from "@/lib/geistdocs/ambient-listening-flow";

function Outcome({ outcome }: { outcome: AmbientOutcome }): JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 rounded-lg px-3 py-2 material-small">
      <span className="text-copy-13 text-gray-900">{outcome.when}</span>
      {outcome.code ? (
        <code className="bg-transparent! p-0! text-copy-13! text-gray-1000!">{outcome.result}</code>
      ) : (
        <span className="text-right text-copy-14 text-gray-1000">{outcome.result}</span>
      )}
    </div>
  );
}

function Stage({ stage, next }: { stage: AmbientStage; next?: AmbientStage }): JSX.Element {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-xl border border-gray-alpha-400 bg-background-100 p-4 sm:p-5">
      <div className="flex flex-col gap-1">
        <span className="font-medium text-copy-14 text-gray-1000">{stage.title}</span>
        <code className="w-fit bg-transparent! p-0! text-copy-13! text-gray-900!">
          {stage.where}
        </code>
      </div>
      <p className="m-0! text-copy-16 text-gray-1000">{stage.question}</p>
      <div className="mt-auto flex flex-col gap-2">
        {stage.stops.map((stop) => (
          <Outcome key={stop.when} outcome={stop} />
        ))}
        {stage.passes && next ? (
          <div className="flex items-baseline justify-between gap-3 px-3 py-2 text-copy-13 text-gray-900">
            <span>{stage.passes}</span>
            <span aria-hidden>
              <span className="lg:hidden">↓</span>
              <span className="hidden lg:inline">→</span>
            </span>
            <span className="sr-only">continues to {next.title}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Shows how an unmentioned message moves through free checks, the decision
 * model, and the agent's own judgment.
 */
export function AmbientListeningFlow(): JSX.Element {
  return (
    <figure
      aria-label="How an ambient agent decides whether to reply"
      className="my-8 grid w-full min-w-0 items-stretch gap-4 lg:grid-cols-3"
    >
      {ambientListeningFlow.map((stage, index) => (
        <Stage key={stage.title} stage={stage} next={ambientListeningFlow[index + 1]} />
      ))}
    </figure>
  );
}
