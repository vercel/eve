"use client";

import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import type { BenchmarkRow } from "@/lib/evals/results";
import { ResultsTable } from "./results-table";

export const PreviouslyMeasuredResults = ({ rows }: { rows: BenchmarkRow[] }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="mt-8">
      <button
        aria-controls="retired-models-results"
        aria-expanded={expanded}
        className="flex items-center gap-2 font-medium text-gray-900 text-sm hover:text-gray-1000 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-1000"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span className="flex size-6 items-center justify-center rounded-md border border-gray-500">
          <ChevronRightIcon
            aria-hidden="true"
            className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </span>
        Retired Models
      </button>
      {expanded ? (
        <div className="mt-4" id="retired-models-results">
          <ResultsTable rows={rows} showMeasurementDate />
        </div>
      ) : null}
    </section>
  );
};
