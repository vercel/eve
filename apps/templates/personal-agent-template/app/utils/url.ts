export function getFileName(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split("/").pop() || "file";
    return decodeURIComponent(filename);
  } catch {
    return "file";
  }
}

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function getFaviconUrl(url: string): string {
  return `https://www.google.com/s2/favicons?sz=32&domain=${getDomain(url)}`;
}
