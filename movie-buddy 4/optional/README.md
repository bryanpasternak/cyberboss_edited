# Optional scripts

Scripts in this folder are **not** part of Movie Buddy proper. They depend on
software that is not in this repository, and Movie Buddy runs perfectly well
without them.

## `archive_watch_sessions.js`

Groups one day of Movie Buddy conversation into per-film archives, and splits a
chosen film into batches for a targeted memory-mining CLI.

**It requires Stone Memory — the memory store written by 来放松一会
([@wanyu445](https://github.com/wanyu445)) — and it `require()`s that project's
internal modules (`src/config`, `src/storage/memory-store`).**

**Stone Memory is currently in closed beta and its repository is invite-only, so
this script will not run for most readers, and there is no download link to give
you.** It is kept in the repo as a worked example rather than as a feature:
point it at your own memory store, or read it to see how a session's thread id
is recovered from `runtime/codex_bridge_state.json` and turned into per-film
archives. Nothing else in Movie Buddy depends on it.

It only ever *reads*. Archives are written to `runtime/watch-sessions/`, which is
gitignored, and the script never writes back into any memory store.

```bash
node optional/archive_watch_sessions.js \
  --stone-repo <path to the memory-store repo> \
  --date 2026-08-04 \
  --target "<exact film title to mine in detail>"
```

Only the Codex backend records a resumable thread id in
`runtime/codex_bridge_state.json`. With the Claude backend, the equivalent
transcript lives in Claude Code's own session storage and this script does not
read it.
