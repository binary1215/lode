> 이 문서는 [verification-evidence.md](../verification-evidence.md)의 한국어판입니다.

# 검증이 증명하는 범위

Core 테스트는 정확한 식별자, 현재 상태 검증, 허용된 전이, 재시도, 무관한 작업의
격리를 검사합니다. 기존 검사의 통과로 미검증 반례를 부정할 수는 없습니다.
재현된 결함마다 행동 회귀 검사가 필요하며, 권위 게시와 일회성 소비 경계에서는
프로세스 경쟁과 중단된 쓰기도 검사합니다.

정답 주석이 있는 Context 테스트는 알려진 graph anchor를 입력합니다. 이는
전달받은 증거의 보존과 무관한 carrier 제외를 측정합니다. provider Lode가
anchor를 발견했는지, 본문을 읽었는지, 작업을 정확히 구현했는지는 측정하지
않습니다. 신규 사용자 및 대화형 검증기는 fixture로 공개 CLI/MCP를 호출하므로
자연어 대화에서의 실제 작업 성공을 입증하지 않습니다.

## 로컬 진단

소스 체크아웃에서 선택적으로 진단을 실행합니다.

```powershell
npm run measure:context-diagnostics
npm run measure:context-diagnostics -- --project C:\path\to\project --task "Inspect the requested change" --iterations 5
```

보고서는 읽기 전용, 변경, 누락된 hint를 구분합니다. catalog 크기는 UTF-8
직렬화 바이트이며 모델 token 비용이 아닙니다. 정적 import 순환은 결합도를
보여주지만 관측된 런타임 실패는 아닙니다.

프로젝트와 작업이 있으면 한 프로세스에서 첫 preview와 반복 preview를
측정합니다. OS 캐시를 비우지 않으므로 첫 호출은 OS cold-cache 측정이 아닙니다.
파일시스템 API로 읽은 바이트도 실제 디스크 I/O와 다릅니다. 측정치는 Capsule
identity, 증거 선택, 승인, 복구에 영향을 주지 않습니다. 명령은 프로젝트 초기화,
World 갱신, Capsule 저장, provider 호출을 하지 않습니다. 작업 원문, 소스 본문,
Observation payload도 출력하지 않습니다.

## 실제 작업 평가

기대 증거와 수락 기준을 숨긴 별도 작업을 사용합니다. 일반 agent와 Lode를 같은
provider/model, 저장소 revision, 작업, 권한, 외부 의존성 조건에서 비교하고,
정답 anchor를 주지 않습니다. 작업 해석, 증거 발견, 파일 읽기, 구현, 검증까지
평가하며 통제된 compaction 또는 provider 교체 사례도 포함합니다.

작업 성공, 필수 증거 누락, 잘못된 수정, 불필요한 질문과 승인, 경과 시간,
실제 provider token, 복구 후 사용자 제약 유지율을 기록합니다. 반복 실행하며
환경 실패를 구분합니다. 기계적 coverage, 패키지 설치, 도구 호출 성공만으로
이 결과를 입증할 수는 없습니다. 현재 fixture는 일반적인 우월성이나 실제 작업
성공을 증명하지 않습니다.

## CI와 게시

디렉터리 단위 trigger는 소스, 테스트, native 코드, 문서, 배포 입력을 포함합니다.
전체 JavaScript suite는 release와 두 marketplace의 독립적인 선행 조건입니다.
Cross-build는 대상 실행 파일을 준비하며, Windows와 macOS 작업은 별도로 설치,
native health, 소유 프로세스 정리, rollback과 uninstall smoke를 실행합니다.

CI 결과, 로컬 Windows 결과, cross-build, 실제 marketplace 설치, live provider
동작은 각각 별도의 증거입니다. 작업 구성이 존재한다는 것만으로 통과한 실행이
되지는 않습니다. 선택적인 native 또는 live-provider 경로에 fixture나 opt-in이
없으면 이를 공개하고 통과로 집계하지 않습니다.

<a id="source-verification"></a>

## 소스에서 검증

Core는 신뢰하는 로컬 호출자가 전달한 결정의 정확한 대상과 허용된 전이를
검증합니다. Host와 Lode는 실제 사용자 승인을 전달해야 하며, digest와
확인 플래그 자체가 사람의 의사를 인증하지는 않습니다.

Fixture 테스트는 재현성과 상태 전이를 입증합니다. Lode의 증거 발견률이나
전체 코딩 작업의 정확성을 입증하지는 않습니다.
[검증 증거와 로컬 진단](verification-evidence.md)을 참고하세요.

```powershell
npm test
npm run verify:newcomer
npm run verify:distribution
npm run verify:codex-marketplace
npm run verify:claude-marketplace
```

네이티브 소스는 해당 모듈 디렉터리에서 `go test ./...`와 `go vet ./...`도
지원합니다. JavaScript는 의미적 기준 구현으로 유지됩니다. 네이티브
백엔드는 픽스처 기반 적합성 검사와 무결성 검증을 통과한 뒤에만 사용 가능한
기능으로 표시됩니다.

## Coverage 계산 비교

선택된 fragment의 coverage index는 반복 탐색 대신 한 render 안의 필드·배열 index별 묶음을 사용합니다. 계산 비용만 바꾸며 검색, 선택 내용, 맥락 상한, 권한과 저장 방식은 바꾸지 않습니다. 기존 방식과 후보에는 같은 원문과 예산을 제공했습니다.

서로 겹치는 별도 근거 집단에서 출력이 동일했습니다. 순수 전달 비교 24건, 합성 입력을 사용한 실제 시작 formatter 18건, callback 순서 비교 22건, 독립 fitter 비교 40건입니다. 관련 회귀 검사는 148개 통과, 실패 없음, 로컬 계정 권한 부족으로 합성 symlink 1개를 건너뛰었습니다. 이 수를 서로 다른 종단 간 시나리오처럼 합산하면 안 됩니다.

4,800자 합성 pressure 조건에서 linked-judgment fitter는 기존 784–914 ms, 후보 33–45 ms였고 Todo fitter는 707–792 ms와 26–33 ms였습니다. 같은 프로세스 안에서 순서를 교대로 바꾼 비교의 원시 범위이며 모듈 시작 비용은 제외합니다. p95나 앱 전체 지연, 모든 경우의 속도 향상을 뜻하지 않습니다. 전체 본문과 짧은 입력은 일관되게 빨라지지 않았습니다.

group-first 묶기 실험은 필요한 조건을 누락했고, graph interleaving은 다른 사례의 회수율을 높였지만 필요한 인용을 잃었습니다. 두 안 모두 제외했습니다. 긴 조건의 누락과 기존 검색 품질은 미해결입니다. 설치된 Host, 실제 provider/model, tokenizer나 전체 메모리 개선은 입증하지 않았습니다.
