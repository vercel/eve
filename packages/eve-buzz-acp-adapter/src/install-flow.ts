import { resolve } from "node:path";

export type InstallTarget = { kind: "local"; directory: string } | { kind: "remote"; url: string };

export interface InstallPrompter {
  intro(title: string, subtitle?: string): void;
  outro(message: string): void;
  text(options: {
    message: string;
    defaultValue?: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  select<T extends string | boolean>(options: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<T>;
  log: {
    success(message: string): void;
    info(message: string): void;
  };
}

export function classifyTarget(value: string, cwd: string): InstallTarget {
  if (looksLikeRemoteTarget(value)) return classifyRemoteTarget(value);
  return { kind: "local", directory: resolve(cwd, value) };
}

export function classifyRemoteTarget(value: string): InstallTarget {
  const input = value.trim();
  const url = new URL(hasUrlScheme(input) ? input : `https://${input}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Remote eve URLs must use HTTP or HTTPS");
  }
  if (url.protocol === "http:" && !isLoopbackUrl(url)) {
    throw new Error("Remote eve URLs must use HTTPS unless they target loopback");
  }
  return { kind: "remote", url: url.toString().replace(/\/$/, "") };
}

export async function chooseInstallTarget(options: {
  cwd: string;
  explicitTarget?: InstallTarget;
  interactive: boolean;
  prompter?: InstallPrompter;
}): Promise<InstallTarget> {
  if (options.explicitTarget) return options.explicitTarget;
  if (!options.interactive || options.prompter === undefined) {
    throw new Error("Specify --local <directory> or --url <url> for non-interactive install");
  }

  const mode = await options.prompter.select({
    message: "Where does your eve agent run?",
    options: [
      { value: "local", label: "Local directory", hint: "Launch and supervise eve locally" },
      { value: "remote", label: "Deployed URL", hint: "Connect to an existing deployment" },
    ],
    initialValue: "local",
  });
  if (mode === "local") {
    const directory = await options.prompter.text({
      message: "eve application directory",
      defaultValue: options.cwd,
      validate: (value) => (value.trim() ? undefined : "Enter an application directory"),
    });
    return { kind: "local", directory: resolve(options.cwd, directory) };
  }

  const url = await options.prompter.text({
    message: "eve deployment URL",
    placeholder: "agent.example.com",
    validate: validateRemoteUrl,
  });
  return classifyRemoteTarget(url);
}

export async function confirmInstall(options: {
  interactive: boolean;
  yes: boolean;
  prompter?: InstallPrompter;
}): Promise<boolean> {
  if (options.yes) return true;
  if (!options.interactive || options.prompter === undefined) {
    throw new Error("Pass --yes to confirm a non-interactive install");
  }
  return await options.prompter.select({
    message: "Install eve Buzz harness?",
    options: [
      { value: true, label: "Install" },
      { value: false, label: "Cancel" },
    ],
    initialValue: true,
  });
}

function validateRemoteUrl(value: string): string | undefined {
  try {
    classifyRemoteTarget(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Enter a valid URL";
  }
}

function looksLikeRemoteTarget(value: string): boolean {
  const input = value.trim();
  if (hasUrlScheme(input)) return true;
  if (/^(?:\.{1,2}[\\/]|[~/\\])/.test(input)) return false;
  const authority = input.split("/", 1)[0] ?? "";
  return authority === "localhost" || authority.startsWith("localhost:") || authority.includes(".");
}

function hasUrlScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function isLoopbackUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  );
}
