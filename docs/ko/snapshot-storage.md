# 스냅샷 저장과 보존

[English](../snapshot-storage.md)

새 로컬 World·Graph 스냅샷은 공백을 줄인 JSON을 gzip으로 압축해 `.json.gz`로 저장합니다. 기존 `.json`은 원래 경로와 바이트를 유지하며 같은 ID로 재사용합니다. 설치·재개·조회는 원본을 이관하지 않습니다.

선택된 Project 소유 근거가 있는 일반적인 완전한 World·Graph 저장은 `shared-domains-v2`를 사용합니다. 바뀌는
구성은 gzip 루트에 넣고, World는 최대 두 개·Graph는 최대 한 개의 불변 코드 묶음을
참조합니다. 묶음은 기존 schema 1 / producer 0.1.0 그대로이며 루트만 schema 2 /
producer 0.2.0입니다. 이전 스냅샷을 연쇄 재생하지 않습니다. 결정 변경은 코드 묶음을
재사용할 수 있지만 코드 변경은 묶음 전체를 새로 저장할 수 있고, 소속 메타데이터도
그래프 크기에 따라 늘어납니다. 첫 조회의 부분 IO나 O(change) 처리를 뜻하지 않습니다.

선택된 Project 소유 근거가 없는 순수 하위 adapter는 기존 whole 문서 저장을
유지하며 초기화를 요구하지 않습니다. 명시적 composition 선택은 소유 근거를
요구하고 전체 검증을 그대로 수행합니다.

최소 reader는 물리 schema 2를 지원하는 릴리스입니다. **Beta.69 이하는 새 루트를
`INVALID_SNAPSHOT_COMPOSITION`으로 거부**하며 구형으로 다시 쓰지 않습니다.
새 World·Graph를 쓰기 전에 이를 읽을 모든 공유 Project 클라이언트를 업데이트하세요.
이는 형식 호환 안내이며 새로운 설정·승인 게이트가 아닙니다. 새 reader는 기존 whole
JSON/gzip·Git·domain-v1 원본을 제자리에서 읽습니다. 명시적 whole/Git/v1 선택도
유지합니다. 물리 형식 때문에 새 의미 payload에 필드를 넣지 않으며, v1에 이미 기록된
분석 필드는 변경 없는 이력의 신원을 유지하도록 승계합니다.

묶음 주소·Project·타입·producer·digest와 재구성한 전체 World·Graph 검증은
유지합니다. 기존 보존·삭제 closure와 reader·publisher 수명이 참조 묶음을 포함합니다.
누락·손상·권한 거부는 해당 읽기의 오류이며 현재 데이터로 대체하지 않습니다.
Graph 포인터 다음 World 포인터를 게시하는 기존 부분 실패 보고도 유지합니다.
새 형식이 두 포인터의 원자적 트랜잭션이나 이미 완료된 효과의 롤백을 만들지는 않습니다.


## 저장 방식 요약

| 선택 | 용도 |
| --- | --- |
| gzip `shared-domains-v2` | 검증된 선택 소유 근거가 있는 완전한 저장의 기본값입니다. |
| Whole JSON/gzip | 보존된 과거 파일과 선택 소유 근거가 없는 하위 adapter입니다. |
| Private Git | 명시적으로 선택하며 기존 원본 검증을 유지합니다. |
| Domain-v1 또는 zstd | 명시적 시험이며 런타임 지원 여부를 알립니다. |
| GC 조회 | 읽기 전용이며 일반 시작에 정리가 필요하지 않습니다. |
| 명시적 GC 적용 | 기존 안전 계약에 따라 지원되고 검증된 미참조 저장물만 삭제합니다. |

## 인코딩과 역사 조회

기존 어댑터가 두 형식을 모두 나열하고 읽으며 실제 물리 경로를 반환합니다. 인코딩은 의미 ID·해시·부모 계보·권한을 바꾸지 않습니다. `snapshotEncoding: "json"`을 명시하면 새 파일에 공백을 줄인 비압축 JSON을 사용합니다.

신규 파일은 기존 파일을 덮어쓰지 않는 원자적 생성으로 게시합니다. 잘림·손상·충돌하는 형식은 실패로 처리하며 다른 스냅샷으로 대체해 오류를 숨기지 않습니다. 단일 파일 게시 실패는 해당 파일의 이전 포인터를 유지합니다. Graph와 World 포인터 게시가 별도이므로 부분 성공은 여전히 보고될 수 있습니다. 일반 소스 폴백도 기존 계약대로 사용할 수 있습니다.

압축 해제 중 할당을 제한하기 위해 압축 입력은 256 MiB, 해제된 JSON은 512 MiB로 제한합니다. Context 토큰 단계·자식 stdout·MCP 한도는 바꾸지 않습니다. 기존 원시 JSON은 호출자가 적용하던 한도를 유지합니다. 해제된 객체의 ID·다이제스트·구조는 기존 typed reader가 검증합니다.

역사 boundary 참조는 정확한 물리 경로·바이트 길이·원시 SHA에 계속 묶입니다. World 참조는 두 접미사를 지원하지만 해제한 내용이 같더라도 원본을 대체할 수는 없습니다. 기존 boundary 바이트 한도도 유지합니다.

압축은 디스크 사용량을 줄이고 계산을 추가합니다. 파싱·검증·질의가 빨라졌다는 근거가 아닙니다. 같은 Project·식별자·질의를 사용해 읽기·해제·파싱·typed 검증을 구분해 측정해야 합니다. fixture 준비 뒤 첫 질의는 OS 캐시까지 비운 측정이 아닙니다.

## 저장 진단과 명시적 정리

```powershell
lode-agent storage-gc C:\path\to\project
lode-agent storage-gc C:\path\to\project --json
lode-agent storage-gc C:\path\to\project --apply --json
```

기본 진단은 파일을 쓰거나 삭제하지 않습니다. 관측상 미참조 용량은 진단이며, 안전한 삭제의 증명이나 실행 권한은 아닙니다. 선택된 Session·새 MCP 도구·사용자 pin/save 입력·상주 수집기가 필요하지 않습니다.

CLI에서 `--apply`를 명시하면 별도의 typed 참조 검증이 끝날 때까지 기다린 뒤, 미참조가 증명된 World/Graph JSON·gzip 표현, 지원하는 private Git 스냅샷 주소·객체, 보존 참조가 없는 domain 조각을 정리합니다. 현재·이전 포인터, 부모와 source alias, Capsule, 지원하는 ChangeSet/VCS·실행 계보·Session/checkpoint 및 정확한 물리 바이트 참조를 보존합니다. Canon·Session 기록과 유효 source bundle은 삭제하지 않습니다. 성공·실패 source bundle은 파일 자체가 P3 관찰 기록 원본이므로 보존 root입니다. 나이·최근 N개 기준은 없으며 모두 참조 중이면 정상 완료해도 삭제는 0개입니다.

지원하는 경로와 원본 검증기는 `scripts/lib/snapshot-deletion-closure.mjs`에 명시돼 있습니다. Core 초기화, whole snapshot, Capsule, 실행 계보, checkpoint, 일반 SessionWork/Todo, 별도로 선택되는 Session 포인터, 검토된 Run 원본, ChangeSet/영향 검토 포인터를 지원합니다. 나머지 Product/온보딩·refresh·Run/Session·관측 기록은 정확한 경로에 원본 검증기가 등록된 경우만 지원합니다. 알 수 없는 경로/스키마, 누락·손상된 의존성, 불완전한 제한 조회, 미지원 backend 구조, 위험 경로, 불명 소유자는 후보 전체를 보존하며 이유를 표시합니다. 이 첫 파일 collector가 기존의 모든 기록 형태를 처리한다고 주장하지 않습니다. 소스 원문 보존 부족과 snapshot 도달성은 구분하며 정리를 위해 원문을 다시 수집하지 않습니다.

협조하는 현재 로컬 writer는 첫 원본 검증 전에 일시적인 Project 내부 P5 수명을 등록하고 실제 비동기 완료까지 유지합니다. 일반 작업이 들어오면 해당 GC 시도는 영구 무효화됩니다. 작업이 scan 도중 시작했다 끝난 경우도 놓치지 않습니다. 짧은 공용 잠금은 등록·한 파일 삭제에만 사용하고 파싱·해시·await 동안 일반 작업을 직렬화하지 않습니다. 빌린 lease·중첩 작업도 보호합니다. 끝난 부모의 detached 작업은 예전 참조를 그대로 게시하지 못합니다. 동기 pointer API와 기존 의미 계약을 유지하며 새 Product 승인 gate를 넣지 않습니다. 별도 저수준 호출 사이의 orphan 예약까지 보장하지는 않습니다.

순수 조회는 관리 파일을 쓰거나 참여 등록을 하지 않습니다. 계속 보존되는 불변 root의 전체 의존성이 과거 조회를 보호하며, 이미 확보한 바이트 계산은 추가 파일을 열 필요가 없습니다. 임의 orphan ID의 직접 조회와 명시 정리가 경합하면 실제 missing/unavailable을 반환할 수 있고 current로 대체하지 않습니다. 미지원·불명 범위에서는 정리를 보류하며 무관한 작업을 막지 않습니다. 등록 실패 후 그 순간 GC가 없다는 이유로 보호 없는 참조 게시를 계속하지 않습니다.

스캔은 한 번에 원본 한 파일만 해제하고 기존 순수 typed 검증을 적용한 뒤 ID·source alias·전체 hash·정확한 물리 pin 요약만 보유합니다. 개별 파일의 기존 512 MiB 해제 상한은 할당/파싱 전에 적용하고, 전체 저장 입력 1 GiB·최대 50,000 항목·인코딩한 요약 64 MiB 상한을 적용합니다. 누적 해제량은 계측하되 작은 누적 decoded 한도로 정상 이력을 일괄 차단하지 않습니다. 이 수치는 V8 전체 RSS 보장이 아닙니다. 파일 사이에 event loop를 양보하고 취소를 확인해 일반 작업이 들어오면 다음 파일 전에 중단합니다.

GC만 OS 파일시스템을 확인합니다. Windows는 숨김·기한 제한 DriveInfo 조회로 고정 드라이브 여부를 확인하고 mapped/network/불명 드라이브를 보존합니다. Linux는 statfs의 ext 계열·XFS·Btrfs·tmpfs만 현재 지원합니다. 다른 플랫폼·알 수 없는 FS는 정리를 보존합니다. 일반 작업에 PowerShell 조회를 추가하지 않으며, 정적으로 비지원인 플랫폼/UNC/Linux FS에서는 새 writer 등록도 요구하지 않습니다. OS 분류가 모든 숨겨진 backing layer나 비협조 host의 부재를 증명하지는 않습니다.

지원하는 혼합 backend는 함께 검증하며, 디렉터리가 있다는 이유로 GC 전체를 막거나 게시 수명 등록을 우회하지 않습니다. owner/config가 없는 잘못된 Git marker는 계속 GC에서 제외하고 기존 일반 작업 우회를 유지합니다. 초기 Git retirement는 Core 소유 SHA256 direct loose ref이며 packed ref·reflog·snapshot symref가 없는 형식만 지원합니다. 두 lock을 대기 없이 소유하고 ref 하나를 정확한 OID·실물 identity로 비교·삭제합니다. 미지원 형식은 보존하며, source 원본은 다른 Git/domain orphan 정리를 막지 않고 자체 보존합니다.

지원 경계는 협조하는 현재 로컬 entry와 일관된 로컬 파일시스템입니다. 구버전/raw writer·공유 host 전체의 배제를 증명하지 않습니다. 알려진 외부/불명 소유권·미지원 저장소는 보존하고, 새 lock이 없다는 이유로 옛 프로세스가 모두 종료됐다고 보지 않습니다. 나이·PID 추측으로 snapshot 수명 기록을 회수하지 않습니다. 일시 participant/attempt는 P2 방향·review·보존 계획이 아닙니다.

구조화 결과는 삭제·실패·보존 경로를 구분합니다. 취소·변조·후속 unlink 실패가 있어도 이미 삭제한 개수와 바이트를 지우지 않습니다. `gc_applied`는 종료 코드 0, 보존·양보·부분 결과는 유용한 결과를 남기며 종료 코드 1입니다. 일반 출력도 삭제 0건의 성공·다른 작업에 양보·미지원·미완료 보존·부분 효과를 구분하며 오류 코드를 숨기지 않습니다. 효과를 자동 재실행하지 않습니다. Git ref retirement와 실물 회수는 별도 결과입니다. 실제 unlink 바이트·새 pack 바이트·순수 관리 파일 감소량을 구분하며 파일 길이를 OS 할당 블록 반환으로 과장하지 않습니다. 이관·설치는 별도입니다.

## 생성하는 Git ignore 규칙

초기화와 명시적 재개는 선택된 `.lode/.gitignore` 또는 기존 `.head/.gitignore`가 없을 때만 새로 생성합니다. 사용자가 편집한 파일을 포함해 모든 기존 파일은 수정하지 않으며, 덮어쓰지 않는 원자적 생성으로 동시에 생긴 파일도 보존합니다. 생성 규칙마다 루트 예외와의 충돌을 따로 확인합니다. 예를 들어 `!.gitkeep`가 있어도 정확한 `/graph-discovery/index.json`은 생성하고, 하위 `.gitkeep`를 가릴 수 있는 디렉터리 규칙은 보존합니다. 확실히 무관한 루트 예외는 해당 규칙을 허용하고, 겹치거나 모호한 와일드카드·escape는 건너뜁니다. 결과에 포함·제외된 규칙을 구분합니다. 생성 직전에 정책 바이트를 다시 확인하되 외부 편집기를 잠그거나 추적 중인 파일을 바꾸지는 않습니다. 선택적 생성 실패는 Project 준비도나 일반 작업을 막지 않습니다.

| 저장 루트 내부 상대 패턴 | 재생성·폐기 가능한 이유 |
| --- | --- |
| `/graph-discovery/index.json` | 검증된 원본 기록에서 다시 만드는 색인. |
| `/.snapshot-gc/` | 일시적 snapshot participant와 GC 시도. |
| `/.operations/` | 프로세스가 소유하는 일시적 scope 잠금. |
| `/refresh/writer.lock/` | 해당 Host의 실행 중 refresh lease. |
| `/refresh/writer.lock.*.staging/` | 아직 게시되지 않은 lease staging. |

스냅샷·Canon·Session 기록·Capsule·역사 boundary·설치 manifest·사용자 편집 문서를 일괄 ignore하지 않습니다. helper는 Git을 실행하거나 기존 추적·staging·전역 설정을 바꾸지 않습니다. ignore로 디스크 공간을 회수하지는 않습니다.

## 로컬 Git snapshot 실험 후보

일반 신규 저장 기본값은 gzip입니다. 내부 World/Graph 로컬 adapter의 명시적 `snapshotEncoding: "git"` 옵션만 새 snapshot을 Project 관리 디렉터리의 `snapshot-objects.git`에 저장합니다. 제품 저장소의 Git 설정·index·branch·hook 또는 원격에는 접근하지 않습니다. 기존 JSON/gzip은 이관하거나 재인코딩하지 않습니다. 기본 소비자는 세 표현을 읽을 수 있으며, 정확한 ID·Project·내용 hash 검증은 그대로 적용됩니다.

Git 원문에는 실제 파일 경로가 없으므로 필요한 World/Graph 반환값에 `file: null` 또는 `snapshotLocation: null`과 작은 `snapshotStorage` 설명을 반환합니다. 여기에는 store ID, object format/ID, encoding, 원문 byte length와 SHA-256이 포함됩니다. current pointer와 refresh receipt 경로는 실제 JSON 파일을 가리킵니다. 경로 필드가 없는 bounded World MCP status에는 새 locator를 추가하지 않습니다.

이 I/O를 소비하는 World·freshness·Compiler·계보·Explorer 및 관련 workflow는 비동기 완료값을 기다립니다. factory, hash, verifier, diff 계산은 동기로 유지합니다. CLI와 MCP는 같은 완료값과 오류를 소비하며, 조회가 snapshot을 새로 수집하거나 외부 adapter를 자동 선택하지 않습니다. legacy historical inventory 0.1의 파일 pin 형식도 바꾸지 않습니다.

각 private Git 작업은 하나의 deadline과 취소 신호를 사용하고 shell·filter·textconv·lazy fetch 없이 실행합니다. 자식 프로세스는 숨김으로 실행하고 종료까지 기다립니다. immutable ref는 create-only이며 같은 원문 경쟁 쓰기만 수렴합니다. Project/store/원문/object 불일치, 링크된 경로, 외부 alternates와 허용되지 않은 private 설정은 해당 작업을 실패시킵니다. 일반 조회·쓰기는 ref 삭제·GC·자동 pack을 하지 않습니다. 위 명시적 정리만 지원하는 orphan 저장물을 회수하며 source별 Git writer는 추가하지 않습니다. 관리 store의 물리적 변경은 코드 source freshness의 입력이 아니며 실제 source·Canon·P3 변경 검사는 유지합니다.

기본값 채택은 별도 실측·독립 검토 사항입니다. packed active store의 크기만으로 원본 백업까지 포함한 전체 디스크 절감이나 읽기 성능 향상을 주장하면 안 됩니다.

## 로컬 domain bundle 시험 후보 — 기본값 변경 아님

내부 로컬 어댑터의 명시적 `snapshotLayout: "domain-bundles-v1"` 시험은 유지합니다. 일반적인 완전한 스냅샷은 위의 flat v2를 쓰며, `snapshotLayout: "whole"`은 전체 파일 저장을 유지합니다. 기존 ID·JSON/gzip 원문·Git 객체·과거 byte pin을 다시 쓰지 않으며 사용자 pin/save/승인 절차를 추가하지 않습니다.

후보 Graph protocol 0.16은 관계의 `logicalRelationId`, 근거에 민감한 `contentRevisionId`/`edgeId`, 정확한 `sourceSnapshotId` 관측을 분리합니다. 논리 신원에는 Project, 양 끝의 논리 신원과 연속성 세대/불확실성, 관계 종류·출처·권한·producer가 포함됩니다. 내용 revision은 실제 endpoint·근거·freshness·confidence도 보존합니다. snapshot을 직접 가리키는 관계는 그 정확한 endpoint를 따릅니다. 삭제 후 재생성, 다른 Session, 근거·confidence 변경을 같은 revision으로 합치지 않습니다. 기존 0.15 및 이전 형식의 원래 ID와 검증은 유지합니다.

작은 구성 문서가 최대 세 불변 묶음을 참조합니다. World 코드 사실/의미 분석, snapshot 관측 소속을 분리한 코드 그래프, 나머지 그래프 구성입니다. 전체 저장소 근거를 가진 Repository와 제품/결정 관계는 변경되는 구성에 남습니다. 결정만 바뀌면 코드 묶음을 재사용하고, 정확히 복원할 때 관측 소속을 다시 결합합니다. 노드마다 파일을 만들지 않습니다. `bundleEncoding: "zstd"`는 지원 runtime에서만 명시적으로 시험하며 미지원 시 설치하지 않습니다.

코드 분석 결과는 이전에 검증된 World의 전체 입력 basis가 같을 때만 재사용합니다. Project·모든 scanner 사실·소스 범위/규칙·producer 버전·source relation 입력·관리 파일 제외가 포함됩니다. Canon/제품 관계와 연속성은 다시 계산합니다. 실제 재사용 여부를 진단 결과에 표시하며 mtime/크기나 코드 바이트만으로 판단하지 않습니다.

reader는 구성·묶음의 Project/type/schema/producer, 관리 영역 내 정확한 주소, SHA-256·복원 길이를 확인합니다. 깊이·묶음 수·총 복원량은 제한하며 기존 512 MiB 저장 상한 안에서 복원합니다. 검증 재사용은 요청 내부의 불변 주소에만 묶습니다. 누락·손상은 해당 조회에서 실패하고 현재 내용으로 메우지 않습니다. 복원된 World/Graph는 기존 의미·구조 검증도 통과해야 합니다. 물리 원문 참조와 복원 내용 digest를 구분하며 P2 방향 권위를 만들지 않습니다.

명시적 Git 후보와 결합하면 Git 구성 문서 + gzip domain 파일의 혼합 저장입니다. 모든 묶음이 Git 객체라는 의미가 아닙니다. 일반 조회·승인 시 자동 pack·삭제·ref 삭제·원격 접근은 없습니다. Git 실행 파일 부재는 `SNAPSHOT_GIT_EXECUTABLE_UNAVAILABLE`로 알리고 기존 파일 기반 읽기는 계속 동작합니다. 제품 폴더에 .git이 없어도 private 후보 저장은 가능합니다.

### typed 보존 참조 관측

`storage-gc` 구조화 결과의 `typedClosure`는 실제 검증된 Capsule·ChangeSet·실행 계보 원본에서 정확한 World·Graph·domain 묶음·retained source bundle을 따릅니다. 의미상의 path/digest 참조와 물리 byte pin을 구분합니다. 알 수 없는 원본·누락 의존성·게시 중간 상태는 보존하고 불완전성을 표시합니다. World의 파일 메타데이터만으로 실제 소스 원문 보존을 증명하지 않습니다.

이 typedClosure는 조회 순서의 관측이며 삭제 안전성 인증이 아닙니다. 명시 apply는 위의 별도 typed 삭제 의존성 검증과 일시 writer 수명을 사용합니다. 이 관측 결과만으로 삭제하지 않으며 Git ref와 원본 묶음은 보존합니다.

private Git 저장은 자기 소유 store/staging 내부에서만 ignore를 새로 만들고, 상위 사용자 예외가 그 영역과 확실히 무관할 때 생성을 허용합니다. 영향을 줄 수 있거나 모호한 예외는 사용자 정책을 보존합니다. 기존 ignore와 tracked 상태를 보존하며 stage/untrack을 수행하지 않습니다. 내부 객체는 복구 가치가 있는 보존 자료이며 disposable cache가 아닙니다.

정확한 source bundle pin은 기존 bundleKey·Project·schema·observation 검증기가 실제로 파싱한 같은 buffer의 raw digest를 사용합니다. 관측한 물리 바이트가 이 digest와 다르면 파일은 보존하되 미검증·부분 상태로 표시합니다. 경로를 전후로 다시 읽는 것만으로는 이 결합이나 ABA 치환 방지를 증명하지 못합니다. 이후 reader/writer 수명까지 인증하는 것은 아닙니다.

## 증분 규모 개선의 적용 범위

명시적 whole-file gzip과 기존 domain-bundles-v1 읽기·쓰기 계약은 유지합니다. 전체 World/Graph hash·원문·Project·권한 검증은 줄이지 않습니다. 같은 관측의 변경 원문은 분석 후 누적하지 않으며, 재사용하는 이전 분석의 소유 검증은 유지합니다. 사용자 cache/save/pin/승인 절차나 daemon은 추가하지 않습니다.

파일별 관계 재사용과 두 packed-chunk 형식은 별도 로컬 고정 후보에서 시험했습니다. 관계 재사용의 검증/복사 비용과 chunk의 전체 복원·파일 검사 비용 때문에 해당 측정에서 전체 지연이 증가해 활성 제품 경로에는 채택하지 않았습니다. 기존 domain 시험의 정확한 전체 codeAnalysisInputBasis 재사용은 유지합니다. 전체 탐색/해시·관계 생성·직렬화/검증·스냅샷 목록 및 Git namespace 검사 비용은 남아 있으며, 이 수정만으로 전체 파이프라인이 변경량에 비례한다고 하지 않습니다. 증분 분석 개선이 자동으로 이력·원문 이관이나 GC·ref 삭제를 실행하지 않으며, 명시적 storage-gc는 위의 별도 계약을 따릅니다.

### 요청 안에서의 private Git 읽기

Private Git 객체는 선택한 객체 묶음마다 제한된 `cat-file --batch` 자식으로 읽습니다. 정확한 OID·객체 type·선언 크기·Git 원문 hash·frame 종결자·완전한 EOF를 확인합니다. metadata를 먼저 검증한 뒤 snapshot 본문 한도를 정하고, decoder가 stream buffer를 소유합니다. 같은 작업 deadline·취소를 적용하며 모든 자식의 종료를 확인한 뒤 반환합니다. 격리된 정리 검증도 main store로 우회하지 않고 같은 프로토콜을 소비합니다.

바뀌는 것은 하위 프로세스 조정입니다. 전체 World/Graph·Project 검증과 정확한 snapshot 주소·namespace 검사·기존 게시/정리 수명은 유지합니다. daemon·네트워크·공유 권한·영구 읽기 cache를 추가하지 않습니다. 명시적 whole gzip도 계속 사용할 수 있으며 자식 수 감소만으로 프로젝트 전체 성능 향상을 주장하지 않습니다.

## 혼합 저장소의 실제 물리 회수

명시적 정리는 stdout을 제한된 stream으로 받아 자기완결 pack을 만듭니다. 쓰기 전에 SHA256 index-v2 공간을 예약하고 하나의 전체 deadline을 공유합니다. 기존 DB나 alternate가 없는 격리 scratch에서 필요한 모든 OID·type·raw hash를 검증합니다. 새 pack을 먼저, idx를 마지막으로 공개하고 old idx부터 제거합니다. 완전히 같은 기존 pair는 검증해 재사용하며 삭제 대상에서 제외합니다. 보존·삭제 실패한 snapshot 표현의 domain/object 의존성은 계속 운영상 pin입니다. 실제 history 전체가 참조 중이면 스냅샷 삭제 0이 정답입니다.

Pack 생성·index·검증은 기존 검증된 native process supervisor로 자식 트리를 정리합니다. 이 기능이 없으면 physical pack 단계만 보류하며 일반 조회·작업의 새 필수조건으로 삼지 않습니다. 기존 one-shot 입력 4 MiB 경계를 실행 전에 검사하고 목록을 잘라 부분 pack을 성공으로 만들지 않습니다. 취소·공간 부족·불명 lock/sidecar·부분 효과를 그대로 보고합니다. 일반 작업 옆에서 destructive Git prune/repack을 실행하지 않습니다. 순수 Git 조회는 제한된 pack 열기 경합에서 처음 고른 OID·store·raw hash만 재획득하며 current를 새로 고르거나 권한·digest 실패를 숨기지 않습니다.

동기·zero-write 진단은 Git/domain 바이너리 내부를 잘못 텍스트로 읽지 않고 추가 backend 관측이 필요함을 표시합니다. CLI에는 기존의 비동기 typed 보존 투영도 포함됩니다. 어느 조회도 삭제 인증은 아닙니다. 불명 crash staging/pack은 보존하며 나이·PID 추측으로 소유권을 훔치거나 예전 효과를 자동 재실행하지 않습니다.

후속 명시적 정리는 owner/config·정확한 실물 identity·PACK checksum·snapshot metadata를 격리 scratch에서 검증한 뒤 올바른 이름의 private pack을 idx 없이도 다시 조사할 수 있습니다. scratch는 순차 생성하고 다음 pack·producer 전에 제거하며, 전체 임시 저장 공간과 작업 deadline을 공유합니다. 순수 진단은 계속 무기록 조회입니다. 알 수 없거나 손상된 내용·다른 Project의 metadata, 보존 의존성 증명 부족은 남은 후보 전체를 보존합니다. 전체 의존성은 입증됐지만 main producer가 정확한 보존 객체를 읽을 수 없는 경우에만 물리 pack 단계를 보류합니다. scratch index로 main을 복구하지 않습니다. 새로운 producer가 전체 보존 집합을 독립 검증한 경우에만 변경 없는 동일 unindexed pack을 재사용하고 자기 index를 마지막으로 게시할 수 있으며, 이전 효과의 replay가 아닌 새 명시적 정리입니다.

일시 participant/attempt와 두 create-only ref lock은 Project·nonce·host·PID·고정 Node runtime 시작 기준값을 결합합니다. 짧은 효과 경계에서 검증한 attempt 소유 정보를 전달하며 PID가 같아도 runtime 시작 기준값이 다르면 해당 소유자의 효과나 정리를 수행하지 않습니다. 명시된 runtime 기준값은 별도 조회한 OS CreationDate나 불명·과거 소유자를 회수할 근거가 아닙니다. 일반 작업에 OS 프로세스 조회를 추가하지 않습니다.

GC 취소는 native supervisor에 한 번 종료를 요청하고 작업의 원래 절대 deadline 안에서 정리 증명을 기다립니다. 해당 deadline에 도달해야 강제 종료하며 deadline을 늘리거나 정리 성공을 추정하지 않습니다. 멈춘 supervisor는 남은 작업 deadline까지, 기존 기본값 기준 최대 30초를 사용할 수 있습니다. 용량 상한이나 원래 오류는 그대로 실패이며 정리를 검증할 수 없는 경우도 성공으로 처리하지 않습니다.
