import { renderBenchmarksPageMarkdown } from "@/lib/evals/eve-format";
import { eveBenchmark } from "@/lib/evals/eve-results";
import { benchmarkResults, benchmarkRows } from "@/lib/evals/results";
import { canonicalRoutes } from "@/lib/geistdocs/canonical";
import { isSupportedLanguage, supportedLanguages } from "@/lib/geistdocs/languages";
import { getSiteOrigin } from "@/lib/geistdocs/url";

export const generateStaticParams = () => supportedLanguages.map((lang) => ({ lang }));

const cachedMarkdown = renderBenchmarksPageMarkdown(
  eveBenchmark.datasets["deepswe-lean"],
  benchmarkRows(benchmarkResults),
  benchmarkResults.generatedAt,
);

export async function GET(
  _request: Request,
  context: { params: Promise<{ lang: string }> },
): Promise<Response> {
  const { lang } = await context.params;
  if (!isSupportedLanguage(lang)) {
    return new Response("Not Found", { status: 404 });
  }
  const canonicalUrl = `${getSiteOrigin()}${canonicalRoutes.benchmarks}`;
  return new Response(cachedMarkdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Link: `<${canonicalUrl}>; rel="canonical"`,
    },
  });
}
