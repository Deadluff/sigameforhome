/** Client decision logic for keep-awake (QOL-1), fullscreen (QOL-4) and seat actions (QOL-2). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wakeMode } from '../client/src/wakeLock.ts';
import { fullscreenSupported } from '../client/src/fullscreen.ts';
import { betweenQuestions, removeConfirmBody } from '../client/src/seatActions.ts';

test('keep-awake: native when allowed, the video only on opt-in, nothing outside a game', () => {
  const base = { gameRunning: true, secure: true, hasWakeLock: true, videoOptIn: false };
  assert.equal(wakeMode(base), 'native');
  assert.equal(wakeMode({ ...base, secure: false }), 'none');
  assert.equal(wakeMode({ ...base, secure: false, videoOptIn: true }), 'video');
  assert.equal(wakeMode({ ...base, hasWakeLock: false, videoOptIn: true }), 'video');
  assert.equal(wakeMode({ ...base, gameRunning: false, videoOptIn: true }), 'none'); // game over releases it
});

test('fullscreen is offered only where the API exists', () => {
  const doc = (fn, enabled = true) => ({ documentElement: { requestFullscreen: fn }, fullscreenEnabled: enabled });
  assert.equal(fullscreenSupported(doc(() => {})), true);
  assert.equal(fullscreenSupported(doc(undefined)), false);
  assert.equal(fullscreenSupported(doc(() => {}, false)), false);
});

test('seat changes wait for a calm moment', () => {
  for (const phase of ['lobby', 'board', 'roundEnd', 'finalThemes', 'gameOver']) {
    assert.equal(betweenQuestions({ phase, pausedPhase: null }), true, phase);
  }
  for (const phase of ['intro', 'reading', 'buzzerOpen', 'answering', 'stakeAuction', 'finalWager', 'reveal']) {
    assert.equal(betweenQuestions({ phase, pausedPhase: null }), false, phase);
  }
  assert.equal(betweenQuestions({ phase: 'paused', pausedPhase: 'board' }), true);
  assert.equal(betweenQuestions({ phase: 'paused', pausedPhase: 'answering' }), false);
});

test('the remove confirmation names a player\'s score so the host can restore it', () => {
  assert.match(removeConfirmBody({ name: 'Alex', role: 'player', score: 1200 }), /Alex has 1,200 points/);
  assert.equal(removeConfirmBody({ name: 'Tv', role: 'spectator', score: 0 }), 'They leave the game right away.');
});

test('keep-awake: one request at a time, none held after the game, and the video resumes', async () => {
  const { createWakeKeeper } = await import('../client/src/wakeLock.ts');
  const released = [];
  const pending = [];
  const lock = (id) => ({ id, released: false, release() { this.released = true; released.push(id); return Promise.resolve(); } });
  const video = { paused: true, plays: 0, play() { this.plays++; this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, remove() {} };
  const keeper = createWakeKeeper({
    requestWakeLock: () => new Promise((resolve) => pending.push(resolve)),
    visible: () => true,
    makeVideo: () => video,
  });

  keeper.apply('native');
  keeper.apply('native'); // a second render while the first request is in flight
  assert.equal(pending.length, 1);
  keeper.apply('none'); // game over before the browser answered
  pending[0](lock(1));
  await new Promise(setImmediate);
  assert.deepEqual(released, [1], 'a late lock is released at once');

  keeper.apply('video');
  assert.equal(video.plays, 1);
  video.paused = true; // the phone switched apps
  keeper.apply('video');
  assert.equal(video.plays, 2, 'the video resumes on return');
});
