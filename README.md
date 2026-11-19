# The Sexual Alchemist

A private, installable web app for daily self-mastery. Each day you log green (saved) or red (slipped). When a slip happens, a guided "why" chain takes you from the symptom to the root cause.

## Benefits

- **Honest daily check-in** in under ten seconds.
- **Clear patterns** from your own data: streaks, time of day, weekday, and root causes.
- **Learning from slips:** the "why" chain surfaces the real trigger, not just the moment.
- **Purpose in view:** write your why, your triggers, and what you will do for each.
- **Private by default:** each Google account sees only its own data.

## Unique value

- Root-cause analysis is part of logging, not a separate journal.
- Reflection is tied to the daily record, so purpose, triggers and actions sit next to the data they explain.
- Installs as a full-screen app and works offline, with data syncing when you reconnect.

## Why it was built

Change is easier when a pattern is measured and understood. The app turns a private struggle into clear data and a plan of action.

## Tech stack

- **Frontend:** HTML, CSS and vanilla JavaScript (ES modules), with no build step
- **Backend:** Firebase Authentication (Google sign-in) and Cloud Firestore, with offline persistence
- **App:** Progressive Web App (web manifest and service worker)
- **Hosting:** Netlify
- **Tooling:** Node.js with `firebase-admin` for data import scripts

## Setup

1. Create a Firebase project, enable Google sign-in, and create a Firestore database.
2. Add your web config to `js/firebase-config.js`, and publish `firestore.rules`.
3. Serve the folder as a static site (for example `npx serve .`) or deploy it to Netlify.
