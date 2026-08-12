import { ArrowUpRight } from "lucide-react";
import type { JSX } from "react";

const FRAMEWORK_FITS: readonly {
  readonly name: string;
  readonly eyebrow: string;
  readonly description: string;
  readonly href: string;
  readonly featured?: boolean;
}[] = [
  {
    name: "eve",
    eyebrow: "Best complete system",
    description:
      "Choose eve when the agent is a durable backend product: long-running, sandboxed, multi-channel, multi-user, and expected to keep growing.",
    href: "/docs/getting-started",
    featured: true,
  },
  {
    name: "Mastra",
    eyebrow: "Best application toolkit",
    description:
      "A broad TypeScript surface with strong memory, workflows, Studio, observability, and rapidly expanding agent-controller features.",
    href: "https://mastra.ai/docs/",
  },
  {
    name: "Flue 2.0",
    eyebrow: "Best portable new harness",
    description:
      "A newly released option for teams that like React-style hooks, target Node or Cloudflare, and are comfortable assembling some production edges.",
    href: "https://flueframework.com/docs/guide/why-flue/",
  },
  {
    name: "Cloudflare Agents SDK",
    eyebrow: "Best Cloudflare-native substrate",
    description:
      "A strong choice when Durable Objects and the Cloudflare platform are already the architecture and you want lower-level control.",
    href: "https://developers.cloudflare.com/agents/",
  },
  {
    name: "LangGraph",
    eyebrow: "Best explicit graph runtime",
    description:
      "A mature option when a checkpointed graph is the desired abstraction, especially with the Python ecosystem and LangSmith platform.",
    href: "https://docs.langchain.com/oss/javascript/langgraph/overview",
  },
  {
    name: "Hermes Agent",
    eyebrow: "Best ready-made personal agent",
    description:
      "Install Hermes when you want a capable self-hosted assistant now. Choose a framework when you need to build a distinct product.",
    href: "https://hermes-agent.nousresearch.com/docs/",
  },
];

/** Gives a candid recommendation for the use case each primary comparison target serves best. */
export function FrameworkFit(): JSX.Element {
  return (
    <div className="not-prose my-8 grid gap-3 sm:grid-cols-2">
      {FRAMEWORK_FITS.map((framework) => (
        <a
          key={framework.name}
          className={`group flex min-w-0 flex-col rounded-xl border p-5 no-underline transition-colors ${framework.featured ? "border-blue-500 bg-blue-100 hover:bg-blue-200" : "border-gray-alpha-400 bg-background-100 hover:bg-background-200"}`}
          href={framework.href}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-mono uppercase tracking-[0.1em] text-label-12 text-gray-700">
                {framework.eyebrow}
              </div>
              <div className="mt-1 font-medium text-copy-16 text-gray-1000">{framework.name}</div>
            </div>
            <ArrowUpRight
              aria-hidden
              className="shrink-0 text-gray-700 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-gray-1000"
              size={16}
            />
          </div>
          <p className="mt-3 text-copy-14 leading-6 text-gray-900">{framework.description}</p>
        </a>
      ))}
    </div>
  );
}
