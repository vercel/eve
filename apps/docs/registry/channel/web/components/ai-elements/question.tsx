"use client";

import type {
  ChangeEvent,
  ComponentProps,
  FormEvent,
  HTMLAttributes,
  MouseEvent,
  ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

export interface QuestionValue {
  selectedValues: readonly string[];
  text: string;
}

export interface QuestionResponse {
  selectedValues: readonly string[];
  text?: string;
}

type SelectionMode = "multiple" | "single";

interface QuestionContextValue {
  disabled: boolean;
  selectedValues: readonly string[];
  selectionMode: SelectionMode;
  setText: (text: string) => void;
  text: string;
  toggleValue: (value: string) => void;
}

const QuestionContext = createContext<QuestionContextValue | null>(null);

const useQuestion = () => {
  const context = useContext(QuestionContext);

  if (!context) {
    throw new Error("Question components must be used within Question");
  }

  return context;
};

export type QuestionProps = Omit<ComponentProps<"form">, "defaultValue" | "onSubmit" | "value"> & {
  defaultValue?: QuestionValue;
  disabled?: boolean;
  onSubmit?: (
    response: QuestionResponse,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
  onValueChange?: (value: QuestionValue) => void;
  selectionMode?: SelectionMode;
  value?: QuestionValue;
};

const EMPTY_VALUE: QuestionValue = { selectedValues: [], text: "" };

const getSelectedValues = (
  currentValues: readonly string[],
  optionValue: string,
  selectionMode: SelectionMode,
): readonly string[] => {
  const isSelected = currentValues.includes(optionValue);

  if (selectionMode === "single") {
    return isSelected ? [] : [optionValue];
  }

  if (isSelected) {
    return currentValues.filter((item) => item !== optionValue);
  }

  return [...currentValues, optionValue];
};

export const Question = ({
  children,
  className,
  defaultValue = EMPTY_VALUE,
  disabled = false,
  onSubmit,
  onValueChange,
  selectionMode = "single",
  value: controlledValue,
  ...props
}: QuestionProps) => {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const value = controlledValue ?? internalValue;

  const setValue = useCallback(
    (nextValue: QuestionValue) => {
      if (controlledValue === undefined) {
        setInternalValue(nextValue);
      }
      onValueChange?.(nextValue);
    },
    [controlledValue, onValueChange],
  );

  const setText = useCallback(
    (text: string) => {
      setValue({ ...value, text });
    },
    [setValue, value],
  );

  const toggleValue = useCallback(
    (optionValue: string) => {
      const selectedValues = getSelectedValues(value.selectedValues, optionValue, selectionMode);
      setValue({ ...value, selectedValues });
    },
    [selectionMode, setValue, value],
  );

  const contextValue = useMemo(
    () => ({
      disabled,
      selectedValues: value.selectedValues,
      selectionMode,
      setText,
      text: value.text,
      toggleValue,
    }),
    [disabled, selectionMode, setText, toggleValue, value],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (disabled) {
        return;
      }

      const text = value.text.trim();
      if (value.selectedValues.length === 0 && text.length === 0) {
        return;
      }

      await onSubmit?.(
        {
          selectedValues: value.selectedValues,
          text: text.length > 0 ? text : undefined,
        },
        event,
      );
    },
    [disabled, onSubmit, value],
  );

  return (
    <QuestionContext.Provider value={contextValue}>
      <form
        className={cn("space-y-4 rounded-lg border bg-background p-4", className)}
        onSubmit={handleSubmit}
        {...props}
      >
        {children}
      </form>
    </QuestionContext.Provider>
  );
};

export type QuestionPromptProps = HTMLAttributes<HTMLParagraphElement>;

export const QuestionPrompt = ({ className, ...props }: QuestionPromptProps) => (
  <p className={cn("font-medium text-sm", className)} {...props} />
);

export type QuestionDescriptionProps = HTMLAttributes<HTMLParagraphElement>;

export const QuestionDescription = ({ className, ...props }: QuestionDescriptionProps) => (
  <p className={cn("text-muted-foreground text-sm", className)} {...props} />
);

export type QuestionOptionsProps = HTMLAttributes<HTMLDivElement>;

export const QuestionOptions = ({ className, ...props }: QuestionOptionsProps) => {
  const { selectionMode } = useQuestion();

  return (
    <div
      className={cn("flex flex-wrap gap-2", className)}
      role={selectionMode === "single" ? "radiogroup" : "group"}
      {...props}
    />
  );
};

export type QuestionOptionProps = Omit<ComponentProps<typeof Button>, "value"> & {
  value: string;
};

export const QuestionOption = ({
  children,
  className,
  disabled,
  onClick,
  value,
  variant,
  ...props
}: QuestionOptionProps) => {
  const question = useQuestion();
  const isSelected = question.selectedValues.includes(value);
  const role = question.selectionMode === "single" ? "radio" : "checkbox";
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      question.toggleValue(value);
      onClick?.(event);
    },
    [onClick, question, value],
  );

  return (
    <Button
      aria-checked={isSelected}
      className={cn("h-auto whitespace-normal", className)}
      disabled={question.disabled || disabled}
      onClick={handleClick}
      role={role}
      type="button"
      variant={variant ?? (isSelected ? "default" : "outline")}
      {...props}
    >
      {children ?? value}
    </Button>
  );
};

export type QuestionInputProps = Omit<ComponentProps<typeof Textarea>, "defaultValue" | "value">;

export const QuestionInput = ({ className, disabled, onChange, ...props }: QuestionInputProps) => {
  const question = useQuestion();
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      question.setText(event.currentTarget.value);
      onChange?.(event);
    },
    [onChange, question],
  );

  return (
    <Textarea
      className={cn("min-h-20", className)}
      disabled={question.disabled || disabled}
      onChange={handleChange}
      value={question.text}
      {...props}
    />
  );
};

export type QuestionActionsProps = HTMLAttributes<HTMLDivElement>;

export const QuestionActions = ({ className, ...props }: QuestionActionsProps) => (
  <div className={cn("flex items-center justify-end gap-2", className)} {...props} />
);

export type QuestionSubmitProps = ComponentProps<typeof Button> & {
  children?: ReactNode;
};

export const QuestionSubmit = ({
  children = "Submit",
  disabled,
  ...props
}: QuestionSubmitProps) => {
  const question = useQuestion();
  const hasResponse = question.selectedValues.length > 0 || question.text.trim().length > 0;

  return (
    <Button disabled={question.disabled || disabled || !hasResponse} type="submit" {...props}>
      {children}
    </Button>
  );
};
