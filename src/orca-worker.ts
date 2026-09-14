import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentDoneTool,
  extractTaskAfterMarker,
  type OrcaWorkerDispatch,
  verifyOrcaWorkerDispatch,
} from "./orca.js";

/**
 * Dedicated Orca worker extension entrypoint.
 *
 * Not part of pi-imps' auto-loaded extension manifest (`package.json`
 * `pi.extensions`). Orca instead loads this file explicitly, e.g.
 * `pi --no-extensions -e ./node_modules/pi-imps/src/orca-worker.ts`, so a
 * worker session never picks up ordinary pi-imps behavior (agent
 * discovery, summon/wait/dismiss, the agents-block system prompt).
 *
 * Verifies Orca's injected dispatched-worker preamble on the raw `input`
 * event text, strips it down to the task text after an exact standalone
 * `=== TASK ===` marker line, and transforms the input so no Orca
 * preamble, identifiers, capability, coordinator instructions, or embedded
 * CLI command ever reach the model. Registers `agent_done` exactly once at
 * load time, backed by private mutable dispatch context updated on each
 * verified input.
 */
export default function (pi: ExtensionAPI): void {
  let dispatch: OrcaWorkerDispatch | undefined;

  pi.registerTool(
    createAgentDoneTool(
      () => dispatch,
      (command, args) => pi.exec(command, args),
    ),
  );

  pi.on("input", (event) => {
    const verified = verifyOrcaWorkerDispatch(event.text);
    if (!verified) return { action: "continue" };

    const task = extractTaskAfterMarker(event.text);
    if (!task) return { action: "continue" };

    dispatch = verified;
    return { action: "transform", text: task };
  });
}
