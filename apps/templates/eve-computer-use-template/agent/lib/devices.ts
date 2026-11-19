/** The screens the agent can operate in its sandbox. The web app's picker chooses one per chat. */
export const DEVICES = {
  browser: {
    label: "Browser",
    description: "A headless Chrome in the sandbox, driven with the browser__* tools.",
    /** What `decide` weighs in Auto mode; see apps/web/app/api/device/route.ts. */
    criteria:
      "Tasks on websites: opening pages, searching, reading or summarizing content, clicking through a site, and filling in web forms.",
  },
  desktop: {
    label: "Desktop",
    description:
      "A Linux desktop with Firefox, terminals, a calculator, and a text editor in the sandbox, driven with computer__computer_use and computer__launch_app.",
    criteria:
      "Tasks that need a desktop: terminals and shell commands, desktop apps such as a calculator or a text editor, files and windows, or a task that names Firefox or the desktop itself.",
  },
} as const;

export type DeviceName = keyof typeof DEVICES;

/** What the picker offers: a device, or Auto, which lets `decide` pick one from the first task. */
export type DeviceChoice = DeviceName | "auto";

export const DEFAULT_DEVICE: DeviceName = "browser";

export function isDeviceName(value: unknown): value is DeviceName {
  return typeof value === "string" && Object.hasOwn(DEVICES, value);
}

/** The browser extension's agent-browser session, so the live view streams the browser the agent drives. */
export const BROWSER_SESSION = "agent";

/** The note sent with each message, so the agent uses the device the user picked. */
export function deviceContext(name: DeviceName): string {
  return `The user picked the ${DEVICES[name].label} device: ${DEVICES[name].description} Use only its tools.`;
}
