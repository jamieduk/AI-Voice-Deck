'use strict';

const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

let db = null;

function init() {
  config.ensureDir(config.DATA_DIR);
  db = new DatabaseSync(config.DB_FILE);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 'New conversation',
      system_prompt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content TEXT NOT NULL DEFAULT '',
      meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages (conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_content
      ON messages (content);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated
      ON conversations (updated_at DESC);
  `);
  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function createConversation(title = 'New conversation', systemPrompt = '') {
  const stmt = getDb().prepare(
    'INSERT INTO conversations (title, system_prompt, updated_at) VALUES (?, ?, ?)'
  );
  const info = stmt.run(String(title).slice(0, 200), String(systemPrompt).slice(0, 8000), nowIso());
  return getConversation(Number(info.lastInsertRowid));
}

function getConversation(id) {
  const row = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(Number(id));
  return row || null;
}

function listConversations(search = '') {
  const term = String(search || '').trim();
  if (term) {
    const like = `%${term}%`;
    return getDb().prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
      FROM conversations c
      WHERE c.title LIKE ? OR EXISTS (
        SELECT 1 FROM messages m2 WHERE m2.conversation_id = c.id AND m2.content LIKE ?
      )
      ORDER BY c.updated_at DESC, c.id DESC
    `).all(like, like);
  }
  return getDb().prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c
    ORDER BY c.updated_at DESC, c.id DESC
  `).all();
}

function renameConversation(id, title) {
  getDb().prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(String(title).slice(0, 200), nowIso(), Number(id));
  return getConversation(id);
}

function deleteConversation(id) {
  const info = getDb().prepare('DELETE FROM conversations WHERE id = ?').run(Number(id));
  return info.changes > 0;
}

function touchConversation(id) {
  getDb().prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(nowIso(), Number(id));
}

function getMessages(conversationId) {
  const rows = getDb().prepare(
    'SELECT id, role, content, meta, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(Number(conversationId));
  return rows.map((r) => ({ ...r, meta: safeParse(r.meta) }));
}

function addMessage(conversationId, role, content, meta = {}) {
  const stmt = getDb().prepare(
    'INSERT INTO messages (conversation_id, role, content, meta) VALUES (?, ?, ?, ?)'
  );
  const info = stmt.run(
    Number(conversationId),
    ['user', 'assistant', 'system'].includes(role) ? role : 'assistant',
    String(content).slice(0, 200000),
    JSON.stringify(meta && typeof meta === 'object' ? meta : {})
  );
  touchConversation(conversationId);
  return Number(info.lastInsertRowid);
}

function updateMessage(messageId, content) {
  getDb().prepare('UPDATE messages SET content = ? WHERE id = ?')
    .run(String(content).slice(0, 200000), Number(messageId));
}

function searchMessages(query, limit = 50) {
  const term = String(query || '').trim();
  if (!term) return [];
  const like = `%${term}%`;
  return getDb().prepare(`
    SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title AS conversation_title
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.content LIKE ?
    ORDER BY m.id DESC
    LIMIT ?
  `).all(like, Math.min(Number(limit) || 50, 200));
}

function pruneOldConversations(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const cutoff = new Date(Date.now() - d * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const info = getDb().prepare('DELETE FROM conversations WHERE updated_at < ?').run(cutoff);
  return info.changes || 0;
}

function countConversations() {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM conversations').get();
  return row ? row.n : 0;
}

function safeParse(str) {
  try { return JSON.parse(str); } catch (_) { return {}; }
}

function close() {
  if (db) {
    try { db.close(); } catch (_) { /* ignore */ }
    db = null;
  }
}

module.exports = {
  init,
  close,
  createConversation,
  getConversation,
  listConversations,
  renameConversation,
  deleteConversation,
  touchConversation,
  getMessages,
  addMessage,
  updateMessage,
  searchMessages,
  pruneOldConversations,
  countConversations
};
