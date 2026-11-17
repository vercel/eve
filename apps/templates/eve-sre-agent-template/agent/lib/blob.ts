import { del, get, list, put } from "@vercel/blob";

export interface BlobObjectStore {
  delete: (pathname: string) => Promise<void>;
  list: (prefix: string) => Promise<string[]>;
  read: (pathname: string) => Promise<string | null>;
  write: (pathname: string, content: string) => Promise<void>;
}

export function createBlobObjectStore(
  options: { useCache?: boolean } = {}
): BlobObjectStore {
  return {
    async delete(pathname) {
      await del(pathname);
    },
    async list(prefix) {
      const pathnames: string[] = [];
      let cursor: string | undefined;
      do {
        // biome-ignore lint/performance/noAwaitInLoops: Blob list pages are sequential by cursor
        const page = await list({ cursor, mode: "expanded", prefix });
        const { blobs, cursor: nextCursor } = page;
        pathnames.push(...blobs.map((blob) => blob.pathname));
        cursor = nextCursor;
      } while (cursor);
      return pathnames;
    },
    async read(pathname) {
      const result = await get(pathname, {
        access: "private",
        useCache: options.useCache,
      });
      if (!result) {
        return null;
      }
      return new Response(result.stream).text();
    },
    async write(pathname, content) {
      await put(pathname, content, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      });
    },
  };
}
