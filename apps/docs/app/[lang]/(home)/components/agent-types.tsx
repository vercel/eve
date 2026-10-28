"use client";

import {
  IconArrowUp,
  IconBookmark,
  IconChevronRightSmall,
  IconClock,
  IconMessage,
  IconPlusCircle,
  IconSparkles,
} from "@vercel/geistdocs/assets/icons";
import { track } from "@vercel/analytics";
import { Button } from "@vercel/geistdocs/components/button";
import { type JSX, type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { analyticsEvents } from "@/lib/analytics/events";
import { canonicalRoutes, templatePath } from "@/lib/geistdocs/canonical";
import { logos, voiceLogo } from "@/lib/integrations/logos";
import { cn } from "@/lib/utils";
import { Frame, FrameHeader, HomeSection } from "./section";

const logoClassName = "size-3.5 shrink-0 grayscale";
const navLogoClassName = "size-4 shrink-0 grayscale";

const FACTORY_STATIONS = [
  { name: "classifier", result: "Feature request, medium scope" },
  { name: "implementer", result: "Opened #318 from eve/eng-142" },
  { name: "reviewer", result: "Left 2 comments, fixed both, approved" },
  { name: "merger", result: "Checks passed, merged to main" },
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
          <span className="truncate text-copy-14 text-gray-1000">Merged #318 into main</span>
        </div>
      </div>
    </>
  );
}

const BRAIN_NAV: { label: string; icon: ReactNode }[] = [
  { label: "New chat", icon: <IconPlusCircle size={14} /> },
  { label: "Automations", icon: <IconClock size={14} /> },
  { label: "Memory", icon: <IconBookmark size={14} /> },
  { label: "Skills", icon: <IconSparkles size={14} /> },
];

const BRAIN_CHATS = ["Daily update", "Write a changelog", "Summarize user interviews"];

const BRAIN_UPDATE = [
  { heading: "Shipped", item: "Usage-based billing, live for 10% of workspaces (PLAT-212)" },
  { heading: "In progress", item: "Enterprise SSO, design review moved to Thursday" },
  { heading: "Blocked", item: "iOS 2.4 is waiting on App Store review" },
];

function CompanyBrainPreview() {
  return (
    <div className="grid min-h-0 flex-1 sm:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="hidden min-h-0 flex-col gap-4 border-gray-alpha-400 border-r p-2 sm:flex">
        <span className="px-2 pt-1.5 font-medium text-copy-14 text-gray-1000">acme</span>
        <ul className="flex list-none flex-col gap-0.5 p-0">
          {BRAIN_NAV.map((item) => (
            <li
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-copy-13 text-gray-1000"
              key={item.label}
            >
              <span className="flex text-gray-900">{item.icon}</span>
              {item.label}
            </li>
          ))}
        </ul>
        <ul className="flex list-none flex-col gap-0.5 p-0">
          {BRAIN_CHATS.map((title, i) => (
            <li
              className={`truncate rounded-md px-2 py-1.5 text-copy-13 ${
                i === 0 ? "bg-gray-alpha-200 text-gray-1000" : "text-gray-900"
              }`}
              key={title}
            >
              {title}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        <FrameHeader>
          <span className="text-gray-1000">Daily update</span>
        </FrameHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 pt-4">
          <span className="ml-auto rounded-full bg-gray-alpha-200 px-3 py-1 text-copy-13 text-gray-1000">
            Run my daily update
          </span>
          <p className="flex items-center gap-1.5 text-copy-13 text-gray-900">
            Read Linear, GitHub, and #product
          </p>
          <div className="flex flex-col gap-1.5 text-copy-14">
            <p className="font-medium text-gray-1000">Daily update · Tue, Oct 21</p>
            {BRAIN_UPDATE.map((section) => (
              <p className="text-gray-900" key={section.heading}>
                <span className="text-gray-1000">{section.heading}</span> {section.item}
              </p>
            ))}
          </div>
        </div>
        <div className="p-3 pt-2">
          <div className="flex items-center gap-2 rounded-xl border border-gray-alpha-400 bg-background-200 py-2 pr-2 pl-3.5">
            <span className="truncate text-copy-13 text-gray-900">
              Ask anything, or press / for a skill
            </span>
            <span className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-full bg-gray-1000 text-background-100">
              <IconArrowUp size={12} />
            </span>
          </div>
        </div>
      </div>
    </div>
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
  logo: ReactNode;
  preview: ReactNode;
}

const USE_CASES: UseCase[] = [
  {
    id: "company-brain",
    name: "Company brain",
    text: "Build a chat app for your whole company, with shared skills, memory, and automations.",
    template: "eve-company-brain-template",
    cta: "Use the company brain template",
    logo: <IconMessage className="shrink-0" size={16} />,
    preview: <CompanyBrainPreview />,
  },
  {
    id: "software-factory",
    name: "Software factory",
    text: "Build an agent that turns issues into merged pull requests, from planning and implementation to review.",
    template: "eve-software-factory-template",
    cta: "Use the software factory template",
    logo: logos.github({ "aria-hidden": true, className: navLogoClassName }),
    preview: <SoftwareFactoryPreview />,
  },
  {
    id: "agentic-apps",
    name: "Agentic apps",
    text: "Agents inside your product, over web, voice, or iMessage, with memory for every user.",
    template: null,
    cta: "Browse app templates",
    logo: logos.web({ "aria-hidden": true, className: navLogoClassName }),
    preview: <AgenticAppsPreview />,
  },
];

export function AgentTypes(): JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();
  const selected = USE_CASES[selectedIndex];

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
    setSelectedIndex(target);
    tabs.current[target]?.focus();
  };

  return (
    <HomeSection
      id="agent-types"
      lede="Start from a working template, or build your own from scratch."
      title="Agents that run your company, power your product, or are personal"
    >
      <div className="grid gap-8 lg:grid-cols-12 lg:gap-x-6">
        <div
          aria-label="Use cases"
          aria-orientation="vertical"
          className="flex flex-col self-start border-gray-alpha-400 border-l lg:col-span-4"
          onKeyDown={onKeyDown}
          role="tablist"
        >
          {USE_CASES.map((useCase, index) => {
            const isSelected = index === selectedIndex;
            return (
              <button
                aria-controls={`${baseId}-panel`}
                aria-selected={isSelected}
                className="group relative flex cursor-pointer flex-col gap-1.5 py-4 pl-5 text-left"
                id={`${baseId}-tab-${useCase.id}`}
                key={useCase.id}
                onClick={() => setSelectedIndex(index)}
                ref={(node) => {
                  tabs.current[index] = node;
                }}
                role="tab"
                tabIndex={isSelected ? 0 : -1}
                type="button"
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-y-0 -left-px w-0.5 transition-colors",
                    isSelected ? "bg-gray-1000" : "bg-transparent group-hover:bg-gray-alpha-600",
                  )}
                />
                <span
                  className={`flex items-center gap-2.5 text-heading-16 transition-colors ${
                    isSelected ? "text-gray-1000" : "text-gray-900 group-hover:text-gray-1000"
                  }`}
                >
                  <span className={cn("flex", !isSelected && "opacity-70")}>{useCase.logo}</span>
                  {useCase.name}
                </span>
                <span className="text-copy-14 text-gray-900">{useCase.text}</span>
              </button>
            );
          })}
        </div>

        <div
          aria-labelledby={`${baseId}-tab-${selected.id}`}
          className="flex min-w-0 flex-col gap-6 lg:col-span-8"
          id={`${baseId}-panel`}
          role="tabpanel"
        >
          <Frame className="flex h-[30rem] flex-col sm:h-[24rem]">{selected.preview}</Frame>
          <Button
            className="w-fit self-end rounded-full"
            href={selected.template ? templatePath(selected.template) : canonicalRoutes.templates}
            onClick={() =>
              track(analyticsEvents.templateOpened, {
                source: "home_examples",
                template: selected.template ?? "gallery",
              })
            }
            size="large"
            suffix={<IconChevronRightSmall size={16} />}
          >
            {selected.cta}
          </Button>
        </div>
      </div>
    </HomeSection>
  );
}
