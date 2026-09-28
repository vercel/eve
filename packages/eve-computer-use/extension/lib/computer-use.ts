import type { SandboxSession } from "eve/sandbox";

import { shellQuote } from "./shell.ts";

const DISPLAY = ":99";
const COMPUTER_USE_DIR = "computer-use";
const DRIVER_DIR = ".eve-code/computer-use-driver";
const MANAGED_BROWSER_DIR = ".eve-code/managed-browser";

type PathSandbox = Pick<SandboxSession, "resolvePath">;

export function computerUsePaths(sandbox: PathSandbox) {
  const root = sandbox.resolvePath(COMPUTER_USE_DIR);
  const driverRoot = sandbox.resolvePath(DRIVER_DIR);
  return {
    root,
    driverRoot,
    driverSocket: `${root}/cua-driver.sock`,
    latestScreenshot: `${root}/latest.png`,
    managedBrowserRoot: sandbox.resolvePath(MANAGED_BROWSER_DIR),
  };
}
const TERMINAL_FONT = "GeistMono Nerd Font";
const FIREFOX_USER_JS = [
  'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);',
  'user_pref("ui.systemUsesDarkTheme", 1);',
  'user_pref("browser.theme.toolbar-theme", 0);',
  'user_pref("browser.theme.content-theme", 0);',
  // Force prefers-color-scheme: dark for page content as well as browser chrome.
  'user_pref("layout.css.prefers-color-scheme.content-override", 0);',
  'user_pref("privacy.resistFingerprinting", false);',
  // Keep Colloid's native XFWM title bar instead of Firefox's tab/title bar.
  'user_pref("browser.tabs.inTitlebar", 0);',
  'user_pref("browser.toolbars.bookmarks.visibility", "never");',
  // Keep address-bar recordings deterministic and free of recommendation UI.
  'user_pref("browser.urlbar.quicksuggest.enabled", false);',
  'user_pref("browser.urlbar.suggest.quicksuggest.nonsponsored", false);',
  'user_pref("browser.urlbar.suggest.quicksuggest.sponsored", false);',
  'user_pref("browser.urlbar.suggest.searches", false);',
  'user_pref("browser.urlbar.suggest.topsites", false);',
  'user_pref("browser.urlbar.suggest.trending", false);',
  'user_pref("browser.urlbar.suggest.history", false);',
  'user_pref("browser.urlbar.suggest.bookmark", false);',
  'user_pref("browser.urlbar.suggest.openpage", false);',
  'user_pref("browser.urlbar.maxRichResults", 0);',
  'user_pref("browser.newtabpage.activity-stream.feeds.topsites", false);',
  'user_pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);',
].join("\n");
const FIREFOX_USER_CHROME = `
@namespace url("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul");

/* Demo chrome: native title bar, then back/forward and the address bar. */
#TabsToolbar,
#toolbar-menubar,
#PersonalToolbar,
#PanelUI-button,
#fxa-toolbar-menu-button,
#firefox-view-button,
#unified-extensions-button,
#downloads-button,
#home-button,
#library-button,
#nav-bar-overflow-button,
#identity-box,
#tracking-protection-icon-container,
#page-action-buttons {
  display: none !important;
}

#main-window {
  background: #000 !important;
}

#navigator-toolbox {
  background: #111 !important;
  border-radius: 8px 8px 0 0 !important;
  overflow: hidden !important;
}

#nav-bar {
  background: #111 !important;
  border: 0 !important;
  box-shadow: none !important;
  min-height: 42px !important;
  padding: 4px 8px !important;
}

/* Firefox paints its rectangular client surface over XFWM's lower corners.
   Clip the browser content so the black window background forms the radius. */
#browser,
#appcontent,
#tabbrowser-tabbox,
#tabbrowser-tabpanels {
  background: #000 !important;
  border-radius: 0 0 8px 8px !important;
  overflow: hidden !important;
}

#urlbar-background {
  background: #1a1a1a !important;
  border: 1px solid #333 !important;
  border-radius: 6px !important;
  box-shadow: none !important;
}

#urlbar-input,
#urlbar-scheme {
  color: #ededed !important;
}

#back-button,
#forward-button {
  display: flex !important;
  color: #ededed !important;
}
`;
const TERMINAL_XRESOURCES = [
  "XTerm*background: #0A0A0A",
  "XTerm*foreground: #bbbbbb",
  "XTerm*cursorColor: #bbbbbb",
  "XTerm*pointerColor: #bbbbbb",
  "XTerm*highlightColorMode: true",
  "XTerm*highlightReverse: false",
  "XTerm*highlightColor: #ffffff",
  "XTerm*highlightTextColor: #000000",
  "XTerm*scrollBar: false",
  "XTerm*toolBar: false",
  "XTerm*color0: #000000",
  "XTerm*color1: #e52222",
  "XTerm*color2: #a6e32d",
  "XTerm*color3: #fc951e",
  "XTerm*color4: #c48dff",
  "XTerm*color5: #fa2573",
  "XTerm*color6: #67d9f0",
  "XTerm*color7: #f2f2f2",
  "XTerm*color8: #555555",
  "XTerm*color9: #ff5555",
  "XTerm*color10: #55ff55",
  "XTerm*color11: #ffff55",
  "XTerm*color12: #5555ff",
  "XTerm*color13: #ff55ff",
  "XTerm*color14: #55ffff",
  "XTerm*color15: #ffffff",
].join("\n");

type LaunchAction =
  | { action: "launch"; app: "xterm"; instance?: "primary" | "secondary" }
  | { action: "launch"; app: "firefox"; url?: string };

type DriverAction = { action: string } & Record<string, unknown>;

interface ComputerUseDriverRequest {
  action: DriverAction;
  screenshotPath: string;
}

export function screenshotPath(sandbox: PathSandbox, path?: string): string {
  const paths = computerUsePaths(sandbox);
  return path === undefined ? paths.latestScreenshot : `${paths.root}/${path}`;
}

export function recordingPath(sandbox: PathSandbox, path?: string): string {
  return `${computerUsePaths(sandbox).root}/${path ?? `recording-${crypto.randomUUID()}.mp4`}`;
}

export function computerUseDriverRequest(
  action: DriverAction,
  screenshot: string,
): ComputerUseDriverRequest {
  return { action, screenshotPath: screenshot };
}

export function computerUseDriverCommand(sandbox: PathSandbox): string {
  return `node ${shellQuote(`${computerUsePaths(sandbox).driverRoot}/client.mjs`)}`;
}

export function computerUseDriverStartCommand(sandbox: PathSandbox): string {
  const paths = computerUsePaths(sandbox);
  const requestEnv = `COMPUTER_USE_REQUEST='{"action":"health"}'`;
  const socketEnv = `COMPUTER_USE_SOCKET_PATH=${shellQuote(paths.driverSocket)}`;
  const rootEnv = `COMPUTER_USE_ROOT=${shellQuote(paths.root)}`;
  const client = `node ${shellQuote(`${paths.driverRoot}/client.mjs`)}`;
  const health = `${requestEnv} ${socketEnv} ${client}`;
  return [
    "set -euo pipefail",
    `mkdir -p ${shellQuote(paths.root)}`,
    `if ! ${health} >/dev/null 2>&1; then`,
    `  rm -f ${shellQuote(paths.driverSocket)}`,
    `  setsid -f env DISPLAY=${DISPLAY} XCURSOR_SIZE=32 CUA_DRIVER_RS_TELEMETRY_ENABLED=false CUA_DRIVER_RS_UPDATE_CHECK=false ${socketEnv} ${rootEnv} node ${shellQuote(`${paths.driverRoot}/server.mjs`)} </dev/null > ${shellQuote(`${paths.root}/cua-driver.log`)} 2>&1`,
    "fi",
    "for _ in $(seq 1 100); do",
    `  ${health} >/dev/null 2>&1 && exit 0`,
    "  sleep 0.1",
    "done",
    `tail -n 200 ${shellQuote(`${paths.root}/cua-driver.log`)} >&2 || true`,
    "exit 1",
  ].join("\n");
}

export function computerUseDisplayCommand(sandbox: PathSandbox): string {
  const { root } = computerUsePaths(sandbox);
  const xfconf = [
    xfconfSetCommand("xsettings", "/Net/ThemeName", "string", "Colloid-Dark"),
    xfconfSetCommand("xsettings", "/Net/PreferDarkTheme", "bool", "true"),
    xfconfSetCommand("xsettings", "/Net/IconThemeName", "string", "Adwaita"),
    xfconfSetCommand("xsettings", "/Gtk/CursorThemeSize", "int", "32"),
    xfconfSetCommand("xfwm4", "/general/theme", "string", "Colloid-Dark"),
    xfconfSetCommand("xsettings", "/Gtk/FontName", "string", "Geist 10"),
    xfconfSetCommand("xsettings", "/Gtk/MonospaceFontName", "string", "GeistMono Nerd Font 10"),
    xfconfSetCommand("xfwm4", "/general/button_layout", "string", "CHM|"),
    xfconfSetCommand("xfwm4", "/general/title_alignment", "string", "center"),
    xfconfSetCommand("xfwm4", "/general/title_font", "string", "Geist Medium 11"),
    xfconfSetCommand("xfwm4", "/general/show_dock_shadow", "bool", "false"),
    xfconfSetCommand("xfwm4", "/general/shadow_opacity", "int", "35"),
  ];
  return [
    "set -euo pipefail",
    "command -v Xvfb >/dev/null && command -v xfwm4 >/dev/null || exit 0",
    `mkdir -p ${root}`,
    "if ! xdpyinfo -display :99 >/dev/null 2>&1; then",
    `  setsid -f Xvfb ${DISPLAY} -screen 0 1920x1080x24 -ac +extension RANDR > ${root}/xvfb.log 2>&1`,
    "fi",
    "for _ in $(seq 1 50); do",
    `  xdpyinfo -display ${DISPLAY} >/dev/null 2>&1 && break`,
    "  sleep 0.1",
    "done",
    `xdpyinfo -display ${DISPLAY} >/dev/null`,
    // A full startxfce4 session launches unnecessary panel, desktop, and power daemons.
    // Colloid needs the smaller D-Bus, xfsettingsd, and xfwm4 session for its dark palette.
    `dbus_output=$(dbus-launch --sh-syntax)`,
    `eval "$dbus_output"`,
    ...xfconf,
    // xfconf values are read through this D-Bus session. Keep the address in
    // a root-owned file so later launch/layout commands can use the same
    // session instead of silently falling back to a decoration-less WM.
    `printf '%s' "$DBUS_SESSION_BUS_ADDRESS" > ${root}/dbus-session-address`,
    `chmod 0600 ${root}/dbus-session-address`,
    `setsid -f env DISPLAY=${DISPLAY} DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" XCURSOR_SIZE=32 xfsettingsd --replace > ${root}/xfsettingsd.log 2>&1`,
    "for _ in $(seq 1 50); do",
    "  pgrep -f '[x]fsettingsd' >/dev/null && break",
    "  sleep 0.1",
    "done",
    `if ! pgrep -f '[x]fsettingsd' >/dev/null; then cat ${root}/xfsettingsd.log >&2 || true; echo 'xfsettingsd did not start' >&2; exit 1; fi`,
    // Colloid's rounded SVG corners require an alpha compositor. Xvfb supports
    // Composite; leaving it enabled avoids opaque white corner rectangles.
    `setsid -f env DISPLAY=${DISPLAY} DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" XCURSOR_SIZE=32 xfwm4 --replace --compositor=on > ${root}/xfwm4.log 2>&1`,
    // A process check can race with xfwm4 exiting during startup. Require the
    // EWMH root-window marker that proves a live WM actually owns the display.
    "for _ in $(seq 1 100); do",
    `  DISPLAY=${DISPLAY} xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -Eq 'window id # 0x[1-9a-f]' && break`,
    "  sleep 0.1",
    "done",
    `if ! DISPLAY=${DISPLAY} xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -Eq 'window id # 0x[1-9a-f]'; then`,
    `  cat ${root}/xfwm4.log >&2 || true`,
    `  echo 'xfwm4 did not claim the X11 display' >&2`,
    "  exit 1",
    "fi",
    `DISPLAY=${DISPLAY} xsetroot -solid '#000000'`,
  ].join("\n");
}

function desktopEnvironmentPrefix(sandbox: PathSandbox): string {
  const { root } = computerUsePaths(sandbox);
  return `export DISPLAY=${DISPLAY}; export DBUS_SESSION_BUS_ADDRESS="$(cat ${root}/dbus-session-address)"; export XCURSOR_SIZE=32`;
}

function xfconfSetCommand(
  channel: string,
  property: string,
  type: "bool" | "int" | "string",
  value: string,
): string {
  return `DISPLAY=${DISPLAY} xfconf-query -c ${channel} -p ${property} --create -t ${type} -s ${shellQuote(value)}`;
}

export function computerUseDesktopSizeCommand(
  sandbox: PathSandbox,
  size: "full_hd" | "large_16_9" | "social_16_9",
): string {
  const dimensions = {
    full_hd: "1920x1080",
    large_16_9: "1600x900",
    social_16_9: "1280x720",
  }[size];
  return [
    desktopEnvironmentPrefix(sandbox),
    `if xdotool search --onlyvisible --class firefox-esr >/dev/null 2>&1 || xdotool search --onlyvisible --classname ComputerUseTerminalPrimary >/dev/null 2>&1 || xdotool search --onlyvisible --classname ComputerUseTerminalSecondary >/dev/null 2>&1; then`,
    `  echo 'desktop size must be selected before launching managed windows' >&2`,
    "  exit 1",
    "fi",
    `xrandr --fb ${dimensions}`,
    `xdpyinfo -display ${DISPLAY} | grep -q 'dimensions: *${dimensions} pixels'`,
    `xdotool mousemove $(( \${dimensions%x*} / 2 )) $(( \${dimensions#*x} / 2 ))`,
    `xsetroot -solid '#000000'`,
  ].join("\n");
}

export function computerUseLaunchCommand(sandbox: PathSandbox, action: LaunchAction): string {
  const paths = computerUsePaths(sandbox);
  const root = paths.root;
  switch (action.app) {
    case "xterm": {
      const instance = action.instance ?? "primary";
      const resourceName =
        instance === "primary" ? "ComputerUseTerminalPrimary" : "ComputerUseTerminalSecondary";
      const title = instance === "primary" ? "Terminal 1" : "Terminal 2";
      const findWindow = `DISPLAY=${DISPLAY} xdotool search --onlyvisible --classname ${resourceName}`;
      return [
        `mkdir -p ${root}`,
        `printf '%s\\n' ${shellQuote(TERMINAL_XRESOURCES)} > ${root}/Xresources`,
        `printf '%s\\n' ${shellQuote(`unset PROMPT_COMMAND; unset CI; export TERM=xterm-256color; export PATH='${paths.managedBrowserRoot}:'"$PATH"; export PS1='▲  \\W/ '`)} > ${root}/terminal-rc`,
        desktopEnvironmentPrefix(sandbox),
        `xrdb -merge ${root}/Xresources`,
        `if ! ${findWindow} >/dev/null 2>&1; then`,
        `  setsid -f env DISPLAY=${DISPLAY} DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" xterm -name ${resourceName} -title ${shellQuote(title)} -xrm '${resourceName}*background: #0A0A0A' -xrm '${resourceName}*foreground: #bbbbbb' -xrm '${resourceName}*cursorColor: #bbbbbb' -xrm '${resourceName}*highlightColorMode: true' -xrm '${resourceName}*highlightReverse: false' -xrm '${resourceName}*highlightColor: #ffffff' -xrm '${resourceName}*highlightTextColor: #000000' -fa ${shellQuote(TERMINAL_FONT)} -fs 18 -hm -selbg '#ffffff' -selfg '#000000' +bc +sb -e bash --noprofile --rcfile ${root}/terminal-rc -i </dev/null > ${root}/xterm-${instance}.log 2>&1`,
        "fi",
        "for _ in $(seq 1 50); do",
        `  ${findWindow} >/dev/null 2>&1 && break`,
        "  sleep 0.1",
        "done",
        `window=$(${findWindow} | head -n 1)`,
        `xdotool windowactivate --sync "$window"`,
        requireWindowDecorationCommand('"$window"', `xterm ${instance}`),
        computerUseWindowLayoutCommand(sandbox, "maximized", '"$window"'),
      ].join("\n");
    }
    case "firefox": {
      const profile = `${root}/firefox-profile`;
      const findWindow = `DISPLAY=${DISPLAY} xdotool search --onlyvisible --class firefox-esr`;
      const navigate = action.url
        ? [
            `  window=$(${findWindow} | head -n 1)`,
            `  previous_title=$(DISPLAY=${DISPLAY} xdotool getwindowname "$window" 2>/dev/null || true)`,
            `  DISPLAY=${DISPLAY} xdotool windowactivate --sync "$window"`,
            `  DISPLAY=${DISPLAY} xdotool key --clearmodifiers ctrl+l`,
            `  DISPLAY=${DISPLAY} xdotool type --clearmodifiers ${shellQuote(action.url)}`,
            `  DISPLAY=${DISPLAY} xdotool key --clearmodifiers Return`,
          ]
        : [];
      const waitForNavigation = action.url
        ? [
            `window=$(${findWindow} | head -n 1)`,
            "for _ in $(seq 1 50); do",
            `  title=$(DISPLAY=${DISPLAY} xdotool getwindowname "$window" 2>/dev/null || true)`,
            '  [[ -n "${title}" && "${title}" != "${previous_title}" ]] && break',
            "  sleep 0.1",
            "done",
          ]
        : [];

      return [
        `mkdir -p ${root} ${profile}/chrome`,
        `printf '%s\n' ${shellQuote(FIREFOX_USER_JS)} > ${profile}/user.js`,
        `printf '%s\n' ${shellQuote(FIREFOX_USER_CHROME)} > ${profile}/chrome/userChrome.css`,
        desktopEnvironmentPrefix(sandbox),
        `if ! ${findWindow} >/dev/null 2>&1; then`,
        ...(action.url ? ["  previous_title='Mozilla Firefox'"] : []),
        `  setsid -f env DISPLAY=${DISPLAY} DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" GTK_THEME=Colloid-Dark firefox-esr --no-remote --new-instance --profile ${profile} ${shellQuote(action.url ?? "about:blank")} </dev/null > ${root}/firefox.log 2>&1`,
        ...(navigate.length > 0 ? ["else", ...navigate] : []),
        "fi",
        "for _ in $(seq 1 100); do",
        `  ${findWindow} >/dev/null 2>&1 && break`,
        "  sleep 0.1",
        "done",
        `${findWindow} >/dev/null`,
        ...waitForNavigation,
        `window=$(${findWindow} | head -n 1)`,
        `DISPLAY=${DISPLAY} xdotool windowactivate --sync "$window"`,
        requireWindowDecorationCommand('"$window"', "Firefox"),
        computerUseWindowLayoutCommand(sandbox, "maximized", '"$window"'),
      ].join("\n");
    }
  }
}

function requireWindowDecorationCommand(window: string, label: string): string {
  return [
    "for _ in $(seq 1 50); do",
    `  DISPLAY=${DISPLAY} xprop -id ${window} _NET_FRAME_EXTENTS 2>/dev/null | grep -q '=.*,' && break`,
    "  sleep 0.1",
    "done",
    `DISPLAY=${DISPLAY} xprop -id ${window} _NET_FRAME_EXTENTS 2>/dev/null | grep -q '=.*,' || { echo ${shellQuote(`${label} opened without window-manager decorations`)} >&2; exit 1; }`,
  ].join("\n");
}

export function computerUseFocusCommand(
  sandbox: PathSandbox,
  app: "firefox" | "xterm",
  instance: "primary" | "secondary" = "primary",
): string {
  const search =
    app === "firefox"
      ? "xdotool search --onlyvisible --class firefox-esr"
      : `xdotool search --onlyvisible --classname ${instance === "primary" ? "ComputerUseTerminalPrimary" : "ComputerUseTerminalSecondary"}`;
  return [
    desktopEnvironmentPrefix(sandbox),
    `window=$(${search} | head -n 1)`,
    `test -n "$window" || { echo ${shellQuote(`${app} ${instance} window is not running`)} >&2; exit 1; }`,
    `xdotool windowactivate --sync "$window"`,
  ].join("\n");
}

export function computerUseWindowLayoutCommand(
  sandbox: PathSandbox,
  layout: "maximized" | "left" | "right",
  window = '"$(DISPLAY=:99 xdotool getactivewindow)"',
): string {
  const geometry = {
    maximized: { height: '"$usable_height"', width: '"$usable_width"', x: "24", y: "24" },
    left: { height: '"$usable_height"', width: '"$left_width"', x: "24", y: "24" },
    right: {
      height: '"$usable_height"',
      width: '"$right_width"',
      x: '"$right_x"',
      y: "24",
    },
  }[layout];
  return [
    desktopEnvironmentPrefix(sandbox),
    `dimensions=$(xdpyinfo -display ${DISPLAY} | awk '/dimensions:/{print $2; exit}')`,
    `screen_width="\${dimensions%x*}"`,
    `screen_height="\${dimensions#*x}"`,
    `usable_width=$((screen_width - 48))`,
    `usable_height=$((screen_height - 48))`,
    `left_width=$(((usable_width - 12) / 2))`,
    `right_x=$((24 + left_width + 12))`,
    `right_width=$((usable_width - left_width - 12))`,
    `xdotool windowactivate --sync ${window}`,
    `xdotool windowmove ${window} ${geometry.x} ${geometry.y}`,
    `xdotool windowsize ${window} ${geometry.width} ${geometry.height}`,
  ].join("\n");
}
