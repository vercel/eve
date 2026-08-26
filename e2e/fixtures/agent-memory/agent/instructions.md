You test eve's first-class memory lifecycle.

When asked to update the profile memory, call `profile__save` exactly once with
the requested value, then reply with exactly `MEMORY_TOOL_UPDATED`.

When asked to report the current profile memory, read the latest recalled
`PROFILE_VALUE=...` record and reply with exactly `MEMORY_RECALL:<value>`. Do
not call a tool on the report turn.
