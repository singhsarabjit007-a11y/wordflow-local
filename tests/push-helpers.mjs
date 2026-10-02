import assert from 'node:assert/strict';
import { isValidPushSubscription, notificationPayload } from '../netlify/functions/send-reminders.mjs';

const noWord = notificationPayload({ items: [], settings: {} }, 0, '2026-09-29-09:00');
assert.equal(noWord.title, 'WordFlow reminder');

const withWord = notificationPayload({
  settings: { todayItemId: 'word-1' },
  items: [{ id: 'word-1', term: 'resilient', meaning: 'Able to recover.', examples: ['A resilient system.'] }]
}, 0, '2026-09-29-09:00');
assert.equal(withWord.title, 'resilient — example 1');
assert.equal(withWord.body, 'A resilient system.');

const safeSubscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/example',
  subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/example', keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) } },
  reminder_times: ['09:00', '12:00', '15:00', '18:00', '21:00'],
  timezone: 'Asia/Kolkata'
};
assert.equal(isValidPushSubscription(safeSubscription), true);
assert.equal(isValidPushSubscription({ ...safeSubscription, endpoint: 'https://127.0.0.1/internal' }), false);
assert.equal(isValidPushSubscription({ ...safeSubscription, endpoint: 'https://fcm.googleapis.com.evil.example/send' }), false);
assert.equal(isValidPushSubscription({ ...safeSubscription, endpoint: 'https://user@fcm.googleapis.com/send' }), false);
assert.equal(isValidPushSubscription({ ...safeSubscription, endpoint: 'https://fcm.googleapis.com:8443/send' }), false);
assert.equal(isValidPushSubscription({ ...safeSubscription, reminder_times: ['09:00', '12:00', '15:00', '18:00', '25:00'] }), false);
assert.equal(isValidPushSubscription({ ...safeSubscription, subscription: { ...safeSubscription.subscription, endpoint: 'https://example.com' } }), false);

console.log('Push helper tests passed.');
