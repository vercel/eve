import type { Metadata } from "next";
import { eveBenchmark } from "@/lib/evals/eve-results";
import { benchmarkResults, benchmarkRows } from "@/lib/evals/results";
import { canonicalAlternates, canonicalRoutes } from "@/lib/geistdocs/canonical";
import { pageTitleMetadata } from "@/lib/geistdocs/metadata-title";
import { BenchmarksHub } from "./benchmarks-hub";

const title = "Benchmarks - eve";
const description =
  "Compare stock eve against peer coding agent harnesses across OpenAI and Anthropic models on DeepSWE-lean, plus eve project authoring benchmarks.";
const titleMetadata = pageTitleMetadata(title);

export const metadata: Metadata = {
  ...titleMetadata,
  description,
  alternates: canonicalAlternates(canonicalRoutes.benchmarks, {
    types: { "text/markdown": "/benchmarks.md" },
  }),
  openGraph: {
    ...titleMetadata.openGraph,
    images: ["/benchmarks/opengraph-image"],
    url: canonicalRoutes.benchmarks,
  },
  twitter: {
    ...titleMetadata.twitter,
    card: "summary_large_image",
    images: ["/benchmarks/twitter-image"],
  },
};

const BenchmarksPage = () => {
  const authoringRows = benchmarkRows(benchmarkResults);
  const authoringRetiredRows = (benchmarkResults.previouslyMeasured ?? []).flatMap((measurement) =>
    benchmarkRows({ ...benchmarkResults, ...measurement }),
  );
  const harnessDataset = eveBenchmark.datasets["deepswe-lean"];

  return (
    <BenchmarksHub
      authoringPublishedAt={benchmarkResults.generatedAt}
      authoringRetiredRows={authoringRetiredRows}
      authoringRevision={benchmarkResults.suite.eveRevision}
      authoringRows={authoringRows}
      harnessDataset={harnessDataset}
    />
  );
};

export default BenchmarksPage;
