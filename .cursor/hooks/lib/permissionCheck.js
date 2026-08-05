#!/usr/bin/env node
/**
 * Legacy detached checker. Waiting notifications are owned by the extension
 * watcher now — a gate staying open while a command runs is not the same as
 * a Run/Skip prompt. This script is kept so old installs that still spawn it
 * exit quietly instead of false-firing.
 *
 * Usage: node permissionCheck.js <delayMs> <conversationId>
 */
process.exit(0);
