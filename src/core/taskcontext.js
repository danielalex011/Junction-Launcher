'use strict';
// The task a piece of code is running for, found through AsyncLocalStorage, so http.download() and
// pool() can report progress and obey Cancel / Pause without every caller passing it along.
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/** Thrown when the user cancels. The message is shown as-is, so keep it a plain sentence. */
class CancelledError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelledError';
    this.code = 'CANCELLED';
  }
}

/** The task api (see tasks.js) of the job running right now, or undefined. */
const currentTask = () => als.getStore();

/** Rejects when `signal` aborts; otherwise settles like `promise`. */
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new CancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

module.exports = { als, currentTask, CancelledError, abortable };
