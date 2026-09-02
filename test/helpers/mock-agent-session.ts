import type { StopReason } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

// ─── Config & Controls ────────────────────────────────────────────────────────

export interface MockSessionConfig {
  totalTurns?: number;
  finalText?: string; // default "ok"
  perTurnUsage?: { input: number; output: number }; // default { input: 10, output: 5 }
  toolCalls?: Array<{ toolName: string; args: Record<string, unknown> } | undefined>;
  failOnPrompt?: string;
}

export interface MockSessionControls {
  steerCalls: string[];
  aborted: boolean;
  promptStarted: boolean;
  promptResolved: boolean;
  promptRejected: boolean;
  emitTurn(opts?: {
    usage?: { input: number; output: number };
    finalText?: string;
    toolCall?: { toolName: string; args: Record<string, unknown> };
  }): Promise<void>;
  /** Resolve the manual-control prompt with a final assistant message. Defaults to stopReason "stop". */
  finish(finalText?: string, opts?: { stopReason?: StopReason; errorMessage?: string }): void;
  fail(message: string): void;
  /** Emit auto_retry_end with success=false then resolve the promise (provider failure path). */
  failWithProviderEvent(message: string): void;
}

// ─── Minimal mock surface ─────────────────────────────────────────────────────

interface MockSessionSurface {
  bindExtensions(bindings: { shutdownHandler?: unknown }): Promise<void>;
  subscribe(cb: (event: AgentSessionEvent) => void): () => void;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  prompt(task: string): Promise<void>;
  state: { errorMessage?: string };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createMockSession(config: MockSessionConfig = {}): {
  session: AgentSession;
  controls: MockSessionControls;
} {
  const listeners: Array<(event: AgentSessionEvent) => void> = [];

  // Stub AssistantMessage builder. src/session.ts only reads role, usage.{input,output},
  // and content[].{type,text}; the remaining fields exist solely to satisfy the SDK type
  // so a future shape change in @earendil-works/pi-ai/pi-coding-agent fails this build.
  const makeAssistantMessage = (
    text: string,
    usage: { input: number; output: number },
    opts?: { stopReason?: StopReason; errorMessage?: string },
  ) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "mock",
    provider: "mock",
    model: "mock",
    stopReason: (opts?.stopReason ?? "stop") as StopReason,
    errorMessage: opts?.errorMessage,
    timestamp: 0,
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.input + usage.output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

  const controls: MockSessionControls = {
    steerCalls: [],
    aborted: false,
    promptStarted: false,
    promptResolved: false,
    promptRejected: false,

    async emitTurn(opts) {
      const usage = opts?.usage ?? config.perTurnUsage ?? { input: 10, output: 5 };
      const text = opts?.finalText ?? config.finalText ?? "ok";
      const toolCall = opts?.toolCall;

      if (toolCall) {
        const evt = {
          type: "tool_execution_start" as const,
          toolCallId: `mock-tool-${Math.random().toString(36).slice(2)}`,
          toolName: toolCall.toolName,
          args: toolCall.args,
        } satisfies AgentSessionEvent;
        for (const l of listeners) l(evt);
      }

      const updateEvt = {
        type: "message_update" as const,
        message: makeAssistantMessage(text, usage),
        assistantMessageEvent: {
          type: "text_delta" as const,
          contentIndex: 0,
          delta: text,
          partial: makeAssistantMessage(text, usage),
        },
      } satisfies AgentSessionEvent;
      for (const l of listeners) l(updateEvt);

      const turnEvt = {
        type: "turn_end" as const,
        message: makeAssistantMessage(text, usage),
        toolResults: [],
      } satisfies AgentSessionEvent;
      for (const l of listeners) l(turnEvt);

      // yield so subscribers (e.g. session.ts turn-limit logic) can act
      await Promise.resolve();
    },

    finish(finalText, opts) {
      pendingFinish?.(finalText, opts);
    },

    fail(message) {
      pendingFail?.(message);
    },

    failWithProviderEvent(message) {
      // Emit the provider-failure event so session.ts captures it
      const evt = {
        type: "auto_retry_end" as const,
        success: false,
        attempt: 1,
        finalError: message,
      } satisfies AgentSessionEvent;
      for (const l of listeners) l(evt);
      // Resolve (not reject) — provider failure surfaces via event, not exception.
      // Empty terminal assistant message with stopReason "error" and no assistant
      // errorMessage, so providerError is the only source of the failure text.
      pendingFinish?.("", { stopReason: "error" });
    },
  };

  // Callbacks for the manual-control (no totalTurns) path
  let pendingFinish:
    | ((finalText?: string, opts?: { stopReason?: StopReason; errorMessage?: string }) => void)
    | undefined;
  let pendingFail: ((message: string) => void) | undefined;

  const mockSession: MockSessionSurface = {
    state: {},

    async bindExtensions(_bindings) {
      // no-op
    },

    subscribe(cb) {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    },

    async steer(text) {
      controls.steerCalls.push(text);
    },

    async abort() {
      controls.aborted = true;
      // Reject any pending prompt
      pendingFail?.("aborted");
    },

    async prompt(_task) {
      controls.promptStarted = true;

      if (config.failOnPrompt) {
        controls.promptRejected = true;
        throw new Error(config.failOnPrompt);
      }

      if (config.totalTurns !== undefined) {
        const total = config.totalTurns;
        const finalText = config.finalText ?? "ok";

        for (let i = 0; i < total; i++) {
          // Check abort before emitting each turn
          if (controls.aborted) {
            controls.promptRejected = true;
            throw new Error("aborted");
          }

          const toolCall = config.toolCalls?.[i];
          const isLast = i === total - 1;

          await controls.emitTurn({
            toolCall: toolCall ?? undefined,
            finalText: isLast ? finalText : undefined,
          });

          // After emitting turn, check if abort was triggered by a subscriber
          // (e.g. session.ts calls abort() on turn_end when turnCount >= turnLimit)
          if (controls.aborted) {
            controls.promptRejected = true;
            throw new Error("aborted");
          }
        }

        // Emit message_end on successful completion
        const endEvt = {
          type: "message_end" as const,
          message: makeAssistantMessage(finalText, { input: 0, output: 0 }),
        } satisfies AgentSessionEvent;
        for (const l of listeners) l(endEvt);

        controls.promptResolved = true;
        return;
      }

      // Manual control path: wait for finish() / fail() / abort()
      await new Promise<void>((resolve, reject) => {
        pendingFinish = (finalText, opts) => {
          pendingFinish = undefined;
          pendingFail = undefined;
          const text = finalText ?? config.finalText ?? "ok";
          if (opts?.errorMessage) {
            mockSession.state.errorMessage = opts.errorMessage;
          }
          const endEvt = {
            type: "message_end" as const,
            message: makeAssistantMessage(text, { input: 0, output: 0 }, opts),
          } satisfies AgentSessionEvent;
          for (const l of listeners) l(endEvt);
          controls.promptResolved = true;
          resolve();
        };

        pendingFail = (message) => {
          pendingFinish = undefined;
          pendingFail = undefined;
          controls.promptRejected = true;
          reject(new Error(message));
        };
      });
    },
  };

  return {
    session: mockSession as unknown as AgentSession,
    controls,
  };
}
