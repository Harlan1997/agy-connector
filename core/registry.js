"use strict";

const { createLogger } = require("./logger");
const log = createLogger("registry");

// Agent adapter registry
const agentRegistry = new Map();

// Platform adapter registry  
const platformRegistry = new Map();

/**
 * Register an agent adapter factory.
 * Mirrors cc-connect core.RegisterAgent().
 * @param {string} name - Agent type name (e.g., "agy")
 * @param {Function} factory - (config) => Agent
 */
function registerAgent(name, factory) {
  agentRegistry.set(name, factory);
  log.debug(`registered agent adapter: ${name}`);
}

/**
 * Register a platform adapter factory.
 * Mirrors cc-connect core.RegisterPlatform().
 * @param {string} name - Platform type name (e.g., "telegram")
 * @param {Function} factory - (config) => Platform
 */
function registerPlatform(name, factory) {
  platformRegistry.set(name, factory);
  log.debug(`registered platform adapter: ${name}`);
}

/**
 * Create an agent by type name.
 * @param {string} name
 * @param {Object} config
 * @returns {Agent}
 */
function createAgent(name, config) {
  const factory = agentRegistry.get(name);
  if (!factory) throw new Error(`unknown agent type: ${name}`);
  return factory(config);
}

/**
 * Create a platform by type name.
 * @param {string} name
 * @param {Object} config
 * @returns {Platform}
 */
function createPlatform(name, config) {
  const factory = platformRegistry.get(name);
  if (!factory) throw new Error(`unknown platform type: ${name}`);
  return factory(config);
}

module.exports = { registerAgent, registerPlatform, createAgent, createPlatform };
