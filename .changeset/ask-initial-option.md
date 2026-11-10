---
"eve": minor
---

Preselect an option in a `display: "select"` question by passing `initialOptionId` to `ctx.ask`.

Slack, Discord, Microsoft Teams, and the `eve dev` terminal UI start with that option selected, and ACP clients receive it as the form field's default. On Slack and Discord, a **Use** button submits the preselected option, because those platforms send nothing when a person keeps the current selection. An `initialOptionId` that matches none of the question's `options` is rejected with a `TypeError`.
