import { renderBenchmarksPageMarkdown } from "@/lib/evals/eve-format";
import { eveBenchmark } from "@/lib/evals/eve-results";
import { benchmarkResults, benchmarkRows } from "@/lib/evals/results";
import { supportedLanguages } from "@/lib/geistdocs/languages";

export const generateStaticParams = () => supportedLanguages.map((lang) => ({ lang }));

export function GET() {
  const markdown = renderBenchmarksPageMarkdown(
    eveBenchmark.datasets["deepswe-lean"],
    benchmarkRows(benchmarkResults),
    benchmarkResults.generatedAt,
  );
  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}
