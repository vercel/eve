import {
  APPROVE_OPTION_ID,
  DENY_OPTION_ID,
  type Interaction,
  type InteractionOption,
} from "eve/events";
import {
  Question,
  QuestionActions,
  QuestionDescription,
  QuestionInput,
  QuestionOption,
  QuestionOptions,
  QuestionPrompt,
  type QuestionResponse,
  QuestionSubmit,
} from "@web/components/ai-elements/question";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Button } from "@web/components/ui/button";
import type { RespondToAgentInput } from "./types";

export function QuestionRequest({
  canRespond,
  interaction,
  onAnswers,
}: {
  readonly canRespond: boolean;
  readonly interaction: Interaction;
  readonly onAnswers: RespondToAgentInput;
}) {
  const { answer, interactionId, request } = interaction;
  const options = request.options ?? [];
  const selectedOption = options.find(
    (option) => option.id === answer?.optionId
  );
  const hasOptions = options.length > 0;
  const acceptsFreeform = request.allowFreeform === true || !hasOptions;

  const submitResponse = ({ selectedValues, text }: QuestionResponse) =>
    onAnswers([{ interactionId, optionId: selectedValues[0], text }]);

  return (
    <Question
      defaultValue={{
        selectedValues: answer?.optionId ? [answer.optionId] : [],
        text: answer?.text ?? "",
      }}
      disabled={
        !canRespond || interaction.status === "settled" || answer !== undefined
      }
      onSubmit={submitResponse}
    >
      <QuestionPrompt>{request.prompt}</QuestionPrompt>
      {hasOptions ? (
        <QuestionOptions
          className="flex-col items-stretch"
          aria-label={request.prompt}
        >
          {options.map((option) => (
            <QuestionOption
              className="justify-start text-left"
              key={option.id}
              value={option.id}
            >
              <span>
                <span className="block">{option.label}</span>
                {option.description ? (
                  <span className="block type-caption opacity-70">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </QuestionOption>
          ))}
        </QuestionOptions>
      ) : null}
      {acceptsFreeform ? (
        <QuestionInput aria-label="Answer" placeholder="Type your answer…" />
      ) : null}
      {answer ? (
        <QuestionDescription>
          Responded: {selectedOption?.label ?? answer.text ?? answer.optionId}
        </QuestionDescription>
      ) : interaction.status === "settled" ? (
        <QuestionDescription>No longer needs an answer.</QuestionDescription>
      ) : (
        <QuestionActions>
          <QuestionSubmit>Answer</QuestionSubmit>
        </QuestionActions>
      )}
    </Question>
  );
}

/** Approve and deny choices, or the options an approval or budget prompt lists. */
export function InteractionActions({
  canRespond,
  interaction,
  onAnswers,
}: {
  readonly canRespond: boolean;
  readonly interaction: Interaction;
  readonly onAnswers: RespondToAgentInput;
}) {
  const { answer, interactionId, request } = interaction;
  const options = request.options ?? defaultApprovalOptions;
  const selectedOption = options.find(
    (option) => option.id === answer?.optionId
  );

  return (
    <Alert variant="warning">
      <AlertTitle>{request.prompt}</AlertTitle>
      <AlertDescription>
        {answer ? (
          <p>
            Responded: {selectedOption?.label ?? answer.text ?? answer.optionId}
          </p>
        ) : interaction.status === "settled" ? (
          <p>No longer needs a response.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {options.map((option) => (
              <Button
                disabled={!canRespond}
                key={option.id}
                onClick={() => {
                  void onAnswers([{ interactionId, optionId: option.id }]);
                }}
                size="sm"
                type="button"
                variant={option.style === "danger" ? "destructive" : "default"}
              >
                {option.label}
              </Button>
            ))}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}

const defaultApprovalOptions: readonly InteractionOption[] = [
  { id: APPROVE_OPTION_ID, label: "Approve", style: "primary" },
  { id: DENY_OPTION_ID, label: "Deny", style: "danger" },
];
