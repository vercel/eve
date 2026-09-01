import { afterEach, describe, expect, it, vi } from "vitest";

import { createTeamsFetchFile, normalizeTeamsFilesPolicy } from "./attachments.js";

describe("createTeamsFetchFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    "smba.trafficmanager.net",
    "smba.infra.gcc.teams.microsoft.com",
    "smba.infra.gov.teams.microsoft.us",
    "smba.infra.dod.teams.microsoft.us",
  ])("authenticates Bot Framework attachment downloads from %s", async (host) => {
    const apiFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer connector-token");
      return new Response(Buffer.from("image"), {
        headers: { "content-type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", apiFetch);

    const fetchFile = createTeamsFetchFile(
      normalizeTeamsFilesPolicy({
        allowedHosts: [host],
        enabled: true,
      }),
      {
        credentials: { tokenProvider: () => "connector-token" },
        fetch: apiFetch,
      },
    );

    await expect(
      fetchFile(`https://${host}/amer/v3/attachments/ATTACHMENT/views/original`),
    ).resolves.toMatchObject({ mediaType: "image/png" });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["https://smba.trafficmanager.net.evil.example/attachments/image"])(
    "does not send the Connector token to lookalike URLs: %s",
    async (url) => {
      const host = new URL(url).hostname;
      const apiFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return new Response(Buffer.from("file"));
      });
      const tokenProvider = vi.fn(() => "connector-token");
      const fetchFile = createTeamsFetchFile(
        normalizeTeamsFilesPolicy({ allowedHosts: [host], enabled: true }),
        { credentials: { tokenProvider }, fetch: apiFetch },
      );

      await expect(fetchFile(url)).resolves.toBeTruthy();
      expect(tokenProvider).not.toHaveBeenCalled();
    },
  );

  it("rejects insecure URLs before fetching", async () => {
    const apiFetch = vi.fn();
    const fetchFile = createTeamsFetchFile(
      normalizeTeamsFilesPolicy({ allowedHosts: ["smba.trafficmanager.net"], enabled: true }),
      { credentials: { tokenProvider: () => "connector-token" }, fetch: apiFetch },
    );

    await expect(fetchFile("http://smba.trafficmanager.net/attachments/image")).resolves.toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects alternate ports unless the allowlist names the port", async () => {
    const apiFetch = vi.fn();
    const tokenProvider = vi.fn(() => "connector-token");
    const fetchFile = createTeamsFetchFile(
      normalizeTeamsFilesPolicy({ allowedHosts: ["smba.trafficmanager.net"], enabled: true }),
      { credentials: { tokenProvider }, fetch: apiFetch },
    );

    await expect(
      fetchFile("https://smba.trafficmanager.net:8443/attachments/image"),
    ).resolves.toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("never authenticates an explicitly allowlisted alternate port", async () => {
    const apiFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(Buffer.from("file"));
    });
    const tokenProvider = vi.fn(() => "connector-token");
    const fetchFile = createTeamsFetchFile(
      normalizeTeamsFilesPolicy({
        allowedHosts: ["smba.trafficmanager.net:8443"],
        enabled: true,
      }),
      { credentials: { tokenProvider }, fetch: apiFetch },
    );

    await expect(
      fetchFile("https://smba.trafficmanager.net:8443/attachments/image"),
    ).resolves.toBeTruthy();
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("never sends the Connector token to arbitrary allowlisted hosts", async () => {
    const apiFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(Buffer.from("public file"));
    });
    const tokenProvider = vi.fn(() => "connector-token");

    const fetchFile = createTeamsFetchFile(
      normalizeTeamsFilesPolicy({ allowedHosts: ["files.example.com"], enabled: true }),
      { credentials: { tokenProvider }, fetch: apiFetch },
    );

    await expect(fetchFile("https://files.example.com/report.pdf")).resolves.toBeTruthy();
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("reports the status and host without leaking signed URL query parameters", async () => {
    const apiFetch = vi.fn(async () => new Response(null, { status: 401 }));
    const fetchFile = createTeamsFetchFile(
      normalizeTeamsFilesPolicy({
        allowedHosts: ["smba.trafficmanager.net"],
        enabled: true,
      }),
      {
        credentials: { tokenProvider: () => "connector-token" },
        fetch: apiFetch,
      },
    );

    const result = fetchFile("https://smba.trafficmanager.net/attachments/image?sig=SECRET");
    await expect(result).rejects.toThrow("HTTP 401 for host smba.trafficmanager.net");
    await expect(result).rejects.not.toThrow("SECRET");
  });

  it.each([
    "https://files.example.com/redirected",
    "http://smba.trafficmanager.net/attachments/image",
    "https://smba.trafficmanager.net:8443/attachments/image",
    "https://smba.trafficmanager.net.evil.example/attachments/image",
  ])("rejects disallowed redirects before requesting %s", async (location) => {
    const apiFetch = vi.fn(async () => Response.redirect(location, 302));
    const fetchFile = createTeamsFetchFile(
      normalizeTeamsFilesPolicy({ allowedHosts: ["smba.trafficmanager.net"], enabled: true }),
      { credentials: { tokenProvider: () => "connector-token" }, fetch: apiFetch },
    );

    await expect(fetchFile("https://smba.trafficmanager.net/attachments/image")).rejects.toThrow(
      "not allowed",
    );
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("revalidates allowed redirects without forwarding the Connector token", async () => {
    const apiFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer connector-token");
        return Response.redirect("https://files.example.com/image", 302);
      })
      .mockImplementationOnce(async (_url, init) => {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return new Response(Buffer.from("image"), { headers: { "content-type": "image/png" } });
      });
    const fetchFile = createTeamsFetchFile(
      normalizeTeamsFilesPolicy({
        allowedHosts: ["smba.trafficmanager.net", "files.example.com"],
        enabled: true,
      }),
      { credentials: { tokenProvider: () => "connector-token" }, fetch: apiFetch },
    );

    await expect(
      fetchFile("https://smba.trafficmanager.net/attachments/image"),
    ).resolves.toMatchObject({ mediaType: "image/png" });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
