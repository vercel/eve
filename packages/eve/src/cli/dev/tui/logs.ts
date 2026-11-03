import { stripAnsi } from "#cli/ui/terminal-text.js";
import type { LogLevel } from "#internal/logging.js";
import {
  parseDevRebuildLogLine,
  type WatcherChangeEvent,
} from "#internal/nitro/host/dev-watcher-log.js";

import type { Block } from "./blocks.js";
import { formatStoredDiagnostic, presentDiagnostic } from "./diagnostic-presentation.js";
import { isLogVisible, type LogDisplayMode } from "./log-display-mode.js";
import type { CapturedLog } from "./terminal.js";

/** The dev watcher's latest rebuild phase, as the status line shows it. */
export type BuildPhase =
  | { readonly phase: "building"; readonly summary: string }
  | { readonly phase: "complete" | "failed" };

/** What one captured log entry changes: transcript blocks to commit, and the build phase. */
interface LogIngest {
  readonly blocks: Block[];
  readonly build?: BuildPhase;
}

const MAX_SUMMARY_PATHS = 3;

/**
 * Turns one captured entry into what the transcript shows under `mode`.
 * Filtering happens here, once: a hidden line is never shown later. The dev
 * watcher's rebuild lines drive the status line instead of the transcript,
 * except a failed rebuild, which always commits as an error.
 */
export function ingestLog(
  entry: CapturedLog,
  options: { readonly mode: LogDisplayMode; readonly diagnosticsPath?: string },
): LogIngest {
  const text = stripAnsi(entry.text).replace(/\s+$/u, "");
  if (text.trim().length === 0) return { blocks: [] };
  const blocks: Block[] = [];
  let build: BuildPhase | undefined;
  let pending: string[] = [];
  const title = entry.source === "stdout" ? "stdout" : "stderr";
  const flush = () => {
    const body = pending.join("\n");
    pending = [];
    if (body.trim().length === 0 || !isLogVisible(options.mode, entry.level)) return;
    blocks.push(logBlock(title, entry.level, presentBody(title, body, options)));
  };
  for (const line of text.split("\n")) {
    const update = parseDevRebuildLogLine(line.trimEnd());
    if (update?.kind === "rebuilding") {
      flush();
      build = { phase: "building", summary: summarizeChangedFiles(update.events, update.more) };
      continue;
    }
    if (update?.kind === "rebuilt" || update?.kind === "reloading") {
      flush();
      build = { phase: "complete" };
      continue;
    }
    if (update?.kind === "failed") {
      flush();
      build = { phase: "failed" };
      blocks.push(logBlock("stderr", "error", line.trimEnd()));
      continue;
    }
    const sandbox = entry.source === "stdout" ? parseSandboxLogLine(line) : undefined;
    if (sandbox !== undefined) {
      flush();
      if (isLogVisible(options.mode, entry.level)) {
        blocks.push({ kind: "sandbox", body: sandbox, live: false });
      }
      continue;
    }
    pending.push(line);
  }
  flush();
  return build === undefined ? { blocks } : { blocks, build };
}

function logBlock(title: string, level: LogLevel | undefined, body: string): Block {
  const block: Block = { kind: "log", title, body, live: false };
  if (level !== undefined) block.logLevel = level;
  return block;
}

/** Long stderr dumps collapse to a summary that points at the diagnostics file, unless all logs show. */
function presentBody(
  title: string,
  body: string,
  options: { readonly mode: LogDisplayMode; readonly diagnosticsPath?: string },
): string {
  if (title !== "stderr" || options.diagnosticsPath === undefined || options.mode === "all") {
    return body;
  }
  const presentation = presentDiagnostic(body, options.diagnosticsPath);
  return presentation.kind === "inline" ? presentation.text : formatStoredDiagnostic(presentation);
}

/**
 * Summarizes watcher change events as `<paths> <verb>`, e.g.
 * `tui/setup-panel.ts changed`: paths shrink to their last two components and
 * anything past three folds into `+N more`.
 */
function summarizeChangedFiles(events: readonly WatcherChangeEvent[], more: number): string {
  const paths = [
    ...new Set(
      events.map((event) =>
        event.path
          .split("/")
          .filter((part) => part.length > 0)
          .slice(-2)
          .join("/"),
      ),
    ),
  ];
  const shown = paths.slice(0, MAX_SUMMARY_PATHS);
  const hidden = paths.length - shown.length + more;
  const kinds = new Set(events.map((event) => event.event));
  const verb = [...kinds].every((kind) => kind === "add" || kind === "addDir")
    ? "added"
    : [...kinds].every((kind) => kind === "unlink" || kind === "unlinkDir")
      ? "removed"
      : "changed";
  return `${shown.join(", ")}${hidden > 0 ? ` +${hidden} more` : ""} ${verb}`;
}

function parseSandboxLogLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("eve: ")) return undefined;
  const message = trimmed.slice("eve: ".length);
  if (!/\bsandbox\b/iu.test(message)) return undefined;
  const lowValue =
    /^initializing (?:\d+ )?sandbox templates?\b/iu.test(message) ||
    /^initialized \d+ sandbox\b/iu.test(message) ||
    /^reused cached sandbox template\b/iu.test(message) ||
    /^sandbox template "[^"]+" \([^)]+\): (checking|reusing)\b/iu.test(message);
  return lowValue ? undefined : message;
}
