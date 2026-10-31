> 이 문서는 [Same-project conversation messaging](../conversation-messaging.md)의 한국어판입니다.

# 같은 프로젝트 대화 메시지

상태: Claude Code, Codex, OpenCode에서 같은 프로젝트의 살아있는 대화를 나열하고 메시지를 보낼 수 있습니다. 전역 목록이 아니며, 프로젝트 밖의 권한을 주지 않습니다.

## 사람이 할 수 있는 일

`lode_conversation_list`는 이 프로젝트의 `.lode/messaging/`에 등록된 다른 살아있는 대화를 보여 줍니다. 각 행에는 보낼 주소와 지금 받을 수 있는지가 있습니다. `lode_conversation_send`는 그 주소로 글을 보냅니다. 답장은 또 하나의 메시지입니다. 받은 쪽은 보낸 주소와 `reply_to`를 사용합니다.

결과는 받는 클라이언트가 주입을 받아들였으면 `delivered`, 모델이 읽었다는 확인 없이 소켓·파이프·프롬프트 훅으로 넘겼으면 `sent`, 그 대화의 수신함에 대기 중이면 `queued`입니다. `unreachable`는 이 프로젝트에 그 주소의 등록이 없다는 뜻이며, 그 경우 아무것도 저장하지 않습니다.

## 범위와 신원

첫 `lode_conversation_list` 또는 `lode_conversation_send`가 `.lode/messaging/`를 엽니다. 그 다음부터 호스트 훅이 그 프로젝트의 다른 살아있는 대화를 등록합니다. 그 디렉터리가 생기기 전에 시작한 Claude Code 또는 Codex 세션은 자신의 다음 `SessionStart` 또는 `UserPromptSubmit`까지 목록에 나오지 않습니다. 그 훅은 우편함을 만들지 않고, 목록은 클라이언트 세션 저장소를 읽지 않습니다. 24시간 동안 조용한 대화는 목록에 없고, 그 주소로 보내면 `unreachable`입니다. 그 전에는 즉시 채널이 아닌 대화에도 보낼 수 있고, 메시지는 다음 프롬프트까지 `queued`로 남습니다. 다른 프로젝트의 대화는 목록에 없고, 주소를 입력해도 고를 수 없습니다. 보낸 사람은 지금 호출한 대화입니다. 도구 인자로 보낸 사람을 지정할 수 없습니다. 하위 에이전트 주소는 부모와 다르고, 하위 에이전트의 프롬프트는 부모 수신함을 가져가지 않습니다. 주입된 본문 줄은 `| `로 시작해 본문이 `from:` 헤더를 위조하지 못합니다. 2분을 넘는 미래 시각의 presence는 오래된 것으로 봅니다.

[세션 작업](session-work-context.md)의 읽기 전용 후보 보기는 그대로입니다. 그 후보는 여전히 연락을 허가하지 않습니다.

## 클라이언트별 받기

Claude Code는 문서화된 inbox 소켓 또는 네이티브 Windows named pipe를 사용합니다. 인증 줄은 문서화된 `{"type":"auth","token":"..."}` 형식입니다. 네이티브 Windows에서는 `CLAUDE_CODE_MESSAGING_TOKEN` 또는 `CLAUDE_CONFIG_DIR` 아래 세션 키 파일에서 토큰을 찾지 못하면 파이프를 열지 않습니다. 쓰기가 끝나도 `delivered`가 아니라 `sent`입니다. 소켓이 없으면 `UserPromptSubmit`이 한 번 넣을 때까지 `queued`로 남습니다.

Codex 즉시 전달은 조상 명령줄에 `app-server --listen unix://`가 있을 때만 `codex app-server proxy --sock`를 사용합니다. 일반 Codex CLI 세션에는 그런 조상이 없으므로 `lode_conversation_list`는 `next-prompt`로 보고하고 메시지는 `UserPromptSubmit`을 기다립니다. Linux는 `/proc`, macOS는 `ps`, Windows는 PowerShell 프로세스 목록을 읽습니다. 소켓은 listen 경로이거나 `CODEX_HOME` 또는 그 변수가 없을 때 `~/.codex`의 제어 소켓입니다. 전달은 `thread/resume` 다음 `turn/start`입니다. turn id가 돌아오면 `delivered`입니다. 홈이 없거나 소켓이 없거나 resume가 거절되거나 Windows spawn이 거절되면 `queued`로 남습니다. Windows에서는 Node가 `codex.cmd`를 직접 띄우면 거절하므로 `cmd.exe /d /s /c`를 거칩니다. `%`, 따옴표, cmd 구분자가 있는 소켓 경로는 `cmd.exe`에 넘기지 않고 메시지는 `queued`로 남습니다. 프록시 종료는 `taskkill.exe /T`로 프로세스 트리를 `cmd.exe`와 함께 끝냅니다. Node는 Unix 소켓을 직접 열지 않습니다. Codex는 프로젝트 디렉터리를 신뢰한 뒤에만 프로젝트 훅을 실행합니다. 그 전에는 Codex 세션이 등록되지 않고 대기 중인 주입을 받지 않습니다.

OpenCode는 `session.get`이 있으면 v1 `client.session.prompt`를 쓰고, `session.get`이 없고 `hook`, `wait`, `command`가 있으면 v2 `client.session.prompt`에 `delivery` `queue`를 사용합니다. `delivery` 값 `queue`는 여기서 쓰는 v2 플러그인 인자이며, 출시된 OpenCode 바이너리로는 확인하지 않았습니다. system transform은 지금 만들고 있는 세션에 prompt하지 않습니다. 수락된 메시지 id는 `delivered`입니다. 그렇지 않으면 다음 system transform이 수신함을 한 번 넣고 `sent`로 보고합니다.

## OpenCode 호출자 티켓

호스트 호출자가 없는 OpenCode 호출은 짧은 티켓을 가집니다. 서명 키는 `LODE_AGENT_OPERATIONAL_STATE_ROOT`가 아니라 `HOME` 또는 `USERPROFILE`과 프로젝트 루트에서 만듭니다. 그래서 그 변수가 달라도 플러그인과 MCP 서버는 같은 파일을 씁니다. POSIX에서 키 디렉터리 모드는 `0700`, 키 파일 모드는 `0600`입니다. 64 hex가 아닌 키 파일은 바꿉니다. 키를 읽을 수 있는 같은 사용자 프로세스는 여전히 티켓에 서명할 수 있습니다. 키는 다른 사용자와 프로젝트에 커밋된 파일이 호출자를 위조하는 것을 막습니다.

## Canon이 아닌 것

`.lode/messaging/`는 살아있는 우편함입니다. 새 프로젝트는 만들 때 `/messaging/`를 무시합니다. 이미 있는 `.lode/.gitignore`는 고치지 않습니다. 우편함 디렉터리는 그 무시 파일을 뺀 모든 파일을 무시하는 자체 `.gitignore`를 가지므로 메시지 본문은 untracked로 남지 않습니다. 주소마다 inbox, inflight, archive를 합쳐 메시지 200개, 1 MiB를 넘기지 않습니다. 한 주소가 가득 차도 다른 주소로 보내는 것은 막지 않습니다. 24시간이 지난 inbox, inflight, archive는 지우고, 끝난 대화에 남은 큐도 포함합니다. 스냅샷, Session 기록, 이관 입력이 아닙니다. 기존 기록 id와 해시는 바뀌지 않습니다.
