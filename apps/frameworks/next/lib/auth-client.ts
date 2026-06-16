export async function signIn(
  providerId: string,
  opts: { returnTo?: string; extraParams?: Record<string, string> } = {},
) {
  const body = new URLSearchParams();
  body.set("csrfToken", await getCsrfToken());
  if (opts.returnTo !== undefined) {
    body.set("callbackUrl", opts.returnTo);
  }
  if (opts.extraParams !== undefined) {
    for (const [k, v] of Object.entries(opts.extraParams)) {
      body.set(k, v);
    }
  }
  await submitAuthAction(`/auth/signin/${encodeURIComponent(providerId)}`, body);
}

export async function signOut(opts: { returnTo?: string } = {}) {
  const body = new URLSearchParams();
  body.set("csrfToken", await getCsrfToken());
  if (opts.returnTo !== undefined) {
    body.set("callbackUrl", opts.returnTo);
  }
  await submitAuthAction("/auth/signout", body);
}

async function getCsrfToken(): Promise<string> {
  const response = await fetch("/auth/csrf");
  if (!response.ok) {
    throw new Error(`Failed to load CSRF token: ${response.status}`);
  }
  const body = (await response.json()) as { csrfToken?: string };
  if (!body.csrfToken) {
    throw new Error("Auth.js did not return a CSRF token.");
  }
  return body.csrfToken;
}

async function submitAuthAction(url: string, body: URLSearchParams): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-auth-return-redirect": "1",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Auth.js action failed: ${response.status}`);
  }
  const result = (await response.json()) as { url?: string };
  if (result.url) {
    window.location.assign(result.url);
  }
}
