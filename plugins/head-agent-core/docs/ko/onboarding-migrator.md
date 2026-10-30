# 독립 실행 legacy 온보딩 migrator

[English](../onboarding-migrator.md)

이 문서는 소스 저장소 유지보수 도구를 설명합니다. Migrator는 설치된 Lode Agent
Core 플러그인, MCP 서버, marketplace payload, native overlay 또는 일반 resume 경로에
포함되지 않습니다.

## 첫 지원 범위

고정된 helper는 완료된 onboarding candidate protocol `0.1.0`, `0.2.0`, `0.3.0`을
인식합니다. 현재 읽을 수 있는 Project와 Session, `ready`인 상태 protocol `0.2.0`,
완전한 historical candidate/review 및 Product Model revision chain, 실제 current Canon,
독립적으로 읽을 수 있는 관련 P2가 모두 있어야 합니다. 상태 protocol `0.1.0`, pending
또는 중단된 승인, 누락 artifact, 읽을 수 없는 current Canon/P2에는 아무것도 쓰지 않으며
별도로 검토된 복구 설계가 필요합니다.

Product Model revision은 나이가 아니라 current verifier 결과로 분류합니다. 현재 계약을
통과하는 revision은 기존 typed P1 Canon evidence로 남고, 폐기된 parser가 필요한 revision만
opaque입니다. Historical candidate와 그 review는 항상 current Core에서 opaque입니다.

## 명시적 one-shot 실행

검토되고 commit이 고정된 source checkout에서 실행합니다.

```powershell
node legacy/onboarding-migrator/bin/head-onboarding-migrate.mjs inspect C:\project
node legacy/onboarding-migrator/bin/head-onboarding-migrate.mjs apply C:\project
```

`inspect`는 읽기 전용입니다. `apply`는 같은 프로세스에서 검증을 다시 수행하고,
직렬화할 수 없는 capability를 generic current boundary publisher에 전달합니다. 새로 생기는
레코드는 `.head/onboarding/historical-boundaries/<id>/boundary.json`, 같은 디렉터리의
`receipt.json`, 마지막에 게시되는 `commit.json`뿐입니다.

세 레코드는 instruction/promotion 권한이 없는 P3 evidence입니다. 기존 candidate,
ReviewDecision, revision, Canon, onboarding pointer, Session, Run, checkpoint, World 또는 Graph를
수정·이동·이름 변경·삭제·재발급·재승인하지 않습니다. 유효하게 commit된 exact retry는
정상적인 current Canon/P2 변화 뒤에도 write 0입니다. Partial retry는 최초 적용 basis가
정확히 같을 때만 빠진 기계적 레코드를 완성할 수 있습니다. 최종 marker 전 basis drift,
다른 inventory, 원본 변조·누락, boundary 밖 unsupported legacy artifact는 fail closed입니다.

## migration 이후

운영 환경에서 standalone helper를 제거합니다. 설치된 플러그인은 legacy parser 없이
commit boundary와 원본 byte 무결성을 검증합니다. Status, World, Context, Session recovery는
current Core 동작으로 계속되며, 과거 promotion을 복구하거나 opaque candidate의 재검토를
요청하지 않습니다.

제품 의미를 변경해야 할 때 provider Lode는 `lode_onboarding_semantic_refresh` 또는 CLI
`onboarding-semantic-refresh`로 fresh `0.4.0` candidate를 제안합니다. Core는 정확한 current
evidence를 검증하고, 이후의 명시적 사용자 ReviewDecision만 Canon을 변경할 수 있습니다.
P3 continuity receipt와 P4 `HISTORICALLY_FOLLOWS` 관계는 typed ancestry나 권한을 만들지 않고
과거와 fresh candidate의 연속성만 기록합니다.
