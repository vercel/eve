---
"eve": patch
---

Update the scaffold's default agent model to `anthropic/claude-sonnet-5`. New agents created with `eve init` (and the setup model picker's pre-selected default) now use Claude Sonnet 5 instead of Claude Sonnet 4.6. Also adds a `DEFAULT_EVAL_MODEL` export to `eve/evals` for eval authors who want a shared default model.
