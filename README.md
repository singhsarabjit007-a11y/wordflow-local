# WordFlow

**One word. Five real-world uses. Every day.**

WordFlow is an installable vocabulary-learning PWA. It always keeps an offline
copy of its data in IndexedDB. When configured, it silently syncs that data to
Supabase using an anonymous device session—there is no login screen, email,
password, or magic link.

## What is included

- Daily word with a meaning, explanation, grammar type and five examples
- Manual word entry and JSON pack import
- Queue, expanded library search, favourites and browser pronunciation
- Spaced reviews at 1, 3, 7, 21 and 60 days
- Five configurable push reminders, including while the installed PWA is closed
- Offline cache plus export/restore backups
- Secure Supabase cloud sync for the current anonymous device session

## Anonymous Supabase identity

Supabase needs an identity to make Row Level Security work. WordFlow uses
**anonymous authentication** automatically on first launch. This is invisible
to the user, but it gives the browser a private device-scoped session so it can
read only its own cloud record.

Anonymous sessions do **not** transfer to a new device. Keep using Export as a
backup, or add an optional account-linking feature later if cross-device access
is required.

## One-time Supabase setup

1. Create a Supabase project.
2. In **Authentication → Providers**, enable **Anonymous sign-ins**.
3. In **SQL Editor**, run [`supabase/schema.sql`](supabase/schema.sql).
4. In **Project Settings → API**, copy the project URL and **Publishable key**.

Never put a Supabase service-role key in the browser or GitHub. Cloud sync does
not need one, but the optional closed-app push sender uses it **only** inside a
Netlify scheduled function.

## Netlify setup

1. Import this GitHub repository into Netlify.
2. Netlify reads `netlify.toml`; leave the build command empty.
3. Add these environment variables under **Project configuration → Environment variables**:

```text
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=your_publishable_key
```

4. Trigger a new deploy.
5. Open WordFlow → **Settings**. It should say that cloud sync is active.

The publishable key is intentionally available to the browser. Security comes
from Supabase RLS policies in `supabase/schema.sql`, not from hiding that key.

## Closed-app push setup

The code is included, but Web Push needs four additional **secret Netlify
environment variables** before it can deliver notifications:

```text
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
VAPID_PUBLIC_KEY=your_vapid_public_key
VAPID_PRIVATE_KEY=your_vapid_private_key
VAPID_SUBJECT=mailto:your-email@example.com
```

1. Generate a VAPID key pair from the repository folder:

   ```powershell
   npx.cmd web-push generate-vapid-keys --json
   ```

2. In Supabase **Project Settings → API Keys → Legacy anon, service_role API
   keys**, copy the `service_role` value into `SUPABASE_SERVICE_ROLE_KEY` in
   Netlify. Never put that value in app code, a commit, or a chat message.
3. Add the VAPID values to Netlify under **Project configuration → Environment
   variables**. `VAPID_PUBLIC_KEY` is browser-safe; the private key is not.
4. Run the latest `supabase/schema.sql` in Supabase SQL Editor. It adds the
   RLS-protected subscription table and a server-only de-duplication table.
5. Redeploy the production site. On the installed PWA, tap **Enable** and allow
   notifications. Reminder times must be five-minute boundaries because the
   sender runs every five minutes.

`send-reminders` is a Netlify Scheduled Function. It checks each device's
saved IANA timezone and reminder times, sends the matching word/example via
Web Push, and deactivates expired subscriptions. To test it, set one reminder
for the next five-minute boundary, enable notifications on the installed PWA,
then use **Run now** in Netlify's Functions view.

## Import a pack

Use [`sample-packs/feature-test-pack.json`](sample-packs/feature-test-pack.json)
to test the Import screen. Every vocabulary item needs exactly five examples.

## Current boundaries

- Browser pronunciation uses the device's built-in text-to-speech voice.
- iPhone/iPad requires an installed PWA and iOS/iPadOS 16.4 or newer for Web
  Push. Android supports it through an installed Chrome-based PWA.

## Verify the source

```bash
npm run check
```
