'use strict';
// When a finished task deserves a desktop notification.

// Downloads and installs. Not "prepare" (that is just starting the game) and not quiet housekeeping ("other").
const NOTIFY_KINDS = new Set(['download', 'modpack', 'mod', 'update', 'newinstance', 'import', 'repair', 'java']);

/**
 * @param {{status: string, kind?: string, title?: string}} task  a task as sent to the page
 * @param {{ get(key: string): any }} settings
 * @param {boolean} windowFocused  no notification while you are looking at Junction
 * @returns {{title: string, body: string} | null}
 */
function notificationFor(task, settings, windowFocused) {
  if (!task || task.status !== 'done') return null;
  if (!settings.get('notifyOnFinish')) return null;
  if (windowFocused) return null;
  if (!NOTIFY_KINDS.has(task.kind)) return null;
  return { title: 'Junction', body: `Finished: ${task.title || 'your download'}` };
}

module.exports = { notificationFor, NOTIFY_KINDS };
