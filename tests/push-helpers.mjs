import assert from 'node:assert/strict';
import { notificationPayload } from '../netlify/functions/send-reminders.mjs';

const noWord = notificationPayload({ items: [], settings: {} }, 0, '2026-09-29-09:00');
assert.equal(noWord.title, 'WordFlow reminder');

const withWord = notificationPayload({
  settings: { todayItemId: 'word-1' },
  items: [{ id: 'word-1', term: 'resilient', meaning: 'Able to recover.', examples: ['A resilient system.'] }]
}, 0, '2026-09-29-09:00');
assert.equal(withWord.title, 'resilient — example 1');
assert.equal(withWord.body, 'A resilient system.');

console.log('Push helper tests passed.');
