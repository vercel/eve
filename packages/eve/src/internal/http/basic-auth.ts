export function encodeBasicCredentials(username: string, password: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(`${username}:${password}`);
  const binaryString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");
  return btoa(binaryString);
}
