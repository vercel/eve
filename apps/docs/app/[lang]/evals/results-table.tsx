"use client";

import { ChevronRightIcon } from "lucide-react";
import { Fragment, useState } from "react";

import type { BenchmarkRow } from "@/lib/evals/results";

export const ResultsTable = ({ rows }: { rows: BenchmarkRow[] }) => {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggle = (groupId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-400">
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <thead className="bg-gray-100 text-gray-900">
          <tr>
            <HeaderCell>Model</HeaderCell>
            <HeaderCell>Harness</HeaderCell>
            <HeaderCell align="right">Avg Duration</HeaderCell>
            <HeaderCell align="right">Avg List Cost</HeaderCell>
            <HeaderCell align="right">Success Rate</HeaderCell>
            <HeaderCell align="right">Success Rate with AGENTS.md *</HeaderCell>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isExpanded = expanded.has(row.groupId);
            return (
              <Fragment key={row.groupId}>
                <tr className="border-t border-gray-400">
                  <Cell>
                    <button
                      aria-expanded={isExpanded}
                      className="flex items-center gap-2 font-medium text-gray-1000"
                      onClick={() => toggle(row.groupId)}
                      type="button"
                    >
                      <span className="flex size-6 items-center justify-center rounded-md border border-gray-500">
                        <ChevronRightIcon
                          aria-hidden="true"
                          className={`size-3.5 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                        />
                      </span>
                      {row.modelDisplayName}
                    </button>
                  </Cell>
                  <Cell>{row.harness}</Cell>
                  <Cell align="right">{formatDuration(row.averageDurationMs)}</Cell>
                  <Cell align="right">{formatCost(row.averageEstimatedListCostUsd)}</Cell>
                  <Cell align="right">{formatRate(row.baselineSuccessRate)}</Cell>
                  <Cell align="right">{formatRate(row.guidedSuccessRate)}</Cell>
                </tr>
                {isExpanded ? (
                  <tr className="border-t border-gray-400">
                    <td className="p-4" colSpan={6}>
                      <div className="overflow-hidden rounded-lg border border-gray-400">
                        <table className="w-full border-collapse text-left">
                          <thead className="bg-gray-100 text-gray-800">
                            <tr>
                              <HeaderCell>Evaluation</HeaderCell>
                              <HeaderCell align="right">Avg Duration</HeaderCell>
                              <HeaderCell align="right">Success Rate</HeaderCell>
                              <HeaderCell align="right">Success Rate with AGENTS.md</HeaderCell>
                            </tr>
                          </thead>
                          <tbody>
                            {row.cases.map((benchmarkCase) => (
                              <tr className="border-t border-gray-400" key={benchmarkCase.caseId}>
                                <Cell>{benchmarkCase.caseId}</Cell>
                                <Cell align="right">
                                  {formatDuration(benchmarkCase.averageDurationMs)}
                                </Cell>
                                <Cell align="right">
                                  {formatRate(benchmarkCase.baselineSuccessRate)}
                                </Cell>
                                <Cell align="right">
                                  {formatRate(benchmarkCase.guidedSuccessRate)}
                                </Cell>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const HeaderCell = ({
  align = "left",
  children,
}: {
  align?: "left" | "right";
  children: React.ReactNode;
}) => (
  <th
    className={`whitespace-nowrap px-4 py-3 font-medium ${align === "right" ? "text-right" : "text-left"}`}
    scope="col"
  >
    {children}
  </th>
);

const Cell = ({
  align = "left",
  children,
}: {
  align?: "left" | "right";
  children: React.ReactNode;
}) => (
  <td className={`whitespace-nowrap px-4 py-4 ${align === "right" ? "text-right" : "text-left"}`}>
    {children}
  </td>
);

const NotAvailable = () => <span className="text-gray-700">N/A</span>;

function formatDuration(value: number | null): React.ReactNode {
  if (value === null) return <NotAvailable />;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatCost(value: number | null): React.ReactNode {
  if (value === null) return <NotAvailable />;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatRate(value: number | null): React.ReactNode {
  if (value === null) return <NotAvailable />;
  return `${Math.round(value)}%`;
}
