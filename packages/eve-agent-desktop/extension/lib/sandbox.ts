/**
 * Sandbox helpers for running agent-desktop inside an eve sandbox: install the
 * CLI and a minimal X11 desktop, start the display, session bus and window
 * manager, and build the environment every agent-desktop command needs.
 *
 * This file is also published as `@eve/agent-desktop/sandbox`, so it imports
 * no part of the extension other than its own sibling `./process`.
 */

import { runCommand, type CommandSandbox } from "./process.js";

/** The agent-desktop CLI version this package's tools are written against. */
export const AGENT_DESKTOP_VERSION = "1.0.2";

export const DEFAULT_AGENT_DESKTOP_INSTALL_SPEC = `agent-desktop@${AGENT_DESKTOP_VERSION}`;

/** Where the managed desktop keeps its logs, session-bus address and runtime directory. */
export const DESKTOP_ROOT = "/tmp/agent-desktop-eve";

export const DEFAULT_DISPLAY = ":99";

/**
 * apt packages for a headless X11 desktop that agent-desktop can read: Xvfb,
 * a D-Bus session, the AT-SPI accessibility bus and GTK bridges, and openbox
 * as the window manager (window control and focus need one; openbox is the
 * X11 window manager agent-desktop's own Linux tests run against). Apps the
 * agent should operate come from `extraPackages`.
 */
export const DESKTOP_APT_PACKAGES = [
  "at-spi2-core",
  "dbus-x11",
  "libatk-adaptor",
  "libgail-common",
  "openbox",
  "x11-utils",
  "x11-xserver-utils",
  "xdotool",
  "xvfb",
] as const;

const SESSION_BUS_FILE = `${DESKTOP_ROOT}/dbus-session-address`;
const A11Y_ENV =
  "export GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0 ACCESSIBILITY_ENABLED=1 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1";

export type { SandboxCommandResult, SandboxProcess } from "./process.js";

/** Structural subset of eve's sandbox session; every `ctx.getSandbox()` result satisfies it. */
export type DesktopSandbox = CommandSandbox;

export interface InstallAgentDesktopOptions {
  readonly signal?: AbortSignal;
  /** npm spec for the CLI, such as a tarball or mirror. Defaults to the version this package targets. */
  readonly installSpec?: string;
  /** Install the Xvfb desktop packages. Turn off when the image already has a desktop session. */
  readonly installDesktop?: boolean;
  /** Extra apt packages, such as the apps the agent should operate (`gnome-calculator`, `mousepad`). */
  readonly extraPackages?: readonly string[];
}

export interface StartDesktopOptions {
  readonly signal?: AbortSignal;
  readonly display?: string;
  readonly width?: number;
  readonly height?: number;
}

/** Install the agent-desktop CLI and, by default, the desktop packages. The desktop needs apt and root or passwordless sudo. */
export async function installAgentDesktop(
  sandbox: DesktopSandbox,
  options: InstallAgentDesktopOptions = {},
): Promise<void> {
  const packages = [
    ...(options.installDesktop === false ? [] : DESKTOP_APT_PACKAGES),
    ...(options.extraPackages ?? []),
  ];
  if (packages.length > 0) {
    await runOrThrow(
      sandbox,
      aptInstallCommand(packages),
      "Installing desktop packages",
      options.signal,
    );
  }
  const spec = quoteShellArg(options.installSpec ?? DEFAULT_AGENT_DESKTOP_INSTALL_SPEC);
  await runOrThrow(
    sandbox,
    // A user-writable npm prefix needs no sudo; fall back to sudo for a root-owned one.
    `npm install -g ${spec} || sudo -n npm install -g ${spec}`,
    "Installing agent-desktop",
    options.signal,
  );
}

/**
 * Start the virtual display, a D-Bus session and the window manager. Safe to
 * repeat: each piece starts only when its readiness check fails. A resumed
 * sandbox keeps files but not processes, so call this again (or let the tools
 * do it) after a resume.
 */
export async function startDesktop(
  sandbox: DesktopSandbox,
  options: StartDesktopOptions = {},
): Promise<void> {
  await runOrThrow(sandbox, startDesktopScript(options), "Starting the desktop", options.signal);
}

/** A command that exits 0 when the display, session bus and window manager are all live. */
export function desktopReadyCommand(display: string = DEFAULT_DISPLAY): string {
  return [displayReady(display), sessionBusReady(), windowManagerReady(display)].join(" && ");
}

/**
 * Shell prefix that puts a command inside the desktop session. For the
 * managed desktop it also points at the managed session bus and runtime
 * directory, so launched apps register on the bus agent-desktop reads.
 * Otherwise it leaves the inherited session environment alone.
 */
export function desktopEnvPrefix(display: string = DEFAULT_DISPLAY, managed = true): string {
  return [
    `export DISPLAY=${quoteShellArg(display)}`,
    ...(managed
      ? [
          `export XDG_RUNTIME_DIR=${DESKTOP_ROOT}/runtime`,
          `export DBUS_SESSION_BUS_ADDRESS="$(cat ${SESSION_BUS_FILE} 2>/dev/null)"`,
        ]
      : []),
    A11Y_ENV,
  ].join("; ");
}

function displayReady(display: string): string {
  return `xdpyinfo -display ${quoteShellArg(display)} >/dev/null 2>&1`;
}

function sessionBusReady(): string {
  return `DBUS_SESSION_BUS_ADDRESS="$(cat ${SESSION_BUS_FILE} 2>/dev/null)" dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply / org.freedesktop.DBus.GetId >/dev/null 2>&1`;
}

function windowManagerReady(display: string): string {
  return `DISPLAY=${quoteShellArg(display)} xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -Eq 'window id # 0x[1-9a-f]'`;
}

/** Poll a readiness check for up to `tenths` tenths of a second, then fail with the log. */
function awaitReady(check: string, tenths: number, log: string, what: string): string[] {
  return [
    `for _ in $(seq 1 ${tenths}); do ${check} && break; sleep 0.1; done`,
    `${check} || { cat ${log} >&2; echo '${what} did not start' >&2; exit 1; }`,
  ];
}

function startDesktopScript(options: StartDesktopOptions): string {
  const display = options.display ?? DEFAULT_DISPLAY;
  const d = quoteShellArg(display);
  const size = `${options.width ?? 1280}x${options.height ?? 800}x24`;
  const root = DESKTOP_ROOT;
  return [
    "set -eu",
    "for tool in Xvfb xdpyinfo dbus-launch openbox; do",
    '  command -v "$tool" >/dev/null || { echo "$tool is missing; run installAgentDesktop first" >&2; exit 1; }',
    "done",
    `mkdir -p ${root}/runtime && chmod 700 ${root} ${root}/runtime`,
    `export XDG_RUNTIME_DIR=${root}/runtime`,
    `if ! ${displayReady(display)}; then`,
    `  setsid -f Xvfb ${d} -screen 0 ${size} -nolisten tcp +extension RANDR > ${root}/xvfb.log 2>&1`,
    ...awaitReady(displayReady(display), 50, `${root}/xvfb.log`, "Xvfb"),
    "fi",
    // One session bus, reused across commands. AT-SPI's launcher is activated on it on first use.
    `if ! ${sessionBusReady()}; then`,
    `  eval "$(DISPLAY=${d} dbus-launch --sh-syntax)"`,
    `  printf '%s' "$DBUS_SESSION_BUS_ADDRESS" > ${SESSION_BUS_FILE}`,
    `  chmod 600 ${SESSION_BUS_FILE}`,
    "fi",
    `export DBUS_SESSION_BUS_ADDRESS="$(cat ${SESSION_BUS_FILE})"`,
    `if ! ${windowManagerReady(display)}; then`,
    `  setsid -f env DISPLAY=${d} openbox > ${root}/openbox.log 2>&1`,
    ...awaitReady(windowManagerReady(display), 100, `${root}/openbox.log`, "openbox"),
    `  DISPLAY=${d} xsetroot -solid '#1f1f1f' 2>/dev/null || true`,
    "fi",
  ].join("\n");
}

function aptInstallCommand(packages: readonly string[]): string {
  const list = packages.map(quoteShellArg).join(" ");
  const install = `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${list} && apt-get clean`;
  return [
    "command -v apt-get >/dev/null || { echo 'agent-desktop desktop install needs an apt-based image (Ubuntu 24.04 or later)' >&2; exit 1; }",
    `if [ "$(id -u)" = 0 ]; then sh -c ${quoteShellArg(install)}; else sudo -n sh -c ${quoteShellArg(install)}; fi`,
  ].join("\n");
}

async function runOrThrow(
  sandbox: DesktopSandbox,
  command: string,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runCommand(sandbox, command, signal);
  if ((result.exitCode ?? 0) !== 0) {
    const detail = [result.stderr, result.stdout]
      .map((stream) => (stream ?? "").trim())
      .filter(Boolean)
      .join("\n")
      .slice(-4000);
    throw new Error(`${label} failed (exit ${result.exitCode}): ${detail || "no output"}`);
  }
}

export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
