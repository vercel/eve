import { IconArrowDown } from "@vercel/geistdocs/assets/icons";
import type { JSX } from "react";
import { ambientListeningFlow } from "@/lib/geistdocs/ambient-listening-flow";

function StageHeader({
  number,
  label,
  where,
}: {
  number: number;
  label: string;
  where: string;
}): JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full border border-gray-alpha-500 font-mono text-copy-13 text-gray-900"
      >
        {number}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium text-copy-14 text-gray-1000">{label}</span>
        <code className="font-mono text-copy-13 text-gray-900">{where}</code>
      </div>
    </div>
  );
}

export function AmbientListeningFlow(): JSX.Element {
  const { root, checks, agent } = ambientListeningFlow;
  return (
    <figure
      aria-label="How an ambient agent decides whether to reply"
      className="not-prose my-8 w-full min-w-0 rounded-xl border border-gray-alpha-400 bg-background-200 p-4 sm:p-6"
    >
      <figcaption className="mb-5 text-center font-medium text-copy-14 text-gray-1000">
        {root}
      </figcaption>
      <ol className="m-0 list-none p-0">
        {checks.map((check, index) => (
          <li key={check.where}>
            <div className="grid grid-cols-[minmax(0,1fr)_24px_minmax(0,0.65fr)] items-center gap-1 sm:gap-2">
              <div className="min-w-0 rounded-lg border border-gray-alpha-500 bg-background-100 p-3 sm:p-4">
                <StageHeader number={index + 1} label={check.label} where={check.where} />
                <div className="mt-3 text-copy-13 text-gray-900">{check.question}</div>
              </div>
              <span aria-hidden className="flex justify-center text-gray-700">
                <IconArrowDown size={16} className="-rotate-90" />
              </span>
              <div className="min-w-0 rounded-lg border border-dashed border-gray-alpha-500 p-3 sm:p-4">
                <div className="text-copy-13 text-gray-900">{check.stop.when}</div>
                <div className="mt-1 font-medium text-copy-14 text-gray-1000">
                  {check.stop.result}
                </div>
                <div className="mt-1 text-copy-13 text-gray-900">{check.stop.detail}</div>
              </div>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_24px_minmax(0,0.65fr)] gap-1 sm:gap-2">
              <div className="flex flex-col items-center gap-1 py-2.5 text-center text-copy-13 text-gray-900">
                <span>{check.proceed}</span>
                <IconArrowDown aria-hidden size={16} className="text-gray-700" />
              </div>
            </div>
          </li>
        ))}
        <li className="rounded-lg border border-gray-alpha-500 bg-background-100 p-3 sm:p-4">
          <StageHeader number={checks.length + 1} label={agent.label} where={agent.where} />
          <div className="mt-3 text-copy-13 text-gray-900">{agent.context}</div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-gray-alpha-400 pt-4">
            {agent.outcomes.map((outcome) => (
              <div key={outcome.result} className="min-w-0">
                <div className="text-copy-13 text-gray-900">{outcome.when}</div>
                <div className="mt-1 font-medium text-copy-14 text-gray-1000">
                  {outcome.code ? (
                    <code className="font-mono text-copy-13">{outcome.result}</code>
                  ) : (
                    outcome.result
                  )}
                </div>
                <div className="mt-1 text-copy-13 text-gray-900">{outcome.detail}</div>
              </div>
            ))}
          </div>
        </li>
      </ol>
    </figure>
  );
}
