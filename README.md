# WordFlow V1

**One word or phrase. Five real-world uses. Every day.**

WordFlow is a personal installable PWA for learning practical vocabulary. ChatGPT generates vocabulary packs as JSON files; the app imports those packs into Supabase; Netlify serves the PWA and sends five Web Push notifications per day for the current word.

## What V1 includes

- Installable PWA for phone/desktop
- Private sign-in through Supabase email magic links
- ChatGPT learning-pack JSON schema
- JSON file import and paste-to-import
- Duplicate-term protection
- Daily word/phrase with meaning, type, context, difficulty and exactly five examples
- Queue with “Learn next” control
- Library with search and status filters
- “I know this” / review states
- Real Web Push notifications even when the PWA is closed
- Five fixed notifications at **09:00, 12:00, 15:00, 18:00 and 21:00 India Standard Time**
- Offline shell caching plus a local snapshot of the current word
- Supabase Row Level Security so browser access is scoped to your login
- A starter IT-meetings learning pack

## Architecture

```text
ChatGPT
   │  generates WordFlow JSON
   ▼
WordFlow PWA (Netlify)
   │  authenticated browser operations
   ▼
Supabase ───────────────┐
  vocabulary            │ service-role access
  queue                  │
  progress               ▼
  push subscriptions  Netlify Scheduled Functions
                         │
                         ▼
                      Web Push
                         │
                         ▼
                      Your phone
```

The OpenAI API is **not required**. ChatGPT is your content-authoring tool; the running app is deterministic and database-driven.

---

# Setup

## 1. Create a Supabase project

Create a project at Supabase, then open **SQL Editor** and run:

`supabase/schema.sql`

This creates the database tables, account bootstrap trigger, indexes, grants and RLS policies.

### Authentication settings

In **Authentication → URL Configuration**:

- Set **Site URL** to your final Netlify URL, e.g. `https://your-site.netlify.app`
- Add the same URL to **Redirect URLs**

Email authentication/magic-link login should be enabled.

**Personal-use hardening:** after you have successfully created your own account, you can disable new user sign-ups in Supabase Auth settings. Existing-account login can remain available while preventing other people from creating accounts on your public Netlify URL.

## 2. Generate Web Push VAPID keys

From the project folder:

```bash
npm install
npx web-push generate-vapid-keys
```

Keep the private key private. The public key is safe to expose to the PWA.

## 3. Deploy to Netlify

Because V1 uses serverless Scheduled Functions and npm dependencies, **use a Git-backed Netlify deploy or Netlify CLI rather than only dragging the static `public` folder into Netlify Drop**.

### Easiest repeatable route

1. Put this project in a GitHub repository.
2. In Netlify choose **Add new project → Import an existing project**.
3. Select the repository.
4. Netlify reads `netlify.toml`; no custom build command is required.
5. Add these environment variables in **Site configuration → Environment variables**:

```text
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=your publishable key
SUPABASE_SERVICE_ROLE_KEY=your service-role secret
VAPID_PUBLIC_KEY=your VAPID public key
VAPID_PRIVATE_KEY=your VAPID private key
VAPID_SUBJECT=mailto:your-email@example.com
```

**Never put `SUPABASE_SERVICE_ROLE_KEY` or `VAPID_PRIVATE_KEY` in browser files.** They are used only by Netlify Functions.

6. Deploy the production site.
7. Return to Supabase Authentication settings and confirm the final Netlify URL is allowed.

## 4. Sign in

Open the Netlify URL, enter your email, and open the magic link Supabase sends you.

## 5. Enable push notifications

On the **Today** screen tap **Enable** under Daily notifications and allow notification permission.

On iPhone/iPad, install the PWA to the Home Screen before enabling web-app push notifications.

## 6. Import your first pack

A ready sample exists here:

`sample-packs/it-meetings-starter.json`

Open **Import** in WordFlow and choose the JSON file.

---

# Generating new packs with ChatGPT

WordFlow contains a reusable prompt on the Import screen. A shorter request can be:

> Create a WordFlow V1 pack with 20 intermediate-to-advanced words and phrases for IT-company status meetings and discussions with management. Return the exact WordFlow JSON schema with five natural examples for every item.

Save ChatGPT's JSON as a `.json` file and import it, or paste the JSON directly into WordFlow.

## JSON contract

```json
{
  "schema_version": 1,
  "pack": {
    "name": "IT Meetings",
    "description": "...",
    "topic": "IT Meetings",
    "difficulty": "Intermediate"
  },
  "items": [
    {
      "term": "align on",
      "type": "phrase",
      "meaning": "...",
      "explanation": "...",
      "category": "IT Meetings",
      "difficulty": "Intermediate",
      "examples": ["...", "...", "...", "...", "..."]
    }
  ]
}
```

V1 deliberately requires exactly five examples because each example maps to one daily push slot.

---

# Notification schedule

Netlify Scheduled Functions use UTC. V1 maps the five IST times as follows:

| IST | UTC cron | Function |
|---|---|---|
| 09:00 | `30 3 * * *` | `notify-slot-1` |
| 12:00 | `30 6 * * *` | `notify-slot-2` |
| 15:00 | `30 9 * * *` | `notify-slot-3` |
| 18:00 | `30 12 * * *` | `notify-slot-4` |
| 21:00 | `30 15 * * *` | `notify-slot-5` |

The first successful notification of the day also creates that day's assignment if you have not opened the app yet. After the fifth successful push, that item moves to **review** so the next queued item can become tomorrow's word.

## How the daily queue works

- `queued` → waiting to be assigned
- `active` → today's word
- `review` → five daily exposures completed; keep it available for review
- `learned` → you explicitly marked it known

The app also prevents importing the same normalized term twice for one account.

---

# Local development

```bash
cp .env.example .env
# fill in your keys
npm install
npm run dev
```

Netlify Dev serves the static PWA and Functions together.

Run the lightweight checks:

```bash
npm run check
```

---

# Security notes

- The browser receives only the Supabase project URL, publishable key and VAPID public key.
- The Supabase service-role key and VAPID private key remain server-side in Netlify environment variables.
- All exposed Supabase tables have RLS enabled and browser policies are limited to the authenticated user's own rows.
- The service role is used only by scheduled notification functions.
- Push endpoint subscriptions are treated as private database records.

---

# V1 boundaries / planned V2 ideas

V1 intentionally keeps these out:

- OpenAI API calls from the app
- AI-generated packs inside the PWA
- fully customizable notification times/timezones
- full spaced-repetition algorithm
- pronunciation/audio generation
- sentence-writing AI feedback
- automatic pack generation when the queue runs low
- multi-user social features

Those can be added without changing the core content model.
