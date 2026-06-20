# Cyberboss Memory System Change Log - Public Version

## Goal

Build a usable daily continuity memory layer for Cyberboss.

The core problem was that diary files existed as readable daily records, but they were not converted into small, searchable memory items. The new layer keeps diary files as the source of truth, then creates a lightweight recall index for cross-day continuity.

## What Changed

### Added `scripts/memory-items.js`

New CLI for memory indexing and retrieval.

Commands:

```bash
npm run memory:sync
npm run memory:sync-workspace-diary
npm run memory:sync-shuoshuo
npm run memory:embed
npm run memory:embed-local
npm run memory:prepare -- --query "current topic" --limit 6
npm run memory:search -- --query "topic keyword" --limit 3
```

Main behavior:

- Reads diary files from `.cyberboss/diary`.
- Parses diary sections in the form `## HH:mm Title`.
- Converts each section into one memory item.
- Writes JSONL items to `.cyberboss/memory/memory_items.jsonl`.
- Adds metadata: `date`, `time`, `title`, `content`, `tags`, `weight`, `status`, `sourcePath`, `sourceHash`.

Imported history support:

- `sync-workspace-diary` reads historical diary files from workspace `diary-001/*.md`.
- `sync-shuoshuo` reads long-form self-record files from workspace `硕硕日记/*.txt`.
- Both are imported as additional memory item sources, not as editable diary replacements.

Search behavior:

- Uses keyword matching, Chinese bigram/trigram matching, tags, recency, weight, and open status.
- Filters out overly broad tokens.
- Requires a real lexical match so unrelated high-weight memories do not float up too easily.
- If embeddings exist, mixes vector similarity into search results.
- JSON output stays compact and does not print full embedding vectors.

### Embedding Support

API embedding mode:

- Uses an OpenAI-compatible `/embeddings` endpoint.
- Config comes from `.env`.
- If no embedding config exists, the command exits clearly instead of pretending vector search is available.

Local no-key fallback:

- `npm run memory:embed-local` creates `local-hashed-ngram-512` vectors.
- Requires no API key, no network, and no token spend.
- Uses hashed Chinese n-gram and token features.
- Weaker than real embedding models, but better than pure keyword search.

### Added Runtime Memory Injection

New runtime behavior:

- New-thread opening turns automatically receive a private memory context block.
- After `/compact` finishes, the next user turn also receives private memory context.
- The retrieved memory context is model-only context, not visible WeChat output.
- Normal chat should not report file paths, commands, scores, or retrieval internals unless explicitly asked.

Files changed:

```text
src/adapters/runtime/memory-context.js
src/adapters/runtime/shared-instructions.js
src/adapters/runtime/codex/index.js
src/adapters/runtime/claudecode/index.js
src/adapters/runtime/codex/session-store.js
src/core/app.js
```

### Added Operation Guidance

Updated operation/instruction files so future turns know:

- Diary is human-readable.
- `memory_items.jsonl` is the cross-day recall index.
- `anchors.md` remains higher priority than retrieved daily items.
- `memory:prepare` is the default reentry helper.
- Retrieval should restore continuity silently, not become chat output.

## Installed State

Current installed state:

- `.cyberboss/diary` history is indexed.
- Workspace historical diary is indexed.
- Workspace self-record files are indexed.
- Total memory items: 447.
- All 447 items have local `local-hashed-ngram-512` vectors.
- New-thread opening turns inject 6 retrieved memory items.
- After compact, the next user turn injects 6 retrieved memory items.

## Current Memory Layers

The current design is:

- `anchors.md`: identity and reentry anchors. Highest priority.
- `diary/*.md`: human-readable daily record.
- `memory_items.jsonl`: generated recallable memory items.
- Imported historical diary items: older diary context.
- Imported self-record items: long-term thinking-style reference.
- Local vectors: zero-key similarity baseline.
- `memory:prepare`: sync today, ensure local vectors, search by current topic.
- Runtime injection: private 6-item context for new thread and compact recovery.

## Verification

Verified:

- `scripts/memory-items.js` passes syntax check.
- Diary sync works.
- Historical diary import works.
- Self-record import works.
- Local vector generation works.
- Search returns compact results.
- Runtime opening text includes private memory context.
- Compact-next-turn injection works.
- `npm run check` passes.

## Cost and Scaling

Current no-key vector mode:

- Uses CPU only.
- Does not use GPU.
- Does not call an API.
- Does not spend model tokens for embedding.
- At hundreds of memory items, search cost is trivial.

Expected scaling:

- Hundreds to low tens of thousands of items should be fine for local JSONL search.
- If the index grows much larger, switch to SQLite or a dedicated vector store.

Tradeoff:

- Local vectors are good as a zero-cost baseline.
- Real embedding models will likely be better for abstract semantic recall.
- Keep anchors above vector results.
- Add provider embeddings only if recall quality is not enough.

## Next Step

Use the rule-based plus local-vector index for a few days.

Then evaluate:

1. Whether retrieved context is relevant enough.
2. Whether some sources should have higher or lower weight.
3. Whether search needs better chunking.
4. Whether a real embedding provider is worth adding.
5. Whether large-scale storage should move from JSONL to SQLite.

Target effect:

- Current messages can pull related memory from previous days.
- Reentry after new thread or compact feels continuous.
- The user should experience continuity, not a file search report.
