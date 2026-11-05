import { sameCodexItemEvidence as same } from "./runtime-codex-turn-evidence.mjs";

// Pinned 3d2ee51: protocol/legacy_events.rs + protocol/thread_history.rs.
// One owned text-only seed, legacy history, raw reasoning explicitly disabled.
// Live UUIDs are NOT stored item-N IDs. Preserve both domains; do not strip IDs
// and compare unordered bags or normalize the stored side into a passing shape.
const fail = () => { throw Object.assign(new Error("Controlled seed differs from its pinned legacy projection"), { code: "CODEX_NATIVE_PREFIX_SOURCE_HISTORY_MISMATCH" }); };
const keys = (item, allowed) => { if (!item || Object.keys(item).some(key => !allowed.includes(key))) fail(); };
function itemValue(item) {
  if (typeof item?.id !== "string" || !item.id) fail();
  if (item.type === "userMessage") {
    keys(item, ["id", "type", "clientId", "content"]);
    if (!Array.isArray(item.content)) fail();
    return { type: item.type, clientId: item.clientId ?? null, content: item.content.map(input => {
      keys(input, ["type", "text", "text_elements"]);
      if (input.type !== "text" || typeof input.text !== "string" || !Array.isArray(input.text_elements ?? [])) fail();
      return { type: "text", text: input.text, text_elements: input.text_elements ?? [] };
    }) };
  }
  if (item.type === "agentMessage") {
    keys(item, ["id", "type", "text", "phase", "memoryCitation", "delivery", "questions"]);
    if (typeof item.text !== "string" || ![null, "commentary", "final_answer"].includes(item.phase ?? null)) fail();
    return { type: item.type, text: item.text, phase: item.phase ?? null,
      memoryCitation: item.memoryCitation ?? null, delivery: item.delivery ?? null, questions: item.questions ?? null };
  }
  if (item.type === "reasoning") {
    keys(item, ["id", "type", "summary", "content"]);
    if (![item.summary ?? [], item.content ?? []].every(values => Array.isArray(values) && values.every(value => typeof value === "string"))) fail();
    return { type: item.type, summary: item.summary ?? [], content: item.content ?? [] };
  }
  fail(); // Tools, compaction, injected prompts, and unknown items are not filtered.
}

export function assertCodexControlledLegacyPrefix({ liveItems, storedItems, seedInput }) {
  if (!Array.isArray(liveItems) || !Array.isArray(storedItems) || typeof seedInput !== "string" || !seedInput) fail();
  const liveIds = new Set(), expected = [];
  let users = 0;
  for (const live of liveItems) {
    const value = itemValue(live);
    if (liveIds.has(live.id)) fail();
    liveIds.add(live.id);
    if (value.type === "userMessage") {
      // The fixed source request contains one text chunk, no client ID/media.
      if (++users !== 1 || expected.length || liveIds.size !== 1 || !same(value, {
        type: "userMessage", clientId: null, content: [{ type: "text", text: seedInput, text_elements: [] }],
      })) fail();
      expected.push(value);
    } else if (value.type === "agentMessage") {
      // Legacy emits each nonempty core text segment; live v2 flattens them.
      if (value.text.length) expected.push(value);
    } else {
      const summary = value.summary.filter(part => part.length > 0);
      // show_raw_agent_reasoning=false omits raw legacy events. Empty events
      // do not allocate IDs or split consecutive persisted reasoning items.
      if (!summary.length) continue;
      const prior = expected.at(-1);
      if (prior?.type === "reasoning") prior.summary.push(...summary);
      else expected.push({ type: "reasoning", summary: [...summary], content: [] });
    }
  }
  if (users !== 1) fail();
  const stored = storedItems.map((item, index) => {
    if (item?.id !== `item-${index + 1}`) fail();
    return itemValue(item);
  });
  let offset = 0;
  for (const value of expected) {
    if (value.type !== "agentMessage") {
      if (!same(stored[offset++], value)) fail();
      continue;
    }
    // No substring matching or cross-live-item merge. Every stored segment is
    // nonempty, ordered, metadata-equal, and consumes exact remaining text.
    // v2 loses core text-chunk boundaries: prove observable text equivalence,
    // not those unavailable boundaries. Stored identities remain exact for fork.
    let remaining = value.text;
    while (remaining.length) {
      const segment = stored[offset++];
      if (!segment || segment.type !== "agentMessage" || !segment.text.length
        || !same({ ...segment, text: value.text }, value) || !remaining.startsWith(segment.text)) fail();
      remaining = remaining.slice(segment.text.length);
    }
  }
  if (offset !== stored.length) fail();
}
