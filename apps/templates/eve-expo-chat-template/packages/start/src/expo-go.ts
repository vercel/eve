/** Turn a Metro Expo Go address into a launch URL that also delivers an app route. */
export function expoGoPairingUrl(value: string): URL {
  let url: URL;
  try {
    if (value.length > 2048) throw Error("Too long");
    url = new URL(value.trim());
  } catch {
    throw Error("Enter the complete exp:// or exps:// Metro URL printed by pnpm mobile:go.");
  }
  if (
    !["exp:", "exps:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    !["", "/"].includes(url.pathname) ||
    url.search ||
    url.hash
  )
    throw Error(
      "Use only the Metro exp:// or exps:// server address, without a path, query, or credentials.",
    );
  url.pathname = "/--/pair";
  return url;
}
