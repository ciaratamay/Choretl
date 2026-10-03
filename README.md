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
  the owner — a task that takes turns has no owner, so that picker goes away
  when you switch it on. Under **Advanced** you can say how long a task takes,
  which is what the Summary tab adds up. The right-hand side of each card shows where its current
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
rolling 7 or 30 days, or all time — counting time rather than just tasks, so
one person doing three five-minute jobs doesn't outrank another doing the
weekly clean. A completion counts for the minutes entered when it was ticked
off, or the task's estimate, or 10 minutes if neither was ever set. Marking
something done has a **+ Time taken** fold-out if you want to record what it
really took.

## When things are due

Every task starts as **Whenever** — no date at all. It sits on the To-do list
until someone does it and never goes late. Dates, times and repeats only
appear once you pick one of the other two:

- **Due by a date** is a window. It shows from the day after it was last done
  right up to its date, so a fortnightly floor-clean due Sunday is back on the
  list the Monday after you did it. Past its date it carries a soft yellow
  warning.
- **Due on a date** is the day itself. The bins don't appear until the
  Wednesday they go out. Past it, the warning is red.

Give a task a time and it goes late an hour after that time rather than at the
end of the day. A task that **repeats** is still a one-off by default — tick
"This repeats" for the scheduling options. Where the schedule pins the day
(every week on a Wednesday, monthly on the 12th), you still choose which one
it starts on, but the date box becomes a list of only the dates that fit — the
next dozen Wednesdays, say — so you can't set a Wednesday task to start on a
Tuesday.

In **All tasks**, anything not currently live tells you when it's next up:
"Not yet · Due Oct 7" for something waiting for its day, or "Back tomorrow"
for a due-by task you've just done.

Tasks made before this existed are treated as "due by", so nothing vanishes
off your list.

## Custom lists

**Edit lists** on the Home tab makes a list that gets a tab of its own. Each
one has:

- a **name** and an optional **icon** — set an emoji and the tab shows that
  instead of the name, which saves a lot of room on a phone;
- a **position**, where 1 sits straight after Home. Left at the top number it
  simply stays last, so adding another list in front won't shuffle it along;
- **private to me**, which hides the list, its tasks and anything done on it
  from everyone else in the household. A work list stays out of your partner's
  tabs, To-do, Log and Summary entirely;
- **tasks here get assigned to someone** — turn it off for a list that's just
  yours to work through, and the owner, assigning, take-turns and person
  filter all disappear from it;
- an **owner** for a shared list that does assign, so tasks added there start
  on that person;
- **include in the Home checklist, Log and Summary** — turn it off to keep a
  list to its own tab, so work tasks aren't counted alongside the housework;
- **which ways to sort and filter it** — you pick the choices that tab even
  offers, not a default. Leave one sort and the control disappears entirely;
- **tags**: use the household's categories, or give the list its own, created
  in the list editor and used nowhere else. Moving a task between lists swaps
  its tag choices over and drops any that don't belong where it landed.

Lists also appear in the filter sheet beside categories, so you can leave one
out of any tab — handy for copying a list without your work items in it.
Deleting a list asks what should happen to its tasks: move them back to the
main lists, or delete them along with it. Either way your log keeps what was
already done, still naming the list it came from.

## The activity log

A log entry is written once, when something is ticked off, and records
everything it needs at that moment: the task, who did it, how long it took,
which list it came from and what that list was called, and who was allowed to
see it. Nothing is looked up again afterwards. Renaming a list, making it
private, or deleting it outright doesn't rewrite anyone's history — and a
private list's entries never become visible to anyone else, even once the list
is gone. The one exception is **Undo**, which removes the entry because the
completion didn't happen.

## Themes

**Edit theme** on the Home tab offers Light, Dark, Miami and Sewer, or your
own. A custom theme gives you a colour picker for each of the nine colours the
app paints with, and repaints live as you pick so you can see what you're
doing. Themes live on the device rather than in the household, since how the
app looks is a matter of whose phone it is.

A word on "private": the app hides those lists from other profiles, but the
database rules are open (see the security note above), so it keeps a list out
of someone's way rather than out of their reach.

## Checking you're on the latest version

The Home tab shows the running build at the bottom (`v20`, and so on). The app
fetches its own code fresh whenever you have a connection and only falls back
to the stored copy offline, so a deploy shows up on the next load. If the
number doesn't change after you've pushed, you're looking at a stale page —
close the app fully and reopen it.

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
