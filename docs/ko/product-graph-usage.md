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

빌드는 문서, 정책 파일과 뜻 파일, 호출 방식 표, 소스 트리를 읽고 `.lode/context/product-graph/build/` 아래에 `graph.json`, `check.json`, `check.txt`를 씁니다. 그 밖에는 아무것도 쓰지 않습니다. 문서, 승인 기록, `product-model.json`은 그대로입니다. 같은 입력으로 두 번 빌드하면 바이트까지 같습니다.

## 검사

```bash
lode-agent product-graph-check <project>
lode-agent product-graph-check <project> --include-estimates
```

검사는 읽기만 합니다. 정합성 검사 여섯 줄과 그 뒤의 목록을 한국어로 냅니다. 기본으로는 승인된 문서만 쓰고, 빼 둔 추정 문서가 몇 개인지 알려 줍니다. `--include-estimates`를 주면 추정 문서도 쓰고, 그것에 기댄 발견마다 `[추정: 코드만 보고 쓴 추정]` 같은 표시를 붙입니다.

MCP에서는 같은 연산이 묶음 tool `lode_product_graph`의 action `build`, `check`, `approve`이고, `lode_tools_call`(검사는 `lode_tools_read`도 됨)로 부릅니다. 기본 tool 목록에는 없습니다.

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
- **하나로 정하지 못한 호출**은 이유마다 개수와 무엇이 있으면 정해지는지를 적습니다. **코드로 읽지 않은 파일**은 보지 않은 것을 세므로, 덮지 못한 곳이 드러납니다.
- **사라진 기능의 뜻**은 기능이 없어진 뜻 줄을 적습니다. 대개 이름을 바꾼 뒤입니다. 그 줄을 손으로 새 ID로 옮깁니다. 빌드는 `기능 뜻.md`를 고치지 않습니다.

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
