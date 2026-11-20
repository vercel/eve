"use client";

import type { SessionView } from "eve/events";
import type { EveMessage, EveToolPart } from "eve/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { DEVICES, type DeviceChoice, type DeviceName } from "../../../agent/lib/devices";
import { explainError, formatDuration, toActivity, type ToolActivity } from "./activity";
import { ArrowUp, ChevronRight, Monitor } from "./icons";
import { Markdown } from "./markdown";
import { activityStatus, Code, Row, TimelineBar } from "./run-ui";
import { Button } from "@ui-sdk/react/button";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { Textarea } from "@ui-sdk/react/textarea";

interface ChatProps {
  readonly messages: readonly EveMessage[];
  readonly view: SessionView;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly error: string | null;
  /** The picker's value: Auto, or the device the chat runs on. */
  readonly choice: DeviceChoice;
  readonly onChoiceChange: (choice: DeviceChoice) => void;
  /** A chat keeps the device it started on, so the picker is fixed once it has messages. */
  readonly locked: boolean;
  /** Auto mode is choosing a device for the first message. */
  readonly deciding: boolean;
  readonly selectedId: string | undefined;
  readonly onSelect: (activity: ToolActivity) => void;
  /** `device` switches to that device first, for suggestions that need one. */
  readonly onSend: (text: string, device?: DeviceName) => void;
  readonly onStop: () => void;
  /** Shown above the composer, such as an approval request. */
  readonly notice?: ReactNode;
}

interface Suggestion {
  readonly text: string;
  readonly device: DeviceName;
}

const SUGGESTIONS: readonly Suggestion[] = [
  {
    text: "Go to wikipedia.org, search for Grace Hopper, and tell me the first sentence of her article.",
    device: "browser",
  },
  { text: "Open news.ycombinator.com and open the comments for the top story.", device: "browser" },
  { text: "Open the calculator and work out 2 × 2.", device: "desktop" },
];

/** Mac or not, known only after hydration, so the server and first client render agree. */
function useIsMac(): boolean {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  return mac;
}

export function Chat({
  messages,
  view,
  busy,
  disabled,
  error,
  choice,
  onChoiceChange,
  locked,
  deciding,
  selectedId,
  onSelect,
  onSend,
  onStop,
  notice,
}: ChatProps) {
  const [draft, setDraft] = useState("");
  // While Auto picks a device the message isn't sent yet; show it in the thread meanwhile.
  const [sent, setSent] = useState<string | null>(null);
  const placeholderShown = useRef(false);
  const waiting = deciding && messages.length === 0 ? sent : null;
  if (waiting !== null) placeholderShown.current = true;
  if (messages.length === 0 && !deciding) placeholderShown.current = false;
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const submit = (text: string, target?: DeviceName) => {
    const value = text.trim();
    if (value.length === 0 || disabled) return;
    onSend(value, target);
    setSent(value);
    setDraft("");
  };

  // ⌘1–3 (Ctrl elsewhere) runs a suggestion from the empty state.
  useEffect(() => {
    if (messages.length > 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const suggestion = SUGGESTIONS[Number(event.key) - 1];
      if (suggestion === undefined) return;
      event.preventDefault();
      submit(suggestion.text, suggestion.device);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="chat-body">
      <div className="log" ref={log}>
        {waiting !== null ? (
          <div className="thread">
            <div className="message-user">
              <div className="bubble">{waiting}</div>
            </div>
            <div className="pending">
              <span className="pending-title shimmer">Choosing browser or desktop</span>
            </div>
          </div>
        ) : messages.length === 0 ? (
          <EmptyState onPick={submit} />
        ) : (
          <div className="thread">
            {messages.map((message, index) =>
              message.role === "user" ? (
                <UserMessage
                  key={message.id}
                  message={message}
                  settled={index === 0 && placeholderShown.current}
                />
              ) : (
                <AssistantMessage
                  key={message.id}
                  live={busy && index === messages.length - 1}
                  message={message}
                  onSelect={onSelect}
                  selectedId={selectedId}
                  view={view}
                />
              ),
            )}
            {busy && !showsProgress(messages.at(-1)) ? (
              <div className="pending">
                <span className="pending-title shimmer">Thinking</span>
              </div>
            ) : null}
            {error ? <p className="chat-error">{error}</p> : null}
          </div>
        )}
      </div>

      <div className="composer-wrap">
        {notice}
        <form
          className="composer"
          onClick={() => input.current?.focus()}
          onSubmit={(event) => {
            event.preventDefault();
            submit(draft);
          }}
        >
          <Textarea
            autoResize
            className="composer-input"
            disabled={disabled}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit(draft);
              }
            }}
            placeholder={
              busy
                ? "Steer the agent…"
                : choice === "auto"
                  ? "Describe a task; Auto picks the browser or the desktop…"
                  : `Ask the agent to do something on the ${DEVICES[choice].label.toLowerCase()}…`
            }
            ref={input}
            rows={2}
            value={draft}
          />
          <div className="composer-bar">
            <DevicePicker choice={choice} locked={locked} onChange={onChoiceChange} />
            <span className="composer-hint">
              <kbd>⏎</kbd> send <kbd>⇧⏎</kbd> new line
            </span>
            {busy && draft.trim().length === 0 ? (
              <Button
                aria-label="Stop"
                className="icon-button icon-button-secondary"
                onClick={onStop}
                title="Stop the agent"
              >
                <span className="stop-square" />
              </Button>
            ) : (
              <Button
                aria-label={busy ? "Steer" : "Send"}
                className="icon-button icon-button-primary"
                disabled={disabled || draft.trim().length === 0}
                title={busy ? "Send to steer the running task" : "Send"}
                type="submit"
              >
                <ArrowUp size={14} />
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

const CHOICES: readonly {
  readonly value: DeviceChoice;
  readonly label: string;
  readonly title: string;
}[] = [
  { value: "auto", label: "Auto", title: "Pick the browser or the desktop from the task" },
  ...(Object.entries(DEVICES) as [DeviceName, (typeof DEVICES)[DeviceName]][]).map(
    ([value, device]) => ({ value, label: device.label, title: device.description }),
  ),
];

/** Auto, Browser, or Desktop. Fixed once the chat starts. */
function DevicePicker({
  choice,
  locked,
  onChange,
}: {
  choice: DeviceChoice;
  locked: boolean;
  onChange: (choice: DeviceChoice) => void;
}) {
  return (
    <SegmentedControl
      aria-label="Device"
      className="device-picker"
      onClick={(event) => event.stopPropagation()}
      onValueChange={(value) => {
        if (value !== null) onChange(value);
      }}
      title={locked ? "Start a new chat to use another device" : undefined}
      value={choice}
    >
      <SegmentedControlIndicator className="device-indicator" />
      {CHOICES.map((option) => (
        <SegmentedControlItem
          className="device-option"
          disabled={locked && choice !== option.value}
          key={option.value}
          title={locked ? undefined : option.title}
          value={option.value}
        >
          {option.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

function EmptyState({ onPick }: { onPick: (text: string, device?: DeviceName) => void }) {
  const mac = useIsMac();
  return (
    <div className="empty">
      <div className="empty-title">
        <h2>Computer use</h2>
      </div>
      <p className="empty-blurb">
        Describe a task and watch the agent work in a sandbox of its own: a headless Chrome, or a
        Linux desktop with Firefox, terminals, a calculator, and a text editor. Pick one below the
        prompt, or leave it on Auto to choose from the task; each chat keeps the one it started
        with.
      </p>
      <div className="suggestions">
        {SUGGESTIONS.map((suggestion, index) => (
          <Button
            className="suggestion"
            key={suggestion.text}
            onClick={() => onPick(suggestion.text, suggestion.device)}
          >
            <span className="suggestion-text">
              <span className="suggestion-chip">
                <Monitor size={12} />
                {DEVICES[suggestion.device].label}
              </span>
              {suggestion.text}
            </span>
            <span className="suggestion-keys">
              <kbd>{mac ? "⌘" : "Ctrl"}</kbd>
              <kbd>{index + 1}</kbd>
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}

function UserMessage({ message, settled }: { message: EveMessage; settled: boolean }) {
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  return (
    <div className={`message-user ${settled ? "message-settled" : ""}`}>
      <div className="bubble">{text}</div>
    </div>
  );
}

type Block =
  | { kind: "text"; key: string; text: string }
  | { kind: "tools"; key: string; parts: EveToolPart[] };

/**
 * Whether the latest message already shows the agent at work: its text, or its steps, whose
 * title says Thinking between steps. Until it shows either, the chat shows its own Thinking line,
 * so the indicator doesn't drop out while the agent decides on its first step.
 */
function showsProgress(message: EveMessage | undefined): boolean {
  return message !== undefined && message.role !== "user" && blocksOf(message).length > 0;
}

function blocksOf(message: EveMessage): Block[] {
  const blocks: Block[] = [];
  message.parts.forEach((part, index) => {
    if (part.type === "text" && part.text.trim().length > 0) {
      blocks.push({ kind: "text", key: part.id ?? `text-${index}`, text: part.text });
    } else if (part.type === "tool" && part.kind === "tool") {
      const last = blocks.at(-1);
      if (last?.kind === "tools") last.parts.push(part);
      else blocks.push({ kind: "tools", key: part.callId, parts: [part] });
    }
  });
  return blocks;
}

function AssistantMessage({
  message,
  view,
  live,
  selectedId,
  onSelect,
}: {
  message: EveMessage;
  view: SessionView;
  live: boolean;
  selectedId: string | undefined;
  onSelect: (activity: ToolActivity) => void;
}) {
  const blocks = blocksOf(message);
  // A reply arrives before it has text or steps; an empty one would push Thinking down a gap.
  if (blocks.length === 0) return null;
  return (
    <div className="message-assistant">
      {blocks.map((block, index) =>
        block.kind === "text" ? (
          <Markdown key={block.key} text={block.text} />
        ) : (
          <WorkGroup
            activities={block.parts.map((part) => toActivity(part, view))}
            key={block.key}
            last={live && index === blocks.length - 1}
            onSelect={onSelect}
            selectedId={selectedId}
          />
        ),
      )}
    </div>
  );
}

/** The steps' time axis: a minute, which covers most turns, doubling for longer ones. */
const AXIS_MS = 60_000;

function axisLength(elapsedMs: number): number {
  let length = AXIS_MS;
  while (length < elapsedMs) length *= 2;
  return length;
}

/** How often running durations update. */
const TICK_MS = 100;

/** The current time, updated every TICK_MS while `ticking`, and left as it was otherwise. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function WorkGroup({
  activities,
  last,
  selectedId,
  onSelect,
}: {
  activities: ToolActivity[];
  last: boolean;
  selectedId: string | undefined;
  onSelect: (activity: ToolActivity) => void;
}) {
  const running = activities.find(
    (activity) => activity.state === "running" || activity.state === "awaiting",
  );
  const needsAttention = activities.some(
    (activity) => activity.state === "awaiting" || activity.state === "error",
  );
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (last || needsAttention);
  // The turn's latest steps, between one step and the next: the agent is deciding what to do.
  const thinking = last && running === undefined;

  const failed = activities.filter((activity) => activity.state === "error").length;
  // Running steps have no end yet, so their durations and bars follow a clock that ticks
  // while any step is still open, instead of jumping each time the session sends an update.
  // `last` is the group the agent is still working in, between steps too.
  const inProgress = last || activities.some((activity) => activity.endedAt === undefined);
  const now = useNow(inProgress);
  const started = activities.flatMap((activity) =>
    activity.startedAt === undefined ? [] : [activity.startedAt],
  );
  const scale =
    started.length > 0
      ? {
          startMs: Math.min(...started),
          endMs: Math.max(...activities.map((activity) => activity.endedAt ?? now)),
        }
      : null;
  // The bars share a fixed axis, so a bar never moves once drawn: a new step appears at its place
  // and only the running one grows. It doubles only when a turn outlasts it.
  const axis =
    scale === null
      ? null
      : { startMs: scale.startMs, endMs: scale.startMs + axisLength(scale.endMs - scale.startMs) };

  return (
    <div className={`work ${expanded ? "work-open" : ""}`}>
      <Button aria-expanded={expanded} className="work-trigger" onClick={() => setOpen(!expanded)}>
        <span
          className={`work-title ${(running && running.state !== "awaiting") || thinking ? "shimmer" : ""}`}
        >
          {running
            ? running.state === "awaiting"
              ? "Waiting for your approval"
              : running.label
            : thinking
              ? "Thinking"
              : failed === activities.length
                ? "Failed"
                : "Worked"}
        </span>
        <span className="work-meta">
          <span>
            {activities.length} {activities.length === 1 ? "step" : "steps"}
          </span>
          {scale ? <span>{formatDuration(scale.endMs - scale.startMs)}</span> : null}
          {failed > 0 ? <span className="tone-red">{failed} failed</span> : null}
        </span>
        <ChevronRight className="work-chevron" size={14} />
      </Button>
      {expanded ? (
        <div className="rows work-rows">
          {activities.map((activity) => (
            <Step
              activity={activity}
              key={activity.id}
              onSelect={onSelect}
              now={now}
              scale={axis}
              selected={selectedId === activity.id}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Step({
  activity,
  selected,
  now,
  scale,
  onSelect,
}: {
  activity: ToolActivity;
  selected: boolean;
  now: number;
  scale: { startMs: number; endMs: number } | null;
  onSelect: (activity: ToolActivity) => void;
}) {
  const status = activityStatus(activity);
  const note =
    activity.state === "awaiting" ? (
      <span className="row-tag row-tag-waiting">Waiting · needs your approval</span>
    ) : activity.error ? (
      <span className="row-tag row-tag-failed">Failed · {explainError(activity.error)}</span>
    ) : undefined;
  const duration =
    activity.startedAt === undefined ? undefined : (activity.endedAt ?? now) - activity.startedAt;

  return (
    <Row
      bar={
        <TimelineBar
          endedAt={activity.endedAt}
          now={now}
          scale={scale}
          startedAt={activity.startedAt}
          status={status}
        />
      }
      duration={formatDuration(duration)}
      name={activity.label}
      note={note}
      onSelect={activity.screen ? () => onSelect(activity) : undefined}
      preview={activity.screen?.url ? displayUrl(activity.screen.url) : undefined}
      selected={selected}
      status={status}
    >
      {activity.input !== undefined ? (
        <Code>{JSON.stringify(activity.input, null, 2)}</Code>
      ) : undefined}
    </Row>
  );
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
