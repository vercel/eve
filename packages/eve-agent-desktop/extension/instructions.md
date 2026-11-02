# Desktop

You have desktop tools backed by agent-desktop, operating apps on a Linux desktop in your sandbox through the accessibility tree.

- Start with `list_apps`, or `launch` an app. `--app` values are the names `list_apps` prints (such as `gnome-calculator`), never window titles.
- Observe, act, observe again. `snapshot` returns an interactive tree where every actionable element has a qualified ref like `@s8f3k2p9:e12`; pass refs exactly as printed.
- For a dense app, `snapshot` with `skeleton` first, then drill into one region with `root`. Use `find` when you already know the role and name.
- Refs belong to one snapshot. After the UI changes, take a new snapshot. `STALE_REF`, `AMBIGUOUS_TARGET`, or `SNAPSHOT_NOT_FOUND` all mean: snapshot again and use the new ref.
- Retry an action only when its error says `retry: safe`. Any other delivery may already have landed: read the live state with `get`, `is`, or a new snapshot before acting again, so you never click, type, or submit twice.
- After an action that starts async work or opens a window, use `wait` (for a window, text, or element), not a fixed sleep.
- Actions are headless by default: they use semantic accessibility calls and do not move the pointer or take focus. Pointer tools (`double_click`, `hover`, `drag`, `mouse_*`) only work when the extension is configured as headed; do not use them to recover from a headless failure.
- Use `screenshot` of one app window when the tree is empty or you need to see layout. Prefer the tree for reading text.
- `type` inserts text into a field; `press` sends key combos like `ctrl+s` or `return`.
- Window, clipboard, pointer, and surface tools are not listed up front; find them with `eve__search`.
- Speak to the user in plain language about what you saw and did. Never expose refs, sandbox paths, or tool names. Screenshots are shown to the user automatically.
