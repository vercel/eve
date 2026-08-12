import { ArrowRight, Check, CircleDot, ExternalLink, Minus, Wrench } from "lucide-react";
import type { JSX } from "react";
import {
  COMPARISON_ROWS,
  FRAMEWORKS,
  SUPPORT_LABELS,
  type ComparisonCell,
  type SupportLevel,
} from "./data";

const LEVEL_STYLES: Readonly<Record<SupportLevel, string>> = {
  native: "border-green-500/30 bg-green-100 text-green-900",
  integrated: "border-blue-500/30 bg-blue-100 text-blue-900",
  assemble: "border-amber-500/30 bg-amber-100 text-amber-900",
  outside: "border-gray-alpha-400 bg-background-200 text-gray-900",
};

function LevelIcon({ level }: { level: SupportLevel }): JSX.Element {
  if (level === "native") return <Check aria-hidden size={12} strokeWidth={2.5} />;
  if (level === "integrated") return <CircleDot aria-hidden size={12} />;
  if (level === "assemble") return <Wrench aria-hidden size={12} />;
  return <Minus aria-hidden size={12} />;
}

function Status({ level }: { level: SupportLevel }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-medium text-label-12 ${LEVEL_STYLES[level]}`}
    >
      <LevelIcon level={level} />
      {SUPPORT_LABELS[level]}
    </span>
  );
}

function MatrixCell({
  cell,
  featured = false,
  isLastColumn,
  isLastRow,
}: {
  cell: ComparisonCell;
  featured?: boolean;
  isLastColumn: boolean;
  isLastRow: boolean;
}): JSX.Element {
  return (
    <td
      className={`min-w-44 border-gray-alpha-400 align-top ${isLastColumn ? "" : "border-r"} ${isLastRow ? "" : "border-b"} ${featured ? "bg-blue-100/60" : "bg-background-100"}`}
    >
      <div className="flex flex-col items-start gap-2 px-4 py-4">
        <Status level={cell.level} />
        <a
          className="group inline-flex items-start gap-1 font-medium text-copy-13 text-gray-1000 no-underline hover:text-blue-900"
          href={cell.href}
        >
          {cell.title}
          <ExternalLink
            aria-hidden
            className="mt-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            size={11}
          />
        </a>
        <p className="m-0! text-copy-13 leading-5 text-gray-900">{cell.detail}</p>
      </div>
    </td>
  );
}

/** Evidence-linked feature matrix for the six primary frameworks in the comparison. */
export function ComparisonMatrix(): JSX.Element {
  return (
    <figure className="not-prose my-8 w-full sm:-mx-4 sm:w-[calc(100%+2rem)]">
      <div className="mb-4 flex flex-wrap items-center gap-2 text-copy-13 text-gray-900">
        {(Object.keys(SUPPORT_LABELS) as SupportLevel[]).map((level) => (
          <Status key={level} level={level} />
        ))}
        <span className="sm:ml-1">describes integration depth, not theoretical possibility</span>
        <span className="ml-auto inline-flex items-center gap-1 whitespace-nowrap font-medium text-gray-1000">
          Scroll to compare <ArrowRight aria-hidden size={13} />
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-gray-alpha-400 bg-background-100 shadow-sm">
        <table className="w-full min-w-[1160px] border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 w-56 border-gray-alpha-400 border-r border-b bg-background-200 px-4 py-4 align-bottom shadow-[1px_0_0_var(--ds-gray-alpha-400)]">
                <div className="font-mono uppercase tracking-[0.1em] text-label-12 text-gray-700">
                  Production concern
                </div>
              </th>
              {FRAMEWORKS.map((framework, frameworkIndex) => (
                <th
                  key={framework.id}
                  className={`min-w-44 border-gray-alpha-400 border-b px-4 py-4 align-bottom ${frameworkIndex < FRAMEWORKS.length - 1 ? "border-r" : ""} ${framework.id === "eve" ? "bg-blue-200" : "bg-background-200"}`}
                  scope="col"
                >
                  <div className="font-medium text-copy-14 text-gray-1000">{framework.name}</div>
                  <div className="mt-1 font-normal text-copy-12 text-gray-700">
                    {framework.category}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARISON_ROWS.map((row, rowIndex) => (
              <tr key={row.feature}>
                <th
                  className={`sticky left-0 z-10 w-56 border-gray-alpha-400 border-r bg-background-200 px-4 py-4 align-top shadow-[1px_0_0_var(--ds-gray-alpha-400)] ${rowIndex < COMPARISON_ROWS.length - 1 ? "border-b" : ""}`}
                  scope="row"
                >
                  <div className="font-medium text-copy-13 text-gray-1000">{row.feature}</div>
                  <div className="mt-1 font-normal text-copy-12 leading-5 text-gray-700">
                    {row.question}
                  </div>
                </th>
                {FRAMEWORKS.map((framework, frameworkIndex) => (
                  <MatrixCell
                    key={framework.id}
                    cell={row.cells[framework.id]}
                    featured={framework.id === "eve"}
                    isLastColumn={frameworkIndex === FRAMEWORKS.length - 1}
                    isLastRow={rowIndex === COMPARISON_ROWS.length - 1}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="mt-3 text-copy-12 text-gray-700">
        Assessment of documented, public surfaces as of July 31, 2026. Every cell links to the
        supporting framework documentation. Products change quickly; verify critical requirements
        against the linked contract.
      </figcaption>
    </figure>
  );
}
