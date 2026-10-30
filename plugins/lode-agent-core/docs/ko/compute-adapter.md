> 이 문서는 영어 원문 [`compute-adapter.md`](../compute-adapter.md)의 한국어 번역입니다.

# ComputeAdapter 및 WorkerProtocol baseline

이 plane을 변경하기 전에 [`architecture.md`](architecture.md)와
[`authority-plane-contract.md`](authority-plane-contract.md)를 읽으세요.

## 목적과 현재 경계

`ComputeAdapter`는 product authority, runtime authority 또는 semantic identity를 구현 언어로 이전하지 않으면서 결정론적인 고부하 계산을 JavaScript control plane에서 분리합니다. Contract version `0.3.0`과 WorkerProtocol version `0.2.0`이 활성화되어 있습니다.

`JsReferenceComputeAdapter`는 결정론적 reference operation을 in-process로 실행하며 semantic oracle 및 local fallback으로 유지됩니다. `GoWorkerComputeAdapter`는 검증된 native stdio transport를 제공합니다. 이제 Go source는 `repository.scan.v1`을 구현하며 명시적 source-scope filtering을 포함한 7개의 성공/실패 fixture에서 JavaScript complete response와 일치하지만, packaged release manifest는 여전히 `worker.health.v1`만 알립니다. 비교 측정 결과 small 및 medium input에서는 regression이 나타났고 large input에서도 개선이 미미했으므로, 입증되지 않은 acceleration을 주장하는 대신 production World Model scanning은 계속 JavaScript를 사용합니다. 어떤 user project에도 native source나 binary가 제공되지 않습니다.

## 권한 경계

모든 adapter descriptor는 다음을 선언해야 합니다.

- `authority: computation-only`;
- `instructionAuthority: false`;
- `promotionAuthority: false`;
- `controlAuthority: false`;
- `mutatesProject: false`;
- `mutatesCanon: false`;
- `semanticIdentity: backend-neutral-canonical-output`.

모든 request와 response는 `authorityEffect: none`을 기록합니다. result validation은 instruction, promotion, control, canonical 또는 unique-authority flag의 값이 정확히 `false`가 아닌 경우 이를 재귀적으로 거부합니다. 이는 defense-in-depth boundary이며, operation-specific validator도 operation schema를 벗어난 output을 계속 거부해야 합니다.

JavaScript control plane은 Product Canon write, ReviewDecision, candidate promotion, Context policy, CLI/MCP integration, backend selection, worker integrity verification 및 process lifecycle enforcement를 계속 담당합니다.

## 표준 WorkerProtocol

`ComputeRequest`는 다음 항목을 포함합니다.

```text
schemaVersion, protocol, kind, requestId,
operation, input, inputDigest,
semanticProducer, limits, authorityEffect
```

operation name은 명시적으로 versioning되며, 예를 들면 `repository.scan.v1`입니다. input은 plain finite JSON이어야 합니다. canonical object-key ordering이 `inputDigest`를 결정하고, protocol version, operation, input digest, semantic producer 및 normalized limit가 콘텐츠에서 파생되는 `requestId`를 결정합니다.

`ComputeResponse`는 request identity를 그대로 되돌려 보내며 다음 항목을 포함합니다.

```text
status, result, resultDigest,
warnings[], errors[], authorityEffect
```

성공 output은 `maxOutputBytes` 이내의 완전한 canonical JSON이어야 하고 authority escalation이 없어야 하며 SHA-256 result digest와 일치해야 합니다. 실패 output에는 partial result나 digest가 없고 하나 이상의 structured error가 필요합니다. warning 및 error record는 canonical 순서로 정렬됩니다. request/response mismatch, extra field, malformed JSON, digest drift, unsupported operation 및 partial result는 fail-closed 방식으로 실패합니다.

## 리소스 및 취소 계약

normalized limit는 다음 항목을 기록합니다.

- timeout;
- maximum input and output bytes;
- maximum files;
- maximum bytes per file;
- maximum total source bytes.

기본 `maxOutputBytes`는 **64 MiB(67,108,864바이트)**입니다. 호출자가 출력
예산을 명시하지 않았고 검증된 오류가 `COMPUTE_OUTPUT_LIMIT` 하나뿐일 때
**64 → 128 → 256 → 512 MiB**, 최초 시도 이후 최대 3회 재시도합니다.
JavaScript와 Go의 최대 한도는 **512 MiB(536,870,912바이트)**이며 `result`나
화면 출력만이 아니라 envelope를 포함한 전체 UTF-8 JSON response에 적용됩니다.
기본값과 같은 예산이라도 명시했다면 자동 확대하지 않습니다. 입력·소스·artifact·
Markdown·MCP 한도는 바뀌지 않습니다. 일반 executor는 모든 시도에 하나의
deadline과 취소 signal을 공유합니다. identity·digest·권한·혼합 오류, 잘못된
응답, stdout 전송 한도 위반과 crash는 확대 사유가 아닙니다. Go는 정상 성공
응답의 인코딩 크기가 초과하면 crash 대신 작은 typed 출력 한도 오류를 반환합니다.
64 MiB까지만 허용하는 구버전 native worker는 더 큰 요청을 거절할 수 있습니다.
기존의 명시적 crash/fallback 규칙은 유지하지만 그 거절 자체가 다음 예산 확대를
허용하지는 않습니다. 배포 manifest는 계속 health만 광고합니다.

JavaScript reference는 호출 안에서 완료된 canonical 결과를 비공개로 보관하고
응답 envelope만 다시 구성합니다. handler를 다시 실행하지 않습니다. 증분 scan도
소스를 한 번 읽은 결과를 그대로 재사용하며 동기 scan에 새 executor timeout을
추가하지 않습니다. 초기 production scan도 JavaScript fallback에서 같은 결과
보관 경로를 사용합니다. 설치·World·문서 저장을 반복하거나 시도별 artifact를
저장하지 않습니다. 다른 adapter의 재실행도 고정된 request input과 무권한
계산 계약에 한정됩니다. 파일을 다시 관측했다고 같은 소스 snapshot이 되는 것은
아니므로 매 결과를 완전하게 검증하고 소비자가 freshness를 확인해야 합니다.
이 정책은 native repository scan을 활성화하지 않습니다.

예산이 늘면 content-derived `requestId`는 바뀌지만 입력·producer·다른 한도와
같은 완전한 결과의 digest는 유지됩니다. 시도 예산·재시도 횟수·상한은 의미나
권한 상태가 아닌 운영 diagnostic입니다. 소진 시 최종 예산과 원래 원인을
알리며 출력을 잘라내지 않습니다. 512 MiB는 메모리나 JSON runtime 용량을
보장하지 않습니다. 문자열 용량 오류는 별도 원인으로 보고하며 출력 초과로
재시도하지 않습니다. 두 번째 거대 응답 문자열을 만들지 않고 envelope 바이트와
digest를 검증합니다.

control-plane executor는 timeout과 external cancellation을 `AbortSignal`에 적용하고, 모든 결과에서 timer와 listener를 정리하며, elapsed time은 protocol response 외부의 operational diagnostic으로만 반환합니다. JavaScript reference handler는 해당 signal을 협력적으로 관찰해야 합니다. 따라서 신뢰할 수 없거나 비협력적인 work는 in-process backend에서 실행할 수 없습니다.

Go adapter는 `shell: false`, 최소 환경, 그리고 검증된 binary directory를 working directory로 사용해 실행 파일 하나를 직접 시작합니다. manifest는 descendant, network access 및 project write를 금지합니다. Stdout은 request output limit에 framing을 더한 크기로 제한되고 stderr는 별도로 제한되며, timeout 또는 cancellation은 정확히 기록된 child PID를 대상으로 graceful termination 후 제한된 forced termination을 수행합니다. 해당 PID가 종료될 때까지 completion을 보고하지 않습니다. 앞으로 child spawn이 허용되는 worker를 위한 descendant-tree supervision은 계속 유예됩니다.

## 적합성

`verifyComputeAdapterConformance`는 JavaScript reference adapter와 candidate adapter에 정확히 동일한 immutable request를 보냅니다. 선택된 field만이 아니라 완전한 canonical protocol response가 일치해야 합니다. 콘텐츠에서 파생된 report는 fixture name, operation, request ID, status 및 result digest를 기록합니다.

conformance는 제공된 fixture에 대해서만 equivalence를 입증합니다. operation-specific schema, deterministic JavaScript implementation, failure fixture, representative benchmark corpus 및 semantic identity check가 존재하기 전에는 어떤 operation도 Go로 이전할 수 없습니다.

`worker.health.v1`은 첫 번째 native conformance operation입니다. 두 backend 모두 동일한 canonical authority-free readiness result를 반환합니다. test-only `worker.lifecycle.v1` fixture는 adapter timeout까지 기다린 뒤 cancellation과 PID exit를 입증하며, production manifest는 이 lifecycle operation을 알리지 않습니다.

Go `repository.scan.v1` candidate는 JavaScript reference와 동일하게 제한된 file traversal, built-in exclusion, 정규화된 user-selected include/exclude root, raw-byte hash, UTF-8 replacement behavior, classification, language mapping, symbol cap, dependency extraction, import binding, call extraction, skipped count, summary 및 콘텐츠에서 파생되는 identity를 다룹니다. canonical JSON은 JavaScript-compatible UTF-16 key ordering 및 escaping을 사용합니다. tracked corpus는 JavaScript, Python, Markdown/Unicode, configuration, Dockerfile, test classification, excluded directory, explicit source scope, unsupported file, managed projection, invalid root 및 resource-limit failure를 다룹니다.

## 배포 및 선택

지원되는 각 platform package에는 executable과 엄격한 `WORKER-MANIFEST.json`이 포함됩니다. manifest는 WorkerProtocol version, platform, architecture, 정규화된 plugin-relative executable path, byte size, SHA-256 digest, advertised operation, process restriction 및 모두 false인 authority flag를 콘텐츠에서 파생되는 manifest ID에 결속합니다.

selection은 plugin root 아래의 정확한 platform directory와 executable만 허용합니다. adapter는 symlinked manifest 또는 binary, path traversal, realpath escape, size 또는 digest mismatch, incompatible protocol, unsupported target 및 non-Windows host의 missing executable permission을 거부합니다. platform package는 Windows x64, Linux x64/arm64 및 macOS x64/arm64용으로 build됩니다. release workflow는 Go code를 test하고 vet을 실행하며 host fixture를 build하고 JS/Go health conformance와 cancellation cleanup을 검증한 뒤에만 platform archive를 생성합니다. version-exact tag 또는 manual dispatch는 user-scoped installer를 위해 해당 archive와 `SHA256SUMS`를 GitHub Release로 게시합니다. main-branch publication도 검증된 archive 5개 모두를 Codex 및 Claude marketplace snapshot에 조립하므로, marketplace install은 release asset이 전달되지 않아 조용히 fallback하는 대신 현재 host binary를 offline으로 선택할 수 있습니다.

## Fallback 정책

manifest나 binary가 없거나 incompatible, corrupt 상태이거나 요청된 operation을 알리지 않는 경우, 또는 native process가 시작되지 않거나 crash하거나 stdin 전달 중 실패한 경우 adapter는 JavaScript reference path를 사용할 수 있습니다. operational diagnostic은 backend, execution mode, fallback 발생 여부, 제한된 reason code 및 가능한 경우 검증된 worker identity를 기록합니다. 이러한 정보는 semantic output과 콘텐츠에서 파생되는 identity에서 제외됩니다.

malformed 또는 digest-invalid native response, stdout limit violation, timeout 및 caller cancellation은 in-process로 retry하지 않고 fail-closed 방식으로 실패합니다. 이를 통해 integrity failure를 숨기거나 caller가 명시적으로 중지한 뒤 작업을 반복하는 일을 방지합니다.

## Repository scan v1

`repository.scan.v1`은 absolute project root를 operational input으로만 받습니다. 검증된 semantic result에는 콘텐츠에서 파생되는 `RepositorySourceScope`, 정규화된 relative path, content digest, size, classification, language, symbol, dependency, import binding, call, skip count 및 콘텐츠에서 파생되는 `scanId`가 포함됩니다. scope는 user-selected observation-boundary authority만 가지며 instruction authority 또는 promotion authority는 명시적으로 없습니다. result에는 absolute root, backend name, PID, timing, GraphDB identifier, Git requirement, source text, instruction authority 또는 promotion authority가 포함되지 않습니다.

World Model은 성공적으로 검증된 complete result만 사용합니다. JavaScript 및 향후 native implementation은 동일한 source-analysis producer version과 canonical ordering을 사용해야 합니다. backend name, execution mode, request ID, result digest 및 elapsed time은 World Model snapshot identity 외부의 pointer 또는 caller diagnostic으로 유지됩니다.

`benchmarks/repository-scan-v1/basic` 아래 tracked corpus는 file, symbol, dependency, binding, call, Unicode, classification, exclusion 및 failure behavior를 다룹니다. `npm run benchmark:repository-scan`은 reference operation을 반복 실행하고 semantic identity drift가 발생하면 실패하며 timing을 non-semantic diagnostic으로만 보고합니다. `scripts/benchmark-go-repository-scan.mjs`는 먼저 complete-response conformance를 입증하고, backend order를 교대하며, fallback을 거부하고 operational median을 보고합니다. 검토된 Windows evaluation은 `benchmarks/repository-scan-v1/native-evaluation.json`에 저장되어 있습니다. Go path는 small 및 medium corpus에서 더 느렸고 large corpus에서는 약 1.07배만 빨랐습니다. 이는 default activation을 정당화하기에 부족합니다.

## 명시적으로 유예된 항목

- compute-backed graph construction, traversal 또는 Context selection operation;
- conformant Go `repository.scan.v1` candidate의 production activation, size-aware selection 또는 transport amortization;
- worker descendant 및 descendant process-tree supervision;
- file scanning, parsing, World Model construction, graph traversal 또는 Context selection의 benchmark-based migration;
- Rust 또는 기타 native backend.
