# @eve/self-modification

## 5.0.4

### Patch Changes

- 7941ad9: Include authored TypeScript entrypoints in the published package so installed self-modification scaffolds compile without workspace source, and clean generated scaffold output before each build.
- 05a53cd: The self-modification subagent can now search the eve registry. A new
  `selfmod__search_registry` tool reports the channels, MCP connections,
  extensions, and observability integrations a project can add — each with its
  item address, whether the authored tree already holds it, and the eve version it
  requires — so the subagent recommends `eve add channel/slack` instead of
  hand-writing an integration the registry already ships. Search is read-only and
  installs nothing. Results include pagination metadata so every match can be
  retrieved, and bundle searches include their component names and metadata.
- Updated dependencies [dbfa01c]
- Updated dependencies [5a029d9]
- Updated dependencies [2bbb775]
- Updated dependencies [2a34f75]
- Updated dependencies [1b1f2dd]
- Updated dependencies [8f2bf7a]
- Updated dependencies [bca1304]
- Updated dependencies [50488a1]
- Updated dependencies [94a0952]
- Updated dependencies [4464e4d]
  - eve@0.44.4

## 5.0.3

### Patch Changes

- Updated dependencies [ebf94fa]
  - eve@0.44.3

## 5.0.2

### Patch Changes

- Updated dependencies [e79dd2f]
  - eve@0.44.2

## 5.0.1

### Patch Changes

- Updated dependencies [7c99773]
- Updated dependencies [02403b9]
- Updated dependencies [84ddb09]
- Updated dependencies [85b2dc8]
- Updated dependencies [a4fd288]
- Updated dependencies [923921c]
- Updated dependencies [673def2]
  - eve@0.44.1

## 5.0.0

### Patch Changes

- Updated dependencies [47e8b64]
- Updated dependencies [beba1a2]
- Updated dependencies [830dd40]
- Updated dependencies [4da95bb]
- Updated dependencies [4ed62a7]
- Updated dependencies [e43d9cb]
  - eve@0.44.0

## 4.0.0

### Patch Changes

- Updated dependencies [1c2684a]
- Updated dependencies [1390675]
- Updated dependencies [f3f4f4a]
- Updated dependencies [7de783e]
- Updated dependencies [3ec0e5b]
- Updated dependencies [b57c965]
- Updated dependencies [3811d81]
- Updated dependencies [be9be27]
- Updated dependencies [1390675]
- Updated dependencies [99de091]
- Updated dependencies [f3f4f4a]
- Updated dependencies [3811d81]
  - eve@0.43.0

## 3.0.0

### Patch Changes

- Updated dependencies [f2169fa]
- Updated dependencies [a43e14f]
  - eve@0.42.0

## 2.0.0

### Patch Changes

- Updated dependencies [0569638]
- Updated dependencies [bdf5f63]
- Updated dependencies [c47350f]
- Updated dependencies [c47350f]
- Updated dependencies [9e19fa4]
  - eve@0.41.0

## 1.0.0

### Patch Changes

- Updated dependencies [e843b4d]
- Updated dependencies [899e079]
- Updated dependencies [cda9539]
- Updated dependencies [2838bb3]
- Updated dependencies [87c61a1]
  - eve@0.40.0

## 0.0.1

### Patch Changes

- 9a7964b: Add a configurable, development-only `@eve/self-modification` source-editing subagent that mounts authored agent source read-write, exposes its instructions through an extension, and uses structured file tools to inspect and safely update source.
- Updated dependencies [c2bfee1]
- Updated dependencies [9a7964b]
- Updated dependencies [542c380]
- Updated dependencies [75bd9c8]
- Updated dependencies [6fc904d]
  - eve@0.39.3
