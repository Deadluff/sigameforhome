/** Only this server's own pages and LAN names may connect (audit SEC-3). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostOnly, policyFromEnv, refusalReason } from '../server/socket/originGuard.ts';

const policy = (env = {}, hostname = 'studio-mac') => policyFromEnv(env, hostname);
const allowed = (headers, p = policy()) => refusalReason(headers, p) === null;

test('LAN names, loopback names, IP literals and the machine name are allowed', () => {
  for (const host of ['localhost:3031', 'p1.localhost:3031', '192.168.1.5:3000', '[fe80::1]:3000', 'studio-mac.local:3000',
    'studio-mac:3000']) {
    assert.ok(allowed({ host }), host);
  }
  assert.equal(hostOnly('[fe80::1]:3000'), 'fe80::1');
  assert.equal(hostOnly('Quiz.Home:80'), 'quiz.home');
});

test('a Windows machine name matches in any case', () => {
  const windows = policy({}, 'DESKTOP-ABC');
  assert.ok(allowed({ host: 'desktop-abc:3000' }, windows));
  assert.ok(allowed({ host: 'DESKTOP-ABC.local:3000' }, windows));
});

test('a request without Origin is allowed, a matching Origin is allowed', () => {
  assert.ok(allowed({ host: '192.168.1.5:3000' }));
  assert.ok(allowed({ host: '192.168.1.5:3000', origin: 'http://192.168.1.5:3000' }));
});

test('a rebinding Host or a foreign Origin is refused', () => {
  assert.match(refusalReason({ host: 'evil.example:3000' }, policy()), /not allowed/);
  assert.match(refusalReason({ host: 'evil.example:3000', origin: 'http://evil.example:3000' }, policy()), /not allowed/);
  assert.match(refusalReason({ host: '192.168.1.5:3000', origin: 'http://evil.example' }, policy()), /does not match/);
  assert.match(refusalReason({ host: '192.168.1.5:3000', origin: 'null' }, policy()), /not a valid URL/);
});

test('ALLOWED_HOSTS lets a named host in; ALLOW_ANY_ORIGIN turns the guard off', () => {
  assert.ok(allowed({ host: 'quiz.home:3000' }, policy({ ALLOWED_HOSTS: 'quiz.home, other.lan' })));
  assert.ok(allowed({ host: 'quiz.home:3000' }, policy({ ALLOWED_HOSTS: 'Quiz.Home:3000' })));
  assert.ok(!allowed({ host: 'quiz.home:3000' }));
  assert.ok(allowed({ host: 'evil.example', origin: 'http://elsewhere' }, policy({ ALLOW_ANY_ORIGIN: '1' })));
});
