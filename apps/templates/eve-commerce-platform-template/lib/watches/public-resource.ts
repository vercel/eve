import { lookup } from "node:dns";
import { get } from "node:https";
import { isPublicAddress, productUrl } from "./product-url.ts";

export function getPublicResource(
  url: URL,
  options: {
    readonly accept: string;
    readonly contentType: RegExp;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  },
): Promise<{ bytes: Buffer } | { redirect: string }> {
  const target = productUrl(url.href);
  return new Promise((resolve, reject) => {
    const request = get(
      target,
      {
        agent: false,
        family: 4,
        signal: options.signal,
        headers: { Accept: options.accept, "User-Agent": "evey-public-research/1.0" },
        lookup(host, _options, callback) {
          lookup(host, { family: 4, all: true }, (error, addresses) => {
            if (error) return callback(error, "", 4);
            const [first] = addresses;
            if (!first || addresses.some(({ address }) => !isPublicAddress(address))) {
              return callback(new Error("URL did not resolve to public IPv4 addresses."), "", 4);
            }
            callback(null, first.address, 4);
          });
        },
      },
      async (response) => {
        try {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            response.destroy();
            resolve({ redirect: response.headers.location });
            return;
          }
          if (
            status !== 200 ||
            !options.contentType.test(response.headers["content-type"] ?? "") ||
            Number(response.headers["content-length"]) > options.maxBytes
          ) {
            throw new Error("The public resource is unsupported or unavailable.");
          }
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of response) {
            total += chunk.length;
            if (total > options.maxBytes)
              throw new Error("The public resource exceeded the read limit.");
            chunks.push(chunk);
          }
          resolve({ bytes: Buffer.concat(chunks) });
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    request.on("error", reject);
  });
}
