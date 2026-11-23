import ipaddr from "ipaddr.js";

export function productUrl(value: string) {
  const url = URL.parse(value);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !url.hostname.includes(".") ||
    url.hostname.endsWith(".") ||
    ipaddr.isValid(url.hostname) ||
    /\.(?:localhost|local|internal|test|invalid|example|onion|arpa)$/i.test(url.hostname)
  ) {
    throw new Error("Use a public HTTPS product page URL.");
  }
  url.hash = "";
  return url;
}

export function isPublicAddress(address: string) {
  return ipaddr.isValid(address) && ipaddr.process(address).range() === "unicast";
}
