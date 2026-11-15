// Built-in UI binding patterns for the product graph's 프론트 기능 (bundle 1).
//
// A front 기능 is a user's signal through a UI. The toolkit only decides how
// that wiring is spelled, so every toolkit here is one entry of the same table,
// in the same format a Project uses in 호출 방식 표.json. product-graph-
// extraction.mjs reads these entries; no toolkit has a code path of its own.
// Every list below is a judgement (판단), not a fact about the toolkit.
//
// Entry fields (all names are the table's own keys):
//   이름          the entry's name; a Project entry with the same name replaces it
//   확장자        file extensions the entry reads
//   파일 표시     optional regex a file must contain (on code with comments and
//                 strings blanked when the language allows it)
//   모양          regex over the file text with named groups: event (unless
//                 이벤트 고정), target, optional emitter
//   메서드        instead of 모양: regex over method names declared in a class,
//                 with an event group (overridden event methods)
//   코드만        true: a match must start in code, not in a comment or string
//   대상 읽기     "식": the target runs from the target group to the end of the
//                 expression (balanced brackets and strings); "그룹": as captured
//   이벤트 고정   the event name when the wiring has none of its own
//   이벤트 바꾸기 transforms applied to the event name in order:
//                 { "떼기": regex } removes matches; "소문자"; "첫 글자 소문자"
//   요소 이름     where the element or emitting object's name comes from when
//                 the target is not a handler name: "보내는 쪽" (emitter group),
//                 "같은 태그 id" (id attribute of the enclosing tag), "줄 앞 대입"
//                 (the name assigned on the same line)
//   유저 조작     events that are a user's operation; "*" means every event
//   유저 조작 아님 events excluded from "*"
//   스스로 도는   events the screen runs by itself (become @effect)

const DOM_USER_EVENTS = Object.freeze([
  "auxclick",
  "beforeinput",
  "change",
  "click",
  "contextmenu",
  "dblclick",
  "drag",
  "dragend",
  "dragenter",
  "dragleave",
  "dragover",
  "dragstart",
  "drop",
  "input",
  "keydown",
  "keypress",
  "keyup",
  "mousedown",
  "mouseup",
  "paste",
  "pointerdown",
  "pointerup",
  "reset",
  "search",
  "select",
  "submit",
  "toggle",
  "touchend",
  "touchstart",
  "wheel",
]);
// React spells DOM events in camelCase after "on" (onClick -> click, onKeyDown -> keyDown).
const COMPONENT_USER_EVENTS = Object.freeze([
  "change",
  "click",
  "contextMenu",
  "doubleClick",
  "drag",
  "dragEnd",
  "dragStart",
  "drop",
  "input",
  "keyDown",
  "keyPress",
  "keyUp",
  "mouseDown",
  "mouseUp",
  "paste",
  "pointerDown",
  "pointerUp",
  "select",
  "submit",
  "touchEnd",
  "touchStart",
  "wheel",
]);
const SIGNAL_USER_EVENTS = Object.freeze([
  "activated",
  "cellClicked",
  "cellDoubleClicked",
  "clicked",
  "currentIndexChanged",
  "currentItemChanged",
  "currentRowChanged",
  "currentTextChanged",
  "doubleClicked",
  "editingFinished",
  "itemChanged",
  "itemClicked",
  "itemDoubleClicked",
  "itemSelectionChanged",
  "pressed",
  "released",
  "returnPressed",
  "sliderMoved",
  "sliderReleased",
  "stateChanged",
  "textChanged",
  "textEdited",
  "toggled",
  "triggered",
  "valueChanged",
]);
const JS = Object.freeze([".js", ".mjs", ".cjs", ".ts", ".mts"]);
const NAME_FIRST = ["보내는 쪽", "같은 태그 id"];
// DOM wiring is read only in files that use the page's document or window,
// so timers and event targets in server code are not taken for a screen.
const DOM_FILE = String.raw`\b(?:document\.(?:getElementById|querySelector(?:All)?|createElement|body|addEventListener)|window\.(?:addEventListener|location|requestAnimationFrame))\b`;

export const BUILT_IN_UI_PATTERNS = Object.freeze(
  [
    // DOM
    {
      이름: "DOM addEventListener",
      확장자: [...JS, ".jsx", ".tsx"],
      "파일 표시": DOM_FILE,
      모양: String.raw`(?<emitter>[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\([^()\n]*\)|\[[^\]\n]*\])*)\.addEventListener\(\s*["'\x60](?<event>[\w:.-]+)["'\x60]\s*,\s*(?<target>)`,
      코드만: true,
      "대상 읽기": "식",
      "요소 이름": NAME_FIRST,
      "유저 조작": DOM_USER_EVENTS,
      "스스로 도는": ["DOMContentLoaded", "load"],
    },
    {
      이름: "DOM on<event> 속성",
      확장자: [...JS, ".jsx", ".tsx"],
      "파일 표시": DOM_FILE,
      모양: String.raw`(?<emitter>[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\([^()\n]*\)|\[[^\]\n]*\])*)\.on(?<event>[a-z]+)\s*=(?![=>])\s*(?<target>)`,
      코드만: true,
      "대상 읽기": "식",
      "요소 이름": NAME_FIRST,
      "유저 조작": DOM_USER_EVENTS,
      "스스로 도는": ["load"],
    },
    {
      이름: "DOM 타이머",
      확장자: [...JS, ".jsx", ".tsx"],
      "파일 표시": DOM_FILE,
      모양: String.raw`\bsetInterval\(\s*(?<target>)`,
      코드만: true,
      "대상 읽기": "식",
      "이벤트 고정": "setInterval",
      "스스로 도는": ["setInterval"],
    },
    {
      이름: "HTML on<event> 속성",
      확장자: [".html", ".htm"],
      모양: String.raw`\son(?<event>[a-zA-Z]+)\s*=\s*"(?<target>[^"]*)"`,
      "이벤트 바꾸기": ["소문자"],
      "요소 이름": ["같은 태그 id"],
      "유저 조작": DOM_USER_EVENTS,
      "스스로 도는": ["load"],
    },
    // Component templates
    {
      이름: "JSX on<Event>",
      확장자: [".jsx", ".tsx"],
      모양: String.raw`\son(?<event>[A-Z][A-Za-z]*)=\{(?<target>)`,
      "대상 읽기": "식",
      "이벤트 바꾸기": ["첫 글자 소문자"],
      "요소 이름": ["같은 태그 id"],
      "유저 조작": COMPONENT_USER_EVENTS,
    },
    {
      이름: "React useEffect",
      확장자: [".jsx", ".tsx", ...JS],
      모양: String.raw`\buseEffect\(\s*(?<target>)`,
      코드만: true,
      "대상 읽기": "식",
      "이벤트 고정": "useEffect",
      "스스로 도는": ["useEffect"],
    },
    {
      이름: "Vue @event / v-on:",
      확장자: [".vue"],
      모양: String.raw`\s(?:@|v-on:)(?<event>[\w-]+)(?:\.[\w-]+)*\s*=\s*"(?<target>[^"]*)"`,
      "요소 이름": ["같은 태그 id"],
      "유저 조작": DOM_USER_EVENTS,
    },
    {
      이름: "Vue onMounted",
      확장자: [".vue"],
      모양: String.raw`\bonMounted\(\s*(?<target>)`,
      "대상 읽기": "식",
      "이벤트 고정": "onMounted",
      "스스로 도는": ["onMounted"],
    },
    {
      이름: "Svelte on:event",
      확장자: [".svelte"],
      모양: String.raw`\son:(?<event>[\w-]+)(?:\|[\w|]+)?\s*=\s*\{(?<target>)`,
      "대상 읽기": "식",
      "요소 이름": ["같은 태그 id"],
      "유저 조작": DOM_USER_EVENTS,
    },
    {
      이름: "Svelte onMount",
      확장자: [".svelte"],
      모양: String.raw`\bonMount\(\s*(?<target>)`,
      "대상 읽기": "식",
      "이벤트 고정": "onMount",
      "스스로 도는": ["onMount"],
    },
    // Signal/slot and callback toolkits
    {
      이름: "Qt signal.connect",
      확장자: [".py"],
      "파일 표시": String.raw`\b(?:PySide[26]?|PyQt[456])\b`,
      모양: String.raw`(?<emitter>[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.(?<event>[A-Za-z_]\w*)(?:\[[^\]\n]*\])?\.connect\s*\(\s*(?<target>)`,
      코드만: true,
      "대상 읽기": "식",
      "요소 이름": ["보내는 쪽"],
      "유저 조작": SIGNAL_USER_EVENTS,
      "스스로 도는": ["timeout"],
    },
    {
      이름: "Qt <name>Event 메서드",
      확장자: [".py"],
      "파일 표시": String.raw`\b(?:PySide[26]?|PyQt[456])\b`,
      메서드: String.raw`^(?<event>close|contextMenu|dragEnter|drop|hide|keyPress|keyRelease|mouseDoubleClick|mousePress|mouseRelease|show|wheel)Event$`,
    },
    {
      이름: "Tk command=",
      확장자: [".py"],
      "파일 표시": String.raw`\b(?:tkinter|Tkinter)\b`,
      모양: String.raw`\bcommand\s*=(?!=)\s*(?<target>)`,
      코드만: true,
      "대상 읽기": "식",
      "이벤트 고정": "command",
      "요소 이름": ["줄 앞 대입"],
      "유저 조작": ["command"],
    },
    {
      이름: "Tk bind",
      확장자: [".py"],
      "파일 표시": String.raw`\b(?:tkinter|Tkinter)\b`,
      모양: String.raw`(?<emitter>[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.bind(?:_all|_class)?\(\s*["'](?<event><[^"'\n]+>)["']\s*,\s*(?<target>)`,
      코드만: true,
      "대상 읽기": "식",
      "이벤트 바꾸기": [{ 떼기: "^<|>$" }],
      "요소 이름": ["보내는 쪽"],
      "유저 조작": ["*"],
      "유저 조작 아님": ["Configure", "Destroy", "Expose", "Map", "Unmap", "Visibility"],
    },
    {
      이름: "Tk after",
      확장자: [".py"],
      "파일 표시": String.raw`\b(?:tkinter|Tkinter)\b`,
      모양: String.raw`\.after\(\s*\d+\s*,\s*(?<target>)`,
      코드만: true,
      "대상 읽기": "식",
      "이벤트 고정": "after",
      "스스로 도는": ["after"],
    },
  ].map((entry) => Object.freeze({ 판단: true, ...entry })),
);

// Signs that a file is UI code. A file that shows one but yields no wiring
// from any pattern is listed under "화면 코드인데 규칙이 없음", so a missing
// pattern shows as a gap rather than as zero 기능. Checked on code with
// comments and strings blanked where the language allows it.
export const BUILT_IN_UI_MARKERS = Object.freeze(
  [
    { 이름: "Qt", 확장자: [".py"], 표시: String.raw`\b(?:PySide[26]?|PyQt[456])\b` },
    { 이름: "Tk", 확장자: [".py"], 표시: String.raw`\b(?:tkinter|Tkinter)\b` },
    { 이름: "GTK", 확장자: [".py"], 표시: String.raw`\bgi\.repository\b|\bimport\s+gtk\b` },
    { 이름: "wxPython", 확장자: [".py"], 표시: String.raw`^\s*(?:import\s+wx\b|from\s+wx\b)` },
    { 이름: "Kivy", 확장자: [".py"], 표시: String.raw`^\s*(?:import\s+kivy\b|from\s+kivy\b)` },
    { 이름: "DOM", 확장자: [...JS], 표시: String.raw`\bdocument\.(?:getElementById|querySelector(?:All)?|createElement|addEventListener)\b` },
    { 이름: "HTML", 확장자: [".html", ".htm"], 표시: String.raw`<(?:button|input|form|select|textarea)\b` },
    { 이름: "JSX", 확장자: [".jsx", ".tsx"], 표시: String.raw`<[A-Za-z][\w.]*[\s>/]` },
    { 이름: "Vue", 확장자: [".vue"], 표시: String.raw`<template\b` },
    { 이름: "Svelte", 확장자: [".svelte"], 표시: String.raw`<[a-z][\w-]*[\s>/]` },
  ].map((entry) => Object.freeze(entry)),
);
