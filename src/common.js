import { readFile, access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.2.0';
export const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MAX_INPUT_BYTES = 1024 * 1024;

export class CliError extends Error {
  constructor(code, message, exitCode = 2, status) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.status = status;
  }
}

export const COMMON_OPTIONS = {
  'env-file': { type: 'string' }, 'timeout-ms': { type: 'string' }, 'dry-run': { type: 'boolean' },
  force: { type: 'boolean' }, pretty: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
};

export async function readInput(path, sources) {
  if (path !== '-') return readFile(resolve(path), 'utf8');
  if (process.stdin.isTTY) throw new CliError('INVALID_INPUT', `Supply ${sources}, or pipe stdin`);
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new CliError('INVALID_INPUT', 'Input exceeds 1 MiB');
  }
  return input;
}

export async function loadEnv(opts) {
  const root = dirname(dirname(await realpath(fileURLToPath(import.meta.url))));
  const envFile = resolve(opts['env-file'] ?? resolve(root, '.env'));
  try { process.loadEnvFile(envFile); }
  catch (error) { if (opts['env-file'] || error.code !== 'ENOENT') throw new CliError('CONFIG_ERROR', 'Could not load environment file'); }
  return envFile;
}

export async function readJob(opts, field) {
  const sources = [opts[field], opts.input, opts['json-input']].filter((value) => value !== undefined);
  if (sources.length > 1) throw new CliError('INVALID_INPUT', 'Choose one input source');
  const raw = opts[field] ?? await readInput(opts['json-input'] ?? opts.input ?? '-', `--${field}, --input, --json-input`);
  if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) throw new CliError('INVALID_INPUT', 'Input exceeds 1 MiB');
  if (!opts['json-input']) return { [field]: raw };
  let job;
  try { job = JSON.parse(raw); } catch { throw new CliError('INVALID_JSON', 'Input is not valid JSON'); }
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new CliError('INVALID_INPUT', 'JSON input must be an object');
  return job;
}

export function timeoutMs(opts, fallback) {
  const timeout = Number(opts['timeout-ms'] ?? fallback);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600000) throw new CliError('INVALID_OPTIONS', 'timeout-ms must be an integer from 1 to 600000');
  return timeout;
}

export async function claimOutput(out, force) {
  const output = resolve(out);
  await access(dirname(output), constants.W_OK);
  if (!force) {
    try { await access(output); throw new CliError('OUTPUT_EXISTS', 'Output exists; choose another path or use --force'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return output;
}

export function apiKey(envFile) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new CliError('MISSING_API_KEY', `Set GEMINI_API_KEY in ${envFile} or your environment`);
  return key;
}
