export type ImpStatus = "running" | "completed" | "failed" | "dismissed" | "truncated";

/** Serializable subset of Imp — safe for details/display, no runtime handles. */
export interface ImpSnapshot {
  readonly name: string;
  readonly agent: string | undefined;
  status: ImpStatus;
  turns: number;
  tokens: { input: number; output: number };
  output?: string;
  error?: string;
  activity?: string; // live: "→ bash npm test"
}

/** Full runtime imp — extends snapshot with non-serializable handles. */
export interface Imp extends ImpSnapshot {
  readonly task: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  completedAt?: number;
  session?: { abort(): Promise<void> }; // set once session is spawned
  /** Resolves when the imp finishes (completed/failed). Never rejects. */
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
}

export type AgentSource = "user" | "project";

export interface AgentConfig {
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly tools?: string[];
  readonly systemPrompt: string;
  readonly source: AgentSource;
  readonly filePath: string;
}

/** Extension settings under the "pi-imps" key in settings.json */
export interface ImpSettings {
  /** Max turns before an imp is cut off. Default: 30 */
  turnLimit: number;
  /** Default tool allowlist for all imps. undefined = all tools allowed */
  toolAllowlist: string[] | undefined;
  /** Extensions that always load on imp sessions regardless of tool filtering */
  additionalExtensions: string[];
}
