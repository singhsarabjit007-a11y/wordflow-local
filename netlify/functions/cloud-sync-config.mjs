// A versioned public-config endpoint for WordFlow's anonymous cloud sync.
// It exposes browser-safe Supabase values only; never add a service-role key.
export default async () => {
  const required = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length) {
    return new Response(JSON.stringify({ error: `Missing environment variables: ${missing.join(', ')}` }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  return new Response(JSON.stringify({
    supabaseUrl: process.env.SUPABASE_URL,
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY
  }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
};
