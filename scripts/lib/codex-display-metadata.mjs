// Display metadata is source data, never instructions or recovery direction.
// Do not derive list titles from an initial prompt: it may contain credentials.
export function capturedCodexDisplayMetadata(state, threadId, forkedFromId = null) {
  const name = typeof state?.name === "string" ? state.name.trim() : "";
  return { title: name || "Codex conversation · " + threadId,
    basis: name ? "captured-selected-state-name" : "recorded-native-identity-no-prompt-excerpt",
    namingPolicy: "captured-display-name-v1", sourceNativeThreadId: threadId,
    recordedForkedFromId: forkedFromId, sourceNameTrimmedForDisplay: typeof state?.name === "string" && name !== state.name,
    scope: "native-list-metadata-not-transcript-or-recovery-direction" };
}
