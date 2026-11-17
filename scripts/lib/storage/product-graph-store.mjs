// The product graph file family inside the Project store (bundle 1).
//
// Layout, relative to the store directory (.lode or .head):
//   context/product-graph/제품 정의서.md          document (제품코어)
//   context/product-graph/유저 저니맵.md          document (유저저니)
//   context/product-graph/IA 문서.md              document (IA)
//   context/product-graph/유저플로우 기획서/<유저 활동 ID>.md   one per 유저 활동
//   context/product-graph/화면설계서/<화면 ID>.md               one per 화면
//   context/product-graph/정책.md                 one rule line per 정책
//   context/product-graph/기능 뜻.md              one meaning line per 기능
//   context/product-graph/호출 방식 표.json        per-project entry rules
//   context/product-graph/승인/product-graph-approval-<id>.json  approval records
//   context/product-graph/build/                  generated output, rebuildable
//
// Everything except build/ is user-owned Canon: Lode reads it and never
// rewrites it on its own. Approval records are immutable and content-addressed.
// The family holds no World, graph-snapshot or source-snapshot reference.
import { canonicalJson } from "../core/canonical-json.mjs";
import { sha256Hex } from "../core/digest.mjs";
import { failCode as fail } from "../core/errors.mjs";

export const PRODUCT_GRAPH_DIRECTORY = "context/product-graph";
export const PRODUCT_GRAPH_BUILD_DIRECTORY = "build";
export const PRODUCT_GRAPH_APPROVAL_DIRECTORY = "승인";
// Confirmation records: what a 뜻 line or a document row was checked against.
export const PRODUCT_GRAPH_CHECK_DIRECTORY = "확인";
export const PRODUCT_GRAPH_ACTIVITY_DIRECTORY = "유저플로우 기획서";
export const PRODUCT_GRAPH_SCREEN_DIRECTORY = "화면설계서";
export const PRODUCT_GRAPH_POLICY_FILE = "정책.md";
export const PRODUCT_GRAPH_MEANING_FILE = "기능 뜻.md";
export const PRODUCT_GRAPH_RULES_FILE = "호출 방식 표.json";
export const PRODUCT_GRAPH_SINGLE_DOCUMENTS = Object.freeze({
  "제품 정의서.md": "제품코어",
  "유저 저니맵.md": "유저저니",
  "IA 문서.md": "IA",
});
export const PRODUCT_GRAPH_MAX_FILE_BYTES = 1024 * 1024;
export const PRODUCT_GRAPH_MAX_FILES = 4096;

export const SCREEN_ID = /^[A-Z][A-Z0-9]*-[0-9]+$/;
export const ACTIVITY_ID = /^UA-[A-Z][A-Z0-9]*-[0-9]+$/;
const APPROVAL_NAME = /^(product-graph-approval-[a-f0-9]{24})\.json$/;
const CHECK_NAME = /^(product-graph-check-[a-f0-9]{24})\.json$/;

export const PRODUCT_GRAPH_APPROVAL_PROTOCOL = "lode-product-graph-approval";
export const PRODUCT_GRAPH_APPROVAL_VERSION = 1;

// Names are compared in NFC so a checkout that stores decomposed Hangul (for
// example an HFS+ volume) is still recognized; the physical name is kept.
const nfc = (name) => (typeof name === "string" ? name.normalize("NFC") : "");

// Classifies one path inside the family ("화면설계서/CHT-01.md"). Returns null
// for anything the family does not define; callers report those, never guess.
export function classifyProductGraphPath(relative) {
  if (typeof relative !== "string" || !relative) return null;
  const parts = relative.split("/").map(nfc);
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (parts[0] === PRODUCT_GRAPH_BUILD_DIRECTORY) return { role: "build", canon: false };
  if (parts.length === 1) {
    const name = parts[0];
    if (Object.hasOwn(PRODUCT_GRAPH_SINGLE_DOCUMENTS, name))
      return { role: "document", canon: true, nodeType: PRODUCT_GRAPH_SINGLE_DOCUMENTS[name], approvable: true };
    if (name === PRODUCT_GRAPH_POLICY_FILE) return { role: "policy", canon: true, nodeType: "정책", approvable: true };
    if (name === PRODUCT_GRAPH_MEANING_FILE) return { role: "meaning", canon: true, nodeType: "기능", approvable: false };
    if (name === PRODUCT_GRAPH_RULES_FILE) return { role: "rules", canon: true, approvable: false };
    return null;
  }
  if (parts.length !== 2) return null;
  const [directory, name] = parts;
  if (directory === PRODUCT_GRAPH_ACTIVITY_DIRECTORY && name.endsWith(".md") && ACTIVITY_ID.test(name.slice(0, -3)))
    return { role: "document", canon: true, nodeType: "유저 활동", id: name.slice(0, -3), approvable: true };
  if (directory === PRODUCT_GRAPH_SCREEN_DIRECTORY && name.endsWith(".md") && SCREEN_ID.test(name.slice(0, -3)))
    return { role: "document", canon: true, nodeType: "화면", id: name.slice(0, -3), approvable: true };
  if (directory === PRODUCT_GRAPH_APPROVAL_DIRECTORY && APPROVAL_NAME.test(name))
    return { role: "approval", canon: true, approvalId: APPROVAL_NAME.exec(name)[1] };
  if (directory === PRODUCT_GRAPH_CHECK_DIRECTORY && CHECK_NAME.test(name)) return { role: "check", canon: true, checkId: CHECK_NAME.exec(name)[1] };
  return null;
}

export const productGraphSubdirectories = Object.freeze([
  PRODUCT_GRAPH_ACTIVITY_DIRECTORY,
  PRODUCT_GRAPH_SCREEN_DIRECTORY,
  PRODUCT_GRAPH_APPROVAL_DIRECTORY,
  PRODUCT_GRAPH_CHECK_DIRECTORY,
]);

export function decodeProductGraphText(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail("PRODUCT_GRAPH_FILE_INVALID");
  if (bytes.length > PRODUCT_GRAPH_MAX_FILE_BYTES) fail("PRODUCT_GRAPH_FILE_TOO_LARGE");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("PRODUCT_GRAPH_FILE_NOT_UTF8");
  }
  if (text.includes("\0")) fail("PRODUCT_GRAPH_FILE_INVALID");
  return text.startsWith("﻿") ? text.slice(1) : text;
}

// An approval binds to what the document says, not to its bytes: UTF-8
// decoded, one leading BOM dropped, CRLF and lone CR turned into LF, NFC;
// then SHA-256 of the UTF-8 bytes. Nothing else is normalised.
export const PRODUCT_GRAPH_APPROVAL_DIGEST_BASIS = "utf8-text-bom-dropped-lf-nfc-sha256";

export function productGraphApprovalDigest(bytes) {
  decodeProductGraphText(bytes); // size, UTF-8 and NUL checks
  let text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  text = text.replace(/\r\n?/g, "\n").normalize("NFC");
  return sha256Hex(Buffer.from(text, "utf8"));
}

// Approval record without its own identity fields, in a fixed field set.
function approvalPayload(record) {
  return {
    schemaVersion: 1,
    kind: "ProductGraphApproval",
    protocol: { name: PRODUCT_GRAPH_APPROVAL_PROTOCOL, version: PRODUCT_GRAPH_APPROVAL_VERSION },
    projectId: record.projectId,
    document: record.document,
    documentTextSha256: record.documentTextSha256,
    digestBasis: PRODUCT_GRAPH_APPROVAL_DIGEST_BASIS,
    rationale: record.rationale,
    authority: "explicit-user-product-graph-approval",
    instructionAuthority: false,
    executionAuthority: false,
  };
}

export function productGraphApprovalRecord({ projectId, document, documentTextSha256, digestBasis = PRODUCT_GRAPH_APPROVAL_DIGEST_BASIS, rationale }) {
  if (typeof projectId !== "string" || !projectId) fail("PRODUCT_GRAPH_APPROVAL_INVALID");
  const target = classifyProductGraphPath(document);
  if (!target?.approvable || nfc(document) !== document) fail("PRODUCT_GRAPH_APPROVAL_TARGET_INVALID");
  if (!/^[a-f0-9]{64}$/.test(documentTextSha256 || "") || digestBasis !== PRODUCT_GRAPH_APPROVAL_DIGEST_BASIS) fail("PRODUCT_GRAPH_APPROVAL_INVALID");
  if (typeof rationale !== "string" || !rationale.trim() || rationale.length > 2000) fail("PRODUCT_GRAPH_APPROVAL_INVALID");
  const payload = approvalPayload({ projectId, document, documentTextSha256, rationale: rationale.trim() });
  const approvalHash = sha256Hex(canonicalJson(payload));
  return { ...payload, approvalId: `product-graph-approval-${approvalHash.slice(0, 24)}`, approvalHash };
}

// Verifies one approval record's exact shape and content address. A record
// whose name, fields or hash do not match is not an approval.
export function verifyProductGraphApproval(document, { projectId = null, approvalId = null } = {}) {
  const fields = [
    "schemaVersion",
    "kind",
    "protocol",
    "projectId",
    "document",
    "documentTextSha256",
    "digestBasis",
    "rationale",
    "authority",
    "instructionAuthority",
    "executionAuthority",
    "approvalId",
    "approvalHash",
  ];
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    JSON.stringify(Object.keys(document).sort()) !== JSON.stringify([...fields].sort())
  )
    fail("PRODUCT_GRAPH_APPROVAL_INVALID");
  const expected = productGraphApprovalRecord(document);
  if (canonicalJson(expected) !== canonicalJson(document)) fail("PRODUCT_GRAPH_APPROVAL_INVALID");
  if (projectId !== null && document.projectId !== projectId) fail("PRODUCT_GRAPH_APPROVAL_PROJECT_MISMATCH");
  if (approvalId !== null && document.approvalId !== approvalId) fail("PRODUCT_GRAPH_APPROVAL_INVALID");
  return document;
}

// ---------- confirmation records ----------
// What a 뜻 line or a document row was checked against: the content (and, for
// a 기능, reach) hashes of the nodes it points to at that moment. Written only
// by product-graph-confirm (an agent's check, "agent-checked") or alongside
// product-graph-approve ("user-approved"). Append-only and content-addressed
// like approval records; never rewritten, never reclaimed. It names no
// snapshot. It grants nothing: it says what was looked at.
export const PRODUCT_GRAPH_CHECK_PROTOCOL = "lode-product-graph-confirmation";
export const PRODUCT_GRAPH_CHECK_VERSION = 1;
// Bounds that keep the records from ever stopping a build: a record is at most
// PRODUCT_GRAPH_CHECK_MAX_BYTES (well under the 1 MiB file limit) and the
// records are counted apart from the documents (PRODUCT_GRAPH_MAX_FILES).
// Lode refuses to write past either bound.
export const PRODUCT_GRAPH_CHECK_MAX_ITEMS = 500;
export const PRODUCT_GRAPH_CHECK_MAX_BYTES = 256 * 1024;
export const PRODUCT_GRAPH_CHECK_MAX_RECORDS = 2000;
const ISO_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$/;
const readerValue = (value) => value === null || (typeof value === "string" && value.length <= 256) || (typeof value === "number" && Number.isFinite(value));
const CHECK_BY = Object.freeze({
  "agent-checked": "agent-check-of-code-not-user-approval",
  "user-approved": "explicit-user-product-graph-approval",
});
const HEX64 = /^[a-f0-9]{64}$/;
const ROW_TYPES = Object.freeze(["기능→화면요소", "화면요소→기능", "화면→코드"]);
const isText = (value, max = 2048) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
const sortedBy = (items, key) => [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

function checkBasis(basis) {
  if (!Array.isArray(basis) || !basis.length || basis.length > 64) fail("PRODUCT_GRAPH_CHECK_INVALID");
  const out = basis.map((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) fail("PRODUCT_GRAPH_CHECK_INVALID");
    const keys = Object.keys(node).sort().join(",");
    if (!["contentSha256,id", "contentSha256,id,reachSha256"].includes(keys)) fail("PRODUCT_GRAPH_CHECK_INVALID");
    if (!isText(node.id) || !HEX64.test(node.contentSha256) || (Object.hasOwn(node, "reachSha256") && !HEX64.test(node.reachSha256)))
      fail("PRODUCT_GRAPH_CHECK_INVALID");
    return Object.hasOwn(node, "reachSha256")
      ? { id: node.id, contentSha256: node.contentSha256, reachSha256: node.reachSha256 }
      : { id: node.id, contentSha256: node.contentSha256 };
  });
  if (new Set(out.map((node) => node.id)).size !== out.length) fail("PRODUCT_GRAPH_CHECK_INVALID");
  return sortedBy(out, (node) => node.id);
}

// One checked item in a closed shape: a 뜻 line, or a row of a document.
export function productGraphCheckItemKey(item) {
  return item.kind === "meaning" ? `meaning\u0000${item.id}` : `row\u0000${item.document}\u0000${item.type}\u0000${item.from}\u0000${item.to}`;
}

function checkItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) fail("PRODUCT_GRAPH_CHECK_INVALID");
  const keys = Object.keys(item).sort().join(",");
  if (item.kind === "meaning") {
    if (keys !== "basis,id,kind,textSha256" || !isText(item.id) || nfc(item.id) !== item.id || !HEX64.test(item.textSha256))
      fail("PRODUCT_GRAPH_CHECK_INVALID");
    const basis = checkBasis(item.basis);
    // The basis names the 기능 the line describes.
    if (!basis.some((node) => node.id === item.id)) fail("PRODUCT_GRAPH_CHECK_INVALID");
    return { kind: "meaning", id: item.id, textSha256: item.textSha256, basis };
  }
  if (item.kind === "documentRow") {
    if (keys !== "basis,document,documentTextSha256,from,kind,to,type") fail("PRODUCT_GRAPH_CHECK_INVALID");
    const target = classifyProductGraphPath(item.document);
    if (!target?.approvable || target.role !== "document" || nfc(item.document) !== item.document) fail("PRODUCT_GRAPH_CHECK_INVALID");
    if (!ROW_TYPES.includes(item.type) || !isText(item.from) || !isText(item.to) || !HEX64.test(item.documentTextSha256)) fail("PRODUCT_GRAPH_CHECK_INVALID");
    if (nfc(item.from) !== item.from || nfc(item.to) !== item.to) fail("PRODUCT_GRAPH_CHECK_INVALID");
    const basis = checkBasis(item.basis);
    // The basis names the node the row says something about.
    const rowTarget = item.type === "기능→화면요소" ? item.from : item.to;
    if (!basis.some((node) => node.id === rowTarget)) fail("PRODUCT_GRAPH_CHECK_INVALID");
    return {
      kind: "documentRow",
      document: item.document,
      type: item.type,
      from: item.from,
      to: item.to,
      documentTextSha256: item.documentTextSha256,
      basis,
    };
  }
  fail("PRODUCT_GRAPH_CHECK_INVALID");
}

function checkPayload(record) {
  if (typeof record.projectId !== "string" || !record.projectId) fail("PRODUCT_GRAPH_CHECK_INVALID");
  if (!Object.hasOwn(CHECK_BY, record.by)) fail("PRODUCT_GRAPH_CHECK_INVALID");
  if (typeof record.checkedAt !== "string" || !ISO_TIME.test(record.checkedAt) || !Number.isFinite(Date.parse(record.checkedAt)))
    fail("PRODUCT_GRAPH_CHECK_INVALID");
  if (record.rationale !== null && (typeof record.rationale !== "string" || !record.rationale.trim() || record.rationale.length > 2000))
    fail("PRODUCT_GRAPH_CHECK_INVALID");
  const reader = record.reader;
  if (!reader || typeof reader !== "object" || Array.isArray(reader) || Object.keys(reader).sort().join(",") !== "generator,graphVersion,sourceAnalysis")
    fail("PRODUCT_GRAPH_CHECK_INVALID");
  if (![reader.generator, reader.graphVersion, reader.sourceAnalysis].every(readerValue)) fail("PRODUCT_GRAPH_CHECK_INVALID");
  if (!Array.isArray(record.items) || !record.items.length || record.items.length > PRODUCT_GRAPH_CHECK_MAX_ITEMS) fail("PRODUCT_GRAPH_CHECK_INVALID");
  const items = sortedBy(record.items.map(checkItem), productGraphCheckItemKey);
  if (new Set(items.map(productGraphCheckItemKey)).size !== items.length) fail("PRODUCT_GRAPH_CHECK_INVALID");
  return {
    schemaVersion: 1,
    kind: "ProductGraphConfirmation",
    protocol: { name: PRODUCT_GRAPH_CHECK_PROTOCOL, version: PRODUCT_GRAPH_CHECK_VERSION },
    projectId: record.projectId,
    by: record.by,
    checkedAt: record.checkedAt,
    rationale: record.rationale === null ? null : record.rationale.trim(),
    reader: { generator: reader.generator ?? null, graphVersion: reader.graphVersion ?? null, sourceAnalysis: reader.sourceAnalysis ?? null },
    items,
    authority: CHECK_BY[record.by],
    instructionAuthority: false,
    executionAuthority: false,
  };
}

export function productGraphCheckRecord({ projectId, by, checkedAt, rationale = null, reader, items }) {
  const payload = checkPayload({ projectId, by, checkedAt, rationale, reader, items });
  const checkHash = sha256Hex(canonicalJson(payload));
  return { ...payload, checkId: `product-graph-check-${checkHash.slice(0, 24)}`, checkHash };
}

// A record whose name, fields or content address do not match is not a check.
export function verifyProductGraphCheck(document, { projectId = null, checkId = null } = {}) {
  const fields = [
    "schemaVersion",
    "kind",
    "protocol",
    "projectId",
    "by",
    "checkedAt",
    "rationale",
    "reader",
    "items",
    "authority",
    "instructionAuthority",
    "executionAuthority",
    "checkId",
    "checkHash",
  ];
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    JSON.stringify(Object.keys(document).sort()) !== JSON.stringify([...fields].sort())
  )
    fail("PRODUCT_GRAPH_CHECK_INVALID");
  if (document.kind !== "ProductGraphConfirmation" || document.schemaVersion !== 1) fail("PRODUCT_GRAPH_CHECK_INVALID");
  const expected = productGraphCheckRecord(document);
  if (canonicalJson(expected) !== canonicalJson(document)) fail("PRODUCT_GRAPH_CHECK_INVALID");
  if (projectId !== null && document.projectId !== projectId) fail("PRODUCT_GRAPH_CHECK_PROJECT_MISMATCH");
  if (checkId !== null && document.checkId !== checkId) fail("PRODUCT_GRAPH_CHECK_INVALID");
  return document;
}

const HANDLINGS = ["따라간다", "경계로 둔다", "범위 밖"];
const RULE_KINDS = ["hook", "command", "tool", "cli", "프론트"];

const UI_ENTRY_KEYS = [
  "이름",
  "설명",
  "판단",
  "처리",
  "확장자",
  "파일 표시",
  "모양",
  "메서드",
  "코드만",
  "대상 읽기",
  "이벤트 고정",
  "이벤트 바꾸기",
  "요소 이름",
  "유저 조작",
  "유저 조작 아님",
  "스스로 도는",
  "그 밖의 이벤트",
];
const NAME_SOURCES = ["보내는 쪽", "같은 태그 id", "줄 앞 대입"];

function regexOrFail(source, flags, invalid, where) {
  try {
    return new RegExp(source, flags);
  } catch (error) {
    invalid(`${where}을 정규식으로 읽지 못했다 (${error.message})`);
  }
}

// One UI binding pattern (a 프론트 entry of the table). Built-in entries and
// Project entries use this same shape; nothing in it names a toolkit.
export function verifyUiBindingPattern(entry, where = "UI 연결 패턴", { allowKind = false } = {}) {
  const invalid = (detail) => fail("PRODUCT_GRAPH_RULES_INVALID", `호출 방식 표가 올바르지 않다: ${detail}`);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid(`${where}가 객체가 아니다`);
  for (const key of Object.keys(entry)) if (!UI_ENTRY_KEYS.includes(key) && !(allowKind && key === "종류")) invalid(`${where}에 모르는 항목 ${key}`);
  if (typeof entry["이름"] !== "string" || !entry["이름"].trim()) invalid(`${where}.이름이 필요하다`);
  if (entry["처리"] !== undefined && !HANDLINGS.includes(entry["처리"])) invalid(`${where}.처리는 ${HANDLINGS.join(", ")} 중 하나여야 한다`);
  if (entry["판단"] !== undefined && entry["판단"] !== true) invalid(`${where}.판단은 true만 쓸 수 있다`);
  if (!Array.isArray(entry["확장자"]) || !entry["확장자"].length || entry["확장자"].some((item) => typeof item !== "string" || !/^\.[\w-]+$/.test(item)))
    invalid(`${where}.확장자는 ".py" 같은 확장자 배열이어야 한다`);
  if (entry["파일 표시"] !== undefined) regexOrFail(entry["파일 표시"], "m", invalid, `${where}.파일 표시`);
  if ((entry["모양"] === undefined) === (entry["메서드"] === undefined)) invalid(`${where}에는 모양이나 메서드 중 하나만 있어야 한다`);
  if (entry["메서드"] !== undefined) {
    regexOrFail(entry["메서드"], "", invalid, `${where}.메서드`);
    for (const key of ["코드만", "대상 읽기", "이벤트 고정", "요소 이름", "유저 조작", "유저 조작 아님", "스스로 도는", "그 밖의 이벤트"])
      if (entry[key] !== undefined) invalid(`${where}: 메서드 항목에는 ${key}를 쓰지 않는다`);
  } else {
    const expression = regexOrFail(entry["모양"], "gmd", invalid, `${where}.모양`);
    const groups = [...expression.source.matchAll(/\(\?<([A-Za-z]\w*)>/g)].map((match) => match[1]);
    for (const group of groups) if (!["event", "target", "emitter"].includes(group)) invalid(`${where}.모양의 이름 붙은 괄호는 event, target, emitter만 쓴다`);
    if (!groups.includes("target")) invalid(`${where}.모양에는 (?<target>…)이 있어야 한다`);
    if (!groups.includes("event") && typeof entry["이벤트 고정"] !== "string") invalid(`${where}에는 (?<event>…)나 이벤트 고정이 있어야 한다`);
    if (entry["코드만"] !== undefined && typeof entry["코드만"] !== "boolean") invalid(`${where}.코드만은 true 또는 false다`);
    if (entry["대상 읽기"] !== undefined && !["식", "그룹"].includes(entry["대상 읽기"])) invalid(`${where}.대상 읽기는 식 또는 그룹이다`);
    if (entry["요소 이름"] !== undefined && (!Array.isArray(entry["요소 이름"]) || entry["요소 이름"].some((item) => !NAME_SOURCES.includes(item))))
      invalid(`${where}.요소 이름은 ${NAME_SOURCES.join(", ")} 중에서 고른 배열이다`);
    for (const key of ["유저 조작", "유저 조작 아님", "스스로 도는", "그 밖의 이벤트"])
      if (entry[key] !== undefined && (!Array.isArray(entry[key]) || entry[key].some((item) => typeof item !== "string" || !item)))
        invalid(`${where}.${key}는 이벤트 이름 배열이다`);
    if (!(entry["유저 조작"] || []).length && !(entry["스스로 도는"] || []).length) invalid(`${where}에는 유저 조작이나 스스로 도는 이벤트가 있어야 한다`);
  }
  if (entry["이벤트 바꾸기"] !== undefined) {
    if (!Array.isArray(entry["이벤트 바꾸기"])) invalid(`${where}.이벤트 바꾸기는 배열이다`);
    for (const step of entry["이벤트 바꾸기"]) {
      if (step === "소문자" || step === "첫 글자 소문자") continue;
      if (!step || typeof step !== "object" || Object.keys(step).join() !== "떼기" || typeof step["떼기"] !== "string")
        invalid(`${where}.이벤트 바꾸기의 한 단계는 "소문자", "첫 글자 소문자" 또는 {"떼기": 정규식}이다`);
      regexOrFail(step["떼기"], "g", invalid, `${where}.이벤트 바꾸기.떼기`);
    }
  }
  return entry;
}

// Entry-rule table (the original's 호출 방식 표). Closed shape so a typo is
// reported instead of silently ignored.
export function verifyProductGraphRules(document) {
  const invalid = (detail) => fail("PRODUCT_GRAPH_RULES_INVALID", `호출 방식 표가 올바르지 않다: ${detail}`);
  if (!document || typeof document !== "object" || Array.isArray(document)) invalid("JSON 객체가 아니다");
  const allowedTop = ["schemaVersion", "kind", "rules", "source", "화면 코드 표시", "화면 파일", "내장 이름"];
  for (const key of Object.keys(document)) if (!allowedTop.includes(key)) invalid(`모르는 항목 ${key}`);
  if (document.schemaVersion !== 1 || document.kind !== "LodeProductGraphEntryRules") invalid("schemaVersion 1, kind LodeProductGraphEntryRules 이어야 한다");
  if (!Array.isArray(document.rules ?? [])) invalid("rules는 배열이어야 한다");
  for (const [index, rule] of (document.rules ?? []).entries()) {
    const where = `rules[${index}]`;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) invalid(`${where}가 객체가 아니다`);
    if (!RULE_KINDS.includes(rule["종류"])) invalid(`${where}.종류는 ${RULE_KINDS.join(", ")} 중 하나여야 한다`);
    if (rule["종류"] === "프론트" && (rule["모양"] !== undefined || rule["메서드"] !== undefined)) {
      verifyUiBindingPattern(rule, where, { allowKind: true });
      continue;
    }
    for (const key of Object.keys(rule))
      if (!["종류", "처리", "판단", "설명", "파일", "패턴", "처리 코드"].includes(key)) invalid(`${where}에 모르는 항목 ${key}`);
    if (rule["처리"] !== undefined && !HANDLINGS.includes(rule["처리"])) invalid(`${where}.처리는 ${HANDLINGS.join(", ")} 중 하나여야 한다`);
    if (rule["판단"] !== undefined && rule["판단"] !== true) invalid(`${where}.판단은 true만 쓸 수 있다`);
    if (rule["종류"] === "tool" || rule["종류"] === "cli") {
      if (rule["패턴"] === undefined && rule["처리"] !== undefined && rule["파일"] === undefined) continue;
      if (!Array.isArray(rule["파일"]) || !rule["파일"].length || rule["파일"].some((item) => typeof item !== "string" || !safeRelative(item)))
        invalid(`${where}.파일은 소스 루트 기준 상대 경로 배열이어야 한다`);
      if (typeof rule["패턴"] !== "string" || !rule["패턴"]) invalid(`${where}.패턴이 필요하다`);
      const expression = regexOrFail(rule["패턴"], "gm", invalid, `${where}.패턴`);
      if (!/\((?!\?)/.test(expression.source)) invalid(`${where}.패턴에는 이름을 잡는 괄호가 하나 있어야 한다`);
      if (rule["처리 코드"] !== undefined && !["줄을 감싼 코드", "파일", "항목"].includes(rule["처리 코드"]))
        invalid(`${where}.처리 코드는 줄을 감싼 코드, 파일 또는 항목이다`);
    } else if (rule["파일"] !== undefined || rule["패턴"] !== undefined || rule["처리 코드"] !== undefined) invalid(`${where}: 파일·패턴은 tool, cli에만 쓴다`);
  }
  const markers = document["화면 코드 표시"];
  if (markers !== undefined) {
    if (!Array.isArray(markers)) invalid("화면 코드 표시는 배열이다");
    for (const [index, marker] of markers.entries()) {
      const where = `화면 코드 표시[${index}]`;
      if (!marker || typeof marker !== "object" || Array.isArray(marker) || Object.keys(marker).some((key) => !["이름", "확장자", "표시"].includes(key)))
        invalid(`${where}는 이름, 확장자, 표시만 쓴다`);
      if (typeof marker["이름"] !== "string" || !marker["이름"]) invalid(`${where}.이름이 필요하다`);
      if (!Array.isArray(marker["확장자"]) || !marker["확장자"].length || marker["확장자"].some((item) => typeof item !== "string" || !/^\.[\w-]+$/.test(item)))
        invalid(`${where}.확장자는 확장자 배열이다`);
      if (typeof marker["표시"] !== "string") invalid(`${where}.표시가 필요하다`);
      regexOrFail(marker["표시"], "m", invalid, `${where}.표시`);
    }
  }
  // Global names a project adds to the built-in table (call precision 나):
  // { "javascript": { "네임스페이스": [...], "함수": [...] }, "python": {...} }.
  const globals = document["내장 이름"];
  if (globals !== undefined) {
    if (!globals || typeof globals !== "object" || Array.isArray(globals)) invalid("내장 이름은 객체다");
    for (const [language, table] of Object.entries(globals)) {
      if (!["javascript", "python"].includes(language)) invalid(`내장 이름에 모르는 언어 ${language} (javascript, python)`);
      if (!table || typeof table !== "object" || Array.isArray(table)) invalid(`내장 이름.${language}는 객체다`);
      for (const [key, names] of Object.entries(table)) {
        if (!["네임스페이스", "함수"].includes(key)) invalid(`내장 이름.${language}에 모르는 항목 ${key} (네임스페이스, 함수)`);
        if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !/^[A-Za-z_$][\w$]*$/.test(name)))
          invalid(`내장 이름.${language}.${key}는 이름 배열이다`);
      }
    }
  }
  const named = document["화면 파일"];
  if (named !== undefined && (!Array.isArray(named) || named.some((item) => typeof item !== "string" || !safeRelative(item))))
    invalid("화면 파일은 소스 루트 기준 상대 경로 배열이다");
  const source = document.source;
  if (source !== undefined) {
    if (!source || typeof source !== "object" || Array.isArray(source)) invalid("source는 객체여야 한다");
    for (const key of Object.keys(source)) if (key !== "제외") invalid(`source에 모르는 항목 ${key}`);
    if (!Array.isArray(source["제외"]) || source["제외"].some((item) => typeof item !== "string" || !safeRelative(item.replace(/\/$/, ""))))
      invalid("source.제외는 상대 경로 배열이어야 한다");
  }
  return document;
}

export function safeRelative(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/^[A-Za-z]:|^\//.test(value) &&
    !value.split("/").some((part) => !part || part === "." || part === ".." || /[\\\x00-\x1f]/.test(part))
  );
}

// Verifies one Canon file's bytes by its family path. Documents and line
// files must be bounded UTF-8 text; the rule table and approvals must match
// their closed shapes. Returns the classification.
export function verifyProductGraphCanonFile(relative, bytes, { projectId = null } = {}) {
  const target = classifyProductGraphPath(relative);
  if (!target?.canon) fail("PRODUCT_GRAPH_PATH_UNSUPPORTED");
  const text = decodeProductGraphText(bytes);
  if (target.role === "rules") {
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      fail("PRODUCT_GRAPH_RULES_INVALID");
    }
    verifyProductGraphRules(document);
  } else if (target.role === "approval") {
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      fail("PRODUCT_GRAPH_APPROVAL_INVALID");
    }
    verifyProductGraphApproval(document, { projectId, approvalId: target.approvalId });
  } else if (target.role === "check") {
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      fail("PRODUCT_GRAPH_CHECK_INVALID");
    }
    verifyProductGraphCheck(document, { projectId, checkId: target.checkId });
  }
  return target;
}

// Lists and verifies the family's Canon files through caller-supplied
// accessors, so a live store, a folder copy and a portable bundle use the same
// rule. list(relative) returns entry names under one directory (deeper names
// may be included; they are ignored here). readBytes(relative) returns bytes.
// Unrecognized names are returned, not verified and not transferred.
export function verifyProductGraphCanonOriginals({ directory, list, readBytes, projectId = null }) {
  const base = `${directory}/${PRODUCT_GRAPH_DIRECTORY}`;
  const verified = [],
    unrecognized = [];
  let checks = 0;
  const top = list(base);
  if (!top.length) return { verified, unrecognized };
  const visit = (prefix, names) => {
    for (const name of [...names].sort()) {
      if (name.includes("/")) {
        if (prefix) unrecognized.push(`${prefix}/${name}`);
        continue;
      }
      const within = prefix ? `${prefix}/${name}` : name;
      const target = classifyProductGraphPath(within);
      if (!prefix && (productGraphSubdirectories.includes(nfc(name)) || nfc(name) === PRODUCT_GRAPH_BUILD_DIRECTORY)) continue;
      if (!target?.canon) {
        unrecognized.push(within);
        continue;
      }
      // Confirmation records are counted apart from the documents.
      if (target.role === "check" ? ++checks > PRODUCT_GRAPH_CHECK_MAX_RECORDS : verified.length - checks >= PRODUCT_GRAPH_MAX_FILES)
        fail("PRODUCT_GRAPH_TOO_MANY_FILES");
      verifyProductGraphCanonFile(within, readBytes(`${base}/${within}`), { projectId });
      verified.push(`${base}/${within}`);
    }
  };
  visit("", top);
  // A bundle lists deeper names ("화면설계서/CHT-01.md"); a directory lists
  // the subdirectory itself. Both identify the same subdirectories.
  const subdirectories = new Set();
  for (const name of top) {
    const first = name.split("/")[0];
    if (productGraphSubdirectories.includes(nfc(first))) subdirectories.add(first);
    else if (name.includes("/") && nfc(first) !== PRODUCT_GRAPH_BUILD_DIRECTORY) unrecognized.push(name);
  }
  for (const name of [...subdirectories].sort()) {
    let names;
    try {
      names = list(`${base}/${name}`);
    } catch (error) {
      // A regular file named like a family folder is not a folder.
      if (error.code === "ENOTDIR") {
        unrecognized.push(name);
        continue;
      }
      throw error;
    }
    visit(name, names);
  }
  // Two names that differ only by Unicode normalisation (NFC and NFD) would be
  // one document under two spellings: refuse rather than carry both.
  const normalised = new Map();
  for (const file of verified) {
    const key = file.normalize("NFC");
    if (normalised.has(key) && normalised.get(key) !== file) fail("PRODUCT_GRAPH_NAME_TWIN", `같은 이름이 유니코드 정규화만 다르게 두 번 있다: ${key}`);
    normalised.set(key, file);
  }
  return { verified, unrecognized: [...new Set(unrecognized)].sort() };
}

// What a transfer did with the family, for export, import and adoption
// results. paths are the verified Canon files (store-relative); notRecognised
// are names inside the family Lode does not define.
export function summarizeProductGraphTransfer({ directory, verified = [], notRecognised = [], carried }) {
  const prefix = `${directory}/${PRODUCT_GRAPH_DIRECTORY}/`;
  const within = verified.map((file) => (file.startsWith(prefix) ? file.slice(prefix.length) : file).normalize("NFC"));
  const roles = within.map((file) => [file, classifyProductGraphPath(file)]);
  return {
    documents: roles.filter(([, target]) => target?.role === "document").length,
    approvalRecords: roles.filter(([, target]) => target?.role === "approval").length,
    checkRecords: roles.filter(([, target]) => target?.role === "check").length,
    otherUserFiles: roles
      .filter(([, target]) => ["policy", "meaning", "rules"].includes(target?.role))
      .map(([file]) => file)
      .sort(),
    buildOutput: carried ? "not-carried-rebuilt-by-product-graph-build" : "left-in-place-not-verified",
    notRecognised: notRecognised.map((name) => `${prefix}${name}`).sort(),
    notRecognisedHandling: carried ? "left-out-not-carried" : "left-in-place-not-verified",
  };
}
