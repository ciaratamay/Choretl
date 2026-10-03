# Household Tasks

A small installable web app for two people to share a household task board, with
live sync via Firebase (last write wins — no merge conflicts to think about).

## What's in here

- `index.html`, `style.css`, `app.js` — the app itself
- `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png` — make it installable
- `firestore.rules` — the security rules to paste into your Firebase project

## One-time setup (you, not your partner)

### 1. Enable Email/Password sign-in

Firebase console → your project → **Build → Authentication → Sign-in method** →
enable **Email/Password**. Nothing else needed there — the app never shows a
normal login screen, it just uses this under the hood.

### 2. Create a Firestore database

Firebase console → **Build → Firestore Database → Create database**. Any region
close to Ireland is fine (e.g. `europe-west1`). Start in **production mode** —
the rules below replace the default deny-all.

### 3. Paste in the security rules

Firestore → **Rules** tab → replace the contents with what's in `firestore.rules`
in this folder → **Publish**.

What these rules actually do: anyone can *read* the list of profile names (so the
"who's this?" screen works before anyone's signed in), but only an account can
create or edit its own profile. Tasks and the activity log are open to anyone
who has an account in the app — i.e. you and your partner, since account
creation happens inside the app itself, not via public sign-up anywhere else.
That matches "no special security" without leaving Firestore wide open to
random internet traffic.

### 4. Get your config values and paste them in

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
project to talk to; the security rules above are what actually gate access.

### 5. Host it

Push this folder to a GitHub repo, then **Settings → Pages → Deploy from
branch** → pick `main` and `/ (root)`. GitHub gives you a URL like
`https://yourname.github.io/household-tasks/`. That's the link you'll both
install from.

(If you'd rather use Netlify or Vercel instead: drag-and-drop this folder onto
their dashboard — either works, and nothing in the app cares which one you
pick.)

## Installing it on your devices

Open the hosted URL in your phone's browser, then:
- **iOS Safari:** Share button → Add to Home Screen
- **Android Chrome:** menu (⋮) → Install app / Add to Home screen
- **Desktop Chrome/Edge:** address bar shows an install icon

## First run

The first person to open it picks "+ Add a person," sets a name, a password
(6 characters minimum — Firebase's own floor, it doesn't need to be strong),
an optional hint, and an optional email. Do this once each. After that,
opening the app on any device shows both names — pick yours, enter your
password, and it stays signed in on that device until you tap "Switch user."

If you skip the email field, that profile just can't self-serve a password
reset later — you'd need to delete and recreate it in the Firebase console.

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
