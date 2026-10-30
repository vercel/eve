---
"eve": patch
---

Agent text that mentions a Nitro build constant such as `import.meta.dev` now reaches production builds unchanged, instead of being rewritten to its value or failing the build.

`eve build` now loads the compiled manifest, compile and model metadata, and prepared sandbox artifacts through a `text:` import, which Nitro leaves untouched.
