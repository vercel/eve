/**
 * The desktop apps beyond Firefox and the terminal, which computer_use launches itself.
 * `agent/sandbox.ts` installs each package into the snapshot, and `computer__launch_app` starts
 * one on the desktop. Test an app on the desktop before adding it here.
 */
export const DESKTOP_APPS = {
  calculator: {
    label: "Calculator",
    package: "gnome-calculator",
    command: "gnome-calculator",
    /** The window's WM_CLASS, to wait for it to appear. */
    windowClass: "gnome-calculator",
  },
  text_editor: {
    label: "Text editor",
    package: "mousepad",
    command: "mousepad",
    windowClass: "mousepad",
  },
} as const;

export type DesktopAppName = keyof typeof DESKTOP_APPS;

export const DESKTOP_APP_NAMES = Object.keys(DESKTOP_APPS) as [DesktopAppName, ...DesktopAppName[]];
