'use strict';

// Upstream provider calls. All outbound traffic happens here so that API keys
// never leave the server process and every request has a hard timeout.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// OpenCode Go routes requests by session and expects a self-identifying client
// rather than a generic HTTP library. Without these headers it rejects traffic
// with "Request is missing x-opencode-session".
const USER_AGENT = 'AI-Voice-Desk/1.0';
const FALLBACK_SESSION_ID = deriveSessionId('default');

function isOpenCodeGo(baseUrl, provider) {
  const name = String(provider || '').toLowerCase().replace(/\s+/g, '');
  if (name.includes('opencode')) return true;
  try {
    const host = new URL(String(baseUrl)).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch (_) {
    return false;
  }
}

/** Deterministic, stable session id derived from a seed (e.g. conversation id). */
function deriveSessionId(seed) {
  return crypto.createHash('sha256').update('ai-voice-desk:' + String(seed)).digest('hex').slice(0, 32);
}

function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new ProviderError('Endpoint URL is not configured.', 400);
  const clean = suffix.replace(/^\/+/, '');
  if (base.toLowerCase().endsWith('/' + clean.toLowerCase())) return base;
  return `${base}/${clean}`;
}

class ProviderError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

function authHeaders(apiKey, extra = {}, route = {}) {
  const headers = { ...extra };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (isOpenCodeGo(route.baseUrl, route.provider)) {
    headers['User-Agent'] = USER_AGENT;
    headers['x-opencode-session'] = route.sessionId || FALLBACK_SESSION_ID;
  }
  return headers;
}

function combinedSignal(timeoutMs, externalSignal) {
  const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 120000));
  if (externalSignal) return AbortSignal.any([timeout, externalSignal]);
  return timeout;
}

async function readError(res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = json.error?.message || json.error || json.message || '';
    } catch (_) {
      detail = text;
    }
  } catch (_) { /* ignore */ }
  detail = String(detail).replace(/\s+/g, ' ').slice(0, 300);
  if (res.status === 401 || res.status === 403) {
    return new ProviderError(`Authentication failed (${res.status}). Check the API key.`, 401);
  }
  if (res.status === 404) {
    return new ProviderError(`Endpoint not found (404). Check the base URL.`, 404);
  }
  if (res.status === 429) {
    return new ProviderError(`Rate limited by provider (429).${detail ? ' ' + detail : ''}`, 429);
  }
  return new ProviderError(`Provider error ${res.status}${detail ? ': ' + detail : ''}`, 502);
}

/**
 * Stream a chat completion. Calls onDelta(text) for each token chunk.
 * Returns { content, usage }.
 */
async function chatStream(opts) {
  const {
    baseUrl, apiKey, model, messages, timeoutMs, signal,
    temperature, maxTokens, onDelta, provider, sessionId
  } = opts;

  const url = joinUrl(baseUrl, 'chat/completions');
  const body = {
    model,
    messages,
    stream: true
  };
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(apiKey, { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, { baseUrl, provider, sessionId }),
    body: JSON.stringify(body),
    signal: combinedSignal(timeoutMs, signal)
  }).catch((err) => {
    if (err.name === 'AbortError') throw err;
    throw new ProviderError(`Could not reach the AI endpoint: ${err.message}`, 502);
  });

  if (!res.ok) throw await readError(res);
  if (!res.body) throw new ProviderError('The AI endpoint returned an empty response.', 502);

  const contentType = res.headers.get('content-type') || '';

  // Some OpenAI-compatible servers ignore `stream` and return plain JSON.
  if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content || '';
    if (onDelta && content) onDelta(content);
    return { content, usage: json.usage || null };
  }

  let content = '';
  let usage = null;
  let buffer = '';

  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch (_) { continue; }
      if (parsed.usage) usage = parsed.usage;
      const choice = parsed.choices && parsed.choices[0];
      if (!choice) continue;
      const delta = choice.delta || choice.message || {};
      const piece = delta.content;
      if (typeof piece === 'string' && piece.length) {
        content += piece;
        if (onDelta) onDelta(piece);
      }
    }
  }
  return { content, usage };
}

/** Non-streaming single request used for connection tests. */
async function chatOnce(opts) {
  const { baseUrl, apiKey, model, messages, timeoutMs, signal, provider, sessionId } = opts;
  const url = joinUrl(baseUrl, 'chat/completions');
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(apiKey, { 'Content-Type': 'application/json' }, { baseUrl, provider, sessionId }),
    body: JSON.stringify({ model, messages, stream: false, max_tokens: 16 }),
    signal: combinedSignal(timeoutMs, signal)
  }).catch((err) => {
    if (err.name === 'AbortError') throw err;
    throw new ProviderError(`Could not reach the AI endpoint: ${err.message}`, 502);
  });
  if (!res.ok) throw await readError(res);
  const json = await res.json();
  return {
    content: json.choices?.[0]?.message?.content || '',
    model: json.model || model
  };
}

/** Speech-to-text. Supports OpenAI-compatible and whisper.cpp server styles. */
async function transcribe(opts) {
  const { baseUrl, apiKey, model, buffer, mime, filename, timeoutMs, signal, language, provider, sessionId, apiStyle } = opts;
  const style = String(apiStyle || 'openai').toLowerCase();
  const whisperCpp = style === 'whisper.cpp' || style === 'whispercpp';
  const url = joinUrl(baseUrl, whisperCpp ? 'inference' : 'audio/transcriptions');
  const boundary = '----AVD' + crypto.randomBytes(16).toString('hex');

  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, 'utf8'));
  const field = (name, value) => {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    push(`${value}\r\n`);
  };

  if (whisperCpp) {
    if (model) field('model', model);
    field('temperature', '0.0');
    field('temperature_inc', '0.2');
    field('no_speech_thold', '0.6');
    field('response_format', 'json');
  } else {
    field('model', model);
    if (language) field('language', language);
  }

  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="file"; filename="${filename || 'audio.webm'}"\r\n`);
  push(`Content-Type: ${mime || 'audio/webm'}\r\n\r\n`);
  parts.push(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  push(`\r\n--${boundary}--\r\n`);

  const body = Buffer.concat(parts);

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(apiKey, {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length)
    }, { baseUrl, provider, sessionId }),
    body,
    signal: combinedSignal(timeoutMs, signal)
  }).catch((err) => {
    if (err.name === 'AbortError') throw err;
    throw new ProviderError(`Could not reach the transcription endpoint: ${err.message}`, 502);
  });

  if (!res.ok) throw await readError(res);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await res.json();
    return String(json.text || '').trim();
  }
  return (await res.text()).trim();
}

/** Text-to-speech via an OpenAI-compatible /audio/speech endpoint. */
async function synthesize(opts) {
  const { baseUrl, apiKey, model, voice, text, format = 'mp3', speed, timeoutMs, signal, provider, sessionId } = opts;
  const url = joinUrl(baseUrl, 'audio/speech');
  const payload = {
    model,
    input: text,
    voice: voice || 'alloy',
    response_format: format
  };
  if (Number.isFinite(speed)) payload.speed = speed;

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(apiKey, { 'Content-Type': 'application/json' }, { baseUrl, provider, sessionId }),
    body: JSON.stringify(payload),
    signal: combinedSignal(timeoutMs, signal)
  }).catch((err) => {
    if (err.name === 'AbortError') throw err;
    throw new ProviderError(`Could not reach the speech endpoint: ${err.message}`, 502);
  });

  if (!res.ok) throw await readError(res);
  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: res.headers.get('content-type') || 'audio/mpeg'
  };
}

/** Text-to-speech using a local Piper binary (https://github.com/rhasspy/piper). */
function synthesizePiper(opts) {
  const { piperPath, voice, text, speaker, rate, timeoutMs, signal } = opts;
  return new Promise((resolve, reject) => {
    if (!piperPath) return reject(new ProviderError('Piper executable path is not configured.', 400));
    if (!voice) return reject(new ProviderError('Piper voice model is not configured.', 400));

    const outFile = path.join(os.tmpdir(), `avd-piper-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`);
    const args = ['--model', voice, '--output_file', outFile];
    if (Number.isFinite(speaker)) args.push('--speaker', String(speaker));
    if (Number.isFinite(rate) && rate > 0) args.push('--length-scale', String(1 / rate));

    let child;
    try {
      child = spawn(piperPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      return reject(new ProviderError(`Could not start Piper: ${err.message}`, 502));
    }

    let settled = false;
    let timer = null;
    let stderr = '';
    const cleanup = () => { try { fs.rmSync(outFile, { force: true }); } catch (_) { /* ignore */ } };
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      cleanup();
      if (err) reject(err); else resolve(value);
    };
    function onAbort() {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      finish(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    }

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      finish(new ProviderError('Piper timed out.', 504));
    }, Math.max(1000, Number(timeoutMs) || 60000));

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdin.on('error', () => { /* ignore EPIPE if piper exits early */ });
    child.on('error', (err) => finish(new ProviderError(`Could not start Piper: ${err.message}`, 502)));
    child.on('close', (code) => {
      if (code !== 0) {
        return finish(new ProviderError(`Piper exited with code ${code}.${stderr ? ' ' + stderr.replace(/\s+/g, ' ').slice(0, 200) : ''}`, 502));
      }
      fs.readFile(outFile, (err, data) => {
        if (err) return finish(new ProviderError(`Piper produced no audio: ${err.message}`, 502));
        if (!data || !data.length) return finish(new ProviderError('Piper produced empty audio.', 502));
        finish(null, { buffer: data, contentType: 'audio/wav' });
      });
    });

    child.stdin.end(String(text));
  });
}

/** Lightweight reachability + auth test for the chat endpoint. */
async function testConnection(opts) {
  const { baseUrl, apiKey, model, timeoutMs, provider } = opts;
  const started = Date.now();
  const result = await chatOnce({
    baseUrl,
    apiKey,
    model,
    provider,
    sessionId: deriveSessionId('connection-test'),
    timeoutMs: Math.min(Number(timeoutMs) || 30000, 30000),
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
  });
  return {
    ok: true,
    model: result.model,
    latencyMs: Date.now() - started,
    reply: String(result.content || '').slice(0, 120)
  };
}

module.exports = {
  ProviderError,
  joinUrl,
  isOpenCodeGo,
  deriveSessionId,
  chatStream,
  chatOnce,
  transcribe,
  synthesize,
  synthesizePiper,
  testConnection
};
