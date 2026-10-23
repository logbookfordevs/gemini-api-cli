import { writeFile } from 'node:fs/promises';
import { CliError, ENDPOINT, apiKey, claimOutput, readJob, timeoutMs } from '../common.js';
import { DEFAULT_MODEL, SCHEMA, VOICES, buildRequest, generate } from '../tts.js';

const help = `gemini-api tts — Gemini API speech generation

Usage:
  gemini-api tts [options]
  gemini-api schema tts      Print the JSON input schema (no key required)
  gemini-api voices          Print prebuilt voice names (no key required)

Examples:
  gemini-api tts --text "Hello!" --out hello.wav
  gemini-api tts --input script.txt --style "Warm Brazilian Portuguese" --out speech.wav
  printf 'Hello!' | gemini-api tts --out hello.wav
  gemini-api tts --json-input examples/dialogue.json --out dialogue.wav
  gemini-api tts --text "Hello!" --dry-run

Options:
  --text TEXT          Verbatim transcript
  --input PATH         UTF-8 transcript file; - reads stdin
  --json-input PATH    JSON job file; - reads stdin
  --out PATH           Required for generation; must end in .wav
  --voice NAME         Default Kore; also accepts provider voice IDs
  --style TEXT         Delivery instructions, separate from transcript
  --model ID           Default ${DEFAULT_MODEL} (or GEMINI_TTS_MODEL)
  --env-file PATH      Default .env in this CLI's checkout
  --timeout-ms MS      Default 120000; range 1–600000
  --dry-run            Print request without credentials or API call
  --force              Overwrite an existing output file
  --pretty             Indent JSON
`;

export const tts = {
  name: 'tts',
  help,
  schema: SCHEMA,
  voices: VOICES,
  options: {
    text: { type: 'string' }, input: { type: 'string' }, 'json-input': { type: 'string' }, out: { type: 'string' },
    voice: { type: 'string' }, style: { type: 'string' }, model: { type: 'string' },
  },

  async run(opts, { print, envFile }) {
    const job = await readJob(opts, 'text');
    for (const key of ['voice', 'style', 'model']) if (opts[key] !== undefined) job[key] = opts[key];
    job.model ??= process.env.GEMINI_TTS_MODEL ?? DEFAULT_MODEL;
    const request = buildRequest(job);
    const timeout = timeoutMs(opts, 120000);
    if (opts['dry-run']) return print({ schemaVersion: 1, ok: true, command: 'tts', dryRun: true, endpoint: ENDPOINT, request });
    if (!opts.out || !opts.out.toLowerCase().endsWith('.wav')) throw new CliError('INVALID_OPTIONS', '--out PATH.wav is required');
    const output = await claimOutput(opts.out, opts.force);
    const key = apiKey(envFile);
    const started = Date.now();
    const result = await generate(request, key, timeout);
    await writeFile(output, result.audio, { flag: opts.force ? 'w' : 'wx' });
    print({ schemaVersion: 1, ok: true, command: 'tts', output, bytes: result.audio.length, mimeType: 'audio/wav', model: request.model, interactionId: result.id, usage: result.usage, durationMs: Date.now() - started });
  },
};
