'use strict';

/* ==========================================================================
 * AI Voice Desk - front-end controller
 * --------------------------------------------------------------------------
 * Responsibilities:
 *   - session bootstrap / login
 *   - conversation list + history (REST)
 *   - streaming chat over Socket.IO
 *   - voice input (push-to-talk + continuous) and speech output
 *   - settings load / save / connection tests
 *
 * No provider credentials ever reach this file; every AI/STT/TTS call is
 * proxied through the server.
 * ========================================================================== */

const $ = (id) => document.getElementById(id);

const dom = {
  shell: $('app-shell'),
  sidebar: $('sidebar'),
  sidebarScrim: $('sidebar-scrim'),
  menuToggle: $('menu-toggle'),
  newConversation: $('new-conversation'),
  searchInput: $('search-input'),
  conversationList: $('conversation-list'),
  toggleTextMode: $('toggle-text-mode'),
  convTitle: $('conv-title'),
  modelLabel: $('model-label'),
  connDot: $('conn-dot'),
  openSettings: $('open-settings'),
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  statusDetail: $('status-detail'),
  conversation: $('conversation'),
  emptyState: $('empty-state'),
  waveWrap: document.querySelector('.wave-wrap'),
  waveform: $('waveform'),
  composer: $('composer'),
  messageInput: $('message-input'),
  sendBtn: $('send-btn'),
  pttBtn: $('ptt-btn'),
  pttLabel: $('ptt-label'),
  modeToggle: $('mode-toggle'),
  muteBtn: $('mute-btn'),
  stopBtn: $('stop-btn'),
  replayBtn: $('replay-btn'),
  clearBtn: $('clear-btn'),
  loginOverlay: $('login-overlay'),
  loginForm: $('login-form'),
  loginPassword: $('login-password'),
  loginError: $('login-error'),
  settingsOverlay: $('settings-overlay'),
  closeSettings: $('close-settings'),
  cancelSettings: $('cancel-settings'),
  saveSettings: $('save-settings'),
  settingsStatus: $('settings-status'),
  toast: $('toast')
};

const state = {
  csrf: null,
  authRequired: false,
  authenticated: false,
  isLocal: false,
  settings: null,
  browserVoice: localStorage.getItem('avd.browserVoice') || '',
  muted: false,
  streaming: false,
  activeRequestId: null,
  conversationId: null,
  lastAssistantText: '',
  continuousActive: false,
  voiceActive: null, // 'recognition' | 'recording' | null
  recognitionBuffer: '',
  recognitionInterim: '',
  textOnly: localStorage.getItem('avd.textOnly') === '1',
  socket: null,
  micDevicesLoaded: false
};

let socket = null;
let toastTimer = null;

/* ------------------------------------------------------------------ */
/* Utilities                                                          */
/* ------------------------------------------------------------------ */

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'req-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(76,175,80,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function applyAccent(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return;
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-soft', hexToRgba(hex, 0.16));
}

function toast(message, kind = 'info', ms = 4200) {
  dom.toast.textContent = message;
  dom.toast.className = 'toast' + (kind === 'error' ? ' is-error' : kind === 'warn' ? ' is-warn' : '');
  dom.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, ms);
}

function inlineResult(el, message, kind) {
  el.textContent = message || '';
  el.className = 'inline-result' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
}

function setConn(status) {
  dom.connDot.className = 'conn-dot conn-' + status;
}

const STATUS_LABEL = {
  idle: 'Ready',
  listening: 'Listening',
  processing: 'Thinking',
  speaking: 'Speaking',
  error: 'Error'
};

function setStatus(status, detail = '') {
  dom.statusPill.dataset.state = status;
  dom.statusPill.className = 'status-pill status-' + status;
  dom.statusText.textContent = STATUS_LABEL[status] || status;
  dom.statusDetail.textContent = detail || '';
  const waveActive = status === 'listening' || status === 'speaking';
  if (dom.waveWrap) dom.waveWrap.classList.toggle('is-active', waveActive);
}

function fmtTime(value) {
  if (!value) return '';
  const iso = String(value).includes('T') ? value : String(value).replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------------------------------------------ */
/* Markdown (escaped, sanitised - no raw HTML passes through)         */
/* ------------------------------------------------------------------ */

function renderMarkdown(src) {
  let text = String(src || '');
  const codeBlocks = [];
  text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    codeBlocks.push({ lang, code });
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  text = text.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<em>$2</em>');

  const lines = text.split('\n');
  let html = '';
  let listType = null;
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };

  for (const line of lines) {
    if (/^\s*$/.test(line)) { closeList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const lvl = Math.min(m[1].length, 6);
      html += `<h${lvl}>${m[2]}</h${lvl}>`;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
      html += `<li>${line.replace(/^\s*[-*+]\s+/, '')}</li>`;
      continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
      html += `<li>${m[1]}</li>`;
      continue;
    }
    if ((m = line.match(/^&gt;\s?(.*)$/))) {
      closeList();
      html += `<blockquote>${m[1]}</blockquote>`;
      continue;
    }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) { closeList(); html += '<hr>'; continue; }
    closeList();
    html += `<p>${line}</p>`;
  }
  closeList();

  html = html.replace(/\u0000CODE(\d+)\u0000/g, (m, i) => {
    const block = codeBlocks[Number(i)];
    if (!block) return '';
    return `<pre><code class="lang-${escapeHtml(block.lang || '')}">${escapeHtml(block.code.replace(/\n$/, ''))}</code></pre>`;
  });
  return html;
}

function stripForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' code block omitted ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* REST helper                                                        */
/* ------------------------------------------------------------------ */

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (method !== 'GET' && method !== 'HEAD' && state.csrf) {
    opts.headers['x-csrf-token'] = state.csrf;
  }
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  if (res.status === 401) {
    state.authenticated = false;
    showLogin();
    throw new Error('Authentication required.');
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    if (ct.includes('application/json')) {
      try { const j = await res.json(); msg = j.error || msg; } catch (_) { /* ignore */ }
    }
    throw new Error(msg);
  }
  if (ct.includes('application/json')) return res.json();
  return res;
}

/* ------------------------------------------------------------------ */
/* Audio engine                                                       */
/* ------------------------------------------------------------------ */

const vad = { active: false, recording: false, busy: false, lastVoice: 0 };

function onLevel(level) {
  if (!vad.active) return;
  const now = performance.now();
  if (level > 0.09) {
    vad.lastVoice = now;
    if (!vad.recording && !vad.busy) startVadSegment();
  } else if (vad.recording && now - vad.lastVoice > 1200) {
    stopVadSegment();
  }
}

const audio = new AudioEngine({
  canvas: dom.waveform,
  onLevel,
  onSpeechStart() { if (!state.voiceActive) setStatus('speaking'); },
  onSpeechEnd() { if (!state.voiceActive) setStatus('idle'); },
  onRecognitionResult,
  onRecognitionError,
  onRecognitionEnd
});

/* ------------------------------------------------------------------ */
/* Status of connection + bootstrap                                   */
/* ------------------------------------------------------------------ */

function showLogin() {
  dom.loginOverlay.hidden = false;
  setTimeout(() => dom.loginPassword.focus(), 50);
}

function hideLogin() {
  dom.loginOverlay.hidden = true;
  dom.loginError.hidden = true;
  dom.loginPassword.value = '';
}

async function bootstrap() {
  let boot;
  try {
    boot = await api('/api/bootstrap');
  } catch (err) {
    setConn('bad');
    setStatus('error', err.message);
    toast('Could not reach the server: ' + err.message, 'error');
    return;
  }

  state.authRequired = Boolean(boot.authRequired);
  state.authenticated = Boolean(boot.authenticated);
  state.isLocal = Boolean(boot.isLocal);
  $('logout-btn').hidden = !state.authRequired;

  if (boot.csrf) state.csrf = boot.csrf;
  if (boot.settings) applySettings(boot.settings);

  if (state.authRequired && !state.authenticated) {
    showLogin();
    return;
  }
  hideLogin();
  startApp();
}

function startApp() {
  setConn('unknown');
  refreshCapabilities();
  connectSocket();
  loadConversations();
  loadMicDevices();
  populateBrowserVoices();
  applyTextOnly(state.textOnly);
}

/* ------------------------------------------------------------------ */
/* Socket.IO                                                          */
/* ------------------------------------------------------------------ */

function connectSocket() {
  if (socket) return;
  socket = io({ withCredentials: true });
  state.socket = socket;

  socket.on('connect', () => {
    setConn('ok');
    if (!state.streaming) setStatus('idle');
    loadConversations();
    if (state.conversationId) loadConversation(state.conversationId);
  });

  socket.on('disconnect', () => {
    setConn('bad');
    setStatus('error', 'Disconnected. Reconnecting…');
  });

  socket.on('connect_error', (err) => {
    setConn('bad');
    const msg = err && err.message ? err.message : 'Connection error';
    if (/auth/i.test(msg)) { showLogin(); return; }
    setStatus('error', msg);
  });

  socket.on('chat:start', onChatStart);
  socket.on('chat:delta', onChatDelta);
  socket.on('chat:done', onChatDone);
  socket.on('chat:error', onChatError);
  socket.on('chat:cancelled', onChatCancelled);
}

/* ------------------------------------------------------------------ */
/* Conversations                                                      */
/* ------------------------------------------------------------------ */

async function loadConversations(query = '') {
  try {
    const qs = query ? `?q=${encodeURIComponent(query)}` : '';
    const data = await api('/api/conversations' + qs);
    renderConversations(data.conversations || []);
  } catch (err) {
    toast('Could not load conversations: ' + err.message, 'error');
  }
}

function renderConversations(list) {
  dom.conversationList.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = dom.searchInput.value ? 'No matches.' : 'No conversations yet.';
    dom.conversationList.appendChild(empty);
    return;
  }
  for (const conv of list) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (conv.id === state.conversationId ? ' is-active' : '');
    item.dataset.id = conv.id;
    item.setAttribute('role', 'listitem');

    const main = document.createElement('div');
    main.className = 'conv-main';
    const title = document.createElement('div');
    title.className = 'conv-title';
    title.textContent = conv.title || 'New conversation';
    const sub = document.createElement('div');
    sub.className = 'conv-sub';
    sub.textContent = `${conv.message_count || 0} message${conv.message_count === 1 ? '' : 's'} · ${fmtTime(conv.updated_at)}`;
    main.appendChild(title);
    main.appendChild(sub);

    const del = document.createElement('button');
    del.className = 'conv-del';
    del.type = 'button';
    del.title = 'Delete conversation';
    del.setAttribute('aria-label', 'Delete conversation');
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(conv.id, conv.title);
    });

    item.appendChild(main);
    item.appendChild(del);
    item.addEventListener('click', () => openConversation(conv.id));
    title.addEventListener('dblclick', (e) => { e.stopPropagation(); beginRename(conv.id, title); });

    dom.conversationList.appendChild(item);
  }
}

async function openConversation(id) {
  if (state.streaming) { toast('Please wait for the current reply to finish.', 'warn'); return; }
  try {
    const data = await api('/api/conversations/' + id);
    state.conversationId = id;
    state.lastAssistantText = '';
    dom.convTitle.textContent = data.conversation.title || 'Conversation';
    renderMessages(data.messages || []);
    highlightActive();
    closeSidebar();
  } catch (err) {
    toast('Could not open conversation: ' + err.message, 'error');
  }
}

function highlightActive() {
  for (const el of dom.conversationList.querySelectorAll('.conv-item')) {
    el.classList.toggle('is-active', Number(el.dataset.id) === state.conversationId);
  }
}

async function newConversation() {
  if (state.streaming) { toast('Please wait for the current reply to finish.', 'warn'); return; }
  try {
    const data = await api('/api/conversations', { method: 'POST', body: { title: 'New conversation' } });
    state.conversationId = data.conversation.id;
    state.lastAssistantText = '';
    dom.convTitle.textContent = 'New conversation';
    renderMessages([]);
    await loadConversations(dom.searchInput.value);
    closeSidebar();
  } catch (err) {
    toast('Could not create conversation: ' + err.message, 'error');
  }
}

async function deleteConversation(id, title) {
  const ok = window.confirm(`Delete "${title || 'this conversation'}"? This cannot be undone.`);
  if (!ok) return;
  try {
    await api('/api/conversations/' + id, { method: 'DELETE' });
    if (state.conversationId === id) {
      state.conversationId = null;
      dom.convTitle.textContent = 'New conversation';
      renderMessages([]);
    }
    await loadConversations(dom.searchInput.value);
    toast('Conversation deleted.');
  } catch (err) {
    toast('Could not delete: ' + err.message, 'error');
  }
}

function beginRename(id, titleEl) {
  const current = titleEl.textContent;
  const input = document.createElement('input');
  input.className = 'input';
  input.value = current;
  input.style.fontSize = '13px';
  input.style.padding = '4px 6px';
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const value = input.value.trim();
    if (!value || value === current) { input.replaceWith(titleEl); return; }
    try {
      await api('/api/conversations/' + id, { method: 'PATCH', body: { title: value } });
      titleEl.textContent = value;
      if (state.conversationId === id) dom.convTitle.textContent = value;
      input.replaceWith(titleEl);
      await loadConversations(dom.searchInput.value);
    } catch (err) {
      toast('Rename failed: ' + err.message, 'error');
      input.replaceWith(titleEl);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { input.replaceWith(titleEl); }
  });
  input.addEventListener('blur', commit);
}

/* ------------------------------------------------------------------ */
/* Message rendering                                                  */
/* ------------------------------------------------------------------ */

function clearConversationView() {
  dom.conversation.innerHTML = '';
  dom.conversation.appendChild(dom.emptyState);
  dom.emptyState.hidden = false;
}

function renderMessages(messages) {
  dom.conversation.innerHTML = '';
  if (!messages.length) {
    dom.conversation.appendChild(dom.emptyState);
    dom.emptyState.hidden = false;
    return;
  }
  dom.emptyState.hidden = true;
  for (const m of messages) appendMessageEl(m.role, m.content, m.id, m.created_at);
  scrollToBottom(true);
}

function appendMessageEl(role, content, id, createdAt) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-' + (role === 'user' ? 'user' : 'assistant');
  if (id != null) wrap.dataset.id = String(id);

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = role === 'user' ? '🧑' : '🤖';

  const body = document.createElement('div');
  body.className = 'msg-body';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = renderMarkdown(content || '');

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = fmtTime(createdAt || new Date().toISOString());

  body.appendChild(bubble);
  body.appendChild(meta);
  wrap.appendChild(avatar);
  wrap.appendChild(body);
  dom.conversation.appendChild(wrap);
  return wrap;
}

function bubbleOf(wrap) { return wrap ? wrap.querySelector('.msg-bubble') : null; }

let scrollQueued = false;
function scrollToBottom(force = false) {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    const el = dom.conversation;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 180;
    if (force || nearBottom) el.scrollTop = el.scrollHeight;
  });
}

function streamRender(bubble, text) {
  bubble._md = text;
  if (bubble._raf) return;
  bubble._raf = requestAnimationFrame(() => {
    bubble._raf = null;
    bubble.innerHTML = renderMarkdown(bubble._md || '');
    scrollToBottom();
  });
}

/* ------------------------------------------------------------------ */
/* Chat flow                                                          */
/* ------------------------------------------------------------------ */

let pendingUserEl = null;

function sendMessage(text) {
  const content = String(text || '').trim();
  if (!content) return;
  if (state.streaming) { toast('A reply is already in progress.', 'warn'); return; }
  if (!state.settings || !state.settings.ai.baseUrl || !state.settings.ai.model) {
    toast('Configure your AI endpoint in Settings first.', 'warn');
    openSettings();
    return;
  }

  dom.emptyState.hidden = true;
  pendingUserEl = appendMessageEl('user', content, null, new Date().toISOString());
  scrollToBottom(true);

  const requestId = uuid();
  state.activeRequestId = requestId;
  state.streaming = true;
  setStatus('processing', 'Waiting for the model…');
  dom.sendBtn.disabled = true;

  socket.emit('chat:send', { requestId, content, conversationId: state.conversationId });
}

function onChatStart(payload) {
  if (payload.requestId !== state.activeRequestId) return;
  if (payload.conversation) {
    state.conversationId = payload.conversation.id;
    dom.convTitle.textContent = payload.conversation.title || 'Conversation';
  }
  if (pendingUserEl && payload.userMessageId != null) {
    pendingUserEl.dataset.id = String(payload.userMessageId);
    pendingUserEl = null;
  }
  const wrap = appendMessageEl('assistant', '', payload.assistantMessageId, new Date().toISOString());
  wrap.classList.add('is-streaming');
  wrap.dataset.requestId = payload.requestId;
  scrollToBottom(true);
  if (payload.createdConversation) loadConversations(dom.searchInput.value);
}

function onChatDelta(payload) {
  if (payload.requestId !== state.activeRequestId) return;
  const wrap = dom.conversation.querySelector(`.msg-assistant[data-request-id="${payload.requestId}"]`);
  if (!wrap) return;
  const bubble = bubbleOf(wrap);
  streamRender(bubble, (bubble._md || '') + (payload.text || ''));
}

function onChatDone(payload) {
  if (payload.requestId !== state.activeRequestId) return;
  const wrap = dom.conversation.querySelector(`.msg-assistant[data-request-id="${payload.requestId}"]`);
  if (wrap) {
    wrap.classList.remove('is-streaming');
    const bubble = bubbleOf(wrap);
    bubble._md = payload.content || bubble._md || '';
    bubble.innerHTML = renderMarkdown(bubble._md);
  }
  finishStream();
  state.lastAssistantText = payload.content || '';
  if (state.lastAssistantText && state.settings && state.settings.voice.autoSpeak && !state.muted) {
    speak(state.lastAssistantText);
  }
  loadConversations(dom.searchInput.value);
}

function onChatError(payload) {
  if (payload.requestId !== state.activeRequestId) return;
  const wrap = dom.conversation.querySelector(`.msg-assistant[data-request-id="${payload.requestId}"]`);
  if (wrap) {
    wrap.classList.remove('is-streaming');
    wrap.classList.add('is-error');
    const bubble = bubbleOf(wrap);
    bubble.innerHTML = renderMarkdown('⚠️ ' + (payload.message || 'The request failed.'));
  } else if (pendingUserEl) {
    pendingUserEl.remove();
    pendingUserEl = null;
  }
  finishStream();
  toast(payload.message || 'The AI request failed.', 'error');
}

function onChatCancelled(payload) {
  if (payload.requestId !== state.activeRequestId) return;
  const wrap = dom.conversation.querySelector(`.msg-assistant[data-request-id="${payload.requestId}"]`);
  if (wrap) {
    wrap.classList.remove('is-streaming');
    const bubble = bubbleOf(wrap);
    bubble._md = payload.content || bubble._md || '';
    bubble.innerHTML = renderMarkdown(bubble._md) || '<em>Stopped.</em>';
  }
  finishStream();
}

function finishStream() {
  state.streaming = false;
  state.activeRequestId = null;
  pendingUserEl = null;
  dom.sendBtn.disabled = false;
  if (!audio.isSpeaking()) setStatus('idle');
}

function cancelActiveRequest() {
  if (state.streaming && state.activeRequestId && socket) {
    socket.emit('chat:cancel', { requestId: state.activeRequestId });
  }
}

/* ------------------------------------------------------------------ */
/* Speech output                                                      */
/* ------------------------------------------------------------------ */

async function speak(text) {
  const clean = stripForSpeech(text);
  if (!clean) return;
  const s = state.settings;
  if (!s) return;
  if ((s.tts.provider === 'api' && s.tts.baseUrl) || s.tts.provider === 'piper') {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': state.csrf || '' },
        body: JSON.stringify({ text: clean })
      });
      if (!res.ok) {
        let msg = `Speech request failed (${res.status})`;
        try { const j = await res.json(); msg = j.error || msg; } catch (_) { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      await audio.playBlob(blob);
    } catch (err) {
      toast('Speech API failed, using browser voice: ' + err.message, 'warn');
      try { await speakBrowser(clean); } catch (e2) { toast('Speech failed: ' + e2.message, 'error'); }
    }
  } else {
    try {
      await speakBrowser(clean);
    } catch (err) {
      toast('Speech failed: ' + err.message, 'error');
    }
  }
}

function speakBrowser(clean) {
  const s = state.settings;
  return audio.speakBrowser(clean, {
    voiceName: state.browserVoice,
    rate: s.tts.rate,
    pitch: s.tts.pitch,
    volume: s.tts.volume
  });
}

/* ------------------------------------------------------------------ */
/* Voice input                                                        */
/* ------------------------------------------------------------------ */

function refreshCapabilities() {
  const caps = audio.capabilities();
  const parts = [];
  parts.push(caps.getUserMedia ? 'microphone ✓' : 'microphone ✗');
  parts.push(caps.speechRecognition ? 'speech recognition ✓' : 'speech recognition ✗');
  parts.push(caps.speechSynthesis ? 'speech synthesis ✓' : 'speech synthesis ✗');
  parts.push(caps.secureContext ? 'secure context ✓' : 'insecure context (mic blocked)');
  const el = $('browser-capabilities');
  if (el) el.textContent = parts.join(' · ');
  return caps;
}

async function loadMicDevices() {
  const select = $('set-mic-device');
  try {
    const devices = await audio.listMicrophones();
    select.innerHTML = '<option value="">System default</option>';
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label;
      select.appendChild(opt);
    }
    state.micDevicesLoaded = devices.length > 0;
    if (state.settings) select.value = state.settings.voice.micDeviceId || '';
  } catch (_) { /* labels may be unavailable without permission */ }
}

function populateBrowserVoices() {
  const select = $('set-browser-voice');
  if (!select) return;
  const voices = audio.listVoices();
  select.innerHTML = '<option value="">Default</option>';
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    select.appendChild(opt);
  }
  select.value = state.browserVoice || '';
}

function micError(err) {
  const name = err && err.name ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    toast('Microphone permission was denied. Enable it in your browser settings.', 'error');
  } else if (name === 'NotFoundError') {
    toast('No microphone was found.', 'error');
  } else {
    toast('Microphone error: ' + (err.message || name || 'unknown'), 'error');
  }
  setStatus('error', 'Microphone unavailable');
  setTimeout(() => { if (!state.voiceActive) setStatus('idle'); }, 2500);
}

function shouldUseRecognition() {
  const caps = audio.capabilities();
  return caps.speechRecognition && state.settings && state.settings.voice.browserTranscription;
}

function startListening() {
  if (state.voiceActive) return;
  if (state.streaming) { toast('Waiting for the current reply…', 'warn'); return; }
  if (audio.isSpeaking()) audio.stopSpeaking();

  state.recognitionBuffer = '';
  state.recognitionInterim = '';

  if (shouldUseRecognition()) {
    state.voiceActive = 'recognition';
    setStatus('listening', 'Speak now…');
    if (!audio.startRecognition({ continuous: false })) {
      state.voiceActive = null;
      toast('Speech recognition could not start.', 'error');
      setStatus('idle');
    }
    return;
  }

  if (!audio.capabilities().mediaRecorder) {
    toast('This browser cannot record audio. Use text input or configure a transcription endpoint.', 'error');
    return;
  }
  state.voiceActive = 'recording';
  setStatus('listening', 'Speak now…');
  audio.startRecording(state.settings.voice.micDeviceId)
    .then(() => { loadMicDevices(); })
    .catch((err) => { state.voiceActive = null; micError(err); });
}

async function stopListening() {
  if (state.voiceActive === 'recognition') {
    audio.stopRecognition();
    return; // final text is dispatched from onRecognitionEnd
  }
  if (state.voiceActive === 'recording') {
    const mode = state.voiceActive;
    state.voiceActive = null;
    let blob = null;
    try { blob = await audio.stopRecording(); } catch (_) { /* ignore */ }
    setStatus('processing', 'Transcribing…');
    if (blob && blob.size > 0) {
      await transcribeAndSend(blob);
    } else {
      setStatus('idle');
    }
    return mode;
  }
}

function onRecognitionResult({ final, interim }) {
  if (final) state.recognitionBuffer += final;
  state.recognitionInterim = interim || '';
  const preview = (state.recognitionBuffer + ' ' + state.recognitionInterim).trim();
  if (state.continuousActive) {
    if (final && final.trim()) {
      const text = (state.recognitionBuffer + ' ' + final).trim();
      state.recognitionBuffer = '';
      state.recognitionInterim = '';
      submitTranscript(text);
    } else {
      setStatus('listening', preview ? '“' + preview + '”' : 'Listening…');
    }
  } else if (state.voiceActive === 'recognition') {
    setStatus('listening', preview ? '“' + preview + '”' : 'Speak now…');
  }
}

function onRecognitionError(code) {
  if (code === 'no-speech' || code === 'aborted') return;
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    toast('Speech recognition permission was denied.', 'error');
  } else if (code === 'audio-capture') {
    toast('No microphone detected.', 'error');
  } else if (code === 'network') {
    toast('Speech recognition network error.', 'error');
  } else {
    toast('Speech recognition error: ' + code, 'error');
  }
}

function onRecognitionEnd({ manual }) {
  if (state.continuousActive) {
    if (!manual && state.continuousActive) {
      setTimeout(() => {
        if (state.continuousActive) audio.startRecognition({ continuous: true });
      }, 250);
    }
    return;
  }
  if (state.voiceActive === 'recognition') {
    state.voiceActive = null;
    const text = state.recognitionBuffer.trim();
    state.recognitionBuffer = '';
    state.recognitionInterim = '';
    if (text) {
      submitTranscript(text);
    } else {
      setStatus('idle', 'No speech detected.');
      setTimeout(() => { if (!state.voiceActive && !state.streaming) setStatus('idle'); }, 2000);
    }
  }
}

function submitTranscript(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  if (state.streaming) { toast('A reply is already in progress.', 'warn'); return; }
  sendMessage(clean);
}

async function transcribeAndSend(blob) {
  if (!state.settings.transcription.baseUrl) {
    toast('No server transcription endpoint is configured. Enable it in Settings → Voice.', 'error');
    setStatus('idle');
    return;
  }
  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': blob.type || 'audio/webm',
        'x-csrf-token': state.csrf || ''
      },
      body: blob
    });
    const ct = res.headers.get('content-type') || '';
    let data = null;
    if (ct.includes('application/json')) data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || `Transcription failed (${res.status})`);
    const text = (data && data.text) || '';
    if (text.trim()) submitTranscript(text);
    else { setStatus('idle', 'No speech detected.'); }
  } catch (err) {
    toast('Transcription failed: ' + err.message, 'error');
    setStatus('error', 'Transcription failed');
    setTimeout(() => { if (!state.streaming) setStatus('idle'); }, 2500);
  }
}

/* ---- Continuous mode ---------------------------------------------- */

async function startContinuous() {
  state.continuousActive = true;
  dom.modeToggle.textContent = 'Mode: Continuous';
  dom.modeToggle.setAttribute('aria-pressed', 'true');
  dom.pttBtn.classList.add('is-recording');
  dom.pttLabel.textContent = 'Listening (tap to stop)';
  setStatus('listening', 'Continuous listening…');

  if (shouldUseRecognition()) {
    state.voiceActive = 'recognition';
    if (!audio.startRecognition({ continuous: true })) {
      toast('Continuous listening could not start.', 'error');
      stopContinuous();
    }
    return;
  }

  // Fallback: record utterances with simple voice-activity detection and
  // send each to the server transcription endpoint.
  if (!audio.capabilities().mediaRecorder || !state.settings.transcription.baseUrl) {
    toast('Continuous mode needs browser speech recognition or a transcription endpoint.', 'error');
    stopContinuous();
    return;
  }
  try {
    await audio.ensureStream(state.settings.voice.micDeviceId);
    vad.active = true;
    vad.recording = false;
    vad.busy = false;
    vad.lastVoice = performance.now();
    audio.startWaveform('mic');
    loadMicDevices();
  } catch (err) {
    stopContinuous();
    micError(err);
  }
}

async function startVadSegment() {
  if (vad.recording) return;
  vad.recording = true;
  try {
    await audio.startRecording(state.settings.voice.micDeviceId);
  } catch (_) {
    vad.recording = false;
  }
}

async function stopVadSegment() {
  if (!vad.recording) return;
  vad.recording = false;
  vad.busy = true;
  let blob = null;
  try { blob = await audio.stopRecording(); } catch (_) { /* ignore */ }
  if (vad.active) audio.startWaveform('mic');
  if (blob && blob.size > 1200) {
    try {
      await transcribeAndSend(blob);
    } catch (_) { /* handled in transcribeAndSend */ }
  }
  vad.busy = false;
}

function stopContinuous() {
  state.continuousActive = false;
  dom.modeToggle.textContent = 'Mode: Push-to-talk';
  dom.modeToggle.setAttribute('aria-pressed', 'false');
  dom.pttBtn.classList.remove('is-recording');
  dom.pttLabel.textContent = 'Hold to talk';

  if (state.voiceActive === 'recognition') audio.stopRecognition();
  state.voiceActive = null;

  if (vad.active) {
    vad.active = false;
    if (vad.recording) stopVadSegment();
    audio.stopWaveform();
  }
  if (!state.streaming) setStatus('idle');
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

function applySettings(s) {
  state.settings = s;
  if (dom.modelLabel) dom.modelLabel.textContent = s.ai && s.ai.model ? s.ai.model : 'No model';
  if (s.ui && s.ui.accent) applyAccent(s.ui.accent);
  fillSettingsForm();
}

function fillSettingsForm() {
  const s = state.settings;
  if (!s) return;
  $('set-ai-provider').value = s.ai.provider || '';
  $('set-ai-url').value = s.ai.baseUrl || '';
  $('set-ai-model').value = s.ai.model || '';
  $('set-ai-timeout').value = s.ai.timeoutMs || 120000;
  $('ai-key-hint').textContent = s.ai.hasApiKey ? `Key saved (${s.ai.apiKeyMasked})` : 'No API key saved.';

  $('set-voice-mode').value = s.voice.mode || 'ptt';
  $('set-auto-speak').checked = Boolean(s.voice.autoSpeak);
  $('set-browser-transcription').checked = Boolean(s.voice.browserTranscription);
  if ($('set-mic-device').options.length) $('set-mic-device').value = s.voice.micDeviceId || '';

  $('set-tr-url').value = s.transcription.baseUrl || '';
  $('set-tr-style').value = s.transcription.apiStyle || 'openai';
  $('set-tr-model').value = s.transcription.model || '';
  $('tr-key-hint').textContent = s.transcription.hasApiKey ? `Key saved (${s.transcription.apiKeyMasked})` : 'No API key saved.';

  $('set-tts-provider').value = s.tts.provider || 'browser';
  $('set-tts-url').value = s.tts.baseUrl || '';
  $('set-tts-model').value = s.tts.model || '';
  $('set-tts-voice').value = s.tts.voice || '';
  $('set-piper-path').value = s.tts.piperPath || '';
  $('set-piper-voice').value = s.tts.piperVoice || '';
  $('tts-key-hint').textContent = s.tts.hasApiKey ? `Key saved (${s.tts.apiKeyMasked})` : 'No API key saved.';
  $('set-rate').value = s.tts.rate;
  $('set-pitch').value = s.tts.pitch;
  $('set-volume').value = s.tts.volume;
  $('rate-value').textContent = Number(s.tts.rate).toFixed(1);
  $('pitch-value').textContent = Number(s.tts.pitch).toFixed(1);
  $('vol-value').textContent = Number(s.tts.volume).toFixed(1);

  $('set-system-prompt').value = s.systemPrompt || '';
  $('set-retention').value = s.retentionDays || 0;
  $('set-accent').value = (s.ui && s.ui.accent) || '#4CAF50';

  $('set-browser-voice').value = state.browserVoice || '';
  toggleTtsFields();
  updateModeLabel();
}

function toggleTtsFields() {
  const provider = $('set-tts-provider').value;
  $('tts-api-fields').style.display = provider === 'api' ? '' : 'none';
  $('tts-piper-fields').style.display = provider === 'piper' ? '' : 'none';
  $('tts-browser-fields').style.display = provider === 'browser' ? '' : 'none';
}

function updateModeLabel() {
  const mode = state.settings ? state.settings.voice.mode : 'ptt';
  dom.modeToggle.textContent = mode === 'continuous' ? 'Mode: Continuous' : 'Mode: Push-to-talk';
  dom.modeToggle.setAttribute('aria-pressed', mode === 'continuous' ? 'true' : 'false');
}

function collectSettingsPayload() {
  const settings = {
    ai: {
      provider: $('set-ai-provider').value.trim(),
      baseUrl: $('set-ai-url').value.trim(),
      model: $('set-ai-model').value.trim(),
      timeoutMs: Number($('set-ai-timeout').value) || 120000
    },
    transcription: {
      baseUrl: $('set-tr-url').value.trim(),
      apiStyle: $('set-tr-style').value,
      model: $('set-tr-model').value.trim()
    },
    tts: {
      provider: $('set-tts-provider').value,
      baseUrl: $('set-tts-url').value.trim(),
      model: $('set-tts-model').value.trim(),
      voice: $('set-tts-voice').value.trim(),
      piperPath: $('set-piper-path').value.trim(),
      piperVoice: $('set-piper-voice').value.trim(),
      rate: Number($('set-rate').value),
      pitch: Number($('set-pitch').value),
      volume: Number($('set-volume').value)
    },
    voice: {
      mode: $('set-voice-mode').value,
      micDeviceId: $('set-mic-device').value,
      autoSpeak: $('set-auto-speak').checked,
      browserTranscription: $('set-browser-transcription').checked
    },
    ui: { accent: $('set-accent').value },
    systemPrompt: $('set-system-prompt').value,
    retentionDays: Number($('set-retention').value) || 0
  };

  const secrets = {};
  const aiKey = $('set-ai-key').value.trim();
  const trKey = $('set-tr-key').value.trim();
  const ttsKey = $('set-tts-key').value.trim();
  if (aiKey) secrets.aiApiKey = aiKey;
  if (trKey) secrets.transcriptionApiKey = trKey;
  if (ttsKey) secrets.ttsApiKey = ttsKey;

  return { settings, secrets };
}

async function saveSettings({ silent = false } = {}) {
  const { settings, secrets } = collectSettingsPayload();
  const body = { settings };
  if (Object.keys(secrets).length) body.secrets = secrets;
  try {
    const data = await api('/api/settings', { method: 'PUT', body });
    applySettings(data.settings);
    $('set-ai-key').value = '';
    $('set-tr-key').value = '';
    $('set-tts-key').value = '';
    if (!silent) inlineResult(dom.settingsStatus, 'Settings saved.', 'ok');
    return true;
  } catch (err) {
    inlineResult(dom.settingsStatus, err.message, 'err');
    toast('Could not save settings: ' + err.message, 'error');
    return false;
  }
}

async function testProvider(kind, resultEl) {
  inlineResult(resultEl, 'Testing…');
  const saved = await saveSettings({ silent: true });
  if (!saved) { inlineResult(resultEl, 'Save failed.', 'err'); return; }
  try {
    const data = await api('/api/settings/test', { method: 'POST', body: { kind } });
    if (kind === 'ai') {
      inlineResult(resultEl, `OK · ${data.model} · ${data.latencyMs}ms · "${data.reply}"`, 'ok');
    } else if (kind === 'transcription') {
      inlineResult(resultEl, `OK · endpoint reachable · reply: "${data.reply || '(empty)'}"`, 'ok');
    } else {
      inlineResult(resultEl, `OK · ${data.bytes} bytes of ${data.contentType}`, 'ok');
    }
  } catch (err) {
    inlineResult(resultEl, err.message, 'err');
  }
}

function openSettings() {
  fillSettingsForm();
  inlineResult(dom.settingsStatus, '');
  dom.settingsOverlay.hidden = false;
  populateBrowserVoices();
  loadMicDevices();
}

function closeSettings() {
  dom.settingsOverlay.hidden = true;
}

async function exportConversation(format) {
  if (!state.conversationId) { toast('Open a conversation first.', 'warn'); return; }
  try {
    const res = await fetch(`/api/conversations/${state.conversationId}/export?format=${format}`, {
      credentials: 'include'
    });
    if (!res.ok) {
      let msg = `Export failed (${res.status})`;
      try { const j = await res.json(); msg = j.error || msg; } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversation-${state.conversationId}.${format === 'json' ? 'json' : 'txt'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Export downloaded.');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Sidebar / responsive                                               */
/* ------------------------------------------------------------------ */

function openSidebar() {
  document.body.classList.add('sidebar-open');
  dom.sidebarScrim.hidden = false;
  dom.menuToggle.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  dom.sidebarScrim.hidden = true;
  dom.menuToggle.setAttribute('aria-expanded', 'false');
}

function applyTextOnly(on) {
  state.textOnly = on;
  localStorage.setItem('avd.textOnly', on ? '1' : '0');
  document.body.classList.toggle('text-only', on);
  dom.toggleTextMode.textContent = 'Text-only mode: ' + (on ? 'on' : 'off');
  dom.toggleTextMode.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (on && state.continuousActive) stopContinuous();
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                       */
/* ------------------------------------------------------------------ */

function autoGrow() {
  const el = dom.messageInput;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

function bindUI() {
  dom.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = dom.messageInput.value.trim();
    if (!text) return;
    dom.messageInput.value = '';
    autoGrow();
    sendMessage(text);
  });

  dom.messageInput.addEventListener('input', autoGrow);
  dom.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      dom.composer.requestSubmit();
    }
  });

  // Push-to-talk
  const pttDown = (e) => {
    e.preventDefault();
    if (state.continuousActive) { stopContinuous(); return; }
    startListening();
  };
  const pttUp = (e) => {
    e.preventDefault();
    if (state.continuousActive) return;
    stopListening();
  };
  dom.pttBtn.addEventListener('pointerdown', pttDown);
  dom.pttBtn.addEventListener('pointerup', pttUp);
  dom.pttBtn.addEventListener('pointerleave', (e) => { if (state.voiceActive) pttUp(e); });
  dom.pttBtn.addEventListener('pointercancel', pttUp);
  dom.pttBtn.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!state.voiceActive) startListening(); }
  });
  dom.pttBtn.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stopListening(); }
  });

  dom.modeToggle.addEventListener('click', () => {
    if (!state.settings) return;
    if (state.continuousActive) { stopContinuous(); return; }
    const next = state.settings.voice.mode === 'continuous' ? 'ptt' : 'continuous';
    state.settings.voice.mode = next;
    updateModeLabel();
    const select = $('set-voice-mode');
    if (select) select.value = next;
    api('/api/settings', { method: 'PUT', body: { settings: { voice: { mode: next } } } })
      .then((data) => { if (data && data.settings) state.settings = data.settings; })
      .catch((err) => toast('Could not save voice mode: ' + err.message, 'error'));
    if (next === 'continuous') startContinuous();
  });

  dom.stopBtn.addEventListener('click', () => {
    cancelActiveRequest();
    audio.stopSpeaking();
    if (state.voiceActive) stopListening();
    if (state.continuousActive) stopContinuous();
    if (!state.streaming) setStatus('idle');
  });

  dom.replayBtn.addEventListener('click', () => {
    if (state.lastAssistantText) speak(state.lastAssistantText);
    else toast('Nothing to replay yet.', 'warn');
  });

  dom.muteBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    dom.muteBtn.setAttribute('aria-pressed', state.muted ? 'true' : 'false');
    dom.muteBtn.textContent = state.muted ? '🔇' : '🔊';
    if (state.muted) audio.stopSpeaking();
    toast(state.muted ? 'Assistant speech muted.' : 'Assistant speech unmuted.');
  });

  dom.clearBtn.addEventListener('click', () => {
    if (state.streaming) cancelActiveRequest();
    audio.stopSpeaking();
    newConversation();
  });

  dom.newConversation.addEventListener('click', newConversation);

  let searchTimer = null;
  dom.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadConversations(dom.searchInput.value.trim()), 250);
  });

  dom.toggleTextMode.addEventListener('click', () => applyTextOnly(!state.textOnly));

  dom.menuToggle.addEventListener('click', () => {
    if (document.body.classList.contains('sidebar-open')) closeSidebar();
    else openSidebar();
  });
  dom.sidebarScrim.addEventListener('click', closeSidebar);

  dom.openSettings.addEventListener('click', openSettings);
  dom.closeSettings.addEventListener('click', closeSettings);
  dom.cancelSettings.addEventListener('click', () => { fillSettingsForm(); closeSettings(); });
  dom.saveSettings.addEventListener('click', () => saveSettings());

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) {
        const active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      for (const panel of document.querySelectorAll('.tab-panel')) {
        panel.classList.toggle('is-active', panel.dataset.panel === tab.dataset.tab);
      }
    });
  }

  $('set-tts-provider').addEventListener('change', toggleTtsFields);
  $('set-rate').addEventListener('input', (e) => { $('rate-value').textContent = Number(e.target.value).toFixed(1); });
  $('set-pitch').addEventListener('input', (e) => { $('pitch-value').textContent = Number(e.target.value).toFixed(1); });
  $('set-volume').addEventListener('input', (e) => { $('vol-value').textContent = Number(e.target.value).toFixed(1); });
  $('set-accent').addEventListener('input', (e) => applyAccent(e.target.value));

  $('set-browser-voice').addEventListener('change', (e) => {
    state.browserVoice = e.target.value;
    localStorage.setItem('avd.browserVoice', state.browserVoice);
  });

  $('test-ai').addEventListener('click', () => testProvider('ai', $('test-ai-result')));
  $('test-tr').addEventListener('click', () => testProvider('transcription', $('test-tr-result')));
  $('test-tts').addEventListener('click', () => testProvider('tts', $('test-tts-result')));

  $('export-txt').addEventListener('click', () => exportConversation('txt'));
  $('export-json').addEventListener('click', () => exportConversation('json'));

  $('logout-btn').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch (_) { /* ignore */ }
    window.location.reload();
  });

  dom.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    dom.loginError.hidden = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: dom.loginPassword.value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        dom.loginError.textContent = data.error || 'Sign in failed.';
        dom.loginError.hidden = false;
        return;
      }
      state.csrf = data.csrf || state.csrf;
      state.authenticated = true;
      if (data.settings) applySettings(data.settings);
      hideLogin();
      startApp();
    } catch (err) {
      dom.loginError.textContent = 'Sign in failed: ' + err.message;
      dom.loginError.hidden = false;
    }
  });

  // Global keyboard shortcut: Escape closes modals / stops speech.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!dom.settingsOverlay.hidden) closeSettings();
      else if (!dom.loginOverlay.hidden) { /* keep login open */ }
      else { audio.stopSpeaking(); if (state.streaming) cancelActiveRequest(); }
    }
  });

  window.addEventListener('beforeunload', () => { try { audio.destroy(); } catch (_) { /* ignore */ } });

  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = populateBrowserVoices;
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

bindUI();
bootstrap();
