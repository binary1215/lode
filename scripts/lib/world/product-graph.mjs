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
import { readGraphProject } from "./discovery-index.mjs";
import { withProjectMutation } from "../storage/project-mutation-lock.mjs";
import {
  PRODUCT_GRAPH_APPROVAL_DIRECTORY,
  PRODUCT_GRAPH_BUILD_DIRECTORY,
  PRODUCT_GRAPH_DIRECTORY,
  PRODUCT_GRAPH_MAX_FILES,
  PRODUCT_GRAPH_RULES_FILE,
  classifyProductGraphPath,
  decodeProductGraphText,
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
import { extractProductGraphCode } from "./product-graph-extraction.mjs";

export const PRODUCT_GRAPH_VERSION = 1;
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const nfc = (name) => name.normalize("NFC");

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
  return fs.readFileSync(file);
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
  return { files: files.sort((a, b) => compare(a.path, b.path)), unrecognized: unrecognized.sort() };
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
  const approvals = new Set();
  const approvalIssues = [];
  for (const file of read.files.filter((item) => item.role === "approval")) {
    if (!inputs.approvals) continue;
    try {
      const record = verifyProductGraphApproval(JSON.parse(decodeProductGraphText(file.bytes)), { projectId: inputs.projectId, approvalId: file.approvalId });
      approvals.add(`${record.document}\0${record.documentSha256}`);
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
    const approved = file.approvable ? approvals.has(`${file.path}\0${file.sha256}`) : null;
    documents.push({
      path: file.path,
      role: file.role,
      nodeType: file.nodeType,
      id: file.id || null,
      sha256: file.sha256,
      approvable: Boolean(file.approvable),
      status: file.approvable ? (approved ? "승인" : "추정") : "직접 씀",
      estimateKind: approved || !file.approvable ? null : parsed.estimate?.kind || null,
      estimateWritten: parsed.estimate?.written ?? null,
      parsed,
    });
  }
  return { documents, unrecognized: read.unrecognized, approvalIssues, approvalsRead: inputs.approvals };
}

function basisLabel(document) {
  if (document.status !== "추정") return null;
  return document.estimateKind ? `추정: ${document.estimateKind}` : "추정: 어느 쪽 추정인지 적지 않음";
}

function absence(documents, nodeType, includeEstimates) {
  const name = DOCUMENT_NAMES[nodeType];
  const all = documents.filter((item) => item.nodeType === nodeType && item.role !== "meaning");
  if (!all.length) return `${SUBJECT[name]} 없다`;
  if (!includeEstimates && all.every((item) => item.status === "추정")) return `승인된 ${SUBJECT[name]} 없다 (추정 ${all.length}개는 기본 검사에 쓰지 않는다)`;
  return null;
}

function compute({ extraction, loaded, includeEstimates }) {
  const { documents } = loaded;
  const used = (document) => document.status !== "추정" || includeEstimates;
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
  for (const document of documents)
    if (document.status === "추정" && document.estimateWritten && !document.estimateKind)
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
    lists: {
      missingIds: missing.sort((a, b) => compare(a.at.path, b.at.path) || a.at.line - b.at.line || compare(a.id, b.id)),
      unpointedFunctions: unpointed,
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
      estimated: approvable.filter((item) => item.status === "추정").length,
      list: approvable.map(({ path: documentPath, nodeType, id, sha256, status, estimateKind }) => ({
        path: documentPath,
        nodeType,
        id,
        sha256,
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
    for (const handler of entry.handlers) edges.push({ type: "기능→코드", from: entry.id, to: handler, at: entry.positions[0] || null });
  }
  for (const node of extraction.codeNodes) nodes.push(node);
  for (const reference of extraction.references)
    edges.push({ type: reference.type, from: reference.from, to: reference.to, at: reference.source, count: reference.count });
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
  return {
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
      sourceFiles: extraction.scannedFiles,
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
}

// ---------- readable text ----------

const where = (at) => (at ? `${at.path}:${at.line}` : "");
const labelText = (labels) => (labels?.length ? ` [${labels.join(", ")}]` : "");
const LIST_LIMIT = 50;

function listLines(items, render) {
  const lines = items.slice(0, LIST_LIMIT).map((item) => `  - ${render(item)}`);
  if (items.length > LIST_LIMIT) lines.push(`  - 외 ${items.length - LIST_LIMIT}개 (구조화된 결과에 모두 있다)`);
  return lines;
}

export function renderProductGraphText(result) {
  const lines = [...renderLimits(result.limits), "", "제품 그래프 정합성 검사", ""];
  result.checks.forEach((check, index) => {
    lines.push(`${index + 1}. ${check.heading} — ${check.meaning}`);
    if (check.outcome === "검사 못 함") lines.push(`   검사 못 함: ${check.reason}`);
    else if (check.outcome === "0건") lines.push("   0건");
    else {
      lines.push(`   ${check.findings.length}건`);
      for (const finding of check.findings) {
        if (check.key === "element-function-without-activity")
          lines.push(`   - ${finding.id} → 기능 ${finding.functions.join(", ")} (${where(finding.at)})${labelText(finding.labels)}`);
        else if (check.key === "screen-without-activity")
          lines.push(`   - ${finding.id}${finding.name ? ` ${finding.name}` : ""} (${where(finding.at)})${labelText(finding.labels)}`);
        else if (check.key === "screen-policy-differs") {
          lines.push(`   - ${finding.screen}의 정책 ${finding.id} (${where(finding.at)}, 정책 ${where(finding.policyAt)})${labelText(finding.labels)}`);
          for (const difference of finding.differences) lines.push(`     ${difference.field}: 화면설계서 "${difference.screen}" / 정책 "${difference.policy}"`);
        } else if (check.key === "journey-order-differs")
          lines.push(`   - ${finding.id} → ${finding.next}: ${finding.problem} (${where(finding.at)})${labelText(finding.labels)}`);
      }
    }
    if (check.sideBySide) {
      lines.push(`   제품코어${labelText(check.sideBySide.labels)}`);
      for (const part of check.sideBySide.제품코어)
        lines.push(`     ${part.heading}: ${part.text === null ? "(절 없음)" : part.text.replace(/\s+/g, " ").slice(0, 200)}`);
      lines.push("   정책");
      for (const policy of check.sideBySide.정책)
        lines.push(`     ${policy.id} (${policy.kind}) 조건: ${policy.조건} / 주체: ${policy.주체} / 행위: ${policy.행위}`);
    }
    lines.push("");
  });
  const lists = result.lists;
  lines.push(`문서가 가리키는데 없는 ID: ${lists.missingIds.length}건`);
  lines.push(
    ...listLines(lists.missingIds, (item) => `${item.kind} ${item.id} (${where(item.at)})${item.note ? ` — ${item.note}` : ""}${labelText(item.labels)}`),
  );
  const noScreens = result.counts["화면"] === 0;
  lines.push(`어떤 화면요소·화면도 가리키지 않는 기능: ${lists.unpointedFunctions.length}개${noScreens ? " (화면설계서가 없어 모든 기능이 여기에 든다)" : ""}`);
  lines.push(...listLines(lists.unpointedFunctions, (id) => id));
  const unreached = lists.unreachedCode;
  const calls = lists.unresolvedReferences;
  lines.push(
    `어느 기능에서도 닿지 않는 코드: 선언 ${unreached.declarations}개 — 풀린 호출 ${calls.resolved} / 전체 ${calls.all}로 따라간 결과다. '닿지 않음'은 풀린 경로를 찾지 못했다는 뜻이고, 죽은 코드라는 뜻이 아니다.`,
  );
  lines.push(`  아무것도 닿지 않는 파일 ${unreached.filesNothingReached}개, 일부만 닿는 파일 ${unreached.filesPartlyReached}개. 많은 파일부터:`);
  lines.push(
    ...listLines(unreached.files, (file) =>
      file.declarations.length
        ? `${file.path} — 선언 ${file.declarations.length}개${file.nothingReached ? " (파일 전체가 닿지 않음)" : ""}`
        : `${file.path} — 선언 없는 파일, 닿지 않음`,
    ),
  );
  lines.push(`하나로 정하지 못한 호출: ${calls.unresolved}개 (전체 ${calls.all}개 중). 이유별:`);
  for (const reason of calls.byReason) lines.push(`  - ${reason.label}: ${reason.count}개 — 정하려면: ${reason.settle}`);
  const looked = lists.notLookedAt;
  lines.push(
    `코드로 읽지 않은 파일(보지 않음): ${looked.files}개${looked.byExtension.length ? ` (${looked.byExtension.map((item) => `${item.extension} ${item.count}`).join(", ")})` : ""}. 테스트로 분류해 코드 층에 넣지 않은 코드 파일 ${looked.testCodeFiles}개, 읽지 못한 코드 파일 ${looked.unreadableCodeFiles}개.`,
  );
  if (looked.skipped.length) lines.push(`  건너뛴 것: ${looked.skipped.map((item) => `${item.reason} ${item.count}`).join(", ")}`);
  lines.push(`사라진 기능의 뜻: ${lists.vanishedMeanings.length}개`);
  lines.push(...listLines(lists.vanishedMeanings, (item) => `${item.id} — "${item.text}" (${where(item.at)})`));
  lines.push(`처리 코드를 찾지 못한 기능: ${lists.unresolvedHandlers.length}개`);
  lines.push(...listLines(lists.unresolvedHandlers, (item) => `${item.id} (${where(item.position)}) — ${item.reason}`));
  lines.push(`기능으로 삼지 않은 연결: ${lists.notTakenBindings.length}개`);
  lines.push(
    ...listLines(
      lists.notTakenBindings,
      (item) =>
        `${item.path}:${item.line} ${item.component} ${item.emitter ? `${item.emitter} ` : ""}${item.event} → ${item.target || "(대상 없음)"} — ${item.pattern}`,
    ),
  );
  lines.push(`화면 코드인데 규칙이 없음: ${lists.uiWithoutRule.length}개`);
  lines.push(...listLines(lists.uiWithoutRule, (item) => `${item.path} — ${item.sign}`));
  if (lists.outOfScope.length) {
    lines.push(`범위 밖으로 둔 입구: ${lists.outOfScope.length}개`);
    lines.push(...listLines(lists.outOfScope, (item) => `${item.id} (${where(item.position)})`));
  }
  if (lists.ruleIssues.length) {
    lines.push(`호출 방식 표 문제: ${lists.ruleIssues.length}개`);
    lines.push(...listLines(lists.ruleIssues, (item) => `${item.종류}: ${item.path} — ${item.reason}`));
  }
  lines.push("노드 수:");
  for (const type of NODE_TYPES) {
    const count = result.counts[type];
    const usedCount = result.usedCounts[type];
    lines.push(`  - ${type} ${count}${typeof usedCount === "number" && usedCount !== count ? ` (검사에 쓴 것 ${usedCount})` : ""}`);
  }
  lines.push("문서별 상태:");
  lines.push(
    ...listLines(
      result.documents.list,
      (item) => `${item.path} — ${item.status}${item.status === "추정" ? ` (${item.estimateKind || "어느 쪽 추정인지 적지 않음"})` : ""}`,
    ),
  );
  if (lists.formatIssues.length) {
    lines.push(`문서 형식 문제: ${lists.formatIssues.length}개`);
    lines.push(...listLines(lists.formatIssues, (item) => `${item.path}:${item.line} ${item.kind}${item.detail ? `: ${item.detail}` : ""}`));
  }
  if (lists.unrecognizedFiles.length) {
    lines.push(`읽지 않은 파일: ${lists.unrecognizedFiles.length}개`);
    lines.push(...listLines(lists.unrecognizedFiles, (item) => item));
  }
  if (lists.approvalIssues.length) {
    lines.push(`승인 기록으로 읽지 못한 파일: ${lists.approvalIssues.length}개`);
    lines.push(...listLines(lists.approvalIssues, (item) => `${item.path} — ${item.reason}`));
  }
  return lines.join("\n") + "\n";
}

// ---------- what this graph cannot answer ----------

export const LIMITS_TITLE = "이 그래프가 답하지 못하는 것";
const NOT_TOLD_APART = Object.freeze(["framework-invoked", "render", "type reference", "re-render", "response", "enqueue", "navigate", "http", "defines"]);
const UI_SCAN_LIMITS = Object.freeze([
  "UI 연결은 패턴을 글자에 맞춰 찾는다. 여러 줄에 걸친 연결, 문자열로 만든 연결, 툴킷이 이름으로 자동으로 잇는 연결, 이벤트 이름을 실행 중에 계산하는 연결은 보지 못한다.",
  "코드인지는 줄 단위로만 가린다(그 줄의 앞쪽 주석과 문자열). 블록 주석이나 여러 줄 문자열 안의 연결은 걸러내지 못하고, HTML·Vue·Svelte 파일에서는 주석도 걸러내지 못한다.",
  "템플릿의 같은 태그 id는 가장 가까운 < 와 > 사이에서 찾는다. 이벤트 메서드는 이름으로만 찾고 상속은 확인하지 않는다.",
]);

// One object for the structured result and generated files; the text renders
// it first. Facts here are not repeated elsewhere in the text.
function limitsOf({ extraction, computed, includeEstimates, loaded, callbacks }) {
  const used = computed.documentSummary.list.filter((item) => item.status === "승인" || includeEstimates).map((item) => item.path);
  return {
    title: LIMITS_TITLE,
    codeReading: "코드는 정규식 기반 소스 분석으로 읽었다. 구문 트리가 아니고 타입 정보가 없다.",
    calls: { resolved: extraction.referenceSummary.resolvedCalls, all: extraction.referenceSummary.allCalls, callbacks },
    referenceKinds: { emitted: ["call", "callback"], notToldApart: NOT_TOLD_APART },
    notExtracted: { nodeTypes: NOT_EXTRACTED, edges: ["navigate"], grouping: "C4 묶음" },
    uiBindingScan: UI_SCAN_LIMITS,
    execution: "아무것도 실행하지 않았다. 문서와 코드를 비교할 뿐이고, 어느 발견도 실행 근거에 기대지 않는다.",
    documents: {
      approved: computed.documentSummary.approved,
      estimated: computed.documentSummary.estimated,
      approvalsRead: loaded.approvalsRead,
      includeEstimates,
      used,
    },
  };
}

function renderLimits(limits) {
  const documents = limits.documents;
  const usage = !documents.approvalsRead
    ? `독립 실행이라 승인 기록을 읽지 않았다(모든 문서가 추정). 이번 실행은 ${documents.includeEstimates ? `추정 문서 ${documents.used.length}개를 썼고, 그것에 기댄 결과에는 [추정: …]을 붙였다` : "추정 문서를 쓰지 않았다"}.`
    : documents.includeEstimates
      ? `이번 실행은 승인과 추정 문서 ${documents.used.length}개를 모두 썼고, 추정에 기댄 결과에는 [추정: …]을 붙였다.`
      : `이번 실행은 승인된 문서 ${documents.used.length}개만 썼다.`;
  return [
    limits.title,
    `- ${limits.codeReading}`,
    `- 호출 ${limits.calls.all}개 중 ${limits.calls.resolved}개를 하나의 선언으로 풀었다. 풀린 것만 코드→코드 연결이 된다.`,
    `- reference 종류는 ${limits.referenceKinds.emitted.join(", ")}만 적는다. ${limits.referenceKinds.notToldApart.join(", ")}는 구별하지 못해 적지 않는다.`,
    `- 뽑지 않은 것: ${limits.notExtracted.nodeTypes.join(", ")} 노드, ${limits.notExtracted.edges.join(", ")} 연결, ${limits.notExtracted.grouping}.`,
    ...limits.uiBindingScan.map((line) => `- ${line}`),
    `- ${limits.execution}`,
    `- 문서: 승인 ${documents.approved}, 추정 ${documents.estimated}. ${usage}`,
  ];
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
  result.text = renderProductGraphText(result);
  return { inputs, rules, extraction, loaded, computed, result };
}

export function checkProductGraph(options = {}) {
  const { result } = run(options, { requireOutput: false });
  return { status: "checked", readOnly: true, persisted: false, ...result };
}

export function buildProductGraph(options = {}) {
  const ran = run(options, { requireOutput: true });
  const { inputs, result } = ran;
  const graph = graphDocument(ran);
  const output = inputs.outputDirectory;
  const { text, ...structured } = result;
  const files = [
    ["graph.json", json(graph)],
    ["check.json", json(structured)],
    ["check.txt", text],
  ];
  const write = () => {
    fs.mkdirSync(output, { recursive: true });
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
  };
  if (inputs.mode === "project") withProjectMutation({ root: inputs.projectRoot, storage: inputs.storage, scope: "product-graph-build", timeoutMs: 0 }, write);
  else write();
  return {
    status: "built",
    mode: result.mode,
    written: files.map(([name, content]) => ({ name, bytes: Buffer.byteLength(content), sha256: sha256Hex(content) })),
    outputLocation: inputs.mode === "project" ? `${inputs.storage.directory}/${PRODUCT_GRAPH_DIRECTORY}/${PRODUCT_GRAPH_BUILD_DIRECTORY}` : output,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    ...result,
  };
}

function physicalFile(base, relative) {
  let current = base;
  for (const part of relative.split("/")) {
    const match = listDirectory(current).find((entry) => nfc(entry.name) === part);
    if (!match) return null;
    current = path.join(current, match.name);
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
    const file = physicalFile(family, relative);
    if (!file) fail("PRODUCT_GRAPH_DOCUMENT_MISSING", `${relative} 문서가 없다.`);
    const bytes = readBounded(file);
    decodeProductGraphText(bytes);
    const current = sha256Hex(bytes);
    if (current !== expectedSha256)
      fail("PRODUCT_GRAPH_APPROVAL_STALE", `${relative}가 사용자가 본 내용과 다르다. 지금 내용을 다시 보여 주고 다시 승인받아야 한다.`);
    const record = productGraphApprovalRecord({ projectId: inspected.project.projectId, document: relative, documentSha256: current, rationale });
    const directory = path.join(family, PRODUCT_GRAPH_APPROVAL_DIRECTORY);
    const destination = path.join(directory, `${record.approvalId}.json`);
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
      documentSha256: current,
      approved: true,
      authority: "explicit-user-product-graph-approval",
      note: "이 문서는 지금 내용 그대로일 때만 승인으로 센다. 고치면 다시 승인받아야 한다.",
      instructionAuthority: false,
      executionAuthority: false,
    };
  });
}

export { CORE_HEADINGS };
