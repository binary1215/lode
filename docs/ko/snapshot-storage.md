# 스냅샷 저장과 보존

[English](../snapshot-storage.md)

새 로컬 World·Graph 스냅샷은 공백을 줄인 JSON을 gzip으로 압축해 `.json.gz`로 저장합니다. 기존 `.json`은 원래 경로와 바이트를 유지하며 같은 ID로 재사용합니다. 설치·재개·조회는 원본을 이관하지 않습니다.

## 인코딩과 역사 조회

기존 어댑터가 두 형식을 모두 나열하고 읽으며 실제 물리 경로를 반환합니다. 인코딩은 의미 ID·해시·부모 계보·권한을 바꾸지 않습니다. `snapshotEncoding: "json"`을 명시하면 새 파일에 공백을 줄인 비압축 JSON을 사용합니다.

신규 파일은 기존 파일을 덮어쓰지 않는 원자적 생성으로 게시합니다. 잘림·손상·충돌하는 형식은 실패로 처리하며 다른 스냅샷으로 대체해 오류를 숨기지 않습니다. 저장 실패 시 기존 포인터를 유지합니다. 일반 소스 폴백도 기존 계약대로 사용할 수 있습니다.

압축 해제 중 할당을 제한하기 위해 압축 입력은 256 MiB, 해제된 JSON은 512 MiB로 제한합니다. Context 토큰 단계·자식 stdout·MCP 한도는 바꾸지 않습니다. 기존 원시 JSON은 호출자가 적용하던 한도를 유지합니다. 해제된 객체의 ID·다이제스트·구조는 기존 typed reader가 검증합니다.

역사 boundary 참조는 정확한 물리 경로·바이트 길이·원시 SHA에 계속 묶입니다. World 참조는 두 접미사를 지원하지만 해제한 내용이 같더라도 원본을 대체할 수는 없습니다. 기존 boundary 바이트 한도도 유지합니다.

압축은 디스크 사용량을 줄이고 계산을 추가합니다. 파싱·검증·질의가 빨라졌다는 근거가 아닙니다. 같은 Project·식별자·질의를 사용해 읽기·해제·파싱·typed 검증을 구분해 측정해야 합니다. fixture 준비 뒤 첫 질의는 OS 캐시까지 비운 측정이 아닙니다.

## 저장 진단: 삭제 기능은 아직 지원하지 않습니다

```powershell
lode-agent storage-gc C:\path\to\project
lode-agent storage-gc C:\path\to\project --json
```

CLI 진단은 선택된 Session이 필요하지 않으며 새 공개 MCP 작업을 추가하지 않습니다. 짧은 출력에 개수와 보존 상태를 보여주고 구조화 출력에 물리 바이트·관측한 의존성·coverage 공백을 포함합니다.

**GC apply는 미완성이며 사용할 수 없습니다.** `--apply`나 `apply: true`를 명시해도 모든 파일을 보존하고 삭제·회수 가능량 0을 반환합니다. 관측상 미참조 용량은 추가 검증할 후보이며 안전한 삭제 대상으로 인증한 것이 아닙니다. 진단은 리뷰·체크포인트·정리 계획을 쓰지 않습니다. 기본 진단의 종료 코드는 0이며, 미지원 apply 요청은 유용한 검사 결과를 보존한 채 종료 코드 1과 `SNAPSHOT_GC_APPLY_UNAVAILABLE`을 반환합니다.

현재·이전 포인터, 부모, ChangeSet, refresh 요청·영수증, Capsule, Session·Run·체크포인트와 review·온보딩 기록의 식별자를 따라갑니다. 정확한 역사 바이트 참조도 확인합니다. 대응이 모호하면 관측된 의존성 전체를 보존합니다. 알 수 없는 스키마·안전하지 않은 경로·누락 원본·staging·진행 중이거나 불명인 writer·조회 한도 생략은 공백으로 표시합니다. 문자열 일치만으로 참조 유효성이나 부재를 인증하지 않습니다.

빠진 경계는 참조 저장 구간입니다. `compileContext`, `recordChangeSet`, 실행 계보 저장과 직접 어댑터 호출 모두가 대상 검증부터 저장 완료까지 GC와 배타적으로 보호되지는 않습니다. 삭제 전에 읽은 스냅샷을 나중에 참조할 수 있어 rename에서만 gate를 확인하면 늦습니다. apply를 완성하려면 async·중첩·전달받은 lease를 포함한 실제 transaction을 보호하고, 진행 중인 작업에는 즉시 양보해야 합니다. 이번 패치는 일반 작업에 전역 writer gate를 추가하지 않습니다.

상주 수집기나 나이·최근 N개 기준 삭제는 없습니다. 모든 스냅샷이 참조돼 있으면 관측상 미참조 개수도 0입니다. 실제 정리에는 이후 구현·검증된 apply와 명시적 실행 권한이 필요합니다.

## 생성하는 Git ignore 규칙

초기화와 명시적 재개는 선택된 `.lode/.gitignore` 또는 기존 `.head/.gitignore`가 없을 때만 새로 생성합니다. 사용자가 생성 규칙을 편집한 경우를 포함해 모든 기존 파일은 수정하지 않습니다. 덮어쓰지 않는 원자적 생성으로 동시에 생긴 파일도 보존합니다. Project에 명시적 예외가 있으면 선택적 생성을 건너뜁니다. 선택적 ignore 생성 실패는 Project 준비도나 일반 작업을 막지 않습니다.

| 저장 루트 내부 상대 패턴 | 재생성·폐기 가능한 이유 |
| --- | --- |
| `/graph-discovery/index.json` | 검증된 원본 기록에서 다시 만드는 색인. |
| `/.operations/` | 프로세스가 소유하는 일시적 scope 잠금. |
| `/refresh/writer.lock/` | 해당 Host의 실행 중 refresh lease. |
| `/refresh/writer.lock.*.staging/` | 아직 게시되지 않은 lease staging. |

스냅샷·Canon·Session 기록·Capsule·역사 boundary·설치 manifest·사용자 편집 문서를 일괄 ignore하지 않습니다. helper는 Git을 실행하거나 기존 추적·staging·전역 설정을 바꾸지 않습니다. ignore로 디스크 공간을 회수하지는 않습니다.

## 로컬 Git snapshot 실험 후보

일반 신규 저장 기본값은 gzip입니다. 내부 World/Graph 로컬 adapter의 명시적 `snapshotEncoding: "git"` 옵션만 새 snapshot을 Project 관리 디렉터리의 `snapshot-objects.git`에 저장합니다. 제품 저장소의 Git 설정·index·branch·hook 또는 원격에는 접근하지 않습니다. 기존 JSON/gzip은 이관하거나 재인코딩하지 않습니다. 기본 소비자는 세 표현을 읽을 수 있으며, 정확한 ID·Project·내용 hash 검증은 그대로 적용됩니다.

Git 원문에는 실제 파일 경로가 없으므로 필요한 World/Graph 반환값에 `file: null` 또는 `snapshotLocation: null`과 작은 `snapshotStorage` 설명을 반환합니다. 여기에는 store ID, object format/ID, encoding, 원문 byte length와 SHA-256이 포함됩니다. current pointer와 refresh receipt 경로는 실제 JSON 파일을 가리킵니다. 경로 필드가 없는 bounded World MCP status에는 새 locator를 추가하지 않습니다.

이 I/O를 소비하는 World·freshness·Compiler·계보·Explorer 및 관련 workflow는 비동기 완료값을 기다립니다. factory, hash, verifier, diff 계산은 동기로 유지합니다. CLI와 MCP는 같은 완료값과 오류를 소비하며, 조회가 snapshot을 새로 수집하거나 외부 adapter를 자동 선택하지 않습니다. legacy historical inventory 0.1의 파일 pin 형식도 바꾸지 않습니다.

각 private Git 작업은 하나의 deadline과 취소 신호를 사용하고 shell·filter·textconv·lazy fetch 없이 실행합니다. 자식 프로세스는 숨김으로 실행하고 종료까지 기다립니다. immutable ref는 create-only이며 같은 원문 경쟁 쓰기만 수렴합니다. Project/store/원문/object 불일치, 링크된 경로, 외부 alternates와 허용되지 않은 private 설정은 해당 작업을 실패시킵니다. ref 삭제·GC·자동 pack·source별 Git writer는 없습니다. 관리 store의 물리적 변경은 코드 source freshness의 입력이 아니며 실제 source·Canon·P3 변경 검사는 유지합니다.

기본값 채택은 별도 실측·독립 검토 사항입니다. packed active store의 크기만으로 원본 백업까지 포함한 전체 디스크 절감이나 읽기 성능 향상을 주장하면 안 됩니다.

## 로컬 domain bundle 시험 후보 — 기본값 변경 아님

내부 로컬 어댑터에 `snapshotLayout: "domain-bundles-v1"`를 명시한 경우에만 새 구성을 시험합니다. 일반 저장은 전체 snapshot gzip 그대로입니다. 기존 ID·JSON/gzip 원문·Git 객체·과거 byte pin을 다시 쓰지 않으며 사용자 pin/save/승인 절차를 추가하지 않습니다.

후보 Graph protocol 0.16은 관계의 `logicalRelationId`, 근거에 민감한 `contentRevisionId`/`edgeId`, 정확한 `sourceSnapshotId` 관측을 분리합니다. 논리 신원에는 Project, 양 끝의 논리 신원과 연속성 세대/불확실성, 관계 종류·출처·권한·producer가 포함됩니다. 내용 revision은 실제 endpoint·근거·freshness·confidence도 보존합니다. snapshot을 직접 가리키는 관계는 그 정확한 endpoint를 따릅니다. 삭제 후 재생성, 다른 Session, 근거·confidence 변경을 같은 revision으로 합치지 않습니다. 기존 0.15 및 이전 형식의 원래 ID와 검증은 유지합니다.

작은 구성 문서가 최대 세 불변 묶음을 참조합니다. World 코드 사실/의미 분석, snapshot 관측 소속을 분리한 코드 그래프, 나머지 그래프 구성입니다. 전체 저장소 근거를 가진 Repository와 제품/결정 관계는 변경되는 구성에 남습니다. 결정만 바뀌면 코드 묶음을 재사용하고, 정확히 복원할 때 관측 소속을 다시 결합합니다. 노드마다 파일을 만들지 않습니다. `bundleEncoding: "zstd"`는 지원 runtime에서만 명시적으로 시험하며 미지원 시 설치하지 않습니다.

코드 분석 결과는 이전에 검증된 World의 전체 입력 basis가 같을 때만 재사용합니다. Project·모든 scanner 사실·소스 범위/규칙·producer 버전·source relation 입력·관리 파일 제외가 포함됩니다. Canon/제품 관계와 연속성은 다시 계산합니다. 실제 재사용 여부를 진단 결과에 표시하며 mtime/크기나 코드 바이트만으로 판단하지 않습니다.

reader는 구성·묶음의 Project/type/schema/producer, 관리 영역 내 정확한 주소, SHA-256·복원 길이를 확인합니다. 깊이·묶음 수·총 복원량은 제한하며 기존 512 MiB 저장 상한 안에서 복원합니다. 검증 재사용은 요청 내부의 불변 주소에만 묶습니다. 누락·손상은 해당 조회에서 실패하고 현재 내용으로 메우지 않습니다. 복원된 World/Graph는 기존 의미·구조 검증도 통과해야 합니다. 물리 원문 참조와 복원 내용 digest를 구분하며 P2 방향 권위를 만들지 않습니다.

명시적 Git 후보와 결합하면 Git 구성 문서 + gzip domain 파일의 혼합 저장입니다. 모든 묶음이 Git 객체라는 의미가 아닙니다. 일반 조회·승인 시 자동 pack·삭제·ref 삭제·원격 접근은 없습니다. Git 실행 파일 부재는 `SNAPSHOT_GIT_EXECUTABLE_UNAVAILABLE`로 알리고 기존 파일 기반 읽기는 계속 동작합니다. 제품 폴더에 .git이 없어도 private 후보 저장은 가능합니다.

### typed 보존 참조 관측

`storage-gc` 구조화 결과의 `typedClosure`는 실제 검증된 Capsule·ChangeSet·실행 계보 원본에서 정확한 World·Graph·domain 묶음·retained source bundle을 따릅니다. 의미상의 path/digest 참조와 물리 byte pin을 구분합니다. 알 수 없는 원본·누락 의존성·게시 중간 상태는 보존하고 불완전성을 표시합니다. World의 파일 메타데이터만으로 실제 소스 원문 보존을 증명하지 않습니다.

조회 순서의 관측이며 트랜잭션이나 삭제 안전성 인증이 아닙니다. writer의 검증~참조 게시, active reader의 수명은 향후 collector를 위한 미완성 경계입니다. apply·ref 삭제·persistent lease는 도입하지 않으며 기존 저장을 모두 보존합니다.

private Git 저장은 자기 소유 store/staging 내부에서만 ignore를 새로 만들고, 상위 사용자 정책에 명시적 !예외가 있으면 생성을 건너뜁니다. 기존 ignore와 tracked 상태를 보존하며 stage/untrack을 수행하지 않습니다. 내부 객체는 복구 가치가 있는 보존 자료이며 disposable cache가 아닙니다.

정확한 source bundle pin은 기존 bundleKey·Project·schema·observation 검증기가 실제로 파싱한 같은 buffer의 raw digest를 사용합니다. 관측한 물리 바이트가 이 digest와 다르면 파일은 보존하되 미검증·부분 상태로 표시합니다. 경로를 전후로 다시 읽는 것만으로는 이 결합이나 ABA 치환 방지를 증명하지 못합니다. 이후 reader/writer 수명까지 인증하는 것은 아닙니다.

## 증분 규모 개선의 적용 범위

일반 whole gzip과 기존 domain-bundles-v1 계약은 유지합니다. 전체 World/Graph hash·원문·Project·권한 검증은 줄이지 않습니다. 같은 관측의 변경 원문은 분석 후 누적하지 않으며, 재사용하는 이전 분석의 소유 검증은 유지합니다. 사용자 cache/save/pin/승인 절차나 daemon은 추가하지 않습니다.

파일별 관계 재사용과 두 packed-chunk 형식은 별도 로컬 고정 후보에서 시험했습니다. 관계 재사용의 검증/복사 비용과 chunk의 전체 복원·파일 검사 비용 때문에 해당 측정에서 전체 지연이 증가해 활성 제품 경로에는 채택하지 않았습니다. 기존 domain 시험의 정확한 전체 codeAnalysisInputBasis 재사용은 유지합니다. 전체 탐색/해시·관계 생성·직렬화/검증·스냅샷 목록 및 Git namespace 검사 비용은 남아 있으며, 이 수정만으로 전체 파이프라인이 변경량에 비례한다고 하지 않습니다. 이력/원문 이관·GC·ref 삭제는 없습니다.
