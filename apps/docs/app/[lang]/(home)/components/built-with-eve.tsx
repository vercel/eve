import Link from "next/link";
import type { JSX } from "react";
import { EveCodeBenchmark } from "@/components/geistdocs/eve-code-benchmark";

export function BuiltWithEve(): JSX.Element {
  return (
    <section className="px-4 py-24">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-heading-32 text-gray-1000 text-balance sm:text-heading-40">
          Built with the same APIs
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900 text-balance">
          eve-code is a coding agent made from eve's public building blocks: tools, skills, a worker
          subagent, and sandbox helpers, packaged as an extension you mount in one file. A benchmark
          workflow runs it against opencode and pi on the same model and tasks.
        </p>
        <div className="mx-auto mt-12 max-w-4xl [&_figure]:my-0">
          <EveCodeBenchmark dataset="deepswe-lean" />
        </div>
        <p className="mx-auto mt-6 max-w-2xl text-center text-gray-900 text-copy-14 text-balance">
          These are the latest complete results.{" "}
          <Link
            className="text-gray-1000 underline decoration-gray-500 underline-offset-4 transition-colors hover:decoration-gray-1000"
            href="/docs/code-extension#benchmark-results"
            prefetch={true}
          >
            See how the benchmark works
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
