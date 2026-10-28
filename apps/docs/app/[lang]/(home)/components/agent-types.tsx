"use client";

import { IconPlusCircle } from "@vercel/geistdocs/assets/icons";
import { track } from "@vercel/analytics";
import { Brain, ChevronRight, Factory, GitPullRequestDraft } from "lucide-react";
import { Button } from "@vercel/geistdocs/components/button";
import {
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { analyticsEvents } from "@/lib/analytics/events";
import { canonicalRoutes, templatePath } from "@/lib/geistdocs/canonical";
import { logos, voiceLogo } from "@/lib/integrations/logos";
import { cn } from "@/lib/utils";
import {
  type Author,
  Card,
  DemoButton,
  Mention,
  Reaction,
  SlackMessage,
  Tail,
  TypingIndicator,
  bubbleRadius,
} from "./chat";
import { AppWindow, HomeSection, PrefetchLink } from "./section";

const logoClassName = "size-3.5 shrink-0 grayscale";

const FACTORY_STATIONS = [
  { name: "classifier", running: "Classifying the report", result: "Bug, small scope" },
  {
    name: "analyst",
    running: "Tracing the cause",
    result: "Traced it to the cart merge on sign-in",
  },
  {
    name: "implementer",
    running: "Writing the fix",
    result: "Pushed eve/eng-142, 6 checks passed",
  },
  { name: "reviewer", running: "Reviewing the change", result: "Approved after 1 fix" },
  {
    name: "open_pr",
    running: "Opening a draft pull request",
    result: "Opened draft #318 on acme/storefront",
  },
];

/**
 * How long each stage of the demo waits before it shows: Sam's report, the foreman working,
 * its reply with the ticket, each station running then finishing, opening the pull request,
 * then its card.
 */
const FACTORY_DEMO = [500, 700, 1200, 1000, 900, 900, 1100, 900, 1000, 600];

const SAM: Author = { name: "Sam" };
const FOREMAN: Author = { name: "foreman", icon: Factory };

// The hero's Slack agents are purple; the factory's foreman is one of them.
const foremanAvatar = "bg-purple-700";

/**
 * A bug a teammate reports in Slack becomes a Linear ticket, which the factory picks up on its
 * own and works through its stations into a draft pull request. In the demo it builds up
 * stage by stage (`stage` counts the stages shown); otherwise it shows in full.
 */
function SoftwareFactoryPreview({ stage }: { stage?: number }) {
  const demo = stage !== undefined;
  const shown = stage ?? FACTORY_DEMO.length;
  const reviewing = shown >= 10;
  return (
    <ol className="m-0 flex list-none flex-col p-0 px-4 pb-4 [--reply-width:24rem]">
      {shown >= 1 ? (
        <SlackMessage
          author={SAM}
          avatarColor={foremanAvatar}
          className={cn(demo && messageIn)}
          continued={false}
          time="10:02 AM"
        >
          <p>Saved carts disappear after I sign in at checkout.</p>
        </SlackMessage>
      ) : null}
      {shown === 2 ? (
        <li className={cn("pt-3 pl-[2.375rem]", fadeIn)}>
          <TypingIndicator author={FOREMAN} />
        </li>
      ) : null}
      {shown >= 3 ? (
        <SlackMessage
          author={FOREMAN}
          avatarColor={foremanAvatar}
          className={cn(demo && agentMessageIn)}
          continued={false}
          time="10:02 AM"
        >
          <p>Filed it and picked it up.</p>
          <Card
            icon={logos.linear({ "aria-hidden": true })}
            meta={`Reported by Sam · ${reviewing ? "In review" : "In progress"}`}
            title="ENG-142 Saved carts disappear after sign-in"
          />
          <RunSteps
            className="mt-2"
            demo={demo}
            ran={demo ? shown - 4 : undefined}
            steps={FACTORY_STATIONS}
          />
          {reviewing ? (
            <div className={cn(demo && fadeIn)}>
              <Card
                icon={<GitPullRequestDraft />}
                meta="acme/storefront#318 · draft, ready for review"
                title="fix(cart): keep guest items after sign-in"
              />
            </div>
          ) : null}
        </SlackMessage>
      ) : null}
    </ol>
  );
}

// The hero gives Slack agents purple and Teams agents blue; the brain takes teal.
const brainAvatar = "bg-teal-700";

const BRAIN_STEPS = [
  {
    name: "list_models",
    running: "Finding models",
    result: "Found customers, orders, and payments",
  },
  {
    name: "get_model",
    running: "Reading the orders model",
    result: "Read the docs for the orders model",
  },
  { name: "query_sql", running: "Running a query", result: "Ran 1 query, returned 3 rows" },
];

const BRAIN_ROWS = [
  { month: "August", orders: 412, repeat: "38%" },
  { month: "September", orders: 455, repeat: "41%" },
  { month: "October", orders: 498, repeat: "44%" },
];

const DANA: Author = { name: "Dana" };
const BRAIN: Author = { name: "company-brain", icon: Brain };

/**
 * How long each stage of the demo waits before it shows: Dana's question, the agent working,
 * its reply with the first tool running, each tool finishing as the next runs, the answer,
 * the table, Dana's thumbs-up, her follow-up, then the agent's reply in its thread.
 */
const BRAIN_DEMO = [500, 700, 1200, 900, 900, 1000, 500, 600, 1100, 1300, 1600];

// Dana's follow-up and its thread only come in the demo; shown in full, the thread ends with
// her thumbs-up.
const FOLLOW_UP = 10;

// Entrances run only in the demo; shown in full, the thread is simply there.
const fadeIn = "animate-command-fade-in";
// The hero's message entrances: people's from 75%, the agent's wider replies from 90%.
const messageIn = "origin-top-left motion-safe:animate-bubble-in motion-reduce:animate-fade-in";
const agentMessageIn = `${messageIn} [--bubble-from:0.9]`;

/**
 * Tools or stations that each show running, shimmering, a stage before they finish. `ran`
 * counts the demo's stages since the first one started; unset, they're all done.
 */
function RunSteps({
  steps,
  ran = Number.POSITIVE_INFINITY,
  demo,
  className,
}: {
  steps: { name: string; running: string; result: string }[];
  ran?: number;
  demo: boolean;
  className?: string;
}) {
  return (
    <ul className={cn("m-0 flex list-none flex-col gap-0.5 p-0", className)}>
      {steps.map((step, index) => {
        if (ran < index) return null;
        const done = ran >= index + 1;
        return (
          <li
            className={cn("flex items-baseline gap-3 text-copy-13", demo && fadeIn)}
            key={step.name}
          >
            <code className="w-24 shrink-0 font-mono text-copy-13-mono text-gray-1000">
              {step.name}
            </code>
            {/* Keyed by state, so the result fades in over the running label. */}
            <span
              className={cn("truncate", done ? "text-gray-900" : "thinking-loader", demo && fadeIn)}
              key={done ? "done" : "running"}
            >
              {done ? step.result : step.running}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The hero's Slack thread, with the company brain on its own avatar color. In the demo it
 * builds up stage by stage (`stage` counts the stages shown); otherwise it shows up to the
 * follow-up.
 */
function CompanyBrainPreview({ stage }: { stage?: number }) {
  const demo = stage !== undefined;
  const shown = stage ?? FOLLOW_UP - 1;
  const list = useRef<HTMLDivElement>(null);
  // Which edges have messages scrolled past them, so only those edges fade, as in the hero.
  const [overflow, setOverflow] = useState({ above: false, below: false });

  const measure = () => {
    const node = list.current;
    if (!node) return;
    const above = node.scrollTop > 1;
    const below = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    setOverflow((o) => (o.above === above && o.below === below ? o : { above, below }));
  };

  // A demo follows the conversation down as it grows; shown in full, it opens at its start.
  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    if (demo) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    else node.scrollTop = 0;
    measure();
  }, [demo, shown]);

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none]"
      data-conversation
      onScroll={measure}
      ref={list}
      style={{
        maskImage: `linear-gradient(to bottom, ${overflow.above ? "transparent, black 40px" : "black"}, ${overflow.below ? "black calc(100% - 40px), transparent" : "black"})`,
      }}
    >
      <ol className="m-0 flex list-none flex-col p-0 px-4 pb-3 [--reply-width:34rem]">
        {shown >= 1 ? (
          <SlackMessage
            author={DANA}
            avatarColor={brainAvatar}
            className={cn(demo && messageIn)}
            continued={false}
            time="9:41 AM"
          >
            <p>
              <Mention>company-brain</Mention> how are repeat orders trending this quarter?
            </p>
          </SlackMessage>
        ) : null}
        {shown === 2 ? (
          <li className={cn("pt-3 pl-[2.375rem]", fadeIn)}>
            <TypingIndicator author={BRAIN} />
          </li>
        ) : null}
        {shown >= 3 ? (
          <SlackMessage
            author={BRAIN}
            avatarColor={brainAvatar}
            className={cn(
              // Dana's questions run a line each; the agent's answer keeps to its table's width.
              "[--reply-width:24rem]",
              demo && agentMessageIn,
            )}
            continued={false}
            time="9:41 AM"
          >
            <RunSteps
              className="mt-1"
              demo={demo}
              ran={demo ? shown - 3 : undefined}
              steps={BRAIN_STEPS}
            />
            {shown >= 7 ? (
              <p className={cn("mt-2", demo && fadeIn)}>
                Repeat customers placed 44% of orders in October, up from 38% in August.
              </p>
            ) : null}
            {shown >= 8 ? (
              <div
                className={cn(
                  "mt-2 rounded-lg border border-gray-alpha-400 bg-background-100 px-3 py-1",
                  demo && fadeIn,
                )}
              >
                <table className="w-full border-collapse text-left text-copy-13 tabular-nums">
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
                    {BRAIN_ROWS.map((row, index) => (
                      <tr
                        className={cn(
                          "border-gray-alpha-400 border-b last:border-b-0",
                          demo && fadeIn,
                        )}
                        key={row.month}
                        // Rows follow the card in, 60ms apart; inline, since the animation
                        // shorthand would reset a class-set delay.
                        style={demo ? { animationDelay: `${(index + 1) * 60}ms` } : undefined}
                      >
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
            ) : null}
          </SlackMessage>
        ) : null}
        {shown >= 9 ? (
          <li className="pt-1.5 pl-[2.375rem]">
            <Reaction count={1} demo={demo} name="+1">
              {/* A fixed box on its own layer, so the glyph scales smoothly in the pop instead of
                snapping to the pixel grid frame by frame. */}
              <span
                aria-label=":+1:"
                className="inline-flex size-4 items-center justify-center text-[14px] leading-none will-change-transform"
                role="img"
              >
                👍
              </span>
            </Reaction>
          </li>
        ) : null}
        {shown >= FOLLOW_UP ? (
          <SlackMessage
            author={DANA}
            avatarColor={brainAvatar}
            className={cn(demo && messageIn)}
            continued={false}
            time="9:44 AM"
          >
            <p>
              <Mention>company-brain</Mention> can you split October by payment method?
            </p>
            {shown >= FOLLOW_UP + 1 ? <ThreadReply demo={demo} /> : null}
          </SlackMessage>
        ) : null}
      </ol>
    </div>
  );
}

/**
 * Slack's thread summary under a message, the replier's avatar, "1 reply", and an unread dot,
 * opening like an accordion onto the reply it hides.
 */
function ThreadReply({ demo }: { demo: boolean }) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  // Once open, the conversation scrolls the reply into view as the panel finishes growing.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const list = panel.current?.closest("[data-conversation]");
      list?.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    }, 200);
    return () => clearTimeout(timer);
  }, [open]);

  const id = useId();
  return (
    <>
      <button
        aria-controls={id}
        aria-expanded={open}
        className={cn(
          // Pulled out by its border and padding, so the avatar lines up with the message text.
          "group -ml-[5px] mt-1 flex w-full cursor-pointer items-center gap-2 rounded-lg border border-transparent p-1 pr-2 text-left transition-colors hover:border-gray-alpha-400 hover:bg-background-100 focus-visible:border-gray-alpha-400 focus-visible:outline-none",
          demo && fadeIn,
        )}
        onClick={() => {
          setOpen(!open);
          setRead(true);
        }}
        type="button"
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-teal-700 text-white">
          <Brain aria-hidden className="size-3" />
        </span>
        <span className="font-medium text-blue-900 text-copy-13">1 reply</span>
        {/* Unread until opened; hovering, or once read, shows when the reply came instead. */}
        {read ? null : (
          <span className="flex items-center gap-1 text-copy-13 text-red-900 group-hover:hidden group-focus-visible:hidden">
            <span aria-hidden className="size-1.5 rounded-full bg-red-800" />
            Unread
          </span>
        )}
        <span
          className={`text-copy-13 text-gray-900 ${read ? "" : "hidden group-hover:inline group-focus-visible:inline"}`}
        >
          Today at 9:44 AM
        </span>
        <ChevronRight
          aria-hidden
          className={cn(
            "ml-auto size-4 shrink-0 text-gray-900 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
            open && "rotate-90",
          )}
        />
      </button>
      {/* Grows from no height to the reply's, by transitioning the row from 0fr to 1fr. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
        id={id}
        inert={!open}
        ref={panel}
      >
        <div className="min-h-0 overflow-hidden">
          <ol className="m-0 mt-1 list-none border-gray-alpha-400 border-l-2 p-0 pl-3">
            <SlackMessage
              author={BRAIN}
              avatarColor={brainAvatar}
              className="pt-2"
              continued={false}
              time="9:44 AM"
            >
              <p>Credit card 56%, bank transfer 21%, coupon 14%, and gift card 9%.</p>
            </SlackMessage>
          </ol>
        </div>
      </div>
    </>
  );
}

// A fixed, hand-shaped envelope so the waveform renders identically on server and client.
const WAVEFORM = [3, 6, 10, 14, 9, 16, 20, 13, 7, 4, 8, 13, 18, 12, 7, 4, 3, 6, 11, 15, 9, 5, 3];

/** Customer support chat docked in a product, shown inside a browser window. */
function WebAppClient() {
  return (
    <AppWindow
      className="min-h-0"
      title={
        <span className="block truncate rounded-md bg-gray-alpha-200 px-3 py-0.5 text-gray-900 text-label-12">
          app.acme.com/orders
        </span>
      }
    >
      <div className="@container relative min-h-0 flex-1 p-3">
        {/* An orders dashboard in the skeleton style of "Own your agent UI": real heading and
            figures, gray bars for everything else. The KPI cards only show once the window is
            wide enough to keep them clear of the chat. */}
        <div aria-hidden className="hidden select-none flex-col gap-2 sm:flex">
          <span className="font-medium text-copy-14 text-gray-1000">Orders</span>
          <span className="mt-1 hidden grid-cols-3 gap-2 @[20rem]:grid">
            {["1,284", "$48.2k", "96%"].map((metric) => (
              <span
                className="flex flex-col gap-2 rounded-md border border-gray-alpha-400 p-2.5"
                key={metric}
              >
                <span className="font-medium text-copy-16 text-gray-1000 tabular-nums">
                  {metric}
                </span>
                <span className="h-2 w-2/3 rounded-[3px] bg-gray-200" />
              </span>
            ))}
          </span>
          {/* Fades out downward, and to the right before the chat's 14rem plus a 1rem gap. */}
          <span className="hidden h-24 rounded-md border border-gray-alpha-400 [mask-composite:intersect] [mask-image:linear-gradient(to_bottom,black,transparent),linear-gradient(to_right,black_calc(100%_-_21rem),transparent_calc(100%_-_15rem))] @[20rem]:block" />
        </div>
        <div className="absolute inset-x-3 bottom-3 flex flex-col gap-3.5 rounded-lg p-1.5 material-menu sm:left-auto sm:w-56 sm:max-w-[calc(100%-1.5rem)]">
          <span className="text-label-12 text-gray-900">Acme support</span>
          {/* The hero's WhatsApp bubble shape, in this chat's colors. */}
          <p
            className="relative ml-auto bg-gray-1000 px-3 py-2 text-copy-13 text-background-100"
            style={{ borderRadius: bubbleRadius }}
          >
            <Tail className="text-gray-1000" flipped />
            Where's my order #4821?
          </p>
          <p
            className="relative bg-gray-alpha-200 px-3 py-2 text-copy-13 text-gray-1000"
            style={{ borderRadius: bubbleRadius }}
          >
            <Tail className="text-gray-alpha-200" />
            It shipped yesterday and arrives Thursday.
          </p>
        </div>
      </div>
    </AppWindow>
  );
}

/** A phone call to a clinic's front desk, with live waveform and call controls. */
function VoiceClient() {
  return (
    <div className="@container flex flex-col gap-3 p-3 material-large">
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
        <span aria-hidden className="ml-auto hidden h-6 items-center gap-[3px] @sm:flex">
          {WAVEFORM.map((height, i) => (
            <span
              className="w-[2px] rounded-full bg-gray-alpha-600"
              // Bars are positional; the array never reorders.
              key={i}
              style={{ height: `${height}px` }}
            />
          ))}
        </span>
        <span className="ml-auto hidden shrink-0 rounded-full bg-red-700 px-3 py-1 text-label-12 text-white @[16rem]:inline @sm:ml-3">
          End
        </span>
      </div>
      <p className="text-copy-13 text-gray-900">
        <span className="text-gray-1000">Agent</span> Done, you're moved to Friday at 10:00.
      </p>
    </div>
  );
}

// iMessage's own colors, so the thread reads as iMessage rather than a generic chat. Each tail
// takes its bubble's fill as its text color.
const sentBubble = {
  bubble: "ml-auto bg-[#007AFF] text-white dark:bg-[#0A84FF]",
  tail: "text-[#007AFF] dark:text-[#0A84FF]",
};
const receivedBubble = {
  bubble: "bg-[#E9E9EB] text-black dark:bg-[#26252A] dark:text-white",
  tail: "text-[#E9E9EB] dark:text-[#26252A]",
};

const IMESSAGE_THREAD: { sent: boolean; text: string }[] = [
  { sent: true, text: "Dinner with Sam on Friday?" },
  { sent: false, text: "Luna has a table at 7. Want it?" },
  { sent: true, text: "Yes please" },
  { sent: false, text: "Booked and added to your calendar." },
];

/** A personal planning thread in an iMessage-style app. */
function IMessageClient() {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden material-large">
      <div className="flex shrink-0 flex-col items-center gap-1 border-gray-alpha-400 border-b py-2.5">
        <span className="flex size-8 items-center justify-center rounded-full bg-gradient-to-b from-[#A5A9B4] to-[#858994] font-medium text-[13px] text-white dark:from-[#636366] dark:to-[#48484A]">
          P
        </span>
        <span className="text-label-12 text-gray-1000">Planner</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-3 text-copy-13">
        {IMESSAGE_THREAD.map((message) => {
          const colors = message.sent ? sentBubble : receivedBubble;
          return (
            <p
              className={`relative max-w-[85%] text-pretty px-3 py-1.5 ${colors.bubble}`}
              key={message.text}
              style={{ borderRadius: bubbleRadius }}
            >
              <Tail className={colors.tail} flipped={message.sent} />
              <span className="sr-only">{message.sent ? "You: " : "Agent: "}</span>
              {message.text}
            </p>
          );
        })}
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
    <figure className="grid h-full grid-cols-[minmax(0,1fr)_9.5rem] gap-3 sm:grid-cols-[minmax(0,1fr)_13rem] sm:gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
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
  /** What the agent does, a short title and line each. */
  features: { title: string; text: string }[];
  /** The example draws its own windows, so it skips the shared one. */
  ownWindows?: boolean;
  /** Stage delays for a "Play demo" replay, for an example that has one. */
  demo?: number[];
  /** The example; `stage` is set while a demo plays or after it ends. */
  preview: (stage?: number) => ReactNode;
}

const USE_CASES: UseCase[] = [
  {
    id: "company-brain",
    name: "Company brain",
    text: "Build a Slack agent that answers your team's business questions from your documented dbt models.",
    template: "eve-company-brain-template",
    cta: "Use the company brain template",
    features: [
      { title: "Answers in Slack", text: "Only for the people and channels you allow." },
      { title: "Grounded in dbt", text: "Reads your model docs before it writes a query." },
      { title: "Read-only SQL", text: "Queries DuckDB or MotherDuck, and never writes to them." },
    ],
    demo: BRAIN_DEMO,
    preview: (stage) => <CompanyBrainPreview stage={stage} />,
  },
  {
    id: "software-factory",
    name: "Software factory",
    text: "Build an agent that turns issues into reviewed draft pull requests, from triage and planning to implementation.",
    template: "eve-software-factory-template",
    cta: "Use the software factory template",
    features: [
      { title: "GitHub and Linear", text: "Picks up tasks where your team already files them." },
      {
        title: "Four stations",
        text: "Classifier, analyst, implementer, and reviewer subagents work each task.",
      },
      {
        title: "Draft pull requests",
        text: "Every task ends in a reviewed draft on your repository.",
      },
    ],
    demo: FACTORY_DEMO,
    preview: (stage) => <SoftwareFactoryPreview stage={stage} />,
  },
  {
    id: "agentic-apps",
    name: "Agentic apps",
    text: "Agents inside your product, over web, voice, or iMessage, with memory for every user.",
    template: null,
    cta: "Browse app templates",
    features: [
      { title: "Web chat", text: "Inside your app, with long-term memory for each user." },
      { title: "Voice", text: "Calls that run tools and ask for approval." },
      { title: "iMessage", text: "Threads that share memory with web and Slack." },
    ],
    ownWindows: true,
    preview: () => <AgenticAppsPreview />,
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
  // The demo's stage while it plays, kept after it ends; unset shows the example in full.
  const [demo, setDemo] = useState<{ stage: number; playing: boolean }>();

  useEffect(() => {
    const delays = selected.demo;
    if (!demo?.playing || !delays) return;
    if (demo.stage >= delays.length) {
      setDemo({ stage: demo.stage, playing: false });
      return;
    }
    const timer = setTimeout(
      () => setDemo({ stage: demo.stage + 1, playing: true }),
      delays[demo.stage],
    );
    return () => clearTimeout(timer);
  }, [demo, selected]);

  const select = (index: number) => {
    setSelectedIndex(index);
    setDemo(undefined);
  };

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
          <UseCaseTabs baseId={baseId} onSelect={select} selectedIndex={selectedIndex} />
        </div>
        <div className="grid gap-4 lg:grid-cols-12 lg:gap-x-6">
          {/* Every use case's text shares one grid cell, so the column keeps the tallest one's
              height and switching tabs never shifts the layout. Beside the window, from its top
              and a column clear of it, on wide screens; above it when stacked. */}
          <div className="grid lg:col-span-4 lg:col-start-9 lg:row-start-1">
            {USE_CASES.map((useCase) => (
              <div
                className={cn(
                  "col-start-1 row-start-1 flex flex-col gap-8",
                  useCase !== selected && "invisible",
                )}
                key={useCase.id}
              >
                <p className="text-pretty text-copy-18 text-gray-1000">{useCase.text}</p>
                <ul className="m-0 flex list-none flex-col gap-5 p-0">
                  {useCase.features.map((feature) => (
                    <li className="flex flex-col gap-1" key={feature.title}>
                      <span className="font-[450] text-copy-16 text-gray-1000">
                        {feature.title}
                      </span>
                      <span className="text-pretty text-copy-16 text-gray-900">{feature.text}</span>
                    </li>
                  ))}
                </ul>
                {useCase.demo ? (
                  // Pulled out by its padding and icon inset, so the icon lines up with the text.
                  <DemoButton
                    className="-ml-2 self-start"
                    onClick={() => setDemo(demo?.playing ? undefined : { stage: 0, playing: true })}
                    playing={Boolean(demo?.playing)}
                  />
                ) : null}
              </div>
            ))}
          </div>
          <div
            aria-labelledby={`${baseId}-tab-${selected.id}`}
            className="min-w-0 lg:col-span-7 lg:row-start-1"
            id={`${baseId}-panel`}
            role="tabpanel"
          >
            {selected.ownWindows ? (
              <div className="h-[30rem] sm:h-[26rem]">{selected.preview()}</div>
            ) : (
              <AppWindow className="h-[30rem] sm:h-[26rem]">
                {selected.preview(demo?.stage)}
              </AppWindow>
            )}
          </div>
        </div>
      </div>
    </HomeSection>
  );
}
