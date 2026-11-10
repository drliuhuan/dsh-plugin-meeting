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
- Meeting agenda upload/paste/drag-and-drop (`txt`, `md`, `csv`, `json`), Office
  documents (`PDF`, `Word`, `PPT`, `Excel`, ODF), and images (`png`, `jpg`,
  `webp`, `bmp`): Word/PPT/ODF text is read directly; PDF, legacy Office and
  images are rendered locally with DSH's LibreOffice kit and read with Windows
  OCR. Nothing is parsed on upload: clicking Apply sends the text to the
  configured DSH model, which returns time / speaker / unit / topic columns plus
  the meeting topic and domain (merged rows and OCR noise included). Click the
  agenda bar to pin the current item, and click a speaker chip to reassign that
  turn. Time ranges, speaker names and organizations become the current-item
  indicator, speaker-name suggestions, and reference context for correction,
  minutes and Q&A.
- A durable **my name + meeting domain** profile (set in the panel settings,
  stored at `~/.dsh/meetings/profile.json`): it never depends on the current
  meeting or the app session.
- **My speech drafts**: after an agenda upload, only when the user's own name
  appears in the agenda, the model writes the user's own speeches and the
  transitions they have to say — no generic host script, nothing for other
  speakers. The writing instructions are editable and the draft can be
  regenerated at any time; the Markdown result survives page reloads and is
  stored with the meeting.
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
- Minutes on demand (conclusion / discussion / decisions / action items / risks); nothing is generated on a timer, and the agenda is included in the prompt
  and a final version when the meeting ends.
- Q&A grounded in the minutes and transcript, with `[mm:ss]` citations and
  optional `ctx.web` search sources.
- On-disk history under `~/.dsh/meetings/<id>/`.

## My speech drafts (讲词 / 串词)

1. Open settings → **我的信息**, enter **我的姓名** (and optionally the
   organization) and save. The profile is stored on this machine and survives
   restarts.
2. Upload or paste the meeting agenda. If at least one agenda speaker matches
   the saved name, the plugin automatically writes:
   - **我的讲词** — for the agenda slots that belong to the user;
   - **我的串词** — the transitions the user has to say around those slots.
3. Open the **讲词串词** tab to read or regenerate the draft. The textarea in
   **生成提示词** is the writing instruction sent to the model; edit it and press
   **用这个提示词重新生成**. Leave it empty to use the built-in default.

Nothing is generated when no name is saved, or when the saved name does not
appear in the agenda: the draft is for the user only, never a generic script,
and an unmatched name must not spend a model call.

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

agenda + my-name profile -> only slots whose speaker matches my name
  -> LLM (editable writing prompt) -> Markdown 讲词/串词
  -> stored with the meeting, or as a pending draft before it starts
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
