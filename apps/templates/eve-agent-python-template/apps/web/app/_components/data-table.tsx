"use client";

import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";
import { useMemo } from "react";

type TableRow = readonly string[];

const features = tableFeatures({
  rowSortingFeature,
  sortFns: { alphanumeric: sortFn_alphanumeric },
  sortedRowModel: createSortedRowModel(),
});

const columnHelper = createColumnHelper<typeof features, TableRow>();

const SORT_ICON = {
  asc: ArrowUpIcon,
  desc: ArrowDownIcon,
  none: ArrowUpDownIcon,
} as const;

const ARIA_SORT = {
  asc: "ascending",
  desc: "descending",
  none: "none",
} as const;

/**
 * A table the agent renders with `render_ui`. Clicking a column header sorts
 * by that column, cycling through ascending, descending, and unsorted.
 *
 * @param props - The component props.
 * @returns The table.
 */
export function DataTable({
  caption,
  columns,
  rows,
}: {
  /** Text shown under the table. */
  readonly caption: string | null;
  /** The column headers. */
  readonly columns: readonly string[];
  /** The rows, each with one cell per column. */
  readonly rows: readonly TableRow[];
}) {
  const tableColumns = useMemo(
    () =>
      columnHelper.columns(
        columns.map((header, index) =>
          columnHelper.accessor((row) => row[index] ?? "", {
            header,
            id: `${index}:${header}`,
            sortFn: "alphanumeric",
          })
        )
      ),
    [columns]
  );
  const data = useMemo(() => [...rows], [rows]);
  const table = useTable({ columns: tableColumns, data, features });

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40">
          {table.getHeaderGroups().map((group) => (
            <tr className="border-b" key={group.id}>
              {group.headers.map((header) => {
                const direction = header.column.getIsSorted();
                const sorted = direction === false ? "none" : direction;
                const SortIcon = SORT_ICON[sorted];
                return (
                  <th
                    aria-sort={ARIA_SORT[sorted]}
                    className="text-left font-medium"
                    key={header.id}
                  >
                    <button
                      className="hover:text-foreground text-muted-foreground flex w-full items-center gap-1.5 px-3 py-2 text-left"
                      onClick={header.column.getToggleSortingHandler()}
                      type="button"
                    >
                      <table.FlexRender header={header} />
                      <SortIcon
                        className={
                          sorted === "none"
                            ? "size-3.5 opacity-40"
                            : "text-foreground size-3.5"
                        }
                      />
                    </button>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr className="border-b last:border-b-0" key={row.id}>
              {row.getAllCells().map((cell) => (
                <td className="px-3 py-2" key={cell.id}>
                  {String(cell.getValue())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {caption === null ? null : (
        <p className="text-muted-foreground border-t px-3 py-2 text-xs">
          {caption}
        </p>
      )}
    </div>
  );
}
