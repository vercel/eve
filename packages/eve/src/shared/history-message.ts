// Shapes adapted from @ai-sdk/provider-utils 5.0.58 (Apache-2.0).
// Kept locally so authoring types do not depend on the app's AI SDK version.

type JSONValue =
  | null
  | boolean
  | number
  | string
  | readonly JSONValue[]
  | { readonly [key: string]: JSONValue | undefined };
type ProviderOptions = Record<string, { [key: string]: JSONValue | undefined }>;
type DataContent = string | Uint8Array | ArrayBuffer;
type ProviderReference = Record<string, string> & { type?: never };
type FileDataData = { type: "data"; data: DataContent };
type FileDataUrl = { type: "url"; url: URL; originalUrl?: string };
type FileData =
  | FileDataData
  | FileDataUrl
  | { type: "reference"; reference: ProviderReference }
  | { type: "text"; text: string };

interface TextPart {
  type: "text";
  text: string;
  providerOptions?: ProviderOptions;
}

interface ImagePart {
  type: "image";
  image: DataContent | URL | ProviderReference;
  mediaType?: string;
  providerOptions?: ProviderOptions;
}

interface FilePart {
  type: "file";
  data: FileData | DataContent | URL | ProviderReference;
  filename?: string;
  mediaType: string;
  providerOptions?: ProviderOptions;
}

interface ReasoningPart {
  type: "reasoning";
  text: string;
  providerOptions?: ProviderOptions;
}

interface CustomPart {
  type: "custom";
  kind: `${string}.${string}`;
  providerOptions?: ProviderOptions;
}

interface ReasoningFilePart {
  type: "reasoning-file";
  data: FileDataData | FileDataUrl | DataContent | URL;
  mediaType: string;
  providerOptions?: ProviderOptions;
}

interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerOptions?: ProviderOptions;
  providerExecuted?: boolean;
}

interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: ToolResultOutput;
  providerOptions?: ProviderOptions;
}

type ToolResultOutput =
  | {
      type: "text";
      value: string;
      providerOptions?: ProviderOptions;
    }
  | {
      type: "json";
      value: JSONValue;
      providerOptions?: ProviderOptions;
    }
  | {
      type: "execution-denied";
      reason?: string;
      providerOptions?: ProviderOptions;
    }
  | {
      type: "error-text";
      value: string;
      providerOptions?: ProviderOptions;
    }
  | {
      type: "error-json";
      value: JSONValue;
      providerOptions?: ProviderOptions;
    }
  | {
      type: "content";
      value: Array<
        | {
            type: "text";
            text: string;
            providerOptions?: ProviderOptions;
          }
        | {
            type: "file";
            data: FileData;
            mediaType: string;
            filename?: string;
            providerOptions?: ProviderOptions;
          }
        | {
            type: "file-data";
            data: string;
            mediaType: string;
            filename?: string;
            providerOptions?: ProviderOptions;
          }
        | {
            type: "file-url";
            url: string;
            mediaType?: string;
            providerOptions?: ProviderOptions;
          }
        | {
            type: "file-id";
            fileId: string | Record<string, string>;
            providerOptions?: ProviderOptions;
          }
        | {
            type: "file-reference";
            providerReference: ProviderReference;
            providerOptions?: ProviderOptions;
          }
        | {
            type: "image-data";
            data: string;
            mediaType: string;
            providerOptions?: ProviderOptions;
          }
        | {
            type: "image-url";
            url: string;
            providerOptions?: ProviderOptions;
          }
        | {
            type: "image-file-id";
            fileId: string | Record<string, string>;
            providerOptions?: ProviderOptions;
          }
        | {
            type: "image-file-reference";
            providerReference: ProviderReference;
            providerOptions?: ProviderOptions;
          }
        | {
            type: "custom";
            providerOptions?: ProviderOptions;
          }
      >;
    };

type ToolApprovalRequest = {
  type: "tool-approval-request";
  approvalId: string;
  toolCallId: string;
  reason?: string;
  isAutomatic?: boolean;
  signature?: string;
  inputSchemaInput?: unknown;
};

type ToolApprovalResponse = {
  type: "tool-approval-response";
  approvalId: string;
  approved: boolean;
  reason?: string;
  providerExecuted?: boolean;
};

type SystemModelMessage = {
  role: "system";
  content: string;
  providerOptions?: ProviderOptions;
};

type UserModelMessage = {
  role: "user";
  content: UserContent;
  providerOptions?: ProviderOptions;
};

type UserContent = string | Array<TextPart | ImagePart | FilePart>;

type AssistantModelMessage = {
  role: "assistant";
  content: AssistantContent;
  providerOptions?: ProviderOptions;
};

type AssistantContent =
  | string
  | Array<
      | TextPart
      | CustomPart
      | FilePart
      | ReasoningPart
      | ReasoningFilePart
      | ToolCallPart
      | ToolResultPart
      | ToolApprovalRequest
    >;

type ToolModelMessage = {
  role: "tool";
  content: ToolContent;
  providerOptions?: ProviderOptions;
};

type ToolContent = Array<ToolResultPart | ToolApprovalResponse>;

/** One system, user, assistant, or tool message in an agent's history. */
export type HistoryMessage =
  | SystemModelMessage
  | UserModelMessage
  | AssistantModelMessage
  | ToolModelMessage;
