# Gemini API CLI

Local, dependency-free Node.js CLI for agent-controlled Gemini media generation: `gemini-api tts` (speech) and `gemini-api music` (Lyria). Requires Node >=22.16. Calls Google's REST API; no SDK, server, or build step.

This is an unofficial project and is not affiliated with Google. Calls use your own API key and may incur charges.

## Setup

```sh
git clone https://github.com/logbookfordevs/gemini-api-cli.git
cd gemini-api-cli
npm link
```

`npm link` puts `gemini-api` on your PATH, pointing at `src/gemini-api.js` in this checkout, so source edits take effect immediately. Keep the checkout at its current path or re-run `npm link` after moving it. Agents must inherit that PATH. `gemini-tts` and `gemini-music` remain as thin entry points that pin the command (`gemini-tts tts …`, `gemini-api music …`); prefer `gemini-api`. The binary is not named `gemini` to avoid clashing with Google's official Gemini CLI.

Set `GEMINI_API_KEY` in this checkout's ignored `.env` file (copy `.env.example` if missing), or export it in your shell. `GOOGLE_API_KEY` is also accepted. Existing environment variables take precedence. The checkout's `.env` loads from any working directory; unrelated projects' env files are never loaded. Use `--env-file /absolute/path/.env` to select another file. Do not give the key to agents in prompts.

## Usage

```sh
gemini-api --help
gemini-api tts --help
gemini-api schema tts --pretty
gemini-api voices
gemini-api tts --text 'Olá, mundo!' --style 'Warm Brazilian Portuguese' --voice Kore --out hello.wav
gemini-api tts --input script.txt --out narration.wav
printf 'Hello!' | gemini-api tts --out hello.wav
gemini-api tts --json-input examples/dialogue.json --out dialogue.wav
gemini-api tts --json-input - --out hello.wav <<'JSON'
{"text":"Hello!","voice":"Puck","style":"Cheerful"}
JSON
gemini-api tts --text 'Hello!' --dry-run --pretty
```

`--input` reads plain UTF-8 text; `--json-input` reads a structured job. Both accept `-` for stdin. No explicit source defaults to plain text stdin. Inputs are limited to 1 MiB locally; provider limits still apply. Keep longer scripts split into explicit jobs. The CLI makes one request per invocation.

Single-speaker input is `{text, voice?, style?, model?}`. For dialogue use `{speakers: [{name, voice}, {name, voice}], turns: [{speaker, text, style?}], style?, model?}`. Exactly two distinct configured speakers are required; each turn references one by name. Per-turn style overrides shared style. `schema` prints JSON Schema; runtime additionally checks speaker references and unique names. Unknown fields fail.

Transcript is verbatim text. Put delivery instructions in `style`, which goes into speech metadata separately. Voice names come from the documented prebuilt list; provider voice IDs are also accepted. `voices` returns a static prebuilt list, not your account's custom voices.

Default model: `gemini-3.8-flash-tts`. Override with `--model`, input `model`, or `GEMINI_TTS_MODEL`, in that order. This CLI uses the Interactions TTS contract; older models using `generateContent` are not interchangeable. No silent model fallback.

## Agent contract

Success prints one JSON object to stdout with `schemaVersion: 1`, `ok: true`, `command: "tts"`, absolute `output`, `bytes`, `mimeType`, `model`, `durationMs`, and provider ID/usage when supplied. Audio is saved as a complete 24 kHz mono WAV, not printed to stdout. Dry runs return `endpoint` and `request`, do not require a key, and do not call the provider.

Errors print `{schemaVersion:1,ok:false,error:{code,message,status?}}` to stderr, leaving stdout empty. Exit codes: 0 success; 2 invalid input/options/configuration or local file errors; 1 API/network/timeout/provider response errors. HTTP response bodies and keys are not echoed. Error codes include `MISSING_API_KEY`, `INVALID_INPUT`, `INVALID_JSON`, `INVALID_OPTIONS`, `CONFIG_ERROR`, `OUTPUT_EXISTS`, `FILE_ERROR`, `API_ERROR`, `NETWORK_ERROR`, `TIMEOUT`, and `INVALID_RESPONSE`.

Generation requires `--out PATH.wav`; the parent directory must already exist. Existing files are protected unless `--force` is given. Timeout defaults to 120000 ms, adjustable with `--timeout-ms` up to 600000. No automatic retries: timeouts and connection failures may occur after billing. Calls use Google's service and may incur charges.

Agent prompt:

> Use `gemini-api schema tts` to discover input. Generate speech with `gemini-api tts --json-input /absolute/job.json --out /absolute/audio.wav`. Inspect exit status and the JSON result. Put speaking directions in `style`. Use `--dry-run` to validate before generation. Do not retry uncertain failures automatically or overwrite files without intent.

## Music (`gemini-api music`)

Same checkout, key and conventions as `tts`, for Lyria music generation via the Interactions REST API.

```sh
gemini-api schema music --pretty
gemini-api music --prompt 'Warm lo-fi beat, instrumental only, about 2 minutes' --out /abs/beat.mp3
gemini-api music --input brief.txt --out /abs/song.mp3
gemini-api music --json-input job.json --out /abs/song.wav
gemini-api music --prompt 'Cinematic theme for this scene' --image scene.png --out /abs/theme.mp3
gemini-api music --prompt 'Upbeat jingle' --dry-run --pretty
```

Job is `{prompt, model?, format?, images?: [paths]}`; `--image` is repeatable (up to 10 jpg/png/webp). The API has no duration, lyrics or instrumental fields: put them in the prompt (e.g. "2-minute song", `[Verse]`/`[Chorus]` lyric tags, "Instrumental only"). Default model `lyria-3.5` (the full-song model, informally "Pro"); `lyria-3-clip-preview` gives 30-second clips. Override with `--model`, input `model`, or `GEMINI_MUSIC_MODEL`.

Output is MP3 by default (44.1 kHz stereo). `--format wav` or a `.wav` `--out` sends `response_format.mime_type: audio/wav`; Google's docs say WAV is possible but do not show the exact value, so treat WAV as unverified until a live call succeeds. `--out` extension must match the format. Success JSON matches `tts` plus `lyrics` (text the model returned alongside the audio, when present). Timeout defaults to 300000 ms. One request, no retries; generation is billed and non-deterministic.

Layout: `src/gemini-api.js` dispatches to `src/commands/{tts,music}.js`; `src/common.js` holds shared input, env, output and error handling; `src/tts.js` and `src/music.js` hold request building and response decoding. A new endpoint is one command module plus one `COMMANDS` entry.

## Development

```sh
npm run check
```

Behavioral tests mock HTTP and exercise CLI subprocesses; they make no paid requests. For a live check after configuring a key, run `gemini-api tts --text 'Hello!' --out /tmp/gemini-tts-smoke.wav` and listen to the result.

To remove the commands, run `npm unlink -g gemini-api-cli`.

## License

[MIT](LICENSE)

API contract and voice list: [Google's speech generation guide](https://ai.google.dev/gemini-api/docs/speech-generation). Implementation follows its non-streaming Interactions REST request and WAV response examples.
