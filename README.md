# The Sexual Alchemist

A dark, installable PWA to track your daily energy. Good or Bad each day. On a Bad day it asks for the approximate time, then keeps asking "why" until you reach the root cause. Everything is stored in Firestore.

## What's in the project

| File | Purpose |
|---|---|
| `index.html`, `css/styles.css`, `js/app.js` | The app (vanilla JS + Firebase modular SDK from CDN, no build step) |
| `js/firebase-config.js` | **You fill this in** with your Firebase web config |
| `manifest.webmanifest`, `sw.js`, `icons/` | Installable PWA: full-screen standalone, dark splash and status bar |
| `firestore.rules` | Each Google account can read and write only its own data |
| `netlify.toml` | Netlify deploy config and headers |
| `scripts/import-history.mjs` | Imports your past-year data, mapped to client emails, without overwriting or deleting |

### Data model (Firestore)

```
users/{uid}/days/{YYYY-MM-DD}
  date:       "2026-03-14"
  result:     "good" | "bad"
  approxTime: "22:30" | "unknown" | null     (asked only on bad days)
  chain:      [{ q, a }, ...]                 (the "why" chain, bad days only)
  rootCause:  "..."                           (the final "why" you confirmed)
  source:     "import" (only on imported days)
  createdAt, updatedAt
```

### Storage rules in this app
- **Firestore** holds all tracking data.
- **Auth session** is kept by Firebase in **IndexedDB**, not localStorage or cookies. Firebase's client SDK does not use cookies, so IndexedDB is the closest fit. Nothing is written to localStorage.
- **Service worker cache** holds only the app's own files (HTML/CSS/JS/icons), never personal data.

---

## 1. Firebase setup (about 10 minutes)

1. Go to <https://console.firebase.google.com> → **Add project** (for example `the-sexual-alchemist`).
2. **Build → Authentication → Get started → Google** → enable it and set a support email.
3. **Build → Firestore Database → Create database** → production mode, pick a region near you.
4. **Project settings → General → Your apps → Web (`</>`)** → register an app. Copy the `firebaseConfig` values into `js/firebase-config.js`.
5. **Firestore → Rules** → paste the contents of `firestore.rules` → **Publish**.

## 2. Deploy on Netlify

1. Push this folder to a GitHub repo, then on Netlify choose **Add new site → Import from Git**. Or drag the folder onto <https://app.netlify.com/drop>.
2. Settings: no build command, publish directory `.` (already set in `netlify.toml`).
3. Copy your site URL (for example `https://the-sexual-alchemist.netlify.app`).
4. Back in Firebase → **Authentication → Settings → Authorized domains** → **Add domain** → paste the Netlify host (without `https://`). Google sign-in fails on the live site without this step.

## 3. Install on Android (full screen, like a native app)

1. Open the Netlify URL in **Chrome** on your phone and sign in with Google.
2. Chrome menu (⋮) → **Install app** (or **Add to Home screen**).
3. Open it from the home screen. It runs standalone, with no browser bar. The status bar uses the same dark colour as the app, so there is no visible gap at the top.

## 4. Import your past-year data

1. Sign in to the app once with each client's Google account. This creates the user record the importer maps to.
2. Firebase console → **Project settings → Service accounts → Generate new private key**. Save the JSON file somewhere safe. **Do not commit it to git.**
3. In a terminal inside this folder:
   ```bash
   npm install
   set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json     (PowerShell: $env:GOOGLE_APPLICATION_CREDENTIALS="...")
   copy scripts\history.template.json scripts\history.json
   ```
4. Put your records into `scripts/history.json` (format in the template), then run:
   ```bash
   npm run import:dry     # shows what would be written. Writes nothing.
   npm run import         # writes. Existing days are skipped, never overwritten.
   ```

## Local preview

Any static server works, for example `npx serve .`. Auth needs `localhost` added to Authorized domains (Firebase adds it by default).
