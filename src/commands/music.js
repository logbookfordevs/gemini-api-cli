import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { CliError, ENDPOINT, apiKey, claimOutput, readJob, timeoutMs } from '../common.js';
import { DEFAULT_MODEL, FORMATS, IMAGE_TYPES, SCHEMA, buildRequest, generate } from '../music.js';

const help = `gemini-api music — Gemini API music generation (Lyria)

Usage:
  gemini-api music [options]
  gemini-api schema music    Print the JSON input schema (no key required)

Examples:
  gemini-api music --prompt "Warm lo-fi beat, instrumental only" --out beat.mp3
  gemini-api music --input brief.txt --out song.mp3
  gemini-api music --json-input job.json --out song.wav
  gemini-api music --prompt "Cinematic theme for this scene" --image scene.png --out theme.mp3
  gemini-api music --prompt "Upbeat jingle" --dry-run

Options:
  --prompt TEXT        Music brief: genre, mood, duration, lyrics with [Verse]/[Chorus] tags
  --input PATH         UTF-8 prompt file; - reads stdin
  --json-input PATH    JSON job file; - reads stdin
  --image PATH         Reference image (jpg/png/webp); repeat up to 10 times
  --out PATH           Required for generation; must end in .mp3 or .wav
  --format mp3|wav     Default mp3 (inferred from --out when omitted)
  --model ID           Default ${DEFAULT_MODEL} (or GEMINI_MUSIC_MODEL)
  --env-file PATH      Default .env in this CLI's checkout
  --timeout-ms MS      Default 300000; range 1–600000
  --dry-run            Print request without credentials or API call
  --force              Overwrite an existing output file
  --pretty             Indent JSON
`;

async function loadImage(path) {
  const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new CliError('INVALID_INPUT', 'Images must be .jpg, .jpeg, .png or .webp');
  return { mimeType, data: (await readFile(resolve(path))).toString('base64') };
}

export const music = {
  name: 'music',
  help,
  schema: SCHEMA,
  options: {
    prompt: { type: 'string' }, input: { type: 'string' }, 'json-input': { type: 'string' }, image: { type: 'string', multiple: true },
    out: { type: 'string' }, format: { type: 'string' }, model: { type: 'string' },
  },

  async run(opts, { print, envFile }) {
    const job = await readJob(opts, 'prompt');
    for (const key of ['model', 'format']) if (opts[key] !== undefined) job[key] = opts[key];
    if (opts.image) job.images = opts.image;
    const outExtension = opts.out ? extname(opts.out).toLowerCase().slice(1) : undefined;
    if (job.format === undefined && outExtension in FORMATS) job.format = outExtension;
    job.model ??= process.env.GEMINI_MUSIC_MODEL ?? DEFAULT_MODEL;

    const { images: paths = [], ...fields } = job;
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string' || !path.trim())) throw new CliError('INVALID_INPUT', 'images must be an array of file paths');
    const request = buildRequest(fields, await Promise.all(paths.map(loadImage)));
    const format = job.format ?? 'mp3';
    const timeout = timeoutMs(opts, 300000);

    if (opts['dry-run']) {
      const shown = { ...request, input: request.input.map((part) => (part.type === 'image' ? { ...part, data: `<${Buffer.byteLength(part.data, 'base64')} bytes>` } : part)) };
      return print({ schemaVersion: 1, ok: true, command: 'music', dryRun: true, endpoint: ENDPOINT, request: shown });
    }
    if (!opts.out || outExtension !== format) throw new CliError('INVALID_OPTIONS', `--out PATH.${format} is required and must match the format`);
    const output = await claimOutput(opts.out, opts.force);
    const key = apiKey(envFile);
    const started = Date.now();
    const result = await generate(request, format, key, timeout);
    await writeFile(output, result.audio, { flag: opts.force ? 'w' : 'wx' });
    print({ schemaVersion: 1, ok: true, command: 'music', output, bytes: result.audio.length, mimeType: FORMATS[format], model: request.model, lyrics: result.lyrics, interactionId: result.id, usage: result.usage, durationMs: Date.now() - started });
  },
};
