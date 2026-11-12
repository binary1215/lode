import { AsyncLocalStorage } from "node:async_hooks";
import { inspectRecoveryCheckpointBasis } from "./compaction-recovery.mjs";

// 4-D (b2): initialize-or-resume reads the recovery basis for a verified caller
// immediately before the final Project read that builds its result, after the
// operation's own writes. The MCP dispatcher opens the capture; nothing else
// does, and the captured basis is never part of the result.
const captures = new AsyncLocalStorage();

export function withEntryBasisCapture(operation) {
  const slot = { basis: null };
  return captures.run(slot, async () => ({ value: await operation(), basis: slot.basis }));
}

export function captureEntryBasis(root) {
  const slot = captures.getStore();
  if (!slot) return;
  try {
    slot.basis = inspectRecoveryCheckpointBasis({ root }).basis;
  } catch {
    slot.basis = null;
  }
}
