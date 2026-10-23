#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { COMMON_OPTIONS, CliError, VERSION, loadEnv } from './common.js';
import { tts } from './commands/tts.js';
import { music } from './commands/music.js';

const COMMANDS = { tts, music };

const HELP = `gemini-api ${VERSION} — Gemini API media generation

Commands:
  tts       Generate speech (WAV)
  music     Generate music with Lyria (MP3/WAV)
  schema    Print a command's JSON input schema: gemini-api schema tts|music
  voices    Print prebuilt TTS voice names

Run gemini-api COMMAND --help for options and examples.

Credentials: GEMINI_API_KEY (or GOOGLE_API_KEY). Shell variables take
precedence over the checkout .env. Exit 0 success, 2 input/config/file
failure, 1 API/network/provider failure. Errors are JSON on stderr.
No automatic retries: a failed request may already have been billed.
`;

const isWord = (value) => value !== undefined && !value.startsWith('-');

// `legacy` pins the command for the gemini-tts / gemini-music entry points.
export async function main(argv, legacy) {
  const args = [...argv];
  const word = isWord(args[0]) ? args.shift() : undefined;
  let name = word ?? legacy;
  if (word === 'schema') name = legacy ?? (isWord(args[0]) ? args.shift() : undefined);
  if (word === 'voices') name = 'tts';
  if (word && !['schema', 'voices', ...Object.keys(COMMANDS)].includes(word)) throw new CliError('INVALID_OPTIONS', 'Unknown command; run gemini-api --help');
  if (word === 'schema' && !COMMANDS[name]) throw new CliError('INVALID_OPTIONS', 'Supply a schema target: tts or music');
  const command = COMMANDS[name];

  let parsed;
  try { parsed = parseArgs({ args, allowPositionals: true, options: { ...COMMON_OPTIONS, ...command?.options } }); }
  catch { throw new CliError('INVALID_OPTIONS', 'Invalid command options; run gemini-api --help'); }
  const { values: opts, positionals } = parsed;
  const print = (value) => console.log(JSON.stringify(value, null, opts.pretty ? 2 : undefined));

  if (opts.version) return console.log(VERSION);
  if (opts.help || (!word && !args.length)) return console.log(command?.help ?? HELP);
  if (positionals.length || !command) throw new CliError('INVALID_OPTIONS', 'Supply a command: tts or music; run gemini-api --help');
  if (word === 'schema') return print(command.schema);
  if (word === 'voices') return print({ schemaVersion: 1, ok: true, voices: command.voices });
  return command.run(opts, { print, envFile: await loadEnv(opts) });
}

export function run(legacy) {
  main(process.argv.slice(2), legacy).catch((error) => {
    const known = error instanceof CliError;
    console.error(JSON.stringify({ schemaVersion: 1, ok: false, error: {
      code: known ? error.code : 'FILE_ERROR', message: known ? error.message : 'Could not read input or write output', ...(error.status ? { status: error.status } : {}),
    } }));
    process.exitCode = known ? error.exitCode : 2;
  });
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) run();
