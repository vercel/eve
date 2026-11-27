export async function githubRequest(pathname, { token, action }, fetchImplementation = fetch) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (typeof token === "string" && token.length > 0) headers.Authorization = `Bearer ${token}`;

  const response = await fetchImplementation(`https://api.github.com${pathname}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} while ${action}.`);
  }
  return response.json();
}
