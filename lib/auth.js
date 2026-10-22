'use strict';

const crypto = require('crypto');
const config = require('../config');

const SESSION_COOKIE = 'avd_sid';
const CSRF_HEADER = 'x-csrf-token';

// In-memory session store. The application is single-user and self-hosted, so
// a process-local store is appropriate. Sealed cookie prevents tampering.
const sessions = new Map();

function sign(value) {
  const secret = config.getSessionSecret();
  const mac = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

function unsign(signed) {
  if (typeof signed !== 'string' || !signed.includes('.')) return null;
  const idx = signed.lastIndexOf('.');
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = crypto.createHmac('sha256', config.getSessionSecret()).update(value).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return value;
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function createSession(isLocal) {
  const id = crypto.randomBytes(32).toString('base64url');
  const session = {
    id,
    csrf: crypto.randomBytes(32).toString('base64url'),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    isLocal: Boolean(isLocal),
    authenticated: true
  };
  sessions.set(id, session);
  return session;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const signed = cookies[SESSION_COOKIE];
  if (!signed) return null;
  const id = unsign(signed);
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  const maxAge = config.SESSION_HOURS * 3600 * 1000;
  if (Date.now() - session.createdAt > maxAge) {
    sessions.delete(id);
    return null;
  }
  session.lastSeen = Date.now();
  return session;
}

function destroySession(req) {
  const cookies = parseCookies(req);
  const signed = cookies[SESSION_COOKIE];
  if (!signed) return;
  const id = unsign(signed);
  if (id) sessions.delete(id);
}

function cookieHeader(session, secure) {
  const maxAge = config.SESSION_HOURS * 3600;
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sign(session.id))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookieHeader(secure) {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0'
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function isLocalRequest(req) {
  const ip = req.socket && req.socket.remoteAddress;
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function authRequired() {
  return Boolean(config.AUTH_PASSWORD);
}

function isAuthenticated(req) {
  // Prefer the session attached by ensureSession(); fall back to reading the
  // cookie directly (e.g. when called before the middleware runs).
  const session = req.session || getSession(req);
  if (!session) return false;
  if (!authRequired()) return true;
  return session.authenticated === true;
}

// Populates req.session, creating one for local requests that need no password.
function ensureSession(req, res) {
  let session = getSession(req);
  const secure = Boolean(req.secure);
  if (!session) {
    if (!authRequired() && isLocalRequest(req)) {
      session = createSession(true);
      res.setHeader('Set-Cookie', cookieHeader(session, secure));
    }
  }
  req.session = session || null;
  return session;
}

function login(req, res, password) {
  if (!authRequired()) return null;
  const expected = String(config.AUTH_PASSWORD);
  const provided = String(password || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  let ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    // Constant-ish time even on length mismatch.
    crypto.timingSafeEqual(Buffer.from('x'.repeat(32)), Buffer.from('x'.repeat(32)));
  }
  if (!ok) return null;
  const session = createSession(isLocalRequest(req));
  session.authenticated = true;
  res.setHeader('Set-Cookie', cookieHeader(session, Boolean(req.secure)));
  return session;
}

function validateCsrf(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const session = req.session;
  if (!session) return false;
  const provided = req.headers[CSRF_HEADER] || (req.body && req.body._csrf);
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(session.csrf);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function prune() {
  const maxAge = config.SESSION_HOURS * 3600 * 1000;
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > maxAge) sessions.delete(id);
  }
}

module.exports = {
  SESSION_COOKIE,
  CSRF_HEADER,
  sessions,
  parseCookies,
  getSession,
  ensureSession,
  createSession,
  destroySession,
  cookieHeader,
  clearCookieHeader,
  isLocalRequest,
  authRequired,
  isAuthenticated,
  login,
  validateCsrf,
  prune
};
