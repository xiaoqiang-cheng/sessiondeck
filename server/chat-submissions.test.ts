import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ChatSubmissions } from './chat-submissions.ts';

test('chat submission IDs bind exact native identity and content and never retain plaintext prompts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new ChatSubmissions(db);
    assert.equal(ledger.begin('contact', 'request', 'native', 'private-prompt-content').created, true);
    assert.equal(ledger.begin('contact', 'request', 'native', 'private-prompt-content').created, false);
    assert.throws(() => ledger.begin('contact', 'request', 'native', 'different'), /其他内容/);
    assert.throws(() => ledger.begin('contact', 'request', 'new-native', 'private-prompt-content'), /其他内容/);
    ledger.finish('contact', 'request', { status: 'accepted', turnId: 'turn-1' });
    assert.deepEqual(ledger.begin('contact', 'request', 'native', 'private-prompt-content'), { created: false, submission: { requestId: 'request', status: 'accepted', turnId: 'turn-1' } });
    assert.equal(JSON.stringify(db.prepare('SELECT data FROM chat_submissions').all()).includes('private-prompt-content'), false);
    assert.equal(ledger.get('another-contact', 'request'), undefined);
  } finally { db.close(); }
});

test('restart recovers in-flight sends as unknown and preserves accepted or rejected outcomes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const first = new ChatSubmissions(db);
    for (const id of ['pending', 'done', 'failed']) first.begin('contact', id, 'native', id);
    first.finish('contact', 'done', { status: 'accepted', turnId: 'turn-1' });
    first.finish('contact', 'failed', { status: 'rejected', error: 'native rejected' });
    const recovered = new ChatSubmissions(db);
    assert.equal(recovered.get('contact', 'pending')?.status, 'unknown');
    assert.equal(recovered.begin('contact', 'pending', 'native', 'pending').created, false);
    assert.equal(recovered.get('contact', 'done')?.turnId, 'turn-1');
    assert.equal(recovered.get('contact', 'failed')?.status, 'rejected');
  } finally { db.close(); }
});
