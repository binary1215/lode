import { readCodexCapturedPhysicalEvents } from "../../scripts/lib/codex-captured-physical-source.mjs";
import { resolveCodexPhysicalLineage } from "../../scripts/lib/codex-physical-lineage.mjs";
import { codexNativePortabilityProfile } from "../../scripts/lib/codex-native-portability.mjs";
import { derivedHash as hash } from "../../scripts/lib/claude-derived-encoder.mjs";

export const id = "01900000-0000-7000-8000-000000006101", sibling = "01900000-0000-7000-8000-000000006102";
export function authoredFixture({ structuredQuestions = false, memoryCitation = false } = {}) {
  const rows = [], add = (type, payload) => rows.push({ ordinal: rows.length, type, payload });
  add("session_meta", { id, session_id: id, cli_version: codexNativePortabilityProfile().engineVersion, history_mode: "paginated" });
  add("event_msg", { type: "task_started", turn_id: "turn-1" });
  const message = (type, itemId, texts) => add("event_msg", { type: "item_completed", thread_id: id, turn_id: "turn-1", item: {
    type, id: itemId, content: texts.map(text => ({ type: type === "UserMessage" ? "text" : "Text", text })) } });
  message("UserMessage", "u-1", ["SYNTHETIC 질문 원문\n공백  유지", "취소·부정은 변경하지 마세요."]);
  add("response_item", { type: "function_call", call_id: "call-1", name: "synthetic_read", arguments: "{}" });
  message("AgentMessage", "a-1", ["실행 중 관측입니다.", "성공으로 해석하지 않습니다."]);
  if (structuredQuestions) rows.at(-1).payload.item.questions = [{ title: "SYNTHETIC 원래 질문을 확인할까요?", options: ["기존 방향 유지", "배포 취소 유지"] }];
  if (memoryCitation) rows.at(-1).payload.item.memory_citation = { entries: [{ path: "C:/synthetic-unavailable/history.md", lineStart: 2, lineEnd: 4, note: "SYNTHETIC historical citation; no current file observation" }], rolloutIds: [id] };
  message("UserMessage", "u-2", ["SYNTHETIC 취소: 배포하지 마세요."]);
  message("UserMessage", "u-3", ["SYNTHETIC 취소: 배포하지 마세요."]);
  add("response_item", { type: "function_call_output", call_id: "call-1", output: "SYNTHETIC failed observation", is_error: true });
  message("AgentMessage", "a-2", ["실패를 보존했습니다.", "배포하지 않았습니다."]);
  add("world_state", { full: true, state: { synthetic: "inactive provider state" } });
  add("event_msg", { type: "task_complete", turn_id: "turn-1" });
  const raw = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n"), originals = [{ threadId: id, rolloutId: id, raw, sha256: hash(raw) }];
  const native = { payload: { threadIds: [id], selectedRolloutId: id }, originals,
    proof: resolveCodexPhysicalLineage({ originals, rolloutId: id }) };
  const read = readCodexCapturedPhysicalEvents({ native, threadId: id });
  return { rows, native, read };
}
