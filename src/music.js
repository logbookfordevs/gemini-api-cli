import { CliError, ENDPOINT } from './common.js';

export const DEFAULT_MODEL = 'lyria-3.5';
export const FORMATS = { mp3: 'audio/mpeg', wav: 'audio/wav' };
export const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const MAX_IMAGES = 10;

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new CliError('INVALID_INPUT', `${name} must be a nonempty string`);
  return value;
}

export function buildRequest(job, images = []) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new CliError('INVALID_INPUT', 'input must be an object');
  for (const key of Object.keys(job)) {
    if (!['prompt', 'model', 'format', 'images'].includes(key)) throw new CliError('INVALID_INPUT', `Unknown input field: ${key}`);
  }
  const format = job.format ?? 'mp3';
  if (!(format in FORMATS)) throw new CliError('INVALID_INPUT', 'format must be mp3 or wav');
  if (images.length > MAX_IMAGES) throw new CliError('INVALID_INPUT', `At most ${MAX_IMAGES} images are allowed`);

  // REST contract: https://ai.google.dev/gemini-api/docs/interactions/music-generation
  return {
    model: text(job.model ?? DEFAULT_MODEL, 'model'),
    input: [{ type: 'text', text: text(job.prompt, 'prompt') }, ...images.map(({ mimeType, data }) => ({ type: 'image', mime_type: mimeType, data }))],
    response_format: format === 'wav' ? { type: 'audio', mime_type: FORMATS.wav } : { type: 'audio' },
  };
}

function matchesFormat(audio, format) {
  if (format === 'wav') return audio.length >= 44 && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE';
  return audio.length >= 4 && (audio.toString('ascii', 0, 3) === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0));
}

export function decodeMusic(response, format = 'mp3') {
  const parts = (response.steps ?? []).filter((step) => step.type === 'model_output').flatMap((step) => step.content ?? []);
  const part = parts.filter((item) => item.type === 'audio').at(-1);
  if (!part || typeof part.data !== 'string' || !part.data.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data) || part.data.length % 4 !== 0) {
    throw new CliError('INVALID_RESPONSE', 'Provider returned no valid base64 audio', 1);
  }
  const audio = Buffer.from(part.data, 'base64');
  if (!matchesFormat(audio, format)) throw new CliError('INVALID_RESPONSE', `Provider did not return the requested ${format.toUpperCase()} audio`, 1);
  const lyrics = parts.filter((item) => item.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n') || undefined;
  return { audio, lyrics };
}

export async function generate(request, format, key, timeoutMs, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new CliError('API_ERROR', `Gemini API returned HTTP ${response.status}`, 1, response.status);
    const data = await response.json();
    return { ...decodeMusic(data, format), id: data.id, usage: data.usage };
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new CliError('TIMEOUT', 'Gemini request timed out; it may already have been billed', 1);
    if (error instanceof SyntaxError) throw new CliError('INVALID_RESPONSE', 'Provider returned invalid JSON', 1);
    throw new CliError('NETWORK_ERROR', 'Could not complete the Gemini request; it may already have been billed', 1);
  }
}

const nonempty = { type: 'string', minLength: 1, pattern: '\\S' };
export const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Gemini music input',
  type: 'object', additionalProperties: false, required: ['prompt'],
  properties: {
    prompt: nonempty,
    model: nonempty,
    format: { enum: Object.keys(FORMATS), default: 'mp3' },
    images: { type: 'array', maxItems: MAX_IMAGES, items: nonempty },
  },
};
