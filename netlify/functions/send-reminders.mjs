import webpush from 'web-push';

// Netlify evaluates schedules in UTC. This runs every five minutes, then each
// subscription is compared with its own saved IANA timezone and reminder time.
export const config = { schedule: '*/5 * * * *' };

function requiredEnvironment() {
  const keys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'];
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function localClock(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const values = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

export function notificationPayload(payload, reminderIndex, deliveryKey) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const todayId = payload?.settings?.todayItemId;
  const item = items.find((candidate) => candidate.id === todayId) || items.find((candidate) => candidate.status === 'active') || items.find((candidate) => candidate.status === 'queued');
  if (!item) return { title: 'WordFlow reminder', body: 'Open WordFlow for today’s word.', tag: `wordflow-${deliveryKey}`, url: '/#today' };
  return {
    title: `${item.term} — example ${reminderIndex + 1}`,
    body: item.examples?.[reminderIndex] || item.meaning || 'Open WordFlow to keep learning.',
    tag: `wordflow-${deliveryKey}`,
    url: '/#today'
  };
}

function supabaseClient(environment) {
  const headers = {
    apikey: environment.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`,
    'content-type': 'application/json'
  };
  return async (path, options = {}) => {
    const response = await fetch(`${environment.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`, {
      ...options,
      headers: { ...headers, ...options.headers }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Supabase request failed (${response.status}): ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

async function reserveDelivery(request, endpoint, deliveryKey) {
  const result = await request('wordflow_push_deliveries?on_conflict=subscription_endpoint%2Cdelivery_key', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify([{ subscription_endpoint: endpoint, delivery_key: deliveryKey }])
  });
  return Array.isArray(result) && result.length === 1;
}

export default async () => {
  const environment = requiredEnvironment();
  const request = supabaseClient(environment);
  webpush.setVapidDetails(environment.VAPID_SUBJECT, environment.VAPID_PUBLIC_KEY, environment.VAPID_PRIVATE_KEY);

  const subscriptions = await request('wordflow_push_subscriptions?select=endpoint,user_id,subscription,reminder_times,timezone&active=eq.true');
  const states = await request('wordflow_device_state?select=user_id,payload');
  const stateByUser = new Map(states.map((state) => [state.user_id, state.payload]));
  const now = new Date();
  let sent = 0;

  for (const row of subscriptions) {
    let clock;
    try { clock = localClock(now, row.timezone); } catch { continue; }
    const reminderIndex = row.reminder_times.indexOf(clock.time);
    if (reminderIndex < 0) continue;

    const deliveryKey = `${clock.date}-${clock.time}`;
    if (!await reserveDelivery(request, row.endpoint, deliveryKey)) continue;

    try {
      await webpush.sendNotification(row.subscription, JSON.stringify(notificationPayload(stateByUser.get(row.user_id), reminderIndex, deliveryKey)), {
        TTL: 60 * 10,
        urgency: 'high',
        // Push-service topics permit URL-safe characters only; omit the colon
        // in HH:MM while retaining a stable per-device reminder identifier.
        topic: `wordflow-${deliveryKey.replace(':', '')}`
      });
      sent += 1;
    } catch (error) {
      const status = error?.statusCode;
      if (status === 404 || status === 410) {
        await request(`wordflow_push_subscriptions?endpoint=eq.${encodeURIComponent(row.endpoint)}`, { method: 'PATCH', body: JSON.stringify({ active: false }) });
      } else {
        // Let a manually retried invocation send this reminder rather than
        // permanently recording a delivery that never reached the push service.
        await request(`wordflow_push_deliveries?subscription_endpoint=eq.${encodeURIComponent(row.endpoint)}&delivery_key=eq.${encodeURIComponent(deliveryKey)}`, { method: 'DELETE' });
        console.error('Push delivery failed:', error);
      }
    }
  }

  return new Response(JSON.stringify({ sent }), { headers: { 'content-type': 'application/json' } });
};
