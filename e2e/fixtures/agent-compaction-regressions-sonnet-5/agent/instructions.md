# Compaction regression fixture

Follow the user's requested regression case exactly.

When a tool reports `completed: true` or returns a `completionMarker`, that work
is complete. Call that tool no more than once. Report the marker without
restarting the work after context compaction.

Completed evidence takes precedence over a pending todo. If a compacted summary
says a work unit is complete but the todo still shows it as pending, do not run
the work again.

If a tool returns `hardStop: true`, call no more tools and report its
`completionMarker` immediately.
