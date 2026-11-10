# AGENTS.md — dsh-plugin-meeting

These instructions apply to every change in this repository. They are part of
the project contract, not optional advice.

## Commit and push as you go

The operator has directed: **随改随提交** — commit and push each coherent change
as it is made. Do not leave finished work uncommitted.

For every change:

1. Make the change and keep the diff focused.
2. Run the narrowest relevant checks:
   - `npm run check` for any JavaScript change.
   - `npm run selftest` for agenda, speaker-clustering or audio changes.
   - `node scripts/build-native.mjs --check` when `native/LoopbackCapture.cs` is
     touched; rebuild with `npm run native:build` first.
3. Update `README.md` / `README.zh.md` when behavior, supported formats, setup,
   or limitations change.
4. `git add` the changed files, commit with a concise English imperative
   message, and `git push origin main`.
5. Never claim a change is complete while its worktree is dirty.

If a change is experimental or cannot be finished, do not leave it mixed into
the repository. Revert it or keep it in a separate scratch location outside the
repository.

## Never commit

- Meeting transcripts, audio, summaries, screenshots or agenda files from
  `~/.dsh/meetings`.
- Downloaded models (SenseVoice / CAM++), build outputs under `node_modules`,
  local probe folders, logs or credentials.
- Tokens, API keys, `.env` files, or machine-specific absolute paths that are
  not documented fallbacks.

`.gitignore` covers the common cases, but check `git status` before every commit.

## Project shape

- `index.js` — Host entry and route registration.
- `client.js` — classic-script Web client, header toggle + portaled right sidebar.
- `lib/meeting.mjs` — capture, ASR, correction, turns, refinement, minutes, Q&A.
- `lib/agenda.mjs` — agenda parsing and current-item matching.
- `lib/office.mjs` — PDF/Office text extraction and LibreOffice rendering.
- `lib/native.mjs` — WASAPI capture, device enumeration, Windows OCR.
- `native/` — C# capture helper and OCR PowerShell script.
- `scripts/` — native build and pure local selftest.

Keep the plugin generic: it captures the Windows default render device and
works with any meeting application. Do not add vendor-specific integrations or
wording without an explicit request.
