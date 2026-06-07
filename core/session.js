"use strict";

const fs = require("fs");
const path = require("path");
const { createLogger } = require("./logger");

const log = createLogger("session");

/**
 * Project represents a workspace directory configuration.
 */
class Project {
  constructor(id, name, path) {
    this.id = id;
    this.name = name;
    this.path = path;
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
  }
}

/**
 * Session represents a single conversation session.
 * Mirrors cc-connect core.Session.
 */
class Session {
  constructor(id, name = "", projectId = "default") {
    this.id = id;
    this.name = name;
    this.projectId = projectId;
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
    this.history = [];
    this.locked = false;
    this.conversationId = ""; // agy conversation ID for context continuity
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
  constructor(storePath, defaultWorkspaceDir = "") {
    this.storePath = storePath || "";
    this.defaultWorkspaceDir = defaultWorkspaceDir || process.env.HOME || "/home/admin";
    // key -> { activeProjectId, projects: { id: Project }, projectActiveSessionId: { projectId: sessionId }, sessions: { id: Session } }
    this._store = new Map();
    this._load();
  }

  /**
   * Helper to ensure the database structure is initialized for a key.
   */
  _ensureInitialized(key) {
    let data = this._store.get(key);
    if (!data) {
      data = {
        activeProjectId: "default",
        projects: {
          "default": new Project("default", "default", this.defaultWorkspaceDir)
        },
        projectActiveSessionId: {},
        sessions: {}
      };
      this._store.set(key, data);
    } else {
      // Rehydrate / upgrade old store format
      if (!data.projects) {
        data.projects = {
          "default": new Project("default", "default", this.defaultWorkspaceDir)
        };
      }
      if (!data.activeProjectId) {
        data.activeProjectId = "default";
      }
      if (!data.projectActiveSessionId) {
        data.projectActiveSessionId = {};
        if (data.activeId) {
          data.projectActiveSessionId["default"] = data.activeId;
        }
      }
      if (!data.sessions) {
        data.sessions = {};
      }
    }
    return data;
  }

  /**
   * Get or create the active session for the active project of a session key.
   * @param {string} key - Session key (chatId or chatId-threadId)
   * @returns {Session}
   */
  getOrCreateActive(key) {
    const data = this._ensureInitialized(key);
    const projectId = data.activeProjectId;
    
    let activeSessionId = data.projectActiveSessionId[projectId];
    if (!activeSessionId || !data.sessions[activeSessionId]) {
      const session = new Session(this._generateId(), "", projectId);
      data.sessions[session.id] = session;
      data.projectActiveSessionId[projectId] = session.id;
      data.activeId = session.id; // For backwards compatibility
      this._save();
      return session;
    }
    return data.sessions[activeSessionId];
  }

  /**
   * Create a new session and make it active for the current workspace.
   * @param {string} key - Session key
   * @param {string} [name] - Optional session name
   * @returns {Session}
   */
  newSession(key, name = "") {
    const data = this._ensureInitialized(key);
    const projectId = data.activeProjectId;
    const session = new Session(this._generateId(), name, projectId);
    data.sessions[session.id] = session;
    data.projectActiveSessionId[projectId] = session.id;
    data.activeId = session.id; // For backwards compatibility
    this._save();
    log.info(`new session created: ${session.id}${name ? ` (${name})` : ""} under project ${projectId}`, `key=${key}`);
    return session;
  }

  /**
   * List all sessions for the active workspace of a session key.
   * @param {string} key
   * @returns {Array<{id: string, name: string, createdAt: string, isActive: boolean}>}
   */
  listSessions(key) {
    const data = this._ensureInitialized(key);
    const projectId = data.activeProjectId;
    const activeSessionId = data.projectActiveSessionId[projectId];

    return Object.values(data.sessions)
      .filter(s => s.projectId === projectId)
      .map(s => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        historyLen: s.history.length,
        isActive: s.id === activeSessionId,
      }))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  /**
   * Switch to a different session within the active workspace.
   * @param {string} key - Session key
   * @param {string} targetId - Session ID or name to switch to
   * @returns {Session|null}
   */
  switchSession(key, targetId) {
    const data = this._ensureInitialized(key);
    const projectId = data.activeProjectId;

    const projectSessions = Object.values(data.sessions).filter(s => s.projectId === projectId);
    const match = projectSessions.find(
      s => s.id === targetId || s.id.startsWith(targetId) || (s.name && s.name === targetId)
    );
    if (!match) return null;

    data.projectActiveSessionId[projectId] = match.id;
    data.activeId = match.id; // For backwards compatibility
    this._save();
    log.info(`switched to session: ${match.id} under project ${projectId}`, `key=${key}`);
    return match;
  }

  /**
   * Delete a session.
   * @param {string} key - Session key
   * @param {string} targetId - Session ID to delete
   * @returns {boolean}
   */
  deleteSession(key, targetId) {
    const data = this._ensureInitialized(key);
    const projectId = data.activeProjectId;

    const projectSessions = Object.values(data.sessions).filter(s => s.projectId === projectId);
    const match = projectSessions.find(
      s => s.id === targetId || s.id.startsWith(targetId) || (s.name && s.name === targetId)
    );
    if (!match) return false;

    const activeSessionId = data.projectActiveSessionId[projectId];
    if (match.id === activeSessionId) {
      // Can't delete active session, switch to another first in the same project
      const others = projectSessions.filter(s => s.id !== match.id);
      if (others.length > 0) {
        data.projectActiveSessionId[projectId] = others[0].id;
        data.activeId = others[0].id;
      } else {
        // Create a new default session for this project
        const newSession = new Session(this._generateId(), "", projectId);
        data.sessions[newSession.id] = newSession;
        data.projectActiveSessionId[projectId] = newSession.id;
        data.activeId = newSession.id;
      }
    }
    delete data.sessions[match.id];
    this._save();
    log.info(`deleted session: ${match.id} under project ${projectId}`, `key=${key}`);
    return true;
  }

  /**
   * Get or create the active project/workspace for a session key.
   * @param {string} key
   * @returns {Project}
   */
  getOrCreateActiveProject(key) {
    const data = this._ensureInitialized(key);
    const projectId = data.activeProjectId;
    let project = data.projects[projectId];
    if (!project) {
      project = data.projects["default"];
      data.activeProjectId = "default";
      this._save();
    }
    return project;
  }

  /**
   * Create a new project/workspace.
   * @param {string} key
   * @param {string} name
   * @param {string} path
   * @returns {Project}
   */
  createProject(key, name, path) {
    const data = this._ensureInitialized(key);
    const existing = Object.values(data.projects).find(
      p => p.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      throw new Error(`Workspace with name "${name}" already exists.`);
    }

    const id = "proj_" + Math.random().toString(36).slice(2, 10);
    const project = new Project(id, name, path);
    data.projects[id] = project;
    data.activeProjectId = id;
    this._save();
    log.info(`new project created: ${id} (${name}) -> ${path}`, `key=${key}`);
    return project;
  }

  /**
   * List all projects/workspaces for a session key.
   * @param {string} key
   * @returns {Array<{id: string, name: string, path: string, createdAt: string, isActive: boolean}>}
   */
  listProjects(key) {
    const data = this._ensureInitialized(key);
    const activeProjectId = data.activeProjectId;

    return Object.values(data.projects).map(p => ({
      id: p.id,
      name: p.name,
      path: p.path,
      createdAt: p.createdAt,
      isActive: p.id === activeProjectId,
    })).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  /**
   * Switch to a different project/workspace.
   * @param {string} key
   * @param {string} targetIdOrName
   * @returns {Project|null}
   */
  switchProject(key, targetIdOrName) {
    const data = this._ensureInitialized(key);
    const match = Object.values(data.projects).find(
      p => p.id === targetIdOrName || p.id.startsWith(targetIdOrName) || p.name.toLowerCase() === targetIdOrName.toLowerCase()
    );
    if (!match) return null;

    data.activeProjectId = match.id;
    this._save();
    log.info(`switched active project to: ${match.id} (${match.name})`, `key=${key}`);
    return match;
  }

  /**
   * Delete a project/workspace and all its sessions.
   * @param {string} key
   * @param {string} targetIdOrName
   * @returns {boolean}
   */
  deleteProject(key, targetIdOrName) {
    const data = this._ensureInitialized(key);
    const match = Object.values(data.projects).find(
      p => p.id === targetIdOrName || p.id.startsWith(targetIdOrName) || p.name.toLowerCase() === targetIdOrName.toLowerCase()
    );
    if (!match) return false;
    if (match.id === "default") {
      throw new Error("Cannot delete the default workspace.");
    }

    if (match.id === data.activeProjectId) {
      data.activeProjectId = "default";
    }

    // Delete all sessions associated with this project
    for (const [sid, sess] of Object.entries(data.sessions)) {
      if (sess.projectId === match.id) {
        delete data.sessions[sid];
      }
    }

    delete data.projects[match.id];
    delete data.projectActiveSessionId[match.id];
    this._save();
    log.info(`deleted project: ${match.id} (${match.name})`, `key=${key}`);
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
          // Rehydrate projects
          if (val.projects) {
            for (const [pid, proj] of Object.entries(val.projects)) {
              const p = new Project(proj.id, proj.name, proj.path);
              p.createdAt = proj.createdAt;
              p.updatedAt = proj.updatedAt;
              val.projects[pid] = p;
            }
          }
          // Rehydrate Session objects
          if (val.sessions) {
            for (const [sid, sess] of Object.entries(val.sessions)) {
              const s = new Session(sess.id, sess.name, sess.projectId || "default");
              s.createdAt = sess.createdAt;
              s.updatedAt = sess.updatedAt;
              s.history = sess.history || [];
              s.conversationId = sess.conversationId || "";
              val.sessions[sid] = s;
            }
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

module.exports = { Session, SessionManager, Project };
