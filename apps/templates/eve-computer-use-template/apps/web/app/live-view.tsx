"use client";

import type { Interaction } from "eve/react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { DEVICES, type DeviceName } from "../../../agent/lib/devices";
import { addressBarUrl } from "../../../agent/lib/live-config";
import type { Screen } from "../../../agent/lib/screen";
import type { ToolActivity } from "./activity";
import { ApprovalBanner } from "./approval";
import {
  AgentIndicator,
  ArrowLeft,
  ArrowRight,
  Clock,
  Collapse,
  Expand,
  Lock,
  Monitor,
  Pointer,
  Refresh,
  Shield,
  Sparkle,
} from "./icons";
import { useLiveStream } from "./use-live-stream";

export type Control = "agent" | "user";

interface LiveViewProps {
  readonly device: DeviceName;
  readonly agentBusy: boolean;
  readonly current: ToolActivity | undefined;
  /** The latest screen any call returned. */
  readonly screen: Screen | undefined;
  /** The picked device's live stream through /api/live, once a call has started one. */
  readonly live: string | undefined;
  /** A past step the user picked from the chat, shown instead of the live screen. */
  readonly pinned: ToolActivity | undefined;
  readonly onExitReplay: () => void;
  readonly approvals: readonly Interaction[];
  readonly onRespond: (interactionId: string, optionId: string) => void;
  readonly control: Control;
  readonly onTakeControl: () => void;
  readonly onHandBack: () => void;
  /** The screen is popped out over the page instead of floating in its corner. */
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
}

const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const PIP_WIDTH = 400;
const PIP_MARGIN = 12;
/** Below the top bar, at the window's right edge. */
const PIP_HOME = { right: 16, top: 68 };
const BUTTONS = ["left", "middle", "right"] as const;

export function LiveView({
  device,
  agentBusy,
  current,
  screen,
  live,
  pinned,
  onExitReplay,
  approvals,
  onRespond,
  control,
  onTakeControl,
  onHandBack,
  expanded,
  onExpandedChange,
}: LiveViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const stream = useLiveStream(canvas, live);
  // Once a device has a live stream it can be driven, even while the socket reconnects, so Take
  // Over and driving don't blink out when a connection drops; input waits for it to come back.
  // A static page may send no frame until something changes, so the screenshot shows until one
  // arrives; after that the last frame stays up through a reconnect. A past step always shows its
  // screenshot.
  const drivable = pinned === undefined && live !== undefined;
  const streaming = drivable && stream.frame !== null;
  const shown = pinned?.screen ?? screen;
  const imageSize = useImageSize(shown?.imageDataUrl);
  const size = streaming ? stream.frame : imageSize;
  const driving = control === "user" && drivable && expanded;

  useEffect(() => {
    if (driving) surface.current?.focus();
  }, [driving]);

  // Floating, the card sits at `pip`, measured from the window's top right corner so it keeps
  // its place when the window resizes. Expanding moves and resizes the same element rather than
  // scaling it, so the stream keeps running and the title bar keeps its real height in flight.
  const card = useRef<HTMLDivElement>(null);
  const [pip, setPip] = useState<{ right: number; top: number }>(PIP_HOME);
  const [closing, setClosing] = useState(false);
  const setExpanded = (next: boolean) => {
    const element = card.current;
    if (element === null || next === expanded || closing) return;
    if (next) {
      const first = element.getBoundingClientRect();
      flushSync(() => onExpandedChange(true));
      const last = element.getBoundingClientRect();
      element.animate([placed(first), placed(last)], { duration: 420, easing: EASE });
      return;
    }
    const first = element.getBoundingClientRect();
    setClosing(true);
    const animation = element.animate(
      [
        placed(first),
        placed({ left: window.innerWidth - pip.right - PIP_WIDTH, top: pip.top, width: PIP_WIDTH }),
      ],
      { duration: 380, easing: EASE, fill: "forwards" },
    );
    animation.onfinish = () => {
      flushSync(() => {
        onExpandedChange(false);
        setClosing(false);
      });
      animation.cancel();
    };
  };

  // Drag the floating card by its title bar, kept inside the window.
  const drag = useRef<{ x: number; y: number; right: number; top: number } | null>(null);
  const clampPip = (position: { right: number; top: number }) => {
    const height = card.current?.offsetHeight ?? 0;
    return {
      right: Math.min(
        Math.max(position.right, PIP_MARGIN),
        window.innerWidth - PIP_WIDTH - PIP_MARGIN,
      ),
      top: Math.min(Math.max(position.top, PIP_MARGIN), window.innerHeight - height - PIP_MARGIN),
    };
  };
  const onDragStart = (event: React.PointerEvent) => {
    if (expanded || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, ...pip };
  };
  const onDragMove = (event: React.PointerEvent) => {
    const start = drag.current;
    if (start === null) return;
    setPip(
      clampPip({
        right: start.right - (event.clientX - start.x),
        top: start.top + (event.clientY - start.y),
      }),
    );
  };
  const onDragEnd = () => {
    drag.current = null;
  };
  useEffect(() => {
    const onResize = () => setPip((current) => clampPip(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  useEffect(() => {
    if (!expanded || driving) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toDevice = (event: { clientX: number; clientY: number }) => {
    const rect = surface.current!.getBoundingClientRect();
    // Input is in the page's CSS pixels (or the screen's), which can differ from frame pixels.
    // Before the first frame, the screenshot has the page's shape at its CSS size.
    const viewport = stream.viewport ?? imageSize ?? { width: rect.width, height: rect.height };
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * viewport.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * viewport.height),
    };
  };

  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const onMouseMove = (event: React.MouseEvent) => {
    if (!driving) return;
    const first = pendingMove.current === null;
    pendingMove.current = toDevice(event);
    if (first) {
      requestAnimationFrame(() => {
        const point = pendingMove.current;
        pendingMove.current = null;
        if (point)
          stream.send({
            type: "input_mouse",
            eventType: "mouseMoved",
            ...point,
            button: "none",
            modifiers: modifiers(event),
          });
      });
    }
  };

  const onMouseButton =
    (eventType: "mousePressed" | "mouseReleased") => (event: React.MouseEvent) => {
      if (!driving) return;
      event.preventDefault();
      surface.current?.focus();
      stream.send({
        type: "input_mouse",
        eventType,
        ...toDevice(event),
        button: BUTTONS[event.button] ?? "left",
        clickCount: Math.max(1, event.detail),
        modifiers: modifiers(event),
      });
    };

  useEffect(() => {
    const element = surface.current;
    if (element === null || !driving) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      stream.send({
        type: "input_mouse",
        eventType: "mouseWheel",
        ...toDevice(event),
        button: "none",
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  });

  const onKey = (eventType: "keyDown" | "keyUp") => (event: React.KeyboardEvent) => {
    if (!driving) return;
    const shortcut = event.metaKey || event.ctrlKey;
    // Leave paste to the onPaste handler so clipboard text reaches the page.
    if (shortcut && event.key.toLowerCase() === "v") return;
    event.preventDefault();
    const text = eventType === "keyDown" && !shortcut ? keyText(event.key) : undefined;
    // The sandbox runs Linux, where shortcuts use Ctrl, so a Mac's Cmd is sent as Ctrl.
    const cmdAsCtrl = isMac() && event.key === "Meta";
    const message: Record<string, unknown> = {
      type: "input_keyboard",
      eventType,
      key: cmdAsCtrl ? "Control" : event.key,
      code: cmdAsCtrl ? "ControlLeft" : event.code,
      windowsVirtualKeyCode: cmdAsCtrl ? 17 : event.keyCode,
      modifiers: modifiers(event),
    };
    if (text !== undefined) message.text = text;
    stream.send(message);
  };

  const onPaste = (event: React.ClipboardEvent) => {
    if (!driving) return;
    event.preventDefault();
    for (const character of event.clipboardData.getData("text/plain")) {
      stream.send({
        type: "input_keyboard",
        eventType: "keyDown",
        key: character,
        text: character,
      });
      stream.send({ type: "input_keyboard", eventType: "keyUp", key: character });
    }
  };

  // The /api/live route runs these in the sandbox; agent-browser's stream has no history messages.
  const navigate = (action: "back" | "forward" | "reload") => {
    stream.send({ type: "history", action });
    surface.current?.focus();
  };

  const ratio = size ? size.width / size.height : 16 / 9;
  // Nothing shows until there is a screen to show; then the card pops into its corner.
  const visible = shown !== undefined || streaming;
  // Expanded, take about 80% of the window; the browser chrome is about 52px tall.
  const style = expanded
    ? { width: `min(80vw, calc((80svh - 52px) * ${ratio}))` }
    : { top: pip.top, right: pip.right, width: PIP_WIDTH };
  const mode = pinned
    ? "replay"
    : driving
      ? "user"
      : approvals.length > 0
        ? "waiting"
        : agentBusy
          ? "agent"
          : "idle";
  const url = (streaming ? stream.url : null) ?? shown?.url ?? null;
  // A desktop screen is the whole Linux display, so it gets no browser chrome of its own.
  const screenDevice = pinned?.screen?.device ?? (streaming ? device : (shown?.device ?? device));

  return (
    <>
      <div
        className={`browser-wrap ${expanded ? "browser-expanded" : `browser-docked ${visible ? "pip-visible" : ""}`}`}
        ref={card}
        style={style}
      >
        {/* Over the screen but outside the viewport, so clicking Approve is never forwarded. */}
        {expanded ? <ApprovalBanner approvals={approvals} onRespond={onRespond} /> : null}
        <div className={`browser browser-${mode}`}>
          <div
            className="browser-chrome"
            onLostPointerCapture={onDragEnd}
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
          >
            {screenDevice === "desktop" ? (
              <div className="screen-label">
                <Monitor size={14} />
                Linux desktop
              </div>
            ) : (
              <>
                <div className="chrome-left">
                  <span aria-hidden="true" className="lights">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="chrome-nav">
                    <button
                      aria-label="Back"
                      className="nav-button"
                      disabled={!driving}
                      onClick={() => navigate("back")}
                      title="Back"
                      type="button"
                    >
                      <ArrowLeft size={14} />
                    </button>
                    <button
                      aria-label="Forward"
                      className="nav-button"
                      disabled={!driving}
                      onClick={() => navigate("forward")}
                      title="Forward"
                      type="button"
                    >
                      <ArrowRight size={14} />
                    </button>
                    <button
                      aria-label="Reload"
                      className="nav-button"
                      disabled={!driving}
                      onClick={() => navigate("reload")}
                      title="Reload"
                      type="button"
                    >
                      <Refresh size={14} />
                    </button>
                  </span>
                </div>
                {driving ? (
                  <AddressBar
                    onOpen={(target) => stream.send({ type: "open", url: target })}
                    url={url}
                  />
                ) : (
                  <div className="url-pill" title={url ?? ""}>
                    {url?.startsWith("https:") ? <Lock className="url-lock" size={12} /> : null}
                    <span className="url-text">
                      {url ? displayUrl(url) : DEVICES[device].label}
                    </span>
                  </div>
                )}
              </>
            )}
            <div className="chrome-right">
              {expanded ? (
                <button
                  aria-label="Collapse"
                  className="icon-button icon-button-tertiary"
                  onClick={() => setExpanded(false)}
                  title="Back to the corner (Esc)"
                  type="button"
                >
                  <Collapse size={14} />
                </button>
              ) : null}
              {pinned ? (
                <button
                  aria-label="Back to Live"
                  className="button button-sm button-secondary"
                  onClick={onExitReplay}
                  title="Back to Live"
                  type="button"
                >
                  <Refresh size={14} />
                  <span className="button-label">Back to Live</span>
                </button>
              ) : driving ? (
                <button
                  className="button button-sm button-warning"
                  onClick={onHandBack}
                  type="button"
                >
                  <Sparkle size={14} />
                  Hand Back
                </button>
              ) : drivable && expanded ? (
                <button
                  className="button button-sm button-secondary"
                  onClick={onTakeControl}
                  title={agentBusy ? "Stop the agent and take over" : undefined}
                  type="button"
                >
                  <Pointer size={14} />
                  Take Over
                </button>
              ) : null}
            </div>
          </div>

          <div
            aria-label="Agent's screen"
            className="viewport"
            onClick={expanded ? undefined : () => setExpanded(true)}
            onContextMenu={(event) => driving && event.preventDefault()}
            onKeyDown={onKey("keyDown")}
            onKeyUp={onKey("keyUp")}
            onMouseDown={onMouseButton("mousePressed")}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseButton("mouseReleased")}
            onPaste={onPaste}
            ref={surface}
            style={{ aspectRatio: String(ratio) }}
            tabIndex={0}
          >
            {/* Kept mounted so frames can draw before it shows; `.frame` would override `hidden`. */}
            <canvas
              className="frame"
              ref={canvas}
              style={streaming ? undefined : { display: "none" }}
            />
            {!streaming && shown ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img alt="The agent's screen" className="frame" src={shown.imageDataUrl} />
            ) : null}
            {expanded ? null : (
              <span className="dock-hint">
                <Expand size={14} />
                Expand
              </span>
            )}

            {mode === "replay" ? (
              <div className="mode mode-replay">
                <Clock size={13} />
                After this step
              </div>
            ) : mode !== "idle" && (streaming || shown) ? (
              <div className={`mode mode-${mode}`}>
                {mode === "agent" ? (
                  <AgentIndicator active size={14} />
                ) : mode === "waiting" ? (
                  <Shield size={13} />
                ) : (
                  <Pointer size={13} />
                )}
                {mode === "user"
                  ? "You're driving"
                  : mode === "waiting"
                    ? "Waiting for you"
                    : "Agent working"}
              </div>
            ) : null}

            {current && (streaming || shown) ? (
              <div className="hud">
                <div className="hud-card hud-now">
                  <AgentIndicator active size={16} />
                  <span className="shimmer hud-now-label">{current.label}</span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {expanded ? (
        <div
          className={`backdrop ${closing ? "backdrop-closing" : ""}`}
          onClick={() => setExpanded(false)}
        />
      ) : null}
    </>
  );
}

/** A keyframe that places the fixed card at a rect; its height follows from its width. */
function placed(rect: { left: number; top: number; width: number }): Keyframe {
  return {
    inset: "auto",
    margin: "0",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
  };
}

/**
 * The address bar while you're driving the browser: type a URL and press Enter to open it,
 * Escape to give up. It follows the page whenever it isn't being edited.
 */
function AddressBar({ url, onOpen }: { url: string | null; onOpen: (url: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <form
      className={`url-pill url-pill-editable ${invalid ? "url-pill-invalid" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        const target = addressBarUrl(draft ?? "");
        if (target === null) {
          setInvalid(true);
          return;
        }
        onOpen(target);
        setDraft(null);
        input.current?.blur();
      }}
    >
      {url?.startsWith("https:") && draft === null ? <Lock className="url-lock" size={12} /> : null}
      <input
        aria-label="Address"
        autoCapitalize="off"
        autoComplete="off"
        className="url-input"
        onBlur={() => {
          setDraft(null);
          setInvalid(false);
        }}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setInvalid(false);
        }}
        onFocus={(event) => {
          setDraft(url ?? "");
          event.currentTarget.select();
        }}
        onKeyDown={(event) => {
          // Keys typed here are for the address bar, not the page.
          event.stopPropagation();
          if (event.key === "Escape") event.currentTarget.blur();
        }}
        placeholder="Enter a URL"
        ref={input}
        spellCheck={false}
        value={draft ?? (url ? displayUrl(url) : "")}
      />
    </form>
  );
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** The screenshot's own pixel size, which sets the view's shape. */
function useImageSize(src: string | undefined) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    // A new chat has no screen yet, so drop the last one's shape too.
    if (src === undefined) {
      setSize(null);
      return;
    }
    const image = new Image();
    image.onload = () => setSize({ width: image.naturalWidth, height: image.naturalHeight });
    image.src = src;
  }, [src]);
  return size;
}

/** CDP's modifier bits, with a Mac's Cmd sent as Ctrl; see onKey. */
function modifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  const mac = isMac();
  const ctrl = event.ctrlKey || (mac && event.metaKey);
  const meta = event.metaKey && !mac;
  return (event.altKey ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

function keyText(key: string): string | undefined {
  if (key === "Enter") return "\r";
  return key.length === 1 ? key : undefined;
}
