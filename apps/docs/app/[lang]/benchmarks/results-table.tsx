"use client";

import { ChevronRightIcon } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import type { BenchmarkRow } from "@/lib/evals/results";

type SortKey =
  | "modelDisplayName"
  | "harness"
  | "averageDurationMs"
  | "averageEstimatedListCostUsd"
  | "baselineSuccessRate"
  | "guidedSuccessRate";

type SortDirection = "ascending" | "descending";

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

export const ResultsTable = ({
  rows,
  showMeasurementDate = false,
}: {
  rows: BenchmarkRow[];
  showMeasurementDate?: boolean;
}) => {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<SortState>({
    key: "guidedSuccessRate",
    direction: "descending",
  });
  const sortedRows = useMemo(
    () => [...rows].sort((left, right) => compareRows(left, right, sort)),
    [rows, sort],
  );

  const toggleExpanded = (groupId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const toggleSort = (key: SortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "ascending" ? "descending" : "ascending",
          }
        : {
            key,
            direction: key === "modelDisplayName" || key === "harness" ? "ascending" : "descending",
          },
    );
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-400">
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <thead className="bg-gray-100 text-gray-900">
          <tr>
            <HeaderCell
              onSort={() => toggleSort("modelDisplayName")}
              sortDirection={sort.key === "modelDisplayName" ? sort.direction : undefined}
            >
              Model
            </HeaderCell>
            <HeaderCell
              onSort={() => toggleSort("harness")}
              sortDirection={sort.key === "harness" ? sort.direction : undefined}
            >
              Harness
            </HeaderCell>
            <HeaderCell
              align="right"
              onSort={() => toggleSort("averageDurationMs")}
              sortDirection={sort.key === "averageDurationMs" ? sort.direction : undefined}
            >
              Avg Duration
            </HeaderCell>
            <HeaderCell
              align="right"
              onSort={() => toggleSort("averageEstimatedListCostUsd")}
              sortDirection={
                sort.key === "averageEstimatedListCostUsd" ? sort.direction : undefined
              }
            >
              Avg List Cost
            </HeaderCell>
            <HeaderCell
              align="right"
              onSort={() => toggleSort("baselineSuccessRate")}
              sortDirection={sort.key === "baselineSuccessRate" ? sort.direction : undefined}
            >
              Success Rate
            </HeaderCell>
            <HeaderCell
              align="right"
              onSort={() => toggleSort("guidedSuccessRate")}
              sortDirection={sort.key === "guidedSuccessRate" ? sort.direction : undefined}
            >
              Success Rate with AGENTS.md
            </HeaderCell>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const isExpanded = expanded.has(row.groupId);
            return (
              <Fragment key={row.groupId}>
                <tr className="border-t border-gray-400">
                  <Cell>
                    <button
                      aria-expanded={isExpanded}
                      className="flex items-center gap-2 font-medium text-gray-1000"
                      onClick={() => toggleExpanded(row.groupId)}
                      type="button"
                    >
                      <span className="flex size-6 items-center justify-center rounded-md border border-gray-500">
                        <ChevronRightIcon
                          aria-hidden="true"
                          className={`size-3.5 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                        />
                      </span>
                      {row.modelDisplayName}
                      {showMeasurementDate && row.latestMeasuredAt !== null ? (
                        <span className="font-normal text-gray-700 text-sm">
                          {formatDate(row.latestMeasuredAt)}
                        </span>
                      ) : null}
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
                              <HeaderCell align="right">Avg Tokens</HeaderCell>
                              <HeaderCell align="right">Avg Tool Calls</HeaderCell>
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
                                  {formatWholeNumber(benchmarkCase.averageTokenConsumption)}
                                </Cell>
                                <Cell align="right">
                                  {formatWholeNumber(benchmarkCase.averageToolInvocationCount)}
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
  onSort,
  sortDirection,
}: {
  align?: "left" | "right";
  children: React.ReactNode;
  onSort?: () => void;
  sortDirection?: SortDirection;
}) => (
  <th
    aria-sort={onSort ? (sortDirection ?? "none") : undefined}
    className={`whitespace-nowrap px-4 py-3 font-medium ${align === "right" ? "text-right" : "text-left"}`}
    scope="col"
  >
    {onSort ? (
      <button
        className={`flex w-full items-center gap-1.5 hover:text-gray-1000 ${align === "right" ? "justify-end" : "justify-start"}`}
        onClick={onSort}
        type="button"
      >
        {children}
      </button>
    ) : (
      children
    )}
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

function compareRows(left: BenchmarkRow, right: BenchmarkRow, sort: SortState): number {
  const comparison =
    sort.key === "modelDisplayName" || sort.key === "harness"
      ? compareText(left[sort.key], right[sort.key], sort.direction)
      : compareNullableNumbers(left[sort.key], right[sort.key], sort.direction);

  return (
    comparison ||
    left.modelDisplayName.localeCompare(right.modelDisplayName) ||
    left.groupId.localeCompare(right.groupId)
  );
}

function compareText(left: string, right: string, direction: SortDirection): number {
  const comparison = left.localeCompare(right);
  return direction === "ascending" ? comparison : -comparison;
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  direction: SortDirection,
): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return direction === "ascending" ? left - right : right - left;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

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

function formatWholeNumber(value: number | null): React.ReactNode {
  if (value === null) return <NotAvailable />;
  return Math.round(value).toLocaleString("en-US");
}
