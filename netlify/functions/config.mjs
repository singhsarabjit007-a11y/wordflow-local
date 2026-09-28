export default async () => {
  const required = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'VAPID_PUBLIC_KEY'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    return new Response(JSON.stringify({ error: `Missing environment variables: ${missing.join(', ')}` }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }
  return new Response(JSON.stringify({
    supabaseUrl: process.env.SUPABASE_URL,
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY
  }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
};
