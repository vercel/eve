// Epoch 15 of the state capability. Epoch 16 changes only the sandbox environment type it reaches
// (an opaque provider runtime); state authoring is unchanged, as this example shows.
import { defineState } from "#public/context/index.js";

export const reviews = defineState("compatibility.reviews", () => ({ count: 0, reviewer: "Bob" }));
