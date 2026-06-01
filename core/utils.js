"use strict";

/**
 * Format a duration in milliseconds to a human-readable string.
 * @param {number} ms - Duration in milliseconds
 * @returns {string} e.g., "2d 5h 30m 15s"
 */
function formatDuration(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

/**
 * Redact a token for safe logging. Mirrors cc-connect core.RedactToken().
 * @param {string} token - The token to redact
 * @param {number} [visibleChars=8] - Number of chars to show
 * @returns {string} e.g., "86125534..."
 */
function redactToken(token, visibleChars = 8) {
  if (!token) return "(not set)";
  if (token.length <= visibleChars) return token;
  return token.slice(0, visibleChars) + "...";
}

/**
 * Compute session key from a message.
 * Uses chatId-threadId if thread exists, otherwise chatId.
 * @param {Object} msg - Message with chatId and threadId
 * @returns {string}
 */
function getSessionKey(msg) {
  return msg.threadId ? `${msg.chatId}-${msg.threadId}` : String(msg.chatId);
}

/**
 * Split text into chunks that fit within a maximum length.
 * Prefers splitting at newlines, then spaces, then hard-cuts.
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
function splitMessage(text, max = 4000) {
  if (text.length <= max) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n", max);
    if (cut < max / 2) cut = remaining.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

module.exports = { formatDuration, redactToken, getSessionKey, splitMessage };
