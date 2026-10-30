# 외부 런타임 상태 증거

[영어 원문](../runtime-state.md)

이 경계를 변경하기 전에 [`architecture.md`](architecture.md)와
[`authority-plane-contract.md`](authority-plane-contract.md)를 읽으세요.

## 범위 및 권한

`RuntimeStateAdapter` 버전 `0.1.0`은 특정 시점의 호스트 관찰을 Repository World Model로 가져옵니다. 읽기 전용 증거 어댑터이며 `AgentRuntimeAdapter`, 프로세스 컨트롤러, 세션 복원기 또는 권한 소스가 아닙니다.

별도의 런타임 제어 플레인은 `PlatformAdapter`, `AgentRuntimeAdapter`, `WorkspaceHostAdapter` 참조와 개인정보 보호형 현재 호스트 CLI 탐색을 갖습니다. 원시 경로를 노출하지 않고 후보 가용성과 콘텐츠에서 파생된 경로 식별자를 기록합니다. 서로 다른 제한형 프로브는 세션을 생성하지 않는 고정 버전 및 공급자별 도움말 표면을 실행할 수 있으며, 정규화된 버전, 허용 목록에 포함된 기능 신호, 출력 다이제스트/크기 및 수명주기 사실만 보존합니다. `RuntimeProjectBinding`은 프로젝트 콘텐츠를 전달하지 않고 해당 관찰을 정규 Lode 프로젝트 및 Session 식별자에 연결합니다. 이러한 아티팩트는 공급자 세션을 생성하지 않으며 어떤 제어 권한도 부여하지 않습니다. [`runtime-adapters.md`](runtime-adapters.md)를 참고하세요.

모든 어댑터는 다음을 선언해야 합니다.

- `authority: derived-evidence-only`;
- `rebuildable: true`;
- `uniqueAuthority: false`;
- `readOnly: true`.

관찰된 기능은 호스트가 보고한 내용을 설명합니다. Lode나 실행자에게 어떤 항목도 시작, 재개, 중단, 메시지 전송, fencing 또는 종료할 권한을 절대 부여하지 않습니다. Lode Session 및 Run 식별자는 정규 상태를 유지하며 공급자 세션 식별자와 구별됩니다.

## 호스트 내보내기 계약

현재 활성 어댑터는 최대 1,000개의 관찰을 담고 크기가 1 MiB 이하인 일반 비심볼릭 링크 JSON 파일을 읽습니다.

```json
{
  "schemaVersion": 1,
  "kind": "LodeRuntimeStateExport",
  "observedAt": "2026-08-18T12:00:00Z",
  "observations": [
    {
      "runtime": "codex",
      "kind": "session",
      "state": "active",
      "externalId": "provider-session-id",
      "workspaceRoot": "C:\\path\\to\\project",
      "pid": 1234,
      "parentPid": 1000,
      "providerVersion": "example-version",
      "commandDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "endpointDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "capabilities": ["inspect", "resume"]
    }
  ]
}
```

[`../assets/runtime-state-export.example.json`](../../assets/runtime-state-export.example.json)에서 시작하여 허용 목록에 포함된 관찰 필드만 바꾸세요.

허용되는 종류는 `workspace`, `session`, `run`, `worker`, `process`, `service`입니다. 허용되는 상태는 `unknown`, `discovered`, `ready`, `active`, `idle`, `blocked`, `completed`, `failed`, `stopped`입니다.

스키마는 임의 필드를 의도적으로 거부합니다. 원시 명령, 엔드포인트, 환경 변수, 프롬프트, 트랜스크립트, 토큰, 자격 증명 및 자유 형식 메타데이터가 World Model에 들어가서는 안 됩니다. `externalId`는 SHA-256 다이제스트로 변환됩니다. 프로젝트 외부 워크스페이스는 다이제스트로만 표현되고, 정규 프로젝트 루트는 `project-root`로 표현됩니다.

## 명령

호스트가 생성한 파일을 저장소 외부 또는 제외된 파생 입력 디렉터리 `.lode/world-model/inputs/` 아래에 둔 다음, 구축하고 쿼리하세요.

```text
node scripts/lode.mjs world-index <project> --runtime-state <host-exported-json-file>
node scripts/lode.mjs world-status <project>
node scripts/lode.mjs world-runtime <project> --runtime codex --state active --kind session --limit 20
```

읽기 전용 MCP 도구는 `lode_runtime_state`입니다.

물리 소스 경로와 어댑터 설명자는 변경 가능한 World Model 포인터에만 기록되므로 최신 상태 검사에서 소스를 다시 읽을 수 있습니다. 이들은 시맨틱 스냅샷 해시에서 제외됩니다. 정규화된 관찰, 타임스탬프, 범위 및 프로토콜 버전이 콘텐츠에서 파생되는 `runtimeStateId`와 World Model ID를 결정합니다.

내보내기가 변경되면 World Model이 오래된 상태가 됩니다. 그러면 `world-index`가 스냅샷을 재구축할 때까지 런타임 쿼리와 Context Compiler 런타임 후보는 fail-closed로 실패합니다. 구성된 내보내기가 누락되었거나 유효하지 않으면 최신 상태 검증이 불가능하며, 이를 암묵적으로 현재 상태로 취급하지 않습니다.

## Context Compiler 동작

World Model이 현재 상태이면 작업 관련 관찰이 `RuntimeStateEvidence`로서 일반 Capsule 예산 안에서 경쟁합니다. 명시적인 런타임, 종류 및 상태 단어는 후보 집합을 좁힙니다. 모든 레코드는 다음을 포함합니다.

- `instructionAuthority: false`;
- `controlAuthority: false`;
- `trustBoundary: evidence-not-instruction`;
- 증거 및 콘텐츠에서 파생된 관찰 다이제스트.

오래된 관찰과 그 메타데이터는 제외됩니다. Capsule은 `get_runtime_state`를 통해 확장을 요청할 수 있지만, 이는 여전히 읽기 작업입니다.

## 경계 및 연기된 제어

`RuntimeStateAdapter`는 관찰 전용으로 유지됩니다. Claude Code, Codex 및 OpenCode의 일회성 Session 및 Run 실행, 호출자 fencing, at-most-once 리스 및 네이티브 자손 소유권은 별도의 Runtime Adapter 계약을 통해 활성화됩니다. 세 런타임 모두 결정론적 프로토콜 픽스처를 갖지만, 현재 라이브 모델 호출 증거를 보존하는 것은 Codex와 OpenCode뿐입니다. 이러한 기능이 이 가져오기 어댑터를 제어 플레인으로 확장하지는 않습니다.

공급자 세션 hydration 또는 숨겨진 세션 복원, 일반적인 resume/stream, 공급자 세션 메시징 및 구독은 연기된 선택적 Runtime Adapter 기능으로 유지됩니다. P2 우선의 선택적 정확한 Lode attachment와 정확히 소유된 일회성 interrupt/close는 별도의 활성 호스트/런타임 경계에 속하며, 이 관찰 어댑터에는 속하지 않습니다.
