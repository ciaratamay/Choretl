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

## How tasks work

There's a difference between a **task** and a **time it comes around**, and
the tabs split along that line:

- **All tasks** is the tasks themselves. Each one has an **owner** — whose job
  it is by default — and the card is tinted in that person's colour. Turn on
  **take turns** if a repeating task should rotate rather than always land on
  the owner. The right-hand side of each card shows where its current
  occurrence stands: the due date, the colour of whoever it's on, and two
  buttons — tick it off, or hand it to someone else. When nothing's open (a
  finished one-off, or a repeat waiting its turn) that side greys out and
  tells you who did it last instead.
- **To-do** and **Done** show the individual times a task comes around, as
  flatter rows with a coloured stripe for whoever it's on. Reassigning one of
  these only changes that one occurrence; next time it goes back to the owner
  (or to the next person in line, if it takes turns). Hitting **Edit** on one
  opens the task itself, and says so.

**Priority** is the star, tapped up through four steps: grey outline (normal)
→ thick yellow outline (high) → filled yellow (higher) → a red exclamation
(highest), which also puts a red outline round the card. Every step is drawn
in the same size box, so tapping through never shifts the text beside it. Sort
by it in either tab.

**Copy list** sits beside the filters on To-do, Done, All tasks and the Home
checklist. It copies exactly what's on screen — same filters, same sort — as a
heading plus plain task names, nothing else, so you can paste someone their
list straight into a message:

```
My tasks in Garden, Home
- Wash floor
- Plant bulbs
```

**Share household** on the Home tab copies a ready-made invite: the link to
this app, how to install it, your household name and its password. The
password lives in that device's own browser storage so the invite can include
it — it is never uploaded, and Firestore still only ever holds a hash. If a
device doesn't have it saved (you joined before this existed, or cleared your
browser data) just type it into the box and it'll be remembered next time.
Anyone with that invite can read and change everything in the household, so
send it to the people you mean to.

**Categories** work like tags — garden, children, car — and a task can carry
as many as suit it. Make and rename them under **Edit categories** on the Home
tab, tag a task by tapping the chips in its editor, and filter by any
combination: pick two and you'll see tasks carrying either. The filter sits in
every tab and carries your choice between them. Deleting a category leaves its
tasks alone, it just takes that one tag off them.

**At a glance** on the Home tab is the quick version: everything open as a
tickable list, with whatever was finished in the last day shown ticked off
underneath. Ticking marks it done as whoever you're viewing as — no "who did
this?" prompt, since on your own checklist the answer is you — and unticking
undoes it, log entry and all. It shares its person filter with the To-do tab,
since both are asking the same question.

**Summary** answers who's actually doing what, over this week, this month, a
rolling 7 or 30 days, or all time.

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
