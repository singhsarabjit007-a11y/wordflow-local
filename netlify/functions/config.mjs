// This is the only Netlify function needed for cloud sync. It exposes only
// Supabase values designed for browser use; never add a service-role key here.
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
