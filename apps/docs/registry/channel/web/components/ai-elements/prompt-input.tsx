"use client";

import { InputGroup, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import type { FileUIPart } from "ai";
import { ArrowUpIcon } from "lucide-react";
import { nanoid } from "nanoid";
import type {
  ChangeEventHandler,
  ClipboardEventHandler,
  ComponentProps,
  FormEvent,
  FormEventHandler,
  HTMLAttributes,
  KeyboardEventHandler,
} from "react";
import {
  Children,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const convertBlobUrlToDataUrl = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    // oxlint-disable-next-line eslint-plugin-promise(avoid-new)
    return new Promise((resolve) => {
      const reader = new FileReader();
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      reader.onloadend = () => resolve(reader.result as string);
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
};

interface AttachmentsContext {
  files: (FileUIPart & { id: string })[];
  add: (files: File[] | FileList) => void;
  remove: (id: string) => void;
  clear: () => void;
}

const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);

export const usePromptInputAttachments = () => {
  const context = useContext(LocalAttachmentsContext);
  if (!context) {
    throw new Error("usePromptInputAttachments must be used within a PromptInput");
  }
  return context;
};

export interface PromptInputMessage {
  text: string;
  files: FileUIPart[];
}

type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit" | "onError"> & {
  accept?: string;
  multiple?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
  onError?: (err: { code: "max_files" | "max_file_size" | "accept"; message: string }) => void;
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
};

export const PromptInput = ({
  className,
  accept,
  multiple,
  maxFiles,
  maxFileSize,
  onError,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [files, setFiles] = useState<(FileUIPart & { id: string })[]>([]);
  const filesRef = useRef(files);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const matchesAccept = useCallback(
    (file: File) => {
      if (!accept || accept.trim() === "") return true;
      const patterns = accept
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return patterns.some((pattern) =>
        pattern.endsWith("/*") ? file.type.startsWith(pattern.slice(0, -1)) : file.type === pattern,
      );
    },
    [accept],
  );

  const add = useCallback(
    (fileList: File[] | FileList) => {
      const incoming = [...fileList];
      const accepted = incoming.filter(matchesAccept);
      if (incoming.length && accepted.length === 0) {
        onError?.({ code: "accept", message: "No files match the accepted types." });
        return;
      }
      const sized = accepted.filter((file) => (maxFileSize ? file.size <= maxFileSize : true));
      if (accepted.length > 0 && sized.length === 0) {
        onError?.({ code: "max_file_size", message: "All files exceed the maximum size." });
        return;
      }
      setFiles((prev) => {
        const capacity =
          typeof maxFiles === "number" ? Math.max(0, maxFiles - prev.length) : undefined;
        const capped = typeof capacity === "number" ? sized.slice(0, capacity) : sized;
        if (typeof capacity === "number" && sized.length > capacity) {
          onError?.({ code: "max_files", message: "Too many files. Some were not added." });
        }
        return [
          ...prev,
          ...capped.map((file) => ({
            filename: file.name,
            id: nanoid(),
            mediaType: file.type,
            type: "file" as const,
            url: URL.createObjectURL(file),
          })),
        ];
      });
    },
    [matchesAccept, maxFiles, maxFileSize, onError],
  );

  const remove = useCallback(
    (id: string) =>
      setFiles((prev) => {
        const found = prev.find((file) => file.id === id);
        if (found?.url) URL.revokeObjectURL(found.url);
        return prev.filter((file) => file.id !== id);
      }),
    [],
  );

  const clear = useCallback(
    () =>
      setFiles((prev) => {
        for (const file of prev) {
          if (file.url) URL.revokeObjectURL(file.url);
        }
        return [];
      }),
    [],
  );

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
      if (event.dataTransfer?.files && event.dataTransfer.files.length > 0)
        add(event.dataTransfer.files);
    };
    form.addEventListener("dragover", onDragOver);
    form.addEventListener("drop", onDrop);
    return () => {
      form.removeEventListener("dragover", onDragOver);
      form.removeEventListener("drop", onDrop);
    };
  }, [add]);

  useEffect(
    () => () => {
      for (const file of filesRef.current) {
        if (file.url) URL.revokeObjectURL(file.url);
      }
    },
    [],
  );

  const handleChange: ChangeEventHandler<HTMLInputElement> = useCallback(
    (event) => {
      if (event.currentTarget.files) add(event.currentTarget.files);
      // Reset so the same file can be selected again after removal.
      event.currentTarget.value = "";
    },
    [add],
  );

  const attachments = useMemo(() => ({ add, clear, files, remove }), [add, clear, files, remove]);

  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const text = (new FormData(form).get("message") as string) || "";
      // Capture and reset before conversion so text typed while it runs isn't lost.
      form.reset();
      try {
        const convertedFiles: FileUIPart[] = await Promise.all(
          files.map(async ({ id: _id, ...item }) => {
            if (item.url?.startsWith("blob:")) {
              const dataUrl = await convertBlobUrlToDataUrl(item.url);
              return { ...item, url: dataUrl ?? item.url };
            }
            return item;
          }),
        );
        await onSubmit({ files: convertedFiles, text }, event);
        clear();
      } catch {
        // Keep attachments available for a retry.
      }
    },
    [files, onSubmit, clear],
  );

  return (
    <LocalAttachmentsContext.Provider value={attachments}>
      <input
        accept={accept}
        aria-label="Upload files"
        className="hidden"
        multiple={multiple}
        onChange={handleChange}
        title="Upload files"
        type="file"
      />
      <form className="w-full" onSubmit={handleSubmit} ref={formRef} {...props}>
        <InputGroup
          className={cn(
            "overflow-hidden rounded-2xl bg-card/80 shadow-sm backdrop-blur-md",
            "focus-within:border-foreground! has-[[data-slot=input-group-control]:focus-visible]:border-foreground!",
            className,
          )}
        >
          {children}
        </InputGroup>
      </form>
    </LocalAttachmentsContext.Provider>
  );
};

export const PromptInputTextarea = ({
  onChange,
  onKeyDown,
  className,
  placeholder = "What would you like to know?",
  ...props
}: ComponentProps<typeof InputGroupTextarea>) => {
  const attachments = usePromptInputAttachments();
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (event.key === "Enter") {
        if (isComposing || event.nativeEvent.isComposing || event.shiftKey) return;
        event.preventDefault();
        const { form } = event.currentTarget;
        const submitButton = form?.querySelector(
          'button[type="submit"]',
        ) as HTMLButtonElement | null;
        if (submitButton?.disabled) return;
        form?.requestSubmit();
      }
      if (
        event.key === "Backspace" &&
        event.currentTarget.value === "" &&
        attachments.files.length > 0
      ) {
        event.preventDefault();
        const lastAttachment = attachments.files.at(-1);
        if (lastAttachment) attachments.remove(lastAttachment.id);
      }
    },
    [onKeyDown, isComposing, attachments],
  );

  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        event.preventDefault();
        attachments.add(files);
      }
    },
    [attachments],
  );

  const handleCompositionEnd = useCallback(() => setIsComposing(false), []);
  const handleCompositionStart = useCallback(() => setIsComposing(true), []);

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-48 min-h-18 text-base md:text-sm", className)}
      name="message"
      onCompositionEnd={handleCompositionEnd}
      onCompositionStart={handleCompositionStart}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={placeholder}
      {...props}
      onChange={onChange}
    />
  );
};

export const PromptInputButton = ({
  variant = "ghost",
  className,
  size,
  ...props
}: ComponentProps<typeof InputGroupButton>) => (
  <InputGroupButton
    className={cn(
      "rounded-full",
      variant === "outline" && "bg-card hover:bg-card dark:hover:bg-input/30",
      className,
    )}
    size={size ?? (Children.count(props.children) > 1 ? "sm" : "icon-sm")}
    type="button"
    variant={variant}
    {...props}
  />
);

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon-sm",
  children,
  ...props
}: ComponentProps<typeof InputGroupButton>) => (
  <InputGroupButton
    aria-label="Submit"
    className={cn("absolute right-2.5 bottom-2.5 rounded-full", className)}
    size={size}
    type="submit"
    variant={variant}
    {...props}
  >
    {children ?? <ArrowUpIcon className="size-4" />}
  </InputGroupButton>
);
