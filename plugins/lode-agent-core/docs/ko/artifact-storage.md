# 작업 산출물 저장 가이드

[영어 원문](../artifact-storage.md)

새 저장 API나 게이트가 아닌 기본 정리 가이드입니다. 기존 프로젝트 관례를 먼저 따릅니다. 폴더를 채우려고 파일을 만들거나 기록만을 위해 Lode를 초기화하거나 일반 Session 작업을 Run으로 바꾸지 않습니다. 필수 Step registry, manifest, 추가 승인이나 자동 GC를 도입하지 않습니다.

## 소유 주체 먼저 선택

- 공식 Lode 계획, 계약, ResultPacket, ReviewDecision, Capsule과 체크포인트는 기존 CLI/MCP/API typed store에 둡니다. 반환된 ID와 경로를 쓰며 직접 작성하거나 작업/Step 폴더로 옮기지 않습니다. 불변 기록과 변경 가능한 current 포인터의 규칙은 다릅니다.
- 제품 소스, 테스트와 사용자 전달물은 기존 프로젝트 위치에 둡니다.
- 기존 관례가 없을 때 보존할 작업 근거는 `<project>/.agent-work/<work-id>/`를 사용할 수 있습니다. 임시 scratch와 보존할 검증 근거는 다릅니다. 이 가이드를 적용하려고 기존 산출물을 이동·삭제·재번호하지 않습니다.

## 이름과 선택적 구성

사람에게 보이는 제목은 자유롭게 씁니다. 폴더는 `YYYYMMDDTHHMMSSZ-<short-kebab-case-slug>`를 권합니다. UTC 생성 시각과 짧은 ASCII 소문자·숫자·하이픈 slug로 Windows에서도 안전합니다. 같은 목적의 연속 작업은 대화가 바뀌어도 같은 work-id를 쓰고 독립 작업에는 새 ID를 씁니다. 충돌하면 소유 작업을 확인하여 재사용하거나 짧은 고유 접미사를 붙이며 다른 작업을 덮어쓰지 않습니다.

work-id는 Lode sessionId, runId나 provider 대화 ID가 아닙니다. 실제 존재하고 관련 있는 Session/Run/contract/result 참조만 선택적으로 기록합니다. 없는 참조를 만들거나 provider 대화 ID를 복구 키로 쓰지 않습니다.

단일 결과는 work 폴더 바로 아래에 둡니다. 단계 근거를 구분할 필요가 있을 때만 `steps/01-inspect/`, `steps/02-implement/`, `steps/03-verify/`처럼 두 자리 이상 순번과 짧은 동작 slug를 씁니다. 완료된 Step을 재번호하지 않습니다. 안정적인 경로일 뿐 실행 상태나 권한이 아니며 모든 도구 호출을 Step으로 만들지 않습니다.

`review.md`, `summary.json`, `scope-check.stdout.log`, `scope-check.stderr.log`처럼 내용을 설명하는 이름을 권합니다. 비교나 실패 분석에 재시도 구분이 필요할 때만 `attempt-01/`, `attempt-02/`를 씁니다. 실패 근거와 이미 참조된 근거를 성공 결과로 덮어쓰지 않습니다. 작업 초안과 work 폴더의 `README.md`는 갱신할 수 있으며 공식 불변 기록이 아닙니다. 기존 프로젝트 파일명 관례를 보존합니다.

## 예시

단일 결과 작업에는 Step이나 색인이 필요하지 않습니다.

```text
.agent-work/20260919T154819Z-artifact-storage-guidelines/
  review.md
```

같은 작업에서 나중에 다단계 검증 근거를 보관하는 경우입니다.

```text
.agent-work/20260919T154819Z-artifact-storage-guidelines/
  review.md
  README.md
  steps/
    01-inspect/
      summary.json
    03-verify/
      attempt-01/
        scope-check.stdout.log
        scope-check.stderr.log
      attempt-02/
        scope-check.stdout.log
        scope-check.stderr.log
```

빠진 단계 번호는 문제없습니다. 파일을 억지로 만들거나 기존 경로를 재번호하지 않습니다. 제품 수정은 여전히 기존 위치에 둡니다.

## 색인, 인계와 보존

장기 보관이나 여러 파일의 인계에는 목적, 핵심 파일 상대 링크, 검증한 소스 버전, 결과/미검증 범위와 알려진 Lode 참조를 짧은 색인에 적을 수 있습니다. 없는 필드는 생략하며 기계용 manifest는 필수가 아닙니다. 이동 가능한 상대 링크를 우선하고 외부 경로는 필요할 때만 쓰며 인계 시 핵심 산출물의 실제 위치를 알립니다.

현재 작업 소유임이 확인된 불필요한 scratch만 정리합니다. 공유·참조 중인 근거, 다른 작업 파일이나 공식 Lode 기록을 자동 삭제하지 않습니다. 새로운 보존기간이나 전역 GC 정책을 정하지 않습니다. 프로세스 정리와 근거 보존은 별개입니다. 인증값을 파일명·로그·색인에 남기지 않습니다.

## 스캔과 배포 경계

이 경로의 보존은 기본적으로 로컬이며 Git clone, 다른 PC 또는 worktree 삭제
이후의 자동 복구를 뜻하지 않습니다. 다른 checkout/PC 인계나 장기 보존이
필요하면 기존에 승인된 프로젝트 전달·보존 위치를 사용하고 수신 측에서 접근할
수 있는지 확인합니다. 공식 기록의 참조만으로 대상 파일이 복제·보존되지는
않습니다. 동기화 서비스나 일반 작업의 추가 승인 절차를 만들지 않습니다.

JS와 Go repository scanner는 루트와 중첩 위치에서 `.agent-work`라는 이름의 디렉터리를 대소문자 구분 없이 제외합니다. 무관한 숨김 소스는 계속 포함 대상입니다. 저장된 source scope를 바꾸거나 파일을 이전하지 않습니다. 명시적 include scope도 기술적 제외를 덮어쓰지 않으므로 제품 파일은 제품 위치에 둡니다.

스캔 생산자 `0.5.1`은 포함 대상 변경을 `0.5.0`과 구분하며 선언 스키마는 계속 읽을 수 있습니다. 기존 freshness 검사는 포함 대상 파일을 비교하며 World indexer identity도 버전 변경을 감지합니다. 과거 불변 snapshot은 근거로 보존합니다. 현재 World 근거가 필요하면 기존 refresh/reconcile을 사용하며 파생 스캔 갱신을 위해 Canon을 자동 승격하거나 재온보딩하지 않습니다. native worker도 다시 빌드해야 하며 구 worker가 새 생산자인 것처럼 응답해서는 안 됩니다.

이 저장소는 해당 디렉터리 이름을 Git에서 ignore하고 중첩 경로까지 배포 열거에서 제외합니다. 다른 프로젝트의 Git·패키징 정책은 유지하며 이 가이드가 자동 수정하지 않습니다. Ignore는 커밋한 근거를 untrack하거나 과거 이력을 지우지 않습니다.

실제 typed 생명주기 계약은 [실행 계보](execution-lineage.md)를 참고합니다.

## 경로 기준과 기존 Project

Project 내부 참조는 검증된 Project root를 기준으로 한 `/` 상대경로입니다. 생성
Markdown의 `relativePath`는 게시 root 기준이고, href는 해당 문서 위치 기준입니다.
문서의 `../` 링크가 원본 selector의 `..`를 허용하는 것은 아닙니다.

런타임 `project_root`, 저장된 `projectRoot`, 설치의 `pluginRoot`와 root 기반 식별자는
검증된 절대 root와 실제 Session 소유자에 계속 결합됩니다. 새 Project는 `.lode/`를
사용하고 기존 `.head/` 원문과 exact selector는 그대로 유지합니다. 이는 기존 경로
계약의 설명이며, workspace 이동 지원이나 자동 repair 기능이 아닙니다.

