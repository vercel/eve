"use client";

import {
  IconBrain,
  IconBuildings,
  IconChevronRight,
  IconGitMerge,
  IconGitPullRequest,
  IconPlusCircle,
} from "@vercel/geistdocs/assets/icons";
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
import { logos, voiceLogo } from "@/lib/integrations/logos";
import { templateGalleryUrl } from "@/lib/templates/links";
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
import { AppWindow, HomeSection } from "./section";

const logoClassName = "size-3.5 shrink-0 grayscale";

const FACTORY_STATIONS = [
  {
    name: "implementer",
    running: "Writing the fix",
    result: "Fixed the cart merge on sign-in, 6 checks passed",
  },
  { name: "reviewer", running: "Reviewing the change", result: "Approved after 1 fix" },
  {
    name: "open_pr",
    running: "Opening a draft pull request",
    result: "Opened draft #318 on acme/storefront",
  },
];

/**
 * How long each stage of the demo waits before it shows: the user's report, the foreman
 * working, its reply with the ticket, each station running then finishing, opening the pull
 * request, its card, the reporter's approval, then the foreman closing the ticket.
 */
const FACTORY_DEMO = [500, 700, 1200, 1100, 1000, 1100, 1000, 600, 1400, 1000];

// The stages that bring the pull request's card, the reporter's approval, and the close.
const FACTORY_PR = 8;
const FACTORY_APPROVED = 9;
const FACTORY_CLOSED = 10;

const FEEDBACK: Author = { name: "User feedback" };
const FOREMAN: Author = { name: "foreman", icon: IconBuildings };

// The hero's Slack agents are purple; the factory's foreman is one of them.
const foremanAvatar = "bg-purple-700";

/**
 * Slack's :ballot_box_with_check:, the reporter's approval, drawn rather than typed so it
 * looks the same on every platform. On its own layer, like the thumbs-up, so it scales smoothly.
 */
function ApprovalEmoji() {
  return (
    <svg
      aria-label=":ballot_box_with_check:"
      className="size-4 will-change-transform"
      fill="none"
      role="img"
      viewBox="0 0 16 16"
    >
      <circle cx="8" cy="8" fill="var(--ds-blue-700)" r="8" />
      <path
        d="m4.5 8.25 2.25 2.25 4.75-5"
        stroke="white"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  );
}

/**
 * A bug a user reports through feedback in Slack becomes a Linear ticket, which the factory
 * picks up on its own and works through its stations into a draft pull request; once the
 * reporter approves, it merges and closes the ticket. In the demo it builds up stage by stage
 * (`stage` counts the stages shown); otherwise it shows in full.
 */
function SoftwareFactoryPreview({ stage }: { stage?: number }) {
  const demo = stage !== undefined;
  const shown = stage ?? FACTORY_DEMO.length;
  const closed = shown >= FACTORY_CLOSED;
  const status = closed ? "Done" : shown >= FACTORY_PR ? "In review" : "In progress";
  return (
    <ol className="m-0 flex list-none flex-col p-0 px-4 pb-4 [--reply-width:27.5rem]">
      {shown >= 1 ? (
        <SlackMessage
          author={FEEDBACK}
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
          <p>Created Linear ticket and picked it up.</p>
          <Card
            icon={logos.linear({ "aria-hidden": true })}
            meta={`From user feedback · ${status}`}
            title="ENG-142 Saved carts disappear after sign-in"
          />
          <RunSteps
            className="mt-2"
            demo={demo}
            ran={demo ? shown - 4 : undefined}
            steps={FACTORY_STATIONS}
          />
          {shown >= FACTORY_PR ? (
            <div className={cn(demo && fadeIn)}>
              <Card
                icon={closed ? <IconGitMerge /> : <IconGitPullRequest />}
                meta={`acme/storefront#318 · ${closed ? "merged" : "draft, ready for review"}`}
                title="fix(cart): keep guest items after sign-in"
              />
            </div>
          ) : null}
        </SlackMessage>
      ) : null}
      {shown >= FACTORY_APPROVED ? (
        <li className="pt-1.5 pl-[2.375rem]">
          <Reaction count={1} demo={demo} name="ballot_box_with_check">
            <ApprovalEmoji />
          </Reaction>
        </li>
      ) : null}
      {shown >= FACTORY_CLOSED ? (
        <SlackMessage
          author={FOREMAN}
          avatarColor={foremanAvatar}
          className={cn(demo && agentMessageIn)}
          continued
          time="10:09 AM"
        >
          <p>Merged #318 and closed ENG-142.</p>
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
const BRAIN: Author = { name: "company-brain", icon: IconBrain };

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
  const content = useRef<HTMLOListElement>(null);
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

  // Resizing the box or reflowing its text can start or stop the overflow without a scroll
  // event, and the overflow decides whether the box contains the page's scroll.
  useEffect(() => {
    const frame = list.current;
    const messages = content.current;
    if (!(frame && messages)) return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(messages);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      // Contain scrolling only while there is something to scroll: Chrome 144+ applies
      // overscroll-behavior to non-overflowing scroll containers, which would trap the page's
      // wheel scroll over a conversation that fits.
      className={cn(
        "min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]",
        (overflow.above || overflow.below) && "overscroll-contain",
      )}
      data-conversation
      onScroll={measure}
      ref={list}
      style={{
        maskImage: `linear-gradient(to bottom, ${overflow.above ? "transparent, black 40px" : "black"}, ${overflow.below ? "black calc(100% - 40px), transparent" : "black"})`,
      }}
    >
      <ol className="m-0 flex list-none flex-col p-0 px-4 pb-3 [--reply-width:34rem]" ref={content}>
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
              "[--reply-width:27.5rem]",
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
              <p className={cn("mt-2 text-pretty", demo && fadeIn)}>
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
          <IconBrain aria-hidden className="size-3" />
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
        <IconChevronRight
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

// WhatsApp's voice recorder: every tenth of a second a bar for the voice's level joins at the
// right and the bars scroll left, a 2px bar and a 3px gap each, across a 156px strip.
const BAR_MS = 100;
const BAR_PITCH = 5;
const WAVE_WIDTH = 156;
const BAR_COUNT = WAVE_WIDTH / BAR_PITCH - 1;

/**
 * The voice's level at bar `t`, as a bar height in px: mostly full and a little uneven, with a
 * short silence of dots between phrases that ramps back up over a few bars. Pure, with integer
 * noise, so server and client draw the same.
 */
function voiceLevel(t: number) {
  const phrase = Math.abs(Math.sin(t / 11));
  const noise = (Math.imul(t + 1, 2654435761) >>> 0) / 2 ** 32;
  const swell = 0.85 + 0.15 * Math.sin(t / 2.3);
  return phrase < 0.1
    ? 2
    : Math.round(4 + 16 * Math.min(1, phrase * 3) * (0.6 + 0.4 * noise) * swell);
}

// The support chat's thread, and the follow-up the demo adds.
const WEB_THREAD = [
  { sent: true, text: "Where's my order #4821?" },
  { sent: false, text: "It shipped yesterday and arrives Thursday." },
];
const WEB_QUESTION = { sent: true, text: "Can it come Wednesday instead?" };
const WEB_ANSWER = { sent: false, text: "Done, it now arrives Wednesday." };

/** The hero's WhatsApp bubble shape, in the support chat's colors. */
function SupportBubble({
  sent,
  text,
  className = "",
}: {
  sent: boolean;
  text: string;
  className?: string;
}) {
  // Not through cn: tailwind-merge reads text-copy-13 and the text color as one conflict.
  return (
    <p
      className={`relative px-3 py-2 text-copy-13 ${
        sent ? "ml-auto bg-gray-1000 text-background-100" : "bg-gray-alpha-200 text-gray-1000"
      } ${className}`}
      style={{ borderRadius: bubbleRadius }}
    >
      <Tail className={sent ? "text-gray-1000" : "text-gray-alpha-200"} flipped={sent} />
      {text}
    </p>
  );
}

/**
 * Grows a message in from nothing, so whatever holds it eases its height up. It takes back the
 * stack's gap and grows it inside, and leaves room for the bubble's tail. Only on phones: from
 * md up, iMessage carries the demo's follow-up.
 */
function GrowIn({ children }: { children: ReactNode }) {
  return (
    <div className="-mt-2 grid motion-safe:animate-grow-in md:hidden">
      <div className="-mx-2 -mb-1 flex min-h-0 flex-col overflow-hidden px-2 pt-2 pb-1">
        {children}
      </div>
    </div>
  );
}

/** Customer support chat docked in a product, shown inside a browser window. */
function WebAppClient({ stage = 0 }: { stage?: number }) {
  const followUp = [
    ...(stage >= AGENTIC_ASKED ? [WEB_QUESTION] : []),
    ...(stage >= AGENTIC_ANSWERED ? [WEB_ANSWER] : []),
  ];
  const list = useRef<HTMLDivElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  // Whether the oldest messages are cut off at the top, so only then the top edge fades.
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    const frame = list.current;
    const content = messages.current;
    if (!(frame && content)) return;
    const observer = new ResizeObserver(() =>
      setClipped(content.offsetHeight > frame.clientHeight + 1),
    );
    observer.observe(content);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

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
        <div aria-hidden className="flex select-none flex-col gap-2">
          <span className="font-medium text-copy-14 text-gray-1000">Past orders</span>
          <span className="mt-1 hidden grid-cols-3 gap-2 @[15rem]:grid">
            {["1,284", "$48.2k", "96%"].map((metric) => (
              <span
                className="flex flex-col gap-2 rounded-md border border-gray-alpha-400 p-2.5"
                key={metric}
              >
                <span className="font-medium text-copy-16 text-gray-900 tabular-nums">
                  {metric}
                </span>
                <span className="h-2 w-2/3 rounded-[3px] bg-gray-200" />
              </span>
            ))}
          </span>
          {/* Fades out downward, and to the right before the chat's 14rem plus a 1rem gap. Left
              out on phones, where the chat spans the window. */}
          <span className="hidden h-24 rounded-md border border-gray-alpha-400 [mask-composite:intersect] [mask-image:linear-gradient(to_bottom,black,transparent),linear-gradient(to_right,black_calc(100%_-_21rem),transparent_calc(100%_-_15rem))] md:@[15rem]:block" />
        </div>
        {/* Pinned to the window's bottom, the chat grows up as messages join, stopping 8px
            short of the KPI row, which ends 106px down (12 + 106 + 8 = 126px off the height);
            past that, the oldest scroll up out of view. */}
        <div className="absolute inset-x-3 bottom-3 flex max-h-[calc(100%-7.875rem)] flex-col gap-3.5 rounded-lg p-1.5 material-menu md:left-auto md:w-56 md:max-w-[calc(100%-1.5rem)]">
          <span className="shrink-0 text-label-12 text-gray-900">Acme support</span>
          <div
            className="flex min-h-0 flex-col justify-end overflow-hidden"
            ref={list}
            style={{
              maskImage: clipped
                ? "linear-gradient(to bottom, transparent, black 24px)"
                : undefined,
            }}
          >
            <div className="flex flex-col gap-2" ref={messages}>
              {WEB_THREAD.map((message) => (
                <SupportBubble key={message.text} {...message} />
              ))}
              {followUp.map((message) => (
                <GrowIn key={message.text}>
                  <SupportBubble
                    {...message}
                    className={`${imessageIn} ${message.sent ? "origin-bottom-right" : "origin-bottom-left"}`}
                  />
                </GrowIn>
              ))}
            </div>
          </div>
        </div>
      </div>
    </AppWindow>
  );
}

/**
 * The call's waveform. While the call is live it records, scrolling left as bars join; once it
 * ends, the recorded bars play back on click, filling in bar by bar like a voice message,
 * holding full for a moment, and resetting. A second click stops playback.
 *
 * Each bar sits at a fixed place on a strip, and one clock both moves the strip and counts the
 * bars, so the scroll stays even. A bar renders a step before it scrolls into view, so it is
 * in place by the time it shows.
 */
function Waveform({ live, from }: { live: boolean; from: number }) {
  // Where this recording started, fixed at mount: `from` follows the call's timer, which
  // re-renders every second, and a moving origin would jolt the bars.
  const [origin] = useState(from);
  // Bars recorded so far, counted from the start of the call.
  const [recorded, setRecorded] = useState(origin);
  // How many bars have played, or null when stopped.
  const [played, setPlayed] = useState<number | null>(null);
  const strip = useRef<HTMLSpanElement>(null);

  // Where the strip sits once `progress` bars have recorded: the newest at the right edge.
  const offset = (progress: number) => WAVE_WIDTH - BAR_PITCH - (progress - origin) * BAR_PITCH;

  useLayoutEffect(() => {
    const node = strip.current;
    if (!node) return;
    if (!live) {
      node.style.transform = `translateX(${offset(recorded)}px)`;
      return;
    }
    const step = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now() - (recorded - origin) * BAR_MS;
    let frame = requestAnimationFrame(function tick(now) {
      const progress = origin + (now - start) / BAR_MS;
      node.style.transform = `translateX(${offset(step ? Math.floor(progress) : progress)}px)`;
      setRecorded(Math.floor(progress));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
    // Restarts only when the call goes live or ends; `recorded` seeds the clock's start.
  }, [live]);

  const first = Math.max(0, recorded - BAR_COUNT - 1);
  // While live, one bar past the newest, still outside the strip's right edge.
  const bars = Array.from({ length: recorded - first + (live ? 1 : 0) }, (_, i) => first + i);
  const playable = bars.slice(-BAR_COUNT);

  useEffect(() => {
    if (played === null) return;
    const done = played === playable.length;
    const timer = setTimeout(() => setPlayed(done ? null : played + 1), done ? 600 : 110);
    return () => clearTimeout(timer);
  }, [played, playable.length]);

  const wave = (
    <span
      className="absolute inset-y-0 left-0"
      ref={strip}
      style={{ transform: `translateX(${offset(origin)}px)` }}
    >
      {bars.map((t) => {
        const index = playable.indexOf(t);
        return (
          <span
            className={cn(
              "absolute top-1/2 w-[2px] -translate-y-1/2 rounded-full transition-colors duration-150",
              !live && played !== null && index !== -1 && index < played
                ? "bg-gray-1000"
                : cn("bg-gray-alpha-600", !live && "group-hover:bg-gray-alpha-700"),
            )}
            key={t}
            style={{ height: voiceLevel(t), left: (t - origin) * BAR_PITCH }}
          />
        );
      })}
    </span>
  );
  // Faded at both ends, so bars ease in at the right and out at the left.
  const frame =
    "relative ml-auto hidden h-6 shrink-0 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_20%,black_85%,transparent)] @sm:block";

  return live ? (
    <span aria-hidden className={frame} style={{ width: WAVE_WIDTH }}>
      {wave}
    </span>
  ) : (
    <button
      aria-label={played === null ? "Play the recording" : "Stop the recording"}
      aria-pressed={played !== null}
      className={cn(
        "group cursor-pointer rounded-[4px] focus-visible:shadow-(--ds-focus-ring) focus-visible:outline-none",
        frame,
      )}
      onClick={() => setPlayed(played === null ? 0 : null)}
      style={{ width: WAVE_WIDTH }}
      type="button"
    >
      {wave}
    </button>
  );
}

const formatDuration = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * A phone call to a clinic's front desk. It opens on a finished call whose recording plays
 * back; Record starts a new one, which runs the timer and records the waveform until End. The
 * demo records and hangs up on its own, and stopping it puts back the finished call.
 */
function VoiceClient({ stage }: { stage?: number }) {
  const [call, setCall] = useState({ id: 0, live: false, seconds: 42, demo: false });

  useEffect(() => {
    if (stage === undefined) {
      setCall((c) => (c.demo ? { id: c.id + 1, live: false, seconds: 42, demo: false } : c));
    } else if (stage === AGENTIC_RECORDING) {
      setCall((c) => ({ id: c.id + 1, live: true, seconds: 0, demo: true }));
    } else if (stage === AGENTIC_HUNG_UP) {
      setCall((c) => (c.demo ? { ...c, live: false } : c));
    }
  }, [stage]);

  useEffect(() => {
    if (!call.live) return;
    const timer = setInterval(
      () => setCall((current) => ({ ...current, seconds: current.seconds + 1 })),
      1000,
    );
    return () => clearInterval(timer);
  }, [call.live]);

  return (
    <div className="@container flex flex-col gap-3 p-3 material-large">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gray-alpha-200 text-gray-1000">
          {voiceLogo({ "aria-hidden": true, className: logoClassName })}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-copy-13 text-gray-1000">Acme Dental</span>
          <span className="truncate text-label-12 text-gray-900 tabular-nums">
            {call.live ? "Front desk" : "Call ended"} · {formatDuration(call.seconds)}
          </span>
        </span>
        {/* A new call gets a fresh waveform, recorded from its start. */}
        <Waveform from={(call.seconds * 1000) / BAR_MS} key={call.id} live={call.live} />
        {/* Not through cn: tailwind-merge reads text-label-12 and a text color as one conflict.
            Record is black on light and white on dark, so its text takes the background. */}
        <button
          className={`ml-auto hidden shrink-0 cursor-pointer rounded-full px-3 py-1 text-label-12 focus-visible:shadow-(--ds-focus-ring) focus-visible:outline-none @[16rem]:inline @sm:ml-0 ${
            call.live ? "bg-red-700 text-white" : "bg-gray-1000 text-background-100"
          }`}
          onClick={() =>
            setCall(
              call.live
                ? { ...call, live: false }
                : { id: call.id + 1, live: true, seconds: 0, demo: false },
            )
          }
          type="button"
        >
          {call.live ? "End" : "Record"}
        </button>
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

/**
 * How long each stage of the agentic apps demo waits before it shows: the call starting to
 * record, the follow-up question, the planner typing, the answer, then the call hanging up.
 * The follow-up plays in iMessage on wider screens and in the support chat on phones, where
 * iMessage is left out, so each layout has one at the same moments.
 */
const AGENTIC_DEMO = [400, 1600, 700, 1400, 1800];
const AGENTIC_RECORDING = 1;
const AGENTIC_ASKED = 2;
const AGENTIC_TYPING = 3;
const AGENTIC_ANSWERED = 4;
const AGENTIC_HUNG_UP = 5;

// The demo's follow-up in the planner thread, entering like the hero's bubbles.
const imessageIn = "motion-safe:animate-bubble-in motion-reduce:animate-fade-in";
const IMESSAGE_QUESTION = { sent: true, text: "Can we make it 7:30?" };
const IMESSAGE_ANSWER = { sent: false, text: "Moved it to 7:30. Your calendar's updated." };

const IMESSAGE_THREAD: { sent: boolean; text: string }[] = [
  { sent: true, text: "Dinner with Sam on Friday?" },
  { sent: false, text: "Luna has a table at 7. Want it?" },
  { sent: true, text: "Yes please" },
  { sent: false, text: "Booked and added to your calendar." },
];

/**
 * A personal planning thread in an iMessage-style app; the demo adds a follow-up. Left out on
 * phones, where its column would be too narrow to read.
 */
function IMessageClient({ stage = 0 }: { stage?: number }) {
  // The follow-up's bubbles grow from their tail's corner.
  const thread = [
    ...IMESSAGE_THREAD.map((message) => ({ ...message, entering: false })),
    ...(stage >= AGENTIC_ASKED ? [{ ...IMESSAGE_QUESTION, entering: true }] : []),
    ...(stage >= AGENTIC_ANSWERED ? [{ ...IMESSAGE_ANSWER, entering: true }] : []),
  ];
  return (
    <div className="hidden min-h-0 flex-col overflow-hidden material-large md:flex">
      <div className="flex shrink-0 flex-col items-center gap-1 border-gray-alpha-400 border-b py-2.5">
        <span className="flex size-8 items-center justify-center rounded-full bg-gradient-to-b from-[#A5A9B4] to-[#858994] font-medium text-[13px] text-white dark:from-[#636366] dark:to-[#48484A]">
          P
        </span>
        <span className="text-label-12 text-gray-1000">Planner</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-3 text-copy-13">
        {thread.map((message) => {
          const colors = message.sent ? sentBubble : receivedBubble;
          return (
            <p
              className={cn(
                "relative max-w-[85%] text-pretty px-3 py-1.5",
                colors.bubble,
                message.entering && [
                  imessageIn,
                  message.sent ? "origin-bottom-right" : "origin-bottom-left",
                ],
              )}
              key={message.text}
              style={{ borderRadius: bubbleRadius }}
            >
              <Tail className={colors.tail} flipped={message.sent} />
              <span className="sr-only">{message.sent ? "You: " : "Agent: "}</span>
              {message.text}
            </p>
          );
        })}
        {stage === AGENTIC_TYPING ? (
          <p
            aria-label="Planner is typing"
            className={cn(
              "relative flex w-fit origin-bottom-left items-center gap-[3px] px-2.5 py-2",
              imessageIn,
              receivedBubble.bubble,
            )}
            style={{ borderRadius: bubbleRadius }}
          >
            <Tail className={receivedBubble.tail} />
            {[0, 1, 2].map((dot) => (
              <span
                className="size-[5px] animate-blink rounded-full bg-current"
                key={dot}
                style={{ animationDelay: `${dot * 200}ms` }}
              />
            ))}
          </p>
        ) : null}
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

function AgenticAppsPreview({ stage }: { stage?: number }) {
  return (
    <figure className="grid h-full grid-cols-1 gap-3 sm:gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
      <figcaption className="sr-only">
        The same kind of agent in three clients: customer support chat in a web app, a voice call to
        a clinic's front desk, and a personal planner in iMessage.
      </figcaption>
      <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3 sm:gap-4">
        <WebAppClient stage={stage} />
        <VoiceClient stage={stage} />
      </div>
      <IMessageClient stage={stage} />
    </figure>
  );
}

interface UseCase {
  id: string;
  name: string;
  text: string;
  /** Vercel template gallery slug, or null to send people to the full gallery. */
  template: string | null;
  cta: string;
  /** What the agent does, a short title and line each. */
  features: { title: string; text: string }[];
  /** The example draws its own windows, so it skips the shared one. */
  ownWindows?: boolean;
  /** Stage delays for a replay, for an example that has one. */
  demo?: number[];
  /** What starts the replay, as its button reads. */
  action?: string;
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
    action: "Ask a question",
    preview: (stage) => <CompanyBrainPreview stage={stage} />,
  },
  {
    id: "software-factory",
    name: "Software factory",
    text: "Build an agent that turns issues into reviewed draft pull requests, from triage and planning to implementation.",
    template: "eve-software-factory",
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
    action: "Trigger a PR",
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
    demo: AGENTIC_DEMO,
    action: "Start a call",
    preview: (stage) => <AgenticAppsPreview stage={stage} />,
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
              <span className="font-medium text-copy-14">{useCase.name}</span>
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
          href={
            selected.template ? `${templateGalleryUrl}/${selected.template}` : templateGalleryUrl
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
              and a little clear of it, on wide screens; above it when stacked. */}
          <div className="grid lg:col-span-5 lg:col-start-8 lg:row-start-1 lg:pl-12">
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
                {useCase.demo && useCase.action ? (
                  // Pulled out by its padding and icon inset, so the icon lines up with the text.
                  <DemoButton
                    action={useCase.action}
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
            className="min-w-0 select-none lg:col-span-7 lg:row-start-1"
            id={`${baseId}-panel`}
            role="tabpanel"
          >
            {selected.ownWindows ? (
              <div className="h-[30rem] md:h-[26rem]">{selected.preview(demo?.stage)}</div>
            ) : (
              <AppWindow className="h-[30rem] md:h-[26rem]">
                {selected.preview(demo?.stage)}
              </AppWindow>
            )}
          </div>
        </div>
      </div>
    </HomeSection>
  );
}
