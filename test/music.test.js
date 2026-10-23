import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequest, decodeMusic, generate } from '../src/music.js';
import { ENDPOINT } from '../src/tts.js';

const cli = fileURLToPath(new URL('../src/music-cli.js', import.meta.url));
const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64)]);
const wav = Buffer.alloc(48);
wav.write('RIFF'); wav.write('WAVE', 8);
const reply = (audio, extra = []) => ({ id: 'test', steps: [{ type: 'model_output', content: [...extra, { type: 'audio', data: audio.toString('base64') }] }] });

test('prompt stays text and wav is requested through response_format', () => {
  assert.deepEqual(buildRequest({ prompt: 'Lo-fi beat' }), {
    model: 'lyria-3.5', input: [{ type: 'text', text: 'Lo-fi beat' }], response_format: { type: 'audio' },
  });
  const request = buildRequest({ prompt: 'Theme', format: 'wav' }, [{ mimeType: 'image/png', data: 'AAAA' }]);
  assert.deepEqual(request.response_format, { type: 'audio', mime_type: 'audio/wav' });
  assert.deepEqual(request.input[1], { type: 'image', mime_type: 'image/png', data: 'AAAA' });
});

test('malformed jobs fail before a request', () => {
  const image = { mimeType: 'image/png', data: 'AAAA' };
  for (const job of [null, [], {}, { prompt: ' ' }, { prompt: 'x', typo: 1 }, { prompt: 'x', format: 'ogg' }]) {
    assert.throws(() => buildRequest(job));
  }
  assert.throws(() => buildRequest({ prompt: 'x' }, Array(11).fill(image)), /At most 10/);
});

test('decodes audio and lyrics, rejecting missing, malformed or wrong-format responses', () => {
  const decoded = decodeMusic(reply(mp3, [{ type: 'text', text: '[Verse] hi' }]));
  assert.deepEqual(decoded.audio, mp3);
  assert.equal(decoded.lyrics, '[Verse] hi');
  assert.deepEqual(decodeMusic(reply(wav), 'wav').audio, wav);
  for (const [data, format] of [[{}, 'mp3'], [{ steps: [{ type: 'model_output', content: [{ type: 'audio', data: '!!!!' }] }] }, 'mp3'], [reply(wav), 'mp3'], [reply(mp3), 'wav']]) {
    assert.throws(() => decodeMusic(data, format), (error) => error.code === 'INVALID_RESPONSE');
  }
});

test('REST call authenticates in headers, is not retried and sanitizes errors', async () => {
  const request = buildRequest({ prompt: 'Hello' });
  const result = await generate(request, 'mp3', 'secret', 1000, async (url, options) => {
    assert.equal(url, ENDPOINT);
    assert.equal(options.headers['x-goog-api-key'], 'secret');
    assert.deepEqual(JSON.parse(options.body), request);
    return new Response(JSON.stringify(reply(mp3)));
  });
  assert.deepEqual(result.audio, mp3);
  let calls = 0;
  await assert.rejects(generate(request, 'mp3', 'secret', 1000, async () => { calls++; return new Response('secret body', { status: 429 }); }), (error) => error.code === 'API_ERROR' && error.status === 429 && !error.message.includes('secret'));
  assert.equal(calls, 1);
});

test('CLI dry run works without a key, infers format from --out and elides image bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-music-test-'));
  try {
    const image = join(dir, 'scene.png');
    writeFileSync(image, Buffer.from('png-bytes'));
    const ok = spawnSync(process.execPath, [cli, 'music', '--prompt', 'Theme', '--image', image, '--out', join(dir, 'a.wav'), '--dry-run'], { cwd: '/private/tmp', encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(ok.status, 0, ok.stderr);
    const { request } = JSON.parse(ok.stdout);
    assert.deepEqual(request.response_format, { type: 'audio', mime_type: 'audio/wav' });
    assert.equal(request.input[1].data, '<9 bytes>');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI rejects mismatched output extension, conflicts and unknown flags with clean stdout', () => {
  for (const args of [
    ['music', '--prompt', 'Hi', '--format', 'wav', '--out', '/private/tmp/gemini-music-mismatch.mp3'],
    ['music', '--prompt', 'Hi', '--input', '-'],
    ['music', '--prompt', 'Hi', '--image', '/private/tmp/x.gif', '--dry-run'],
    ['music', '--unknown'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: '/private/tmp', encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).ok, false);
  }
});

test('CLI writes provider MP3 with lyrics, selected env, and protects existing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-music-test-'));
  try {
    const output = join(dir, 'song.mp3');
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'GEMINI_API_KEY=test-only-key\n');
    const body = JSON.stringify(reply(mp3, [{ type: 'text', text: 'la la' }]));
    const mock = `globalThis.fetch = async (url, options) => {
      if (options.headers['x-goog-api-key'] !== 'test-only-key') throw new Error('Missing test key');
      return new Response(${JSON.stringify(body)});
    };`;
    const args = ['--import', 'data:text/javascript,' + encodeURIComponent(mock), cli, 'music', '--prompt', 'Hello', '--out', output, '--env-file', envFile];
    const options = { cwd: '/private/tmp', encoding: 'utf8', env: { PATH: process.env.PATH } };
    const result = spawnSync(process.execPath, args, options);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.output, output);
    assert.equal(summary.lyrics, 'la la');
    assert.deepEqual(readFileSync(output), mp3);
    const duplicate = spawnSync(process.execPath, args, options);
    assert.equal(duplicate.status, 2);
    assert.equal(JSON.parse(duplicate.stderr).error.code, 'OUTPUT_EXISTS');
    assert.equal(spawnSync(process.execPath, [...args, '--force'], options).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gemini-api dispatches tts and music, schemas and voices, and rejects unknown commands', () => {
  const entry = fileURLToPath(new URL('../src/gemini-api.js', import.meta.url));
  const call = (...args) => spawnSync(process.execPath, [entry, ...args], { cwd: '/private/tmp', encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.match(call().stdout, /Commands:/);
  assert.match(call('music', '--help').stdout, /gemini-api music/);
  assert.equal(JSON.parse(call('schema', 'music').stdout).title, 'Gemini music input');
  assert.equal(JSON.parse(call('schema', 'tts').stdout).title, 'Gemini TTS input');
  assert.ok(JSON.parse(call('voices').stdout).voices.includes('Kore'));
  assert.equal(JSON.parse(call('tts', '--text', 'Hi', '--dry-run').stdout).command, 'tts');
  assert.equal(JSON.parse(call('music', '--prompt', 'Hi', '--dry-run').stdout).command, 'music');
  for (const args of [['bogus'], ['schema'], ['schema', 'nope'], ['--text', 'Hi'], ['music', '--voice', 'Kore'], ['tts', '--prompt', 'Hi'], ['tts', '--text', 'Hi', 'extra']]) {
    const result = call(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).ok, false);
  }
});
