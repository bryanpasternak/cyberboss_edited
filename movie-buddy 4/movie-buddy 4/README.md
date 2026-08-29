# Movie Buddy

Watch a film on your own machine with an AI sitting next to you.

You load a video file and a subtitle file. They stay in your browser tab — nothing
is uploaded, transcoded, or copied into the project. When you say something (typed
or spoken), Movie Buddy sends the AI exactly three things: **the current video
frame, what you just said, and at most four subtitle lines that have already
played.** It replies in a line or two, like someone on the couch with you.

It cannot spoil the film, because it is never given the parts you haven't watched.

```
your video + subtitles          (never leave the browser)
        │
        ▼
   browser (app.js) ── current moment only ──► POST /api/message
        │                                              │
        │                                     runtime/message_queue.jsonl
        │                                              │
        │                                    claude_bridge.js / codex_bridge.js
        │                                              │
        │                                     Claude Code  or  Codex
        │                                              │
        └────────── GET /api/state ◄────────── runtime/response.json

voice: MediaRecorder ──► POST /api/transcribe ──► faster-whisper (on this machine)
```

## Requirements

| | |
|---|---|
| Python | 3.10 or newer |
| Node.js | 18 or newer (20+ recommended; the Codex backend needs 22+ for its built-in `WebSocket`) |
| An agent CLI | **Claude Code** (default) or **Codex** |
| Optional | `faster-whisper` for push-to-talk |

Install the AI backend you want:

```bash
# Claude Code (default backend)
npm install -g @anthropic-ai/claude-code
claude          # run once to sign in

# or Codex
npm install -g @openai/codex
```

Then, for voice input:

```bash
pip install -r requirements.txt
```

Model weights download on first use into `runtime/models/` and are never committed.
Typing works without this step.

## Run it

```bash
./start.sh            # macOS / Linux
```

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1    # Windows
```

Your browser opens `http://127.0.0.1:4174/`. Drop a video and a `.srt`/`.vtt` onto
the player, press play, and start talking.

If the subtitles are burned into the picture, press **"Subtitles are in the
picture"** — Movie Buddy then asks the AI to read them off the frame instead, and
any subtitle file you loaded is used only for its timeline.

## Configure it

Copy `config.example.json` to `config.json` and edit. `config.json` is gitignored,
so your names, persona, and language stay on your machine.

```json
{
  "backend": "claude",
  "userName": "Sam",
  "buddyName": "Robin",
  "persona": "You are watching a film with {userName}, sitting right next to them…",
  "claude": { "model": "sonnet" }
}
```

Everything is optional; anything you omit falls back to `config.example.json`.
Useful keys:

- `backend` — `"claude"` or `"codex"`.
- `persona` — the whole personality. `{userName}` and `{buddyName}` are substituted.
- `ui` — every string the page displays, so you can run it in any language.
  A complete Chinese config lives at [`examples/config.zh.json`](examples/config.zh.json):
  copy it to `config.json`, change the two names, done.
- `prompts` — the scene template sent with each turn, including the `[SILENT]` token.
- `capture.maxWidth` / `capture.jpegQuality` — smaller frames cost fewer tokens.
- `whisper.language` — set to your spoken language, or `""` to auto-detect.
- `server.port` — if 4174 is taken.

## What actually leaves your machine

This matters more than the marketing line, so plainly:

**Stays local, always.** The video file. The full subtitle file. Your recorded
audio — it is written to a temp file, transcribed by `faster-whisper` on this
machine, and deleted immediately. Screenshots and message history in `runtime/`.

**Goes to the AI backend** (and therefore to whatever model that CLI is configured
to use, which for a default install is a hosted model): one JPEG frame per turn,
your message text, the current subtitle line, and up to four already-played
subtitle lines. Nothing else — not the filename's path, not future subtitles, not
the audio.

If you want zero network egress, point the backend CLI at a local model. Movie
Buddy itself never opens a network connection.

**You are responsible for the media you load.** Sending frames of a film to a
hosted model is your call to make, and `prepare_episode.py` transcribes whatever
you point it at.

## Threat model

- The server binds `127.0.0.1` only, and rejects any request whose `Host` header
  isn't ours (blocks DNS rebinding) or whose `Origin` is a different site (blocks
  a random webpage POSTing into your queue).
- Static file serving is a three-name allowlist — there is no path traversal.
- With the Claude backend the agent runs with **`--tools ""`**: no Read, no Write,
  no Bash, no MCP servers. It can only emit text. With the Codex backend it runs
  `approvalPolicy: never` + `sandbox: read-only`.
- The no-spoilers guarantee is **structural for subtitles** — future cues are
  filtered out in `subtitleMoment()` before anything is sent. It is only a
  *prompt-level* request that the model not draw on what it already knows about
  the film, or look it up. A model that has memorised the plot can still spoil it.

## Optional extras

- `prepare_episode.py <video> <output.srt>` — generate a timed transcript locally
  with `faster-whisper` when you have no subtitle file.
- `optional/` — scripts that depend on software outside this repository. See
  [`optional/README.md`](optional/README.md).

**Memory.** Movie Buddy itself remembers nothing between runs beyond the
backend's own session. Long-term memory — the watch-along conversation that
survives across sessions and can be recalled later — is
**Stone Memory**, a separate project by 来放松一会
([@wanyu445](https://github.com/wanyu445)), currently in closed beta with an
invite-only repository. It is not required, not bundled, and not written to by
anything here — Movie Buddy works fully without it.

## Layout

| File | Role |
|---|---|
| `index.html`, `styles.css` | two-column UI: timeline on the left, player on the right |
| `app.js` | playback, subtitle parsing, frame capture, voice, proactive scheduling |
| `server.py` | loopback HTTP, message queue, local speech-to-text |
| `claude_bridge.js` | Claude Code backend (`claude -p`, streaming JSON, one long session) |
| `codex_bridge.js` | Codex backend (`codex app-server`, JSON-RPC over WebSocket) |
| `load_config.js` | shared config loading for the bridges |
| `runtime/` | all local state; gitignored, never commit it |

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces talk to each other.

## Acknowledgements

Movie Buddy is built on top of Game Buddy, and on two pieces of other people's
work without which it would not exist.

**利未 — [@Liooowei](https://github.com/Liooowei)** wrote Game Buddy's
speech-to-text and its direct Codex bridge. Before that bridge, every exchange
had to wait for a once-a-minute polling heartbeat; after it, the reply arrives
while the frame is still on screen, and you can talk instead of type. That one
change is the difference between correspondence and company, and it is the
foundation everything here stands on.

**Long-term memory in this project is Stone Memory, written by 来放松一会
([@wanyu445](https://github.com/wanyu445)).** It is what keeps a single
watch-along conversation alive across sessions: threads are compressed and
rebuilt as they grow, so the window opened on day one is still the same window
today — with the original text preserved and recallable, not summarised away.
Stone Memory is its own project and none of its code is in this repository,
which is why it appears here and not in the license file.

Built by [@yanjun62](https://github.com/yanjun62).

## License

MIT — see [LICENSE](LICENSE).
