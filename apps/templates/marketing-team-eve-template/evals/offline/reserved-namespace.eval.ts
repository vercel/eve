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
    t.check(
      reservedNamespaceForUrl(
        "https://example.private.blob.vercel-storage.com/brand-context/brand.md"
      ) !== null,
      equals(true)
    );
  },
});
