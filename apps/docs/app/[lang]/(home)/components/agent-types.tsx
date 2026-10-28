"use client";

import { IconPlusCircle } from "@vercel/geistdocs/assets/icons";
import { track } from "@vercel/analytics";
import { Button } from "@vercel/geistdocs/components/button";
import {
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { analyticsEvents } from "@/lib/analytics/events";
import { canonicalRoutes, templatePath } from "@/lib/geistdocs/canonical";
import { logos, voiceLogo } from "@/lib/integrations/logos";
import { cn } from "@/lib/utils";
import { Frame, FrameHeader, HomeSection, PrefetchLink } from "./section";

const logoClassName = "size-3.5 shrink-0 grayscale";

const FACTORY_STATIONS = [
  { name: "classifier", result: "Feature request, medium scope" },
  { name: "analyst", result: "Mapped the checkout flow and wrote a plan" },
  { name: "implementer", result: "Pushed eve/eng-142 and opened draft #318" },
  { name: "reviewer", result: "Left 2 comments, both addressed" },
];

function SoftwareFactoryPreview() {
  return (
    <>
      <FrameHeader>
        {logos.github({ "aria-hidden": true, className: logoClassName })}
        <span className="text-gray-1000">acme/storefront</span>
        <span className="ml-auto">Example run</span>
      </FrameHeader>
      <div className="flex flex-col gap-3 p-5 sm:p-6">
        <div className="flex items-center gap-3 rounded-lg border border-gray-alpha-400 bg-background-200 px-4 py-3">
          {logos.linear({ "aria-hidden": true, className: logoClassName })}
          <span className="font-mono text-copy-13-mono text-gray-900">ENG-142</span>
          <span className="truncate text-copy-14 text-gray-1000">Add saved carts to checkout</span>
        </div>
        <ol className="flex list-none flex-col p-0">
          {FACTORY_STATIONS.map((station) => (
            <li
              className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[1rem_11rem_minmax(0,1fr)]"
              key={station.name}
            >
              <span aria-hidden className="relative flex justify-center">
                <span className="absolute inset-y-0 w-px bg-gray-alpha-400" />
                <span className="relative mt-[1.1rem] size-2 rounded-full bg-gray-1000" />
              </span>
              <code className="pt-3 font-mono text-copy-13-mono text-gray-1000">
                subagents/{station.name}
              </code>
              <span className="col-start-2 pb-1 text-copy-14 text-gray-900 sm:col-start-3 sm:pt-3 sm:pb-0">
                {station.result}
              </span>
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-3 rounded-lg border border-gray-alpha-600 px-4 py-3">
          {logos.github({ "aria-hidden": true, className: logoClassName })}
          <span className="truncate text-copy-14 text-gray-1000">
            Draft #318 is ready for your review
          </span>
        </div>
      </div>
    </>
  );
}

const BRAIN_STEPS = [
  { tool: "list_models", result: "Found customers, orders, and payments" },
  { tool: "get_model", result: "Read the docs for the orders model" },
  { tool: "query_sql", result: "Ran 1 query, returned 3 rows" },
];

const BRAIN_ROWS = [
  { month: "August", orders: 412, repeat: "38%" },
  { month: "September", orders: 455, repeat: "41%" },
  { month: "October", orders: 498, repeat: "44%" },
];

function CompanyBrainPreview() {
  return (
    <>
      <FrameHeader>
        {logos.slack({ "aria-hidden": true, className: logoClassName })}
        <span className="text-gray-1000">#analytics</span>
        <span className="ml-auto">Example run</span>
      </FrameHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-5 sm:p-6">
        <p className="ml-auto w-fit rounded-xl bg-gray-alpha-200 px-3 py-1 text-copy-13 text-gray-1000">
          How are repeat orders trending this quarter?
        </p>
        <ul className="flex list-none flex-col gap-1 p-0">
          {BRAIN_STEPS.map((step) => (
            <li className="flex items-baseline gap-3 text-copy-13" key={step.tool}>
              <code className="w-24 shrink-0 font-mono text-copy-13-mono text-gray-1000">
                {step.tool}
              </code>
              <span className="truncate text-gray-900">{step.result}</span>
            </li>
          ))}
        </ul>
        <p className="text-copy-14 text-gray-1000">
          Repeat customers placed 44% of orders in October, up from 38% in August.
        </p>
        <table className="w-full max-w-[26rem] border-collapse rounded-lg text-left text-copy-13 tabular-nums">
          <thead className="text-gray-900">
            <tr className="border-gray-alpha-400 border-b">
              <th className="py-1.5 pr-3 font-normal" scope="col">
                Month
              </th>
              <th className="py-1.5 pr-3 text-right font-normal" scope="col">
                Orders
              </th>
              <th className="py-1.5 text-right font-normal" scope="col">
                Repeat
              </th>
            </tr>
          </thead>
          <tbody className="text-gray-1000">
            {BRAIN_ROWS.map((row) => (
              <tr className="border-gray-alpha-400 border-b last:border-b-0" key={row.month}>
                <th className="py-1.5 pr-3 font-normal" scope="row">
                  {row.month}
                </th>
                <td className="py-1.5 pr-3 text-right">{row.orders}</td>
                <td className="py-1.5 text-right">{row.repeat}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// A fixed, hand-shaped envelope so the waveform renders identically on server and client.
const WAVEFORM = [3, 6, 10, 14, 9, 16, 20, 13, 7, 4, 8, 13, 18, 12, 7, 4, 3, 6, 11, 15, 9, 5, 3];

/** Customer support chat docked in a product, shown inside a browser window. */
function WebAppClient() {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-gray-alpha-400 bg-background-200">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-gray-alpha-400 border-b px-3">
        {[0, 1, 2].map((dot) => (
          <span className="size-2 rounded-full bg-gray-alpha-400" key={dot} />
        ))}
        <span className="mx-auto truncate rounded-md bg-gray-alpha-200 px-3 py-0.5 text-label-12 text-gray-900">
          app.acme.com/orders
        </span>
      </div>
      <div className="relative min-h-0 flex-1 p-3">
        <div aria-hidden className="hidden flex-col gap-2 sm:flex">
          <span className="text-copy-13 text-gray-1000">Orders</span>
          {["w-3/5", "w-2/5", "w-1/2"].map((width) => (
            <span className={`h-2 rounded-full bg-gray-alpha-200 ${width}`} key={width} />
          ))}
        </div>
        <div className="absolute inset-x-3 bottom-3 flex flex-col gap-2 rounded-lg border border-gray-alpha-400 bg-background-100 p-2.5 shadow-lg sm:left-auto sm:w-60">
          <span className="text-label-12 text-gray-900">Acme support</span>
          <p className="ml-auto rounded-2xl bg-gray-1000 px-3 py-1 text-copy-13 text-background-100">
            Where's my order #4821?
          </p>
          <p className="rounded-2xl bg-gray-alpha-200 px-3 py-1 text-copy-13 text-gray-1000">
            It shipped yesterday and arrives Thursday.
          </p>
        </div>
      </div>
    </div>
  );
}

/** A phone call to a clinic's front desk, with live waveform and call controls. */
function VoiceClient() {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-gray-alpha-400 bg-background-200 p-3">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gray-alpha-200 text-gray-1000">
          {voiceLogo({ "aria-hidden": true, className: logoClassName })}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-copy-13 text-gray-1000">Acme Dental</span>
          <span className="truncate text-label-12 text-gray-900 tabular-nums">
            Front desk · 00:42
          </span>
        </span>
        <span aria-hidden className="ml-auto hidden h-6 items-center gap-[3px] sm:flex">
          {WAVEFORM.map((height, i) => (
            <span
              className="w-[2px] rounded-full bg-gray-alpha-600"
              // Bars are positional; the array never reorders.
              key={i}
              style={{ height: `${height}px` }}
            />
          ))}
        </span>
        <span className="ml-3 hidden shrink-0 rounded-full bg-red-700 px-3 py-1 text-label-12 text-white sm:inline">
          End
        </span>
      </div>
      <p className="text-copy-13 text-gray-900">
        <span className="text-gray-1000">Agent</span> Done, you're moved to Friday at 10:00.
      </p>
    </div>
  );
}

// iMessage's own colors, so the thread reads as iMessage rather than a generic chat.
const sentBubbleClassName = "ml-auto bg-[#007AFF] text-white dark:bg-[#0A84FF]";
const receivedBubbleClassName = "bg-[#E9E9EB] text-black dark:bg-[#26252A] dark:text-white";

const IMESSAGE_THREAD: { sent: boolean; text: string }[] = [
  { sent: true, text: "Dinner with Sam on Friday?" },
  { sent: false, text: "Luna has a table at 7. Want it?" },
  { sent: true, text: "Yes please" },
  { sent: false, text: "Booked and added to your calendar." },
];

/** A personal planning thread in an iMessage-style app. */
function IMessageClient() {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-gray-alpha-400 bg-background-200">
      <div className="flex shrink-0 flex-col items-center gap-1 border-gray-alpha-400 border-b py-2.5">
        <span className="flex size-8 items-center justify-center rounded-full bg-gradient-to-b from-[#A5A9B4] to-[#858994] font-medium text-[13px] text-white dark:from-[#636366] dark:to-[#48484A]">
          P
        </span>
        <span className="text-label-12 text-gray-1000">Planner</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-3 text-copy-13">
        {IMESSAGE_THREAD.map((message) => (
          <p
            className={`max-w-[85%] rounded-[18px] px-3 py-1.5 ${
              message.sent ? sentBubbleClassName : receivedBubbleClassName
            }`}
            key={message.text}
          >
            <span className="sr-only">{message.sent ? "You: " : "Agent: "}</span>
            {message.text}
          </p>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-2 p-2.5 pt-0">
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gray-alpha-200 text-gray-900"
        >
          <IconPlusCircle size={14} />
        </span>
        <span className="flex-1 truncate rounded-full border border-gray-alpha-400 px-3 py-1 text-copy-13 text-gray-900">
          iMessage
        </span>
      </div>
    </div>
  );
}

function AgenticAppsPreview() {
  return (
    <figure className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_9.5rem] gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_13rem] sm:gap-4 sm:p-4">
      <figcaption className="sr-only">
        The same kind of agent in three clients: customer support chat in a web app, a voice call to
        a clinic's front desk, and a personal planner in iMessage.
      </figcaption>
      <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3 sm:gap-4">
        <WebAppClient />
        <VoiceClient />
      </div>
      <IMessageClient />
    </figure>
  );
}

interface UseCase {
  id: string;
  name: string;
  text: string;
  /** Template slug, or null to send people to the full gallery. */
  template: string | null;
  cta: string;
  preview: ReactNode;
}

const USE_CASES: UseCase[] = [
  {
    id: "company-brain",
    name: "Company brain",
    text: "Build a Slack agent that answers your team's business questions from your documented dbt models.",
    template: "eve-company-brain-template",
    cta: "Use the company brain template",
    preview: <CompanyBrainPreview />,
  },
  {
    id: "software-factory",
    name: "Software factory",
    text: "Build an agent that turns issues into reviewed draft pull requests, from triage and planning to implementation.",
    template: "eve-software-factory-template",
    cta: "Use the software factory template",
    preview: <SoftwareFactoryPreview />,
  },
  {
    id: "agentic-apps",
    name: "Agentic apps",
    text: "Agents inside your product, over web, voice, or iMessage, with memory for every user.",
    template: null,
    cta: "Browse app templates",
    preview: <AgenticAppsPreview />,
  },
];

/**
 * vercel.com/ai-gateway's sliding tabs (vercel-marketing's SlidingTabs): a gray pill slides
 * under the selected tab.
 */
function UseCaseTabs({
  baseId,
  selectedIndex,
  onSelect,
}: {
  baseId: string;
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number }>();

  useLayoutEffect(() => {
    const measure = () => {
      const tab = list.current?.querySelector<HTMLElement>("[aria-selected=true]");
      if (tab) setIndicator({ left: tab.offsetLeft, width: tab.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (list.current) observer.observe(list.current);
    return () => observer.disconnect();
  }, [selectedIndex]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? USE_CASES.length - 1
          : step === undefined
            ? undefined
            : (selectedIndex + step + USE_CASES.length) % USE_CASES.length;
    if (target === undefined) return;
    event.preventDefault();
    onSelect(target);
    list.current?.querySelectorAll<HTMLElement>("[role=tab]")[target]?.focus();
  };

  return (
    <div
      aria-label="Use cases"
      aria-orientation="horizontal"
      className="relative inline-flex max-w-full gap-1 overflow-x-auto overscroll-x-contain p-1 [scrollbar-width:none]"
      onKeyDown={onKeyDown}
      ref={list}
      role="tablist"
    >
      {USE_CASES.map((useCase, index) => {
        const isSelected = index === selectedIndex;
        return (
          <button
            aria-controls={`${baseId}-panel`}
            aria-selected={isSelected}
            className="relative z-10 flex-none cursor-pointer whitespace-nowrap rounded-[6px] focus-visible:shadow-(--ds-focus-ring) focus-visible:outline-none"
            id={`${baseId}-tab-${useCase.id}`}
            key={useCase.id}
            onClick={() => onSelect(index)}
            role="tab"
            tabIndex={isSelected ? 0 : -1}
            type="button"
          >
            {/* The size sits apart from the color, which cn would otherwise merge it away with. */}
            <span
              className={cn(
                "block px-3.5 py-1.5 transition-colors hover:text-gray-1000",
                isSelected ? "text-gray-1000" : "text-gray-900",
              )}
            >
              <span className="text-copy-14">{useCase.name}</span>
            </span>
          </button>
        );
      })}
      {indicator ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1 bottom-1 z-0 rounded-[6px] bg-gray-200 transition-[left,width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none"
          style={indicator}
        />
      ) : null}
    </div>
  );
}

export function AgentTypes(): JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const baseId = useId();
  const selected = USE_CASES[selectedIndex];

  return (
    <HomeSection
      action={
        <Button
          className="w-fit rounded-full text-base"
          Component={PrefetchLink}
          href={selected.template ? templatePath(selected.template) : canonicalRoutes.templates}
          onClick={() =>
            track(analyticsEvents.templateOpened, {
              source: "home_examples",
              template: selected.template ?? "gallery",
            })
          }
          size="large"
        >
          {selected.cta}
        </Button>
      }
      id="agent-types"
      lede="Start from a working template, or build your own from scratch."
      title="Agents that run your company, power your product, or are personal"
    >
      <div className="flex flex-col gap-6">
        {/* Pulled out by the list's padding, so the selected pill lines up with the window. */}
        <div className="-ml-1">
          <UseCaseTabs baseId={baseId} onSelect={setSelectedIndex} selectedIndex={selectedIndex} />
        </div>
        <div className="grid gap-4 lg:grid-cols-12 lg:gap-x-6">
          {/* Every description shares one grid cell, so it keeps the tallest one's height and
              switching tabs never shifts the layout. Beside the window, from its top and a column
              clear of it, on wide screens; above it when stacked. */}
          <div className="grid lg:col-span-4 lg:col-start-9 lg:row-start-1 lg:max-w-[44ch]">
            {USE_CASES.map((useCase) => (
              <p
                className={cn(
                  "col-start-1 row-start-1 text-pretty text-copy-14 text-gray-900",
                  useCase !== selected && "invisible",
                )}
                key={useCase.id}
              >
                {useCase.text}
              </p>
            ))}
          </div>
          <div
            aria-labelledby={`${baseId}-tab-${selected.id}`}
            className="min-w-0 lg:col-span-7 lg:row-start-1"
            id={`${baseId}-panel`}
            role="tabpanel"
          >
            <Frame className="flex h-[30rem] flex-col sm:h-[24rem]">{selected.preview}</Frame>
          </div>
        </div>
      </div>
    </HomeSection>
  );
}
