'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const ROOT = __dirname;

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');
const DB_FILE = path.join(DATA_DIR, 'app.db');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    // Corrupt file: back it up instead of destroying data.
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    } catch (_) { /* ignore */ }
    return fallback;
  }
}

function writeJsonSecure(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* ignore */ }
}

function envSettings() {
  return {
    ai: {
      provider: process.env.AI_PROVIDER || 'OpenAI-compatible',
      baseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      timeoutMs: int(process.env.AI_TIMEOUT_MS, 120000)
    },
    transcription: {
      baseUrl: process.env.TRANSCRIPTION_BASE_URL || '',
      model: process.env.TRANSCRIPTION_MODEL || 'whisper-1',
      apiStyle: process.env.TRANSCRIPTION_API_STYLE || 'openai',
      timeoutMs: int(process.env.TRANSCRIPTION_TIMEOUT_MS, 120000)
    },
    tts: {
      provider: process.env.TTS_PROVIDER || (process.env.TTS_BASE_URL ? 'api' : 'browser'),
      baseUrl: process.env.TTS_BASE_URL || '',
      model: process.env.TTS_MODEL || 'tts-1',
      voice: process.env.TTS_VOICE || 'alloy',
      piperPath: process.env.PIPER_PATH || '',
      piperVoice: process.env.PIPER_VOICE || '',
      rate: 1,
      pitch: 1,
      volume: 1
    },
    voice: {
      mode: 'ptt',
      micDeviceId: '',
      autoSpeak: true,
      browserTranscription: true
    },
    ui: {
      accent: '#4CAF50'
    },
    systemPrompt: 'You are a helpful, concise voice assistant. Answer clearly and avoid unnecessary formatting.',
    retentionDays: int(process.env.RETENTION_DAYS, 0)
  };
}

function envSecrets() {
  return {
    aiApiKey: process.env.AI_API_KEY || '',
    transcriptionApiKey: process.env.TRANSCRIPTION_API_KEY || '',
    ttsApiKey: process.env.TTS_API_KEY || ''
  };
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (typeof base !== 'object' || Array.isArray(base) || base === null) return patch;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(patch)) {
    const val = patch[key];
    if (val && typeof val === 'object' && !Array.isArray(val) &&
        base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

let settingsCache = null;
let secretsCache = null;

function init() {
  ensureDir(DATA_DIR);
  ensureDir(path.join(ROOT, 'logs'));

  settingsCache = deepMerge(envSettings(), readJson(SETTINGS_FILE, {}));
  secretsCache = deepMerge(envSecrets(), readJson(SECRETS_FILE, {}));

  // Persist initial values so the user can see/edit them.
  if (!fs.existsSync(SETTINGS_FILE)) writeJsonSecure(SETTINGS_FILE, settingsCache);
  if (!fs.existsSync(SECRETS_FILE)) writeJsonSecure(SECRETS_FILE, secretsCache);
}

function getSettings() {
  if (!settingsCache) init();
  return settingsCache;
}

function getSecrets() {
  if (!secretsCache) init();
  return secretsCache;
}

function updateSettings(patch) {
  if (!settingsCache) init();
  settingsCache = deepMerge(settingsCache, sanitizeSettingsPatch(patch));
  writeJsonSecure(SETTINGS_FILE, settingsCache);
  return settingsCache;
}

function updateSecrets(patch) {
  if (!secretsCache) init();
  const clean = {};
  for (const key of ['aiApiKey', 'transcriptionApiKey', 'ttsApiKey']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      const val = patch[key];
      if (val === null || val === undefined || val === '' || val === '__KEEP__') continue;
      clean[key] = String(val).slice(0, 4096);
    }
  }
  secretsCache = { ...secretsCache, ...clean };
  writeJsonSecure(SECRETS_FILE, secretsCache);
  return secretsCache;
}

// Only allow known settings keys through so a client cannot write arbitrary data.
function sanitizeSettingsPatch(patch) {
  const s = getSettings();
  const out = {};
  const src = patch && typeof patch === 'object' ? patch : {};

  // Only allow writing known settings keys through so a client cannot write arbitrary data.
  const str = (v, max = 512) => (v === undefined ? undefined : String(v).slice(0, max));
  const num = (v, min, max, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(max, Math.max(min, n));
  };
  const url = (v) => {
    if (v === undefined) return undefined;
    const value = String(v).trim();
    if (!value) return '';
    if (!/^https?:\/\//i.test(value)) return undefined;
    return value.slice(0, 2048);
  };

  const ai = src.ai || {};
  out.ai = {};
  if (str(ai.provider, 128) !== undefined) out.ai.provider = str(ai.provider, 128);
  if (url(ai.baseUrl) !== undefined) out.ai.baseUrl = url(ai.baseUrl);
  if (str(ai.model, 256) !== undefined) out.ai.model = str(ai.model, 256);
  if (num(ai.timeoutMs, 1000, 600000) !== undefined) out.ai.timeoutMs = num(ai.timeoutMs, 1000, 600000);
  out.ai = { ...s.ai, ...out.ai };

  const tr = src.transcription || {};
  out.transcription = {};
  if (url(tr.baseUrl) !== undefined) out.transcription.baseUrl = url(tr.baseUrl);
  if (str(tr.model, 256) !== undefined) out.transcription.model = str(tr.model, 256);
  if (['openai', 'whisper.cpp'].includes(tr.apiStyle)) out.transcription.apiStyle = tr.apiStyle;
  if (num(tr.timeoutMs, 1000, 600000) !== undefined) out.transcription.timeoutMs = num(tr.timeoutMs, 1000, 600000);
  if (typeof tr.useBrowser === 'boolean') out.transcription.useBrowser = tr.useBrowser;
  out.transcription = { ...s.transcription, ...out.transcription };

  const tts = src.tts || {};
  out.tts = {};
  if (['browser', 'api', 'piper'].includes(tts.provider)) out.tts.provider = tts.provider;
  if (url(tts.baseUrl) !== undefined) out.tts.baseUrl = url(tts.baseUrl);
  if (str(tts.model, 256) !== undefined) out.tts.model = str(tts.model, 256);
  if (str(tts.voice, 128) !== undefined) out.tts.voice = str(tts.voice, 128);
  if (str(tts.piperPath, 1024) !== undefined) out.tts.piperPath = str(tts.piperPath, 1024);
  if (str(tts.piperVoice, 1024) !== undefined) out.tts.piperVoice = str(tts.piperVoice, 1024);
  if (num(tts.rate, 0.25, 4) !== undefined) out.tts.rate = num(tts.rate, 0.25, 4);
  if (num(tts.pitch, 0, 2) !== undefined) out.tts.pitch = num(tts.pitch, 0, 2);
  if (num(tts.volume, 0, 1) !== undefined) out.tts.volume = num(tts.volume, 0, 1);
  out.tts = { ...s.tts, ...out.tts };

  const voice = src.voice || {};
  out.voice = {};
  if (['ptt', 'continuous'].includes(voice.mode)) out.voice.mode = voice.mode;
  if (str(voice.micDeviceId, 256) !== undefined) out.voice.micDeviceId = str(voice.micDeviceId, 256);
  if (typeof voice.autoSpeak === 'boolean') out.voice.autoSpeak = voice.autoSpeak;
  if (typeof voice.browserTranscription === 'boolean') out.voice.browserTranscription = voice.browserTranscription;
  out.voice = { ...s.voice, ...out.voice };

  const ui = src.ui || {};
  out.ui = {};
  if (typeof ui.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(ui.accent)) out.ui.accent = ui.accent;
  out.ui = { ...s.ui, ...out.ui };

  if (typeof src.systemPrompt === 'string') out.systemPrompt = src.systemPrompt.slice(0, 8000);
  if (num(src.retentionDays, 0, 3650) !== undefined) out.retentionDays = Math.round(num(src.retentionDays, 0, 3650));

  return out;
}

function maskSecret(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 4) return '••••';
  return '••••••••' + s.slice(-4);
}

function getPublicSettings() {
  const s = getSettings();
  const sec = getSecrets();
  return {
    ...s,
    ai: { ...s.ai, apiKeyMasked: maskSecret(sec.aiApiKey), hasApiKey: Boolean(sec.aiApiKey) },
    transcription: { ...s.transcription, apiKeyMasked: maskSecret(sec.transcriptionApiKey), hasApiKey: Boolean(sec.transcriptionApiKey) },
    tts: { ...s.tts, apiKeyMasked: maskSecret(sec.ttsApiKey), hasApiKey: Boolean(sec.ttsApiKey) }
  };
}

function getSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim()) {
    return process.env.SESSION_SECRET.trim();
  }
  // Persist a generated secret so sessions survive restarts.
  const keyFile = path.join(DATA_DIR, 'session.key');
  try {
    if (fs.existsSync(keyFile)) {
      const existing = fs.readFileSync(keyFile, 'utf8').trim();
      if (existing) return existing;
    }
    const generated = crypto.randomBytes(48).toString('hex');
    ensureDir(DATA_DIR);
    fs.writeFileSync(keyFile, generated, { mode: 0o600 });
    return generated;
  } catch (_) {
    return crypto.randomBytes(48).toString('hex');
  }
}

module.exports = {
  ROOT,
  DATA_DIR,
  DB_FILE,
  SETTINGS_FILE,
  SECRETS_FILE,
  PORT: int(process.env.PORT, 8381),
  LAN_ACCESS: bool(process.env.LAN_ACCESS, false),
  HOST: process.env.HOST || '127.0.0.1',
  AUTH_PASSWORD: process.env.AUTH_PASSWORD || '',
  SESSION_HOURS: int(process.env.SESSION_HOURS, 24),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  init,
  getSettings,
  getSecrets,
  getPublicSettings,
  updateSettings,
  updateSecrets,
  sanitizeSettingsPatch,
  getSessionSecret,
  maskSecret,
  writeJsonSecure,
  ensureDir
};
