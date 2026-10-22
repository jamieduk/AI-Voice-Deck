'use strict';

// `node:sqlite` is built into Node.js >= 22.5.0 but only unlocked with the
// `--experimental-sqlite` flag on Node < 23.4. Re-exec once with the flag when
// it is required so the app runs unmodified on every supported version.
(function ensureSqlite() {
  try {
    require('node:sqlite');
    return;
  } catch (err) {
    if (process.execArgv.includes('--experimental-sqlite')) throw err;
    const { spawnSync } = require('child_process');
    const result = spawnSync(
      process.execPath,
      ['--experimental-sqlite', ...process.execArgv, __filename, ...process.argv.slice(2)],
      { stdio: 'inherit' }
    );
    process.exit(typeof result.status === 'number' ? result.status : 1);
  }
})();

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const config = require('./config');
const db = require('./database');
const auth = require('./lib/auth');
const providers = require('./lib/providers');

config.init();
db.init();

const LOG_LEVEL = (config.LOG_LEVEL || 'info').toLowerCase();
function log(level, ...args) {
  const order = { error: 0, warn: 1, info: 2, debug: 3 };
  if ((order[level] ?? 2) > (order[LOG_LEVEL] ?? 2)) return;
  const stamp = new Date().toISOString();
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${stamp}] [${level}]`, ...args);
}

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------
if (config.LAN_ACCESS && !config.AUTH_PASSWORD) {
  log('error', 'LAN_ACCESS=true requires AUTH_PASSWORD to be set. Refusing to start.');
  process.exit(1);
}

const BIND_HOST = config.LAN_ACCESS ? '0.0.0.0' : config.HOST;

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// Raw audio body for backend transcription.
app.use('/api/transcribe', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }));

// ---------------------------------------------------------------------------
// Rate limiting (per IP, sliding window)
// ---------------------------------------------------------------------------
const rateBuckets = new Map();
function rateLimit({ windowMs = 60000, max = 120 } = {}) {
  return (req, res, next) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      rateBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    return next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) if (now - b.start > 300000) rateBuckets.delete(ip);
  auth.prune();
}, 60000).unref();

// ---------------------------------------------------------------------------
// Session / auth middleware
// ---------------------------------------------------------------------------
const publicPaths = new Set([
  '/api/bootstrap',
  '/api/login',
  '/api/logout',
  '/api/health'
]);

app.use('/api', (req, res, next) => {
  auth.ensureSession(req, res);
  next();
});

function requireAuth(req, res, next) {
  if (auth.isAuthenticated(req)) return next();
  if (auth.authRequired()) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  // No password configured: only loopback clients are trusted.
  if (auth.isLocalRequest(req)) {
    if (!req.session) req.session = auth.ensureSession(req, res);
    if (req.session) return next();
  }
  return res.status(403).json({ error: 'Access denied. This server is local-only.' });
}

function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.session) return res.status(401).json({ error: 'No active session.' });
  if (!auth.validateCsrf(req)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  }
  return next();
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// Routes: session
// ---------------------------------------------------------------------------
app.get('/api/health', rateLimit({ max: 300 }), (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), port: config.PORT });
});

app.get('/api/bootstrap', rateLimit({ max: 60 }), (req, res) => {
  const authenticated = auth.isAuthenticated(req);
  const payload = {
    authRequired: auth.authRequired(),
    authenticated,
    isLocal: auth.isLocalRequest(req),
    server: {
      port: config.PORT,
      lanAccess: config.LAN_ACCESS,
      version: require('./package.json').version
    }
  };
  if (authenticated) {
    payload.settings = config.getPublicSettings();
    payload.csrf = req.session.csrf;
  }
  res.json(payload);
});

app.post('/api/login', rateLimit({ max: 10 }), (req, res) => {
  if (!auth.authRequired()) {
    return res.json({ ok: true, authRequired: false });
  }
  const session = auth.login(req, res, req.body && req.body.password);
  if (!session) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  return res.json({ ok: true, csrf: session.csrf, settings: config.getPublicSettings() });
});

app.post('/api/logout', requireCsrf, (req, res) => {
  auth.destroySession(req);
  res.setHeader('Set-Cookie', auth.clearCookieHeader(Boolean(req.secure)));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Routes: settings
// ---------------------------------------------------------------------------
app.get('/api/settings', requireAuth, (req, res) => {
  res.json({ settings: config.getPublicSettings() });
});

app.put('/api/settings', requireAuth, requireCsrf, (req, res) => {
  const body = req.body || {};
  const updated = config.updateSettings(body.settings || {});
  if (body.secrets && typeof body.secrets === 'object') {
    config.updateSecrets(body.secrets);
  }
  res.json({ ok: true, settings: config.getPublicSettings() });
});

app.post('/api/settings/test', requireAuth, requireCsrf, rateLimit({ max: 20 }), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const kind = body.kind || 'ai';
  const settings = config.getSettings();
  const secrets = config.getSecrets();

  try {
    if (kind === 'ai') {
      const result = await providers.testConnection({
        baseUrl: settings.ai.baseUrl,
        apiKey: secrets.aiApiKey,
        model: settings.ai.model,
        provider: settings.ai.provider,
        timeoutMs: Math.min(settings.ai.timeoutMs, 30000)
      });
      return res.json({ ok: true, kind, ...result });
    }
    if (kind === 'transcription') {
      if (!settings.transcription.baseUrl) {
        return res.status(400).json({ error: 'No transcription endpoint configured.' });
      }
      // A tiny silent WAV exercise validates auth + route without real audio.
      const silentWav = buildSilentWav();
      const text = await providers.transcribe({
        baseUrl: settings.transcription.baseUrl,
        apiKey: secrets.transcriptionApiKey,
        model: settings.transcription.model,
        apiStyle: settings.transcription.apiStyle,
        buffer: silentWav,
        mime: 'audio/wav',
        filename: 'silence.wav',
        timeoutMs: 30000
      });
      return res.json({ ok: true, kind, reply: text.slice(0, 80) });
    }
    if (kind === 'tts') {
      const provider = settings.tts.provider;
      let audio;
      if (provider === 'piper') {
        audio = await providers.synthesizePiper({
          piperPath: settings.tts.piperPath,
          voice: settings.tts.piperVoice,
          text: 'ok',
          timeoutMs: 30000
        });
      } else {
        if (!settings.tts.baseUrl) {
          return res.status(400).json({ error: 'No speech endpoint configured.' });
        }
        audio = await providers.synthesize({
          baseUrl: settings.tts.baseUrl,
          apiKey: secrets.ttsApiKey,
          model: settings.tts.model,
          voice: settings.tts.voice,
          text: 'ok',
          format: 'mp3',
          timeoutMs: 30000
        });
      }
      return res.json({ ok: true, kind, bytes: audio.buffer.length, contentType: audio.contentType });
    }
    return res.status(400).json({ error: 'Unknown test kind.' });
  } catch (err) {
    const status = err.status && err.status < 500 ? err.status : 502;
    return res.status(status).json({ error: err.message || 'Connection test failed.' });
  }
}));

function buildSilentWav(ms = 300) {
  const sampleRate = 8000;
  const samples = Math.round((sampleRate * ms) / 1000);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

// ---------------------------------------------------------------------------
// Routes: conversations
// ---------------------------------------------------------------------------
function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

app.get('/api/conversations', requireAuth, (req, res) => {
  const search = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  res.json({ conversations: db.listConversations(search) });
});

app.post('/api/conversations', requireAuth, requireCsrf, (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 200) : '';
  const conversation = db.createConversation(title || 'New conversation', config.getSettings().systemPrompt);
  res.status(201).json({ conversation });
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const id = parseId(req.params.id);
  const conversation = id ? db.getConversation(id) : null;
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  return res.json({ conversation, messages: db.getMessages(id) });
});

app.patch('/api/conversations/:id', requireAuth, requireCsrf, (req, res) => {
  const id = parseId(req.params.id);
  const conversation = id ? db.getConversation(id) : null;
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 200) : '';
  if (!title) return res.status(400).json({ error: 'A title is required.' });
  return res.json({ conversation: db.renameConversation(id, title) });
});

app.delete('/api/conversations/:id', requireAuth, requireCsrf, (req, res) => {
  const id = parseId(req.params.id);
  const conversation = id ? db.getConversation(id) : null;
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  db.deleteConversation(id);
  return res.json({ ok: true });
});

app.get('/api/conversations/:id/export', requireAuth, (req, res) => {
  const id = parseId(req.params.id);
  const conversation = id ? db.getConversation(id) : null;
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  const messages = db.getMessages(id);
  const format = req.query.format === 'json' ? 'json' : 'txt';
  const safeName = conversation.title.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-') || `conversation-${id}`;

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.json"`);
    return res.send(JSON.stringify({ conversation: { id, title: conversation.title, created_at: conversation.created_at }, messages }, null, 2));
  }
  const lines = [`# ${conversation.title}`, `Created: ${conversation.created_at}`, ''];
  for (const m of messages) {
    lines.push(`${m.role === 'user' ? 'You' : 'Assistant'} (${m.created_at}):`);
    lines.push(m.content);
    lines.push('');
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.txt"`);
  return res.send(lines.join('\n'));
});

app.get('/api/search', requireAuth, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  res.json({ results: db.searchMessages(q, 50) });
});

// ---------------------------------------------------------------------------
// Routes: transcription (server-side fallback)
// ---------------------------------------------------------------------------
app.post('/api/transcribe', requireAuth, requireCsrf, rateLimit({ max: 30 }), asyncHandler(async (req, res) => {
  const settings = config.getSettings();
  const secrets = config.getSecrets();
  if (!settings.transcription.baseUrl) {
    return res.status(400).json({ error: 'No server-side transcription endpoint is configured.' });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'No audio data received.' });
  }
  try {
    const text = await providers.transcribe({
      baseUrl: settings.transcription.baseUrl,
      apiKey: secrets.transcriptionApiKey,
      model: settings.transcription.model,
      apiStyle: settings.transcription.apiStyle,
      buffer: req.body,
      mime: req.headers['content-type'] || 'audio/webm',
      filename: 'recording.webm',
      timeoutMs: settings.transcription.timeoutMs
    });
    return res.json({ text });
  } catch (err) {
    const status = err.status && err.status < 500 ? err.status : 502;
    return res.status(status).json({ error: err.message || 'Transcription failed.' });
  }
}));

// ---------------------------------------------------------------------------
// Routes: speech synthesis (external provider)
// ---------------------------------------------------------------------------
app.post('/api/tts', requireAuth, requireCsrf, rateLimit({ max: 60 }), asyncHandler(async (req, res) => {
  const settings = config.getSettings();
  const secrets = config.getSecrets();
  const provider = settings.tts.provider;
  if (provider !== 'api' && provider !== 'piper') {
    return res.status(400).json({ error: 'Server-side speech provider is not enabled.' });
  }
  if (provider === 'api' && !settings.tts.baseUrl) {
    return res.status(400).json({ error: 'No speech endpoint configured.' });
  }
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'No text supplied.' });
  if (text.length > 8000) return res.status(413).json({ error: 'Text too long for a single utterance.' });

  try {
    let audio;
    if (provider === 'piper') {
      audio = await providers.synthesizePiper({
        piperPath: settings.tts.piperPath,
        voice: settings.tts.piperVoice,
        text,
        rate: settings.tts.rate,
        timeoutMs: settings.tts.timeoutMs
      });
    } else {
      audio = await providers.synthesize({
        baseUrl: settings.tts.baseUrl,
        apiKey: secrets.ttsApiKey,
        model: settings.tts.model,
        voice: settings.tts.voice,
        text,
        format: 'mp3',
        speed: settings.tts.rate,
        timeoutMs: settings.tts.timeoutMs
      });
    }
    res.setHeader('Content-Type', audio.contentType);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(audio.buffer);
  } catch (err) {
    const status = err.status && err.status < 500 ? err.status : 502;
    return res.status(status).json({ error: err.message || 'Speech synthesis failed.' });
  }
}));

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// API 404 + error handling
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large.' });
  }
  log('error', 'Unhandled error:', err && err.message ? err.message : err);
  if (res.headersSent) return;
  return res.status(500).json({ error: 'An internal error occurred.' });
});

// ---------------------------------------------------------------------------
// HTTP + Socket.IO
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2 * 1024 * 1024,
  cors: {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      return callback(null, isAllowedOrigin(origin));
    },
    credentials: true
  }
});

function isAllowedOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1') return true;
    if (!config.LAN_ACCESS) return false;
    return true;
  } catch (_) {
    return false;
  }
}

io.engine.on('connection_error', (err) => {
  log('warn', 'Socket connection error:', err && err.code, err && err.message);
});

io.use((socket, next) => {
  const origin = socket.handshake.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    return next(new Error('Origin not allowed'));
  }
  const cookies = auth.parseCookies({ headers: socket.handshake.headers });
  const session = cookies[auth.SESSION_COOKIE]
    ? (() => {
        const fakeReq = { headers: socket.handshake.headers };
        return auth.getSession(fakeReq);
      })()
    : null;

  if (auth.authRequired()) {
    if (!session || !session.authenticated) return next(new Error('Authentication required'));
  } else {
    // Local-only mode: only accept loopback connections.
    const addr = socket.handshake.address || '';
    const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    if (!local) return next(new Error('Local access only'));
  }
  socket.data.session = session;
  next();
});

const MAX_MESSAGE_CHARS = 32000;
const MAX_CONTEXT_MESSAGES = 40;
const activeRequests = new Map();

io.on('connection', (socket) => {
  log('debug', 'Socket connected:', socket.id);

  socket.emit('server:hello', {
    id: socket.id,
    authRequired: auth.authRequired()
  });

  socket.on('chat:send', async (payload = {}) => {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId.slice(0, 64) : crypto.randomUUID();
    if (activeRequests.has(socket.id + ':' + requestId)) return;

    const content = typeof payload.content === 'string' ? payload.content.trim() : '';
    if (!content) {
      socket.emit('chat:error', { requestId, message: 'Message is empty.' });
      return;
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      socket.emit('chat:error', { requestId, message: 'Message is too long.' });
      return;
    }

    // Resolve the conversation, creating one if the client supplied an invalid id.
    let conversation = parseId(payload.conversationId) ? db.getConversation(parseId(payload.conversationId)) : null;
    let createdConversation = false;
    if (!conversation) {
      conversation = db.createConversation('New conversation', config.getSettings().systemPrompt);
      createdConversation = true;
    }

    const settings = config.getSettings();
    const secrets = config.getSecrets();

    if (!settings.ai.baseUrl || !settings.ai.model) {
      socket.emit('chat:error', { requestId, message: 'The AI endpoint is not configured. Open Settings to set it up.' });
      return;
    }

    const userMessageId = db.addMessage(conversation.id, 'user', content);
    const assistantMessageId = db.addMessage(conversation.id, 'assistant', '');

    // Auto-title from the first user message.
    if (conversation.title === 'New conversation') {
      const title = content.replace(/\s+/g, ' ').slice(0, 60);
      db.renameConversation(conversation.id, title || 'New conversation');
      conversation = db.getConversation(conversation.id);
    }

    socket.emit('chat:start', {
      requestId,
      conversation: { id: conversation.id, title: conversation.title },
      createdConversation,
      userMessageId,
      assistantMessageId
    });

    const history = db.getMessages(conversation.id)
      .filter((m) => m.id !== assistantMessageId)
      .slice(-MAX_CONTEXT_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }));

    const systemPrompt = conversation.system_prompt || settings.systemPrompt || '';
    const messages = [];
    if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt.trim() });
    for (const m of history) {
      if (m.role === 'system' || !m.content) continue;
      messages.push(m);
    }

    const controller = new AbortController();
    const key = socket.id + ':' + requestId;
    activeRequests.set(key, { controller, conversationId: conversation.id, assistantMessageId });

    let full = '';
    try {
      const result = await providers.chatStream({
        baseUrl: settings.ai.baseUrl,
        apiKey: secrets.aiApiKey,
        model: settings.ai.model,
        provider: settings.ai.provider,
        sessionId: providers.deriveSessionId('conversation:' + conversation.id),
        messages,
        timeoutMs: settings.ai.timeoutMs,
        signal: controller.signal,
        onDelta(piece) {
          full += piece;
          socket.emit('chat:delta', { requestId, text: piece });
        }
      });
      if (!full && result.content) full = result.content;
      db.updateMessage(assistantMessageId, full);
      db.touchConversation(conversation.id);
      socket.emit('chat:done', {
        requestId,
        conversationId: conversation.id,
        assistantMessageId,
        content: full,
        usage: result.usage || null
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        db.updateMessage(assistantMessageId, full);
        socket.emit('chat:cancelled', { requestId, conversationId: conversation.id, assistantMessageId, content: full });
      } else {
        db.updateMessage(assistantMessageId, full);
        log('warn', 'Chat request failed:', err.message);
        socket.emit('chat:error', {
          requestId,
          conversationId: conversation.id,
          assistantMessageId,
          message: err.message || 'The AI request failed.'
        });
      }
    } finally {
      activeRequests.delete(key);
    }
  });

  socket.on('chat:cancel', (payload = {}) => {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const key = socket.id + ':' + requestId;
    const entry = activeRequests.get(key);
    if (entry) {
      entry.controller.abort();
      activeRequests.delete(key);
    }
  });

  socket.on('disconnect', () => {
    for (const [key, entry] of activeRequests) {
      if (key.startsWith(socket.id + ':')) {
        entry.controller.abort();
        activeRequests.delete(key);
      }
    }
    log('debug', 'Socket disconnected:', socket.id);
  });
});

// ---------------------------------------------------------------------------
// Retention job
// ---------------------------------------------------------------------------
function runRetention() {
  try {
    const days = config.getSettings().retentionDays;
    const removed = db.pruneOldConversations(days);
    if (removed > 0) log('info', `Retention policy removed ${removed} old conversation(s).`);
  } catch (err) {
    log('warn', 'Retention job failed:', err.message);
  }
}
runRetention();
setInterval(runRetention, 6 * 3600 * 1000).unref();

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(config.PORT, BIND_HOST, () => {
  log('info', `AI Voice Desk listening on http://${BIND_HOST === '0.0.0.0' ? 'localhost' : BIND_HOST}:${config.PORT}`);
  if (!config.LAN_ACCESS) log('info', 'Local-only mode. Set LAN_ACCESS=true (with AUTH_PASSWORD) for network access.');
  if (!auth.authRequired()) log('info', 'No AUTH_PASSWORD set: only loopback clients are served.');
  log('info', `Data directory: ${config.DATA_DIR}`);
});

function shutdown(signal) {
  log('info', `Received ${signal}, shutting down...`);
  for (const [, entry] of activeRequests) {
    try { entry.controller.abort(); } catch (_) { /* ignore */ }
  }
  io.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log('error', 'Unhandled rejection:', err && err.message));

module.exports = { app, server, io };
