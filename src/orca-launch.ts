import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { OrcaExecFn } from "./orca.js";
import { buildImpResourceLoader, resolveImpModel, resolveImpThinkingLevel, resolveTurnLimit } from "./session.js";
import type { AgentConfig, ImpSettings, ThinkingLevel } from "./types.js";

/**
 * Prepare (but never execute) an Orca-dispatched external launch.
 *
 * Reuses the exact same model, thinking, turn limit, tool, and extension
 * resolution as an in-process imp session (see `src/session.ts`), then
 * builds a safely single-quoted `pi ... --is-imp` command that a future
 * Orca launcher can hand to a terminal. This module performs no Orca
 * run/task/terminal operations itself — only local prerequisite checks
 * (POSIX platform, `orca status`, `orca worktree current`) and pure command
 * construction.
 */

/** POSIX platforms Orca imp launches are supported on. Windows/remote hosts are non-goals. */
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];

/** Absolute path to pi-imps' own worker entrypoint, derived from this module's location. */
const WORKER_ENTRYPOINT = fileURLToPath(new URL("./index.ts", import.meta.url));

interface OrcaCheckResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Single-quote one shell token per POSIX quoting rules: wrap in `'...'` and
 * replace every embedded `'` with `'\''`. Throws on an embedded NUL byte,
 * which cannot be represented in a POSIX command line argument.
 */
export function posixQuote(token: string): string {
  if (token.includes("\0")) {
    throw new Error("Refusing to build a command containing a NUL byte");
  }
  return `'${token.replace(/'/g, "'\\''")}'`;
}

/** Build a single-quoted POSIX command line from an argv array. Every token is quoted, including the program name. */
export function buildOrcaCommand(argv: readonly string[]): string {
  return argv.map(posixQuote).join(" ");
}

/** Run one `orca <args> --json` prerequisite check; throws an actionable diagnostic on any failure. */
async function runOrcaCheck(exec: OrcaExecFn, args: string[], label: string): Promise<void> {
  let result: OrcaCheckResult;
  try {
    result = await exec("orca", args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Orca ${label} check failed to run: ${message || "unknown error"}`);
  }

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "no output").trim();
    throw new Error(`Orca ${label} check failed (exit ${result.code}): ${detail || "no output"}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Orca ${label} check returned malformed JSON: ${result.stdout.trim() || "(empty output)"}`);
  }

  if (!parsed || typeof parsed !== "object" || (parsed as { ok?: unknown }).ok !== true) {
    throw new Error(`Orca ${label} check reported a non-ok status: ${result.stdout.trim() || "(empty output)"}`);
  }
}

/** Deduplicate a list of paths, preserving first-seen order. */
function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (!seen.has(path)) {
      seen.add(path);
      result.push(path);
    }
  }
  return result;
}

export interface BuildOrcaLaunchArgvParams {
  workerEntrypoint: string;
  extensionPaths: readonly string[];
  turnLimit: number;
  modelId: string;
  thinkingLevel: string;
  systemPrompt: string;
  toolAllowlist: string[] | undefined;
}

/**
 * Build the exact `pi` argv for an Orca imp launch. `agent_done` is always
 * allowed: it is unioned into an explicit tool allowlist, and omitted
 * (along with `--tools`) entirely means every tool among the selected
 * extensions/builtins is available.
 */
export function buildOrcaLaunchArgv(params: BuildOrcaLaunchArgvParams): string[] {
  const argv: string[] = [
    "pi",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "-e",
    params.workerEntrypoint,
  ];

  for (const path of params.extensionPaths) {
    argv.push("-e", path);
  }

  argv.push(
    "--is-imp",
    "--imp-turn-limit",
    String(params.turnLimit),
    "--model",
    params.modelId,
    "--thinking",
    params.thinkingLevel,
    "--system-prompt",
    params.systemPrompt,
  );

  if (params.toolAllowlist !== undefined) {
    const tools = params.toolAllowlist.includes("agent_done")
      ? params.toolAllowlist
      : [...params.toolAllowlist, "agent_done"];
    argv.push("--tools", tools.join(","));
  }

  return argv;
}

export interface OrcaLaunchPlan {
  /** Full single-quoted POSIX command line, ready to hand to a terminal. */
  readonly command: string;
  /** The unquoted argv the command was built from. */
  readonly argv: readonly string[];
  readonly modelId: string;
  readonly thinkingLevel: string;
  readonly turnLimit: number;
  readonly toolAllowlist: string[] | undefined;
  /** Absolute paths of selected extensions (excluding the internal worker entrypoint and inline pseudo-paths), in selection order. */
  readonly extensionPaths: readonly string[];
  readonly workerEntrypoint: string;
}

export interface PrepareOrcaLaunchOptions {
  cwd: string;
  config: AgentConfig;
  parentModel: Model<Api>;
  parentThinkingLevel: ThinkingLevel;
  modelRegistry: ModelRegistry;
  settings: ImpSettings;
  exec: OrcaExecFn;
  /** Injectable for tests; defaults to `process.platform`. Never mutate `process.platform` in tests. */
  platform?: NodeJS.Platform;
}

/**
 * Verify local Orca/POSIX prerequisites and build a serializable launch plan
 * for an Orca-dispatched imp worker. Performs no Orca run/task/terminal
 * operations — only prerequisite checks and pure resolution/command
 * construction. Fails explicitly (no silent local fallback) if the platform
 * is unsupported or either Orca check fails.
 */
export async function prepareOrcaLaunch(opts: PrepareOrcaLaunchOptions): Promise<OrcaLaunchPlan> {
  const platform = opts.platform ?? process.platform;
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(`Orca imp launches require a POSIX platform (darwin or linux); got "${platform}".`);
  }

  await runOrcaCheck(opts.exec, ["status", "--json"], "status");
  await runOrcaCheck(opts.exec, ["worktree", "current", "--json"], "current worktree");

  const model = resolveImpModel(opts.config, opts.parentModel, opts.modelRegistry);
  if (!model.provider || !model.id) {
    throw new Error(
      `Resolved model is missing a provider or id for Orca launch (provider="${model.provider}", id="${model.id}").`,
    );
  }
  const modelId = `${model.provider}/${model.id}`;

  const thinkingLevel = resolveImpThinkingLevel(opts.config.thinking ?? opts.parentThinkingLevel);
  const turnLimit = resolveTurnLimit(opts.config.turnLimit, opts.settings.turnLimit);

  const { loader, toolAllowlist } = buildImpResourceLoader(opts.cwd, opts.config, opts.settings);
  await loader.reload();
  const { extensions } = loader.getExtensions();
  const extensionPaths = dedupePaths(
    extensions
      .map((ext) => {
        if (ext.resolvedPath && isAbsolute(ext.resolvedPath)) return ext.resolvedPath;
        const fallback = ext.path;
        if (!fallback || fallback.startsWith("<")) return fallback;
        return isAbsolute(fallback) ? fallback : resolve(opts.cwd, fallback);
      })
      .filter((path): path is string => !!path && !path.startsWith("<")),
  );

  const argv = buildOrcaLaunchArgv({
    workerEntrypoint: WORKER_ENTRYPOINT,
    extensionPaths,
    turnLimit,
    modelId,
    thinkingLevel,
    systemPrompt: opts.config.systemPrompt,
    toolAllowlist,
  });

  return {
    command: buildOrcaCommand(argv),
    argv,
    modelId,
    thinkingLevel,
    turnLimit,
    toolAllowlist,
    extensionPaths,
    workerEntrypoint: WORKER_ENTRYPOINT,
  };
}
