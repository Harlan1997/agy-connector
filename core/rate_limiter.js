"use strict";

const { createLogger } = require("./logger");
const log = createLogger("rate-limit");

/**
 * Sliding-window rate limiter per session key.
 * Mirrors cc-connect core.RateLimiter.
 */
class RateLimiter {
  /**
   * @param {number} maxMessages - Max messages per window; 0 = disabled
   * @param {number} windowMs - Window size in milliseconds
   */
  constructor(maxMessages = 0, windowMs = 60000) {
    this.maxMessages = maxMessages;
    this.windowMs = windowMs;
    this._buckets = new Map(); // key -> timestamp[]
    this._cleanupTimer = null;
    if (maxMessages > 0) {
      this._cleanupTimer = setInterval(() => this._cleanup(), windowMs * 2);
    }
  }

  /**
   * Check if a message is allowed for the given key.
   * @param {string} key - Session key or user ID
   * @returns {boolean}
   */
  allow(key) {
    if (this.maxMessages <= 0) return true;
    const now = Date.now();
    let timestamps = this._buckets.get(key);
    if (!timestamps) {
      timestamps = [];
      this._buckets.set(key, timestamps);
    }
    // Remove expired entries
    const cutoff = now - this.windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= this.maxMessages) {
      log.debug(`rate limited: key=${key}, count=${timestamps.length}`);
      return false;
    }
    timestamps.push(now);
    return true;
  }

  stop() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  _cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this._buckets) {
      while (timestamps.length > 0 && timestamps[0] < cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this._buckets.delete(key);
      }
    }
  }
}

module.exports = { RateLimiter };
