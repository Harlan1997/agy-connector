"use strict";

const fs = require("fs");
const path = require("path");
const { createLogger } = require("./logger");

const log = createLogger("session");

/**
 * Session represents a single conversation session.
 * Mirrors cc-connect core.Session.
 */
class Session {
  constructor(id, name = "") {
    this.id = id;
    this.name = name;
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
    this.history = [];
    this.locked = false;
  }

  addHistory(role, content) {
    this.history.push({ role, content, timestamp: new Date().toISOString() });
    this.updatedAt = new Date().toISOString();
  }

  tryLock() {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  unlock() {
    this.locked = false;
    this.updatedAt = new Date().toISOString();
  }
}

/**
 * SessionManager manages multiple sessions per chat key.
 * Mirrors cc-connect core.SessionManager with persistent JSON storage.
 */
class SessionManager {
  constructor(storePath) {
    this.storePath = storePath || "";
    // key -> { activeId, sessions: { id: Session } }
    this._store = new Map();
    this._load();
  }

  /**
   * Get or create the active session for a session key.
   * @param {string} key - Session key (chatId or chatId-threadId)
   * @returns {Session}
   */
  getOrCreateActive(key) {
    let data = this._store.get(key);
    if (!data) {
      const session = new Session(this._generateId());
      data = { activeId: session.id, sessions: { [session.id]: session } };
      this._store.set(key, data);
      this._save();
    }
    return data.sessions[data.activeId];
  }

  /**
   * Create a new session and make it active.
   * @param {string} key - Session key
   * @param {string} [name] - Optional session name
   * @returns {Session}
   */
  newSession(key, name = "") {
    let data = this._store.get(key);
    const session = new Session(this._generateId(), name);
    if (!data) {
      data = { activeId: session.id, sessions: {} };
      this._store.set(key, data);
    }
    data.sessions[session.id] = session;
    data.activeId = session.id;
    this._save();
    log.info(`new session created: ${session.id}${name ? ` (${name})` : ""}`, `key=${key}`);
    return session;
  }

  /**
   * List all sessions for a session key.
   * @param {string} key
   * @returns {Array<{id: string, name: string, createdAt: string, isActive: boolean}>}
   */
  listSessions(key) {
    const data = this._store.get(key);
    if (!data) return [];
    return Object.values(data.sessions).map(s => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      historyLen: s.history.length,
      isActive: s.id === data.activeId,
    })).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  /**
   * Switch to a different session.
   * @param {string} key - Session key
   * @param {string} targetId - Session ID to switch to
   * @returns {Session|null}
   */
  switchSession(key, targetId) {
    const data = this._store.get(key);
    if (!data) return null;
    // Match by ID prefix or by name
    const match = Object.values(data.sessions).find(
      s => s.id === targetId || s.id.startsWith(targetId) || (s.name && s.name === targetId)
    );
    if (!match) return null;
    data.activeId = match.id;
    this._save();
    log.info(`switched to session: ${match.id}`, `key=${key}`);
    return match;
  }

  /**
   * Delete a session.
   * @param {string} key - Session key
   * @param {string} targetId - Session ID to delete
   * @returns {boolean}
   */
  deleteSession(key, targetId) {
    const data = this._store.get(key);
    if (!data) return false;
    const match = Object.values(data.sessions).find(
      s => s.id === targetId || s.id.startsWith(targetId) || (s.name && s.name === targetId)
    );
    if (!match) return false;
    if (match.id === data.activeId) {
      // Can't delete active session, switch to another first
      const others = Object.keys(data.sessions).filter(id => id !== match.id);
      if (others.length > 0) {
        data.activeId = others[0];
      } else {
        // Create a new default session
        const newSession = new Session(this._generateId());
        data.sessions[newSession.id] = newSession;
        data.activeId = newSession.id;
      }
    }
    delete data.sessions[match.id];
    this._save();
    log.info(`deleted session: ${match.id}`, `key=${key}`);
    return true;
  }

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  _load() {
    if (!this.storePath) return;
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf8");
        const data = JSON.parse(raw);
        for (const [key, val] of Object.entries(data)) {
          // Rehydrate Session objects
          for (const [sid, sess] of Object.entries(val.sessions)) {
            const s = new Session(sess.id, sess.name);
            s.createdAt = sess.createdAt;
            s.updatedAt = sess.updatedAt;
            s.history = sess.history || [];
            val.sessions[sid] = s;
          }
          this._store.set(key, val);
        }
        log.info(`loaded ${this._store.size} session key(s) from ${this.storePath}`);
      }
    } catch (err) {
      log.warn(`failed to load sessions: ${err.message}`);
    }
  }

  _save() {
    if (!this.storePath) return;
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj = {};
      for (const [key, val] of this._store) {
        obj[key] = val;
      }
      fs.writeFileSync(this.storePath, JSON.stringify(obj, null, 2));
    } catch (err) {
      log.error(`failed to save sessions: ${err.message}`);
    }
  }
}

module.exports = { Session, SessionManager };
