import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  realpath: vi.fn(),
  password: vi.fn(),
  entry: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.read, realpath: mocks.realpath }));
vi.mock("node:os", () => ({ homedir: () => "/test/home" }));
vi.mock("node:module", () => ({
  createRequire: () => () => ({
    Entry: class {
      constructor(service: string, name: string) {
        mocks.entry(service, name);
      }
      getPassword() {
        return mocks.password();
      }
    },
  }),
}));
import { readVercelCliConnection } from "./vercel-cli.js";
const base =
  process.platform === "darwin"
    ? "/test/home/Library/Application Support"
    : "/test/home/.local/share";
const configPath = join(base, "com.vercel.cli", "config.json");
const authPath = join(base, "com.vercel.cli", "auth.json");
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VERCEL_TOKEN", "");
  vi.stubEnv("VERCEL_TOKEN_STORAGE", undefined);
  vi.stubEnv("XDG_DATA_HOME", undefined);
  vi.stubEnv("PATH", "/cli/bin");
  mocks.realpath.mockResolvedValue("/cli/node_modules/vercel/dist/index.js");
});
afterEach(() => vi.unstubAllEnvs());
function files(storage: string) {
  mocks.read.mockImplementation(async (path: string) => {
    if (path === configPath) return JSON.stringify({ currentTeam: "team_a", credStorage: storage });
    if (path === authPath)
      return JSON.stringify({ token: "file-token", refreshToken: "never-copy-me" });
    throw new Error("ENOENT");
  });
}
it("reads file credentials and returns no refresh token", async () => {
  files("file");
  expect(await readVercelCliConnection()).toEqual({ token: "file-token", teamId: "team_a" });
  expect(mocks.entry).not.toHaveBeenCalled();
});
it.each(["auto", "keyring"])("reads raw CLI keyring entries in %s mode", async (storage) => {
  files(storage);
  mocks.password.mockReturnValue(
    JSON.stringify({ token: "keyring-token", refreshToken: "never-copy-me" }),
  );
  expect(await readVercelCliConnection()).toEqual({ token: "keyring-token", teamId: "team_a" });
  expect(mocks.entry).toHaveBeenCalledWith(
    "com.vercel.vercel-cli",
    expect.stringMatching(/^cli:[a-f0-9]{16}$/),
  );
});
it("falls back to file credentials when automatic keyring access is unavailable", async () => {
  files("auto");
  mocks.password.mockImplementation(() => {
    throw new Error("Keyring unavailable");
  });
  expect(await readVercelCliConnection()).toEqual({ token: "file-token", teamId: "team_a" });
});
it("does not guess a team when the CLI has no selection", async () => {
  mocks.read.mockResolvedValue("{}");
  expect(await readVercelCliConnection()).toBeUndefined();
});
