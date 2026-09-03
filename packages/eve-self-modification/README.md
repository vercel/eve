# @eve/self-modification

`@eve/self-modification` is a compatibility package. It forwards its entrypoints to the implementation included with `eve`.

Update imports to use `eve` directly:

```ts
import { defineSelfModificationAgent } from "eve/self-modification/agent";

export default defineSelfModificationAgent();
```

```ts
export { default } from "eve/self-modification/sandbox";
```

```ts
export { default } from "eve/self-modification";
```
