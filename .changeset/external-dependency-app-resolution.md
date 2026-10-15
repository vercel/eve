---
"eve": patch
---

Hosted builds now fail with a clear error when the build output imports a `build.externalDependencies` package, or a subpath of one, that does not resolve inside the output the way Node's ESM loader resolves it (including the conditional export Node selects). Previously the build succeeded and the deployed function crashed at boot with `ERR_MODULE_NOT_FOUND` (for example when only a workspace package installed the dependency) or `ERR_PACKAGE_PATH_NOT_EXPORTED` (when the copied version does not export the imported subpath). The error names the import and the app `package.json` to add the package to.
