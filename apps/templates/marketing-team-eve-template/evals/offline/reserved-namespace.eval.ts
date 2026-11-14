import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import {
  reservedNamespaceForPath,
  reservedNamespaceForUrl,
} from "../../agent/lib/vercel-blob/config.js";

export default defineEval({
  description:
    "the asset tools' guard reserves every managed Blob prefix and nothing else.",
  test(t) {
    const reserved = (pathname: string) =>
      reservedNamespaceForPath(pathname) !== null;
    t.check(reserved("brand-context/brand.md"), equals(true));
    t.check(reserved("/brand-context/brand.md"), equals(true));
    t.check(reserved("artifacts/seo-audit-pricing-k3f9qz.md"), equals(true));
    t.check(reserved("eve/memory/file/someone-else.md"), equals(true));
    t.check(reserved("user-preferences/abc.md"), equals(true));
    t.check(reserved("drafts/launch-post.md"), equals(false));
    for (const pathname of [
      "brand-context/brand.md",
      "ev%65/memory/file/someone-else/MEMORY.md",
      "brand-context%2Fbrand.md",
      "artifacts%2Fhandoff.md",
      "user-preferenc%65s/alice.md",
      "%invalid",
    ]) {
      t.check(
        reservedNamespaceForUrl(
          `https://example.private.blob.vercel-storage.com/${pathname}`
        ) !== null,
        equals(true)
      );
    }
    t.check(
      reservedNamespaceForUrl(
        "https://example.private.blob.vercel-storage.com/drafts/launch%20post.md"
      ),
      equals(null)
    );
  },
});
