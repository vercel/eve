import type { JSX } from "react";
import {
  type AmbientBranch,
  ambientListeningFlow,
  ambientListeningRoot,
} from "@/lib/geistdocs/ambient-listening-flow";

function Branches({ branches }: { branches: readonly AmbientBranch[] }): JSX.Element {
  return (
    <ul className="m-0! ml-2! list-none p-0!">
      {branches.map((branch, index) => {
        const last = index === branches.length - 1;
        return (
          <li key={branch.label} className={`relative m-0! pt-3 pl-7 ${last ? "" : "pb-0"}`}>
            <span
              aria-hidden
              className={`absolute top-0 left-0 w-px bg-gray-alpha-500 ${last ? "h-[23px]" : "h-full"}`}
            />
            <span aria-hidden className="absolute top-[22px] left-0 h-px w-5 bg-gray-alpha-500" />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-copy-14 text-gray-1000">{branch.label}</span>
              {branch.where ? (
                <code className="bg-transparent! p-0! text-copy-13! text-gray-900!">
                  {branch.where}
                </code>
              ) : null}
              {branch.result ? (
                <span className="flex items-baseline gap-2">
                  <span aria-hidden className="text-copy-14 text-gray-700">
                    →
                  </span>
                  {branch.code ? (
                    <code className="bg-transparent! p-0! font-medium text-copy-13! text-gray-1000!">
                      {branch.result}
                    </code>
                  ) : (
                    <span className="font-medium text-copy-14 text-gray-1000">{branch.result}</span>
                  )}
                </span>
              ) : null}
            </div>
            {branch.children ? <Branches branches={branch.children} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Shows how an unmentioned message moves through free checks, the decision
 * model, and the agent's own judgment, as a tree of outcomes.
 */
export function AmbientListeningFlow(): JSX.Element {
  return (
    <figure
      aria-label="How an ambient agent decides whether to reply"
      className="my-8 w-full min-w-0 rounded-xl border border-gray-alpha-400 bg-background-100 p-5 sm:p-6"
    >
      <span className="font-medium text-copy-14 text-gray-1000">{ambientListeningRoot}</span>
      <Branches branches={ambientListeningFlow} />
    </figure>
  );
}
