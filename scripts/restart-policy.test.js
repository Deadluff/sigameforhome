/** The launcher restarts crashes but never a deliberate stop (audit CONN-1). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldRestart, EXIT_PORT_IN_USE } from './restart-policy.cjs';

const now = 1_000_000;
const crash = (overrides = {}) => ({ status: 1, signal: null, parentStopping: false, history: [], now, ...overrides });

test('a crash is restarted up to three times a minute', () => {
  assert.equal(shouldRestart(crash()), true);
  assert.equal(shouldRestart(crash({ history: [now - 5_000] })), true);
  assert.equal(shouldRestart(crash({ history: [now - 5_000, now - 2_000] })), true);
  // A fourth crash inside 60 s is a crash loop.
  assert.equal(shouldRestart(crash({ history: [now - 30_000, now - 5_000, now - 2_000] })), false);
  // Old restarts age out of the window.
  assert.equal(shouldRestart(crash({ history: [now - 90_000, now - 80_000, now - 70_000] })), true);
});

test('a clean exit or a taken port is never restarted', () => {
  assert.equal(shouldRestart(crash({ status: 0 })), false);
  assert.equal(EXIT_PORT_IN_USE, 78);
  assert.equal(shouldRestart(crash({ status: EXIT_PORT_IN_USE })), false);
});

test('a signal or a stopping launcher is never restarted', () => {
  assert.equal(shouldRestart(crash({ status: null, signal: 'SIGTERM' })), false);
  assert.equal(shouldRestart(crash({ status: null, signal: 'SIGKILL' })), false);
  // Windows Ctrl+C: the child exits with 0xC000013A and no signal; only the parent flag tells.
  assert.equal(shouldRestart(crash({ status: 3221225786, parentStopping: true })), false);
});
