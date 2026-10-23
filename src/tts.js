import { CliError, ENDPOINT } from './common.js';

export { CliError, ENDPOINT } from './common.js';
export const DEFAULT_MODEL = 'gemini-3.8-flash-tts';
export const VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new CliError('INVALID_INPUT', `${name} must be a nonempty string`);
  return value;
}

function fields(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('INVALID_INPUT', `${name} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new CliError('INVALID_INPUT', `Unknown ${name} field: ${key}`);
  }
}

export function buildRequest(job) {
  fields(job, ['text', 'voice', 'style', 'model', 'speakers', 'turns'], 'input');
  const model = text(job.model ?? DEFAULT_MODEL, 'model');
  if (job.style !== undefined) text(job.style, 'style');
  let content;
  let speechConfig;

  if (job.speakers !== undefined || job.turns !== undefined) {
    if (job.text !== undefined || job.voice !== undefined) throw new CliError('INVALID_INPUT', 'Dialogue uses speakers and turns instead of text and voice');
    if (!Array.isArray(job.speakers) || job.speakers.length !== 2) throw new CliError('INVALID_INPUT', 'Dialogue requires exactly two speakers');
    const speakers = job.speakers.map((speaker) => {
      fields(speaker, ['name', 'voice'], 'speaker');
      return { speaker: text(speaker.name, 'speaker.name'), voice: text(speaker.voice, 'speaker.voice') };
    });
    const names = new Set(speakers.map((speaker) => speaker.speaker));
    if (names.size !== speakers.length) throw new CliError('INVALID_INPUT', 'Speaker names must be unique');
    if (!Array.isArray(job.turns) || !job.turns.length) throw new CliError('INVALID_INPUT', 'turns must be a nonempty array');
    content = job.turns.map((turn) => {
      fields(turn, ['speaker', 'text', 'style'], 'turn');
      if (!names.has(turn.speaker)) throw new CliError('INVALID_INPUT', 'Each turn must reference a configured speaker');
      const annotation = { type: 'speech_metadata', speaker: turn.speaker };
      if (turn.style !== undefined || job.style !== undefined) annotation.style = text(turn.style ?? job.style, 'turn.style');
      return { type: 'text', text: text(turn.text, 'turn.text'), annotations: [annotation] };
    });
    speechConfig = { mode: 'conversational', speakers };
  } else {
    const annotation = { type: 'speech_metadata' };
    if (job.style !== undefined) annotation.style = job.style;
    content = [{ type: 'text', text: text(job.text, 'text'), annotations: [annotation] }];
    speechConfig = [{ voice: text(job.voice ?? 'Kore', 'voice') }];
  }

  // REST contract: https://ai.google.dev/gemini-api/docs/speech-generation
  return {
    model,
    input: [{ type: 'user_input', content }],
    response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: 24000 },
    generation_config: { speech_config: speechConfig },
  };
}

export function decodeAudio(response) {
  const parts = (response.steps ?? []).filter((step) => step.type === 'model_output').flatMap((step) => step.content ?? []);
  const part = parts.filter((item) => item.type === 'audio').at(-1);
  if (!part || typeof part.data !== 'string' || !part.data.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data) || part.data.length % 4 !== 0) {
    throw new CliError('INVALID_RESPONSE', 'Provider returned no valid base64 audio', 1);
  }
  const audio = Buffer.from(part.data, 'base64');
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new CliError('INVALID_RESPONSE', 'Provider did not return the requested WAV audio', 1);
  }
  return audio;
}

export async function generate(request, key, timeoutMs, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new CliError('API_ERROR', `Gemini API returned HTTP ${response.status}`, 1, response.status);
    const data = await response.json();
    return { audio: decodeAudio(data), id: data.id, usage: data.usage };
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
  title: 'Gemini TTS input',
  type: 'object', additionalProperties: false,
  properties: {
    text: nonempty, voice: nonempty, style: nonempty, model: nonempty,
    speakers: { type: 'array', minItems: 2, maxItems: 2, items: {
      type: 'object', additionalProperties: false, required: ['name', 'voice'], properties: { name: nonempty, voice: nonempty },
    } },
    turns: { type: 'array', minItems: 1, items: {
      type: 'object', additionalProperties: false, required: ['speaker', 'text'], properties: { speaker: nonempty, text: nonempty, style: nonempty },
    } },
  },
  oneOf: [
    { required: ['text'], not: { anyOf: [{ required: ['speakers'] }, { required: ['turns'] }] } },
    { required: ['speakers', 'turns'], not: { anyOf: [{ required: ['text'] }, { required: ['voice'] }] } },
  ],
};
