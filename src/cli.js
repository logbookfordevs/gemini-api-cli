#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, DEFAULT_MODEL, ENDPOINT, SCHEMA, VOICES, buildRequest, generate } from './tts.js';

const HELP = `gemini-tts 0.1.0 — Gemini API speech generation

Commands:
  tts       Generate a WAV file; stdout contains JSON metadata
  schema    Print the JSON input schema (no key required)
  voices    Print prebuilt voice names (no key required)

Examples:
  gemini-tts tts --text "Hello!" --out hello.wav
  gemini-tts tts --input script.txt --style "Warm Brazilian Portuguese" --out speech.wav
  printf 'Hello!' | gemini-tts tts --out hello.wav
  gemini-tts tts --json-input examples/dialogue.json --out dialogue.wav
  gemini-tts tts --text "Hello!" --dry-run

Options:
  --text TEXT          Verbatim transcript
  --input PATH         UTF-8 transcript file; - reads stdin
  --json-input PATH    JSON job file; - reads stdin
  --out PATH           Required for generation; must end in .wav
  --voice NAME         Default Kore; also accepts provider voice IDs
  --style TEXT         Delivery instructions, separate from transcript
  --model ID           Default ${DEFAULT_MODEL}
  --env-file PATH      Default .env in this CLI's checkout
  --timeout-ms MS      Default 120000; range 1–600000
  --dry-run            Print request without credentials or API call
  --force              Overwrite an existing output file
  --pretty             Indent JSON
  --help, -h           Show help
  --version            Print version

Credentials: GEMINI_API_KEY (or GOOGLE_API_KEY). Shell variables take
precedence over the checkout .env. Exit 0 success, 2 input/config/file
failure, 1 API/network/provider failure. Errors are JSON on stderr.
No automatic retries: a failed request may already have been billed.
`;

async function readInput(path) {
  if (path !== '-') return readFile(resolve(path), 'utf8');
  if (process.stdin.isTTY) throw new CliError('INVALID_INPUT', 'Supply --text, --input, --json-input, or pipe stdin');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new CliError('INVALID_INPUT', 'Input exceeds 1 MiB');
  }
  return input;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: {
      text: { type: 'string' }, input: { type: 'string' }, 'json-input': { type: 'string' }, out: { type: 'string' },
      voice: { type: 'string' }, style: { type: 'string' }, model: { type: 'string' }, 'env-file': { type: 'string' },
      'timeout-ms': { type: 'string' }, 'dry-run': { type: 'boolean' }, force: { type: 'boolean' },
      pretty: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    } });
  } catch { throw new CliError('INVALID_OPTIONS', 'Invalid command options; run gemini-tts --help'); }
  const { values: opts, positionals } = parsed;
  const print = (value) => console.log(JSON.stringify(value, null, opts.pretty ? 2 : undefined));
  if (opts.help || process.argv.length === 2) return console.log(HELP);
  if (opts.version) return console.log('0.1.0');
  const [command] = positionals;
  if (positionals.length !== 1) throw new CliError('INVALID_OPTIONS', 'Supply exactly one command: tts, schema, or voices');
  if (command === 'schema') return print(SCHEMA);
  if (command === 'voices') return print({ schemaVersion: 1, ok: true, voices: VOICES });
  if (command !== 'tts') throw new CliError('INVALID_OPTIONS', 'Unknown command; run gemini-tts --help');

  const root = dirname(dirname(await realpath(fileURLToPath(import.meta.url))));
  const envFile = resolve(opts['env-file'] ?? resolve(root, '.env'));
  try { process.loadEnvFile(envFile); }
  catch (error) { if (opts['env-file'] || error.code !== 'ENOENT') throw new CliError('CONFIG_ERROR', 'Could not load environment file'); }

  const sources = [opts.text, opts.input, opts['json-input']].filter((value) => value !== undefined);
  if (sources.length > 1) throw new CliError('INVALID_INPUT', 'Choose one input source');
  let job;
  const raw = opts.text ?? await readInput(opts['json-input'] ?? opts.input ?? '-');
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new CliError('INVALID_INPUT', 'Input exceeds 1 MiB');
  if (opts['json-input']) {
    try { job = JSON.parse(raw); } catch { throw new CliError('INVALID_JSON', 'Input is not valid JSON'); }
    if (!job || typeof job !== 'object' || Array.isArray(job)) throw new CliError('INVALID_INPUT', 'JSON input must be an object');
  } else job = { text: raw };
  for (const key of ['voice', 'style', 'model']) if (opts[key] !== undefined) job[key] = opts[key];
  job.model ??= process.env.GEMINI_TTS_MODEL ?? DEFAULT_MODEL;
  const request = buildRequest(job);
  const timeout = Number(opts['timeout-ms'] ?? 120000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600000) throw new CliError('INVALID_OPTIONS', 'timeout-ms must be an integer from 1 to 600000');
  if (opts['dry-run']) return print({ schemaVersion: 1, ok: true, command, dryRun: true, endpoint: ENDPOINT, request });
  if (!opts.out || !opts.out.toLowerCase().endsWith('.wav')) throw new CliError('INVALID_OPTIONS', '--out PATH.wav is required');
  const output = resolve(opts.out);
  await access(dirname(output), constants.W_OK);
  if (!opts.force) {
    try { await access(output); throw new CliError('OUTPUT_EXISTS', 'Output exists; choose another path or use --force'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new CliError('MISSING_API_KEY', `Set GEMINI_API_KEY in ${envFile} or your environment`);
  const started = Date.now();
  const result = await generate(request, key, timeout);
  await writeFile(output, result.audio, { flag: opts.force ? 'w' : 'wx' });
  print({ schemaVersion: 1, ok: true, command, output, bytes: result.audio.length, mimeType: 'audio/wav', model: request.model, interactionId: result.id, usage: result.usage, durationMs: Date.now() - started });
}

main().catch((error) => {
  const known = error instanceof CliError;
  console.error(JSON.stringify({ schemaVersion: 1, ok: false, error: {
    code: known ? error.code : 'FILE_ERROR', message: known ? error.message : 'Could not read input or write output', ...(error.status ? { status: error.status } : {}),
  } }));
  process.exitCode = known ? error.exitCode : 2;
});
