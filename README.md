# dsh-plugin-meeting

A DeepSeek Harness plugin that listens to any meeting playing through the
default Windows render device, transcribes it locally with SenseVoice, has the
configured DSH model proofread each turn in the meeting's domain and optionally
translate it, keeps a rolling summary, and answers questions from the meeting
with optional web lookup.

Audio never leaves the machine. Only recognized text reaches the model you
already configured in DSH.

## Features

- Native WASAPI loopback capture of the default render endpoint — no virtual
  audio cable, no screen-share picker, no browser media permissions.
- Offline SenseVoice recognition through DSH's optional Voice Input bundle.
- Domain-aware LLM correction (medical, technology, gaming, finance, legal,
  education, manufacturing, marketing, research, custom) using the meeting topic
  and an optional glossary.
- Meeting agenda upload/paste/drag-and-drop (`txt`, `md`, `csv`, `json`) and
  image screenshots (`png`, `jpg`, `webp`, `bmp`) with local Windows OCR: time
  ranges, speaker names and organizations become the current-item indicator,
  speaker-name suggestions, and reference context for correction, minutes and
  Q&A.
- Local CAM++ voice clustering into 发言人 1/2/3 (about 27 MB): consecutive
  turns by one speaker are merged into one continuous block; a one-minute pass
  re-corrects the whole conversation to join lines split by the 10-second ASR
  window. Labels are suggestions, not identity recognition, and can be renamed
  with an organization.
- Optional microphone capture labelled **自己** (yourself), separate from the
  meeting speakers. Headphones are recommended to avoid echo duplicates.
- Per-line translation is **off by default**; English, Simplified Chinese,
  Japanese, or Korean can be enabled per meeting.
- A right-hand sidebar: opening the panel shifts the DSH shell left, and the
  header icon breathes green while listening.
- Raw ASR text kept behind a disclosure, with retry for failed corrections.
- Rolling minutes (conclusion / discussion / decisions / action items / risks)
  and a final version when the meeting ends.
- Q&A grounded in the minutes and transcript, with `[mm:ss]` citations and
  optional `ctx.web` search sources.
- On-disk history under `~/.dsh/meetings/<id>/`.

## Requirements

- Windows 10/11 x64.
- DSH 0.2.1+ with the official **Voice Input** bundle enabled
  (`@deepseek-ai/dsh-experimental-voice-input-bundle`).
- A configured DSH default model and credentials.
- Optional: a configured DSH web-search provider for Q&A lookup.
- The local SenseVoice model (about 240 MB) and, if speaker labels are on, the
  CAM++ speaker-embedding model (about 27 MB) are downloaded on first use.

## Install

```powershell
dsh plugin --profile desktop add D:\path\to\dsh-plugin-meeting
```

Then enable **Voice Input** and **Meeting Assistant** in DSH's plugin manager.
Open the meeting assistant from the Session header, open settings, and click
**Download and prepare model** (about 240 MB) the first time.

See [README.zh.md](README.zh.md) for the full Chinese guide, architecture,
privacy notes, and troubleshooting.

## Architecture

```text
system audio -> WASAPI loopback (native helper) -> downmix/resample 16 kHz
  -> energy VAD utterances -> CAM++ speaker embedding + online clustering
  -> SenseVoice (local) -> DSH LLM (domain correction + translation) -> SSE
  -> rolling summary (LLM) and Q&A (minutes + transcript + optional web search)

agenda (txt/md/csv/json) -> current time slot + speaker/org reference
```

The native helper is `native/LoopbackCapture.cs` (C# / .NET Framework 4.x). A
prebuilt `native/LoopbackCapture.exe` ships with the package; rebuild with
`node scripts/build-native.mjs`.

## Development

```powershell
npm run check
npm run selftest
node scripts/build-native.mjs --check
```

`client.js` is loaded as a classic script through DSH's module loader; reload the
page after editing it. Host modules are reloaded by DSH HMR.

## License

MIT
