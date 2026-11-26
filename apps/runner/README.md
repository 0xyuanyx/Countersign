# 맡긴 일 실행기

폰 앱에서 맡긴 일은 에이전트가 `next_task`로 받아 가야 진행된다. 실행기는 그 일을 받아 에이전트 CLI(Claude Code `claude -p` 또는 Codex `codex exec`)에 넘겨 실제로 사고, 결과를 `finish_task`로 보고하게 한다. 결제는 그 에이전트 연결의 지갑 MCP로만 한다.

```bash
cd ~/Developer/Countersign && node_modules/.bin/tsx apps/runner/src/main.ts agent-5 --cli codex   # 또는 --cli claude
```

- 첫 인자: 앱에 보이는 에이전트 이름이나 id. 주인 토큰(`.countersign/owner.token`)으로 주인 API에서 그 에이전트의 **실행기 전용 주소**를 받는다 (앱에서 만든 연결 주소는 그대로).
- 10초마다 새 일을 확인하고, 일 하나에 최대 15분. 에이전트가 보고하지 않고 끝나면 실행기가 실패로 남긴다.
- 처음 보는 판매자면 에이전트가 1분 간격으로 다시 시도하며 폰 승인을 기다린다.
- `--cli claude`는 Claude Code 로그인(`claude` 실행 후 `/login`)이 필요하다. `--cli codex`는 ChatGPT 로그인된 Codex CLI를 쓴다.
