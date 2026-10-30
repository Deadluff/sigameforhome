/** Copy results text (QOL-6) and the join-link choices (UX-6). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inviteChoices, resultsText } from '../client/src/sharing.ts';

test('results copy as plain text with shared places', () => {
  const text = resultsText([{ name: 'Alex', score: 1200 }, { name: 'Bea', score: 1200 }, { name: 'Cid', score: -100 }], 'Demo');
  assert.equal(text, 'SIGame results: Demo\n1. Alex — 1,200\n1. Bea — 1,200\n3. Cid — -100');
});

test('the host machine offers every LAN address; other devices keep their own address', () => {
  const urls = ['http://192.168.1.5:3000', 'http://10.0.0.7:3000'];
  assert.deepEqual(inviteChoices(urls, 'localhost', 'http://localhost:3000'), urls);
  assert.deepEqual(inviteChoices(urls, '192.168.1.5', 'http://192.168.1.5:3000'), ['http://192.168.1.5:3000']);
  assert.deepEqual(inviteChoices([], 'localhost', 'http://localhost:3000'), ['http://localhost:3000']);
});
