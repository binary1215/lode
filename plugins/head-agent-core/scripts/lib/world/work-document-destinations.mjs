import fs from "node:fs";
import path from "node:path";
import { safeSessionPath } from "../session/session-paths.mjs";
import { atomicCreateArtifact, atomicWriteArtifact } from "../core/fs-atomic.mjs";
import { workDocumentHash } from "./work-document-source.mjs";
import { documentFailure } from "./work-document-store.mjs";

const normalize = (text) => text.replaceAll("\r\n", "\n").trimEnd();
export const sameDocumentText = (a, b) => typeof a === "string" && typeof b === "string" && normalize(a) === normalize(b);
const safeId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,180}$/.test(value);
// Readable vault names: no path separators, reserved or link-breaking characters,
// control characters, leading dot/space or trailing dot/space.
export const safeVaultName = (value) =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 180 &&
  value === value.normalize("NFC") &&
  !/[\x00-\x1f\x7f\\/:*?"<>|#^[\]]/.test(value) &&
  !/^[.\s]/.test(value) &&
  !/[.\s]$/.test(value);
// Vault link targets: every path segment percent-encoded, parentheses included,
// so a name with a collision suffix such as "(d403)" keeps the Markdown link intact.
export const encodeLinkSegment = (segment) => encodeURIComponent(segment).replace(/[()]/g, (character) => (character === "(" ? "%28" : "%29"));
const pageId = (value) => typeof value === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value);
const notionPublicationBudgets = new WeakSet();

// Target aliases and Session names are not resource identities. These values
// describe an operational destination only, never a Project or recovery owner.
export function documentDestinationIdentity(target) {
  if (target?.kind === "notion" && pageId(target.parentPageId))
    return workDocumentHash(["notion-parent", target.parentPageId.replaceAll("-", "").toLowerCase()]);
  if (target?.kind === "obsidian") {
    const directory = fs.realpathSync(target.vaultRoot),
      stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) documentFailure("Unsafe vault destination.");
    return workDocumentHash(["obsidian-vault", String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
  }
  documentFailure("Unknown document destination.");
}

export function createBoundedNotionRequest({ token, fetchFunction = fetch, maxBytes = 4 * 1024 * 1024 } = {}) {
  if (typeof token !== "string" || !token || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024)
    documentFailure("Explicit transport configuration is required.");
  return async ({ method, url, headers, body, signal }) => {
    const endpoint = new URL(url);
    if (endpoint.origin !== "https://api.notion.com" || !endpoint.pathname.startsWith("/v1/") || endpoint.username || endpoint.password)
      documentFailure("Unexpected Notion endpoint.");
    const response = await fetchFunction(url, {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const reader = response.body?.getReader();
    if (!reader) documentFailure("Remote response body is unavailable.");
    const chunks = [];
    let size = 0;
    try {
      const declared = response.headers?.get("content-length");
      if (declared && Number(declared) > maxBytes) documentFailure("Remote response bound exceeded.", "WORK_DOCUMENT_RESPONSE_BOUND");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) documentFailure("Remote response bound exceeded.", "WORK_DOCUMENT_RESPONSE_BOUND");
        chunks.push(Buffer.from(value));
      }
      return { status: response.status, body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock?.();
    }
  };
}

export function createObsidianWorkDocumentAdapter({ vaultRoot, directory }) {
  const segments = typeof directory === "string" ? directory.split("/") : [];
  if (!fs.statSync(vaultRoot).isDirectory() || segments[0] !== "Lode" || segments.length < 2 || !segments.slice(1).every(safeVaultName))
    documentFailure("Select an existing vault and Lode-owned relative area.");
  const vault = fs.realpathSync(vaultRoot),
    target = safeSessionPath(vault, directory);
  const file = (id) => {
    if (!/\.md$/.test(id || "") || !safeVaultName(id.slice(0, -3))) documentFailure("Invalid vault document identity.");
    return safeSessionPath(vault, directory, id);
  };
  const read = async (id) => {
    const targetFile = file(id),
      stat = fs.lstatSync(targetFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) documentFailure("Unsafe vault file.");
    const identity = fs.lstatSync(targetFile, { bigint: true });
    return {
      id,
      markdown: fs.readFileSync(targetFile, "utf8"),
      complete: true,
      warnings: [],
      objectIdentity: workDocumentHash([String(identity.dev), String(identity.ino), String(identity.birthtimeNs)]),
    };
  };
  return {
    kind: "obsidian",
    // A file name is the document identity and creation never overwrites.
    exclusiveCreate: true,
    identity: workDocumentHash(["obsidian", vault, directory]),
    url: (id) => encodeLinkSegment(id),
    directory,
    scoped(segment) {
      if (!safeVaultName(segment)) documentFailure("Invalid child document directory.");
      return createObsidianWorkDocumentAdapter({ vaultRoot: vault, directory: `${directory}/${segment}` });
    },
    async read(id) {
      return read(id);
    },
    // A name in this folder that Lode has not recorded is never reused.
    occupied(name) {
      return fs.existsSync(path.join(target, name));
    },
    async find({ documentId, markdown }) {
      try {
        const value = await read(documentId);
        return { complete: true, matches: sameDocumentText(value.markdown, markdown) ? [value] : [], occupied: !sameDocumentText(value.markdown, markdown) };
      } catch (error) {
        if (error.code === "ENOENT") return { complete: true, matches: [] };
        // A folder or other non-file at the name is occupied, not Lode's document.
        if (fs.existsSync(file(documentId))) return { complete: true, matches: [], occupied: true };
        throw error;
      }
    },
    async create({ documentId, markdown }) {
      const targetFile = file(documentId);
      fs.mkdirSync(target, { recursive: true });
      safeSessionPath(vault, directory);
      atomicCreateArtifact(targetFile, markdown);
      return { id: documentId, objectIdentity: (await read(documentId)).objectIdentity };
    },
    async replace({ id, oldText, newText }) {
      const observed = await read(id),
        at = observed.markdown.indexOf(oldText);
      if (at < 0 || observed.markdown.indexOf(oldText, at + oldText.length) >= 0)
        documentFailure("Managed text changed or is ambiguous.", "WORK_DOCUMENT_REMOTE_DRIFT");
      const next = observed.markdown.slice(0, at) + newText + observed.markdown.slice(at + oldText.length);
      const digest = workDocumentHash(observed.markdown);
      atomicWriteArtifact(file(id), next, {
        beforePublish() {
          if (workDocumentHash(fs.readFileSync(file(id))) !== digest) documentFailure("Vault changed before publication.", "WORK_DOCUMENT_REMOTE_DRIFT");
        },
      });
      return { id, objectIdentity: (await read(id)).objectIdentity };
    },
  };
}

// A request is supplied by the explicitly configured Host. There is no ambient
// token discovery, arbitrary base URL, remote instruction execution or SDK daemon.
export function createNotionWorkDocumentAdapter({ parentPageId, request, requestBudget = 64, deadlineMs = 30000, now = Date.now, _sharedBudget = null }) {
  if (!pageId(parentPageId) || typeof request !== "function")
    documentFailure("Select an exact parent and authenticated transport.", "WORK_DOCUMENT_UNCONNECTED");
  if (!Number.isInteger(requestBudget) || requestBudget < 1 || requestBudget > 64 || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30000)
    documentFailure("Invalid publication transport budget.");
  if (_sharedBudget && !notionPublicationBudgets.has(_sharedBudget)) documentFailure("Unknown publication budget.");
  const budget = _sharedBudget || { used: 0, deadline: now() + deadlineMs };
  notionPublicationBudgets.add(budget);
  const compact = (id) => id.replaceAll("-", "").toLowerCase();
  const rejections = new WeakMap();
  const intent = (method, endpoint, body) => ({
    protocol: "notion-markdown-v2",
    method,
    endpoint,
    parentPageId: compact(parentPageId),
    bodyDigest: workDocumentHash(body),
  });
  const createBody = ({ title, markdown }) => ({
    parent: { type: "page_id", page_id: parentPageId },
    properties: { title: { type: "title", title: [{ type: "text", text: { content: title } }] } },
    markdown,
    markdown_version: "v2",
  });
  const replaceBody = ({ oldText, newText }) => ({
    type: "update_content",
    markdown_version: "v2",
    allow_async: true,
    update_content: { content_updates: [{ old_str: oldText, new_str: newText }] },
  });
  const isWriteEndpoint = (method, endpoint) =>
    (method === "POST" && endpoint === "/pages") || (method === "PATCH" && /^\/pages\/[a-f0-9-]+\/markdown$/i.test(endpoint) && pageId(endpoint.split("/")[2]));
  // This narrow error contract is a rejected request, not an uncertain timeout.
  // restricted_resource includes workspace block limits: retain its cause verbatim.
  const validRejection = (value) =>
    value?.object === "error" &&
    value.status === 403 &&
    value.code === "restricted_resource" &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    value.message.length <= 4096 &&
    (value.request_id === undefined || (typeof value.request_id === "string" && value.request_id.length <= 180));
  const budgetLeft = () => {
    if (budget.used >= requestBudget || now() >= budget.deadline)
      documentFailure("Publication/recovery transport budget exhausted.", "WORK_DOCUMENT_TRANSPORT_BUDGET");
  };
  const call = async (method, endpoint, body) => {
    budgetLeft();
    budget.used++;
    const remaining = Math.max(1, budget.deadline - now());
    let timer, result;
    try {
      result = await Promise.race([
        request({
          method,
          url: `https://api.notion.com/v1${endpoint}`,
          signal: AbortSignal.timeout(remaining),
          headers: { "Notion-Version": "2026-03-11", "Content-Type": "application/json" },
          ...(body ? { body } : {}),
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("Publication deadline expired."), { code: "WORK_DOCUMENT_TRANSPORT_BUDGET" })), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (now() >= budget.deadline) documentFailure("Publication deadline expired; effects remain unconfirmed.", "WORK_DOCUMENT_TRANSPORT_BUDGET");
    if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300) {
      const status = result?.status;
      const error = Object.assign(new Error("Notion request did not verify publication."), {
        code: status === 401 || status === 403 ? "WORK_DOCUMENT_PERMISSION_DENIED" : "WORK_DOCUMENT_HTTP_UNKNOWN",
        ...(Number.isInteger(status) ? { httpStatus: status } : {}),
      });
      if (status === 403 && isWriteEndpoint(method, endpoint) && validRejection(result.body)) {
        const { object, status: responseStatus, code, message, request_id } = result.body;
        rejections.set(error, {
          kind: "VerifiedRejectedNotionWrite",
          intent: intent(method, endpoint, body),
          response: { object, status: responseStatus, code, message, ...(request_id ? { request_id } : {}) },
        });
      }
      throw error;
    }
    const value = result.body;
    if (result.status === 202) {
      if (!safeId(value?.id)) documentFailure("Unknown async task identity.");
      return { pendingTask: value.id, status: value.status, pollAfterSeconds: value.poll_after_seconds || 1 };
    }
    return value;
  };
  const read = async (id) => {
    if (!pageId(id)) documentFailure("Invalid exact page identity.");
    // A page that is gone is told apart from other failures (async task, listing).
    const page = await call("GET", `/pages/${id}`).catch((error) => {
      if (error.httpStatus === 404) error.pageMissing = true;
      throw error;
    });
    // A page a person moved to the trash answers with in_trash (archived in
    // older API versions): it is read as missing, like a page that is gone.
    if (page?.in_trash === true || page?.archived === true)
      throw Object.assign(new Error("Page is in the trash."), { code: "WORK_DOCUMENT_REMOTE_DRIFT", pageMissing: true });
    if (compact(page?.id || "") !== compact(id) || compact(page.parent?.page_id || "") !== compact(parentPageId))
      documentFailure("Page parent or identity differs.", "WORK_DOCUMENT_REMOTE_DRIFT");
    const value = await call("GET", `/pages/${id}/markdown?markdown_version=v2`);
    if (compact(value?.id || "") !== compact(id) || typeof value.markdown !== "string" || Buffer.byteLength(value.markdown) > 2 * 1024 * 1024)
      documentFailure("Page body is unavailable.");
    return {
      id,
      title: (page.properties?.title?.title || []).map((part) => part.plain_text ?? part.text?.content ?? "").join(""),
      markdown: value.markdown,
      complete:
        value.object === "page_markdown" &&
        value.truncated === false &&
        Array.isArray(value.unknown_block_ids) &&
        value.unknown_block_ids.length === 0 &&
        !/<unknown\b/.test(value.markdown),
      warnings: value.warnings || [],
    };
  };
  return {
    kind: "notion",
    identity: workDocumentHash(["notion", compact(parentPageId)]),
    scoped(parentId) {
      // Core must first verify the exact owned container through its journal and
      // readback. Every child still enforces one exact parent; no subtree ownership
      // or workspace-wide search is inferred by this adapter.
      return createNotionWorkDocumentAdapter({ parentPageId: parentId, request, requestBudget, deadlineMs, now, _sharedBudget: budget });
    },
    writeIntent(operation, input) {
      if (operation === "create") return intent("POST", "/pages", createBody(input));
      if (operation === "replace-exact-text" && pageId(input.id)) return intent("PATCH", `/pages/${input.id}/markdown`, replaceBody(input));
      documentFailure("Invalid write operation.");
    },
    describeWriteRejection(error, expected) {
      const proof = rejections.get(error);
      return proof && workDocumentHash(proof.intent) === workDocumentHash(expected) ? proof : null;
    },
    validateStoredWriteRejection(proof, expected) {
      return (
        proof?.kind === "VerifiedRejectedNotionWrite" &&
        validRejection(proof.response) &&
        isWriteEndpoint(expected?.method, expected?.endpoint) &&
        expected.parentPageId === compact(parentPageId) &&
        workDocumentHash(proof.intent) === workDocumentHash(expected)
      );
    },
    // Checked before a write is journaled: a request this adapter would refuse
    // to send is a known not-attempted outcome, never an unknown one.
    ensureBudget: budgetLeft,
    beginPublication() {
      if (!_sharedBudget) {
        budget.used = 0;
        budget.deadline = now() + deadlineMs;
      }
    },
    url: (id) => {
      if (!pageId(id)) documentFailure("Invalid exact page link.");
      return `https://www.notion.so/${compact(id)}`;
    },
    read,
    // With a title, a candidate must match both title and body (layout v2 bodies
    // carry no identity line; titles are unique within one exact parent).
    async find({ title, markdown, cursor = null }) {
      const matches = [];
      if (title !== undefined) {
        // Layout v2: list the exact parent to its end and read only children
        // whose listed title is this title (or not given). One complete listing
        // decides; no slice of it is ever bound. A parent too large to list and
        // read within one call's request budget cannot be decided: that is
        // reported as such, not as a repeat that would restart the listing.
        const candidates = [];
        let pageCursor = null;
        try {
          for (;;) {
            const children = await call(
              "GET",
              "/blocks/" + parentPageId + "/children?page_size=100" + (pageCursor ? "&start_cursor=" + encodeURIComponent(pageCursor) : ""),
            );
            if (!Array.isArray(children.results) || children.results.length > 100) documentFailure("Parent enumeration is incomplete.");
            for (const child of children.results)
              if (child.type === "child_page" && (typeof child.child_page?.title !== "string" || child.child_page.title === title)) candidates.push(child.id);
            if (children.has_more === false) break;
            if (typeof children.next_cursor !== "string" || !children.next_cursor || children.next_cursor.length > 500) return { complete: false, matches };
            pageCursor = children.next_cursor;
          }
          for (const id of candidates) {
            // A same-title page in the trash is not a candidate.
            const value = await read(id).catch((error) => {
              if (error.pageMissing) return null;
              throw error;
            });
            if (!value) continue;
            if (value.complete && !value.warnings.length && sameDocumentText(value.markdown, markdown) && value.title === title) matches.push({ id: value.id });
          }
        } catch (error) {
          if (error.code !== "WORK_DOCUMENT_TRANSPORT_BUDGET") throw error;
          return { complete: false, matches: [], limit: "recovery-exceeds-one-call-request-budget" };
        }
        return { complete: true, matches };
      }
      if (
        cursor &&
        (typeof cursor !== "object" ||
          !Number.isInteger(cursor.offset) ||
          cursor.offset < 0 ||
          cursor.offset > 100 ||
          (cursor.pageCursor !== null && (typeof cursor.pageCursor !== "string" || cursor.pageCursor.length > 500)) ||
          !/^[a-f0-9]{64}$/.test(cursor.listingDigest || ""))
      )
        documentFailure("Invalid recovery cursor.", "WORK_DOCUMENT_RECORD_TAMPER");
      let pageCursor = cursor?.pageCursor || null,
        offset = cursor?.offset || 0,
        inspected = 0;
      // Bounded slices of the exact selected parent. Progress survives calls;
      // an unfinished prefix never proves uniqueness or authorizes a POST.
      for (let page = 0; page < 3; page++) {
        const children = await call(
          "GET",
          "/blocks/" + parentPageId + "/children?page_size=100" + (pageCursor ? "&start_cursor=" + encodeURIComponent(pageCursor) : ""),
        );
        if (!Array.isArray(children.results) || children.results.length > 100) documentFailure("Parent enumeration is incomplete.");
        const digest = workDocumentHash(children.results.map((child) => [child.id, child.type]));
        if (cursor && page === 0 && cursor.listingDigest !== digest) offset = 0;
        for (let index = offset; index < children.results.length; index++) {
          const child = children.results[index];
          if (child.type !== "child_page") continue;
          if (inspected++ >= 12) return { complete: false, matches, cursor: { pageCursor, offset: index, listingDigest: digest } };
          const value = await read(child.id);
          if (value.complete && !value.warnings.length && sameDocumentText(value.markdown, markdown) && (title === undefined || value.title === title))
            matches.push({ id: value.id });
        }
        if (children.has_more === false) return { complete: true, matches };
        if (typeof children.next_cursor !== "string" || !children.next_cursor || children.next_cursor.length > 500) return { complete: false, matches };
        pageCursor = children.next_cursor;
        offset = 0;
        cursor = null;
      }
      // The next page is read once to bind its listing before saving an offset.
      const next = await call("GET", "/blocks/" + parentPageId + "/children?page_size=100&start_cursor=" + encodeURIComponent(pageCursor));
      if (!Array.isArray(next.results) || next.results.length > 100) documentFailure("Parent enumeration is incomplete.");
      return {
        complete: false,
        matches,
        cursor: { pageCursor, offset: 0, listingDigest: workDocumentHash(next.results.map((child) => [child.id, child.type])) },
      };
    },
    // Child page titles under this exact parent, from at most three listing pages.
    // complete:false means the titles are not all known.
    async childTitles() {
      const titles = [];
      let pageCursor = null;
      for (let page = 0; page < 3; page++) {
        const children = await call(
          "GET",
          "/blocks/" + parentPageId + "/children?page_size=100" + (pageCursor ? "&start_cursor=" + encodeURIComponent(pageCursor) : ""),
        );
        if (!Array.isArray(children.results) || children.results.length > 100) return { complete: false, titles };
        for (const child of children.results)
          if (child.type === "child_page") titles.push(typeof child.child_page?.title === "string" ? child.child_page.title : null);
        if (children.has_more === false) return { complete: !titles.includes(null), titles: titles.filter((title) => title !== null) };
        if (typeof children.next_cursor !== "string" || !children.next_cursor) return { complete: false, titles };
        pageCursor = children.next_cursor;
      }
      return { complete: false, titles: titles.filter((title) => title !== null) };
    },
    async create({ title, markdown }) {
      const result = await call("POST", "/pages", createBody({ title, markdown }));
      if (result.pendingTask) return result;
      if (!pageId(result.id) || compact(result.parent?.page_id || "") !== compact(parentPageId)) documentFailure("Create result identity differs.");
      return { id: result.id };
    },
    async replace({ id, oldText, newText }) {
      if (!pageId(id)) documentFailure("Invalid exact page identity.");
      const result = await call("PATCH", `/pages/${id}/markdown`, replaceBody({ oldText, newText }));
      return result.pendingTask ? result : { id, warnings: result.warnings || [] };
    },
    async poll(taskId) {
      if (!safeId(taskId)) documentFailure("Invalid async task identity.");
      // Never send credentials to the returned status_url. One bounded read per
      // request avoids daemon polling and respects caller-scheduled retry timing.
      return call("GET", `/async_tasks/${taskId}`);
    },
  };
}
