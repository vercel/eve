"use client";

import type { SessionView } from "eve/events";
import type { EveMessage, EveToolPart } from "eve/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { DEVICES, type DeviceName } from "../../../agent/lib/devices";
import { explainError, formatDuration, toActivity, type ToolActivity } from "./activity";
import { AgentIndicator, ArrowUp, ChevronRight, Clock, Monitor, Wrench } from "./icons";
import { Markdown } from "./markdown";
import { activityStatus, Code, Row, TimelineBar } from "./run-ui";

interface ChatProps {
  readonly messages: readonly EveMessage[];
  readonly view: SessionView;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly device: DeviceName;
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
  { text: "Open Firefox, go to example.com, and tell me what the page says.", device: "desktop" },
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
  device,
  selectedId,
  onSelect,
  onSend,
  onStop,
  notice,
}: ChatProps) {
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const submit = (text: string, target?: DeviceName) => {
    const value = text.trim();
    if (value.length === 0 || disabled) return;
    onSend(value, target);
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
        {messages.length === 0 ? (
          <EmptyState onPick={submit} />
        ) : (
          <div className="thread">
            {messages.map((message, index) =>
              message.role === "user" ? (
                <UserMessage key={message.id} message={message} />
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
            {busy && messages.at(-1)?.role === "user" ? (
              <div className="pending">
                <AgentIndicator active size={18} />
                <span className="shimmer">Thinking</span>
                <Ellipsis />
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
          <textarea
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
                : `Ask the agent to do something on the ${DEVICES[device].label.toLowerCase()}…`
            }
            ref={input}
            rows={2}
            value={draft}
          />
          <div className="composer-bar">
            <span className="composer-hint">
              <kbd>⏎</kbd> send <kbd>⇧⏎</kbd> new line
            </span>
            {busy && draft.trim().length === 0 ? (
              <button
                aria-label="Stop"
                className="icon-button icon-button-secondary"
                onClick={onStop}
                title="Stop the agent"
                type="button"
              >
                <span className="stop-square" />
              </button>
            ) : (
              <button
                aria-label={busy ? "Steer" : "Send"}
                className="icon-button icon-button-primary"
                disabled={disabled || draft.trim().length === 0}
                title={busy ? "Send to steer the running task" : "Send"}
                type="submit"
              >
                <ArrowUp size={14} />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string, device?: DeviceName) => void }) {
  const mac = useIsMac();
  return (
    <div className="empty">
      <div className="empty-mark">
        <AgentIndicator size={28} />
      </div>
      <div className="empty-title">
        <h2>Computer use</h2>
      </div>
      <p className="empty-blurb">
        Describe a task and watch the agent work in a sandbox of its own: a headless Chrome, or a
        Linux desktop with Firefox and terminals. Pick the device at the top right; each chat keeps
        the one it started with.
      </p>
      <div className="suggestions">
        {SUGGESTIONS.map((suggestion, index) => (
          <button
            className="suggestion"
            key={suggestion.text}
            onClick={() => onPick(suggestion.text, suggestion.device)}
            type="button"
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
          </button>
        ))}
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: EveMessage }) {
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  return (
    <div className="message-user">
      <div className="bubble">{text}</div>
    </div>
  );
}

type Block =
  | { kind: "text"; key: string; text: string }
  | { kind: "tools"; key: string; parts: EveToolPart[] };

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

  const failed = activities.filter((activity) => activity.state === "error").length;
  const now = Date.now();
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

  return (
    <div className={`work ${expanded ? "work-open" : ""}`}>
      <button
        aria-expanded={expanded}
        className="work-trigger"
        onClick={() => setOpen(!expanded)}
        type="button"
      >
        <span className={`work-title ${running && running.state !== "awaiting" ? "shimmer" : ""}`}>
          {running
            ? running.state === "awaiting"
              ? "Waiting for your approval"
              : running.label
            : failed === activities.length
              ? "Failed"
              : "Worked"}
        </span>
        <span className="work-meta">
          <span>
            <Wrench size={12} />
            {activities.length}
          </span>
          {scale ? (
            <span>
              <Clock size={12} />
              {formatDuration(scale.endMs - scale.startMs)}
            </span>
          ) : null}
          {failed > 0 ? <span className="tone-red">{failed} Failed</span> : null}
        </span>
        <ChevronRight className="work-chevron" size={14} />
      </button>
      {expanded ? (
        <div className="rows work-rows">
          {activities.map((activity) => (
            <Step
              activity={activity}
              key={activity.id}
              onSelect={onSelect}
              scale={scale}
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
  scale,
  onSelect,
}: {
  activity: ToolActivity;
  selected: boolean;
  scale: { startMs: number; endMs: number } | null;
  onSelect: (activity: ToolActivity) => void;
}) {
  const status = activityStatus(activity);
  const note =
    activity.state === "awaiting" ? (
      <span className="tone-amber">Needs your approval</span>
    ) : activity.error ? (
      <span className="tone-red">{explainError(activity.error)}</span>
    ) : undefined;
  const duration =
    activity.startedAt === undefined
      ? undefined
      : (activity.endedAt ?? Date.now()) - activity.startedAt;

  return (
    <Row
      bar={
        <TimelineBar
          endedAt={activity.endedAt}
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

function Ellipsis() {
  return (
    <span aria-hidden="true" className="ellipsis">
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  );
}
