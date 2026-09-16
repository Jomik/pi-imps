import type { Dirent } from "node:fs";
import { readdirSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
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
async function runOrcaCheck(exec: OrcaExecFn, args: string[], label: string, signal?: AbortSignal): Promise<void> {
  let result: OrcaCheckResult;
  try {
    result = await exec("orca", args, signal ? { signal } : undefined);
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

/** Basename prefix identifying an Orca host-integration extension under `${agentDir}/extensions`. */
const ORCA_HOST_EXTENSION_PREFIX = "orca-";

/** File extensions eligible for direct-file Orca host extension matches. */
const SUPPORTED_HOST_EXTENSION_FILE_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".js"]);

/**
 * Discover Orca host-integration extensions installed globally under
 * `${agentDir}/extensions`. Matches direct child entries whose basename
 * starts with `orca-`:
 *
 * - regular `.ts`/`.js` files
 * - directories (extension packages or index directories)
 * - symlinks, of any target type — passed through as-is; Pi's `-e` loader
 *   natively resolves single files, index directories, and package
 *   manifests, so no local symlink target inspection is done here.
 *
 * Non-matching basenames and other entry kinds (unsupported file
 * extensions, sockets, devices, etc.) are ignored. A missing extensions
 * directory (or a non-directory in its place) returns an empty list; any
 * other read failure throws a concise, actionable error. Results are
 * absolute paths, sorted lexically for a deterministic `-e` order.
 */
export function discoverOrcaHostExtensions(agentDir: string): string[] {
  const extensionsDir = join(agentDir, "extensions");
  let entries: Dirent[];
  try {
    entries = readdirSync(extensionsDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read Orca host extensions directory "${extensionsDir}": ${message}`);
  }

  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(ORCA_HOST_EXTENSION_PREFIX)) continue;
    if (entry.isSymbolicLink() || entry.isDirectory()) {
      matches.push(entry.name);
      continue;
    }
    if (entry.isFile() && SUPPORTED_HOST_EXTENSION_FILE_EXTENSIONS.has(extname(entry.name))) {
      matches.push(entry.name);
    }
  }

  return matches.sort().map((name) => join(extensionsDir, name));
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
 * Build the exact `pi` argv for an Orca imp launch. An explicit tool allowlist
 * is passed through unchanged; omitted `--tools` means every tool among the
 * selected extensions/builtins is available.
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
    argv.push("--tools", params.toolAllowlist.join(","));
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
  /** Abort signal checked before/after each prerequisite check and around `loader.reload()` (itself not cancellable). */
  signal?: AbortSignal;
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

  await runOrcaCheck(opts.exec, ["status", "--json"], "status", opts.signal);
  await runOrcaCheck(opts.exec, ["worktree", "current", "--json"], "current worktree", opts.signal);

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
  opts.signal?.throwIfAborted();
  await loader.reload();
  opts.signal?.throwIfAborted();
  const { extensions } = loader.getExtensions();
  const selectedExtensionPaths = extensions
    .map((ext) => {
      if (ext.resolvedPath && isAbsolute(ext.resolvedPath)) return ext.resolvedPath;
      const fallback = ext.path;
      if (!fallback || fallback.startsWith("<")) return fallback;
      return isAbsolute(fallback) ? fallback : resolve(opts.cwd, fallback);
    })
    .filter((path): path is string => !!path && !path.startsWith("<"));

  // Orca host-integration extensions (e.g. status/prefill/title bridges)
  // always load for Orca-dispatched workers, regardless of the tool
  // allowlist or `additionalExtensions` — they are not ordinary
  // tool-providing extensions and are never subject to that filtering.
  const hostExtensionPaths = discoverOrcaHostExtensions(getAgentDir());
  const extensionPaths = dedupePaths([...selectedExtensionPaths, ...hostExtensionPaths]);

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
