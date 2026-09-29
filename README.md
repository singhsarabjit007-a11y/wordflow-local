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
- Five configurable local reminders while the PWA is open
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

Never put a Supabase service-role key in this project, the browser, or Netlify.
WordFlow does not need one for the current cloud-sync feature.

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

## Import a pack

Use [`sample-packs/feature-test-pack.json`](sample-packs/feature-test-pack.json)
to test the Import screen. Every vocabulary item needs exactly five examples.

## Current boundaries

- Closed-app push notifications are not included yet. Supabase sync makes them
  practical to add next, alongside browser push subscriptions and scheduled
  Netlify Functions.
- Browser pronunciation uses the device's built-in text-to-speech voice.

## Verify the source

```bash
npm run check
```
