import fs from "node:fs";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { renderGraphExplorer } from "../../scripts/lib/graph-explorer-html.mjs";

// Visibility only: no CSS layout, clipping, real accessibility tree or browser proof.
export function visibleText(element) {
  if (element.hidden || element.getAttribute?.("hidden") !== null || ["title", "script"].includes(element.tagName)) return "";
  const children = element.tagName === "details" && !element.open ? element.children.filter(child => child.tagName === "summary") : element.children;
  return (element._text || "") + children.map(visibleText).join("");
}

// A deliberately limited in-memory DOM/Canvas test double. This executes the
// shipped browser script, but proves neither browser layout nor actual GUI speed.
export function explorerDom(snapshot, { devicePixelRatio = 1, narrow = false, cardMeasure = null, fontSize = 14, resetDetachedScroll = false } = {}) {
  let modeledFontSize = fontSize;
  const windowListeners = new Map(), fontListeners = new Map();
  const ids = new Map(), frames = [], pointerCaptures = new Map(), stats = { created: 0, svg: 0, fills: 0, strokes: 0, lines: 0, focused: null, transforms: [], scrolled: null, points: [] };
  const clearDetachedScroll = element => { if (!resetDetachedScroll) return; element.scrollTop = element.scrollLeft = 0; for (const child of element.children) clearDetachedScroll(child); };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.dataset = {}; this.style = {}; this.hidden = false; this.value = ""; this.checked = false; this._text = ""; if (tag === "details") this.open = false; this.clientWidth = 1000; this.clientHeight = 700; this.rect = { left: 0, top: 0, width: 1000, height: 700 }; stats.created++; }
    set id(value) { this._id = value; ids.set(value, this); } get id() { return this._id; }
    set textContent(value) { this._text = String(value ?? ""); for (const child of this.children) child.parentNode = null; this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    append(...items) { for (const child of items) { const node = typeof child === "string" ? Object.assign(new Element("text"), { textContent: child }) : child; node.remove(); node.parentNode = this; this.children.push(node); } }
    replaceChildren(...items) { for (const child of this.children) { clearDetachedScroll(child); child.parentNode = null; } this.children = []; this._text = ""; this.append(...items); }
    remove() { if (!this.parentNode) return; clearDetachedScroll(this); const list = this.parentNode.children, index = list.indexOf(this); if (index >= 0) list.splice(index, 1); this.parentNode = null; }
    insertBefore(child, reference) { if (child === reference) return child; child.remove(); const at = reference ? this.children.indexOf(reference) : this.children.length; child.parentNode = this; this.children.splice(at < 0 ? this.children.length : at, 0, child); return child; }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    before(node) { const parent = this.parentNode || body, index = parent.children.indexOf(this); node.parentNode = parent; parent.children.splice(Math.max(0, index), 0, node); }
    after(node) { const parent = this.parentNode || body, index = parent.children.indexOf(this); node.parentNode = parent; parent.children.splice(index + 1, 0, node); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === "id") this.id = value; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    querySelectorAll(selector) { const found = []; const match = selector.match(/^\[([^\]]+)\]$/); const walk = node => { for (const child of node.children) { if (match && child.attributes.has(match[1])) found.push(child); walk(child); } }; walk(this); return found; }
    addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(callback); }
    dispatch(name, extra = {}) { const event = { target: this, detail: 1, button: 0, preventDefault() {}, stopPropagation() {}, ...extra }; for (const callback of this.listeners.get(name) || []) callback(event); }
    focus() { stats.focused = this.id || this.getAttribute("data-node"); stats.focusedElement = this; }
    scrollIntoView() { stats.scrolled = this; }
    setPointerCapture(id) { pointerCaptures.set(id, this); }
    closest(selector) { const match = selector.match(/^\[([^\]]+)\]$/); return match && this.attributes.has(match[1]) ? this : this.parentNode?.closest?.(selector) || null; }
    getBoundingClientRect() { if (cardMeasure && this.className?.includes("map-measure")) return { ...this.rect, width: parseFloat(this.style.width), height: cardMeasure(this, modeledFontSize) }; return this.rect; }
    createSVGPoint() { return { x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y }; } }; }
    getScreenCTM() { return { inverse() { return {}; } }; }
    getContext() { const element = this; if (!this.context) this.context = { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() { stats.lines++; }, stroke() { stats.strokes++; },
      setTransform(...values) { stats.transforms.push({ id: element.id, values }); }, fillRect(...values) { stats.fills++; if (element.id) stats.points.push({ id: element.id, values }); },
      measureText(value) { return { width: Array.from(value).length * 7 }; } }; return this.context; }
  }
  const body = new Element("body"), html = renderGraphExplorer(snapshot);
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const element = new Element(match[1]); element.id = match[3]; element.disabled = /\sdisabled(?:\s|$)/.test(match[2]);
    element.hidden = /\shidden(?:\s|$)/.test(match[2]); if (match[1] === "details") element.open = /\sopen(?:\s|$)/.test(match[2]); body.append(element);
  }
  const dataStart = html.indexOf('id="snapshot" type="application/json">') + 'id="snapshot" type="application/json">'.length;
  ids.get("snapshot").textContent = html.slice(dataStart, html.indexOf('</script>', dataStart));
  for (const id of ["layer"]) ids.get(id).value = "project";
  for (const id of ["axis", "view", "relation-filter", "kind-filter"]) ids.get(id).value = "all";
  const document = { body, get activeElement() { return stats.focusedElement || body; }, getElementById: id => ids.get(id) || null, createElement: tag => new Element(tag),
    createElementNS: (_ns, tag) => { stats.svg++; return new Element(tag); }, documentElement: { dataset: {} } };
  if (cardMeasure) document.fonts = { status: "loaded", ready: Promise.resolve(), addEventListener: (name, callback) => fontListeners.set(name, callback) };
  const runtime = vm.createContext({ document, performance, console, devicePixelRatio, setTimeout: callback => callback(),
    ...(cardMeasure ? { getComputedStyle: () => ({ fontSize: `${modeledFontSize}px`, fontFamily: "system-ui" }) } : {}),
    addEventListener: (name, callback) => { if (!windowListeners.has(name)) windowListeners.set(name, []); windowListeners.get(name).push(callback); },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; }, matchMedia: () => ({ matches: narrow }) });
  const source = fs.readFileSync(new URL("../../scripts/graph-explorer/codec.js", import.meta.url), "utf8").replace(/^export const explorerCodec =/m, "const explorerCodec =") + "\n"
    + fs.readFileSync(new URL("../../scripts/graph-explorer/cards.js", import.meta.url), "utf8") + "\n"
    + fs.readFileSync(new URL("../../scripts/graph-explorer/exploration.js", import.meta.url), "utf8") + "\n"
    + fs.readFileSync(new URL("../../scripts/graph-explorer/product-perspectives.js", import.meta.url), "utf8") + "\n"
    + fs.readFileSync(new URL("../../scripts/graph-explorer/browser.js", import.meta.url), "utf8");
  const start = performance.now(); new vm.Script(source).runInContext(runtime, { timeout: 10000 });
  return { ids, stats, document, initialMs: performance.now() - start, html,
    windowEvent(name, event = {}) { for (const callback of windowListeners.get(name) || []) callback(event); },
    setModeledFontSize(value) { modeledFontSize = value; }, finishModeledFonts() { fontListeners.get("loadingdone")?.(); },
    event(id, name = "click", extra) { const element = typeof id === "string" ? ids.get(id) : id; if (!element) throw Error(`Missing element ${id}`); element.dispatch(name, extra); },
    // A narrow Pointer Events capture/retargeting model, not a browser.
    pointerClick(element, extra = {}) {
      const pointerId = extra.pointerId ?? 1, original = typeof element === "string" ? ids.get(element) : element;
      const bubble = (target, name) => { for (let current = target; current; current = current.parentNode) current.dispatch(name, { ...extra, pointerId, target }); };
      bubble(original, "pointerdown");
      const capturedUp = pointerCaptures.get(pointerId), upTarget = capturedUp || original;
      bubble(upTarget, "pointerup"); pointerCaptures.delete(pointerId);
      bubble(capturedUp || original, "click");
    },
    frame() { const next = frames.shift(); if (next) next(performance.now()); return Boolean(next); },
    flush() { while (frames.length) frames.shift()(performance.now()); },
    async settle(limit = 1000) { for (let i = 0; i < limit; i++) { await Promise.resolve(); while (frames.length) frames.shift()(performance.now()); if (!frames.length && ids.get("cancel-work").disabled) return; } throw Error("Synthetic UI did not settle"); },
    rectangle(id, rect) { ids.get(id).rect = rect; ids.get(id).clientWidth = rect.width; ids.get(id).clientHeight = rect.height; },
    pendingFrames() { return frames.length; } };
}
