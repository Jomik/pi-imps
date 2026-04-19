export type ImpStatus = "running" | "completed" | "failed" | "dismissed";

export interface Imp {
  readonly name: string;
  readonly agentName: string; // named agent or "ephemeral"
  readonly task: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  status: ImpStatus;
  collected: boolean;
  completedAt?: number;
  turns: number;
  tokens: { input: number; output: number };
  output?: string;
  error?: string;
  activity?: string; // live: "→ bash npm test"
  /** Resolves when the imp finishes (completed/failed). Never rejects. */
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
}

export type AgentSource = "user" | "project";

export interface AgentConfig {
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly systemPrompt: string;
  readonly source: AgentSource;
  readonly filePath: string;
}
