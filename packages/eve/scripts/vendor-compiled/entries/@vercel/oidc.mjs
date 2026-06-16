// Thin ESM re-export shim for the vendored `@vercel/oidc` package.
//
// Upstream ships only `dist/index.js` as CommonJS, so rolldown's default
// bundling collapses it into a single default-export object. Pointing the
// vendor pipeline at this wrapper instead lets it surface the same named
// exports eve source uses (`getVercelOidcToken`, …) with no Node CJS
// named-exports interop on the consumer side.
export {
  AccessTokenMissingError,
  RefreshAccessTokenFailedError,
  getContext,
  getVercelOidcToken,
  getVercelOidcTokenSync,
  getVercelToken,
} from "@vercel/oidc";
