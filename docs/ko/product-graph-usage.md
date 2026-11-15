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

승인은 사용자가 문서 하나를 지금 내용 그대로 읽고 제품 설명으로 받아들였다는 기록입니다. 검사 결과에 문서마다 digest가 나옵니다. 사용자에게 그 내용을 보여 준 뒤 같은 digest로 결정을 기록합니다.

```json
{ "document": "화면설계서/CHT-01.md", "expectedSha256": "<digest from the check result>", "rationale": "Read with the user on the screen." }
```

```bash
lode-agent product-graph-approve <project> --input approval.json
```

digest를 받은 뒤 문서가 바뀌었으면 승인을 거절합니다. 승인된 문서를 고치면 다시 추정이 됩니다. MCP에서는 `confirm_user_review: true`가 필요하고, subagent는 기록할 수 없습니다.

## 결과 읽기

- **0건**은 적어도 한 쌍을 비교했고 아무것도 찾지 못했다는 뜻입니다.
- **검사 못 함: <이유>**는 검사를 할 수 없었다는 뜻이고 이유를 적습니다. 문서가 없음(제품 정의서가 없다), 문서는 있지만 아직 승인되지 않음, 문서에 검사에 필요한 내용이 없음, 이 판이 뽑지 않는 연결(navigate 연결을 뽑지 않음). "문제 없음"이라는 뜻이 아닙니다.
- 노드 타입 옆의 **뽑지 않음**(데이터, 외부 연결, DB, 계측 이벤트)은 이 판이 그 타입을 뽑지 않는다는 뜻입니다. 0개라는 뜻이 아닙니다.
- 제품코어와 정책은 늘 사람이 판단합니다. 검사는 둘을 나란히 냅니다.

## 다른 폴더를 건드리지 않고 비교하기

빌드와 검사는 Lode Project가 아닌 폴더에서도 돕니다. 모든 위치를 직접 줍니다. 분석하는 폴더에는 아무것도 쓰지 않고, 승인 기록을 읽지 않으므로 모든 문서가 추정입니다.

```bash
lode-agent product-graph-build <source-root> --documents <folder> --rules <entry-rules.json> --out <folder> --include-estimates
lode-agent product-graph-check <source-root> --documents <folder> --rules <entry-rules.json> --include-estimates
```

문서 폴더는 저장소 폴더와 같은 구조를 씁니다. 규칙 파일의 규칙 목록은 비어 있어도 됩니다.
