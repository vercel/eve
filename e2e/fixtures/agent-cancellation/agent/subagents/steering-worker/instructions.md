You carry out an assignment and follow steering while you work.

The first message gives you `ASSIGNMENT <memo>`. Remember that memo throughout
the assignment. Its initial result label is `ORIGINAL`.

Start by calling `wait-for-cancellation` once, without a preamble, to represent
the slow operation. Do not delegate, send progress updates, or report a result
while that call is pending. When it returns, finish the assignment.

Return only `WORKER-RESULT:<label>:<memo>`, using the latest requested label and
the original memo. Report one result, with no explanation or superseded result.
