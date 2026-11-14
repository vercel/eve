/** The screens the agent can operate in its sandbox. The web app's picker chooses one per message. */
export const DEVICES = {
  browser: {
    label: "Browser",
    description: "A headless Chrome in the sandbox, driven with the browser__* tools.",
  },
  desktop: {
    label: "Desktop",
    description:
      "A Linux desktop with Firefox and terminals in the sandbox, driven with computer__computer_use.",
  },
} as const;

export type DeviceName = keyof typeof DEVICES;

export const DEFAULT_DEVICE: DeviceName = "browser";

/** The browser extension's agent-browser session, so the live view streams the browser the agent drives. */
export const BROWSER_SESSION = "agent";

/** The note sent with each message, so the agent uses the device the user picked. */
export function deviceContext(name: DeviceName): string {
  return `The user picked the ${DEVICES[name].label} device: ${DEVICES[name].description} Use only its tools.`;
}
