import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const TIME_ZONE = 'Asia/Kolkata';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function indiaDateISO(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function adminClient() {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
  });
}

async function getOrCreateAssignment(sb, userId, date) {
  const { data: existing, error: existingError } = await sb
    .from('daily_assignments')
    .select('id, vocabulary_item_id, vocabulary_items(id, term, item_type, meaning, status)')
    .eq('user_id', userId)
    .eq('learning_date', date)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing;

  // Recover cleanly if a previous day's fifth push never completed.
  const { error: staleError } = await sb
    .from('vocabulary_items')
    .update({ status: 'review' })
    .eq('user_id', userId)
    .eq('status', 'active')
    .lt('started_on', date);
  if (staleError) throw staleError;

  const { data: next, error: nextError } = await sb
    .from('vocabulary_items')
    .select('id, term, item_type, meaning, status')
    .eq('user_id', userId)
    .eq('status', 'queued')
    .order('queue_position', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (nextError) throw nextError;
  if (!next) return null;

  const { data: inserted, error: insertError } = await sb
    .from('daily_assignments')
    .insert({ user_id: userId, learning_date: date, vocabulary_item_id: next.id })
    .select('id, vocabulary_item_id')
    .single();

  if (insertError) {
    // Handles a rare race with the PWA opening at exactly the same moment.
    const { data: raced, error: racedError } = await sb
      .from('daily_assignments')
      .select('id, vocabulary_item_id, vocabulary_items(id, term, item_type, meaning, status)')
      .eq('user_id', userId)
      .eq('learning_date', date)
      .maybeSingle();
    if (racedError) throw racedError;
    return raced;
  }

  const { error: updateError } = await sb.from('vocabulary_items').update({ status: 'active', started_on: date }).eq('id', next.id);
  if (updateError) throw updateError;
  return { ...inserted, vocabulary_items: { ...next, status: 'active' } };
}

export async function sendNotificationSlot(slot) {
  if (![1,2,3,4,5].includes(slot)) throw new Error('Notification slot must be 1-5.');

  webpush.setVapidDetails(
    requiredEnv('VAPID_SUBJECT'),
    requiredEnv('VAPID_PUBLIC_KEY'),
    requiredEnv('VAPID_PRIVATE_KEY')
  );

  const sb = adminClient();
  const date = indiaDateISO();
  const { data: settings, error: settingsError } = await sb
    .from('user_settings')
    .select('user_id')
    .eq('notifications_enabled', true);
  if (settingsError) throw settingsError;

  const summary = { slot, date, users: settings?.length || 0, sent: 0, skipped: 0, failed: 0 };

  for (const { user_id: userId } of settings || []) {
    try {
      const { data: subscriptions, error: subError } = await sb
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth')
        .eq('user_id', userId);
      if (subError) throw subError;
      if (!subscriptions?.length) { summary.skipped++; continue; }

      const assignment = await getOrCreateAssignment(sb, userId, date);
      if (!assignment?.vocabulary_item_id) { summary.skipped++; continue; }
      const item = assignment.vocabulary_items;
      if (!item || item.status !== 'active') { summary.skipped++; continue; }

      const { data: already } = await sb
        .from('notification_log')
        .select('id')
        .eq('user_id', userId)
        .eq('vocabulary_item_id', assignment.vocabulary_item_id)
        .eq('learning_date', date)
        .eq('slot', slot)
        .maybeSingle();
      if (already) { summary.skipped++; continue; }

      const { data: example, error: exampleError } = await sb
        .from('examples')
        .select('sentence')
        .eq('vocabulary_item_id', assignment.vocabulary_item_id)
        .eq('example_index', slot)
        .single();
      if (exampleError) throw exampleError;

      const payload = JSON.stringify({
        title: `${item.term} · ${slot}/5`,
        body: example.sentence,
        tag: `wordflow-${date}-${assignment.vocabulary_item_id}-${slot}`,
        url: '/#today'
      });

      let successes = 0;
      for (const sub of subscriptions) {
        try {
          await webpush.sendNotification({
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth }
          }, payload, { TTL: 60 * 60 * 4 });
          successes++;
        } catch (error) {
          const status = error?.statusCode;
          if (status === 404 || status === 410) {
            await sb.from('push_subscriptions').delete().eq('id', sub.id);
          } else {
            console.error('Push send failed', { userId, slot, status, message: error?.message });
          }
        }
      }

      if (successes > 0) {
        await sb.from('notification_log').insert({
          user_id: userId,
          vocabulary_item_id: assignment.vocabulary_item_id,
          learning_date: date,
          slot
        });
        summary.sent += successes;

        if (slot === 5 && item.status === 'active') {
          await sb.from('vocabulary_items').update({ status: 'review' }).eq('id', assignment.vocabulary_item_id);
        }
      } else {
        summary.failed++;
      }
    } catch (error) {
      summary.failed++;
      console.error('WordFlow notification user failed', { userId, slot, message: error?.message });
    }
  }

  console.log('WordFlow scheduled notification summary', summary);
  return summary;
}
