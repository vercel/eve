# Declarative tool stub verification

This fixture runs consumer evals with every real model in the `e2e-local`
matrix (`modelMatrix: full`). The tasks journey uses a semantic judge to
distinguish acknowledging a completed task from listing it as still open;
it carries the `real-model` tag. Matching and cross-turn playback also run
with the shared scripted responder in the Postgres and Vercel world suites.
A passing scripted world run is transport/durability evidence, not live-model evidence.

| Contract                                                                                         | Primary proof                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List three tasks, complete the intended task, list two remaining tasks on a later turn           | `evals/tasks.eval.ts`: tool arguments, counts, order, outputs, and final user-visible task list                                                                 |
| Nested partial matching, string and array membership, extra input fields                         | `evals/matching.eval.ts`: actual model-generated arguments select the expected response                                                                         |
| Overlapping rules select the first match                                                         | `evals/matching.eval.ts`: a specific rule precedes a broader matching fallback                                                                                  |
| Several calls to one tool within a turn, then continuation on a later turn                       | `evals/matching.eval.ts`: pending → first result → next result                                                                                                  |
| An unmatched call invokes the real executor                                                      | `evals/matching.eval.ts`: distinct live marker                                                                                                                  |
| Report an injected tool failure and recover on a later retry                                     | `evals/errors.eval.ts`: failed-call assertion, error message, successful retry, and recovered marker                                                            |
| Supported matcher shapes and setup rejection                                                     | `packages/eve/src/tool-stubs/schema.test.ts`: representative matching, rejected keywords and values, no coercion/default mutation                               |
| Independent rule sequences, first-match precedence, replay, persistent-tool restrictions, bounds | `packages/eve/src/tool-stubs/rules.test.ts` and existing runtime integration tests                                                                              |
| Root, child, and nested child paths stay distinct                                                | `execution/tool-stubs/execution.integration.test.ts` and `test/scenarios/nested-tool-stubs.scenario.test.ts`: ordinary and workflow tools through compiled HTTP |
| Concurrent admission, separate session state, multi-turn continuation                            | `agent-workflow-stress/evals/tool-stubs.eval.ts` with its deliberately scripted model                                                                           |

Matcher tests cover eve's supported subset and reject features affected by known
validator defects. They do not duplicate the dependency's conformance suite.
The runtime and compiled HTTP tests cover early rejection of invalid tool paths,
permission to inspect stub results, and recording which rules matched. The eval
runner warns about unused rules without turning them into call expectations.

Live-model evals verify the model/runtime boundary. They do not prove every
schema combination or every possible model response.
