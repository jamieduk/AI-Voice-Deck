#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test.
 *
 * Boots the real server against a throwaway data directory and a mock
 * OpenAI-compatible endpoint, then exercises:
 *   - health + static frontend
 *   - session bootstrap (local mode)
 *   - settings read/write + connection test
 *   - conversation create / list / fetch / export / delete
 *   - streaming chat over Socket.IO with persistence
 *
 * Run with:  npm test
 */

const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.error(`  \u2717 ${name}${detail ? ' - ' + detail : ''}`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForHealth(base, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) return true;
    } catch (_) { /* not up yet */ }
    await wait(150);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Mock OpenAI-compatible provider                                    */
/* ------------------------------------------------------------------ */

function startMockProvider() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const auth = req.headers.authorization || '';
        if (!auth.startsWith('Bearer test-key')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'bad key' } }));
        }

        if (req.url.startsWith('/v1/chat/completions')) {
          let parsed = {};
          try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch (_) { /* ignore */ }
          if (parsed.stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive'
            });
            const pieces = ['Hello', ' from', ' the', ' mock', ' model.'];
            let i = 0;
            const timer = setInterval(() => {
              if (i < pieces.length) {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] })}\n\n`);
              } else {
                res.write('data: [DONE]\n\n');
                clearInterval(timer);
                res.end();
              }
            }, 10);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            model: parsed.model || 'mock-model',
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { total_tokens: 3 }
          }));
        }

        if (req.url.startsWith('/v1/audio/transcriptions')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ text: 'transcribed text' }));
        }

        if (req.url.startsWith('/v1/audio/speech')) {
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          return res.end(Buffer.from([0xff, 0xfb, 0x00, 0x00]));
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ */
/* Tiny cookie-aware HTTP client                                      */
/* ------------------------------------------------------------------ */

function createClient(base) {
  let cookie = '';
  let csrf = '';

  async function request(pathname, { method = 'GET', body, headers = {}, raw = false } = {}) {
    const opts = { method, headers: { ...headers } };
    if (cookie) opts.headers.Cookie = cookie;
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (method !== 'GET' && method !== 'HEAD' && csrf) opts.headers['x-csrf-token'] = csrf;
    const res = await fetch(base + pathname, opts);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    let data = null;
    if (raw) data = Buffer.from(await res.arrayBuffer());
    else if (ct.includes('application/json')) data = await res.json().catch(() => null);
    else data = await res.text();
    return { status: res.status, data, headers: res.headers };
  }

  return {
    request,
    setCsrf(value) { csrf = value; },
    getCookie() { return cookie; }
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-test-'));
  const appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;

  console.log('\nAI Voice Desk smoke test');
  console.log('  data dir :', dataDir);
  console.log('  app port :', appPort);

  const mock = await startMockProvider();
  console.log('  mock port:', mock.port, '\n');

  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'server.js')], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      PORT: String(appPort),
      HOST: '127.0.0.1',
      LAN_ACCESS: 'false',
      AUTH_PASSWORD: '',
      DATA_DIR: dataDir,
      LOG_LEVEL: 'warn',
      AI_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
      AI_MODEL: 'mock-model',
      AI_API_KEY: 'test-key',
      TRANSCRIPTION_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
      TRANSCRIPTION_API_STYLE: 'openai',
      TRANSCRIPTION_MODEL: 'whisper-1',
      TRANSCRIPTION_API_KEY: 'test-key',
      TTS_PROVIDER: 'api',
      TTS_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
      TTS_MODEL: 'tts-1',
      TTS_API_KEY: 'test-key',
      RETENTION_DAYS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    await wait(300);
    try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    mock.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  try {
    const healthy = await waitForHealth(base);
    ok('server starts and answers /api/health', healthy, serverLog.slice(-400));
    if (!healthy) throw new Error('server did not become healthy');

    const client = createClient(base);

    // --- static frontend ---
    const page = await client.request('/');
    ok('serves index.html', page.status === 200 && /AI Voice Desk/.test(String(page.data)));
    const css = await client.request('/css/style.css');
    ok('serves stylesheet', css.status === 200);
    const js = await client.request('/js/app.js');
    ok('serves app.js', js.status === 200);

    // --- bootstrap ---
    const boot = await client.request('/api/bootstrap');
    ok('bootstrap returns JSON', boot.status === 200 && boot.data && typeof boot.data === 'object');
    ok('local mode needs no password', boot.data.authRequired === false);
    ok('local session is authenticated', boot.data.authenticated === true);
    ok('bootstrap exposes settings', Boolean(boot.data.settings && boot.data.settings.ai));
    ok('bootstrap exposes csrf token', typeof boot.data.csrf === 'string' && boot.data.csrf.length > 10);
    client.setCsrf(boot.data.csrf);
    ok('api key is masked, not exposed', !('aiApiKey' in (boot.data.settings.ai || {})));

    // --- settings ---
    const put = await client.request('/api/settings', {
      method: 'PUT',
      body: {
        settings: { ui: { accent: '#2196F3' }, voice: { autoSpeak: false }, systemPrompt: 'Test prompt' }
      }
    });
    ok('settings update accepted', put.status === 200 && put.data.settings.ui.accent === '#2196F3');
    ok('settings update persisted value', put.data.settings.systemPrompt === 'Test prompt');
    ok('settings rejects invalid accent', (await client.request('/api/settings', {
      method: 'PUT', body: { settings: { ui: { accent: 'red' } } }
    })).data.settings.ui.accent === '#2196F3');
    ok('settings rejects non-http url', (await client.request('/api/settings', {
      method: 'PUT', body: { settings: { ai: { baseUrl: 'javascript:alert(1)' } } }
    })).data.settings.ai.baseUrl.startsWith('http'));

    // --- CSRF enforcement ---
    const noCsrf = createClient(base);
    await noCsrf.request('/api/bootstrap');
    const csrfFail = await noCsrf.request('/api/conversations', { method: 'POST', body: { title: 'x' } });
    ok('state-changing request without CSRF is rejected', csrfFail.status === 403);

    // --- AI connection test ---
    const aiTest = await client.request('/api/settings/test', { method: 'POST', body: { kind: 'ai' } });
    ok('AI connection test succeeds', aiTest.status === 200 && aiTest.data.ok === true);
    const trTest = await client.request('/api/settings/test', { method: 'POST', body: { kind: 'transcription' } });
    ok('transcription connection test succeeds', trTest.status === 200 && trTest.data.ok === true);
    const ttsTest = await client.request('/api/settings/test', { method: 'POST', body: { kind: 'tts' } });
    ok('speech connection test succeeds', ttsTest.status === 200 && ttsTest.data.ok === true);

    // --- conversations ---
    const created = await client.request('/api/conversations', { method: 'POST', body: { title: 'Smoke chat' } });
    ok('creates conversation', created.status === 201 && created.data.conversation.id > 0);
    const convId = created.data.conversation.id;

    const list = await client.request('/api/conversations');
    ok('lists conversations', Array.isArray(list.data.conversations) && list.data.conversations.length >= 1);

    // --- socket.io streaming chat ---
    const { io } = require('socket.io-client');
    const socket = io(base, { transports: ['websocket'], forceNew: true });

    const chatResult = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('chat timed out')), 8000);
      let text = '';
      socket.on('connect_error', (err) => { clearTimeout(timeout); reject(err); });
      socket.on('connect', () => {
        socket.emit('chat:send', { requestId: 'smoke-1', content: 'Say hi', conversationId: convId });
      });
      socket.on('chat:delta', (p) => { text += p.text; });
      socket.on('chat:done', (p) => { clearTimeout(timeout); resolve({ text: p.content || text, usage: p.usage }); });
      socket.on('chat:error', (p) => { clearTimeout(timeout); reject(new Error(p.message)); });
    });
    ok('streams a chat reply', /Hello from the mock model\./.test(chatResult.text), chatResult.text);
    socket.close();

    // --- persistence ---
    const fetched = await client.request('/api/conversations/' + convId);
    const roles = fetched.data.messages.map((m) => m.role);
    ok('persists user + assistant messages', roles.includes('user') && roles.includes('assistant'));
    const assistant = fetched.data.messages.find((m) => m.role === 'assistant');
    ok('persists streamed content', /Hello from the mock model\./.test(assistant.content));

    // --- rename + search + export ---
    const renamed = await client.request('/api/conversations/' + convId, { method: 'PATCH', body: { title: 'Renamed chat' } });
    ok('renames conversation', renamed.data.conversation.title === 'Renamed chat');
    const search = await client.request('/api/conversations?q=Renamed');
    ok('searches conversations', search.data.conversations.some((c) => c.id === convId));
    const exportTxt = await client.request(`/api/conversations/${convId}/export?format=txt`, { raw: true });
    ok('exports plain text', exportTxt.status === 200 && exportTxt.data.toString('utf8').includes('Assistant'));
    const exportJson = await client.request(`/api/conversations/${convId}/export?format=json`);
    ok('exports JSON', exportJson.status === 200 && Array.isArray(exportJson.data.messages));

    // --- server-side transcription ---
    const tr = await client.request('/api/transcribe', {
      method: 'POST',
      raw: true,
      headers: { 'Content-Type': 'audio/webm' },
      body: undefined
    });
    // no audio body -> 400, proves the route is wired and validated
    ok('transcription route validates empty body', tr.status === 400);

    // --- not found handling ---
    const missing = await client.request('/api/conversations/999999');
    ok('missing conversation returns 404', missing.status === 404);

    // --- delete ---
    const del = await client.request('/api/conversations/' + convId, { method: 'DELETE' });
    ok('deletes conversation', del.status === 200);
    ok('deleted conversation is gone', (await client.request('/api/conversations/' + convId)).status === 404);
  } catch (err) {
    failed++;
    console.error('\nFatal test error:', err && err.message ? err.message : err);
    if (serverLog) console.error('Server output:\n' + serverLog.slice(-1500));
  } finally {
    await cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
