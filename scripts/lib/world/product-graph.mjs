// 제품 그래프 (bundle 1): build, check and approve.
//
// The model, node types, check phrases and Korean vocabulary are the original
// project's (Won6314/head-agent-core, graph/build/02a-graph-definitions.md),
// adopted unchanged by the user on 2026-11-15. This is not the existing
// Product Model and does not read, write or reinterpret product-model.json.
// The family is not a World input.
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
  PRODUCT_GRAPH_DIRECTORY,
  PRODUCT_GRAPH_MAX_FILE_BYTES,
  PRODUCT_GRAPH_MAX_FILES,
  PRODUCT_GRAPH_RULES_FILE,
  classifyProductGraphPath,
  decodeProductGraphText,
  productGraphApprovalDigest,
  productGraphApprovalRecord,
  productGraphSubdirectories,
  verifyProductGraphApproval,
  verifyProductGraphRules,
} from "../storage/product-graph-store.mjs";
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

export const PRODUCT_GRAPH_VERSION = 1;
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
export const NOT_EXTRACTED = Object.freeze(["데이터", "외부 연결", "DB", "계측 이벤트"]);

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
// listed, never parsed.
function readDocumentFiles(directory) {
  const files = [],
    unrecognized = [];
  const visit = (prefix, absolute) => {
    for (const entry of listDirectory(absolute)) {
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
  };
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
  return { documents, unrecognized: read.unrecognized, twins: read.twins, approvalIssues, approvalsRead: inputs.approvals };
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
      edges.push({ type: "기능→코드", from: entry.id, to: handler, at: entry.handlerAt?.[handler] || entry.positions[0] || null });
  }
  for (const node of extraction.codeNodes) nodes.push(node);
  for (const reference of extraction.references)
    edges.push({ type: reference.type, from: reference.from, to: reference.to, at: reference.source, count: reference.count });
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
      ...walk.renderGuide(result.guide),
      ...walk.renderChecks(result.checks),
      ...walk.renderGapLists(walk.gapLists(result, nodeTypes)),
    ].join("\n") + "\n"
  );
}

// ---------- what this graph cannot answer ----------

export const LIMITS_TITLE = "이 그래프가 답하지 못하는 것";
const NOT_TOLD_APART = Object.freeze(["framework-invoked", "render", "type reference", "re-render", "response", "enqueue", "navigate", "http", "defines"]);
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
    referenceKinds: { emitted: ["call", "callback"], notToldApart: NOT_TOLD_APART },
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
    referenceSummary: {
      resolvedCalls: extraction.referenceSummary.resolvedCalls,
      callbacks,
      unresolvedCalls: extraction.referenceSummary.unresolvedCalls,
    },
    documents: { ...computed.documentSummary, approvalsRead: loaded.approvalsRead },
  };
  result.limits = limitsOf({ extraction, computed, includeEstimates, loaded, callbacks });
  const graph = graphDocument({ extraction, loaded, computed, inputs, rules, result });
  const baseline = compareToBaseline({ inputs, graph, computed, readFiles: extraction.readFiles, takeIfMissing: requireOutput });
  result.changes = baseline.changes;
  result.text = renderProductGraphText(result);
  return { inputs, rules, extraction, loaded, computed, result, graph, baseline };
}

const baselineFile = (inputs) => path.join(inputs.outputDirectory, PRODUCT_GRAPH_BASELINE_FILE);

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
    if (inputs.mode === "project") assertNoLinkedComponents(inputs.projectRoot, retainedFile(inputs));
    let retained = readRetainedContent(retainedFile(inputs), { baseline: read.baseline, baselineBytes });
    // A baseline from before retained content existed gets its "before" from
    // this build where (and only where) a node's content is the baseline's. A
    // build writes it once; a check computes the same in memory.
    let retainedCreate = null;
    if (retained.status === "missing") {
      const hashes = new Map(read.baseline.nodes.map(([id, , , , , contentSha256]) => [id, contentSha256]));
      retainedCreate = retainedContentFor({
        graph,
        baselineBytes,
        readText: (relative) => readFiles.get(relative),
        unresolvedHandlers: computed.lists?.unresolvedHandlers || [],
        only: (node) => Boolean(node.contentSha256) && hashes.get(node.id) === node.contentSha256,
      });
      retained = retainedView(retainedCreate);
    }
    return {
      changes: compareWithBaseline(graph, read.baseline, { meaningLines, retained }),
      state: { status: "kept", setAt: read.baseline.setAt },
      retainedCreate,
    };
  }
  if (read.missing && takeIfMissing) {
    const taken = baselineFromGraph(graph, { setAt: new Date().toISOString() });
    const retainedCreate = retainedContentFor({
      graph,
      baselineBytes: Buffer.from(serializeBaseline(taken)),
      readText: (relative) => readFiles.get(relative),
      unresolvedHandlers: computed.lists?.unresolvedHandlers || [],
    });
    return {
      changes: compareWithBaseline(graph, taken, { meaningLines, retained: retainedView(retainedCreate) }),
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
  return { status: "checked", readOnly: true, persisted: false, ...result };
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
  if (baseline.retainedCreate) created.push([PRODUCT_GRAPH_RETAINED_CONTENT_FILE, serializeRetainedContent(baseline.retainedCreate)]);
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
    for (const [name, content] of files) atomicWriteArtifact(path.join(output, name), content);
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
  return {
    status: "built",
    mode: result.mode,
    written: [...files, ...created].map(([name, content]) => ({ name, bytes: Buffer.byteLength(content), sha256: sha256Hex(content) })),
    baseline: baseline.state || { status: "none" },
    outputLocation: inputs.mode === "project" ? `${inputs.storage.directory}/${PRODUCT_GRAPH_DIRECTORY}/${PRODUCT_GRAPH_BUILD_DIRECTORY}` : output,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    ...result,
  };
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
        readDocumentFiles(inputs.documentsDirectory)
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
  // The hashes of the build files are taken only when a question needs them
  // (a later page, the impact preview); a plain question does not pay for them.
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
    freshness: freshnessOf(inputs, graph),
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
  return readRetainedContent(path.join(read.directory, PRODUCT_GRAPH_RETAINED_CONTENT_FILE), { baseline: read.baselineEvidence, baselineBytes });
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
    atomicWriteArtifact(file, baselineText);
    atomicWriteArtifact(contentFile, serializeRetainedContent(retained));
    return { baseline, previous };
  };
  const { baseline, previous } =
    inputs.mode === "project"
      ? withProjectMutation({ root: inputs.projectRoot, storage: inputs.storage, scope: "product-graph-build", timeoutMs: 0 }, move)
      : move();
  return {
    status: "moved",
    setAt: baseline.setAt,
    previous,
    dropped,
    text: `기준을 옮겼다: ${baseline.setAt}. 바뀐 것 ${dropped.changes}개와 다시 볼 것 ${dropped.reviewAgain}개가 목록에서 빠진다(다음 빌드부터).${previous ? ` 이전 기준: ${previous.setAt}.` : " 이전 기준은 없었다."}\n`,
    graphUnchanged: true,
  };
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
    const directory = path.join(family, PRODUCT_GRAPH_APPROVAL_DIRECTORY);
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
    return {
      status,
      document: relative,
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
