import type { Metadata } from "next";
import { Suspense } from "react";
import { eveBenchmark, orderedModels } from "@/lib/evals/eve-results";
import { benchmarkResults, benchmarkRows } from "@/lib/evals/results";
import { canonicalAlternates, canonicalRoutes } from "@/lib/geistdocs/canonical";
import { supportedLanguages } from "@/lib/geistdocs/languages";
import { pageTitleMetadata } from "@/lib/geistdocs/metadata-title";
import { BenchmarksHub, type HubView } from "./benchmarks-hub";

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

export const generateStaticParams = () => supportedLanguages.map((lang) => ({ lang }));

const authoringRows = benchmarkRows(benchmarkResults);
const authoringRetiredRows = (benchmarkResults.previouslyMeasured ?? []).flatMap((measurement) =>
  benchmarkRows({ ...benchmarkResults, ...measurement }),
);
const harnessDataset = eveBenchmark.datasets["deepswe-lean"];
const availableFamilies = new Set(
  harnessDataset ? orderedModels(harnessDataset).map((entry) => entry.family) : [],
);
const defaultFamily = harnessDataset
  ? (orderedModels(harnessDataset)[0]?.family ?? "openai")
  : "openai";

const ResolvedBenchmarksHub = async ({
  searchParams,
}: {
  searchParams: PageProps<"/[lang]/benchmarks">["searchParams"];
}) => {
  const params = await searchParams;
  const viewParam = Array.isArray(params.view) ? params.view[0] : params.view;
  const modelParam = Array.isArray(params.model) ? params.model[0] : params.model;
  const initialView: HubView = viewParam === "authoring" ? "authoring" : "harness";
  const initialFamily =
    typeof modelParam === "string" && availableFamilies.has(modelParam)
      ? modelParam
      : defaultFamily;

  return (
    <BenchmarksHub
      authoringPublishedAt={benchmarkResults.generatedAt}
      authoringRetiredRows={authoringRetiredRows}
      authoringRevision={benchmarkResults.suite.eveRevision}
      authoringRows={authoringRows}
      harnessDataset={harnessDataset}
      initialFamily={initialFamily}
      initialView={initialView}
    />
  );
};

const BenchmarksPage = ({ searchParams }: PageProps<"/[lang]/benchmarks">) => (
  <Suspense
    fallback={
      <BenchmarksHub
        authoringPublishedAt={benchmarkResults.generatedAt}
        authoringRetiredRows={authoringRetiredRows}
        authoringRevision={benchmarkResults.suite.eveRevision}
        authoringRows={authoringRows}
        harnessDataset={harnessDataset}
        initialFamily={defaultFamily}
        initialView="harness"
      />
    }
  >
    <ResolvedBenchmarksHub searchParams={searchParams} />
  </Suspense>
);

export default BenchmarksPage;
