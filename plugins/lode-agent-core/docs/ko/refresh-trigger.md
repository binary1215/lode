# 디바운스된 새로 고침 트리거

[영어 원문](../refresh-trigger.md)

상태: 파일시스템 및 구조화된 CI 트리거 수집 활성화

프로토콜 버전: `0.2.0`; 다이제스트 검증된 `0.1.0` 배치와 전달은 계속 읽을 수 있음

## 목적

트리거 계층은 잡음이 많은 파일시스템 또는 CI 관찰을 범위가 제한된 불변 증거로 변환하고, 그 증거를 기존 증분 새로 고침 계약에 전달합니다. 이벤트 경로를 전체 변경 목록으로 취급하지 않으며, 이벤트 생성자에게 Product Canon, 검토된 관계, 활성 Run 또는 생성 문서에 대한 권한을 부여하지도 않습니다.

```text
filesystem or CI observations
  -> bounded debounce queue
  -> canonical RefreshTriggerBatch
  -> exclusive project refresh-writer lease
  -> IncrementalRefreshRequest / complete repository rescan
  -> IncrementalRefreshReceipt
  -> PostRefreshProjectionPolicy / PostRefreshProjectionReceipt
  -> RefreshTriggerDeliveryReceipt
  -> replaceable trigger pointer
```

World Model은 여전히 적격 파일의 완전한 탐색, 원시 바이트 읽기 및 콘텐츠 해싱으로 결정됩니다. 트리거 페이로드는 스캔이 실행된 이유만 설명합니다.

## 지원 소스

두 소스 어댑터가 활성화되어 있습니다.

- `filesystem`: 재귀 감시와 범위가 제한된 디바운스를 사용하는 포그라운드 Node `fs.watch` 어댑터;
- `ci`: 하나의 범위가 제한된 배치로 처리되는 구조화된 JSON 이벤트 파일.

두 어댑터 모두 동일하게 정규화된 이벤트 어휘를 내보냅니다.

```json
{
  "kind": "path-hint",
  "operation": "change",
  "path": "src/service.mjs",
  "evidenceId": null
}
```

또는:

```json
{
  "kind": "project-signal",
  "operation": "build",
  "path": null,
  "evidenceId": "ci-build-0001"
}
```

작업은 실행 가능한 명령이 아니라 레이블입니다. 경로는 프로젝트 내부에 있어야 합니다. 절대 경로, 드라이브 한정 경로, NUL 바이트 및 순회 이탈은 실패로 폐쇄됩니다.

## 디바운스 및 병합

큐는 25~60,000밀리초의 디바운스 창과 1~4,096개의 버퍼 이벤트에 해당하는 배치 제한을 받습니다. 기본값은 350밀리초와 1,024개 이벤트입니다.

배치 구성은 다음을 수행합니다.

- 경로 구분자와 순서를 정규화합니다.
- 수락된 이벤트를 정규 순서로 정렬하고 중복을 제거합니다.
- 중복 이벤트를 `duplicate-event`로 기록합니다.
- 저장소 스캔에서 무시되는 디렉터리와 관리되는 프로젝션 파일을 `excluded-or-managed-path`로 제외합니다.
- 범위가 제한된 오버플로를 `event-limit-exceeded`로 기록하고 전체 재스캔을 강제합니다.
- 타이머 지속 시간, 도착 타임스탬프, 백엔드 레코드 ID 및 프로세스 ID를 의미적 배치 ID에서 제외합니다.

`.lode`, `.git`, 의존성/벤더 트리, 빌드 출력 및 캐시 아래 이벤트는 그 자체만으로 새로 고침을 예약하지 않습니다. 이렇게 하면 `.lode` 아래에 기록되는 트리거 아티팩트가 감시자를 재귀적으로 촉발하지 않습니다. 실제 프로젝트 이벤트와 함께 제외된 이벤트가 도착하면, 그 폐기 개수는 배치 증거에 계속 표시됩니다.

큐는 전달을 도착 배치 순서로 직렬화합니다. 첫 번째 스캔이 실행되는 동안 두 번째 배치가 누적될 수 있지만, 한 큐의 두 전달이 동시에 실행되지는 않습니다.

다른 프로세스가 World Model 작성자 리스를 소유하는 경우 `REFRESH_WRITER_BUSY`만 재시도할 수 있습니다. 큐는 실패한 배치를 범위가 제한된 버퍼에 복원하고, 오버플로를 강제 재스캔 신호로 보존하며, 초당 한 번보다 자주 재시도하지 않습니다. 다이제스트, 스키마, 권한, 경로, 그래프 및 포인터 실패는 자동으로 재시도하지 않습니다.

## 불변 트리거 아티팩트

`RefreshTriggerBatch`는 다음을 기록합니다.

- 프로젝트 및 소스 어댑터 ID;
- 정규화된 수락 이벤트 힌트;
- 입력, 수락, 병합 및 폐기 개수;
- 정렬된 폐기 사유;
- 전체 재스캔이 필요한지 여부;
- 거짓으로 설정된 지시, 승격 및 Canon 변경 권한.

`RefreshTriggerDeliveryReceipt`는 다음을 기록합니다.

- 정확한 트리거 배치 ID 및 해시;
- 이전 및 이후 World Model, SourceSnapshot 및 GraphSnapshot ID;
- 재스캔이 실행된 경우 연결된 증분 요청 및 영수증 ID;
- `ignored`, `unchanged` 또는 `refreshed` 처리 결과;
- 배타적 World Model 작성자 및 예상 포인터 확인 직렬화 증거;
- 적용된 전달에 대한 정확한 새로 고침 후 프로젝션 영수증, 정책 ID 및 `manual-deferred`, `projected`, `unchanged`, 차단 또는 실패 문서 처리 결과.

로컬 참조 구현은 다음 위치에 저장합니다.

```text
.lode/refresh/triggers/batches/refresh-trigger-batch-*.json
.lode/refresh/triggers/deliveries/refresh-trigger-delivery-*.json
.lode/refresh/triggers/current.json
.lode/document-projection/post-refresh/receipts/post-refresh-projection-receipt-*.json
```

배치 및 전달 파일은 불변이며 콘텐츠로부터 파생됩니다. `current.json`은 교체 가능한 다이제스트 검증 포인터입니다.

## 단일 작성자 경계

명시적 인덱싱과 수동, 파일시스템 및 CI 새로 고침을 포함한 모든 영속적 World Model 빌드는 동일한 프로젝트 범위 리스를 획득합니다.

```text
.lode/refresh/writer.lock/owner.json
```

디렉터리 생성이 프로세스 간 배타 연산입니다. 소유자 문서는 운영 메타데이터일 뿐이며 프로세스 ID, 임의 토큰, 시작 시간 및 거짓 권한 플래그를 포함합니다. 중첩된 트리거 전달은 동일한 프로세스와 프로젝트가 소유한 것으로 검증된 리스만 재사용할 수 있습니다. 이로써 모든 핵심 World Model 포인터 작성자는 상호 배타적이 됩니다. 트리거된 새로 고침은 현재 포인터가 여전히 미리보기 기준과 일치하는지도 추가로 검증합니다.

활성 리스 또는 소유권을 알 수 없는 리스는 `REFRESH_WRITER_BUSY`로 실패합니다. 기록된 PID가 존재하지 않는 것으로 입증된 리스는 잠금 디렉터리에 정확한 소유자 파일만 포함되어 있음을 검증한 후 복구할 수 있습니다. 구현은 리스를 복구하기 위해 다른 프로세스를 종료하지 않습니다. 잠금은 `finally`에서 해제되며, World Model은 기록 전에 예상 현재 포인터 비교를 계속 수행합니다.

## CLI

구조화된 CI 수집은 입력 파일을 사용합니다.

```json
{
  "sourceKind": "ci",
  "events": [
    {
      "kind": "project-signal",
      "operation": "build",
      "path": null,
      "evidenceId": "ci-build-0001"
    }
  ],
  "maxEvents": 1024
}
```

```powershell
node scripts/lode.mjs world-refresh-events <project> --input refresh-events.json
node scripts/lode.mjs world-refresh-watch <project> --debounce-ms 350 --max-events 1024
node scripts/lode.mjs world-refresh-trigger-status <project>
node scripts/lode.mjs world-refresh-trigger-read <project> --delivery refresh-trigger-delivery-<24-hex>
```

`world-refresh-watch`는 의도적으로 포그라운드에서 실행됩니다. `SIGINT` 또는 `SIGTERM`은 파일시스템 감시자를 닫고, 대기 중인 실제 프로젝트 배치를 플러시하고, 직렬화된 전달을 기다린 뒤, 작성자 리스를 해제하고 범위가 제한된 종료 요약을 반환합니다. 서비스 설치 및 백그라운드 데몬 소유권은 계속 유보됩니다.

이벤트 수집 명령은 `sourceKind`, `events` 및 선택적 `maxEvents`만 받습니다. 명령, 환경 값, 자격 증명, 엔드포인트, GraphDB 레코드, Product Canon 변경 또는 정확한 변경 경로 단언은 받지 않습니다.

## 읽기 전용 MCP

MCP는 검증 기능만 노출합니다.

- `lode_refresh_trigger_status`;
- `lode_refresh_trigger_delivery`.

MCP는 감시자를 시작하거나, CI 이벤트를 수집하거나, 변경 권한을 획득하거나, 새로 고침을 시작할 수 없습니다.

## 권한 및 실행 경계

트리거 배치와 전달은 지시 또는 승격 권한이 없는 증거입니다. 다음을 수행할 수 없습니다.

- Feature 또는 관계 후보 승격;
- Product Canon 또는 Decisions 편집;
- 수락된 ChangeSet 또는 병합 추론;
- 수락된 ExecutionContract 또는 ContextCapsule 변경;
- 활성 Run 또는 대기 중인 ResultPacket 재작성;
- 스스로 문서 게시 권한 획득; 별도로 선택된 새로 고침 후 정책만 깨끗한 Markdown을 재생성할 수 있습니다.
- Git 또는 GraphDB를 필수로 만들기.

트리거된 새로 고침이 활성 Run 중 더 새로운 SourceSnapshot을 생성하면, 연결된 증분 영수증은 수동 새로 고침과 동일한 명시적 계속, 재컴파일, 수정 또는 취소 요구 사항을 기록합니다.

## 실패 정책

트리거 경로는 다음 상황에서 실패로 폐쇄됩니다.

- 유효하지 않거나 이탈하는 경로 및 지원되지 않는 이벤트 필드;
- 잘못된 배치, 전달, 포인터 또는 권한 플래그;
- 콘텐츠 다이제스트 불일치 또는 불변 아티팩트 충돌;
- 활성 상태이거나, 알 수 없거나, 안전하지 않거나, 불일치하는 작성자 리스 소유권;
- 증분 요청/영수증 불일치;
- 새로 고침 후 정책, 영수증, 후보 또는 DocumentProjection 바인딩 불일치;
- World Model 미리보기 드리프트, 포인터 충돌 또는 그래프 구체화 실패;
- 오래되었거나 변조된 연결 스냅샷.

다운스트림 새로 고침이 실패하면 트리거 배치는 불변 증거로 남을 수 있지만 전달 포인터는 전진하지 않습니다. 작성자 사용 중 실패는 범위가 제한된 방식으로 다시 큐에 들어가며, 그 밖의 모든 새로 고침 실패는 교정 또는 새로운 명시적 트리거가 필요합니다. 반면 다운스트림 문서 프로젝션 실패는 연결된 전달에 기록되며, 성공한 관찰 상태 새로 고침을 무효화하거나 롤백하지 않습니다.

## 유보된 다음 단계

이 범위에서는 백그라운드 서비스를 설치하거나 공급자별 CI 웹후크를 연결하지 않습니다. 호스트는 포그라운드 감시자를 호출하거나 엄격한 CI 이벤트 파일을 생성합니다. 안전한 옵트인 자동 Markdown 재생성, 명시적 DocumentChangeCandidate 검토/적용 및 그 시간적 감사 프로젝션은 활성화되어 있습니다. 자동 원격 GraphDB 프로젝션 새로 고침, Obsidian/Notion 게시, 양방향 동기화, 자동 병합 및 일반 의미 승격은 계속 유보됩니다.
