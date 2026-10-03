# Choretl

A small installable web app for a household to share a task board, with
live sync via Firebase (last write wins — no merge conflicts to think about).

## What's in here

- `index.html`, `style.css`, `app.js` — the app itself
- `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png` — make it installable
- `firestore.rules` — the security rules to paste into your Firebase project

## One-time setup (you, not your partner)

### 1. Create a Firestore database

Firebase console → **Build → Firestore Database → Create database**. Any region
close to Ireland is fine (e.g. `europe-west1`). Start in **production mode** —
the rules below replace the default deny-all.

(There's no Authentication step this time — the app doesn't use Firebase Auth
at all. A household's password is checked by the app itself, not Firebase.)

### 2. Paste in the security rules

Firestore → **Rules** tab → replace the contents with what's in `firestore.rules`
in this folder → **Publish**.

These rules are wide open — anyone with your Firebase config could read or
write through the API directly, not just through the app. That's a deliberate
trade-off: a household here is gated by its own password, checked client-side,
not by Firebase-level security. Fine for "keep two people's chores separate,"
not a substitute for real security if that ever matters to you.

### 3. Get your config values and paste them in

Firebase console → ⚙️ **Project settings** → scroll to **Your apps** → if you
don't have a web app yet, click **Add app → Web** (the `</>` icon) and register
it (no need for Firebase Hosting when asked). You'll get a config object.

Open `index.html`, find this near the bottom:

```js
window.FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

Replace each value with what Firebase gave you. These values aren't secret in
the way an API key normally is — they just tell the browser which Firebase
project to talk to.

### 4. Host it

Push this folder to a GitHub repo, then **Settings → Pages → Deploy from
branch** → pick `main` and `/ (root)`. GitHub gives you a URL like
`https://yourname.github.io/choretl/`. That's the link you'll both install from.

(If you'd rather use Netlify or Vercel instead: drag-and-drop this folder onto
their dashboard — either works, and nothing in the app cares which one you
pick.)

## Installing it on your devices

Open the hosted URL in your phone's browser, then:
- **iOS Safari:** Share button → Add to Home Screen
- **Android Chrome:** menu (⋮) → Install app / Add to Home screen
- **Desktop Chrome/Edge:** address bar shows an install icon

## First run

The first person opens the app and picks **Create household** — a household
name (this is what you tell your partner, so pick something easy to say out
loud), a password (6 characters minimum, doesn't need to be strong), and an
optional hint. Everyone else picks **Join household** and enters that same
name and password.

Once you're in a household, you add a "person" for each of you — just a name
and a colour, no password of your own. You can switch which person you're
viewing as at any time without re-entering the household password, rename or
recolour anyone, or delete a person (their tasks go back to unassigned rather
than disappearing). The device stays in the household until you tap "Leave
this household."

## How the sync actually works

Every change (checking a task off, reassigning it, adding a new one) writes
straight to Firestore, and every device holds a live listener on the same
data — so both phones update within about a second of each other, no refresh
needed. If a device is offline, its changes queue locally and send the moment
it reconnects; if the same task got changed on both devices while one was
offline, whichever write reaches Firestore last is the one that sticks.

## A note on cost

Firebase's free "Spark" tier covers this comfortably — two people checking off
a handful of chores a day is a rounding error against the free quota
(50K reads / 20K writes per day). You won't hit a bill from this.
