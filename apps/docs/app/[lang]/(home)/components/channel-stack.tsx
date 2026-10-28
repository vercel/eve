"use client";

import { SiWhatsapp } from "@icons-pack/react-simple-icons";
import { type JSX, type ReactNode, useEffect, useState } from "react";
import { logos } from "@/lib/integrations/logos";
import { cn } from "@/lib/utils";
import { monochromeLogo } from "./control-visual";

// The chat previews follow chat-sdk.dev's: the same agent reply, drawn in each platform's way.

function Mention({ children }: { children: string }) {
  return (
    <span className="rounded-[4px] bg-blue-200 px-1 font-medium text-blue-900">@{children}</span>
  );
}

function ChatButton({ children, primary }: { children: string; primary?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center justify-center rounded-md px-3 font-medium text-label-13",
        primary
          ? "bg-gray-1000 text-background-100"
          : "bg-background-100 text-gray-1000 shadow-[0_0_0_1px_var(--ds-gray-alpha-400)]",
      )}
    >
      {children}
    </span>
  );
}

function Message({
  avatar,
  name,
  badge,
  round,
  dark,
  children,
}: {
  avatar: string;
  name: string;
  badge?: string;
  round?: boolean;
  dark?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center font-medium text-label-12",
          round ? "rounded-full" : "rounded-md",
          dark ? "bg-gray-1000 text-background-100" : "bg-gray-200 text-gray-1000",
        )}
      >
        {avatar}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-gray-1000 text-label-13">{name}</span>
          {badge ? (
            <span className="rounded-[4px] bg-gray-200 px-1 py-px font-medium text-[10px] text-gray-900 uppercase leading-none tracking-wide">
              {badge}
            </span>
          ) : null}
          <span className="text-gray-900 text-label-12">9:41 AM</span>
        </div>
        <div className="mt-0.5 text-pretty text-copy-13 text-gray-1000">{children}</div>
      </div>
    </div>
  );
}

const question = "can we ship PR #103?";
const title = "Deploy to production?";
const detail = "PR #103 passed every check.";

function SlackChat() {
  return (
    <>
      <Message avatar="A" name="Alice">
        <Mention>Coder</Mention> {question}
      </Message>
      <Message avatar="C" badge="App" dark name="Coder">
        <p className="mt-1 font-semibold text-copy-14">{title}</p>
        <p className="mt-1 text-gray-900">{detail}</p>
        <div className="mt-2.5 flex gap-2">
          <ChatButton primary>Approve</ChatButton>
          <ChatButton>Cancel</ChatButton>
        </div>
      </Message>
    </>
  );
}

function TeamsChat() {
  return (
    <>
      <Message avatar="A" name="Alice" round>
        <Mention>Coder</Mention> {question}
      </Message>
      <Message avatar="C" dark name="Coder" round>
        <div className="mt-1.5 max-w-[22rem] rounded-lg p-3 shadow-[0_0_0_1px_var(--ds-gray-alpha-400)]">
          <p className="font-semibold text-copy-14">{title}</p>
          <p className="mt-1 text-gray-900">{detail}</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <ChatButton primary>Approve</ChatButton>
            <ChatButton>Cancel</ChatButton>
          </div>
        </div>
      </Message>
    </>
  );
}

function WhatsAppChat() {
  return (
    <>
      <div className="max-w-[min(85%,20rem)] self-end text-pretty rounded-xl rounded-br-sm bg-gray-1000 px-3 py-2 text-background-100 text-copy-13">
        Can we ship PR #103?
      </div>
      <div className="flex w-full max-w-[min(85%,20rem)] flex-col gap-1">
        <div className="text-pretty rounded-xl rounded-bl-sm bg-gray-100 px-3 py-2 text-copy-13 text-gray-1000">
          <p className="font-semibold">{title}</p>
          <p className="mt-0.5">{detail}</p>
        </div>
        <span className="inline-flex h-8 items-center justify-center rounded-lg bg-background-100 font-medium text-gray-1000 text-label-13 shadow-[0_0_0_1px_var(--ds-gray-alpha-400)]">
          Approve
        </span>
        <span className="inline-flex h-8 items-center justify-center rounded-lg bg-background-100 font-medium text-gray-1000 text-label-13 shadow-[0_0_0_1px_var(--ds-gray-alpha-400)]">
          Cancel
        </span>
      </div>
    </>
  );
}

const SCREENS: { platform: string; channel: string; logo: ReactNode; chat: ReactNode }[] = [
  {
    platform: "Slack",
    channel: "#deploys",
    logo: logos.slack({ "aria-hidden": true, className: monochromeLogo }),
    chat: <SlackChat />,
  },
  {
    platform: "Microsoft Teams",
    channel: "Engineering",
    logo: logos.teams({ "aria-hidden": true, className: monochromeLogo }),
    chat: <TeamsChat />,
  },
  {
    platform: "WhatsApp",
    channel: "Coder",
    logo: <SiWhatsapp aria-hidden />,
    chat: <WhatsAppChat />,
  },
];

const CYCLE_MS = 4000;
// Each step back lifts a window by the height of its header and narrows it, so only that
// header shows above the window in front.
const STEP_PX = 40;
const STEP_SCALE = 0.06;

/**
 * Slack, Teams, and WhatsApp windows stacked front to back, each showing the same agent
 * reply. The front window cycles to the back on a timer, paused on hover and focus and
 * without reduced motion; a back window's header brings it to the front.
 */
export function ChannelStack(): JSX.Element {
  const [front, setFront] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setFront((i) => (i + 1) % SCREENS.length), CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [paused]);

  return (
    <div
      aria-label="The same agent reply in Slack, Microsoft Teams, and WhatsApp"
      aria-roledescription="carousel"
      className="relative"
      onBlur={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role="region"
      style={{ paddingTop: STEP_PX * (SCREENS.length - 1) }}
    >
      <div className="relative h-[19rem]">
        {SCREENS.map((screen, i) => {
          const depth = (i - front + SCREENS.length) % SCREENS.length;
          const isFront = depth === 0;
          return (
            <section
              aria-hidden={!isFront}
              aria-label={`${screen.platform} preview`}
              className="absolute inset-0 overflow-hidden rounded-xl border border-gray-alpha-400 bg-background-100 shadow-sm transition-[transform,opacity] duration-500 ease-out motion-reduce:transition-none"
              key={screen.platform}
              style={{
                opacity: 1 - depth * 0.15,
                transform: `translateY(${-depth * STEP_PX}px) scale(${1 - depth * STEP_SCALE})`,
                transformOrigin: "top center",
                zIndex: SCREENS.length - depth,
              }}
            >
              <button
                aria-label={isFront ? undefined : `Show ${screen.platform}`}
                className={cn(
                  "flex h-10 w-full items-center gap-2 border-gray-alpha-400 border-b px-4 text-left text-copy-13 [&>svg]:size-4 [&>svg]:shrink-0",
                  isFront ? "cursor-default" : "cursor-pointer",
                )}
                disabled={isFront}
                onClick={() => setFront(i)}
                tabIndex={isFront ? -1 : 0}
                type="button"
              >
                {screen.logo}
                <span className="font-medium text-gray-1000">{screen.platform}</span>
                <span className="text-gray-900">{screen.channel}</span>
              </button>
              <div
                className={cn(
                  "flex flex-col gap-4 p-6 transition-opacity duration-500",
                  isFront ? "opacity-100" : "opacity-0",
                )}
              >
                {screen.chat}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
