# @eve/self-modification

## 0.0.6

### Patch Changes

- Updated dependencies [68d44b5]
- Updated dependencies [b20c2aa]
- Updated dependencies [0172af9]
- Updated dependencies [fbc89e5]
- Updated dependencies [3f20c80]
- Updated dependencies [1ee8fa9]
- Updated dependencies [a40ebb0]
  - eve@0.49.0

## 0.0.5

### Patch Changes

- Updated dependencies [62546ab]
- Updated dependencies [f43525a]
- Updated dependencies [b7321c9]
- Updated dependencies [3e2abe5]
- Updated dependencies [453d194]
- Updated dependencies [1d78323]
- Updated dependencies [e219a6a]
- Updated dependencies [d1b3439]
- Updated dependencies [9ed9d29]
- Updated dependencies [1d74287]
- Updated dependencies [859151e]
- Updated dependencies [3c16df6]
  - eve@0.48.0

## 0.0.4

### Patch Changes

- b7ac284: The self-modification subagent can now install items from the configured eve
  registry. A new `selfmod__registry_add` tool runs `eve add <address>
--non-interactive --skip-setup` in the application root under `eve dev`,
  pausing the authored-source watcher for the whole install and reporting the
  item's declared environment variables that are still unset. Failed dependency
  installs restore tracked project files and return a sanitized, structured reason
  instead of implying the project was untouched. Items that declare a setup flow
  or multiple components are never partially installed: the local dev TUI now
  opens their existing setup panel automatically, while headless development
  reports the command that finishes them, so no setup question is answered by the
  model.
- Updated dependencies [b0799b3]
- Updated dependencies [b9eb1b2]
- Updated dependencies [0a1ad48]
- Updated dependencies [aafcb34]
- Updated dependencies [f2c96a1]
- Updated dependencies [7a7da6d]
- Updated dependencies [6a8340f]
- Updated dependencies [ee5e4c7]
- Updated dependencies [c72dc2e]
- Updated dependencies [6a8340f]
- Updated dependencies [1982202]
- Updated dependencies [b7ac284]
- Updated dependencies [7a415bf]
- Updated dependencies [bc2a1f6]
  - eve@0.47.7

## 0.0.3

### Patch Changes

- Updated dependencies [a3b23c0]
- Updated dependencies [52e89ef]
- Updated dependencies [56514d9]
- Updated dependencies [41c8286]
- Updated dependencies [bdb3973]
- Updated dependencies [fccbf2b]
  - eve@0.47.0

## 0.0.2

### Patch Changes

- Updated dependencies [47b3e48]
- Updated dependencies [9c0a138]
- Updated dependencies [7acb4ec]
- Updated dependencies [1d79217]
  - eve@0.46.0

## 0.0.1

### Patch Changes

- 91700b0: Keep self-modification on the pre-1.0 version line by versioning its eve runtime dependency like other separately published eve packages.
- b595a70: When a self-modification registry search finds an exact item in a local `eve dev` session, the subagent now directs you to install it with `/add <address>` instead of attempting the installation itself.
- Updated dependencies [4a18994]
- Updated dependencies [d2995e1]
- Updated dependencies [dfe0d18]
- Updated dependencies [b3cf8ee]
- Updated dependencies [6252784]
- Updated dependencies [659774f]
- Updated dependencies [fc52796]
- Updated dependencies [2be67fa]
- Updated dependencies [7ed4fb1]
- Updated dependencies [0bc8432]
- Updated dependencies [3274eee]
- Updated dependencies [ae83a08]
- Updated dependencies [f439e3d]
- Updated dependencies [80571ee]
- Updated dependencies [7c5a69e]
- Updated dependencies [f38eaf1]
- Updated dependencies [cfa90d6]
- Updated dependencies [d79de0b]
- Updated dependencies [687c371]
- Updated dependencies [8e5d9b2]
- Updated dependencies [7eae011]
- Updated dependencies [c6f9c85]
  - eve@0.45.0
