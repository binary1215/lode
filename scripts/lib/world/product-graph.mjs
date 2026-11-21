// 제품 그래프 (bundle 1): build, check and approve.
//
// The model, node types, check phrases and Korean vocabulary are the original
// project's (Won6314/head-agent-core, graph/build/02a-graph-definitions.md),
// adopted unchanged by the user on 2026-11-15. This is not the existing
// Product Model and does not read, write or reinterpret product-model.json.
// The family is not a World input.
import { markTextFromStructure } from "./product-graph-answer.mjs";
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../core/digest.mjs";
import { failCode as fail } from "../core/errors.mjs";
import { atomicCreateArtifact, atomicWriteArtifact } from "../core/fs-atomic.mjs";
import { readGraphProject, safeGraphFile } from "./discovery-index.mjs";
import { withProjectMutation } from "../storage/project-mutation-lock.mjs";
import {
  PRODUCT_GRAPH_APPROVAL_DIRECTORY,
  PRODUCT_GRAPH_BUILD_DIRECTORY,
  PRODUCT_GRAPH_CHECK_DIRECTORY,
  PRODUCT_GRAPH_CHECK_MAX_BYTES,
  PRODUCT_GRAPH_CHECK_MAX_RECORDS,
  PRODUCT_GRAPH_DIRECTORY,
  PRODUCT_GRAPH_MAX_FILE_BYTES,
  PRODUCT_GRAPH_MAX_FILES,
  PRODUCT_GRAPH_RULES_FILE,
  PRODUCT_GRAPH_RUN_DIRECTORY,
  PRODUCT_GRAPH_RUN_MAX_BYTES,
  PRODUCT_GRAPH_RUN_MAX_OUTPUT,
  PRODUCT_GRAPH_RUN_MAX_RECORDS,
  PRODUCT_GRAPH_RUN_MAX_RUNS,
  classifyProductGraphPath,
  decodeProductGraphText,
  productGraphApprovalDigest,
  productGraphApprovalRecord,
  productGraphSubdirectories,
  verifyProductGraphApproval,
  verifyProductGraphCheck,
  verifyProductGraphRules,
  verifyProductGraphRun,
  productGraphRunRecord,
} from "../storage/product-graph-store.mjs";
import { checkableItems, confirmationRecords, confirmationStatus } from "./product-graph-confirmations.mjs";
import {
  CORE_HEADINGS,
  parseActivityDocument,
  parseCoreDocument,
  parseIaDocument,
  parseJourneyDocument,
  parseMeaningFile,
  parsePolicyFile,
  parseScreenDocument,
} from "./product-graph-documents.mjs";
import { assertUniqueIds, extractProductGraphCode, productGraphCodeFiles } from "./product-graph-extraction.mjs";
import {
  PRODUCT_GRAPH_BASELINE_FILE,
  PRODUCT_GRAPH_RETAINED_CONTENT_FILE,
  addContentHashes,
  baselineFromGraph,
  compareWithBaseline,
  noBaseline,
  productGraphReader,
  readBaseline,
  readerKey,
  readRetainedContent,
  retainedContentFor,
  serializeBaseline,
  serializeRetainedContent,
  sourceTextHash,
} from "./product-graph-compare.mjs";
import { productGraphWalk as walk } from "../../graph-explorer/product-graph-walk.js";
import { machineEdges, runLabel, runStates } from "./product-graph-runs.mjs";

export const PRODUCT_GRAPH_VERSION = 2;
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const nfc = (name) => name.normalize("NFC");
// What the impact preview compares between builds: the Project, the source
// root (as a hash, never the path) and the way code is read. Nothing in it
// changes with a plugin update that reads code the same way.
const buildScope = (inputs) => ({
  projectId: inputs.projectId || null,
  sourceRootHash: sha256Hex(fs.realpathSync.native(inputs.sourceRoot).replaceAll("\\", "/")),
  reader: JSON.parse(readerKey(productGraphReader(PRODUCT_GRAPH_VERSION))),
});
export const PRODUCT_GRAPH_BUILD_CONTEXT_FILE = "build-context.json";

export const NODE_TYPES = Object.freeze([
  "제품코어",
  "유저저니",
  "IA",
  "유저 활동",
  "화면",
  "화면요소",
  "정책",
  "기능",
  "코드",
  "데이터",
  "외부 연결",
  "DB",
  "계측 이벤트",
]);
export const NOT_EXTRACTED = Object.freeze(["계측 이벤트"]);
// What the counts of the outside-facing node types cover (2.8).
export const COUNT_COVERS = Object.freeze({
  데이터: "환경 변수 이름과 바깥 규칙이 이름 붙인 데이터",
  "외부 연결": "바깥 규칙이 이름 붙인 외부 연결",
  DB: "코드 문자열과 .sql 파일의 CREATE TABLE로 만든 표와 그 열",
});

// The original's six checks: phrase and meaning, verbatim.
export const CHECKS = Object.freeze([
  Object.freeze({ key: "product-core-policy", heading: "제품코어와 부딪히는 정책", meaning: "정책이나 제품코어 중 하나가 틀렸다" }),
  Object.freeze({
    key: "element-function-without-activity",
    heading: "화면요소 → 기능이 있는데 그 화면요소를 가리키는 유저 활동이 없다",
    meaning: "기획에 빠진 일이거나 쓰이지 않는 기능",
  }),
  Object.freeze({ key: "activity-navigate", heading: "앞 활동의 화면에서 다음 활동의 화면으로 가는 navigate가 없다", meaning: "막힌 동선" }),
  Object.freeze({ key: "screen-without-activity", heading: "어떤 유저 활동도 가리키지 않는 화면", meaning: "목적 없는 화면" }),
  Object.freeze({ key: "screen-policy-differs", heading: "화면 정책 절과 정책 노드가 다르다", meaning: "둘 중 하나가 낡았다" }),
  Object.freeze({ key: "journey-order-differs", heading: "유저 활동의 다음 활동과 유저저니 순서가 다르다", meaning: "둘 중 하나가 낡았다" }),
]);

const DOCUMENT_NAMES = Object.freeze({
  제품코어: "제품 정의서",
  유저저니: "유저 저니맵",
  IA: "IA 문서",
  "유저 활동": "유저플로우 기획서",
  화면: "화면설계서",
  정책: "정책 파일",
});
// Subject particles, so a reason reads as a sentence.
const SUBJECT = Object.freeze({
  "제품 정의서": "제품 정의서가",
  "유저 저니맵": "유저 저니맵이",
  "IA 문서": "IA 문서가",
  유저플로우기획서: "유저플로우 기획서가",
  "유저플로우 기획서": "유저플로우 기획서가",
  화면설계서: "화면설계서가",
  "정책 파일": "정책 파일이",
});

// ---------- inputs ----------

function readProject(root) {
  try {
    return readGraphProject(root);
  } catch (error) {
    if (error.code === "ENOENT") return { project: null };
    throw error;
  }
}

function listDirectory(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(nfc(a.name), nfc(b.name)));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function readBounded(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("PRODUCT_GRAPH_FILE_INVALID");
  if (stat.size > PRODUCT_GRAPH_MAX_FILE_BYTES) fail("PRODUCT_GRAPH_FILE_TOO_LARGE");
  return fs.readFileSync(file);
}

// S1: every existing component from the Project root to target must be a real
// directory or file, not a link or junction, so nothing is written or read
// through a link to somewhere outside the Project.
function assertNoLinkedComponents(projectRoot, target) {
  const relative = path.relative(projectRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("PRODUCT_GRAPH_LINKED_PATH", "제품 그래프 경로가 프로젝트 밖을 가리킨다.");
  let current = projectRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink())
      fail("PRODUCT_GRAPH_LINKED_PATH", `제품 그래프 경로에 링크가 있어 쓰지 않는다: ${path.relative(projectRoot, current).replaceAll("\\", "/")}`);
  }
}

// Reads the documents directory in the family layout. Unknown names are
// listed, never parsed. Confirmation records are only listed here (name,
// physical path); readCheckFiles reads them, and only when asked: freshness
// reads none.
function readDocumentFiles(directory, { readChecks = true } = {}) {
  const files = [],
    unrecognized = [],
    checks = [],
    checkFolderIssues = [],
    runs = [],
    runFolderIssues = [];
  const visit = (prefix, absolute) => {
    let entries;
    try {
      entries = listDirectory(absolute);
    } catch (error) {
      // A 확인/ or 실행 기록/ folder that cannot be listed is an issue, never a failure.
      if (prefix === PRODUCT_GRAPH_RUN_DIRECTORY) {
        runFolderIssues.push({
          path: `${PRODUCT_GRAPH_RUN_DIRECTORY}/`,
          code: "PRODUCT_GRAPH_RUN_UNREADABLE",
          reason: "실행 기록 폴더를 읽지 못했다",
          errno: error.code || null,
        });
        return;
      }
      if (prefix !== PRODUCT_GRAPH_CHECK_DIRECTORY) throw error;
      checkFolderIssues.push({
        path: `${PRODUCT_GRAPH_CHECK_DIRECTORY}/`,
        code: "PRODUCT_GRAPH_CHECK_UNREADABLE",
        reason: "확인 기록 폴더를 읽지 못했다",
        errno: error.code || null,
      });
      return;
    }
    for (const entry of entries) {
      const name = nfc(entry.name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!prefix && name === PRODUCT_GRAPH_BUILD_DIRECTORY) continue;
      if (entry.isDirectory()) {
        if (!prefix && productGraphSubdirectories.includes(name)) visit(name, path.join(absolute, entry.name));
        else unrecognized.push(relative + "/");
        continue;
      }
      const target = classifyProductGraphPath(relative);
      if (!entry.isFile() || !target?.canon) {
        unrecognized.push(relative);
        continue;
      }
      // Confirmation records are read apart (below): nothing in 확인/ can
      // stop a build, a check or a baseline move.
      if (target.role === "check") {
        checks.push({ path: relative, ...target, absolute: path.join(absolute, entry.name) });
        continue;
      }
      if (target.role === "run") {
        runs.push({ path: relative, ...target, absolute: path.join(absolute, entry.name) });
        continue;
      }
      if (files.length >= PRODUCT_GRAPH_MAX_FILES) fail("PRODUCT_GRAPH_TOO_MANY_FILES");
      const bytes = readBounded(path.join(absolute, entry.name));
      files.push({ path: relative, ...target, bytes, sha256: sha256Hex(bytes) });
    }
  };
  visit("", directory);
  const byPath = new Map();
  for (const file of files) byPath.set(file.path, (byPath.get(file.path) || 0) + 1);
  const twins = [...byPath.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  return {
    files: files.filter((file) => !twins.includes(file.path)).sort((a, b) => compare(a.path, b.path)),
    unrecognized: unrecognized.sort(),
    twins: twins.sort(),
    ...(readChecks ? readCheckFiles(checks, checkFolderIssues) : {}),
    ...(readChecks ? readRunFiles(runs, runFolderIssues) : {}),
  };
}

// At most this many surplus names are listed one by one; the rest are counted.
const CHECK_SURPLUS_LISTED = 100;

// Confirmation records, in file-name order: the first
// PRODUCT_GRAPH_CHECK_MAX_RECORDS are read, each up to
// PRODUCT_GRAPH_CHECK_MAX_BYTES. A record over the size, one that cannot be
// read, and records past the count are issues naming their file (the first
// CHECK_SURPLUS_LISTED surplus names, then one count); an issue excuses
// nothing and never fails the build.
// The words and bounds of each kind of record a build reads apart.
const RECORD_KINDS = Object.freeze({
  check: {
    directory: PRODUCT_GRAPH_CHECK_DIRECTORY,
    maxRecords: PRODUCT_GRAPH_CHECK_MAX_RECORDS,
    maxBytes: PRODUCT_GRAPH_CHECK_MAX_BYTES,
    noun: "확인 기록",
    idField: "checkId",
    codes: { invalid: "PRODUCT_GRAPH_CHECK_INVALID", limit: "PRODUCT_GRAPH_CHECK_LIMIT", unreadable: "PRODUCT_GRAPH_CHECK_UNREADABLE" },
  },
  run: {
    directory: PRODUCT_GRAPH_RUN_DIRECTORY,
    maxRecords: PRODUCT_GRAPH_RUN_MAX_RECORDS,
    maxBytes: PRODUCT_GRAPH_RUN_MAX_BYTES,
    noun: "실행 기록",
    idField: "runId",
    codes: { invalid: "PRODUCT_GRAPH_RUN_INVALID", limit: "PRODUCT_GRAPH_RUN_LIMIT", unreadable: "PRODUCT_GRAPH_RUN_UNREADABLE" },
  },
});

function readCheckFiles(entries, folderIssues = []) {
  const read = readRecordFiles(entries, folderIssues, RECORD_KINDS.check);
  return { checkFiles: read.files, checkIssues: read.issues, recordLimit: read.recordLimit, checkListingSha256: read.listingSha256 };
}

// Run records, read like confirmation records (2.6): an issue never fails a build.
function readRunFiles(entries, folderIssues = []) {
  const read = readRecordFiles(entries, folderIssues, RECORD_KINDS.run);
  return { runFiles: read.files, runIssues: read.issues, runRecordLimit: read.recordLimit, runListingSha256: read.listingSha256 };
}

function readRecordFiles(entries, folderIssues, spec) {
  const files = [],
    issues = [...folderIssues];
  const ordered = [...entries].sort((a, b) => compare(a.path, b.path));
  const seen = new Set();
  const listing = [];
  let surplus = 0;
  for (const [index, entry] of ordered.entries()) {
    const issue = ({ code }, reason, extra = {}) => issues.push({ path: entry.path, code, reason, ...extra });
    // Sizes only for the records that are read; surplus names are names only.
    let stat = null;
    if (index < spec.maxRecords)
      try {
        stat = fs.lstatSync(entry.absolute);
      } catch {
        /* Reported below. */
      }
    listing.push([entry.path, stat?.size ?? null]);
    if (seen.has(entry.path)) {
      issue({ code: spec.codes.invalid }, `같은 이름(정규화 뒤)의 ${spec.noun}이 둘 이상이다`);
      continue;
    }
    seen.add(entry.path);
    if (index >= spec.maxRecords) {
      surplus += 1;
      if (surplus <= CHECK_SURPLUS_LISTED)
        issue({ code: spec.codes.limit }, `${spec.noun}이 ${spec.maxRecords}개를 넘어 읽지 않았다(파일 이름 순으로 앞의 ${spec.maxRecords}개만 읽는다)`);
      continue;
    }
    if (!stat) {
      issue({ code: spec.codes.unreadable }, `${spec.noun}을 읽지 못했다`);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      issue({ code: spec.codes.invalid }, `${spec.noun}이 일반 파일이 아니다`);
      continue;
    }
    if (stat.size > spec.maxBytes) {
      issue({ code: spec.codes.limit }, `${spec.noun}이 ${spec.maxBytes}바이트를 넘어 읽지 않았다`, { bytes: stat.size });
      continue;
    }
    let bytes;
    try {
      bytes = fs.readFileSync(entry.absolute);
    } catch (error) {
      issue({ code: spec.codes.unreadable }, `${spec.noun}을 읽지 못했다`, { errno: error.code || null });
      continue;
    }
    if (bytes.length > spec.maxBytes) {
      issue({ code: spec.codes.limit }, `${spec.noun}이 ${spec.maxBytes}바이트를 넘어 읽지 않았다`, { bytes: bytes.length });
      continue;
    }
    files.push({ path: entry.path, role: entry.role, [spec.idField]: entry[spec.idField], bytes, sha256: sha256Hex(bytes) });
  }
  if (surplus > CHECK_SURPLUS_LISTED)
    issues.push({
      path: `${spec.directory}/`,
      code: spec.codes.limit,
      reason: `그 밖에 ${spec.noun} ${surplus - CHECK_SURPLUS_LISTED}개를 더 읽지 않았다(이름은 앞의 ${CHECK_SURPLUS_LISTED}개만 적는다)`,
      count: surplus - CHECK_SURPLUS_LISTED,
    });
  const recordLimit = ordered.length > spec.maxRecords ? { present: ordered.length, read: spec.maxRecords } : null;
  return { files, issues, recordLimit, listingSha256: checkListingDigest(listing, folderIssues) };
}

// What freshness compares: every record name with its size, and whether the
// folder could be listed. No record is read for it, so a change in place that
// keeps the size is noticed at the next build.
function checkListingDigest(listing, folderIssues = []) {
  return sha256Hex(JSON.stringify({ listing, unlisted: folderIssues.map((issue) => issue.path) }));
}

function resolveInputs(options) {
  const { root = ".", sourceRoot = null, documentsDirectory = null, rulesFile = null, outputDirectory = null, requireOutput = false } = options;
  if (documentsDirectory !== null || sourceRoot !== null || rulesFile !== null || outputDirectory !== null) {
    // Stand-alone: every location is explicit; no Project is read or written.
    const missing = [
      ["sourceRoot", sourceRoot],
      ["documentsDirectory", documentsDirectory],
      ["rulesFile", rulesFile],
      ...(requireOutput ? [["outputDirectory", outputDirectory]] : []),
    ].filter(([, value]) => typeof value !== "string" || !value);
    if (missing.length)
      fail(
        "PRODUCT_GRAPH_STANDALONE_INPUT_REQUIRED",
        `독립 실행에는 소스 루트, 문서 폴더, 호출 방식 표 파일${requireOutput ? ", 출력 폴더" : ""}를 모두 줘야 한다.`,
      );
    const documents = path.resolve(documentsDirectory);
    if (!fs.existsSync(documents) || !fs.statSync(documents).isDirectory()) fail("PRODUCT_GRAPH_DOCUMENTS_MISSING");
    if (outputDirectory) {
      const output = path.resolve(outputDirectory);
      const inside = (parent) => {
        const relative = path.relative(parent, output);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      };
      if (inside(documents) || output === path.resolve(sourceRoot))
        fail("PRODUCT_GRAPH_OUTPUT_OVERLAPS", "출력 폴더는 문서 폴더(또는 그 안)나 소스 루트와 같을 수 없다.");
    }
    return {
      mode: "standalone",
      sourceRoot: path.resolve(sourceRoot),
      documentsDirectory: documents,
      rulesFile: path.resolve(rulesFile),
      rulesRequired: true,
      outputDirectory: outputDirectory ? path.resolve(outputDirectory) : null,
      projectId: null,
      approvals: false,
    };
  }
  const inspected = readProject(root);
  if (!inspected.project)
    fail(
      "NOT_INITIALIZED",
      "제품 그래프는 Lode 프로젝트나, 소스 루트·문서 폴더·호출 방식 표를 모두 준 독립 실행에서만 쓴다. 이 폴더는 Lode 프로젝트가 아니다.",
    );
  const projectRoot = inspected.project.projectRoot;
  const family = path.join(projectRoot, inspected.storage.directory, ...PRODUCT_GRAPH_DIRECTORY.split("/"));
  return {
    mode: "project",
    projectRoot,
    storage: inspected.storage,
    sourceRoot: projectRoot,
    documentsDirectory: family,
    rulesFile: path.join(family, PRODUCT_GRAPH_RULES_FILE),
    rulesRequired: false,
    outputDirectory: path.join(family, PRODUCT_GRAPH_BUILD_DIRECTORY),
    projectId: inspected.project.projectId,
    approvals: true,
  };
}

function readRules(inputs) {
  if (!fs.existsSync(inputs.rulesFile)) {
    if (inputs.rulesRequired) fail("PRODUCT_GRAPH_RULES_MISSING", "호출 방식 표 파일이 없다.");
    return { rules: null, sha256: null };
  }
  const bytes = readBounded(inputs.rulesFile);
  let document;
  try {
    document = JSON.parse(decodeProductGraphText(bytes));
  } catch (error) {
    if (error.code) throw error;
    fail("PRODUCT_GRAPH_RULES_INVALID", "호출 방식 표를 JSON으로 읽지 못했다.");
  }
  return { rules: verifyProductGraphRules(document), sha256: sha256Hex(bytes) };
}

// ---------- graph and checks ----------

function loadDocuments(inputs) {
  const read = readDocumentFiles(inputs.documentsDirectory);
  // Approved digests per document path, so a document whose text changed
  // after approval can be told apart from one never approved.
  const approvals = new Map();
  const approvalIssues = [];
  for (const file of read.files.filter((item) => item.role === "approval")) {
    if (!inputs.approvals) continue;
    try {
      const record = verifyProductGraphApproval(JSON.parse(decodeProductGraphText(file.bytes)), { projectId: inputs.projectId, approvalId: file.approvalId });
      if (!approvals.has(record.document)) approvals.set(record.document, new Set());
      approvals.get(record.document).add(record.documentTextSha256);
    } catch (error) {
      const code = error.code || "PRODUCT_GRAPH_APPROVAL_INVALID";
      approvalIssues.push({
        path: file.path,
        code,
        reason:
          code === "PRODUCT_GRAPH_APPROVAL_PROJECT_MISMATCH"
            ? "다른 프로젝트의 승인 기록이다"
            : code === "PRODUCT_GRAPH_APPROVAL_INVALID"
              ? "승인 기록의 모양이나 내용 주소가 맞지 않는다"
              : "승인 기록으로 읽지 못했다",
      });
    }
  }
  // Confirmation records (project mode only, like approvals). One that does
  // not verify is an issue naming its file and excuses nothing.
  const checkRecords = [];
  const checkIssues = inputs.approvals ? [...read.checkIssues] : [];
  for (const file of read.checkFiles) {
    if (!inputs.approvals) continue;
    try {
      checkRecords.push(verifyProductGraphCheck(JSON.parse(decodeProductGraphText(file.bytes)), { projectId: inputs.projectId, checkId: file.checkId }));
    } catch (error) {
      const code = error.code || "PRODUCT_GRAPH_CHECK_INVALID";
      checkIssues.push({
        path: file.path,
        code,
        reason:
          code === "PRODUCT_GRAPH_CHECK_PROJECT_MISMATCH"
            ? "다른 프로젝트의 확인 기록이다"
            : code === "PRODUCT_GRAPH_CHECK_INVALID"
              ? "확인 기록의 모양이나 내용 주소가 맞지 않는다"
              : "확인 기록으로 읽지 못했다",
      });
    }
  }
  const documents = [];
  for (const file of read.files) {
    if (!["document", "policy", "meaning"].includes(file.role)) continue;
    const text = decodeProductGraphText(file.bytes);
    const base = { path: file.path, text };
    let parsed;
    if (file.role === "meaning") parsed = parseMeaningFile(base);
    else if (file.role === "policy") parsed = parsePolicyFile(base);
    else if (file.nodeType === "화면") parsed = parseScreenDocument({ ...base, id: file.id });
    else if (file.nodeType === "유저 활동") parsed = parseActivityDocument({ ...base, id: file.id });
    else if (file.nodeType === "유저저니") parsed = parseJourneyDocument(base);
    else if (file.nodeType === "IA") parsed = parseIaDocument(base);
    else parsed = parseCoreDocument(base);
    const approvalDigest = file.approvable ? productGraphApprovalDigest(file.bytes) : null;
    const approved = file.approvable ? Boolean(approvals.get(file.path)?.has(approvalDigest)) : null;
    const changedAfterApproval = file.approvable && !approved && approvals.has(file.path);
    documents.push({
      path: file.path,
      role: file.role,
      nodeType: file.nodeType,
      id: file.id || null,
      sha256: file.sha256,
      approvalDigest,
      approvable: Boolean(file.approvable),
      status: file.approvable ? (approved ? "승인" : changedAfterApproval ? "승인 뒤 바뀜" : "추정") : "직접 씀",
      estimateKind: approved || !file.approvable ? null : parsed.estimate?.kind || null,
      estimateWritten: parsed.estimate?.written ?? null,
      parsed,
    });
  }
  checkIssues.sort((a, b) => compare(a.path, b.path));
  return {
    documents,
    unrecognized: read.unrecognized,
    twins: read.twins,
    approvalIssues,
    approvalsRead: inputs.approvals,
    checkRecords,
    checkIssues,
    checkListingSha256: read.checkListingSha256,
    checkRecordLimit: read.recordLimit,
    ...loadRunRecords(inputs, read),
  };
}

// Run records (project mode only, like 확인 records). One that does not
// verify is an issue naming its file and gives no evidence.
function loadRunRecords(inputs, read) {
  const runRecords = [];
  const runIssues = inputs.approvals ? [...(read.runIssues || [])] : [];
  for (const file of read.runFiles || []) {
    if (!inputs.approvals) continue;
    try {
      runRecords.push(verifyProductGraphRun(JSON.parse(decodeProductGraphText(file.bytes)), { projectId: inputs.projectId, runId: file.runId }));
    } catch (error) {
      const code = error.code || "PRODUCT_GRAPH_RUN_INVALID";
      runIssues.push({
        path: file.path,
        code,
        reason:
          code === "PRODUCT_GRAPH_RUN_PROJECT_MISMATCH"
            ? "다른 프로젝트의 실행 기록이다"
            : code === "PRODUCT_GRAPH_RUN_INVALID"
              ? "실행 기록의 모양이나 내용 주소가 맞지 않는다"
              : "실행 기록으로 읽지 못했다",
      });
    }
  }
  runIssues.sort((a, b) => compare(a.path, b.path));
  return { runRecords, runIssues, runListingSha256: read.runListingSha256 ?? null, runRecordLimit: read.runRecordLimit ?? null };
}

// A document is used as the product description only while 승인. One whose
// text changed after approval is an estimate again and keeps its kind.
const isEstimate = (document) => document.status === "추정" || document.status === "승인 뒤 바뀜";

function basisLabel(document) {
  if (!isEstimate(document)) return null;
  const kind = document.estimateKind ? `추정: ${document.estimateKind}` : "추정: 어느 쪽 추정인지 적지 않음";
  return document.status === "승인 뒤 바뀜" ? `${kind}, 승인 뒤 바뀜` : kind;
}

function absence(documents, nodeType, includeEstimates) {
  const name = DOCUMENT_NAMES[nodeType];
  const all = documents.filter((item) => item.nodeType === nodeType && item.role !== "meaning");
  if (!all.length) return `${SUBJECT[name]} 없다`;
  if (!includeEstimates && all.every(isEstimate)) return `승인된 ${SUBJECT[name]} 없다 (추정 ${all.length}개는 기본 검사에 쓰지 않는다)`;
  return null;
}

function compute({ extraction, loaded, includeEstimates }) {
  const { documents } = loaded;
  const used = (document) => !isEstimate(document) || includeEstimates;
  const ofType = (nodeType, onlyUsed = true) => documents.filter((item) => item.nodeType === nodeType && item.role !== "meaning" && (!onlyUsed || used(item)));
  const screens = ofType("화면"),
    activities = ofType("유저 활동"),
    allScreens = ofType("화면", false),
    allActivities = ofType("유저 활동", false);
  const policyDocument = documents.find((item) => item.role === "policy") || null;
  const journeyDocument = documents.find((item) => item.nodeType === "유저저니") || null;
  const coreDocument = documents.find((item) => item.nodeType === "제품코어") || null;
  const iaDocument = documents.find((item) => item.nodeType === "IA") || null;
  const meaningDocument = documents.find((item) => item.role === "meaning") || null;
  const functionIds = new Set(extraction.functionNodes.map((item) => item.id));
  const codeIds = new Set(extraction.codeNodes.map((item) => item.id));
  const elementOwner = new Map(),
    allElementOwner = new Map();
  for (const screen of allScreens) for (const element of screen.parsed.elements) allElementOwner.set(element.id, screen);
  for (const screen of screens) for (const element of screen.parsed.elements) elementOwner.set(element.id, screen);
  const screenIds = new Set(screens.map((item) => item.id)),
    allScreenIds = new Set(allScreens.map((item) => item.id));
  const activityIds = new Set(activities.map((item) => item.id)),
    allActivityIds = new Set(allActivities.map((item) => item.id));
  const policyUsed = policyDocument && used(policyDocument);
  const policies = new Map(policyUsed ? policyDocument.parsed.policies.map((item) => [item.id, item]) : []);
  const allPolicies = new Map(policyDocument ? policyDocument.parsed.policies.map((item) => [item.id, item]) : []);
  const labelsFor = (...items) => [...new Set(items.filter(Boolean).map(basisLabel).filter(Boolean))];

  // Cited IDs that do not exist.
  const missing = [];
  const cite = (kind, id, citedBy, exists, existsInEstimate, basis) => {
    if (exists) return;
    missing.push({ kind, id, at: citedBy, note: existsInEstimate ? "추정 문서에만 있음" : null, labels: labelsFor(basis) });
  };
  for (const screen of screens) {
    for (const element of screen.parsed.elements) {
      for (const id of element.operates) cite("화면요소가 가리키는 기능", id, { path: screen.path, line: element.line }, functionIds.has(id), false, screen);
      for (const id of element.shows) cite("화면요소가 가리키는 기능", id, { path: screen.path, line: element.line }, functionIds.has(id), false, screen);
    }
    for (const area of screen.parsed.commonAreas)
      cite("공통 영역으로 적은 화면", area.id, { path: screen.path, line: area.line }, screenIds.has(area.id), allScreenIds.has(area.id), screen);
    for (const draw of screen.parsed.drawsCode) {
      const ref = draw.ref.replace(/:[0-9]+$/, "");
      cite("그리는 코드로 적은 코드", draw.ref, { path: screen.path, line: draw.line }, codeIds.has(ref), false, screen);
    }
    for (const policy of screen.parsed.policies)
      if (policyDocument)
        cite("화면 정책 절이 가리키는 정책", policy.id, { path: screen.path, line: policy.line }, policies.has(policy.id), allPolicies.has(policy.id), screen);
      else cite("화면 정책 절이 가리키는 정책", policy.id, { path: screen.path, line: policy.line }, false, false, screen);
  }
  for (const activity of activities) {
    for (const step of activity.parsed.steps) {
      for (const id of step.elements)
        cite("차례가 가리키는 화면요소", id, { path: activity.path, line: step.line }, elementOwner.has(id), allElementOwner.has(id), activity);
      for (const id of step.screens)
        cite("차례가 가리키는 화면", id, { path: activity.path, line: step.line }, screenIds.has(id), allScreenIds.has(id), activity);
    }
    for (const next of activity.parsed.next)
      cite(
        "다음 활동이 가리키는 유저 활동",
        next.id,
        { path: activity.path, line: next.line },
        activityIds.has(next.id),
        allActivityIds.has(next.id),
        activity,
      );
  }
  if (policyUsed)
    for (const policy of policyDocument.parsed.policies)
      for (const id of policy.functions)
        cite("정책이 가리키는 기능", id, { path: policyDocument.path, line: policy.line }, functionIds.has(id), false, policyDocument);
  // A 뜻 line whose 기능 no longer exists is kept as written and listed, so a
  // person can re-attach it to a renamed 기능. It is not an error.
  const vanishedMeanings = meaningDocument
    ? meaningDocument.parsed.meanings
        .filter((meaning) => !functionIds.has(meaning.id))
        .map((meaning) => ({ id: meaning.id, text: meaning.text, at: { path: meaningDocument.path, line: meaning.line } }))
    : [];
  if (journeyDocument && used(journeyDocument))
    for (const stage of journeyDocument.parsed.stages)
      for (const item of stage.activities)
        cite(
          "유저 저니맵이 가리키는 유저 활동",
          item.id,
          { path: journeyDocument.path, line: item.line },
          activityIds.has(item.id),
          allActivityIds.has(item.id),
          journeyDocument,
        );
  if (iaDocument && used(iaDocument))
    for (const item of iaDocument.parsed.screens)
      cite("IA 문서가 가리키는 화면", item.id, { path: iaDocument.path, line: item.line }, screenIds.has(item.id), allScreenIds.has(item.id), iaDocument);

  // 화면 → 기능: 기능 that run by themselves (@effect) in the class the 화면
  // cites as its drawing code.
  const screenFunctions = new Map();
  for (const screen of screens)
    for (const draw of screen.parsed.drawsCode) {
      const [file, symbol] = draw.ref.replace(/:[0-9]+$/, "").split("#");
      if (!symbol) continue;
      const prefix = `fe/${file.replace(/\.[^./]+$/, "")}/${symbol}@effect:`;
      for (const id of functionIds) if (id.startsWith(prefix)) screenFunctions.set(id, screen);
    }

  const checks = [];
  const result = (check, outcome) => checks.push({ ...check, ...outcome });

  // 1. 제품코어와 부딪히는 정책 — not decided by machine.
  {
    const reasons = [absence(documents, "제품코어", includeEstimates), absence(documents, "정책", includeEstimates)].filter(Boolean);
    result(CHECKS[0], {
      outcome: "검사 못 함",
      reason: reasons.length ? reasons.join(", ") : "기계로 정하지 않는다. 아래 제품코어와 정책을 사람이 나란히 읽고 판단한다",
      sideBySide: reasons.length
        ? null
        : {
            제품코어: coreDocument.parsed.parts,
            정책: [...policies.values()].map(({ id, kind, 조건, 주체, 행위 }) => ({ id, kind, 조건, 주체, 행위 })),
            labels: labelsFor(coreDocument, policyDocument),
          },
    });
  }
  // 2. 화면요소 → 기능 without a 유저 활동.
  {
    const reason = absence(documents, "화면", includeEstimates) || absence(documents, "유저 활동", includeEstimates);
    if (reason) result(CHECKS[1], { outcome: "검사 못 함", reason });
    else {
      const cited = new Map();
      for (const activity of activities) for (const step of activity.parsed.steps) for (const id of step.elements) cited.set(id, activity);
      const compared = [],
        findings = [];
      for (const screen of screens)
        for (const element of screen.parsed.elements) {
          if (!element.operates.length) continue;
          compared.push(element.id);
          if (!cited.has(element.id))
            findings.push({ id: element.id, functions: element.operates, at: { path: screen.path, line: element.line }, labels: labelsFor(screen) });
        }
      if (!compared.length) result(CHECKS[1], { outcome: "검사 못 함", reason: "조작하면 실행되는 기능이 적힌 화면요소가 없다" });
      else result(CHECKS[1], findings.length ? { outcome: "findings", findings } : { outcome: "0건", compared: compared.length });
    }
  }
  // 3. navigate — not extracted in this bundle.
  result(CHECKS[2], { outcome: "검사 못 함", reason: "navigate 연결을 뽑지 않음" });
  // 4. 화면 no 유저 활동 points to.
  {
    const reason = absence(documents, "화면", includeEstimates) || absence(documents, "유저 활동", includeEstimates);
    if (reason) result(CHECKS[3], { outcome: "검사 못 함", reason });
    else {
      const pointed = new Set();
      for (const activity of activities)
        for (const step of activity.parsed.steps) {
          for (const id of step.elements) pointed.add(id.split("#")[0]);
          for (const id of step.screens) pointed.add(id);
        }
      const findings = screens
        .filter((screen) => !pointed.has(screen.id))
        .map((screen) => ({ id: screen.id, name: screen.parsed.name, at: { path: screen.path, line: screen.parsed.line }, labels: labelsFor(screen) }));
      result(CHECKS[3], findings.length ? { outcome: "findings", findings } : { outcome: "0건", compared: screens.length });
    }
  }
  // 5. 화면 정책 절 vs 정책 노드, by 정책 ID.
  {
    const reason = absence(documents, "정책", includeEstimates) || absence(documents, "화면", includeEstimates);
    if (reason) result(CHECKS[4], { outcome: "검사 못 함", reason });
    else {
      let compared = 0;
      const findings = [];
      for (const screen of screens)
        for (const row of screen.parsed.policies) {
          const node = policies.get(row.id);
          if (!node) continue;
          compared += 1;
          const differences = [];
          for (const field of ["조건", "주체", "행위"])
            if (row[field] && row[field] !== node[field]) differences.push({ field, screen: row[field], policy: node[field] });
          if (node.kind === "처리") differences.push({ field: "종류", screen: "표시 정책 자리(화면 정책 절)", policy: "처리" });
          if (differences.length)
            findings.push({
              id: row.id,
              screen: screen.id,
              differences,
              at: { path: screen.path, line: row.line },
              policyAt: { path: policyDocument.path, line: node.line },
              labels: labelsFor(screen, policyDocument),
            });
        }
      if (!compared) result(CHECKS[4], { outcome: "검사 못 함", reason: "화면 정책 절에 정책 파일에 있는 정책 ID가 하나도 없다" });
      else result(CHECKS[4], findings.length ? { outcome: "findings", findings } : { outcome: "0건", compared });
    }
  }
  // 6. 다음 활동 vs 유저저니 order.
  {
    let reason = absence(documents, "유저저니", includeEstimates) || absence(documents, "유저 활동", includeEstimates);
    if (!reason && !journeyDocument.parsed.hasActivityIds) reason = "유저 저니맵이 단계마다 유저 활동 ID를 적지 않았다";
    const pairs = [];
    if (!reason) for (const activity of activities) for (const next of activity.parsed.next) if (activityIds.has(next.id)) pairs.push({ activity, next });
    if (!reason && !pairs.length) reason = "다음 활동이 적힌 유저 활동이 없다";
    if (reason) result(CHECKS[5], { outcome: "검사 못 함", reason });
    else {
      const stagesOf = new Map();
      journeyDocument.parsed.stages.forEach((stage, index) => {
        for (const item of stage.activities) {
          if (!stagesOf.has(item.id)) stagesOf.set(item.id, []);
          stagesOf.get(item.id).push(index);
        }
      });
      const findings = [];
      for (const { activity, next } of pairs) {
        const from = stagesOf.get(activity.id),
          to = stagesOf.get(next.id);
        const labels = labelsFor(activity, journeyDocument);
        if (!from || !to)
          findings.push({
            id: activity.id,
            next: next.id,
            problem: `유저 저니맵 단계에 없는 활동: ${[!from ? activity.id : null, !to ? next.id : null].filter(Boolean).join(", ")}`,
            at: { path: activity.path, line: next.line },
            labels,
          });
        else if (Math.max(...to) < Math.min(...from))
          findings.push({
            id: activity.id,
            next: next.id,
            problem: `다음 활동이 유저 저니맵에서 앞 단계(${journeyDocument.parsed.stages[Math.max(...to)].name})에 있다`,
            at: { path: activity.path, line: next.line },
            labels,
          });
      }
      result(CHECKS[5], findings.length ? { outcome: "findings", findings } : { outcome: "0건", compared: pairs.length });
    }
  }

  // First-run guide: each missing input, what it unlocks and what to do next.
  const guide = [];
  const GUIDE_INPUTS = [
    ["제품코어", "제품 정의서.md", ["검사 1"]],
    ["유저저니", "유저 저니맵.md", ["검사 6"]],
    ["화면", "화면설계서/<화면 ID>.md", ["검사 2", "검사 4", "검사 5", "목록: 어떤 화면요소·화면도 가리키지 않는 기능"]],
    ["유저 활동", "유저플로우 기획서/<유저 활동 ID>.md", ["검사 2", "검사 4", "검사 6"]],
    ["정책", "정책.md", ["검사 1", "검사 5"]],
  ];
  for (const [nodeType, file, unlocks] of GUIDE_INPUTS) {
    const reason = absence(documents, nodeType, includeEstimates);
    if (!reason) continue;
    const unapproved = reason.startsWith("승인된");
    guide.push({
      input: DOCUMENT_NAMES[nodeType],
      state: unapproved ? "승인 안 됨" : "없음",
      reason,
      unlocks,
      next: unapproved
        ? loaded.approvalsRead
          ? "사용자에게 지금 내용을 보여 주고, 검사가 보여 주는 digest로 승인을 기록한다 (product-graph-approve)"
          : "독립 실행은 승인 기록을 읽지 않는다. 추정 문서까지 쓰려면 --include-estimates로 검사한다"
        : loaded.approvalsRead
          ? `${file}를 쓰고 → 검사(product-graph-check) → 사용자가 읽은 뒤 승인(product-graph-approve)`
          : `${file}를 쓰고 → --include-estimates로 검사한다 (승인은 Lode 프로젝트에서만 센다)`,
    });
  }
  const pointedFunctions = new Set(screenFunctions.keys());
  for (const screen of screens) for (const element of screen.parsed.elements) for (const id of element.operates) pointedFunctions.add(id);
  const unpointed = extraction.functionNodes.filter((item) => !pointedFunctions.has(item.id)).map((item) => item.id);
  const approvable = documents.filter((item) => item.approvable);
  const counts = {};
  for (const type of NODE_TYPES) counts[type] = NOT_EXTRACTED.includes(type) ? "뽑지 않음" : 0;
  counts["제품코어"] = coreDocument ? 1 : 0;
  counts["유저저니"] = journeyDocument ? 1 : 0;
  counts["IA"] = iaDocument ? 1 : 0;
  counts["유저 활동"] = allActivities.length;
  counts["화면"] = allScreens.length;
  counts["화면요소"] = allElementOwner.size;
  counts["정책"] = allPolicies.size;
  counts["기능"] = extraction.functionNodes.length;
  counts["코드"] = extraction.codeNodes.length;
  for (const type of ["데이터", "외부 연결", "DB"]) counts[type] = (extraction.outsideNodes || []).filter((node) => node.type === type).length;
  const usedCounts = {
    "유저 활동": activities.length,
    화면: screens.length,
    화면요소: elementOwner.size,
    정책: policies.size,
  };
  const formatIssues = [];
  for (const document of documents)
    for (const issue of document.parsed.issues || []) formatIssues.push({ path: document.path, line: issue.line, kind: issue.kind, detail: issue.detail });
  for (const twin of loaded.twins || [])
    formatIssues.push({ path: twin, line: 1, kind: "유니코드 정규화만 다른 같은 이름이 둘 이상 (둘 다 읽지 않음)", detail: twin });
  const elementSeen = new Map();
  for (const screen of allScreens)
    for (const element of screen.parsed.elements) {
      if (elementSeen.has(element.id))
        formatIssues.push({
          path: screen.path,
          line: element.line,
          kind: "같은 화면요소 ID가 두 번",
          detail: `${element.id} (처음: ${elementSeen.get(element.id)})`,
        });
      else elementSeen.set(element.id, `${screen.path}:${element.line}`);
    }
  for (const document of documents)
    if (isEstimate(document) && document.estimateWritten && !document.estimateKind)
      formatIssues.push({ path: document.path, line: 1, kind: "추정 종류를 읽지 못함", detail: document.estimateWritten });

  return {
    screens,
    activities,
    allScreens,
    allActivities,
    policyDocument,
    journeyDocument,
    coreDocument,
    iaDocument,
    meaningDocument,
    screenFunctions,
    elementOwner: allElementOwner,
    checks,
    guide,
    lists: {
      missingIds: missing.sort((a, b) => compare(a.at.path, b.at.path) || a.at.line - b.at.line || compare(a.id, b.id)),
      unpointedFunctions: unpointed,
      // Only meaningful against 화면설계서: without any in use the list is a
      // count and a reason, not every 기능 of the product.
      unpointedFunctionsReason: absence(documents, "화면", includeEstimates),
      vanishedMeanings,
      unreachedCode: extraction.unreachedCode,
      unresolvedReferences: {
        all: extraction.referenceSummary.allCalls,
        resolved: extraction.referenceSummary.resolvedCalls,
        unresolved: extraction.referenceSummary.unresolvedCalls,
        byReason: extraction.referenceSummary.unresolvedByReason,
      },
      notLookedAt: extraction.notLookedAt,
      unresolvedHandlers: extraction.unresolvedHandlers,
      multiRowFunctions: extraction.multiRowFunctions,
      partlyResolvedRows: extraction.partlyResolvedRows,
      notTakenBindings: extraction.notTakenBindings,
      uiWithoutRule: extraction.uiWithoutRule,
      outOfScope: extraction.outOfScope,
      ruleIssues: extraction.ruleIssues,
      // framework-invoked as read (2.2): every site, and the paths more than one file matched.
      runByPath: extraction.runByPath,
      // 분기 matches whose branch block could not be delimited (2.9).
      branchUndelimited: extraction.branchUndelimited || [],
      // Outside calls no 바깥 rule names, and named 데이터 calls neither read nor write (2.8).
      outside: extraction.outside?.lists || null,
      formatIssues: formatIssues.sort((a, b) => compare(a.path, b.path) || a.line - b.line),
      unrecognizedFiles: loaded.unrecognized,
      approvalIssues: loaded.approvalIssues,
    },
    counts,
    usedCounts,
    documentSummary: {
      approved: approvable.filter((item) => item.status === "승인").length,
      changedAfterApproval: approvable.filter((item) => item.status === "승인 뒤 바뀜").length,
      estimated: approvable.filter((item) => item.status === "추정").length,
      list: approvable.map(({ path: documentPath, nodeType, id, approvalDigest, status, estimateKind }) => ({
        path: documentPath,
        nodeType,
        id,
        approvalDigest,
        status,
        estimateKind,
      })),
    },
  };
}

function graphDocument({ extraction, loaded, computed, inputs, rules, result }) {
  const nodes = [];
  const edges = [];
  const basisOf = (document) => (document ? { path: document.path, status: document.status, estimateKind: document.estimateKind } : null);
  const meaning = new Map((computed.meaningDocument?.parsed.meanings || []).map((item) => [item.id, item.text]));
  if (computed.coreDocument)
    nodes.push({
      id: "제품코어",
      type: "제품코어",
      basis: basisOf(computed.coreDocument),
      parts: computed.coreDocument.parsed.parts.map(({ heading, line }) => ({ heading, line })),
    });
  if (computed.journeyDocument)
    nodes.push({
      id: "유저저니",
      type: "유저저니",
      basis: basisOf(computed.journeyDocument),
      stages: computed.journeyDocument.parsed.stages.map(({ name, line, activities }) => ({ name, line, activities: activities.map((item) => item.id) })),
    });
  if (computed.iaDocument)
    nodes.push({
      id: "IA",
      type: "IA",
      basis: basisOf(computed.iaDocument),
      screens: computed.iaDocument.parsed.screens.map(({ id, group }) => ({ id, group })),
    });
  for (const activity of computed.allActivities) {
    nodes.push({
      id: activity.id,
      type: "유저 활동",
      oneLine: activity.parsed.oneLine,
      at: { path: activity.path, line: activity.parsed.line },
      basis: basisOf(activity),
    });
    for (const step of activity.parsed.steps)
      for (const id of step.elements)
        edges.push({ type: "유저 활동→화면요소", from: activity.id, to: id, at: { path: activity.path, line: step.line }, basis: basisOf(activity) });
    for (const next of activity.parsed.next)
      edges.push({ type: "유저 활동→유저 활동", from: activity.id, to: next.id, at: { path: activity.path, line: next.line }, basis: basisOf(activity) });
  }
  for (const screen of computed.allScreens) {
    nodes.push({
      id: screen.id,
      type: "화면",
      name: screen.parsed.name,
      group: screen.parsed.group,
      at: { path: screen.path, line: screen.parsed.line },
      basis: basisOf(screen),
    });
    for (const area of screen.parsed.commonAreas)
      edges.push({ type: "화면→화면", from: screen.id, to: area.id, at: { path: screen.path, line: area.line }, basis: basisOf(screen) });
    for (const draw of screen.parsed.drawsCode)
      edges.push({
        type: "화면→코드",
        from: screen.id,
        to: draw.ref.replace(/:[0-9]+$/, ""),
        at: { path: screen.path, line: draw.line },
        basis: basisOf(screen),
      });
    for (const policy of screen.parsed.policies)
      edges.push({ type: "화면→정책", from: screen.id, to: policy.id, at: { path: screen.path, line: policy.line }, basis: basisOf(screen) });
    for (const element of screen.parsed.elements) {
      nodes.push({
        id: element.id,
        type: "화면요소",
        oneLine: element.oneLine,
        location: element.location,
        at: { path: screen.path, line: element.line },
        basis: basisOf(screen),
      });
      edges.push({ type: "화면→화면요소", from: screen.id, to: element.id, at: { path: screen.path, line: element.line }, basis: basisOf(screen) });
      if (element.parent)
        edges.push({ type: "화면요소→화면요소", from: element.parent, to: element.id, at: { path: screen.path, line: element.line }, basis: basisOf(screen) });
      for (const id of element.operates)
        edges.push({ type: "화면요소→기능", from: element.id, to: id, at: { path: screen.path, line: element.line }, basis: basisOf(screen) });
      for (const id of element.shows)
        edges.push({ type: "기능→화면요소", from: id, to: element.id, at: { path: screen.path, line: element.line }, basis: basisOf(screen) });
    }
  }
  for (const [id, screen] of computed.screenFunctions)
    edges.push({ type: "화면→기능", from: screen.id, to: id, at: null, basis: basisOf(screen), derivedFrom: "화면→코드 클래스의 @effect 기능" });
  if (computed.policyDocument)
    for (const policy of computed.policyDocument.parsed.policies) {
      nodes.push({
        id: policy.id,
        type: "정책",
        kind: policy.kind,
        조건: policy.조건,
        주체: policy.주체,
        행위: policy.행위,
        at: { path: computed.policyDocument.path, line: policy.line },
        basis: basisOf(computed.policyDocument),
      });
      for (const id of policy.functions)
        edges.push({
          type: "정책→기능",
          from: policy.id,
          to: id,
          at: { path: computed.policyDocument.path, line: policy.line },
          basis: basisOf(computed.policyDocument),
        });
    }
  for (const entry of extraction.functionNodes) {
    nodes.push({ id: entry.id, type: "기능", kind: entry.kind, oneLine: meaning.get(entry.id) || "", handling: entry.handling, positions: entry.positions });
    for (const handler of entry.handlers)
      edges.push({
        type: "기능→코드",
        from: entry.id,
        to: handler,
        역할: "처리",
        at: entry.handlerAt?.[handler] || entry.positions[0] || null,
        // 분기 (2.9): the lines of the shared handler this 기능 passes.
        ...(entry.handlerRanges?.[handler] ? { 줄: entry.handlerRanges[handler] } : {}),
      });
    // 입구: code the 기능 passes through that is not its handler (a rule says so).
    for (const code of entry.entries || []) edges.push({ type: "기능→코드", from: entry.id, to: code, 역할: "입구", at: entry.positions[0] || null });
  }
  for (const node of extraction.codeNodes) nodes.push(node);
  for (const node of extraction.outsideNodes || []) nodes.push(node);
  const branchHandlers = new Set(extraction.branchHandlers || []);
  for (const reference of extraction.references)
    edges.push({
      type: reference.type,
      from: reference.from,
      to: reference.to,
      at: reference.source,
      count: reference.count,
      // Written by hand (2.4): a judgement, and what the rule says.
      ...(reference.judgement ? { judgement: true } : {}),
      ...(reference.설명 ? { 설명: reference.설명 } : {}),
      // Every line it occurs on, from a handler a 분기 rule splits (2.9).
      ...(branchHandlers.has(reference.from) && reference.allLines?.size > 1 ? { lines: [...reference.allLines].sort((a, b) => a - b) } : {}),
    });
  // A 화면요소 or 정책 ID written twice in the documents is a 형식 문제
  // (listed by the check); the graph keeps its first occurrence.
  const kept = new Set();
  const unique = nodes.filter((node) => {
    if (!["화면요소", "정책"].includes(node.type)) return true;
    const key = `${node.type}\0${node.id}`;
    if (kept.has(key)) return false;
    kept.add(key);
    return true;
  });
  nodes.length = 0;
  nodes.push(...unique);
  assertUniqueIds(nodes);
  const typeOrder = new Map(NODE_TYPES.map((type, index) => [type, index]));
  nodes.sort((a, b) => typeOrder.get(a.type) - typeOrder.get(b.type) || compare(a.id, b.id));
  edges.sort(
    (a, b) =>
      compare(a.type, b.type) ||
      compare(a.from, b.from) ||
      compare(a.to, b.to) ||
      compare(a.at?.path || "", b.at?.path || "") ||
      (a.at?.line || 0) - (b.at?.line || 0),
  );
  const graph = {
    schemaVersion: 1,
    kind: "LodeProductGraph",
    generator: { name: "lode-product-graph", version: PRODUCT_GRAPH_VERSION },
    model: "원본 제품 그래프 정의(Won6314/head-agent-core graph/build/02a-graph-definitions.md)를 그대로 쓴다",
    derived: true,
    inputs: {
      mode: inputs.mode === "project" ? "프로젝트" : "독립 실행",
      documents: loaded.documents.map(({ path: documentPath, sha256, status }) => ({ path: documentPath, sha256, status })),
      rulesSha256: rules.sha256,
      approvalsRead: loaded.approvalsRead,
      // Every source file the build read, with the hash of its normalised
      // text, so a reader can tell whether the source moved since.
      sourceFiles: [...extraction.readFiles.entries()]
        .map(([file, text]) => ({ path: file, sha256: sourceTextHash(text) }))
        .sort((a, b) => compare(a.path, b.path)),
      reader: productGraphReader(PRODUCT_GRAPH_VERSION),
      codeFiles: extraction.codeFiles,
      sourceExcludes: extraction.excludes,
    },
    nodeTypes: NODE_TYPES.map((type) => ({ type, count: computed.counts[type] })),
    limits: result.limits,
    rules: extraction.rules,
    referenceSummary: extraction.referenceSummary,
    unreachedCode: extraction.unreachedCode,
    notLookedAt: extraction.notLookedAt,
    nodes,
    edges,
  };
  return addContentHashes(graph, extraction.readFiles, extraction.unresolvedHandlers);
}

// ---------- readable text ----------

// check.txt. Its parts are rendered by the walk module the page and
// product-graph-query share, so the page shows the build's own lines.
export function renderProductGraphText(result) {
  const nodeTypes = NODE_TYPES;
  return (
    [
      ...walk.renderLimits(result.limits),
      "",
      ...walk.renderChanges(result.changes),
      ...walk.renderConfirmations(result.confirmations),
      ...walk.renderGuide(result.guide),
      ...walk.renderChecks(result.checks),
      ...walk.renderGapLists(walk.gapLists(result, nodeTypes)),
    ].join("\n") + "\n"
  );
}

// ---------- what this graph cannot answer ----------

export const LIMITS_TITLE = "이 그래프가 답하지 못하는 것";
const NOT_TOLD_APART = Object.freeze(["render", "type reference", "re-render", "response", "enqueue", "navigate", "http", "defines"]);
// The shapes of framework-invoked this reading sees, and what it still does not.
const RUN_BY_PATH_LIMITS =
  "framework-invoked는 두 모양만 읽는다: 코드의 문자열·템플릿 리터럴이 스캔한 코드 파일 하나의 경로(전체 상대 경로, 또는 / 경계에서 시작하는 그 뒷부분)로 끝나고 그 글자를 실행·적재하는 호출에 넘기는 곳(동적 import, spawn·fork·exec 같은 프로세스 시작, Worker, 언어의 실행 파일(process.execPath, sys.executable)도 함께 넘기는 호출. 경로를 만드는 join·resolve·URL과 배열·객체는 건너 본다. 공백이 있는 글자는 명령 줄이라, 그 경로는 프로그램 자체이거나 언어 실행기(node, python 같은 것) 뒤의 스크립트일 때만 센다), 그리고 이름 없이 들여오는 JS·TS import \"<상대 경로>\". 경로가 여러 파일에 맞으면 잇지 않고 센다. 경로를 상수에 담아 뒤에서 넘기는 곳, import·export·require의 경로, 주입, 데코레이터, 파일 이름으로 정하는 경로는 보지 못한다. 읽은 곳은 모두 '경로로 실행으로 읽은 곳'에 적는다.";
const ENTRY_STOP_RULE =
  "닿는 범위는 처리 코드와 입구 둘 다에서 시작하고, 입구에서 걷는 길은 다른 기능의 처리 코드인 노드 앞에서 멈춘다(그 노드만. 멈춘 곳은 답마다 센다). 그래서 분배 코드가 한 기능의 처리 코드를 다른 기능들의 공통 단계로 정말 부르면 그 길은 보이지 않는다.";
const OUTSIDE_LIMITS =
  '환경 변수는 process.env.NAME, process.env["NAME"], os.environ["NAME"], os.environ.get("NAME"), os.getenv("NAME")만 읽어 데이터 data:env:NAME을 읽는 연결로 적고, 대입이나 delete는 쓰는 연결로 적는다. const { NAME } = process.env는 꺼내는 이름마다 읽음이다. 환경 객체를 다른 이름에 담아 넘기면 따라가지 않는다. 바깥 모듈 표(JS: fs, fs/promises, net, http, https, dgram, tls, child_process, readline. Python: 내장 open, os, shutil, pathlib, subprocess, socket, sqlite3, urllib, http.client. 바깥 규칙이 적은 모듈도 더한다)에서 들여온 이름으로 부른 호출은 사실로 적고, 프로젝트가 바깥 규칙으로 맞은편을 이름 붙인 것만 연결이 된다. 짐작하지 않는다. SQL은 동사가 제자리에서 이름을 받는 문자열만 읽는다: 읽기(FROM·JOIN <이름>)나 쓰기(INSERT INTO·REPLACE INTO <이름>, UPDATE <이름> … SET, DELETE FROM <이름>). 그런 문자열은 모두 SQL로 읽은 곳에 적고, 아는 표면 잇고, CREATE TABLE이 만들지 않은 이름은 표를 모름으로 적는다. 동사 낱말만 있는 문자열은 SQL로 보지 않는다. 표는 코드 문자열이나 .sql 파일의 CREATE TABLE로 만든 것만 보고, 다른 방법으로 만든 표는 보지 못한다. 표와 데이터의 뜻 줄은 없다.';
const VALUE_USE_LIMITS =
  '부르지 않고 넘기거나 담은 이름(.map(f), { run }, process.on("x", f), 기본값 = f)이 호출과 같은 규칙(안쪽 선언, 같은 파일, import, 다시 내보내기)으로 함수·클래스 선언 하나로 풀린 곳이 callback 연결이 된다. 멤버는 호출이 풀리는 곳에서만 푼다: 클래스 안 this.x·self.x, 제품 클래스의 C.x(JS는 static), 모듈 수준 객체 리터럴이나 namespace import의 name.x. 매개변수·지역 변수에 담긴 이름, 이름이 제품에 하나뿐이라는 이유로는 풀지 않는다. 선언·import·export 목록·속성 이름·점 뒤 멤버는 쓰임으로 세지 않고, TypeScript의 타입 자리(:, satisfies 뒤)와 <…> 안, 데코레이터는 읽지 않는다.';
const UI_SCAN_LIMITS = Object.freeze([
  "UI 연결은 패턴을 글자에 맞춰 찾는다. 여러 줄에 걸친 연결, 문자열로 만든 연결, 툴킷이 이름으로 자동으로 잇는 연결, 이벤트 이름을 실행 중에 계산하는 연결은 보지 못한다.",
  "코드인지는 글자 단위 lexer로 가린다. JS·TS·Python 파일에서는 주석과 문자열(여러 줄 문자열과 템플릿 문자열 포함) 안의 연결을 걸러내고, HTML·Vue·Svelte 파일에서는 <!-- --> 주석만 걸러낸다. JSX의 on<Event>={…} 속성은 주석과 문자열을 가리지 않는다. lexer는 파서가 아니어서 정규식 리터럴을 바로 앞 글자로만 알아본다.",
  "템플릿의 같은 태그 id는 가장 가까운 < 와 > 사이에서 찾는다. 이벤트 메서드는 이름으로만 찾고 상속은 확인하지 않는다.",
]);

const TABLE_ROW_LIMITS =
  "처리 코드를 표 항목에서 찾는 규칙은 맞은 곳을 감싼 리스트·객체·딕셔너리의 원소(그런 것이 없으면 그 문장, 데코레이터 줄이면 꾸미는 정의(스캔이 그 정의를 선언으로 가질 때만))를 함수 본문처럼 읽는다: 값으로 쓴 함수 이름, 항목 안 함수의 호출, 경로를 글자로 쓴 동적 import에서 같은 식으로 꺼낸 이름. 한 항목에서 나온 기능 둘은 그 항목의 처리 코드를 함께 쓴다. Python의 동적 import(importlib)는 읽지 않는다.";

// How calls are resolved beyond plain names (call precision, approved
// 2026-11-15). Each is a stated limit of the lexical reading.
const CALL_READING_LIMITS = Object.freeze([
  '멤버 선언: JS·TS 클래스 본문의 메서드와 함수를 담은 클래스 필드(<클래스>.<멤버>), 이름에 묶은 클래스 식(const A = class {)과 이름 없는 default 클래스(default)의 멤버, 모듈 수준 이름에 묶인 객체 리터럴의 함수 멤버(<이름>.<멤버>)가 선언이다. 중첩된 객체 리터럴, 이름에 묶이지 않은 리터럴, 따옴표나 계산한 이름([Symbol.iterator]() {, "이름"() {)은 선언이 아니다. 메서드를 정의하는 자리(name(…) {)와 본문 없는 TypeScript 시그니처(abstract run(): void;, 오버로드, interface 멤버)는 호출로 세지 않는다.',
  "받는 쪽은 글자로만 정한다: 클래스 안(필드 포함)의 this.x(·self.x(, 클래스 이름의 C.x((JS는 static 메서드), 객체 리터럴 이름의 name.x(, 같은 함수나 모듈 수준에서 한 번 new C(…)(Python은 C(…))로 만든 const의 v.x(, Python classmethod 안의 cls(…)(그 클래스). 다시 대입하는 변수는 추론하지 않고, 상속은 따라가지 않으며(상속받았거나 본문 없는 선언만 있는 멤버일 수 있음), 이름이 제품에 하나뿐이라는 이유로 정하지 않는다.",
  "new C(…)는 C를 부르는 참조로 센다(클래스에 닿으면 생성자에 닿는다). 내장 클래스나 제품 밖 모듈의 클래스면 그 이유로 센다. 타입 인자를 적은 TypeScript 호출(this.format<number>(x), make<T>(x))은 호출로 보지 못한다.",
  '값 바인딩: 함수식이 아닌 값으로 정한 모듈 수준 이름(const fail = failWith("X"))은 어디선가 함수로 불릴 때만 값 노드가 되고, 그 참조는 초기값 안의 호출이다. 불리지 않는 값 바인딩은 노드가 아니다.',
  "다시 내보내기: export { a as b } from, export * from, import한 이름을 적은 export 목록, default(export { default } from, export { x as default }, export default 이름)를 선언까지 따라간다(Python은 패키지 모듈이 들여온 이름). 단계 수에 한도가 있고, 고리는 끊고 원래 이유를 둔다. export * as 이름 from은 읽지 않는다.",
  "내장 호출: 언어·런타임의 전역 이름 표(판단, 프로젝트 규칙의 내장 이름으로 더함)에 있고 파일이 그 이름을 선언·들여오거나 묶지 않을 때만 내장으로 본다. 메서드 이름이 제품 어디에서도 정의되지 않을 때만(선언이 아닌 것까지 넓게 본다: 클래스 필드, 클래스 식, 어느 객체 리터럴의 멤버, 시그니처, 따옴표 이름, x.y = function, prototype 대입, defineProperty) 제품 코드일 수 없다고 본다. 실행 중에 만든 이름(obj[name] = fn, Object.assign, 섞어 넣기)은 보지 못하므로, 그런 메서드는 제품 코드인데도 이 이유에 들 수 있다. 제품이 같은 이름을 정의하면 받는 쪽 타입을 모르는 호출로 둔다.",
]);

// One object for the structured result and generated files; the text renders
// it first. Facts here are not repeated elsewhere in the text.
// All calls in three numbers: those that cannot be product code (built-in
// reasons and language keywords), those into modules outside the product, and
// of the rest (calls that can be product code) how many resolved. Every call
// is in exactly one reason, so the numbers add up to all.
function callNumbers(summary, callbacks) {
  const count = (group) => summary.unresolvedByReason.filter((reason) => reason.group === group).reduce((sum, reason) => sum + reason.count, 0);
  const notProduct = { builtIn: count("built-in"), keyword: count("keyword"), external: count("external") };
  return {
    all: summary.allCalls,
    notProduct,
    canBeProduct: summary.allCalls - notProduct.builtIn - notProduct.keyword - notProduct.external,
    resolved: summary.resolvedCalls,
    keywordPseudoCalls: notProduct.keyword,
    callbacks,
  };
}

function limitsOf({ extraction, computed, includeEstimates, loaded, callbacks }) {
  const used = computed.documentSummary.list.filter((item) => item.status === "승인" || includeEstimates).map((item) => item.path);
  return {
    title: LIMITS_TITLE,
    codeReading: "코드는 정규식 기반 소스 분석으로 읽었다. 구문 트리가 아니고 타입 정보가 없다.",
    calls: callNumbers(extraction.referenceSummary, callbacks),
    callReading: CALL_READING_LIMITS,
    referenceKinds: { emitted: ["call", "callback", "framework-invoked"], notToldApart: NOT_TOLD_APART },
    runByPath: RUN_BY_PATH_LIMITS,
    // 입구 (2.1): the stop rule, stated whenever a rule gives 입구.
    ...(extraction.functionNodes.some((entry) => entry.entries?.length)
      ? { entries: { functions: extraction.functionNodes.filter((entry) => entry.entries?.length).length, rule: ENTRY_STOP_RULE } }
      : {}),
    // 데이터, 외부 연결, DB (2.8): what is read and what is still not seen.
    outside: { ...(extraction.outside?.counts || {}), unnamedCalls: extraction.outside?.lists.unnamedOutsideCount ?? 0, reading: OUTSIDE_LIMITS },
    // Functions used as values (2.3), counted apart from calls.
    valueUses: { ...extraction.valueUses, reading: VALUE_USE_LIMITS },
    notExtracted: { nodeTypes: NOT_EXTRACTED, edges: ["navigate"], grouping: "C4 묶음" },
    uiBindingScan: UI_SCAN_LIMITS,
    // Files whose lexer mask could not be trusted: 코드만 fell back to the
    // line-local check there.
    lineLocalFallback: { count: extraction.untrustedMaskFiles.length, files: extraction.untrustedMaskFiles },
    // How rows are read when a rule takes its 처리 코드 from the table row.
    tableRows: extraction.tableRowRules ? TABLE_ROW_LIMITS : null,
    execution: "아무것도 실행하지 않았다. 문서와 코드를 비교할 뿐이고, 어느 발견도 실행 근거에 기대지 않는다.",
    documents: {
      approved: computed.documentSummary.approved,
      changedAfterApproval: computed.documentSummary.changedAfterApproval,
      estimated: computed.documentSummary.estimated,
      approvalsRead: loaded.approvalsRead,
      includeEstimates,
      used,
    },
  };
}

// ---------- operations ----------

function run(options, { requireOutput }) {
  const inputs = resolveInputs({ ...options, requireOutput });
  const rules = readRules(inputs);
  const extraction = extractProductGraphCode({ sourceRoot: inputs.sourceRoot, projectRules: rules.rules });
  const loaded = loadDocuments(inputs);
  const includeEstimates = options.includeEstimates === true;
  const computed = compute({ extraction, loaded, includeEstimates });
  const callbacks = extraction.references.filter((item) => item.type === "callback").reduce((sum, item) => sum + item.count, 0);
  const result = {
    kind: "ProductGraphCheck",
    schemaVersion: 1,
    mode: inputs.mode === "project" ? "프로젝트" : "독립 실행",
    includeEstimates,
    checks: computed.checks.map(({ key, heading, meaning, outcome, reason, findings, compared, sideBySide }) => ({
      key,
      heading,
      meaning,
      outcome,
      ...(reason ? { reason } : {}),
      ...(findings ? { findings } : {}),
      ...(compared ? { compared } : {}),
      ...(sideBySide ? { sideBySide } : {}),
    })),
    guide: computed.guide,
    lists: computed.lists,
    counts: computed.counts,
    usedCounts: computed.usedCounts,
    countCovers: COUNT_COVERS,
    referenceSummary: {
      resolvedCalls: extraction.referenceSummary.resolvedCalls,
      callbacks,
      unresolvedCalls: extraction.referenceSummary.unresolvedCalls,
    },
    documents: { ...computed.documentSummary, approvalsRead: loaded.approvalsRead },
  };
  result.limits = limitsOf({ extraction, computed, includeEstimates, loaded, callbacks });
  const graph = graphDocument({ extraction, loaded, computed, inputs, rules, result });
  applyRunEvidence({ graph, computed, loaded, extraction, rules, result });
  const baseline = compareToBaseline({ inputs, graph, computed, readFiles: extraction.readFiles, takeIfMissing: requireOutput });
  result.changes = baseline.changes;
  result.confirmations = confirmationsOf({ graph, computed, loaded });
  result.text = renderProductGraphText(result);
  return { inputs, rules, extraction, loaded, computed, result, graph, baseline };
}

// Run records and the machine's 기능→화면요소 edges (2.6), on the finished
// graph (hashes in place): the edges are added after hashing because a
// 기능→화면요소 edge is in no content or reach hash. Document edges say
// 근거 "문서"; an edge lists every kind of evidence it has.
function applyRunEvidence({ graph, computed, loaded, extraction, rules, result }) {
  const states = runStates({ graph, records: loaded.runRecords || [], reader: graph.inputs.reader });
  const codeNodes = new Map();
  for (const node of graph.nodes) if (node.type === "코드") push(codeNodes, node.file, node);
  const codeOf = (file, line) => {
    let best = null;
    for (const node of codeNodes.get(file) || [])
      if (
        node.lines &&
        node.id !== node.file &&
        node.lines[0] <= line &&
        line <= node.lines[1] &&
        (!best || node.lines[1] - node.lines[0] < best.lines[1] - best.lines[0])
      )
        best = node;
    return best ? best.id : codeNodes.has(file) ? file : null;
  };
  const files = new Map([...extraction.readFiles].filter(([file]) => codeNodes.has(file)));
  const found = machineEdges({ graph, screens: computed.screens, states, files, codeOf, removals: rules.rules?.["빼는 연결"] || [] });
  const basisOf = (screen) => ({ path: screen.path, status: screen.status, estimateKind: screen.estimateKind });
  const byPair = new Map(found.edges.map((edge) => [`${edge.from}\u0000${edge.to}`, edge]));
  for (const edge of graph.edges) {
    if (edge.type !== "기능→화면요소") continue;
    const machine = byPair.get(`${edge.from}\u0000${edge.to}`);
    edge.근거 = machine?.document ? machine.근거 : ["문서"];
  }
  const screenOf = new Map();
  for (const screen of computed.screens) for (const element of screen.parsed.elements) screenOf.set(element.id, screen);
  for (const edge of found.edges)
    if (!edge.document)
      graph.edges.push({
        type: "기능→화면요소",
        from: edge.from,
        to: edge.to,
        at: edge.at,
        basis: basisOf(screenOf.get(edge.to)),
        근거: edge.근거,
        machine: true,
      });
  graph.edges.sort(
    (a, b) =>
      compare(a.type, b.type) ||
      compare(a.from, b.from) ||
      compare(a.to, b.to) ||
      compare(a.at?.path || "", b.at?.path || "") ||
      (a.at?.line || 0) - (b.at?.line || 0),
  );
  result.lists.runs = {
    records: states.records,
    functions: states.functions,
    currentFunctions: states.currentFunctions,
    replaced: states.replaced,
    current: states.current.map(({ 출력, ...run }) => ({ ...run, outputBytes: Buffer.byteLength(출력) })),
    stale: states.stale,
    issues: loaded.runIssues || [],
    ...(loaded.runRecordLimit ? { recordLimit: loaded.runRecordLimit } : {}),
    recordsListingSha256: loaded.runListingSha256 ?? null,
  };
  result.lists.screenEvidence = { phrased: found.phrased, removed: found.removed, filesRead: found.filesRead, ...found.lists };
  result.lists.ruleIssues.push(...found.ruleIssues);
  // The limits block: Lode ran nothing, and what it read of runs.
  if (states.records) {
    result.limits.execution = `아무것도 실행하지 않았다. 프로젝트가 넘긴 실행 기록 ${states.records}개(기능 ${states.functions}개)를 읽었고, 그중 기능 ${states.currentFunctions}개의 실행이 지금 코드에 그대로다. 실행 근거는 그 실행의 출력 글이다.`;
    result.limits.runs = { records: states.records, functions: states.functions, currentFunctions: states.currentFunctions, lodeRan: false };
  }
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

const baselineFile = (inputs) => path.join(inputs.outputDirectory, PRODUCT_GRAPH_BASELINE_FILE);

// What was checked and whether it still holds, independent of the baseline.
function confirmationsOf({ graph, computed, loaded }) {
  const status = confirmationStatus({
    graph,
    meaningDocument: computed.meaningDocument,
    documents: loaded.documents,
    records: loaded.checkRecords,
    issues: loaded.checkIssues,
    read: loaded.approvalsRead,
  });
  if (status.status !== "compared") return status;
  return { ...status, ...(loaded.checkRecordLimit ? { recordLimit: loaded.checkRecordLimit } : {}), recordsListingSha256: loaded.checkListingSha256 };
}

// The records in 확인/ as they are now: names and sizes only, from every
// folder named 확인 (after normalisation), as a build finds them.
function checkListingNow(documentsDirectory) {
  return recordListingNow(documentsDirectory, { ...RECORD_KINDS.check, role: "check" });
}

function runListingNow(documentsDirectory) {
  return recordListingNow(documentsDirectory, { ...RECORD_KINDS.run, role: "run" });
}

function recordListingNow(documentsDirectory, spec) {
  const listing = [],
    folderIssues = [];
  for (const folder of listDirectory(documentsDirectory).filter((entry) => entry.isDirectory() && nfc(entry.name) === spec.directory)) {
    let entries;
    try {
      entries = listDirectory(path.join(documentsDirectory, folder.name));
    } catch {
      folderIssues.push({ path: `${spec.directory}/` });
      continue;
    }
    for (const entry of entries) {
      const relative = `${spec.directory}/${nfc(entry.name)}`;
      if (!entry.isFile() || classifyProductGraphPath(relative)?.role !== spec.role) continue;
      listing.push([relative, path.join(documentsDirectory, folder.name, entry.name)]);
    }
  }
  listing.sort((a, b) => compare(a[0], b[0]));
  // As a build: sizes for the first spec.maxRecords, names for the rest.
  listing.forEach((row, index) => {
    let size = null;
    if (index < spec.maxRecords)
      try {
        size = fs.lstatSync(row[1]).size;
      } catch {
        /* An unreadable entry has no size. */
      }
    row[1] = size;
  });
  return checkListingDigest(listing, folderIssues);
}

// The comparison with the baseline (8A.3). A missing baseline is taken from
// this build by a build (never by a check); an unreadable one is reported and
// left as it is. A baseline never blocks a build, except that a build which
// does not reproduce the baseline's nodes for unchanged files stops.
// The output folder as it is on disk: null when absent. A path under a regular
// file is "absent" too (ENOTDIR on POSIX, ENOENT on Windows).
function outputStat(directory) {
  try {
    return fs.lstatSync(directory, { throwIfNoEntry: false }) || null;
  } catch (error) {
    if (error.code === "ENOTDIR") return null;
    throw error;
  }
}

const retainedFile = (inputs) => path.join(inputs.outputDirectory, PRODUCT_GRAPH_RETAINED_CONTENT_FILE);

// What a document of retained content says about itself to the comparison,
// read back the way the next build will read it from disk.
const retainedView = (document) => ({ status: "read", entries: new Map(Object.keys(document.entries).map((id) => [id, true])) });

function compareToBaseline({ inputs, graph, computed, takeIfMissing, readFiles }) {
  if (!inputs.outputDirectory) return { changes: noBaseline("독립 검사에는 출력 폴더가 없어 기준을 읽지 않는다") };
  // Something other than a folder where the output folder belongs is refused
  // by a build with the product graph reason before anything under it is read;
  // a check reports it and reads no baseline.
  const existing = outputStat(inputs.outputDirectory);
  // (A link is left to the linked-path check that follows.)
  if (existing && !existing.isDirectory() && !existing.isSymbolicLink()) {
    if (takeIfMissing) fail("PRODUCT_GRAPH_OUTPUT_NOT_DIRECTORY", "출력 폴더 자리에 폴더가 아닌 것이 있다.");
    return { changes: noBaseline("출력 폴더 자리에 폴더가 아닌 것이 있어 기준을 읽지 않았다") };
  }
  if (inputs.mode === "project") assertNoLinkedComponents(inputs.projectRoot, baselineFile(inputs));
  const read = readBaseline(baselineFile(inputs));
  const meaning = computed.meaningDocument;
  const meaningLines = (meaning?.parsed.meanings || []).map((item) => ({ id: item.id, at: { path: meaning.path, line: item.line } }));
  if (read.baseline) {
    const baselineBytes = fs.readFileSync(baselineFile(inputs));
    const baselineSha256 = sha256Hex(baselineBytes);
    if (inputs.mode === "project") assertNoLinkedComponents(inputs.projectRoot, retainedFile(inputs));
    let retained = readRetainedContent(retainedFile(inputs), { baseline: read.baseline, baselineBytes });
    // The retained file is derived from the baseline: when it is missing, for
    // another baseline (an interrupted move) or unreadable, a build writes it
    // again from this build, only for nodes whose content is still the
    // baseline's. Only when the baseline was read the way this build reads
    // code; otherwise nothing is written and the reason says what to do. A
    // check computes the same in memory.
    let retainedCreate = null,
      retainedReplace = false;
    const sameReader = readerKey(read.baseline.reader) === readerKey(graph.inputs.reader);
    if (["missing", "other-baseline", "unreadable", "other-reader"].includes(retained.status)) {
      if (sameReader) {
        const hashes = new Map(read.baseline.nodes.map(([id, , , , , contentSha256]) => [id, contentSha256]));
        retainedCreate = retainedContentFor({
          graph,
          baselineBytes,
          readText: (relative) => readFiles.get(relative),
          unresolvedHandlers: computed.lists?.unresolvedHandlers || [],
          only: (node) => Boolean(node.contentSha256) && hashes.get(node.id) === node.contentSha256,
        });
        retainedReplace = retained.status !== "missing";
        retained = { ...retainedView(retainedCreate), rebuiltFrom: retained.status };
      } else
        retained = {
          status: "other-reader",
          entries: new Map(),
          reason: "기준이 지금과 다른 방식으로 코드를 읽어 잡혔다",
          action: "product-graph-baseline으로 기준을 다시 잡으면 이전 본문이 보관된다",
        };
    }
    return {
      changes: compareWithBaseline(graph, read.baseline, { meaningLines, retained, baselineSha256 }),
      state: { status: "kept", setAt: read.baseline.setAt },
      retainedCreate,
      retainedReplace,
    };
  }
  if (read.missing && takeIfMissing) {
    const taken = baselineFromGraph(graph, { setAt: new Date().toISOString() });
    const takenBytes = Buffer.from(serializeBaseline(taken));
    const retainedCreate = retainedContentFor({
      graph,
      baselineBytes: takenBytes,
      readText: (relative) => readFiles.get(relative),
      unresolvedHandlers: computed.lists?.unresolvedHandlers || [],
    });
    return {
      changes: compareWithBaseline(graph, taken, { meaningLines, retained: retainedView(retainedCreate), baselineSha256: sha256Hex(takenBytes) }),
      taken,
      retainedCreate,
      state: { status: "taken-now", setAt: taken.setAt, message: "기준 없음 — 이번 빌드를 기준으로 삼았다" },
    };
  }
  const reason = read.missing ? "기준 파일이 없다 — 첫 빌드가 이 빌드를 기준으로 삼는다" : `${read.reason} — product-graph-baseline으로 다시 잡을 수 있다`;
  return { changes: noBaseline(reason), state: { status: "none", reason } };
}

export function checkProductGraph(options = {}) {
  const { result } = run(options, { requireOutput: false });
  return markTextFromStructure({ status: "checked", readOnly: true, persisted: false, ...result }, renderProductGraphText);
}

export function buildProductGraph(options = {}) {
  const ran = run(options, { requireOutput: true });
  const { inputs, result, graph, baseline } = ran;
  const output = inputs.outputDirectory;
  const { text, ...structured } = result;
  const graphText = json(graph);
  const files = [
    ["graph.json", graphText],
    ["check.json", json(structured)],
    ["check.txt", text],
    [PRODUCT_GRAPH_BUILD_CONTEXT_FILE, json({ kind: "ProductGraphBuildContext", graphFileSha256: sha256Hex(graphText), scope: buildScope(inputs) })],
  ];
  // The retained "before" content: created with a new baseline, or once for a
  // baseline that has none (only nodes whose content equals the baseline's).
  const created = [];
  if (baseline.taken) created.push([PRODUCT_GRAPH_BASELINE_FILE, serializeBaseline(baseline.taken)]);
  const replaced = [];
  if (baseline.retainedCreate)
    (baseline.retainedReplace ? replaced : created).push([PRODUCT_GRAPH_RETAINED_CONTENT_FILE, serializeRetainedContent(baseline.retainedCreate)]);
  const write = () => {
    if (inputs.mode === "project") assertNoLinkedComponents(inputs.projectRoot, output);
    const existing = fs.lstatSync(output, { throwIfNoEntry: false });
    if (existing && !existing.isDirectory()) fail("PRODUCT_GRAPH_OUTPUT_NOT_DIRECTORY", "출력 폴더 자리에 폴더가 아닌 것이 있다.");
    fs.mkdirSync(output, { recursive: true });
    if (inputs.mode === "project") assertNoLinkedComponents(inputs.projectRoot, output);
    if (inputs.mode === "project") {
      const ignore = path.join(output, ".gitignore");
      if (!fs.existsSync(ignore))
        try {
          atomicCreateArtifact(ignore, "# Generated product graph output; rebuild with product-graph-build.\n*\n");
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
    }
    for (const [name, content] of [...files, ...replaced]) atomicWriteArtifact(path.join(output, name), content);
    // The baseline and its retained content are written once; only
    // product-graph-baseline moves them.
    for (const [name, content] of created)
      try {
        atomicCreateArtifact(path.join(output, name), content);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
  };
  if (inputs.mode === "project") withProjectMutation({ root: inputs.projectRoot, storage: inputs.storage, scope: "product-graph-build", timeoutMs: 0 }, write);
  else write();
  const built = {
    status: "built",
    mode: result.mode,
    written: [...files, ...replaced, ...created].map(([name, content]) => ({ name, bytes: Buffer.byteLength(content), sha256: sha256Hex(content) })),
    baseline: baseline.state || { status: "none" },
    outputLocation: inputs.mode === "project" ? `${inputs.storage.directory}/${PRODUCT_GRAPH_DIRECTORY}/${PRODUCT_GRAPH_BUILD_DIRECTORY}` : output,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    ...result,
  };
  return markTextFromStructure(built, renderProductGraphText);
}

// ---------- reading an existing build (query, viewer, baseline move) ----------

const BOUNDED_LIST = 5;
const PRODUCT_GRAPH_SOURCE_READ_BYTES = 1024 * 1024;
const bounded = (items) => `${items.slice(0, BOUNDED_LIST).join(", ")}${items.length > BOUNDED_LIST ? ` 외 ${items.length - BOUNDED_LIST}개` : ""}`;

function buildCommandOf(inputs) {
  if (!inputs) return "product-graph-build <source-root> --documents <folder> --rules <entry-rules.json> --out <folder>";
  if (inputs.mode === "project") return `product-graph-build ${inputs.projectRoot}`;
  return `product-graph-build ${inputs.sourceRoot ?? "<source-root>"} --documents ${inputs.documentsDirectory ?? "<folder>"} --rules ${inputs.rulesFile ?? "<entry-rules.json>"} --out ${inputs.outputDirectory}`;
}

// A source file's text as it is now, read inside the source root, or null.
export function sourceTextNow(sourceRoot, relative) {
  try {
    const file = safeGraphFile(sourceRoot, relative);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PRODUCT_GRAPH_SOURCE_READ_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function sourceHashNow(sourceRoot, relative) {
  try {
    // Every source file on every read: the plain read main used (lstat refuses
    // a linked file). The checked read is kept for showing content.
    const file = path.join(sourceRoot, ...relative.split("/"));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > PRODUCT_GRAPH_SOURCE_READ_BYTES) return null;
    return sourceTextHash(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file)));
  } catch {
    return null;
  }
}

// 6.3: is this build still the source as it is now? Compares the documents,
// the rules file and every source file the build read (and looks for new code
// files) with what is on disk. Read-only. Without a source root, unknown.
function freshnessOf(inputs, graph) {
  const result = { state: "fresh", documents: { known: false, changed: [] }, rules: { known: false, changed: false }, source: { known: false, changed: [] } };
  if (!inputs) {
    result.state = "unknown";
    result.source.reason = "소스 루트 없이 빌드 폴더만 받았다";
    result.text = "소스가 바뀌었는지 알 수 없음 — 소스 루트 없이 빌드 폴더만 받았다";
    return result;
  }
  // Each input is compared only when it was given; what was not given stays
  // "알 수 없음" with that reason.
  if (!inputs.documentsDirectory) result.documents.reason = "문서 폴더를 받지 않았다";
  else
    try {
      const now = new Map(
        readDocumentFiles(inputs.documentsDirectory, { readChecks: false })
          .files.filter((file) => ["document", "policy", "meaning"].includes(file.role))
          .map((file) => [file.path, file.sha256]),
      );
      const before = new Map((graph.inputs?.documents || []).map((item) => [item.path, item.sha256]));
      result.documents = {
        known: true,
        changed: [...new Set([...now.keys(), ...before.keys()])].filter((file) => now.get(file) !== before.get(file)).sort(compare),
      };
    } catch (error) {
      result.documents.reason = error.code || "문서를 읽지 못했다";
    }
  let excludes = [];
  if (!inputs.rulesFile) result.rules.reason = "호출 방식 표 파일을 받지 않았다";
  else
    try {
      const rules = readRules({ ...inputs, rulesRequired: false });
      result.rules = { known: true, changed: (rules.sha256 ?? null) !== (graph.inputs?.rulesSha256 ?? null) };
      excludes = rules.rules?.source?.["제외"] || [];
    } catch (error) {
      result.rules = { known: true, changed: true, reason: error.code || "호출 방식 표를 읽지 못했다" };
    }
  const recorded = graph.inputs?.sourceFiles;
  if (!inputs.sourceRoot) result.source.reason = "소스 루트를 받지 않았다";
  else if (!Array.isArray(recorded)) result.source.reason = "이 빌드는 읽은 소스 파일의 해시를 적지 않았다(0.3.0-beta.126 이전에 만든 빌드)";
  else
    try {
      const changed = [];
      const known = new Set();
      for (const item of recorded) {
        known.add(item.path);
        if (sourceHashNow(inputs.sourceRoot, item.path) !== item.sha256) changed.push(item.path);
      }
      // A code file the build would read now but did not (a file it cannot
      // read as text is not one the build reads either).
      for (const file of productGraphCodeFiles(inputs.sourceRoot, excludes))
        if (!known.has(file) && sourceHashNow(inputs.sourceRoot, file) !== null) changed.push(file);
      result.source = { known: true, changed: changed.sort(compare) };
    } catch (error) {
      result.source.reason = `소스를 읽지 못했다 (${error.code || "읽기 실패"})`;
    }
  const parts = [];
  if (result.documents.changed.length) parts.push(`문서 ${result.documents.changed.length}개 (${bounded(result.documents.changed)})`);
  if (result.rules.changed) parts.push("호출 방식 표");
  if (result.source.known && result.source.changed.length) parts.push(`소스 파일 ${result.source.changed.length}개 (${bounded(result.source.changed)})`);
  const unknowns = [
    ...(!result.source.known ? [`소스가 바뀌었는지 알 수 없음 — ${result.source.reason}`] : []),
    ...(!result.documents.known ? [`문서가 바뀌었는지 알 수 없음 — ${result.documents.reason}`] : []),
    ...(!result.rules.known ? [`호출 방식 표가 바뀌었는지 알 수 없음 — ${result.rules.reason}`] : []),
  ];
  if (parts.length) {
    result.state = "stale";
    result.text = `빌드가 낡음: ${parts.join(" / ")}${unknowns.length ? ` · ${unknowns.join(" · ")}` : ""}`;
  } else if (unknowns.length) {
    result.state = "unknown";
    result.text = unknowns.join(" · ");
  } else result.text = "빌드 뒤 바뀐 것 없음";
  return result;
}

// Confirmation records written after the build (product-graph-confirm,
// product-graph-approve) are not in check.json until the next build. That is
// said next to the freshness; it does not make the build stale (the graph is
// still the source as it is) and blocks nothing.
function withConfirmationFiles(freshness, inputs, check) {
  const recorded = check?.confirmations?.recordsListingSha256;
  if (inputs?.mode !== "project" || typeof recorded !== "string") return freshness;
  let now;
  try {
    now = checkListingNow(inputs.documentsDirectory);
  } catch {
    return freshness;
  }
  const changed = now !== recorded;
  if (!changed) return { ...freshness, confirmations: { changed: false } };
  const note = "확인 기록이 빌드 뒤 바뀜 — 다시 빌드하면 확인 상태에 반영된다";
  return { ...freshness, confirmations: { changed: true, text: note }, text: `${freshness.text} · ${note}` };
}

// Run records added or removed since the build: a note, like 확인 records.
function withRunFiles(freshness, inputs, check) {
  const recorded = check?.lists?.runs?.recordsListingSha256;
  if (inputs?.mode !== "project" || typeof recorded !== "string") return freshness;
  let now;
  try {
    now = runListingNow(inputs.documentsDirectory);
  } catch {
    return freshness;
  }
  if (now === recorded) return { ...freshness, runs: { changed: false } };
  const note = "실행 기록이 빌드 뒤 바뀜 — 다시 빌드하면 연결에 반영된다";
  return { ...freshness, runs: { changed: true, text: note }, text: `${freshness.text} · ${note}` };
}

// Reads the existing build: graph.json, check.json, the time of graph.json
// and the baseline's time. Never builds, checks or writes. Project mode reads
// the Project's build folder; { buildDirectory } reads a stand-alone output
// folder (its source state is then unknown); the stand-alone build options
// read --out with the given roots.
export function readProductGraphBuild(options = {}) {
  let inputs = null,
    directory;
  if (options.buildDirectory) {
    directory = path.resolve(options.buildDirectory);
    // Whatever roots were given with the folder are used for 6.3.
    if (options.sourceRoot || options.documentsDirectory || options.rulesFile)
      inputs = {
        mode: "standalone",
        sourceRoot: options.sourceRoot ? path.resolve(options.sourceRoot) : null,
        documentsDirectory: options.documentsDirectory ? path.resolve(options.documentsDirectory) : null,
        rulesFile: options.rulesFile ? path.resolve(options.rulesFile) : null,
        rulesRequired: false,
        outputDirectory: directory,
        approvals: false,
      };
  } else {
    inputs = resolveInputs({ ...options, requireOutput: true });
    directory = inputs.outputDirectory;
  }
  const buildCommand = buildCommandOf(inputs);
  const folder = outputStat(directory);
  if (folder && !folder.isDirectory() && !folder.isSymbolicLink())
    return {
      status: "unreadable",
      code: "PRODUCT_GRAPH_OUTPUT_NOT_DIRECTORY",
      reason: "빌드 폴더 자리에 폴더가 아닌 것이 있다",
      buildCommand,
      inputs,
      directory,
    };
  if (!folder) return { status: "not-built", code: "PRODUCT_GRAPH_NOT_BUILT", reason: "없음, 빌드 필요", buildCommand, inputs, directory };
  if (inputs?.mode === "project") assertNoLinkedComponents(inputs.projectRoot, path.join(directory, "graph.json"));
  const graphFile = path.join(directory, "graph.json");
  const stat = outputStat(graphFile);
  if (!stat) return { status: "not-built", code: "PRODUCT_GRAPH_NOT_BUILT", reason: "없음, 빌드 필요", buildCommand, inputs, directory };
  let graph, check, graphBytes, checkText;
  try {
    if (!stat.isFile()) throw Object.assign(new Error("not a file"), { code: "PRODUCT_GRAPH_BUILD_UNREADABLE" });
    graphBytes = fs.readFileSync(graphFile);
    graph = JSON.parse(graphBytes.toString("utf8"));
    checkText = fs.readFileSync(path.join(directory, "check.json"));
    check = JSON.parse(checkText.toString("utf8"));
  } catch (error) {
    return {
      status: "unreadable",
      code: "PRODUCT_GRAPH_BUILD_UNREADABLE",
      reason: `빌드 파일을 읽지 못했다 (${error.code || "JSON이 아니다"})`,
      buildCommand,
      inputs,
      directory,
    };
  }
  if (graph?.kind !== "LodeProductGraph" || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || check?.kind !== "ProductGraphCheck")
    return { status: "unreadable", code: "PRODUCT_GRAPH_BUILD_UNREADABLE", reason: "빌드 파일의 모양이 제품 그래프가 아니다", buildCommand, inputs, directory };
  const baseline = readBaseline(path.join(directory, PRODUCT_GRAPH_BASELINE_FILE));
  // The hashes of the build files are taken when first asked for. Every
  // query answer asks (its buildSha256): one SHA-256 pass over bytes already
  // read, about 18 ms for Lode's own 8.6 MiB build and under 1 ms for the
  // test fixture (measured 2026-11-21); the viewer and the baseline move do not.
  let graphFileSha256 = null,
    checkFileSha256 = null;
  const checkBytes = checkText;
  return {
    status: "built",
    builtAt: stat.mtime.toISOString(),
    graph,
    get graphFileSha256() {
      return (graphFileSha256 ??= sha256Hex(graphBytes));
    },
    get checkFileSha256() {
      return (checkFileSha256 ??= sha256Hex(checkBytes));
    },
    check,
    freshness: withRunFiles(withConfirmationFiles(freshnessOf(inputs, graph), inputs, check), inputs, check),
    baselineNow: baseline.baseline ? { setAt: baseline.baseline.setAt } : null,
    baselineEvidence: baseline.baseline || null,
    buildCommand,
    inputs,
    directory,
  };
}

// The retained "before" content of a read build's baseline (only the
// `changes --list content` question reads it).
export function readProductGraphRetainedContent(read) {
  const baselinePath = path.join(read.directory, PRODUCT_GRAPH_BASELINE_FILE);
  if (!read.baselineEvidence) return { status: "no-baseline", entries: new Map(), reason: "기준이 없다" };
  if (read.inputs?.mode === "project") assertNoLinkedComponents(read.inputs.projectRoot, path.join(read.directory, PRODUCT_GRAPH_RETAINED_CONTENT_FILE));
  let baselineBytes;
  try {
    baselineBytes = fs.readFileSync(baselinePath);
  } catch {
    return { status: "unreadable", entries: new Map(), reason: "기준 파일을 읽지 못했다" };
  }
  return {
    ...readRetainedContent(path.join(read.directory, PRODUCT_GRAPH_RETAINED_CONTENT_FILE), { baseline: read.baselineEvidence, baselineBytes }),
    baselineSha256: sha256Hex(baselineBytes),
  };
}

// The build's scope record, read only by the impact preview. Unknown (null)
// when absent or written for a different graph.json.
export function readProductGraphBuildContext(read) {
  try {
    const metadata = JSON.parse(readBounded(path.join(read.directory, PRODUCT_GRAPH_BUILD_CONTEXT_FILE)).toString("utf8"));
    return metadata?.kind === "ProductGraphBuildContext" && metadata.graphFileSha256 === read.graphFileSha256 ? metadata : null;
  } catch {
    return null;
  }
}

// 8A.2: the only operation that moves the baseline. Takes the existing build
// as the new baseline when that build is the source as it is now.
export function moveProductGraphBaseline(options = {}) {
  if (options.buildDirectory)
    fail("PRODUCT_GRAPH_BUILD_STALE", "소스 루트 없이 빌드 폴더만으로는 기준을 옮기지 않는다. 프로젝트나 빌드와 같은 독립 실행 옵션을 준다.");
  const read = readProductGraphBuild(options);
  if (read.status === "not-built") fail("PRODUCT_GRAPH_NOT_BUILT", `제품 그래프 빌드가 없다. 먼저 빌드한다: ${read.buildCommand}`);
  if (read.status !== "built") fail(read.code || "PRODUCT_GRAPH_BUILD_UNREADABLE", read.reason);
  const { graph, check, inputs } = read;
  if (!Array.isArray(graph.inputs?.sourceFiles) || graph.nodes.some((node) => !Object.hasOwn(node, "contentSha256")))
    fail("PRODUCT_GRAPH_BUILD_STALE", `이 빌드에는 내용 해시가 없다(이전 버전의 빌드). 다시 빌드한 뒤 옮긴다: ${read.buildCommand}`);
  if (read.freshness.state !== "fresh") fail("PRODUCT_GRAPH_BUILD_STALE", `${read.freshness.text}. 다시 빌드한 뒤 옮긴다: ${read.buildCommand}`);
  const file = path.join(read.directory, PRODUCT_GRAPH_BASELINE_FILE);
  const counts = check.changes?.status === "compared" ? check.changes.counts : null;
  const dropped = {
    changes: counts ? counts.changed + counts.added + counts.removed + counts.reachChanged : 0,
    reviewAgain: counts ? counts.reviewAgain : 0,
  };
  const move = () => {
    const old = readBaseline(file);
    const previous = old.baseline ? { setAt: old.baseline.setAt, droppedChanges: dropped.changes, droppedReviewAgain: dropped.reviewAgain } : null;
    const baseline = baselineFromGraph(graph, { setAt: new Date().toISOString(), previous });
    const baselineText = serializeBaseline(baseline);
    const retained = retainedContentFor({
      graph,
      baselineBytes: Buffer.from(baselineText),
      readText: (relative) => sourceTextNow(inputs.sourceRoot, relative),
      unresolvedHandlers: check.lists?.unresolvedHandlers || [],
    });
    const contentFile = path.join(read.directory, PRODUCT_GRAPH_RETAINED_CONTENT_FILE);
    if (inputs.mode === "project") {
      assertNoLinkedComponents(inputs.projectRoot, file);
      assertNoLinkedComponents(inputs.projectRoot, contentFile);
    }
    // The retained file first: if the move stops between the two writes, the
    // old baseline stays with a retained file for another baseline, which the
    // next build writes again.
    atomicWriteArtifact(contentFile, serializeRetainedContent(retained));
    atomicWriteArtifact(file, baselineText);
    return { baseline, previous };
  };
  const { baseline, previous } =
    inputs.mode === "project"
      ? withProjectMutation({ root: inputs.projectRoot, storage: inputs.storage, scope: "product-graph-build", timeoutMs: 0 }, move)
      : move();
  // Keys in the order main answered with (text before graphUnchanged).
  const fields = { setAt: baseline.setAt, previous, dropped };
  return markTextFromStructure({ status: "moved", ...fields, text: baselineMovedText(fields), graphUnchanged: true }, baselineMovedText);
}

// The sentence a baseline move answers with, from its structured fields.
function baselineMovedText({ setAt, previous, dropped }) {
  return `기준을 옮겼다: ${setAt}. 바뀐 것 ${dropped.changes}개와 다시 볼 것 ${dropped.reviewAgain}개가 목록에서 빠진다(다음 빌드부터).${previous ? ` 이전 기준: ${previous.setAt}.` : " 이전 기준은 없었다."}\n`;
}

// The current graph, recomputed read-only, when it is exactly the build on
// disk: the build is fresh and rebuilding now would write the same graph.json
// (an approval or a Lode update since the build makes it differ). Otherwise a
// reason.
function currentBuildGraph(root) {
  const read = readProductGraphBuild({ root });
  if (read.status === "not-built")
    return { ok: false, code: "PRODUCT_GRAPH_NOT_BUILT", reason: `제품 그래프 빌드가 없다. 먼저 빌드한다: ${read.buildCommand}` };
  if (read.status !== "built") return { ok: false, code: read.code || "PRODUCT_GRAPH_BUILD_UNREADABLE", reason: read.reason };
  if (read.graph.nodes.some((node) => !Object.hasOwn(node, "contentSha256")))
    return { ok: false, code: "PRODUCT_GRAPH_BUILD_STALE", reason: `이 빌드에는 내용 해시가 없다(이전 버전의 빌드). 다시 빌드한다: ${read.buildCommand}` };
  if (read.freshness.state !== "fresh")
    return { ok: false, code: "PRODUCT_GRAPH_BUILD_STALE", reason: `${read.freshness.text}. 다시 빌드한다: ${read.buildCommand}` };
  const ran = run({ root }, { requireOutput: false });
  // What a record stores: every node's content and reach hash and the way code
  // is read. An approval since the build changes a document's status, not
  // these, so a second approval in a row still records its code basis.
  const hashes = (graph) =>
    JSON.stringify(graph.nodes.map((node) => [node.id, node.contentSha256 ?? null, node.reachSha256 ?? null]).sort((a, b) => compare(a[0], b[0])));
  if (hashes(ran.graph) !== hashes(read.graph) || readerKey(ran.graph.inputs?.reader) !== readerKey(read.graph.inputs?.reader))
    return {
      ok: false,
      code: "PRODUCT_GRAPH_BUILD_STALE",
      reason: `빌드의 노드 내용이 지금 소스로 다시 읽은 것과 다르다(Lode가 코드를 읽는 방식이 바뀌었을 수 있다). 다시 빌드한다: ${read.buildCommand}`,
    };
  return { ok: true, ran };
}

const checkableOf = (ran) => checkableItems({ graph: ran.graph, meaningDocument: ran.computed.meaningDocument, documents: ran.loaded.documents });

// Where the family's folder named `name` is written: the folder spelled
// exactly `name` (NFC) when there is one, as main writes; otherwise the one
// existing folder whatever its spelling (a name stored decomposed); otherwise
// a new NFC folder. Folder spelling never stops a write. `all` lists every
// folder with that name after normalisation (a build reads them all).
function familyFolder(family, name) {
  const matches = listDirectory(family).filter((entry) => nfc(entry.name) === name);
  const all = matches.filter((entry) => entry.isDirectory()).map((entry) => path.join(family, entry.name));
  if (!matches.length) return { path: path.join(family, name), exists: false, folder: false, all };
  const chosen = matches.find((entry) => entry.name === name) || matches[0];
  return { path: path.join(family, chosen.name), exists: true, folder: chosen.isDirectory(), all };
}

// Writes the records of one command. Everything that can be checked is checked
// first: a refusal (a linked path, a 확인 that is not a folder or cannot be
// listed, too many records, a colliding name) writes nothing. A write that
// fails part way stops there; the reply names what was written and what was not.
function writeCheckRecords({ projectRoot, family, records }) {
  const folder = familyFolder(family, PRODUCT_GRAPH_CHECK_DIRECTORY);
  if (folder.exists && !folder.folder)
    fail("PRODUCT_GRAPH_CHECK_FOLDER_INVALID", `${PRODUCT_GRAPH_CHECK_DIRECTORY}가 폴더가 아니라서 확인 기록을 쓰지 않는다.`);
  const directory = folder.path;
  const planned = records.map((record) => {
    const destination = path.join(directory, `${record.checkId}.json`);
    assertNoLinkedComponents(projectRoot, destination);
    const text = json(record);
    // A record a build could not read back is never written.
    if (Buffer.byteLength(text) > PRODUCT_GRAPH_CHECK_MAX_BYTES)
      fail("PRODUCT_GRAPH_CHECK_LIMIT", `확인 기록 하나가 ${PRODUCT_GRAPH_CHECK_MAX_BYTES}바이트를 넘는다.`);
    let existing = false;
    // The same record in the other spelling's folder is already there.
    const present = [destination, ...folder.all.map((other) => path.join(other, `${record.checkId}.json`))].find((candidate) => fs.existsSync(candidate));
    if (present) {
      const stored = verifyProductGraphCheck(JSON.parse(decodeProductGraphText(readBounded(present))), {
        projectId: record.projectId,
        checkId: record.checkId,
      });
      if (stored.checkHash !== record.checkHash) fail("PRODUCT_GRAPH_CHECK_COLLISION");
      existing = true;
    }
    return { checkId: record.checkId, destination, text, existing };
  });
  let present = 0;
  try {
    // Counted over every 확인 folder, as a build reads them.
    for (const each of folder.all.length ? folder.all : [directory])
      present += listDirectory(each).filter(
        (entry) => classifyProductGraphPath(`${PRODUCT_GRAPH_CHECK_DIRECTORY}/${nfc(entry.name)}`)?.role === "check",
      ).length;
  } catch (error) {
    fail("PRODUCT_GRAPH_CHECK_UNREADABLE", `확인 기록 폴더를 읽지 못해 쓰지 않는다(${error.code || "오류"}).`);
  }
  const added = planned.filter((entry) => !entry.existing).length;
  if (present + added > PRODUCT_GRAPH_CHECK_MAX_RECORDS)
    fail(
      "PRODUCT_GRAPH_CHECK_LIMIT",
      `확인 기록이 ${present}개 있어, ${added}개를 더 쓰면 한도 ${PRODUCT_GRAPH_CHECK_MAX_RECORDS}개를 넘는다. 아무것도 쓰지 않았다.`,
    );
  const result = { written: [], existing: planned.filter((entry) => entry.existing).map((entry) => entry.checkId), notWritten: [], error: null };
  for (const entry of planned) {
    if (entry.existing) continue;
    if (result.error) {
      result.notWritten.push(entry.checkId);
      continue;
    }
    try {
      if (!result.written.length) fs.mkdirSync(directory, { recursive: true });
      atomicCreateArtifact(entry.destination, entry.text);
      result.written.push(entry.checkId);
    } catch (error) {
      result.error = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code) ? error.code : "UNKNOWN";
      result.notWritten.push(entry.checkId);
    }
  }
  return result;
}

const PRODUCT_GRAPH_CHECK_MAX_ID = 65536;
const MISSING_LISTED = 10;
const ECHO_CHARS = 200;
const echo = (value) => (value.length > ECHO_CHARS ? `${value.slice(0, ECHO_CHARS)}…(${value.length}자)` : value);
const describeItem = (item) =>
  item?.kind === "meaning"
    ? `기능 ${String(item.id).slice(0, 120)}`
    : `${item?.document} ${item?.type} ${String(item?.from).slice(0, 60)} → ${String(item?.to).slice(0, 60)}`;

const PRODUCT_GRAPH_CHECK_NOTE =
  "에이전트가 코드를 다시 읽고 남긴 확인이다. 사용자의 승인이 아니며 아무 권한도 주지 않는다. 확인한 코드가 바뀌면 '확인 뒤 코드가 바뀜'으로 다시 나온다.";

// Records an agent's check of 뜻 lines (by 기능 id) and of every row of the
// named documents against the code as the current build has it. Only after
// re-reading that code; it is not the user's approval.
export function confirmProductGraph({ root = ".", features = [], documents = [], rationale = null } = {}) {
  const inspected = readProject(root);
  if (!inspected.project) fail("NOT_INITIALIZED", "확인 기록은 Lode 프로젝트에서만 쓴다. 이 폴더는 Lode 프로젝트가 아니다.");
  // Any id the graph produced can be named; the bound only keeps one input sane.
  const list = (value, what) => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0))
      fail("PRODUCT_GRAPH_CHECK_TARGET_INVALID", `${what}는 비어 있지 않은 글의 목록이다.`);
    const long = value.find((item) => item.length > PRODUCT_GRAPH_CHECK_MAX_ID);
    if (long) fail("PRODUCT_GRAPH_CHECK_TARGET_INVALID", `${what}의 한 항목이 ${PRODUCT_GRAPH_CHECK_MAX_ID}자를 넘는다: ${long.slice(0, 80)}…`);
    return value;
  };
  const featureIds = list(features, "기능 ID");
  const documentPaths = list(documents, "문서 경로").map((item) => nfc(item.replaceAll("\\", "/")));
  if (featureIds.length + documentPaths.length === 0) fail("PRODUCT_GRAPH_CHECK_TARGET_INVALID", "확인할 기능 ID나 문서 경로를 하나 이상 준다.");
  if (rationale !== null && (typeof rationale !== "string" || !rationale.trim() || rationale.length > 2000))
    fail("PRODUCT_GRAPH_CHECK_TARGET_INVALID", "근거는 비어 있지 않은 2000자 이하 글이다.");
  const projectRoot = inspected.project.projectRoot;
  const family = path.join(projectRoot, inspected.storage.directory, ...PRODUCT_GRAPH_DIRECTORY.split("/"));
  return withProjectMutation({ root: projectRoot, storage: inspected.storage, scope: "product-graph-check", timeoutMs: 0 }, () => {
    const current = currentBuildGraph(projectRoot);
    if (!current.ok) fail(current.code, current.reason);
    const checkable = checkableOf(current.ran);
    const missing = [];
    const items = [];
    for (const id of new Set(featureIds)) {
      const item = checkable.find((entry) => entry.kind === "meaning" && entry.id === id);
      if (item) items.push(item);
      else missing.push(`기능 ${echo(id)}: 그래프에 있는 기능의 뜻 줄이 없다`);
    }
    for (const document of new Set(documentPaths)) {
      const rows = checkable.filter((entry) => entry.kind === "documentRow" && entry.document === document);
      if (rows.length) items.push(...rows);
      else missing.push(`${echo(document)}: 코드와 잇는 행(기능→화면요소, 화면요소→기능, 화면→코드)이 없는 문서다`);
    }
    // Bounded: the first MISSING_LISTED names, each cut to ECHO_CHARS, then a count.
    if (missing.length)
      fail(
        "PRODUCT_GRAPH_CHECK_TARGET_MISSING",
        `확인할 것이 없다: ${missing.slice(0, MISSING_LISTED).join(" / ")}${missing.length > MISSING_LISTED ? ` / 외 ${missing.length - MISSING_LISTED}개` : ""}`,
      );
    const made = confirmationRecords({
      projectId: inspected.project.projectId,
      by: "agent-checked",
      rationale,
      graph: current.ran.graph,
      items,
      records: current.ran.loaded.checkRecords,
    });
    if (made.missingBasis) fail("PRODUCT_GRAPH_CHECK_TARGET_INVALID", "내용 해시가 없는 노드를 가리킨다. 다시 빌드한다.");
    if (made.tooLarge)
      fail(
        "PRODUCT_GRAPH_CHECK_LIMIT",
        `이 항목의 코드 근거가 확인 기록 하나(${PRODUCT_GRAPH_CHECK_MAX_BYTES}바이트)에 들어가지 않는다: ${describeItem(made.item)}`,
      );
    const written = made.records.length
      ? writeCheckRecords({ projectRoot, family, records: made.records })
      : { written: [], existing: [], notWritten: [], error: null };
    if (written.error && !written.written.length && !written.existing.length)
      fail("PRODUCT_GRAPH_CHECK_WRITE_FAILED", `확인 기록을 쓰지 못했다(${written.error}). 아무것도 쓰지 않았다.`);
    const kept = new Set([...written.written, ...written.existing]);
    const counted = made.records.filter((record) => kept.has(record.checkId));
    const confirmations = confirmationsOf({
      graph: current.ran.graph,
      computed: current.ran.computed,
      loaded: { ...current.ran.loaded, checkRecords: [...current.ran.loaded.checkRecords, ...counted] },
    });
    const stored = counted.flatMap((record) => record.items);
    return {
      status: !made.records.length ? "unchanged" : written.error ? "partial" : "recorded",
      ...(made.records.length ? {} : { reason: "고른 항목마다 같은 코드 근거의 에이전트 확인이 이미 지금 기록이다. 새로 쓰지 않았다." }),
      ...(written.error
        ? {
            reason: `확인 기록 ${made.records.length}개 가운데 ${kept.size}개만 썼다(${written.error}). 쓰지 못한 기록의 항목은 확인으로 치지 않는다.`,
            notWritten: written.notWritten,
            writeError: written.error,
          }
        : {}),
      records: [...kept],
      recordsWritten: written.written.length,
      by: "agent-checked",
      checkedAt: made.records[0]?.checkedAt ?? null,
      items: items.length,
      itemsRecorded: stored.length,
      itemsAlreadyCurrent: made.unchanged,
      meanings: stored.filter((item) => item.kind === "meaning").length,
      documentRows: stored.filter((item) => item.kind === "documentRow").length,
      confirmations: { status: confirmations.status, counts: confirmations.counts },
      note: `${PRODUCT_GRAPH_CHECK_NOTE} check.txt에는 다음 빌드부터 보인다.`,
      authority: "agent-check-of-code-not-user-approval",
      instructionAuthority: false,
      executionAuthority: false,
    };
  });
}

// ---------- run records (2.6) ----------

// Writes the run records of one command, as writeCheckRecords writes 확인
// records: everything checkable first, so a refusal writes nothing.
function writeRunRecords({ projectRoot, family, records }) {
  const folder = familyFolder(family, PRODUCT_GRAPH_RUN_DIRECTORY);
  if (folder.exists && !folder.folder) fail("PRODUCT_GRAPH_RUN_FOLDER_INVALID", `${PRODUCT_GRAPH_RUN_DIRECTORY}가 폴더가 아니라서 실행 기록을 쓰지 않는다.`);
  const directory = folder.path;
  const planned = records.map((record) => {
    const destination = path.join(directory, `${record.runId}.json`);
    assertNoLinkedComponents(projectRoot, destination);
    const text = json(record);
    if (Buffer.byteLength(text) > PRODUCT_GRAPH_RUN_MAX_BYTES)
      fail("PRODUCT_GRAPH_RUN_LIMIT", `실행 기록 하나가 ${PRODUCT_GRAPH_RUN_MAX_BYTES}바이트를 넘는다.`);
    const present = [destination, ...folder.all.map((other) => path.join(other, `${record.runId}.json`))].find((candidate) => fs.existsSync(candidate));
    if (present) {
      const stored = verifyProductGraphRun(JSON.parse(decodeProductGraphText(readBounded(present))), { projectId: record.projectId, runId: record.runId });
      if (stored.runHash !== record.runHash) fail("PRODUCT_GRAPH_RUN_COLLISION");
    }
    return { runId: record.runId, destination, text, existing: Boolean(present) };
  });
  let present = 0;
  try {
    for (const each of folder.all.length ? folder.all : [directory])
      present += listDirectory(each).filter((entry) => classifyProductGraphPath(`${PRODUCT_GRAPH_RUN_DIRECTORY}/${nfc(entry.name)}`)?.role === "run").length;
  } catch (error) {
    fail("PRODUCT_GRAPH_RUN_UNREADABLE", `실행 기록 폴더를 읽지 못해 쓰지 않는다(${error.code || "오류"}).`);
  }
  const added = planned.filter((entry) => !entry.existing).length;
  if (present + added > PRODUCT_GRAPH_RUN_MAX_RECORDS)
    fail(
      "PRODUCT_GRAPH_RUN_LIMIT",
      `실행 기록이 ${present}개 있어, ${added}개를 더 쓰면 한도 ${PRODUCT_GRAPH_RUN_MAX_RECORDS}개를 넘는다. 아무것도 쓰지 않았다.`,
    );
  const result = { written: [], existing: planned.filter((entry) => entry.existing).map((entry) => entry.runId), notWritten: [], error: null };
  for (const entry of planned) {
    if (entry.existing) continue;
    if (result.error) {
      result.notWritten.push(entry.runId);
      continue;
    }
    try {
      if (!result.written.length) fs.mkdirSync(directory, { recursive: true });
      atomicCreateArtifact(entry.destination, entry.text);
      result.written.push(entry.runId);
    } catch (error) {
      result.error = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code) ? error.code : "UNKNOWN";
      result.notWritten.push(entry.runId);
    }
  }
  return result;
}

const PRODUCT_GRAPH_RUN_NOTE =
  "Lode는 아무것도 실행하지 않았다. 프로젝트가 실행한 것과 그 출력을, 지금 빌드의 기능 내용·닿는 코드 해시와 함께 적었다. 출력 글은 이 기록에 그대로 남고 이식용 내보내기에 함께 실린다. Lode는 출력에 비밀이 있는지 보지 않는다.";

// Records runs a project made (what it ran, its state label, its raw output,
// its exit code), each with the 기능's content and reach hashes from the
// present build and the way code is read. Refusals mirror confirm: the build
// is not current, a 기능 is not in the graph, a bound (2,000 records, 256 KiB
// per record, 16 KiB per output: a longer output is refused, not cut).
export function addProductGraphRuns({ root = ".", runs = [], rationale = null } = {}) {
  const inspected = readProject(root);
  if (!inspected.project) fail("NOT_INITIALIZED", "실행 기록은 Lode 프로젝트에서만 쓴다. 이 폴더는 Lode 프로젝트가 아니다.");
  if (!Array.isArray(runs) || !runs.length) fail("PRODUCT_GRAPH_RUN_TARGET_INVALID", "runs는 실행 하나 이상의 목록이다.");
  if (rationale !== null && (typeof rationale !== "string" || !rationale.trim() || rationale.length > 2000))
    fail("PRODUCT_GRAPH_RUN_TARGET_INVALID", "근거는 비어 있지 않은 2000자 이하 글이다.");
  const given = runs.map((run, index) => {
    const where = `runs[${index}]`;
    if (!run || typeof run !== "object" || Array.isArray(run)) fail("PRODUCT_GRAPH_RUN_TARGET_INVALID", `${where}가 객체가 아니다.`);
    const unknown = Object.keys(run).find((key) => !["기능", "실행", "상태", "출력", "종료"].includes(key));
    if (unknown) fail("PRODUCT_GRAPH_RUN_TARGET_INVALID", `${where}에 모르는 항목 ${unknown}.`);
    if (typeof run.기능 !== "string" || !run.기능 || run.기능.length > PRODUCT_GRAPH_CHECK_MAX_ID)
      fail("PRODUCT_GRAPH_RUN_TARGET_INVALID", `${where}.기능은 기능 ID다.`);
    if (typeof run.실행 !== "string" || !run.실행.trim() || run.실행.length > 2000)
      fail("PRODUCT_GRAPH_RUN_TARGET_INVALID", `${where}.실행은 무엇을 실행했는지 적은 2000자 이하 글이다.`);
    if (run.상태 !== undefined && run.상태 !== null && (typeof run.상태 !== "string" || run.상태.length > 2000))
      fail("PRODUCT_GRAPH_RUN_TARGET_INVALID", `${where}.상태는 2000자 이하 글이다.`);
    if (typeof run.출력 !== "string") fail("PRODUCT_GRAPH_RUN_TARGET_INVALID", `${where}.출력은 출력 글이다.`);
    if (Buffer.byteLength(run.출력) > PRODUCT_GRAPH_RUN_MAX_OUTPUT)
      fail("PRODUCT_GRAPH_RUN_LIMIT", `${where}.출력이 ${PRODUCT_GRAPH_RUN_MAX_OUTPUT}바이트를 넘는다. 자르지 않고 거부한다.`);
    if (run.종료 !== undefined && run.종료 !== null && !Number.isSafeInteger(run.종료)) fail("PRODUCT_GRAPH_RUN_TARGET_INVALID", `${where}.종료는 정수다.`);
    return { 기능: run.기능, 실행: run.실행, 상태: run.상태 ?? null, 출력: run.출력, 종료: run.종료 ?? null };
  });
  const projectRoot = inspected.project.projectRoot;
  const family = path.join(projectRoot, inspected.storage.directory, ...PRODUCT_GRAPH_DIRECTORY.split("/"));
  return withProjectMutation({ root: projectRoot, storage: inspected.storage, scope: "product-graph-run", timeoutMs: 0 }, () => {
    const current = currentBuildGraph(projectRoot);
    if (!current.ok) fail(current.code, current.reason);
    const nodes = new Map(current.ran.graph.nodes.map((node) => [node.id, node]));
    const missing = [...new Set(given.map((run) => run.기능))].filter((id) => nodes.get(id)?.type !== "기능");
    if (missing.length)
      fail(
        "PRODUCT_GRAPH_RUN_TARGET_MISSING",
        `그래프에 없는 기능이다: ${missing.slice(0, MISSING_LISTED).map(echo).join(", ")}${missing.length > MISSING_LISTED ? ` 외 ${missing.length - MISSING_LISTED}개` : ""}`,
      );
    const reader = JSON.parse(readerKey(current.ran.graph.inputs.reader));
    const recordedAt = new Date().toISOString();
    const withBasis = given.map((run) => {
      const node = nodes.get(run.기능);
      return { ...run, basis: { id: node.id, contentSha256: node.contentSha256, reachSha256: node.reachSha256 } };
    });
    // Split by size: runs in order, a new record when one would pass a bound.
    const records = [];
    let batch = [];
    const make = (list) =>
      productGraphRunRecord({
        projectId: inspected.project.projectId,
        recordedAt,
        rationale,
        reader,
        runs: list.map((run, index) => ({ 번호: index + 1, ...run })),
      });
    for (const run of withBasis) {
      const next = [...batch, run];
      if (batch.length && (next.length > PRODUCT_GRAPH_RUN_MAX_RUNS || Buffer.byteLength(json(make(next))) > PRODUCT_GRAPH_RUN_MAX_BYTES)) {
        records.push(make(batch));
        batch = [run];
      } else batch = next;
    }
    if (batch.length) records.push(make(batch));
    const written = writeRunRecords({ projectRoot, family, records });
    if (written.error && !written.written.length && !written.existing.length)
      fail("PRODUCT_GRAPH_RUN_WRITE_FAILED", `실행 기록을 쓰지 못했다(${written.error}). 아무것도 쓰지 않았다.`);
    const kept = new Set([...written.written, ...written.existing]);
    return {
      status: written.error ? "partial" : "recorded",
      ...(written.error
        ? { reason: `실행 기록 ${records.length}개 가운데 ${kept.size}개만 썼다(${written.error}).`, notWritten: written.notWritten, writeError: written.error }
        : {}),
      records: [...kept],
      recordsWritten: written.written.length,
      runs: records
        .filter((record) => kept.has(record.runId))
        .flatMap((record) => record.runs.map((run) => ({ id: runLabel(record.runId, run.번호), 기능: run.기능, 실행: run.실행 }))),
      recordedAt,
      lodeRan: false,
      note: `${PRODUCT_GRAPH_RUN_NOTE} check.txt와 연결에는 다음 빌드부터 보인다.`,
      storedAt: `${PRODUCT_GRAPH_DIRECTORY}/${PRODUCT_GRAPH_RUN_DIRECTORY}/`,
      authority: "project-supplied-run-evidence-not-lode-execution",
      instructionAuthority: false,
      executionAuthority: false,
    };
  });
}

function physicalFile(base, relative) {
  let current = base;
  for (const part of relative.split("/")) {
    const matches = listDirectory(current).filter((entry) => nfc(entry.name) === part);
    if (matches.length > 1) fail("PRODUCT_GRAPH_NAME_TWIN", `같은 이름이 유니코드 정규화만 다르게 두 번 있다: ${relative}`);
    if (!matches.length) return null;
    current = path.join(current, matches[0].name);
  }
  return current;
}

// With an approval, the code basis of the approved document's rows as the
// current build has it ("user-approved"). A build that is not current, or a
// document without such rows, approves the text as before and says the code
// basis was not recorded; this never blocks the approval. Computed against
// the graph from before this approval was written (the build's own).
function approvedCodeBasisRecord({ projectRoot, projectId, document, digest, rationale }) {
  // Nothing here may stop the approval: every failure becomes "not recorded".
  try {
    const current = currentBuildGraph(projectRoot);
    if (!current.ok)
      return { result: { status: "not-recorded", code: current.code, reason: `코드 근거는 기록하지 않았다(문서 승인은 됐다): ${current.reason}` } };
    const items = checkableOf(current.ran).filter((item) => item.kind === "documentRow" && item.document === document && item.documentTextSha256 === digest);
    if (!items.length) return { result: { status: "not-recorded", reason: "이 문서에는 코드와 잇는 행이 없어 코드 근거를 기록하지 않았다" } };
    const made = confirmationRecords({ projectId, by: "user-approved", rationale, graph: current.ran.graph, items, records: current.ran.loaded.checkRecords });
    if (made.missingBasis)
      return {
        result: { status: "not-recorded", code: "PRODUCT_GRAPH_CHECK_TARGET_INVALID", reason: "내용 해시가 없는 노드를 가리켜 코드 근거를 기록하지 않았다" },
      };
    if (made.tooLarge)
      return {
        result: {
          status: "not-recorded",
          code: "PRODUCT_GRAPH_CHECK_LIMIT",
          reason: `이 행의 코드 근거가 확인 기록 하나에 들어가지 않아 코드 근거를 기록하지 않았다: ${describeItem(made.item)}`,
        },
      };
    return { records: made.records, rows: items.length, unchanged: made.unchanged };
  } catch (error) {
    return {
      result: {
        status: "not-recorded",
        code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code) ? error.code : "PRODUCT_GRAPH_CHECK_INVALID",
        reason: "코드 근거를 계산하지 못해 기록하지 않았다(문서 승인은 됐다)",
      },
    };
  }
}

// Records the user's approval of one document's exact current bytes. The
// caller states the digest the user reviewed; a document changed since then is
// refused, never approved by name.
export function approveProductGraphDocument({ root = ".", document, expectedSha256, rationale } = {}) {
  const inspected = readProject(root);
  if (!inspected.project) fail("NOT_INITIALIZED", "승인은 Lode 프로젝트에서만 기록한다. 이 폴더는 Lode 프로젝트가 아니다.");
  const relative = typeof document === "string" ? nfc(document.replaceAll("\\", "/")) : "";
  const target = classifyProductGraphPath(relative);
  if (!target?.approvable) fail("PRODUCT_GRAPH_APPROVAL_TARGET_INVALID", "승인할 수 있는 것은 제품 그래프 문서와 정책 파일이다.");
  const projectRoot = inspected.project.projectRoot;
  const family = path.join(projectRoot, inspected.storage.directory, ...PRODUCT_GRAPH_DIRECTORY.split("/"));
  return withProjectMutation({ root: projectRoot, storage: inspected.storage, scope: "product-graph-approval", timeoutMs: 0 }, () => {
    assertNoLinkedComponents(projectRoot, family);
    const file = physicalFile(family, relative);
    if (!file) fail("PRODUCT_GRAPH_DOCUMENT_MISSING", `${relative} 문서가 없다.`);
    const bytes = readBounded(file);
    decodeProductGraphText(bytes);
    const current = productGraphApprovalDigest(bytes);
    if (current !== expectedSha256)
      fail("PRODUCT_GRAPH_APPROVAL_STALE", `${relative}가 사용자가 본 내용과 다르다. 지금 내용을 다시 보여 주고 다시 승인받아야 한다.`);
    const record = productGraphApprovalRecord({ projectId: inspected.project.projectId, document: relative, documentTextSha256: current, rationale });
    const basis = approvedCodeBasisRecord({ projectRoot, projectId: inspected.project.projectId, document: relative, digest: current, rationale });
    // A 승인 folder stored decomposed is the same folder, never a second one.
    const directory = familyFolder(family, PRODUCT_GRAPH_APPROVAL_DIRECTORY).path;
    const destination = path.join(directory, `${record.approvalId}.json`);
    assertNoLinkedComponents(projectRoot, destination);
    let status = "recorded";
    if (fs.existsSync(destination)) {
      const existing = verifyProductGraphApproval(JSON.parse(decodeProductGraphText(readBounded(destination))), {
        projectId: inspected.project.projectId,
        approvalId: record.approvalId,
      });
      if (existing.approvalHash !== record.approvalHash) fail("PRODUCT_GRAPH_APPROVAL_COLLISION");
      status = "existing";
    } else {
      fs.mkdirSync(directory, { recursive: true });
      atomicCreateArtifact(destination, json(record));
    }
    // The approval is written; the code basis never turns it into a failure.
    let codeBasis = basis.result;
    if (basis.records)
      try {
        const written = basis.records.length
          ? writeCheckRecords({ projectRoot, family, records: basis.records })
          : { written: [], existing: [], notWritten: [], error: null };
        const kept = [...written.written, ...written.existing];
        codeBasis = {
          status: !basis.records.length ? "unchanged" : !written.error ? "recorded" : kept.length ? "partial" : "not-recorded",
          ...(written.error
            ? {
                code: written.error,
                reason: kept.length
                  ? `코드 근거 기록 ${basis.records.length}개 가운데 ${kept.length}개만 썼다(문서 승인은 됐다). 쓰지 못한 기록의 행은 확인으로 치지 않는다.`
                  : "코드 근거 기록을 쓰지 못했다(문서 승인은 됐다)",
                notWritten: written.notWritten,
              }
            : {}),
          records: kept,
          recordsWritten: written.written.length,
          rows: basis.rows,
          rowsAlreadyCurrent: basis.unchanged,
          ...(basis.records.length ? {} : { reason: "행마다 같은 코드 근거의 사용자 승인 기록이 이미 지금 기록이다. 새로 쓰지 않았다." }),
        };
      } catch (error) {
        codeBasis = {
          status: "not-recorded",
          code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code) ? error.code : "PRODUCT_GRAPH_CHECK_LIMIT",
          reason: "코드 근거 기록을 쓰지 못했다(문서 승인은 됐다)",
        };
      }
    return {
      status,
      document: relative,
      codeBasis,
      documentTextSha256: current,
      digestBasis: record.digestBasis,
      approved: true,
      authority: "explicit-user-product-graph-approval",
      note: "이 문서는 지금 내용 그대로일 때만 승인으로 센다. 고치면 다시 승인받아야 한다.",
      instructionAuthority: false,
      executionAuthority: false,
    };
  });
}

export { CORE_HEADINGS };
