# Movie Buddy · Architecture

Movie Buddy is a local-only companion app. The browser plays a film the user
selected; the app forwards one "moment" at a time to an agent CLI running on the
same machine and shows the reply. Never read, request, or package `runtime/` —
it holds local screenshots, messages, and session ids.

## Components

- `index.html` / `styles.css` — two-column UI: message timeline left, player right.
- `app.js` — loads local video and SRT/VTT, parses cues, captures the current
  frame to a canvas, computes the subtitle window, records voice, schedules
  proactive check-ins, polls state. Applies all user-visible strings from
  `GET /api/config`.
- `server.py` — loopback-only HTTP. Serves three static files, accepts messages,
  exposes state and config, and runs local Whisper transcription. Spawns the
  bridge for the configured backend.
- `claude_bridge.js` — Claude Code backend.
- `codex_bridge.js` — Codex backend.
- `load_config.js` — merges `config.example.json` with `config.json`, or reads the
  resolved config out of the `MOVIE_BUDDY_CONFIG` environment variable that
  `server.py` sets.
- `prepare_episode.py` — optional local transcript generator.
- `optional/` — scripts depending on software outside this repo, including the
  adapter for **Stone Memory** (by 来放松一会, https://github.com/wanyu445), which
  is where long-term memory lives. Movie Buddy holds none of its own. Stone
  Memory is in closed beta and invite-only, so treat that adapter as a worked
  example, not a runnable feature.

## Data flow

```text
local video + subtitle files
        |
        v
browser app.js -- current moment only --> POST /api/message
        |                                  |
        |                          runtime/message_queue.jsonl
        |                                  |
        |                         <backend>_bridge.js
        |                                  |
        |                          Claude Code / Codex
        |                                  |
        +<-- GET /api/state <-- runtime/response.json
```

Voice is a separate path: `MediaRecorder -> POST /api/transcribe ->
faster-whisper`, and the temp audio file is deleted as soon as it is transcribed.

## The bridge contract

Any backend is a Node script that:

| Reads | |
|---|---|
| `runtime/message_queue.jsonl` | append-only, one JSON object per line: `{id, text, frameAttached, mode}` |
| `runtime/current_frame.jpg` | the frame belonging to the newest queued message |

| Writes | |
|---|---|
| `runtime/bridge_status.json` | `{status, backend, updatedAt, ...}` where status is `starting`, `ready`, `thinking`, `error`, or `stopped` |
| `runtime/response.json` | `{id, text, at}` — the reply for one message id |

Rules every bridge follows: dedupe by message id, one in-flight turn at a time,
persist processed ids so a restart doesn't replay the film, and write **no**
response file when the model returns the silence token.

Both writes are atomic (temp file + rename), because `server.py` polls these files
while the bridge is writing them.

## Claude Code backend

One long-lived process:

```text
claude -p
  --input-format stream-json --output-format stream-json --verbose
  --system-prompt-file runtime/system_prompt.txt
  --tools ""                 # no Read/Write/Bash/anything: text replies only
  --permission-mode dontAsk
  --strict-mcp-config        # ignore whatever MCP servers the user has configured
  --model <config.claude.model>
  --session-id <uuid>        # first launch; later launches use --resume <id>
```

Each turn is one line on stdin:

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"text","text":"…scene context…"},
  {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"…"}}
]},"parent_tool_use_id":null}
```

The bridge reads newline-delimited JSON on stdout, takes `session_id` from the
`system/init` event, and treats the `result` message as end-of-turn. If the CLI
exits, the bridge relaunches it with `--resume <session_id>`; the in-flight
message was never marked processed, so it is retried automatically. Restarts are
rate-limited to six per minute before the bridge gives up with an error status.

The persona lives in the system prompt, so it costs tokens once rather than once
per turn.

## Codex backend

Connects to `codex app-server --listen ws://127.0.0.1:8766` over WebSocket
JSON-RPC, keeps one thread (`approvalPolicy: never`, `sandbox: read-only`),
sends `turn/start` with a `localImage` block pointing at the frame on disk, and
assembles the reply from `item/completed`, `item/agentMessage/delta`, and
`turn/completed` events. Codex has no separate system-prompt channel here, so the
persona is prepended to every turn. Requires Node 22+ for the global `WebSocket`.

## Safety properties

1. The HTTP server binds loopback, validates the `Host` header, and rejects
   cross-origin requests. Static serving is a three-name allowlist.
2. The whole film, the whole subtitle file, and the recorded audio never reach
   the model. Only the current frame, the user's line, and up to four cues that
   already played.
3. Future subtitles are filtered out in `subtitleMoment()` before the payload is
   built — a structural guarantee, not a prompt. The request that the model not
   volunteer what it already knows about the film *is* only a prompt.
4. `runtime/`, session ids, screenshots, and local paths are not for display,
   commit, or documentation.
5. Nothing bypasses the bridge contract to write into an external memory store.

## Extending it

To add a backend: create `<name>_bridge.js` honouring the contract above,
register it in `BRIDGES` in `server.py`, and add a config block. The browser and
server need no other changes — the UI only reads `bridge_status.json`.
