// The VAPID public key is intentionally available to browsers. The matching
// private key never leaves Netlify environment variables.
export default async () => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    return new Response(JSON.stringify({ error: 'Missing environment variable: VAPID_PUBLIC_KEY' }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }
  return new Response(JSON.stringify({ vapidPublicKey: process.env.VAPID_PUBLIC_KEY }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
};
