---
"eve": patch
---

Hosted builds now fail with a clear error when the build output imports a `build.externalDependencies` package that the output does not contain. Previously the build succeeded and the deployed function crashed at boot with `ERR_MODULE_NOT_FOUND`, for example when only a workspace package installed the dependency. The error names the package and the app `package.json` to add it to.
