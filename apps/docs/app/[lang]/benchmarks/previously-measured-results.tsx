"use client";

import { useState } from "react";

import type { BenchmarkRow } from "@/lib/evals/results";
import { ResultsTable } from "./results-table";

export const PreviouslyMeasuredResults = ({ rows }: { rows: BenchmarkRow[] }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="mt-10" aria-labelledby="previously-measured">
      <button
        aria-expanded={expanded}
        className="text-gray-700 text-sm hover:text-gray-1000"
        id="previously-measured"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        Retired Models [{expanded ? "−" : "+"}]
      </button>
      {expanded ? (
        <div className="mt-4">
          <ResultsTable rows={rows} showMeasurementDate />
        </div>
      ) : null}
    </section>
  );
};
