import {
  eveCodeBenchmark,
  rankedHarnesses,
  type EveCodeHarnessScore,
} from "@/lib/evals/eve-code-results";

const percent = (value: number) => `${Math.round(value * 100)}%`;
const seconds = (ms: number) =>
  ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;
const dollars = (value: number | null) => (value === null ? "—" : `$${value.toFixed(2)}`);
const date = (value: string | null) =>
  value === null
    ? "—"
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
        new Date(value),
      );

/** Renders the latest published eve-code results for one eve-bench dataset. */
export const EveCodeBenchmark = ({ dataset }: { dataset: string }) => {
  const results = eveCodeBenchmark.datasets[dataset];
  if (!results) return <p>No published {dataset} results yet.</p>;
  const ranked = rankedHarnesses(results);
  const slowest = Math.max(...ranked.map((score) => score.latencyP50Ms));

  return (
    <figure className="not-prose my-6 overflow-hidden rounded-xl border border-gray-400 bg-background-100">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2 border-gray-400 border-b px-5 py-4">
        <span className="font-medium text-gray-1000">
          {results.tasks} tasks × {results.attempts} attempts
        </span>
        <span className="text-gray-800 text-sm">
          <code className="font-mono">{results.model.id}</code> · updated{" "}
          {date(results.generatedAt)}
        </span>
      </figcaption>

      <ol className="divide-y divide-gray-400">
        {ranked.map((score, index) => (
          <HarnessRow key={score.harness} rank={index + 1} score={score} slowest={slowest} />
        ))}
      </ol>

      <p className="border-gray-400 border-t px-5 py-3 text-gray-700 text-xs">
        Bars show resolve rate; the shaded band is the 95% interval. Overlapping bands are not a
        measured difference.
      </p>
    </figure>
  );
};

const HarnessRow = ({
  rank,
  score,
  slowest,
}: {
  rank: number;
  score: EveCodeHarnessScore;
  slowest: number;
}) => {
  const isEveCode = score.harness === "eve-code";
  const { estimate, low, high } = score.resolveRate;

  return (
    <li
      className={`grid gap-3 px-5 py-4 sm:grid-cols-[10rem_1fr_14rem] sm:items-center ${isEveCode ? "bg-gray-100" : ""}`}
    >
      <div className="flex items-center gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-gray-500 text-gray-900 text-xs tabular-nums">
          {rank}
        </span>
        <span
          className={`font-mono text-sm ${isEveCode ? "font-semibold text-gray-1000" : "text-gray-900"}`}
        >
          {score.harness}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <div
          aria-label={`${percent(estimate)} resolved, 95% interval ${percent(low)} to ${percent(high)}`}
          className="relative h-3 flex-1 rounded-full bg-gray-200"
          role="img"
        >
          <div
            className="absolute inset-y-0 rounded-full bg-gray-400"
            style={{ left: percent(low), width: percent(high - low) }}
          />
          <div
            className={`absolute inset-y-0.5 left-0 rounded-full ${isEveCode ? "bg-gray-1000" : "bg-gray-700"}`}
            style={{ width: percent(estimate) }}
          />
        </div>
        <span className="w-24 text-right text-sm tabular-nums">
          <span className="font-semibold text-gray-1000">{percent(estimate)}</span>{" "}
          <span className="text-gray-700">
            {score.resolved}/{score.attempts}
          </span>
        </span>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="Median">
          {seconds(score.latencyP50Ms)}
          <span
            className="mt-1 block h-1 rounded-full bg-gray-500"
            style={{ width: percent(score.latencyP50Ms / slowest) }}
          />
        </Stat>
        <Stat label="Cost">{dollars(score.costUsd)}</Stat>
        <Stat label="Run">
          {score.runUrl ? (
            <a className="underline underline-offset-2" href={score.runUrl}>
              {date(score.measuredAt)}
            </a>
          ) : (
            date(score.measuredAt)
          )}
        </Stat>
      </dl>
    </li>
  );
};

const Stat = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <dt className="text-gray-700">{label}</dt>
    <dd className="font-medium text-gray-1000 tabular-nums">{children}</dd>
  </div>
);
