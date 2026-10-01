import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequest, decodeAudio, generate, ENDPOINT } from '../src/tts.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const wav = Buffer.alloc(48);
wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
const response = { id: 'test', steps: [{ type: 'model_output', content: [{ type: 'audio', data: wav.toString('base64') }] }] };

function run(args, input) {
  return spawnSync(process.execPath, [cli, ...args, ...(args[0] === 'tts' ? ['--env-file', fileURLToPath(new URL('../.env.example', import.meta.url))] : [])], { cwd: '/private/tmp', input, encoding: 'utf8', env: { PATH: process.env.PATH } });
}

test('style remains metadata instead of being read as transcript', () => {
  const request = buildRequest({ text: 'Olá!', style: 'Warm Portuguese', voice: 'Puck' });
  assert.equal(request.input[0].content[0].text, 'Olá!');
  assert.equal(request.input[0].content[0].annotations[0].style, 'Warm Portuguese');
  assert.equal(request.generation_config.speech_config[0].voice, 'Puck');
});

test('dialogue preserves turn speakers and per-turn style overrides', () => {
  const request = buildRequest({ speakers: [{ name: 'A', voice: 'Kore' }, { name: 'B', voice: 'Puck' }], style: 'Calm', turns: [{ speaker: 'A', text: 'Hi' }, { speaker: 'B', text: 'Hello', style: 'Excited' }] });
  assert.deepEqual(request.input[0].content.map((part) => part.annotations[0]), [
    { type: 'speech_metadata', speaker: 'A', style: 'Calm' }, { type: 'speech_metadata', speaker: 'B', style: 'Excited' },
  ]);
  assert.throws(() => buildRequest({ speakers: [{ name: 'A', voice: 'Kore' }, { name: 'B', voice: 'Puck' }], turns: [{ speaker: 'C', text: 'Hi' }] }), /configured speaker/);
});

test('malformed and ambiguous jobs fail before a request', () => {
  for (const job of [null, [], {}, { text: '' }, { text: 'Hi', typo: true }, { text: 'Hi', style: 12 }, { text: 'Hi', turns: [] }]) {
    assert.throws(() => buildRequest(job));
  }
});

test('decodes WAV and rejects missing, malformed or raw PCM responses', () => {
  assert.deepEqual(decodeAudio(response), wav);
  for (const data of [{}, { steps: [{ type: 'model_output', content: [{ type: 'audio', data: '!!!!' }] }] }, { steps: [{ type: 'model_output', content: [{ type: 'audio', data: Buffer.alloc(48).toString('base64') }] }] }]) {
    assert.throws(() => decodeAudio(data), (error) => error.code === 'INVALID_RESPONSE');
  }
});

test('REST call authenticates in headers and returns audio metadata', async () => {
  const request = buildRequest({ text: 'Hello' });
  const result = await generate(request, 'secret', 1000, async (url, options) => {
    assert.equal(url, ENDPOINT);
    assert.equal(options.headers['x-goog-api-key'], 'secret');
    assert.deepEqual(JSON.parse(options.body), request);
    return new Response(JSON.stringify(response));
  });
  assert.deepEqual(result.audio, wav);
  assert.equal(result.id, 'test');
});

test('HTTP errors and timeouts are structured, sanitized, and not retried', async () => {
  let calls = 0;
  await assert.rejects(generate({}, 'secret', 1000, async () => { calls++; return new Response('secret provider body', { status: 429 }); }), (error) => error.code === 'API_ERROR' && error.status === 429 && !error.message.includes('secret'));
  assert.equal(calls, 1);
  await assert.rejects(generate({}, 'secret', 1, async () => { throw new DOMException('secret', 'TimeoutError'); }), (error) => error.code === 'TIMEOUT');
});

test('CLI schema and stdin dry run work from another directory without a key', () => {
  const schema = run(['schema']);
  assert.equal(schema.status, 0);
  assert.equal(JSON.parse(schema.stdout).title, 'Gemini TTS input');
  const dry = run(['tts', '--dry-run'], 'Olá!');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).request.input[0].content[0].text, 'Olá!');
});

test('CLI rejects conflicts, missing keys, invalid JSON and unknown flags with clean stdout', () => {
  for (const args of [
    ['tts', '--text', 'Hi', '--input', '-'],
    ['tts', '--text', 'Hi', '--out', '/private/tmp/gemini-tts-missing-key-test.wav'],
    ['tts', '--json-input', '-', '--dry-run'],
    ['tts', '--unknown'],
  ]) {
    const result = run(args, '{broken');
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).ok, false);
  }
});


test('CLI writes provider WAV, reports absolute path, loads selected env and protects existing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-tts-test-'));
  try {
    const output = join(dir, 'speech.wav');
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'GEMINI_API_KEY=test-only-key\n');
    const mock = `globalThis.fetch = async (url, options) => {
      if (options.headers['x-goog-api-key'] !== 'test-only-key') throw new Error('Missing test key');
      return new Response(${JSON.stringify(JSON.stringify(response))});
    };`;
    const args = ['--import', 'data:text/javascript,' + encodeURIComponent(mock), cli, 'tts', '--text', 'Hello', '--out', output, '--env-file', envFile];
    const options = { cwd: '/private/tmp', encoding: 'utf8', env: { PATH: process.env.PATH } };
    const result = spawnSync(process.execPath, args, options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).output, output);
    assert.deepEqual(readFileSync(output), wav);
    const duplicate = spawnSync(process.execPath, args, options);
    assert.equal(duplicate.status, 2);
    assert.equal(JSON.parse(duplicate.stderr).error.code, 'OUTPUT_EXISTS');
    assert.deepEqual(readFileSync(output), wav);
    const overwrite = spawnSync(process.execPath, [...args, '--force'], options);
    assert.equal(overwrite.status, 0, overwrite.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
