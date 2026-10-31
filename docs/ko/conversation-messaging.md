> 이 문서는 [Same-project conversation messaging](../conversation-messaging.md)의 한국어판입니다.

# 같은 프로젝트 대화 메시지

상태: Claude Code, Codex, OpenCode에서 같은 프로젝트의 살아있는 대화를 나열하고 메시지를 보낼 수 있습니다. 전역 목록이 아니며, 프로젝트 밖의 권한을 주지 않습니다.

## 사람이 할 수 있는 일

`lode_conversation_list`는 이 프로젝트의 `.lode/messaging/`에 등록된 다른 살아있는 대화를 보여 줍니다. 각 행에는 보낼 주소와 지금 받을 수 있는지가 있습니다. `lode_conversation_send`는 그 주소로 글을 보냅니다. 답장은 또 하나의 메시지입니다. 받은 쪽은 보낸 주소와 `reply_to`를 사용합니다.

결과는 받는 클라이언트가 주입을 받아들였으면 `delivered`, 모델이 읽었다는 확인 없이 소켓·파이프·프롬프트 훅으로 넘겼으면 `sent`, 그 대화의 수신함에 대기 중이면 `queued`입니다. `unreachable`는 이 프로젝트에 그 주소의 등록이 없다는 뜻이며, 그 경우 아무것도 저장하지 않습니다.

## 범위와 신원

등록은 실제로 열린 프로젝트의 호스트 훅 또는 OpenCode 플러그인에서 일어납니다. 다른 프로젝트의 대화는 목록에 없고, 주소를 입력해도 고를 수 없습니다. 보낸 사람은 지금 호출한 대화입니다. 도구 인자로 보낸 사람을 지정할 수 없습니다. 하위 에이전트 주소는 부모와 다르고, 하위 에이전트의 프롬프트는 부모 수신함을 가져가지 않습니다.

[세션 작업](session-work-context.md)의 읽기 전용 후보 보기는 그대로입니다. 그 후보는 여전히 연락을 허가하지 않습니다.

## 클라이언트별 받기

Claude Code는 문서화된 inbox 소켓 또는 네이티브 Windows named pipe를 사용합니다. 인증 줄은 문서화된 `{"type":"auth","token":"..."}` 형식입니다. 네이티브 Windows에서는 `CLAUDE_CODE_MESSAGING_TOKEN` 또는 `CLAUDE_CONFIG_DIR` 아래 세션 키 파일에서 토큰을 찾지 못하면 파이프를 열지 않습니다. 쓰기가 끝나도 `delivered`가 아니라 `sent`입니다. 소켓이 없으면 `UserPromptSubmit`이 한 번 넣을 때까지 `queued`로 남습니다.

Codex는 이 대화의 프로세스 조상에 `app-server --listen unix://`가 있을 때만 `CODEX_HOME` 아래 문서화된 제어 소켓에 `codex app-server proxy --sock`로 연결합니다. turn id가 돌아오면 `delivered`입니다. 그렇지 않으면 `UserPromptSubmit`을 위해 `queued`로 남습니다. Node는 Windows를 포함해 Unix 소켓을 직접 열지 않습니다.

OpenCode는 그 메서드가 있을 때 v1 플러그인 클라이언트 `client.session.prompt`를 사용합니다. 수락된 메시지 id는 `delivered`입니다. 그렇지 않으면 다음 system transform이 수신함을 한 번 넣고 `sent`로 보고합니다.

## Canon이 아닌 것

`.lode/messaging/`는 살아있는 우편함입니다. 생성되는 저장소 규칙에서 무시되며 스냅샷, Session 기록, 이관 입력이 아닙니다. 기존 기록 id와 해시는 바뀌지 않습니다.
