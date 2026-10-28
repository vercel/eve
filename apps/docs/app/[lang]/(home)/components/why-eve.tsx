import { SiNextdotjs, SiNuxt, SiSvelte, SiTanstack } from "@icons-pack/react-simple-icons";
import { IconChevronRightSmall } from "@vercel/geistdocs/assets/icons";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { slackLogo } from "@/lib/integrations/logos";
import { cn } from "@/lib/utils";
import { Frame, FrameHeader, HomeSection } from "./section";

// The four harness layers, each with what it decides.
const HARNESS = [
  { layer: "Execution", role: "How work runs and waits" },
  { layer: "Context", role: "What the model knows" },
  { layer: "Actions", role: "What the agent can do" },
  { layer: "Triggers", role: "What starts a run" },
];

function HarnessLayers() {
  return (
    <ol className="flex h-full list-none flex-col justify-center gap-1.5 p-3">
      {HARNESS.map((row) => (
        <li
          className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-center gap-x-2 rounded-md border border-gray-alpha-400 bg-background-200 px-3 py-2.5"
          key={row.layer}
        >
          <span className="text-label-12 text-gray-1000">{row.layer}</span>
          <span className="truncate text-copy-13 text-gray-900">{row.role}</span>
        </li>
      ))}
    </ol>
  );
}

const FRAMEWORKS = [
  { name: "Next.js", Logo: SiNextdotjs },
  { name: "Nuxt", Logo: SiNuxt },
  { name: "SvelteKit", Logo: SiSvelte },
  { name: "TanStack", Logo: SiTanstack },
];

const SIGNUPS = [620, 680, 710, 690, 820, 905, 1010, 1284];
const SIGNUPS_MAX = Math.max(...SIGNUPS);
const SIGNUPS_GROWTH = Math.round((SIGNUPS.at(-1)! / SIGNUPS[0] - 1) * 100);

function SignupsChart() {
  return (
    <figure className="flex flex-col gap-2 rounded-lg border border-gray-alpha-400 bg-background-200 p-3">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-label-12 text-gray-1000">Weekly signups</span>
        <span className="text-label-12 text-gray-900 tabular-nums">
          <span className="text-gray-1000">{SIGNUPS.at(-1)?.toLocaleString("en-US")}</span> this
          week, +{SIGNUPS_GROWTH}%
        </span>
      </figcaption>
      <div aria-hidden className="flex h-12 items-end gap-[2px] border-gray-alpha-400 border-b">
        {SIGNUPS.map((value, i) => {
          const current = i === SIGNUPS.length - 1;
          return (
            <div className="flex h-full flex-1 items-end" key={i} title={`${value} signups`}>
              <div
                className={cn(
                  "w-full rounded-t-[4px]",
                  current ? "bg-gray-1000" : "bg-gray-alpha-500",
                )}
                style={{ height: `${(value / SIGNUPS_MAX) * 100}%` }}
              />
            </div>
          );
        })}
      </div>
      <div aria-hidden className="flex justify-between text-label-12 text-gray-900">
        <span>8 weeks ago</span>
        <span>This week</span>
      </div>
      <table className="sr-only">
        <caption>Weekly signups for the last 8 weeks</caption>
        <tbody>
          {SIGNUPS.map((value, i) => (
            <tr key={i}>
              <th scope="row">
                {i === SIGNUPS.length - 1 ? "This week" : `${SIGNUPS.length - 1 - i} weeks ago`}
              </th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function AgentUi() {
  return (
    <>
      <FrameHeader>
        {FRAMEWORKS.map(({ name, Logo }) => (
          <Logo aria-label={name} className="size-3.5 text-gray-1000" key={name} role="img" />
        ))}
        <code className="ml-auto font-mono text-copy-13-mono">useEveAgent()</code>
      </FrameHeader>
      <div className="flex flex-col gap-1.5 p-3">
        <p className="ml-auto w-fit rounded-xl bg-gray-alpha-200 px-3 py-1 text-copy-13 text-gray-1000">
          How are signups trending?
        </p>
        <SignupsChart />
      </div>
    </>
  );
}

// Steps of one turn as Agent Runs times them, in milliseconds from the turn start.
const STEPS = [
  { kind: "Model", name: "claude-opus-5.5", start: 0, end: 800 },
  { kind: "Skill", name: "oncall-runbook", start: 800, end: 1000 },
  { kind: "Tool", name: "search_logs", start: 1000, end: 1700 },
  { kind: "Tool", name: "get_deploy", start: 1700, end: 2000 },
  { kind: "Model", name: "claude-opus-5.5", start: 2000, end: 2900 },
];
const TURN_MS = 2900;

function AgentRun() {
  return (
    <>
      <FrameHeader>
        {slackLogo({ "aria-hidden": true, className: "size-3.5 shrink-0 grayscale" })}
        <span className="truncate text-gray-1000">
          Checkout errors started after Friday's deploy
        </span>
        <span className="ml-auto shrink-0 tabular-nums">{(TURN_MS / 1000).toFixed(1)}s</span>
      </FrameHeader>
      <table className="my-2 w-full table-fixed border-collapse text-left">
        <caption className="sr-only">Timings for each step of the turn</caption>
        <colgroup>
          <col className="w-[4.25rem]" />
          <col className="w-[42%]" />
          <col />
          <col className="w-12" />
        </colgroup>
        <tbody>
          {STEPS.map((step, i) => (
            <tr className="align-middle" key={`${step.name}-${i}`}>
              <th className="py-1 pl-4 font-normal text-label-12 text-gray-900" scope="row">
                {step.kind}
              </th>
              <td className="truncate py-1 pr-3 font-mono text-label-12-mono text-gray-1000">
                {step.name}
              </td>
              <td className="py-1">
                <div className="relative h-1.5 rounded-full bg-gray-alpha-100">
                  <div
                    className="absolute inset-y-0 rounded-full bg-gray-1000"
                    style={{
                      left: `${(step.start / TURN_MS) * 100}%`,
                      width: `${((step.end - step.start) / TURN_MS) * 100}%`,
                    }}
                  />
                </div>
              </td>
              <td className="py-1 pr-4 text-right text-label-12 text-gray-900 tabular-nums">
                {((step.end - step.start) / 1000).toFixed(1)}s
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-auto flex gap-5 border-gray-alpha-400 border-t px-4 py-2.5 text-label-12">
        {[
          ["Input", "12.4k"],
          ["Cached", "9.8k"],
          ["Output", "860"],
        ].map(([label, value]) => (
          <div className="flex gap-1.5" key={label}>
            <dt className="text-gray-900">{label}</dt>
            <dd className="text-gray-1000 tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function Reason({
  title,
  href,
  linkLabel,
  children,
  visual,
  visualLabel,
}: {
  title: string;
  href: string;
  linkLabel: string;
  children: ReactNode;
  visual: ReactNode;
  visualLabel: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 lg:col-span-4">
      {/* Every column's visual shares one height so the titles below line up. */}
      <figure aria-label={visualLabel} className="mb-4">
        <Frame className="flex h-56 flex-col">{visual}</Frame>
      </figure>
      <h3 className="text-heading-24 text-gray-1000">{title}</h3>
      <p className="text-copy-16 text-gray-900">{children}</p>
      <Link
        className="group mt-1 inline-flex w-fit items-center text-copy-14 text-gray-1000"
        href={href}
        prefetch={true}
      >
        {linkLabel}
        <IconChevronRightSmall
          className="text-gray-900 transition-transform group-hover:translate-x-0.5"
          size={16}
        />
      </Link>
    </div>
  );
}

export function WhyEve(): JSX.Element {
  return (
    <HomeSection
      id="why-eve"
      lede="Customize at every layer, from the harness to the UI to every agent run."
      title="Why use eve?"
    >
      <div className="grid gap-x-8 gap-y-14 lg:grid-cols-12">
        <Reason
          href="/docs/concepts/default-harness"
          linkLabel="Read about the default harness"
          title="Own your harness"
          visual={<HarnessLayers />}
          visualLabel="The four layers of the eve harness: execution, context, actions, and triggers"
        >
          Start with great defaults. Turn off what you don't need, extend what you do. Scale from
          side project to enterprise.
        </Reason>
        <Reason
          href="/docs/guides/frontend/overview"
          linkLabel="Build a chat UI"
          title="Build rich agent UIs"
          visual={<AgentUi />}
          visualLabel="A data agent answering in chat with a rendered bar chart of weekly signups"
        >
          Works natively with Next.js, Nuxt, SvelteKit, and TanStack. Stream chat, render real UI,
          and ship agent and app in one deploy.
        </Reason>
        <Reason
          href="/docs/observability/instrumentation"
          linkLabel="Set up tracing"
          title="Govern and observe every run"
          visual={<AgentRun />}
          visualLabel="An example agent run with step timings and token usage, in the style of Vercel Agent Runs"
        >
          Every session, model call, and tool call recorded, with OpenTelemetry traces. Credentials
          never reach the model.
        </Reason>
      </div>
    </HomeSection>
  );
}
