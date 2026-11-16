> 이 문서는 [Using the product graph](../product-graph-usage.md)의 한국어판입니다.

# 제품 그래프 쓰는 법

이 문서는 [제품 그래프](product-graph.md)의 문서를 쓰고, 빌드하고, 검사하고, 승인하는 방법을 보여 줍니다. 노드 타입, ID, 문서 형식은 그 문서에 정의되어 있습니다.

## 문서 쓰기

문서는 Project 저장소의 `.lode/context/product-graph/` 아래에 문서마다 파일 하나로 둡니다. 제품 정의서, 유저 저니맵, IA 문서는 하나씩, 유저플로우 기획서는 유저 활동마다, 화면설계서는 화면마다 하나씩 그 ID를 이름으로 씁니다. 정책 줄은 `정책.md`에, 기능마다 뜻 한 줄은 `기능 뜻.md`에 적습니다. 이 프로젝트에만 있는 호출 방식(예: MCP tool을 등록하는 곳)은 `호출 방식 표.json`에 적습니다.

누가 확인하기 전에 쓴 문서는 추정입니다. 어느 쪽인지 `| 항목 | 내용 |` 표에 적습니다. 제품을 실행하지 않고 코드에서 썼으면 추정: 코드만 보고 쓴 추정, 화면만 보고 썼으면 화면만 보고 쓴 추정. 실행하지 않은 제품의 근거는 파일과 줄이며, 실행을 지어내지 않습니다.

기능과 코드는 쓰지 않아도 됩니다. 소스 트리에서 나옵니다. 화면요소 표에는 빌드가 보여 주는 기능 ID를 그대로 적습니다.

## 빌드

```bash
lode-agent product-graph-build <project>
```

빌드는 문서, 정책 파일과 뜻 파일, 호출 방식 표, 소스 트리를 읽고 `.lode/context/product-graph/build/` 아래에 `graph.json`, `check.json`, `check.txt`를, 처음에는 `baseline.json`도 씁니다(아래 기준 뒤 바뀐 것 참고). 그 밖에는 아무것도 쓰지 않습니다. 문서, 승인 기록, `product-model.json`은 그대로입니다. 같은 입력을 같은 폴더에 두 번 빌드하면 바이트까지 같습니다. 결과를 한 단계씩 읽으려면 아래 그래프에 묻기를 보거나 [Graph Explorer](graph-explorer.md)의 제품 그래프 보기를 엽니다.

## 검사

```bash
lode-agent product-graph-check <project>
lode-agent product-graph-check <project> --include-estimates
```

검사는 읽기만 합니다. 정합성 검사 여섯 줄과 그 뒤의 목록을 한국어로 냅니다. 기본으로는 승인된 문서만 쓰고, 빼 둔 추정 문서가 몇 개인지 알려 줍니다. `--include-estimates`를 주면 추정 문서도 쓰고, 그것에 기댄 발견마다 `[추정: 코드만 보고 쓴 추정]` 같은 표시를 붙입니다.

MCP에서는 같은 연산이 묶음 tool `lode_product_graph`의 action `build`, `check`, `query`, `baseline`, `approve`이고, `lode_tools_call`(읽기만 하는 검사와 질의는 `lode_tools_read`도 됨)로 부릅니다. 기본 tool 목록에는 없습니다.

## 승인

승인은 사용자가 문서 하나를 지금 내용 그대로 읽고 제품 설명으로 받아들였다는 기록입니다. 검사 글은 승인이 아닌 문서마다 그 줄에 승인 digest(`승인할 digest …`)를 적고, 구조화된 결과에는 `documents.list`의 `approvalDigest`로 들어갑니다. 사용자에게 그 내용을 보여 준 뒤 같은 digest로 결정을 기록합니다.

```json
{ "document": "화면설계서/CHT-01.md", "expectedSha256": "<digest from the check result>", "rationale": "Read with the user on the screen." }
```

```bash
lode-agent product-graph-approve <project> --input approval.json
```

digest를 받은 뒤 문서가 바뀌었으면 승인을 거절합니다. 승인된 문서를 고치면 다시 추정이 되고 승인 뒤 바뀜으로 나옵니다. digest는 본문으로 계산하므로(정의 문서 참고) 다른 편집기가 줄바꿈이나 BOM을 바꿔도 승인이 풀리지 않습니다. MCP에서는 `confirm_user_review: true`가 필요하고, subagent는 기록할 수 없습니다.

**승인 기록이란.** 사용자가 한 말의 기록이지 보안 경계가 아닙니다. Project 저장소에 파일을 쓸 수 있는 누구나 승인 기록을 만들 수 있습니다. MCP 경로는 확인 플래그를 요구하고 subagent는 쓸 수 없으며, CLI 경로는 사용자가 직접 하는 것입니다. 감사 기록은 `승인/` 폴더의 버전 관리 이력입니다.

## 결과 읽기

- **0건**은 적어도 한 쌍을 비교했고 아무것도 찾지 못했다는 뜻입니다.
- **검사 못 함: <이유>**는 검사를 할 수 없었다는 뜻이고 이유를 적습니다. 문서가 없음(제품 정의서가 없다), 문서는 있지만 아직 승인되지 않음, 문서에 검사에 필요한 내용이 없음, 이 판이 뽑지 않는 연결(navigate 연결을 뽑지 않음). "문제 없음"이라는 뜻이 아닙니다.
- 노드 타입 옆의 **뽑지 않음**(데이터, 외부 연결, DB, 계측 이벤트)은 이 판이 그 타입을 뽑지 않는다는 뜻입니다. 0개라는 뜻이 아닙니다.
- 제품코어와 정책은 늘 사람이 판단합니다. 검사는 둘을 나란히 냅니다.
- **처음 쓸 때 — 빠진 입력**은 검사에 필요한 문서가 없거나 아직 승인되지 않았을 때만 나옵니다. 줄마다 그 입력, 그것이 여는 검사와 목록, 다음에 할 일을 적습니다. 그 아래 검사들은 여전히 같은 이유로 검사 못 함으로 끝납니다.
- **이 그래프가 답하지 못하는 것**이 맨 먼저 나옵니다. 발견보다 먼저 읽습니다. 코드를 얼마나 풀었는지, 무엇을 뽑지 않았는지, UI 스캔이 무엇을 못 보는지, 아무것도 실행하지 않았다는 것, 이번 실행이 어떤 문서를 썼는지를 적습니다.
- **어느 기능에서도 닿지 않는 코드**는 풀린 reference로 어느 기능에서도 닿지 않는 선언을, 많은 파일부터 적습니다. 풀린 호출이 적으면 항목이 많은 것이 당연합니다. 항목은 판정이 아니라 읽는 사람에게 던지는 질문(빠진 기능인가, 죽은 코드인가)입니다.
- **하나로 정하지 못한 호출**은 이유마다 개수와 무엇이 있으면 정해지는지를 적습니다. 한계 블록은 호출을 세 수로 나눕니다. 전체, 제품 코드일 수 없거나 제품 밖 모듈로 가는 호출, 그리고 나머지 중 풀린 수입니다. **코드로 읽지 않은 파일**은 보지 않은 것을 세므로, 덮지 못한 곳이 드러납니다.
- **사라진 기능의 뜻**은 기능이 없어진 뜻 줄을 적습니다. 대개 이름을 바꾼 뒤입니다. 그 줄을 손으로 새 ID로 옮깁니다. 빌드는 `기능 뜻.md`를 고치지 않습니다.

## 그래프에 묻기

```bash
lode-agent product-graph-query <project>                      # overview: the first block and the starts
lode-agent product-graph-query <project> node cli:sync
lode-agent product-graph-query <project> down cli:sync [--depth 2]
lode-agent product-graph-query <project> up cli:sync
lode-agent product-graph-query <project> reach cli:sync       # code a 기능 reaches
lode-agent product-graph-query <project> reach src/store.mjs  # 기능 that reach a file or a 코드 node
lode-agent product-graph-query <project> find store
lode-agent product-graph-query <project> gaps [--list unreachedCode]
lode-agent product-graph-query <project> changes [--list reviewAgain]
lode-agent product-graph-query <source-root> overview --build <folder>   # a stand-alone output folder
```

질의는 이미 있는 빌드를 읽기만 하고, 빌드·검사·승인·쓰기를 하지 않습니다. 모든 답은 세 줄로 시작합니다. `graph.json`을 쓴 시각과 빌드가 지금 소스 그대로인지(빌드 뒤 바뀐 것 없음, 빌드가 낡음: …, 소스가 바뀌었는지 알 수 없음), 제품 코드일 수 있는 호출 중 몇 개를 풀었는지, 기준 뒤 무엇이 바뀌었는지입니다. 그다음 경로 줄과 들여 쓴 트리가 빌드의 말로 나옵니다. 답은 쪽으로 나뉩니다(`--limit`, 기본 50, 그리고 `--cursor`). 더 있는 답은 몇 개가 남았는지와 다음 쪽 명령을 말합니다. `down`과 시작점 `@기능`, `@기능/<kind>`, `@화면`, `@유저 활동`, `@파일`, `@바뀐 것`은 한 단계씩 갑니다. 이미 경로에 있는 노드는 위에 있음으로 표시합니다. `reach`는 풀린 call·callback 참조만 따라가고, 검사가 어느 기능에서도 닿지 않는 코드에 쓰는 것과 같은 닫힘입니다. `--json`은 구조화된 결과를 줍니다. 글자는 같은 질문에 대한 뷰어의 "글자로 보기"와 같습니다. 빌드가 없으면 답은 `PRODUCT_GRAPH_NOT_BUILT`와 빌드 명령이고, 모르는 ID는 `PRODUCT_GRAPH_NODE_NOT_FOUND`와 가까운 것들입니다.

MCP에서는 묶은 도구 `lode_product_graph`의 `query` 동작(`lode_product_graph_query`)이 같은 질문입니다. 사용자 동작이 어떤 코드에 닿는지, 무엇이 한 파일에 닿는지, 빈 곳이 어디인지 알아야 할 때 도움이 됩니다. 타입 없는 스캔이고, 보통 작업의 전제가 아닙니다.

## 기준 뒤 바뀐 것

빌드는 읽은 것을 해시합니다. 코드 노드마다 그 글(파일은 전체, 선언은 줄 범위), 기능마다 종류·처리·처리 코드(그리고 닿는 코드 전체에 대한 두 번째 해시), 문서 노드마다 적힌 값, 읽은 소스 파일마다 그 글(`inputs.sourceFiles`)입니다. 글은 BOM을 빼고 CR LF와 CR을 LF로 바꾼 뒤 비교하므로, 다른 체크아웃의 줄 끝은 아무것도 바꾸지 않고, 선언을 글을 바꾸지 않은 채 파일 안에서 옮겨도 해시는 그대로입니다. 선언은 범위 끝의 빈 줄을 뺀 글로 해시하므로, 파일의 마지막 선언 뒤에 코드를 붙이면 그 파일과 새 선언만 바뀝니다. 줄 끝이 CR뿐인 파일은 파일 전체로는 LF 사본과 같은 해시이지만, 공유 스캔이 한 줄로 읽어서 선언의 줄 범위와 해시는 LF 사본과 다릅니다. 이 해시는 생성된 `build/` 폴더에만 있고, ID는 바뀌지 않습니다. 읽는 방식은 생성기, 그 그래프 버전, 소스 분석 버전으로 비교합니다. Lode 버전은 참고로만 적으므로, 코드를 똑같이 읽는 업그레이드는 바뀐 것으로 치지 않습니다.

첫 빌드는 자신을 기준(`build/baseline.json`)으로 삼고 "기준 없음 — 이번 빌드를 기준으로 삼았다"고 말합니다. 뒤의 빌드는 기준과 비교하고 기준을 옮기지 않으므로, 다시 빌드해도 기준 뒤 바뀐 것을 모두 계속 보여 줍니다. `check.txt`와 `check.json`(`changes`)은 한계 바로 다음에 이것을 줍니다. 기준을 잡은 때와 그 뒤 움직인 것(소스 파일, 문서, 호출 방식 표, 읽는 방식), 노드 종류별로 변화 없음은 수로, 변경·신규·사라짐은 ID로, 자신의 내용은 같지만 닿는 코드가 바뀐 기능(닿는 코드가 바뀜)과 바뀐 노드, 새로 생기거나 사라진 연결, 옮겨졌을 수 있는 쌍(같은 종류·이름·내용), 소스가 그대로인 곳에서 달라진 것, 그리고 **다시 볼 것**: 바뀐 것을 가리키는 뜻 줄과 문서 줄(화면요소→기능, 기능→화면요소, 화면→코드)과 그 문서의 상태입니다. 그중 승인된 문서는 "승인된 문서가 가리키는 것이 기준 뒤 바뀜"으로 표시하고 승인은 그대로 둡니다. 그 글이 아직 맞는지는 사람이 판단하기 때문입니다. 빌드는 문서, 뜻 줄, 승인을 바꾸지 않습니다.

```bash
lode-agent product-graph-baseline <project>
```

기준은 이 명령으로만 옮겨집니다. 이미 있는 빌드를 기준으로 삼고, 그 빌드가 지금 소스 그대로가 아니면 `PRODUCT_GRAPH_BUILD_STALE`로 거절하며, 바뀐 것과 다시 볼 것 몇 개가 목록에서 빠지는지 말합니다. `build/`를 지우면 그 목록만 잃습니다. 빌드가 지금 소스 그대로인지는 빌드가 읽은 모든 파일과 새로 생긴 코드 파일로 확인합니다. 코드가 아닌 새 파일(예: hook JSON이나 플러그인 매니페스트)은 다음 빌드에서야 보입니다. 같은 읽는 방식에서 기준과 글이 같은 파일의 노드가 해시나 줄 범위가 다르면 빌드는 `PRODUCT_GRAPH_NOT_REPRODUCIBLE`로 멈추고 아무것도 쓰지 않습니다.

## 다른 폴더를 건드리지 않고 비교하기

빌드와 검사는 Lode Project가 아닌 폴더에서도 돕니다. 모든 위치를 직접 줍니다. 분석하는 폴더에는 아무것도 쓰지 않고, 승인 기록을 읽지 않으므로 모든 문서가 추정입니다.

```bash
lode-agent product-graph-build <source-root> --documents <folder> --rules <entry-rules.json> --out <folder> --include-estimates
lode-agent product-graph-check <source-root> --documents <folder> --rules <entry-rules.json> --include-estimates
```

문서 폴더는 저장소 폴더와 같은 구조를 씁니다. 규칙 파일의 규칙 목록은 비어 있어도 됩니다. `--out`은 문서 폴더(또는 그 안)나 소스 루트일 수 없고, 지정한 폴더의 출력 파일 세 개는 빌드할 때마다 바뀝니다.

## 명령 표를 위한 규칙

제품이 명령을 표의 항목으로 등록한다면, 프로젝트 규칙으로 명령마다 그 항목에서 처리 코드를 가져올 수 있습니다. 이런 표라면:

```javascript
export const COMMANDS = [
  { command: "save", handler: saveFile },
  { command: "export", load: () => import("./export.mjs").then((m) => m.runExport) },
];
```

`호출 방식 표.json`에 이렇게 씁니다.

```json
{ "종류": "cli", "판단": true, "파일": ["src/commands.mjs"], "패턴": "command: \"([a-z-]+)\"", "처리 코드": "항목" }
```

그러면 `cli:save`의 처리 코드는 `saveFile`, `cli:export`의 처리 코드는 `runExport`가 됩니다. 패턴은 다른 곳의 언급이 아니라 항목 자신의 키에 맞게 씁니다. 여러 항목에서 나온 기능은 목록에 나오므로 패턴을 좁힐 수 있습니다.

## 표에 없는 전역 이름

내장 이름 표에 없는 런타임 전역(예를 들어 호스트가 따로 주는 전역)을 부르면 선언이 없는 호출로 셉니다. `호출 방식 표.json`의 `"내장 이름"`에 언어별로 그 이름을 더합니다.

```json
{ "schemaVersion": 1, "kind": "LodeProductGraphEntryRules", "rules": [], "내장 이름": { "javascript": { "함수": ["hostLog"], "네임스페이스": ["host"] } } }
```

그러면 그 이름을 선언·들여오거나 묶지 않는 모든 파일에서 `hostLog(x)`는 내장 함수, `host.run(x)`는 내장 네임스페이스의 멤버입니다.
