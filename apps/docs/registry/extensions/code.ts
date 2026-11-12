import code from "eve/extensions/code";

// For `gh` and `vc` in the sandbox, call `installCodeTooling` from
// `eve/extensions/code/sandbox` in your sandbox's `prepare` callback.
export default code({
  // Optional: broker Vercel credentials into the sandbox through Vercel Connect.
  // vercel: { connector: "vercel/<connector-name>" },
});
