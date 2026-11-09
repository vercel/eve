// Sessions an eve before v27 recorded, as their stored lines: a v26 event per line. Captured from
// a v26 deployment and trimmed: streamed deltas are dropped and long descriptions shortened.

export const KITCHEN_SINK: readonly unknown[] = [
  {
    data: { runtime: { agentId: "v26-spike", agentName: "v26-spike", eveVersion: "0.82.0" } },
    meta: { at: "2026-10-22T21:36:06.909Z", deliveryIds: ["f369f304-02f5-4ee8-9e55-6db429738ac3"] },
    type: "session.started",
  },
  {
    data: { sequence: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:06.912Z", deliveryIds: ["f369f304-02f5-4ee8-9e55-6db429738ac3"] },
    type: "turn.started",
  },
  {
    data: {
      message: "hello there",
      parts: [{ text: "hello there", type: "text" }],
      sequence: 0,
      turnId: "turn_0",
    },
    meta: { at: "2026-10-22T21:36:06.912Z", deliveryIds: ["f369f304-02f5-4ee8-9e55-6db429738ac3"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 0, stepIndex: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:06.914Z", deliveryIds: ["f369f304-02f5-4ee8-9e55-6db429738ac3"] },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 0, stepIndex: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:06.939Z", deliveryIds: ["f369f304-02f5-4ee8-9e55-6db429738ac3"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: "Echo: hello there",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    },
    meta: { at: "2026-10-22T21:36:06.942Z", deliveryIds: ["f369f304-02f5-4ee8-9e55-6db429738ac3"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
      usage: { inputTokens: 316, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:06.944Z", deliveryIds: ["f369f304-02f5-4ee8-9e55-6db429738ac3"] },
    type: "step.completed",
  },
  {
    data: { sequence: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:06.959Z", deliveryIds: ["f369f304-02f5-4ee8-9e55-6db429738ac3"] },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 316, outputTokens: 5 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:06.960Z", deliveryIds: ["f369f304-02f5-4ee8-9e55-6db429738ac3"] },
    type: "session.waiting",
  },
  {
    data: { sequence: 1, turnId: "turn_1" },
    meta: { at: "2026-10-22T21:36:07.146Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "turn.started",
  },
  {
    data: {
      message: "what is the weather",
      parts: [{ text: "what is the weather", type: "text" }],
      sequence: 1,
      turnId: "turn_1",
    },
    meta: { at: "2026-10-22T21:36:07.146Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 1, stepIndex: 0, turnId: "turn_1" },
    meta: { at: "2026-10-22T21:36:07.146Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 1, stepIndex: 0, turnId: "turn_1" },
    meta: { at: "2026-10-22T21:36:07.160Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "tool-calls",
      message: "Let me check the weather.",
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
    },
    meta: { at: "2026-10-22T21:36:07.164Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "message.completed",
  },
  {
    data: {
      actions: [
        {
          callId: "mock-tool-call-2-0-1",
          input: { city: "Paris" },
          kind: "tool-call",
          toolName: "get_weather",
        },
      ],
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
    },
    meta: { at: "2026-10-22T21:36:07.165Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "actions.requested",
  },
  {
    data: {
      result: {
        callId: "mock-tool-call-2-0-1",
        kind: "tool-result",
        output: { city: "Paris", forecast: "sunny", temperatureC: 21 },
        toolName: "get_weather",
      },
      sequence: 1,
      status: "completed",
      stepIndex: 0,
      turnId: "turn_1",
    },
    meta: { at: "2026-10-22T21:36:07.165Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "action.result",
  },
  {
    data: {
      finishReason: "tool-calls",
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
      usage: { inputTokens: 330, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:07.167Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "step.completed",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 1, stepIndex: 1, turnId: "turn_1" },
    meta: { at: "2026-10-22T21:36:07.185Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 1, stepIndex: 1, turnId: "turn_1" },
    meta: { at: "2026-10-22T21:36:07.193Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: 'get_weather said: {"city":"Paris","forecast":"sunny","temperatureC":21}',
      sequence: 1,
      stepIndex: 1,
      turnId: "turn_1",
    },
    meta: { at: "2026-10-22T21:36:07.193Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 1,
      stepIndex: 1,
      turnId: "turn_1",
      usage: { inputTokens: 354, outputTokens: 18, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:07.194Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "step.completed",
  },
  {
    data: { sequence: 1, turnId: "turn_1" },
    meta: { at: "2026-10-22T21:36:07.199Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 1000, outputTokens: 34 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:07.199Z", deliveryIds: ["e1db1ef9-dcd0-48b9-a0d7-460795f4c8e4"] },
    type: "session.waiting",
  },
  {
    data: { sequence: 2, turnId: "turn_2" },
    meta: { at: "2026-10-22T21:36:07.461Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "turn.started",
  },
  {
    data: {
      message: "please run the gate",
      parts: [{ text: "please run the gate", type: "text" }],
      sequence: 2,
      turnId: "turn_2",
    },
    meta: { at: "2026-10-22T21:36:07.462Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 2, stepIndex: 0, turnId: "turn_2" },
    meta: { at: "2026-10-22T21:36:07.462Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "step.started",
  },
  {
    data: {
      actions: [
        {
          callId: "mock-tool-call-3-1-1",
          input: { marker: "M1" },
          kind: "tool-call",
          toolName: "gate",
        },
      ],
      sequence: 2,
      stepIndex: 0,
      turnId: "turn_2",
    },
    meta: { at: "2026-10-22T21:36:07.469Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "actions.requested",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 2, stepIndex: 0, turnId: "turn_2" },
    meta: { at: "2026-10-22T21:36:07.469Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "tool-calls",
      sequence: 2,
      stepIndex: 0,
      turnId: "turn_2",
      usage: { inputTokens: 381, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:07.470Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "step.completed",
  },
  {
    data: {
      requests: [
        {
          action: {
            callId: "mock-tool-call-3-1-1",
            input: { marker: "M1" },
            kind: "tool-call",
            toolName: "gate",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Approve" },
            { id: "cancel", label: "Cancel" },
          ],
          prompt: "Approve Gate?",
          requestId: "aitxt-3AWSk88AOGAwJJf09k9k53UD",
        },
      ],
      sequence: 2,
      stepIndex: 0,
      turnId: "turn_2",
    },
    meta: { at: "2026-10-22T21:36:07.473Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "input.requested",
  },
  {
    data: {
      on: "input",
      sequence: 2,
      turnId: "turn_2",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 1381, outputTokens: 38 },
    },
    meta: { at: "2026-10-22T21:36:07.474Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "turn.waiting",
  },
  {
    data: {
      outcome: "approved",
      requestId: "aitxt-3AWSk88AOGAwJJf09k9k53UD",
      responderPrincipalId: "alice",
      sequence: 2,
      stepIndex: 0,
      turnId: "turn_2",
    },
    meta: { at: "2026-10-22T21:36:07.786Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "approval.settled",
  },
  {
    data: {
      resolutions: [
        {
          kind: "tool-approval",
          outcome: "approved",
          requestId: "aitxt-3AWSk88AOGAwJJf09k9k53UD",
          response: { optionId: "approve", requestId: "aitxt-3AWSk88AOGAwJJf09k9k53UD" },
        },
      ],
      sequence: 2,
      stepIndex: 0,
      turnId: "turn_2",
    },
    meta: { at: "2026-10-22T21:36:07.786Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "input.resolved",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 2, stepIndex: 1, turnId: "turn_2" },
    meta: { at: "2026-10-22T21:36:07.787Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "step.started",
  },
  {
    data: {
      result: {
        callId: "mock-tool-call-3-1-1",
        kind: "tool-result",
        output: { executed: true, marker: "M1" },
        toolName: "gate",
      },
      sequence: 2,
      status: "completed",
      stepIndex: 1,
      turnId: "turn_2",
    },
    meta: { at: "2026-10-22T21:36:07.788Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "action.result",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 2, stepIndex: 1, turnId: "turn_2" },
    meta: { at: "2026-10-22T21:36:07.795Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: 'gate said: {"executed":true,"marker":"M1"}',
      sequence: 2,
      stepIndex: 1,
      turnId: "turn_2",
    },
    meta: { at: "2026-10-22T21:36:07.795Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 2,
      stepIndex: 1,
      turnId: "turn_2",
      usage: { inputTokens: 432, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:07.796Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "step.completed",
  },
  {
    data: { sequence: 2, turnId: "turn_2" },
    meta: { at: "2026-10-22T21:36:07.799Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 1813, outputTokens: 49 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:07.799Z", deliveryIds: ["01ae5dd5-5093-43d8-bed1-9f5a8280e379"] },
    type: "session.waiting",
  },
  {
    data: { sequence: 3, turnId: "turn_3" },
    meta: { at: "2026-10-22T21:36:08.108Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "turn.started",
  },
  {
    data: {
      message: "run the gate again",
      parts: [{ text: "run the gate again", type: "text" }],
      sequence: 3,
      turnId: "turn_3",
    },
    meta: { at: "2026-10-22T21:36:08.108Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 3, stepIndex: 0, turnId: "turn_3" },
    meta: { at: "2026-10-22T21:36:08.108Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "step.started",
  },
  {
    data: {
      actions: [
        {
          callId: "mock-tool-call-5-2-1",
          input: { marker: "M1" },
          kind: "tool-call",
          toolName: "gate",
        },
      ],
      sequence: 3,
      stepIndex: 0,
      turnId: "turn_3",
    },
    meta: { at: "2026-10-22T21:36:08.114Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "actions.requested",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 3, stepIndex: 0, turnId: "turn_3" },
    meta: { at: "2026-10-22T21:36:08.115Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "tool-calls",
      sequence: 3,
      stepIndex: 0,
      turnId: "turn_3",
      usage: { inputTokens: 452, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:08.115Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "step.completed",
  },
  {
    data: {
      requests: [
        {
          action: {
            callId: "mock-tool-call-5-2-1",
            input: { marker: "M1" },
            kind: "tool-call",
            toolName: "gate",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Approve" },
            { id: "cancel", label: "Cancel" },
          ],
          prompt: "Approve Gate?",
          requestId: "aitxt-63W6rvQYVV46U5gL4HLLfk6b",
        },
      ],
      sequence: 3,
      stepIndex: 0,
      turnId: "turn_3",
    },
    meta: { at: "2026-10-22T21:36:08.118Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "input.requested",
  },
  {
    data: {
      on: "input",
      sequence: 3,
      turnId: "turn_3",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 2265, outputTokens: 53 },
    },
    meta: { at: "2026-10-22T21:36:08.118Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "turn.waiting",
  },
  {
    data: {
      outcome: "cancelled",
      requestId: "aitxt-63W6rvQYVV46U5gL4HLLfk6b",
      responderPrincipalId: "alice",
      sequence: 3,
      stepIndex: 0,
      turnId: "turn_3",
    },
    meta: { at: "2026-10-22T21:36:08.430Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "approval.settled",
  },
  {
    data: {
      resolutions: [
        {
          kind: "tool-approval",
          outcome: "denied",
          requestId: "aitxt-63W6rvQYVV46U5gL4HLLfk6b",
          response: { optionId: "cancel", requestId: "aitxt-63W6rvQYVV46U5gL4HLLfk6b" },
        },
      ],
      sequence: 3,
      stepIndex: 0,
      turnId: "turn_3",
    },
    meta: { at: "2026-10-22T21:36:08.430Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "input.resolved",
  },
  {
    data: {
      error: { code: "TOOL_EXECUTION_DENIED", message: "Tool execution was denied." },
      result: {
        callId: "mock-tool-call-5-2-1",
        isError: true,
        kind: "tool-result",
        output: {
          approval: { requestId: "aitxt-63W6rvQYVV46U5gL4HLLfk6b", status: "denied" },
          code: "TOOL_EXECUTION_DENIED",
          message: "Tool execution was denied.",
          tool: { result: "not_run" },
        },
        toolName: "gate",
      },
      sequence: 3,
      status: "rejected",
      stepIndex: 0,
      turnId: "turn_3",
    },
    meta: { at: "2026-10-22T21:36:08.431Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "action.result",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 3, stepIndex: 1, turnId: "turn_3" },
    meta: { at: "2026-10-22T21:36:08.432Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 3, stepIndex: 1, turnId: "turn_3" },
    meta: { at: "2026-10-22T21:36:08.438Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: 'gate said: "Tool execution was denied."',
      sequence: 3,
      stepIndex: 1,
      turnId: "turn_3",
    },
    meta: { at: "2026-10-22T21:36:08.439Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 3,
      stepIndex: 1,
      turnId: "turn_3",
      usage: { inputTokens: 502, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:08.439Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "step.completed",
  },
  {
    data: { sequence: 3, turnId: "turn_3" },
    meta: { at: "2026-10-22T21:36:08.442Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 2767, outputTokens: 63 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:08.442Z", deliveryIds: ["5e530261-82be-4c54-9e1e-d7e58af2d613"] },
    type: "session.waiting",
  },
  {
    data: { sequence: 4, turnId: "turn_4" },
    meta: { at: "2026-10-22T21:36:08.760Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "turn.started",
  },
  {
    data: {
      message: "ask me a question",
      parts: [{ text: "ask me a question", type: "text" }],
      sequence: 4,
      turnId: "turn_4",
    },
    meta: { at: "2026-10-22T21:36:08.761Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 4, stepIndex: 0, turnId: "turn_4" },
    meta: { at: "2026-10-22T21:36:08.761Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "step.started",
  },
  {
    data: {
      actions: [
        {
          callId: "mock-tool-call-7-3-1",
          input: {
            question: "Which color?",
            options: [
              { label: "Red", description: "A warm color." },
              { label: "Blue", description: "A cool color." },
            ],
          },
          kind: "tool-call",
          toolName: "ask_question",
        },
      ],
      sequence: 4,
      stepIndex: 0,
      turnId: "turn_4",
    },
    meta: { at: "2026-10-22T21:36:08.768Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "actions.requested",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 4, stepIndex: 0, turnId: "turn_4" },
    meta: { at: "2026-10-22T21:36:08.768Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "tool-calls",
      sequence: 4,
      stepIndex: 0,
      turnId: "turn_4",
      usage: { inputTokens: 521, outputTokens: 33, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:08.769Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "step.completed",
  },
  {
    data: {
      on: "tasks",
      sequence: 4,
      turnId: "turn_4",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 3288, outputTokens: 96 },
    },
    meta: { at: "2026-10-22T21:36:08.771Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "turn.waiting",
  },
  {
    data: {
      requests: [
        {
          action: {
            callId: "mock-tool-call-7-3-1",
            input: {
              question: "Which color?",
              options: [
                { label: "Red", description: "A warm color." },
                { label: "Blue", description: "A cool color." },
              ],
            },
            kind: "tool-call",
            toolName: "ask_question",
          },
          kind: "question",
          prompt: "Which color?",
          requestId: "wrun_01M5JRNY2EWQ594SJCQNDFPF25-ask-1",
          allowFreeform: true,
          display: "select",
          options: [
            { description: "A warm color.", id: "Red", label: "Red" },
            { description: "A cool color.", id: "Blue", label: "Blue" },
          ],
        },
      ],
      sequence: 4,
      stepIndex: 0,
      turnId: "turn_4",
      callId: "mock-tool-call-7-3-1",
    },
    meta: { at: "2026-10-22T21:36:08.832Z" },
    type: "input.requested",
  },
  {
    data: {
      on: "input",
      sequence: 4,
      turnId: "turn_4",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 3288, outputTokens: 96 },
    },
    meta: { at: "2026-10-22T21:36:08.832Z" },
    type: "turn.waiting",
  },
  {
    data: {
      resolutions: [
        {
          kind: "question",
          outcome: "answered",
          requestId: "wrun_01M5JRNY2EWQ594SJCQNDFPF25-ask-1",
          response: { optionId: "Blue", requestId: "wrun_01M5JRNY2EWQ594SJCQNDFPF25-ask-1" },
        },
      ],
      sequence: 4,
      stepIndex: 0,
      turnId: "turn_4",
    },
    meta: { at: "2026-10-22T21:36:09.127Z" },
    type: "input.resolved",
  },
  {
    data: {
      result: {
        callId: "mock-tool-call-7-3-1",
        kind: "tool-result",
        output: { answer: "Blue", status: "answered" },
        toolName: "ask_question",
      },
      sequence: 4,
      status: "completed",
      stepIndex: 0,
      turnId: "turn_4",
    },
    meta: { at: "2026-10-22T21:36:09.165Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "action.result",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 4, stepIndex: 1, turnId: "turn_4" },
    meta: { at: "2026-10-22T21:36:09.166Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 4, stepIndex: 1, turnId: "turn_4" },
    meta: { at: "2026-10-22T21:36:09.172Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: 'ask_question said: {"answer":"Blue","status":"answered"}',
      sequence: 4,
      stepIndex: 1,
      turnId: "turn_4",
    },
    meta: { at: "2026-10-22T21:36:09.172Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 4,
      stepIndex: 1,
      turnId: "turn_4",
      usage: { inputTokens: 535, outputTokens: 14, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:09.173Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "step.completed",
  },
  {
    data: { sequence: 4, turnId: "turn_4" },
    meta: { at: "2026-10-22T21:36:09.177Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 3823, outputTokens: 110 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:09.177Z", deliveryIds: ["a0c6e954-277e-49bb-8eb6-35164a209c6e"] },
    type: "session.waiting",
  },
  {
    data: { sequence: 5, turnId: "turn_5" },
    meta: { at: "2026-10-22T21:36:09.493Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "turn.started",
  },
  {
    data: {
      message: "ask me a question again",
      parts: [{ text: "ask me a question again", type: "text" }],
      sequence: 5,
      turnId: "turn_5",
    },
    meta: { at: "2026-10-22T21:36:09.493Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 5, stepIndex: 0, turnId: "turn_5" },
    meta: { at: "2026-10-22T21:36:09.493Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "step.started",
  },
  {
    data: {
      actions: [
        {
          callId: "mock-tool-call-8-4-1",
          input: {
            question: "Which color?",
            options: [
              { label: "Red", description: "A warm color." },
              { label: "Blue", description: "A cool color." },
            ],
          },
          kind: "tool-call",
          toolName: "ask_question",
        },
      ],
      sequence: 5,
      stepIndex: 0,
      turnId: "turn_5",
    },
    meta: { at: "2026-10-22T21:36:09.499Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "actions.requested",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 5, stepIndex: 0, turnId: "turn_5" },
    meta: { at: "2026-10-22T21:36:09.500Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "tool-calls",
      sequence: 5,
      stepIndex: 0,
      turnId: "turn_5",
      usage: { inputTokens: 559, outputTokens: 33, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:09.500Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "step.completed",
  },
  {
    data: {
      on: "tasks",
      sequence: 5,
      turnId: "turn_5",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 4382, outputTokens: 143 },
    },
    meta: { at: "2026-10-22T21:36:09.502Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "turn.waiting",
  },
  {
    data: {
      requests: [
        {
          action: {
            callId: "mock-tool-call-8-4-1",
            input: {
              question: "Which color?",
              options: [
                { label: "Red", description: "A warm color." },
                { label: "Blue", description: "A cool color." },
              ],
            },
            kind: "tool-call",
            toolName: "ask_question",
          },
          kind: "question",
          prompt: "Which color?",
          requestId: "wrun_01M5JRNYS7ABGM16P294JDT4E0-ask-1",
          allowFreeform: true,
          display: "select",
          options: [
            { description: "A warm color.", id: "Red", label: "Red" },
            { description: "A cool color.", id: "Blue", label: "Blue" },
          ],
        },
      ],
      sequence: 5,
      stepIndex: 0,
      turnId: "turn_5",
      callId: "mock-tool-call-8-4-1",
    },
    meta: { at: "2026-10-22T21:36:09.559Z" },
    type: "input.requested",
  },
  {
    data: {
      on: "input",
      sequence: 5,
      turnId: "turn_5",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 4382, outputTokens: 143 },
    },
    meta: { at: "2026-10-22T21:36:09.559Z" },
    type: "turn.waiting",
  },
  {
    data: {
      resolutions: [
        {
          kind: "question",
          outcome: "answered",
          requestId: "wrun_01M5JRNYS7ABGM16P294JDT4E0-ask-1",
          response: { requestId: "wrun_01M5JRNYS7ABGM16P294JDT4E0-ask-1", text: "Green, actually" },
        },
      ],
      sequence: 5,
      stepIndex: 0,
      turnId: "turn_5",
    },
    meta: { at: "2026-10-22T21:36:09.868Z" },
    type: "input.resolved",
  },
  {
    data: {
      result: {
        callId: "mock-tool-call-8-4-1",
        kind: "tool-result",
        output: { answer: "Green, actually", status: "answered" },
        toolName: "ask_question",
      },
      sequence: 5,
      status: "completed",
      stepIndex: 0,
      turnId: "turn_5",
    },
    meta: { at: "2026-10-22T21:36:09.907Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "action.result",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 5, stepIndex: 1, turnId: "turn_5" },
    meta: { at: "2026-10-22T21:36:09.908Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 5, stepIndex: 1, turnId: "turn_5" },
    meta: { at: "2026-10-22T21:36:09.914Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: 'ask_question said: {"answer":"Green, actually","status":"answered"}',
      sequence: 5,
      stepIndex: 1,
      turnId: "turn_5",
    },
    meta: { at: "2026-10-22T21:36:09.915Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 5,
      stepIndex: 1,
      turnId: "turn_5",
      usage: { inputTokens: 576, outputTokens: 17, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:09.915Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "step.completed",
  },
  {
    data: { sequence: 5, turnId: "turn_5" },
    meta: { at: "2026-10-22T21:36:09.922Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 4958, outputTokens: 160 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:09.922Z", deliveryIds: ["4bc198cc-31e7-4f06-ab1c-ecefc3b7d999"] },
    type: "session.waiting",
  },
  {
    data: { sequence: 6, turnId: "turn_6" },
    meta: { at: "2026-10-22T21:36:10.243Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "turn.started",
  },
  {
    data: {
      message: "delegate to the helper",
      parts: [{ text: "delegate to the helper", type: "text" }],
      sequence: 6,
      turnId: "turn_6",
    },
    meta: { at: "2026-10-22T21:36:10.243Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 6, stepIndex: 0, turnId: "turn_6" },
    meta: { at: "2026-10-22T21:36:10.243Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "step.started",
  },
  {
    data: {
      actions: [
        {
          callId: "mock-tool-call-9-5-1",
          description: "A helper subagent. Call it to delegate. ",
          input: { message: "Say the marker" },
          name: "helper",
          nodeId: "subagents/helper",
          kind: "subagent-call",
          subagentName: "helper",
        },
      ],
      presentation: { "mock-tool-call-9-5-1": { label: "Helper: Say the marker" } },
      sequence: 6,
      stepIndex: 0,
      turnId: "turn_6",
    },
    meta: { at: "2026-10-22T21:36:10.249Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "actions.requested",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 6, stepIndex: 0, turnId: "turn_6" },
    meta: { at: "2026-10-22T21:36:10.250Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "tool-calls",
      sequence: 6,
      stepIndex: 0,
      turnId: "turn_6",
      usage: { inputTokens: 603, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:10.250Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "step.completed",
  },
  {
    data: {
      callId: "mock-tool-call-9-5-1",
      kind: "agent",
      name: "helper",
      taskId: "helper-1sd8t5",
      turnId: "turn_6",
    },
    meta: { at: "2026-10-22T21:36:10.283Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "task.started",
  },
  {
    data: {
      result: {
        callId: "mock-tool-call-9-5-1",
        kind: "tool-result",
        output: "Task helper-1sd8t5 is running.",
        toolName: "helper",
      },
      sequence: 6,
      status: "completed",
      stepIndex: 0,
      turnId: "turn_6",
    },
    meta: { at: "2026-10-22T21:36:10.297Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "action.result",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 6, stepIndex: 1, turnId: "turn_6" },
    meta: { at: "2026-10-22T21:36:10.298Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 6, stepIndex: 1, turnId: "turn_6" },
    meta: { at: "2026-10-22T21:36:10.304Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: "Started the helper.",
      sequence: 6,
      stepIndex: 1,
      turnId: "turn_6",
    },
    meta: { at: "2026-10-22T21:36:10.304Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 6,
      stepIndex: 1,
      turnId: "turn_6",
      usage: { inputTokens: 666, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:10.304Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "step.completed",
  },
  {
    data: {
      on: "tasks",
      sequence: 6,
      turnId: "turn_6",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 6227, outputTokens: 172 },
    },
    meta: { at: "2026-10-22T21:36:10.308Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "turn.waiting",
  },
  {
    data: {
      callId: "mock-tool-call-9-5-1",
      turnId: "turn_6",
      name: "helper",
      sessionId: "wrun_01M5JRNZJ9VF5XQGNKC91ETXB5",
      streamPath: "/eve/v1/session/wrun_01M5JRNZJ9VF5XQGNKC91ETXB5/stream",
      taskId: "helper-1sd8t5",
    },
    meta: { at: "2026-10-22T21:36:10.417Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "agent.started",
  },
  {
    data: {
      callId: "mock-tool-call-9-5-1",
      kind: "agent",
      name: "helper",
      status: "completed",
      taskId: "helper-1sd8t5",
      turnId: "turn_6",
      output: "HELPER-MARKER-42",
    },
    meta: { at: "2026-10-22T21:36:10.463Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "task.settled",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 6, stepIndex: 2, turnId: "turn_6" },
    meta: { at: "2026-10-22T21:36:10.471Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 6, stepIndex: 2, turnId: "turn_6" },
    meta: { at: "2026-10-22T21:36:10.477Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: "The helper said HELPER-MARKER-42.",
      sequence: 6,
      stepIndex: 2,
      turnId: "turn_6",
    },
    meta: { at: "2026-10-22T21:36:10.477Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 6,
      stepIndex: 2,
      turnId: "turn_6",
      usage: { inputTokens: 720, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:10.478Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "step.completed",
  },
  {
    data: { sequence: 6, turnId: "turn_6" },
    meta: { at: "2026-10-22T21:36:10.483Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 7053, outputTokens: 185 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:10.483Z", deliveryIds: ["d75cc68d-0aa3-4c24-aed2-5899f64d2e2f"] },
    type: "session.waiting",
  },
  {
    data: { sequence: 7, turnId: "turn_7" },
    meta: { at: "2026-10-22T21:36:10.728Z", deliveryIds: ["90e06b8f-1ec6-4301-aa26-df19271bb9ee"] },
    type: "turn.started",
  },
  {
    data: {
      message: "explode please",
      parts: [{ text: "explode please", type: "text" }],
      sequence: 7,
      turnId: "turn_7",
    },
    meta: { at: "2026-10-22T21:36:10.728Z", deliveryIds: ["90e06b8f-1ec6-4301-aa26-df19271bb9ee"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 7, stepIndex: 0, turnId: "turn_7" },
    meta: { at: "2026-10-22T21:36:10.729Z", deliveryIds: ["90e06b8f-1ec6-4301-aa26-df19271bb9ee"] },
    type: "step.started",
  },
  {
    data: {
      actions: [
        { callId: "mock-tool-call-13-6-1", input: {}, kind: "tool-call", toolName: "explode" },
      ],
      sequence: 7,
      stepIndex: 0,
      turnId: "turn_7",
    },
    meta: { at: "2026-10-22T21:36:10.740Z", deliveryIds: ["90e06b8f-1ec6-4301-aa26-df19271bb9ee"] },
    type: "actions.requested",
  },
  {
    data: {
      error: { code: "ACTION_RESULT_FAILED", message: "Kaboom", name: "Error" },
      result: {
        callId: "mock-tool-call-13-6-1",
        kind: "tool-result",
        output: "Kaboom",
        toolName: "explode",
        errorName: "Error",
        isError: true,
      },
      sequence: 7,
      status: "failed",
      stepIndex: 0,
      turnId: "turn_7",
    },
    meta: { at: "2026-10-22T21:36:10.741Z", deliveryIds: ["90e06b8f-1ec6-4301-aa26-df19271bb9ee"] },
    type: "action.result",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 7, stepIndex: 0, turnId: "turn_7" },
    meta: { at: "2026-10-22T21:36:10.742Z", deliveryIds: ["90e06b8f-1ec6-4301-aa26-df19271bb9ee"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "tool-calls",
      sequence: 7,
      stepIndex: 0,
      turnId: "turn_7",
      usage: { inputTokens: 736, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:10.742Z", deliveryIds: ["90e06b8f-1ec6-4301-aa26-df19271bb9ee"] },
    type: "step.completed",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 7, stepIndex: 1, turnId: "turn_7" },
    meta: { at: "2026-10-22T21:36:10.753Z", deliveryIds: ["90e06b8f-1ec6-4301-aa26-df19271bb9ee"] },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 7, stepIndex: 1, turnId: "turn_7" },
    meta: { at: "2026-10-22T21:36:10.759Z", deliveryIds: ["90e06b8f-1ec6-4301-aa26-df19271bb9ee"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: 'explode said: "Error: Kaboom"',
      sequence: 7,
      stepIndex: 1,
      turnId: "turn_7",
    },
    meta: { at: "2026-10-22T21:36:10.760Z", deliveryIds: ["90e06b8f-1ec6-4301-aa26-df19271bb9ee"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 7,
      stepIndex: 1,
      turnId: "turn_7",
      usage: { inputTokens: 744, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:10.760Z", deliveryIds: ["90e06b8f-1ec6-4301-aa26-df19271bb9ee"] },
    type: "step.completed",
  },
  {
    data: { sequence: 7, turnId: "turn_7" },
    meta: { at: "2026-10-22T21:36:10.766Z", deliveryIds: ["90e06b8f-1ec6-4301-aa26-df19271bb9ee"] },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 8533, outputTokens: 194 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:10.766Z", deliveryIds: ["90e06b8f-1ec6-4301-aa26-df19271bb9ee"] },
    type: "session.waiting",
  },
  {
    data: { sequence: 8, turnId: "turn_8" },
    meta: { at: "2026-10-22T21:36:11.111Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "turn.started",
  },
  {
    data: {
      message: "do both things",
      parts: [{ text: "do both things", type: "text" }],
      sequence: 8,
      turnId: "turn_8",
    },
    meta: { at: "2026-10-22T21:36:11.112Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 8, stepIndex: 0, turnId: "turn_8" },
    meta: { at: "2026-10-22T21:36:11.112Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "step.started",
  },
  {
    data: {
      actions: [
        {
          callId: "mock-tool-call-14-7-1",
          input: { city: "Oslo" },
          kind: "tool-call",
          toolName: "get_weather",
        },
      ],
      sequence: 8,
      stepIndex: 0,
      turnId: "turn_8",
    },
    meta: { at: "2026-10-22T21:36:11.119Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "actions.requested",
  },
  {
    data: {
      actions: [
        {
          callId: "mock-tool-call-14-7-2",
          input: { marker: "M2" },
          kind: "tool-call",
          toolName: "gate",
        },
      ],
      sequence: 8,
      stepIndex: 0,
      turnId: "turn_8",
    },
    meta: { at: "2026-10-22T21:36:11.120Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "actions.requested",
  },
  {
    data: {
      result: {
        callId: "mock-tool-call-14-7-1",
        kind: "tool-result",
        output: { city: "Oslo", forecast: "sunny", temperatureC: 21 },
        toolName: "get_weather",
      },
      sequence: 8,
      status: "completed",
      stepIndex: 0,
      turnId: "turn_8",
    },
    meta: { at: "2026-10-22T21:36:11.120Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "action.result",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 8, stepIndex: 0, turnId: "turn_8" },
    meta: { at: "2026-10-22T21:36:11.121Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "tool-calls",
      sequence: 8,
      stepIndex: 0,
      turnId: "turn_8",
      usage: { inputTokens: 760, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:11.121Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "step.completed",
  },
  {
    data: {
      requests: [
        {
          action: {
            callId: "mock-tool-call-14-7-2",
            input: { marker: "M2" },
            kind: "tool-call",
            toolName: "gate",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Approve" },
            { id: "cancel", label: "Cancel" },
          ],
          prompt: "Approve Gate?",
          requestId: "aitxt-v1a9uJxRmDRH1gS6CNmgQr3j",
        },
      ],
      sequence: 8,
      stepIndex: 0,
      turnId: "turn_8",
    },
    meta: { at: "2026-10-22T21:36:11.128Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "input.requested",
  },
  {
    data: {
      on: "input",
      sequence: 8,
      turnId: "turn_8",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 9293, outputTokens: 202 },
    },
    meta: { at: "2026-10-22T21:36:11.128Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "turn.waiting",
  },
  {
    data: {
      outcome: "approved",
      requestId: "aitxt-v1a9uJxRmDRH1gS6CNmgQr3j",
      responderPrincipalId: "alice",
      sequence: 8,
      stepIndex: 0,
      turnId: "turn_8",
    },
    meta: { at: "2026-10-22T21:36:11.481Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "approval.settled",
  },
  {
    data: {
      resolutions: [
        {
          kind: "tool-approval",
          outcome: "approved",
          requestId: "aitxt-v1a9uJxRmDRH1gS6CNmgQr3j",
          response: { optionId: "approve", requestId: "aitxt-v1a9uJxRmDRH1gS6CNmgQr3j" },
        },
      ],
      sequence: 8,
      stepIndex: 0,
      turnId: "turn_8",
    },
    meta: { at: "2026-10-22T21:36:11.482Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "input.resolved",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 8, stepIndex: 1, turnId: "turn_8" },
    meta: { at: "2026-10-22T21:36:11.482Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "step.started",
  },
  {
    data: {
      result: {
        callId: "mock-tool-call-14-7-2",
        kind: "tool-result",
        output: { executed: true, marker: "M2" },
        toolName: "gate",
      },
      sequence: 8,
      status: "completed",
      stepIndex: 1,
      turnId: "turn_8",
    },
    meta: { at: "2026-10-22T21:36:11.482Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "action.result",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 8, stepIndex: 1, turnId: "turn_8" },
    meta: { at: "2026-10-22T21:36:11.489Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: "Both done.",
      sequence: 8,
      stepIndex: 1,
      turnId: "turn_8",
    },
    meta: { at: "2026-10-22T21:36:11.489Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 8,
      stepIndex: 1,
      turnId: "turn_8",
      usage: { inputTokens: 824, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:11.489Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "step.completed",
  },
  {
    data: { sequence: 8, turnId: "turn_8" },
    meta: { at: "2026-10-22T21:36:11.492Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10117, outputTokens: 205 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:11.492Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "session.waiting",
  },
  {
    data: { sequence: 9, sessionId: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ", turnId: "turn_9" },
    meta: { at: "2026-10-22T21:36:11.874Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "context.cleared",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10117, outputTokens: 205 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:11.875Z", deliveryIds: ["23afc349-ba19-4510-83d7-fba157238868"] },
    type: "session.waiting",
  },
  {
    data: { sequence: 9, turnId: "turn_9" },
    meta: { at: "2026-10-22T21:36:12.247Z", deliveryIds: ["411ce700-d20f-4f4c-a09b-4a1c35d5e4d5"] },
    type: "turn.started",
  },
  {
    data: {
      message: "hello after clear",
      parts: [{ text: "hello after clear", type: "text" }],
      sequence: 9,
      turnId: "turn_9",
    },
    meta: { at: "2026-10-22T21:36:12.247Z", deliveryIds: ["411ce700-d20f-4f4c-a09b-4a1c35d5e4d5"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 9, stepIndex: 0, turnId: "turn_9" },
    meta: { at: "2026-10-22T21:36:12.247Z", deliveryIds: ["411ce700-d20f-4f4c-a09b-4a1c35d5e4d5"] },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 9, stepIndex: 0, turnId: "turn_9" },
    meta: { at: "2026-10-22T21:36:12.251Z", deliveryIds: ["411ce700-d20f-4f4c-a09b-4a1c35d5e4d5"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: "Echo: hello after clear",
      sequence: 9,
      stepIndex: 0,
      turnId: "turn_9",
    },
    meta: { at: "2026-10-22T21:36:12.252Z", deliveryIds: ["411ce700-d20f-4f4c-a09b-4a1c35d5e4d5"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 9,
      stepIndex: 0,
      turnId: "turn_9",
      usage: { inputTokens: 338, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:12.252Z", deliveryIds: ["411ce700-d20f-4f4c-a09b-4a1c35d5e4d5"] },
    type: "step.completed",
  },
  {
    data: { sequence: 9, turnId: "turn_9" },
    meta: { at: "2026-10-22T21:36:12.255Z", deliveryIds: ["411ce700-d20f-4f4c-a09b-4a1c35d5e4d5"] },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10455, outputTokens: 211 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:12.255Z", deliveryIds: ["411ce700-d20f-4f4c-a09b-4a1c35d5e4d5"] },
    type: "session.waiting",
  },
  {
    data: { sequence: 10, turnId: "turn_10" },
    meta: { at: "2026-10-22T21:36:12.329Z", deliveryIds: ["5cf3a163-8521-4490-902b-97dac4f48f01"] },
    type: "turn.started",
  },
  {
    data: {
      messages: [
        { role: "user", text: "Earlier question from another system", id: "h1" },
        { role: "assistant", text: "Earlier answer from another system", id: "h2" },
      ],
      sequence: 10,
      turnId: "turn_10",
    },
    meta: { at: "2026-10-22T21:36:12.329Z", deliveryIds: ["5cf3a163-8521-4490-902b-97dac4f48f01"] },
    type: "history.imported",
  },
  {
    data: {
      message: "IMPORT this and say hi",
      parts: [{ text: "IMPORT this and say hi", type: "text" }],
      sequence: 10,
      turnId: "turn_10",
    },
    meta: { at: "2026-10-22T21:36:12.329Z", deliveryIds: ["5cf3a163-8521-4490-902b-97dac4f48f01"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 10, stepIndex: 0, turnId: "turn_10" },
    meta: { at: "2026-10-22T21:36:12.329Z", deliveryIds: ["5cf3a163-8521-4490-902b-97dac4f48f01"] },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 10, stepIndex: 0, turnId: "turn_10" },
    meta: { at: "2026-10-22T21:36:12.333Z", deliveryIds: ["5cf3a163-8521-4490-902b-97dac4f48f01"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: "Echo: IMPORT this and say hi",
      sequence: 10,
      stepIndex: 0,
      turnId: "turn_10",
    },
    meta: { at: "2026-10-22T21:36:12.333Z", deliveryIds: ["5cf3a163-8521-4490-902b-97dac4f48f01"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 10,
      stepIndex: 0,
      turnId: "turn_10",
      usage: { inputTokens: 372, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:12.333Z", deliveryIds: ["5cf3a163-8521-4490-902b-97dac4f48f01"] },
    type: "step.completed",
  },
  {
    data: { sequence: 10, turnId: "turn_10" },
    meta: { at: "2026-10-22T21:36:12.336Z", deliveryIds: ["5cf3a163-8521-4490-902b-97dac4f48f01"] },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10827, outputTokens: 218 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:12.336Z", deliveryIds: ["5cf3a163-8521-4490-902b-97dac4f48f01"] },
    type: "session.waiting",
  },
  {
    data: {
      modelId: "eve-mock/spike-mock",
      sequence: 11,
      sessionId: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      stepIndex: 0,
      turnId: "turn_11",
      usageInputTokens: 406,
    },
    meta: { at: "2026-10-22T21:36:12.400Z", deliveryIds: ["5cf3a163-8521-4490-902b-97dac4f48f01"] },
    type: "compaction.requested",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 11278, outputTokens: 251 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:12.405Z", deliveryIds: ["5cf3a163-8521-4490-902b-97dac4f48f01"] },
    type: "session.waiting",
  },
  {
    data: { sequence: 11, turnId: "turn_11" },
    meta: { at: "2026-10-22T21:36:14.422Z", deliveryIds: ["28ccf371-08b8-4484-bf8a-ed5f0549189a"] },
    type: "turn.started",
  },
  {
    data: {
      message: "hello after compact",
      parts: [{ text: "hello after compact", type: "text" }],
      sequence: 11,
      turnId: "turn_11",
    },
    meta: { at: "2026-10-22T21:36:14.422Z", deliveryIds: ["28ccf371-08b8-4484-bf8a-ed5f0549189a"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 11, stepIndex: 0, turnId: "turn_11" },
    meta: { at: "2026-10-22T21:36:14.422Z", deliveryIds: ["28ccf371-08b8-4484-bf8a-ed5f0549189a"] },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 11, stepIndex: 0, turnId: "turn_11" },
    meta: { at: "2026-10-22T21:36:14.427Z", deliveryIds: ["28ccf371-08b8-4484-bf8a-ed5f0549189a"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: "Echo: hello after compact",
      sequence: 11,
      stepIndex: 0,
      turnId: "turn_11",
    },
    meta: { at: "2026-10-22T21:36:14.427Z", deliveryIds: ["28ccf371-08b8-4484-bf8a-ed5f0549189a"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 11,
      stepIndex: 0,
      turnId: "turn_11",
      usage: { inputTokens: 388, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:14.428Z", deliveryIds: ["28ccf371-08b8-4484-bf8a-ed5f0549189a"] },
    type: "step.completed",
  },
  {
    data: { sequence: 11, turnId: "turn_11" },
    meta: { at: "2026-10-22T21:36:14.431Z", deliveryIds: ["28ccf371-08b8-4484-bf8a-ed5f0549189a"] },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRNW3JXDKMN1BP7T89PTCQ",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 11666, outputTokens: 258 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:14.431Z", deliveryIds: ["28ccf371-08b8-4484-bf8a-ed5f0549189a"] },
    type: "session.waiting",
  },
];

export const STEER_AND_CANCEL: readonly unknown[] = [
  {
    data: { runtime: { agentId: "v26-spike", agentName: "v26-spike", eveVersion: "0.82.0" } },
    meta: { at: "2026-10-22T21:36:14.563Z", deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3"] },
    type: "session.started",
  },
  {
    data: { sequence: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:14.563Z", deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3"] },
    type: "turn.started",
  },
  {
    data: {
      message: "slow please",
      parts: [{ text: "slow please", type: "text" }],
      sequence: 0,
      turnId: "turn_0",
    },
    meta: { at: "2026-10-22T21:36:14.564Z", deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 0, stepIndex: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:14.564Z", deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3"] },
    type: "step.started",
  },
  {
    data: {
      actions: [
        {
          callId: "mock-tool-call-1-0-1",
          input: { ms: 6000 },
          kind: "tool-call",
          toolName: "slow",
        },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    },
    meta: { at: "2026-10-22T21:36:14.568Z", deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3"] },
    type: "actions.requested",
  },
  {
    data: {
      result: {
        callId: "mock-tool-call-1-0-1",
        kind: "tool-result",
        output: { slept: 6000 },
        toolName: "slow",
      },
      sequence: 0,
      status: "completed",
      stepIndex: 0,
      turnId: "turn_0",
    },
    meta: { at: "2026-10-22T21:36:20.568Z", deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3"] },
    type: "action.result",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 0, stepIndex: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:20.569Z", deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "tool-calls",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
      usage: { inputTokens: 316, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:20.569Z", deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3"] },
    type: "step.completed",
  },
  {
    data: {
      message: "actually, also this steering note",
      parts: [{ text: "actually, also this steering note", type: "text" }],
      sequence: 0,
      turnId: "turn_0",
    },
    meta: {
      at: "2026-10-22T21:36:20.583Z",
      deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3", "3a25f2be-a49b-4a20-8a6a-318bf8138071"],
    },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 0, stepIndex: 1, turnId: "turn_0" },
    meta: {
      at: "2026-10-22T21:36:20.583Z",
      deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3", "3a25f2be-a49b-4a20-8a6a-318bf8138071"],
    },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 0, stepIndex: 1, turnId: "turn_0" },
    meta: {
      at: "2026-10-22T21:36:20.586Z",
      deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3", "3a25f2be-a49b-4a20-8a6a-318bf8138071"],
    },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message: "Echo: actually, also this steering note",
      sequence: 0,
      stepIndex: 1,
      turnId: "turn_0",
    },
    meta: {
      at: "2026-10-22T21:36:20.587Z",
      deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3", "3a25f2be-a49b-4a20-8a6a-318bf8138071"],
    },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 0,
      stepIndex: 1,
      turnId: "turn_0",
      usage: { inputTokens: 333, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: {
      at: "2026-10-22T21:36:20.587Z",
      deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3", "3a25f2be-a49b-4a20-8a6a-318bf8138071"],
    },
    type: "step.completed",
  },
  {
    data: { sequence: 0, turnId: "turn_0" },
    meta: {
      at: "2026-10-22T21:36:20.589Z",
      deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3", "3a25f2be-a49b-4a20-8a6a-318bf8138071"],
    },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRP3PB99CA7JDRX1AH8GJP",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 649, outputTokens: 13 },
      wait: "next-user-message",
    },
    meta: {
      at: "2026-10-22T21:36:20.589Z",
      deliveryIds: ["83636cf2-6b24-4186-8ed4-f14df9d2b6a3", "3a25f2be-a49b-4a20-8a6a-318bf8138071"],
    },
    type: "session.waiting",
  },
  {
    data: { sequence: 1, turnId: "turn_1" },
    meta: { at: "2026-10-22T21:36:20.741Z", deliveryIds: ["90467626-6065-463b-a396-4d6a380abe85"] },
    type: "turn.started",
  },
  {
    data: {
      message: "slow please again",
      parts: [{ text: "slow please again", type: "text" }],
      sequence: 1,
      turnId: "turn_1",
    },
    meta: { at: "2026-10-22T21:36:20.741Z", deliveryIds: ["90467626-6065-463b-a396-4d6a380abe85"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 1, stepIndex: 0, turnId: "turn_1" },
    meta: { at: "2026-10-22T21:36:20.741Z", deliveryIds: ["90467626-6065-463b-a396-4d6a380abe85"] },
    type: "step.started",
  },
  {
    data: {
      actions: [
        {
          callId: "mock-tool-call-3-1-1",
          input: { ms: 6000 },
          kind: "tool-call",
          toolName: "slow",
        },
      ],
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
    },
    meta: { at: "2026-10-22T21:36:20.746Z", deliveryIds: ["90467626-6065-463b-a396-4d6a380abe85"] },
    type: "actions.requested",
  },
  {
    data: { sequence: 1, turnId: "turn_1" },
    meta: { at: "2026-10-22T21:36:21.050Z", deliveryIds: ["90467626-6065-463b-a396-4d6a380abe85"] },
    type: "turn.cancelled",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRP3PB99CA7JDRX1AH8GJP",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 649, outputTokens: 13 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:21.051Z", deliveryIds: ["90467626-6065-463b-a396-4d6a380abe85"] },
    type: "session.waiting",
  },
];

export const PENDING_APPROVAL: readonly unknown[] = [
  {
    data: { runtime: { agentId: "v26-spike", agentName: "v26-spike", eveVersion: "0.82.0" } },
    meta: { at: "2026-10-22T21:36:21.356Z", deliveryIds: ["8be1dfa2-67cc-4f07-a435-09f5d9ae6402"] },
    type: "session.started",
  },
  {
    data: { sequence: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:21.356Z", deliveryIds: ["8be1dfa2-67cc-4f07-a435-09f5d9ae6402"] },
    type: "turn.started",
  },
  {
    data: {
      message: "please run the gate",
      parts: [{ text: "please run the gate", type: "text" }],
      sequence: 0,
      turnId: "turn_0",
    },
    meta: { at: "2026-10-22T21:36:21.356Z", deliveryIds: ["8be1dfa2-67cc-4f07-a435-09f5d9ae6402"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 0, stepIndex: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:21.356Z", deliveryIds: ["8be1dfa2-67cc-4f07-a435-09f5d9ae6402"] },
    type: "step.started",
  },
  {
    data: {
      actions: [
        {
          callId: "mock-tool-call-1-0-1",
          input: { marker: "M1" },
          kind: "tool-call",
          toolName: "gate",
        },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    },
    meta: { at: "2026-10-22T21:36:21.359Z", deliveryIds: ["8be1dfa2-67cc-4f07-a435-09f5d9ae6402"] },
    type: "actions.requested",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 0, stepIndex: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:21.360Z", deliveryIds: ["8be1dfa2-67cc-4f07-a435-09f5d9ae6402"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "tool-calls",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
      usage: { inputTokens: 318, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:21.360Z", deliveryIds: ["8be1dfa2-67cc-4f07-a435-09f5d9ae6402"] },
    type: "step.completed",
  },
  {
    data: {
      requests: [
        {
          action: {
            callId: "mock-tool-call-1-0-1",
            input: { marker: "M1" },
            kind: "tool-call",
            toolName: "gate",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Approve" },
            { id: "cancel", label: "Cancel" },
          ],
          prompt: "Approve Gate?",
          requestId: "aitxt-DHJ6EZuW9iJ3mxtxH3OaSi8l",
        },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    },
    meta: { at: "2026-10-22T21:36:21.368Z", deliveryIds: ["8be1dfa2-67cc-4f07-a435-09f5d9ae6402"] },
    type: "input.requested",
  },
  {
    data: {
      on: "input",
      sequence: 0,
      turnId: "turn_0",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 318, outputTokens: 4 },
    },
    meta: { at: "2026-10-22T21:36:21.368Z", deliveryIds: ["8be1dfa2-67cc-4f07-a435-09f5d9ae6402"] },
    type: "turn.waiting",
  },
];

export const ATTACHMENT: readonly unknown[] = [
  {
    data: { runtime: { agentId: "v26-spike", agentName: "v26-spike", eveVersion: "0.82.0" } },
    meta: { at: "2026-10-22T21:36:21.957Z", deliveryIds: ["056319ad-ea04-4094-9b5f-91ec260fc40e"] },
    type: "session.started",
  },
  {
    data: { sequence: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:21.958Z", deliveryIds: ["056319ad-ea04-4094-9b5f-91ec260fc40e"] },
    type: "turn.started",
  },
  {
    data: {
      message: "here is a file\n[file: note.txt (text/plain)]",
      parts: [
        { text: "here is a file", type: "text" },
        { mediaType: "text/plain", type: "file", filename: "note.txt", size: 5 },
      ],
      sequence: 0,
      turnId: "turn_0",
    },
    meta: { at: "2026-10-22T21:36:21.958Z", deliveryIds: ["056319ad-ea04-4094-9b5f-91ec260fc40e"] },
    type: "message.received",
  },
  {
    data: { modelId: "eve-mock/spike-mock", sequence: 0, stepIndex: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:21.959Z", deliveryIds: ["056319ad-ea04-4094-9b5f-91ec260fc40e"] },
    type: "step.started",
  },
  {
    data: { reasoning: "Thinking it over.", sequence: 0, stepIndex: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:21.963Z", deliveryIds: ["056319ad-ea04-4094-9b5f-91ec260fc40e"] },
    type: "reasoning.completed",
  },
  {
    data: {
      finishReason: "stop",
      message:
        "Echo: here is a fileAttached file /workspace/.eve/attachments/2cf24dba5fb0a30e/note.txt (text/plain)",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    },
    meta: { at: "2026-10-22T21:36:21.963Z", deliveryIds: ["056319ad-ea04-4094-9b5f-91ec260fc40e"] },
    type: "message.completed",
  },
  {
    data: {
      finishReason: "stop",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
      usage: { inputTokens: 337, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    meta: { at: "2026-10-22T21:36:21.964Z", deliveryIds: ["056319ad-ea04-4094-9b5f-91ec260fc40e"] },
    type: "step.completed",
  },
  {
    data: { sequence: 0, turnId: "turn_0" },
    meta: { at: "2026-10-22T21:36:21.966Z", deliveryIds: ["056319ad-ea04-4094-9b5f-91ec260fc40e"] },
    type: "turn.completed",
  },
  {
    data: {
      continuationToken: "wrun_01M5JRPAK84YV23T2V7SHG8EJ5",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 337, outputTokens: 25 },
      wait: "next-user-message",
    },
    meta: { at: "2026-10-22T21:36:21.967Z", deliveryIds: ["056319ad-ea04-4094-9b5f-91ec260fc40e"] },
    type: "session.waiting",
  },
];
