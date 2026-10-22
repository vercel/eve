import { IconArrowUpRight } from "@vercel/geistdocs/assets/icons/icon-arrow-up-right";
import Link from "next/link";
import type { JSX } from "react";
import { cn } from "@/lib/utils";
import { GradientBorder } from "./gradient-border";

interface Layer {
  name: string;
  role: string;
  body: string;
  href: string;
  linkLabel: string;
  external: boolean;
  /** You build everything to the right of this layer's coverage. */
  covers: number;
}

const LAYERS: Layer[] = [
  {
    name: "AI SDK",
    role: "Call models",
    body: "Use it for model calls, streaming, and tool calling inside code you already run. eve makes its model calls through AI SDK.",
    href: "https://ai-sdk.dev",
    linkLabel: "ai-sdk.dev",
    external: true,
    covers: 1,
  },
  {
    name: "libfx",
    role: "Embed an agent loop",
    body: "Use it to embed a durable agent loop in your own server, or run one in a browser page, when you plan to build the product around it. It is a separate project from eve.",
    href: "https://fx.sh/docs/lib",
    linkLabel: "fx.sh/docs/lib",
    external: true,
    covers: 2,
  },
  {
    name: "eve",
    role: "Run the whole agent",
    body: "Use it when you want the whole system: an agent that answers in Slack or your app, runs on a schedule, waits for approvals, works in a sandbox, and ships with evals.",
    href: "/docs/getting-started",
    linkLabel: "Get started",
    external: false,
    covers: 3,
  },
];

const SCOPE = ["Model calls", "Agent loop", "Channels, schedules, evals"];

export function WhereEveFits(): JSX.Element {
  return (
    <section className="px-4 py-24">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-heading-32 text-gray-1000 text-balance sm:text-heading-40">
          Where eve fits
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900 text-balance">
          Three open-source options from Vercel and Vercel Labs. Choose by how much of the system
          you want to build yourself.
        </p>

        <div
          aria-hidden
          className="mt-10 flex items-center justify-center gap-5 text-gray-900 text-label-12"
        >
          <span className="inline-flex items-center gap-2">
            <span className="h-3 w-5 rounded-sm border border-gray-400 bg-gray-100" />
            Included
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="h-3 w-5 rounded-sm border border-dashed" />
            You build
          </span>
        </div>

        <ul className="mt-6 grid list-none gap-4 md:grid-cols-3">
          {LAYERS.map((layer) => {
            const isEve = layer.name === "eve";
            return (
              <li
                className={cn(
                  "relative flex flex-col gap-4 rounded-xl p-5",
                  isEve ? "material-small" : "border",
                )}
                key={layer.name}
              >
                {isEve ? <GradientBorder /> : null}
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-gray-900 text-label-13-mono">{layer.name}</span>
                  <h3 className="text-gray-1000 text-heading-20">{layer.role}</h3>
                </div>

                {/* Which parts of the stack this layer gives you. */}
                <div
                  aria-label={`${layer.name} covers`}
                  className="flex flex-col gap-1.5"
                  role="list"
                >
                  {SCOPE.map((part, index) => {
                    const covered = index < layer.covers;
                    return (
                      <div
                        className={cn(
                          "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-copy-13",
                          covered
                            ? "border-gray-400 bg-gray-100 text-gray-1000"
                            : "border-dashed text-gray-900",
                        )}
                        key={part}
                        role="listitem"
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            covered ? "bg-gray-1000" : "bg-gray-500",
                          )}
                        />
                        <span className="min-w-0">{part}</span>
                        <span className="sr-only">{covered ? "(included)" : "(you build)"}</span>
                      </div>
                    );
                  })}
                </div>

                <p className="grow text-gray-900 text-copy-14">{layer.body}</p>

                <Link
                  className="inline-flex w-fit items-center gap-1 text-gray-1000 text-copy-14 underline decoration-gray-500 underline-offset-4 transition-colors hover:decoration-gray-1000"
                  href={layer.href}
                  prefetch={layer.external ? undefined : true}
                  rel={layer.external ? "noopener" : undefined}
                  target={layer.external ? "_blank" : undefined}
                >
                  {layer.linkLabel}
                  {layer.external ? (
                    <>
                      <IconArrowUpRight className="text-gray-900" size={14} />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>

        <p className="mx-auto mt-8 max-w-2xl text-center text-gray-900 text-copy-14 text-balance">
          <Link
            className="text-gray-1000 underline decoration-gray-500 underline-offset-4 transition-colors hover:decoration-gray-1000"
            href="/docs/overview#where-eve-fits"
            prefetch={true}
          >
            Read the full comparison
          </Link>{" "}
          in the docs overview.
        </p>
      </div>
    </section>
  );
}
