# WordFlow V1

**One word. Five real-world uses. Every day.**

WordFlow is a personal, installable vocabulary-learning PWA. V1 is deliberately
local-first: it has no account, authentication, database server, API key,
Netlify Function, or environment variable.

Your words, progress and settings are stored in IndexedDB in the browser where
you use the app. Export a backup before clearing browser data or moving to a
new device.

## V1 features

- Installable PWA that works offline after the first visit
- One daily word or phrase with type, meaning, explanation and five examples
- Add a word manually or import a JSON vocabulary pack
- Queue, searchable library and status filters
- Search words by term, meaning, explanation, category, type or difficulty
- Save favourite words for quick filtering
- Browser pronunciation using the device's built-in text-to-speech voice
- Spaced repetition reviews at 1, 3, 7, 21 and 60 days
- Mark words learned or put them in review
- Five configurable local reminder times
- Browser notification permission (reminders fire while WordFlow is open)
- Export and restore a complete local backup

## Important V1 boundary

Web browsers cannot reliably run local timers after the PWA/browser is closed.
For that reason, V1 reminders run while WordFlow is open. Real push
notifications for a closed app are a future feature and require a backend that
stores browser push subscriptions.

## Deploy to Netlify

1. Push this repository to GitHub.
2. In Netlify, use **Add new project → Import an existing project**.
3. Select this repository and deploy. Netlify reads `netlify.toml`.
4. No build command, Supabase project, VAPID key, or environment variable is
   needed.
5. Make sure Netlify's Site/Team Protection is disabled if anyone should be
   able to open the PWA URL without a Netlify account.

## Import format

The included [`sample-packs/it-meetings-starter.json`](sample-packs/it-meetings-starter.json)
is ready to import. Packs use this shape:

```json
{
  "schema_version": 1,
  "pack": { "name": "IT meetings", "topic": "Work", "difficulty": "Intermediate" },
  "items": [{
    "term": "align on",
    "type": "phrase",
    "meaning": "Reach a shared understanding.",
    "explanation": "Use it when people need to agree on a plan.",
    "category": "IT meetings",
    "difficulty": "Intermediate",
    "examples": ["One.", "Two.", "Three.", "Four.", "Five."]
  }]
}
```

Every item must have exactly five non-empty example sentences.

## Verify the source

```bash
npm run check
```

This validates the PWA JavaScript syntax and the included sample pack.

## Later ideas

- Reliable closed-app push notifications
- Cloud backup and multi-device sync
- AI-created packs and sentence feedback
- Categories, favourites and learning statistics
