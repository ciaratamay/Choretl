import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, getDoc, addDoc, updateDoc,
  deleteDoc, onSnapshot, query, orderBy, serverTimestamp, Timestamp,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(window.FIREBASE_CONFIG);
const db = getFirestore(app);
enableIndexedDbPersistence(db).catch(() => {});

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

const LS_HOUSEHOLD_ID = "choretl.householdId";
const LS_HOUSEHOLD_NAME = "choretl.householdName";
const LS_PROFILE_ID = "choretl.activeProfileId";
// Kept on this device only — never written to Firestore, which holds just a
// hash. It's here so "Share household" can put the password in the invite
// without making you dig it out of your head every time.
const LS_HOUSEHOLD_PASSWORD = "choretl.householdPassword";

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._h);
  showToast._h = setTimeout(() => t.classList.remove("show"), 2200);
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "household";
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function addMonthsKeepDay(date, n, day) {
  const d = new Date(date);
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, 28));
  return d;
}

function fmtRelative(date) {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function fmtDue(date, hasTime) {
  const opts = { month: "short", day: "numeric" };
  const dateStr = date.toLocaleDateString(undefined, opts);
  if (!hasTime) return dateStr;
  const timeStr = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${dateStr}, ${timeStr}`;
}

// A task with no estimate still counts for something in the Summary, so
// totals don't read as zero work.
const DEFAULT_TASK_MINS = 10;

function fmtMins(total) {
  const mins = Math.max(0, Math.round(total || 0));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

// The next time this weekday comes round, today included.
function nextWeekdayDate(weekday, from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  return addDays(d, (weekday - d.getDay() + 7) % 7);
}

// The next time this day of the month comes round, today included.
function nextMonthDayDate(day, from = new Date()) {
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const d = new Date(from.getFullYear(), from.getMonth(), Math.min(day, 28));
  return d < today ? addMonthsKeepDay(d, 1, day) : d;
}

// Frequencies where the day of the week (or of the month) is already pinned,
// so a free date field would let you pick a day the schedule can't fall on.
// These get a list of the dates that actually match instead.
function freqImpliesDate(type) {
  return type === "weekly" || type === "custom-weeks" || type === "monthly";
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmtShortDay(date) {
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

// The dates a weekday- or monthday-anchored schedule can actually start on:
// the next dozen Wednesdays, or the next dozen 12ths.
function matchingDates(type, freq, count = 12) {
  const out = [];
  if (type === "monthly") {
    let d = nextMonthDayDate(freq.monthDay);
    for (let i = 0; i < count; i++) {
      out.push(d);
      d = addMonthsKeepDay(d, 1, freq.monthDay);
    }
  } else {
    let d = nextWeekdayDate(freq.weekday);
    for (let i = 0; i < count; i++) {
      out.push(d);
      d = addDays(d, 7);
    }
  }
  return out;
}

function freqSummary(freq) {
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  switch (freq.type) {
    case "once": return "One-off";
    case "daily": return "Every day";
    case "weekly":
      return typeof freq.weekday === "number"
        ? `Every week on ${weekdayNames[freq.weekday]}`
        : "Every week";
    case "custom-days": return `Every ${freq.intervalDays} days`;
    case "custom-weeks": return `Every ${freq.intervalWeeks} weeks on ${weekdayNames[freq.weekday]}`;
    case "monthly": return `Monthly on the ${freq.monthDay}${ordinal(freq.monthDay)}`;
    default: return "";
  }
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// How often a task comes around, in days — used for the "most / least
// frequent" sorts. A one-off never comes around at all, so it sorts as the
// least frequent thing there is.
function freqIntervalDays(freq) {
  switch (freq.type) {
    case "daily": return 1;
    case "custom-days": return freq.intervalDays || 1;
    case "weekly": return 7;
    case "custom-weeks": return (freq.intervalWeeks || 1) * 7;
    case "monthly": return 30;
    case "once": return Infinity;
    default: return Infinity;
  }
}

// A task's due date, or null for a "whenever" task that hasn't got one.
function dueDateOf(task) {
  return task.dueAt ? task.dueAt.toDate() : null;
}

// Sorting helper: tasks with no date sort to the end rather than to 1970.
function dueSortValue(task) {
  const d = dueDateOf(task);
  return d ? d.getTime() : Infinity;
}

function advanceDue(task) {
  const base = dueDateOf(task);
  if (!base) return null;
  const f = task.freq;
  switch (f.type) {
    case "once": return base;
    case "daily": return addDays(base, 1);
    case "weekly": return addDays(base, 7);
    case "custom-days": return addDays(base, f.intervalDays);
    case "custom-weeks": return addDays(base, f.intervalWeeks * 7);
    case "monthly": return addMonthsKeepDay(base, 1, f.monthDay);
    default: return addDays(base, 1);
  }
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  const d = startOfDay(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

// When a task starts showing in the To-do tab, and when it starts warning.
//
// A "whenever" task has no date at all: always available, never late.
// A "due on" task is only there on the day itself — bins go out on the
// Wednesday, so there's no point seeing them on the Monday.
// A "due by" task is there for the whole stretch leading up to its date:
// from the day after it was last done, or straight away if it never has
// been. Clean the floors any time this fortnight, just have it done by
// Sunday.
//
// With a time set, an hour's grace before it counts as late; without one,
// you have until the end of the day.
function taskWindow(task) {
  const due = dueDateOf(task);
  if (!due || task.dueMode === "whenever") {
    return { appearAt: null, overdueAt: null };
  }

  const overdueAt = task.hasTime
    ? new Date(due.getTime() + 60 * 60 * 1000)
    : endOfDay(due);

  let appearAt;
  if (task.dueMode === "on") {
    appearAt = task.hasTime ? new Date(due) : startOfDay(due);
  } else {
    const lastAt = task.lastCompletion && task.lastCompletion.at
      ? task.lastCompletion.at.toDate()
      : null;
    // The next stretch opens the morning after it was last done.
    appearAt = lastAt ? startOfDay(addDays(lastAt, 1)) : null;
  }
  return { appearAt, overdueAt };
}

// "pending" = not yet appeared (don't show in To-do), "upcoming" = showing,
// actionable, "overdue" = showing with a warning.
function taskStatus(task, now) {
  const { appearAt, overdueAt } = taskWindow(task);
  if (!overdueAt) return "upcoming";            // a "whenever" task
  if (now > overdueAt) return "overdue";
  if (appearAt && now < appearAt) return "pending";
  return "upcoming";
}

// Missing a "due by" date is a nudge; missing a "due on" one is a miss. They
// warn in different colours to match.
function isSoftOverdue(task) {
  return task.dueMode === "by";
}

// When a task that isn't currently live will be back on the list. That's its
// appear moment, not its due date — a "due by" task reopens the day after it
// was done, which can be a fortnight before the date it's due by.
function nextAppearanceText(task) {
  if (task.freq.type === "once" && task.lastCompletion) return null;
  const { appearAt } = taskWindow(task);
  const when = appearAt || dueDateOf(task);
  if (!when) return null;
  const today = startOfDay(new Date());
  const day = startOfDay(when);
  if (day.getTime() === today.getTime()) return "Back today";
  if (day.getTime() === addDays(today, 1).getTime()) return "Back tomorrow";
  return `Back ${fmtShortDay(when)}`;
}

// How a task's timing reads in a list.
function dueText(task, status) {
  const due = dueDateOf(task);
  if (!due || task.dueMode === "whenever") return "Whenever";
  const when = fmtDue(due, task.hasTime);
  if (status === "overdue") return task.dueMode === "by" ? `Was due by ${when}` : `Was due ${when}`;
  return task.dueMode === "by" ? `Due by ${when}` : `Due ${when}`;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function eyeSvg(open) {
  return open
    ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/></svg>`
    : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.2A10.6 10.6 0 0 1 12 5c7 0 10.5 7 10.5 7a13.6 13.6 0 0 1-3.1 4.1M6.5 6.6C3.4 8.6 1.5 12 1.5 12s3.5 7 10.5 7a9.9 9.9 0 0 0 4.4-1"/><path d="M9.5 9.8a3 3 0 0 0 4.2 4.2"/></svg>`;
}

function checkIconSvg() {
  return `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg>`;
}

function crossIconSvg() {
  return `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>`;
}

function personIconSvg() {
  return `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="6.6" r="3.2"/><path d="M3.9 17c0-3.2 2.7-5.3 6.1-5.3s6.1 2.1 6.1 5.3"/></svg>`;
}

function editIconSvg() {
  return `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.3 3.3l3.4 3.4L6 17.4l-4 .9.9-4L13.3 3.3z"/></svg>`;
}

// ---------- state ----------
let householdId = null;
let householdName = null;
let currentProfile = null;       // {id, name, color}
let profilesCache = {};          // profileId -> {name, color}
let sortedProfileIds = [];
let tasksById = {};
let categoriesCache = {};        // categoryId -> {name}
let sortedCategoryIds = [];
let listsCache = {};             // listId -> list doc
let unsubLists = null;
let logRows = [];                // newest-first, kept so Summary can re-filter
let unsubProfiles = null;
let unsubTasks = null;
let unsubLog = null;
let unsubCategories = null;
let editingTaskId = null;
let editingProfileId = null;     // null while adding a new person
let selectedNewColor = null;
let pendingAutoSelectProfileId = null;
let rolloverTimer = null;
let activeTab = "home";

const PALETTE = [
  "#C0613F", "#1F8A66", "#7B4FA0", "#B8364C",
  "#A6790A", "#0E7C86", "#6B7A33", "#555A64",
];

function fallbackColorForProfile(id) {
  const idx = Math.max(0, sortedProfileIds.indexOf(id));
  return PALETTE[idx % PALETTE.length];
}

function colorForProfile(id) {
  return profilesCache[id]?.color || fallbackColorForProfile(id);
}

function initialForProfile(id) {
  const name = profilesCache[id]?.name || "?";
  return name.trim().charAt(0).toUpperCase();
}

// A profile colour at low opacity, for tinting a card background.
function tintForProfile(id, alpha) {
  const hex = colorForProfile(id).replace("#", "");
  const n = parseInt(hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function categoryName(id) {
  return categoriesCache[id]?.name || null;
}

function buildAvatar(id, opts = {}) {
  const span = document.createElement("span");
  span.className = `avatar${opts.small ? " small" : ""}${id ? "" : " unassigned"}`;
  if (id && profilesCache[id]) {
    span.style.background = colorForProfile(id);
    span.textContent = initialForProfile(id);
  } else {
    span.textContent = "–";
  }
  return span;
}

// ---------- Firestore path helpers (everything lives under the household) ----------
const hhDoc = () => doc(db, "households", householdId);
const profilesCol = () => collection(db, "households", householdId, "profiles");
const profileDoc = (id) => doc(db, "households", householdId, "profiles", id);
const tasksCol = () => collection(db, "households", householdId, "tasks");
const taskDoc = (id) => doc(db, "households", householdId, "tasks", id);
const logCol = () => collection(db, "households", householdId, "log");
const logDoc = (id) => doc(db, "households", householdId, "log", id);
const categoriesCol = () => collection(db, "households", householdId, "categories");
const categoryDoc = (id) => doc(db, "households", householdId, "categories", id);
const listsCol = () => collection(db, "households", householdId, "lists");
const listDoc = (id) => doc(db, "households", householdId, "lists", id);

// ---------- generic UI wiring ----------
function wireEyeButtons() {
  document.querySelectorAll(".eye-btn").forEach((btn) => {
    btn.innerHTML = eyeSvg(false);
    btn.addEventListener("click", () => {
      const input = $(btn.dataset.target);
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      btn.innerHTML = eyeSvg(reveal);
      btn.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
    });
  });
}

function wireSegmented() {
  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const mode = btn.dataset.mode;
      $("household-step-join").classList.toggle("hidden", mode !== "join");
      $("household-step-create").classList.toggle("hidden", mode !== "create");
    });
  });
}

// ---------- home-pane step switching ----------
let currentHomeStep = null;

function showHomeStep(step) {
  $("home-no-household").classList.toggle("hidden", step !== "gate");
  $("home-pick-profile").classList.toggle("hidden", step !== "profiles");
  $("home-step-profile").classList.toggle("hidden", step !== "profile-edit");
  $("home-signed-in").classList.toggle("hidden", step !== "active");
  $("home-categories").classList.toggle("hidden", step !== "categories");
  $("home-lists").classList.toggle("hidden", step !== "lists");
  $("home-list-edit").classList.toggle("hidden", step !== "list-edit");
  // Only on a real step change — a background sync re-asserting the same
  // step shouldn't yank the page out from under anyone mid-scroll.
  if (step !== currentHomeStep) {
    currentHomeStep = step;
    if (activeTab === "home") window.scrollTo(0, 0);
  }
}

// Modals sit over the page, so lock the body while one is open — otherwise
// the list behind scrolls under your finger on a phone.
function setModalOpen(backdropId, open) {
  const backdrop = $(backdropId);
  backdrop.classList.toggle("hidden", !open);
  if (open) {
    const body = backdrop.querySelector(".modal-body");
    if (body) body.scrollTop = 0;
  }
  document.body.classList.toggle("modal-open",
    document.querySelectorAll(".modal-backdrop:not(.hidden)").length > 0);
}

// ---------- create / join household ----------
on("input-join-name", "input", () => {
  $("household-hint-display").classList.add("hidden");
});

on("btn-show-household-hint", "click", async () => {
  const name = $("input-join-name").value.trim();
  if (!name) { showToast("Enter the household name first."); return; }
  try {
    const snap = await getDoc(doc(db, "households", slugify(name)));
    const h = $("household-hint-display");
    if (!snap.exists()) {
      h.textContent = "No household with that name.";
    } else {
      const data = snap.data();
      h.textContent = data.hint ? `Hint: ${data.hint}` : "No hint was set for this household.";
    }
    h.classList.remove("hidden");
  } catch (e) {
    showToast("Couldn't look that up right now.");
  }
});

on("btn-create-household", "click", async () => {
  const name = $("input-create-name").value.trim();
  const password = $("input-create-password").value;
  const hint = $("input-create-hint").value.trim();
  const err = $("create-household-error");
  err.textContent = "";

  if (!name) { err.textContent = "Enter a household name."; return; }
  if (password.length < 6) { err.textContent = "Password needs to be at least 6 characters."; return; }

  const id = slugify(name);
  $("btn-create-household").disabled = true;
  try {
    const ref = doc(db, "households", id);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      err.textContent = "That household name is taken — try joining it instead.";
      return;
    }
    const passwordHash = await sha256Hex(`${id}:${password}`);
    await setDoc(ref, { name, passwordHash, hint: hint || null, createdAt: serverTimestamp() });
    localStorage.setItem(LS_HOUSEHOLD_PASSWORD, password);
    enterHousehold(id, name);
  } catch (e) {
    err.textContent = `Couldn't create that household — ${e.message || e.code || "unknown error"}.`;
  } finally {
    $("btn-create-household").disabled = false;
  }
});

on("btn-join-household", "click", () => doJoinHousehold());
on("input-join-password", "keydown", (e) => { if (e.key === "Enter") doJoinHousehold(); });

async function doJoinHousehold() {
  const name = $("input-join-name").value.trim();
  const password = $("input-join-password").value;
  const err = $("join-error");
  err.textContent = "";
  if (!name) { err.textContent = "Enter the household name."; return; }
  if (!password) { err.textContent = "Enter the password."; return; }

  const id = slugify(name);
  $("btn-join-household").disabled = true;
  try {
    const snap = await getDoc(doc(db, "households", id));
    if (!snap.exists()) { err.textContent = "No household with that name."; return; }
    const data = snap.data();
    const hash = await sha256Hex(`${id}:${password}`);
    if (hash !== data.passwordHash) { err.textContent = "That password doesn't match."; return; }
    localStorage.setItem(LS_HOUSEHOLD_PASSWORD, password);
    enterHousehold(id, data.name || name);
  } catch (e) {
    err.textContent = `Couldn't join right now — ${e.message || e.code || "unknown error"}.`;
  } finally {
    $("btn-join-household").disabled = false;
  }
}

function enterHousehold(id, name) {
  householdId = id;
  householdName = name;
  localStorage.setItem(LS_HOUSEHOLD_ID, id);
  localStorage.setItem(LS_HOUSEHOLD_NAME, name);
  $("household-name-display").textContent = name;
  $("household-name-display-2").textContent = name;
  pendingAutoSelectProfileId = localStorage.getItem(LS_PROFILE_ID);
  subscribeProfiles();
  subscribeCategories();
  subscribeLists();
  subscribeTasks();
  subscribeLog();
  startRollover();
}

// Keeps the "Home" tab label and the tab bar's colour in sync with whoever
// is currently active — their name instead of "Home", their colour instead
// of the default blue.
function syncIdentityUI() {
  const homeLabel = $("tab-home-label");
  if (homeLabel) homeLabel.textContent = currentProfile ? currentProfile.name : "Home";
  if (currentProfile) {
    document.documentElement.style.setProperty("--active-tab-color", colorForProfile(currentProfile.id));
  } else {
    document.documentElement.style.removeProperty("--active-tab-color");
  }
}

// ---------- sharing the household ----------
// Where this copy of the app lives, so the invite points wherever it's
// actually hosted rather than at a URL baked in at build time.
function appUrl() {
  const { origin, pathname } = window.location;
  if (origin.startsWith("http")) {
    const dir = pathname.replace(/[^/]*$/, "");
    return `${origin}${dir}`;
  }
  return "https://ciaratamay.github.io/Choretl/";
}

function buildInviteText(password) {
  return [
    `Join my household task tracker at ${appUrl()}`,
    "",
    "* Open that link, then use the “Install on this device” button on the Home tab to add it to your phone. If it isn't there: on Android open the browser menu (top right) and choose “Install app”; on iPhone tap Share, then “Add to Home Screen”.",
    `* Join my household called “${householdName || ""}”`,
    `* Enter password - ${password || "(I'll send this separately)"}`,
  ].join("\n");
}

function refreshInvitePreview() {
  $("share-preview").value = buildInviteText($("input-share-password").value.trim());
}

// Read once when the share sheet opens, so "Check password" and "View hint"
// both answer instantly instead of hitting the network on every tap.
let shareHouseholdData = null;

on("btn-share-household", "click", async () => {
  $("input-share-password").value = localStorage.getItem(LS_HOUSEHOLD_PASSWORD) || "";
  clearShareChecks();
  refreshInvitePreview();
  setModalOpen("share-modal-backdrop", true);
  shareHouseholdData = null;
  try {
    const snap = await getDoc(hhDoc());
    if (snap.exists()) shareHouseholdData = snap.data();
  } catch (e) {
    // Offline — the buttons say so if they're used.
  }
});

function clearShareChecks() {
  const r = $("share-password-result");
  r.className = "pw-result hidden";
  r.innerHTML = "";
  $("share-hint-display").classList.add("hidden");
}

function showPasswordResult(state, message) {
  const r = $("share-password-result");
  r.className = `pw-result ${state}`;
  r.innerHTML = state === "ok" ? checkIconSvg() : (state === "bad" ? crossIconSvg() : "");
  const span = document.createElement("span");
  span.textContent = message;
  r.appendChild(span);
}

on("input-share-password", "input", () => {
  // A verdict about the old text would be misleading next to new text.
  clearShareChecks();
  refreshInvitePreview();
});

on("btn-check-share-password", "click", async () => {
  const typed = $("input-share-password").value;
  if (!typed) { showPasswordResult("neutral", "Nothing entered to check."); return; }
  if (!shareHouseholdData) {
    try {
      const snap = await getDoc(hhDoc());
      if (snap.exists()) shareHouseholdData = snap.data();
    } catch (e) { /* handled below */ }
  }
  if (!shareHouseholdData) {
    showPasswordResult("neutral", "Couldn't check right now — no connection.");
    return;
  }
  const hash = await sha256Hex(`${householdId}:${typed}`);
  if (hash === shareHouseholdData.passwordHash) {
    localStorage.setItem(LS_HOUSEHOLD_PASSWORD, typed);
    showPasswordResult("ok", "Password is correct");
  } else {
    showPasswordResult("bad", "Password is wrong");
  }
});

on("btn-show-share-hint", "click", async () => {
  if (!shareHouseholdData) {
    try {
      const snap = await getDoc(hhDoc());
      if (snap.exists()) shareHouseholdData = snap.data();
    } catch (e) { /* handled below */ }
  }
  const h = $("share-hint-display");
  if (!shareHouseholdData) h.textContent = "Couldn't load the hint right now — no connection.";
  else if (shareHouseholdData.hint) h.textContent = `Hint: ${shareHouseholdData.hint}`;
  else h.textContent = "No hint was set for this household.";
  h.classList.remove("hidden");
});

on("btn-close-share", "click", () => setModalOpen("share-modal-backdrop", false));

// Copies exactly what's in the box — checking it is a separate, deliberate step.
on("btn-copy-share", "click", () =>
  copyText(buildInviteText($("input-share-password").value.trim()), "Invite copied"));

function leaveHousehold() {
  teardown();
  householdId = null;
  householdName = null;
  currentProfile = null;
  syncIdentityUI();
  localStorage.removeItem(LS_HOUSEHOLD_ID);
  localStorage.removeItem(LS_HOUSEHOLD_NAME);
  localStorage.removeItem(LS_PROFILE_ID);
  localStorage.removeItem(LS_HOUSEHOLD_PASSWORD);
  $("input-join-name").value = "";
  $("input-join-password").value = "";
  $("input-create-name").value = "";
  $("input-create-password").value = "";
  $("input-create-hint").value = "";
  resetHouseholdGateToJoin();
  showHomeStep("gate");
  setTabsLocked(true);
  switchTab("home");
}

function resetHouseholdGateToJoin() {
  document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === "join"));
  $("household-step-join").classList.remove("hidden");
  $("household-step-create").classList.add("hidden");
}

function teardown() {
  if (unsubProfiles) unsubProfiles();
  if (unsubTasks) unsubTasks();
  if (unsubLog) unsubLog();
  if (unsubCategories) unsubCategories();
  if (unsubLists) unsubLists();
  if (rolloverTimer) clearInterval(rolloverTimer);
  unsubProfiles = unsubTasks = unsubLog = unsubCategories = unsubLists = null;
  rolloverTimer = null;
  tasksById = {};
  profilesCache = {};
  sortedProfileIds = [];
  categoriesCache = {};
  sortedCategoryIds = [];
  listsCache = {};
  listFilter.clear();
  logRows = [];
}

on("btn-leave-household-1", "click", () => {
  if (confirm("Leave this household on this device? You can rejoin any time with the password.")) leaveHousehold();
});
on("btn-leave-household-2", "click", () => {
  if (confirm("Leave this household on this device? You can rejoin any time with the password.")) leaveHousehold();
});

// ---------- profiles within a household ----------
function subscribeProfiles() {
  if (unsubProfiles) unsubProfiles();
  unsubProfiles = onSnapshot(profilesCol(), (snap) => {
    profilesCache = {};
    snap.forEach((d) => { profilesCache[d.id] = d.data(); });
    sortedProfileIds = Object.keys(profilesCache).sort((a, b) =>
      (profilesCache[a].name || "").localeCompare(profilesCache[b].name || ""));
    onProfilesUpdated();
  }, () => showToast("Having trouble syncing right now."));
}

function onProfilesUpdated() {
  if (currentProfile && !profilesCache[currentProfile.id]) {
    // The active profile was deleted (maybe by the other person) — drop back to the picker.
    currentProfile = null;
    localStorage.removeItem(LS_PROFILE_ID);
    syncIdentityUI();
    showHomeStep("profiles");
    setTabsLocked(true);
    switchTab("home");
  } else if (currentProfile) {
    currentProfile = { id: currentProfile.id, ...profilesCache[currentProfile.id] };
    $("me-badge").textContent = currentProfile.name;
    syncIdentityUI();
  } else if (pendingAutoSelectProfileId && profilesCache[pendingAutoSelectProfileId]) {
    const id = pendingAutoSelectProfileId;
    pendingAutoSelectProfileId = null;
    selectProfile(id);
  } else {
    showHomeStep("profiles");
    setTabsLocked(true);
  }
  populateOwnerSelect();
  if (currentProfile) populatePersonFilters();
  renderProfilePicker(); // keeps the list (and the "current" highlight) live even while hidden
  renderAll();
}

function renderProfilePicker() {
  const list = $("profile-list");
  list.innerHTML = "";
  $("profile-list-empty").classList.toggle("hidden", sortedProfileIds.length > 0);
  sortedProfileIds.forEach((id) => {
    const p = profilesCache[id];
    const row = document.createElement("div");
    row.className = "profile-pick-row";

    const btn = document.createElement("button");
    btn.className = `profile-pick${currentProfile && id === currentProfile.id ? " current" : ""}`;
    btn.appendChild(buildAvatar(id, { small: true }));
    btn.appendChild(document.createTextNode(p.name));
    btn.onclick = () => selectProfile(id);
    row.appendChild(btn);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "icon-edit-btn";
    editBtn.setAttribute("aria-label", `Edit ${p.name}`);
    editBtn.innerHTML = editIconSvg();
    editBtn.onclick = (e) => { e.stopPropagation(); openEditProfile(id); };
    row.appendChild(editBtn);

    list.appendChild(row);
  });
}

function selectProfile(id, fallbackData) {
  // Normally profilesCache is already populated by the live listener, but
  // right after creating a brand-new profile the listener's update can lag
  // a tick behind addDoc's own promise — fall back to the data we just
  // wrote so we don't strand the user on the "add person" screen.
  const data = profilesCache[id] || fallbackData;
  if (!data) return;
  currentProfile = { id, ...data };
  localStorage.setItem(LS_PROFILE_ID, id);
  $("me-badge").textContent = currentProfile.name;
  syncIdentityUI();
  populateOwnerSelect();
  populatePersonFilters();
  rebuildTabs();
  renderListAdmin();
  populateListSelect();
  renderProfilePicker();
  showHomeStep("active");
  setTabsLocked(false);
  renderAll();
  // Deliberately no tab switch here — picking or switching a profile stays
  // on the Home tab until the person navigates themselves.
}

on("btn-switch-profile", "click", () => {
  // The active profile stays active (and highlighted) while browsing this
  // list — tapping a different name is what actually switches.
  renderProfilePicker();
  showHomeStep("profiles");
});

on("btn-show-add-profile", "click", () => openAddProfile());
on("btn-back-to-profiles", "click", () => {
  renderProfilePicker();
  showHomeStep("profiles");
});

function openAddProfile() {
  editingProfileId = null;
  $("profile-step-title").textContent = "Add a person";
  $("input-profile-name").value = "";
  $("profile-error").textContent = "";
  $("btn-delete-profile").classList.add("hidden");
  renderColorSwatches();
  showHomeStep("profile-edit");
}

function openEditProfile(id) {
  editingProfileId = id;
  const p = profilesCache[id];
  $("profile-step-title").textContent = "Edit person";
  $("input-profile-name").value = p.name;
  $("profile-error").textContent = "";
  $("btn-delete-profile").classList.remove("hidden");
  renderColorSwatches(p.color);
  showHomeStep("profile-edit");
}

function renderColorSwatches(preselect) {
  const row = $("color-swatch-row");
  row.innerHTML = "";
  const usedColors = new Set(
    Object.entries(profilesCache)
      .filter(([id]) => id !== editingProfileId)
      .map(([, p]) => p.color)
      .filter(Boolean)
  );
  selectedNewColor = preselect || PALETTE.find((c) => !usedColors.has(c)) || PALETTE[0];
  PALETTE.forEach((color) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `swatch${color === selectedNewColor ? " selected" : ""}`;
    btn.style.background = color;
    btn.onclick = () => {
      selectedNewColor = color;
      row.querySelectorAll(".swatch").forEach((s) => s.classList.remove("selected"));
      btn.classList.add("selected");
    };
    row.appendChild(btn);
  });
}

on("btn-save-profile", "click", async () => {
  const name = $("input-profile-name").value.trim();
  const err = $("profile-error");
  err.textContent = "";
  if (!name) { err.textContent = "Enter a name."; return; }
  const nameTaken = Object.entries(profilesCache)
    .some(([id, p]) => id !== editingProfileId && p.name.toLowerCase() === name.toLowerCase());
  if (nameTaken) { err.textContent = "Someone in this household already has that name."; return; }

  $("btn-save-profile").disabled = true;
  try {
    if (editingProfileId) {
      await updateDoc(profileDoc(editingProfileId), { name, color: selectedNewColor });
      renderProfilePicker();
      showHomeStep("profiles");
    } else {
      const ref = await addDoc(profilesCol(), { name, color: selectedNewColor, createdAt: serverTimestamp() });
      selectProfile(ref.id, { name, color: selectedNewColor });
    }
  } catch (e) {
    err.textContent = `Couldn't save — ${e.message || e.code || "unknown error"}.`;
  } finally {
    $("btn-save-profile").disabled = false;
  }
});

on("btn-delete-profile", "click", async () => {
  if (!editingProfileId) return;
  const p = profilesCache[editingProfileId];
  if (!confirm(`Delete ${p?.name || "this person"}? Tasks owned by, assigned to, or done by them will become unassigned.`)) return;
  const id = editingProfileId;
  try {
    const touched = Object.values(tasksById).filter((t) =>
      t.assignedTo === id || t.owner === id || (t.lastCompletion && t.lastCompletion.by === id));
    await Promise.all(touched.map((t) => {
      const patch = {};
      if (t.assignedTo === id) patch.assignedTo = null;
      if (t.owner === id) patch.owner = null;
      if (t.lastCompletion && t.lastCompletion.by === id) patch["lastCompletion.by"] = null;
      return updateDoc(taskDoc(t.id), patch);
    }));
    await deleteDoc(profileDoc(id));
    if (currentProfile?.id === id) {
      currentProfile = null;
      localStorage.removeItem(LS_PROFILE_ID);
    }
    renderProfilePicker();
    showHomeStep("profiles");
    showToast("Person deleted");
  } catch (e) {
    showToast(`Couldn't delete — ${e.message || e.code || "unknown error"}`);
  }
});

// ---------- custom lists ----------
// A list is a tab of its own holding its own tasks. A private one belongs to
// the person who made it and is hidden from everyone else in the household —
// their tabs, their To-do, their logs and summaries. That hiding is done by
// the app, not by the database, which is wide open either way (see the
// README); it keeps a work list out of your partner's way, it doesn't keep a
// determined person out of your data.
function subscribeLists() {
  if (unsubLists) unsubLists();
  unsubLists = onSnapshot(listsCol(), (snap) => {
    listsCache = {};
    snap.forEach((d) => { listsCache[d.id] = { id: d.id, ...d.data() }; });
    pruneListFilter();
    rebuildTabs();
    renderListAdmin();
    populateListSelect();
    renderAll();
  }, () => showToast("Having trouble syncing lists right now."));
}

function listById(id) {
  return id ? listsCache[id] : null;
}

// Lists this profile is allowed to see, in tab order.
function visibleLists() {
  return Object.values(listsCache)
    .filter((l) => !l.private || (currentProfile && l.privateTo === currentProfile.id))
    .sort((a, b) => (a.order || Infinity) - (b.order || Infinity)
      || (a.name || "").localeCompare(b.name || ""));
}

function canSeeList(id) {
  const l = listById(id);
  if (!l) return true;              // no list, or one that's been deleted
  return !l.private || (currentProfile && l.privateTo === currentProfile.id);
}

// Can this task be shown to whoever is viewing at all?
function taskVisible(task) {
  return canSeeList(task.listId);
}

// Does it count towards the Home checklist, the Log and the Summary?
function taskCountsInSummaries(task) {
  if (!taskVisible(task)) return false;
  const l = listById(task.listId);
  return !l || l.includeInSummaries !== false;
}

// The list filter works like the category one: a set, empty meaning "all".
const listFilter = new Set();

function pruneListFilter() {
  [...listFilter].forEach((id) => {
    if (id !== "main" && !canSeeList(id)) listFilter.delete(id);
  });
}

function matchesListFilter(task) {
  if (listFilter.size === 0) return true;
  if (!task.listId) return listFilter.has("main");
  return listFilter.has(task.listId);
}

// Everything a shared view shows has to clear both: visible to me, and not
// filtered out.
function passesListRules(task) {
  return taskVisible(task) && matchesListFilter(task);
}

// ---------- managing custom lists ----------
let editingListId = null;

on("btn-edit-lists", "click", () => {
  renderListAdmin();
  showHomeStep("lists");
});
on("btn-back-from-lists", "click", () => showHomeStep("active"));
on("btn-back-to-lists", "click", () => { renderListAdmin(); showHomeStep("lists"); });
on("btn-show-add-list", "click", () => openListEditor(null));
on("input-list-private", "change", syncListOwnerRow);

function syncListOwnerRow() {
  // A private list is yours by definition — nobody else to hand it to.
  $("wrap-list-owner").classList.toggle("hidden", $("input-list-private").checked);
}

function renderListAdmin() {
  const wrap = $("list-admin");
  if (!wrap) return;
  const lists = visibleLists();
  wrap.innerHTML = "";
  $("list-admin-empty").classList.toggle("hidden", lists.length > 0);

  lists.forEach((l) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "list-admin-row";

    const icon = document.createElement("span");
    icon.className = "list-admin-icon";
    icon.textContent = l.emoji || "•";
    row.appendChild(icon);

    const main = document.createElement("span");
    main.className = "list-admin-main";
    const name = document.createElement("span");
    name.className = "list-admin-name";
    name.textContent = l.name;
    main.appendChild(name);

    const bits = [l.order ? `#${l.order}` : "last"];
    if (l.private) bits.push("private");
    else if (l.owner && profilesCache[l.owner]) bits.push(profilesCache[l.owner].name);
    if (l.includeInSummaries === false) bits.push("own tab only");
    const meta = document.createElement("span");
    meta.className = "list-admin-meta";
    meta.textContent = bits.join(" · ");
    main.appendChild(meta);
    row.appendChild(main);

    const count = document.createElement("span");
    count.className = "list-admin-count";
    const n = Object.values(tasksById).filter((t) => t.listId === l.id).length;
    count.textContent = `${n} task${n === 1 ? "" : "s"}`;
    row.appendChild(count);

    row.onclick = () => openListEditor(l.id);
    wrap.appendChild(row);
  });
}

function openListEditor(id) {
  editingListId = id;
  const l = id ? listsCache[id] : null;
  $("list-edit-title").textContent = l ? "Edit list" : "Add a list";
  $("input-list-name").value = l ? l.name : "";
  $("input-list-emoji").value = l ? (l.emoji || "") : "";
  $("input-list-private").checked = l ? !!l.private : false;
  $("input-list-summaries").checked = l ? l.includeInSummaries !== false : true;
  $("list-error").textContent = "";
  $("btn-delete-list").classList.toggle("hidden", !l);

  // The order can run from 1 (straight after Home) to one past the current
  // tabs, which is what a brand-new list takes by default: last.
  const max = maxTabOrder() + (l ? 0 : 1);
  $("input-list-order").max = max;
  $("input-list-order").value = l && l.order ? l.order : max;
  $("list-order-hint").textContent = `1 puts it first after Home. Leave it at ${max} to keep it last, whatever else gets added.`;

  populateOwnerLikeSelect($("input-list-owner"), l ? l.owner : null);
  fillPersonOptions($("input-list-filter"), "due");
  $("input-list-filter").value = l && l.defaultFilter ? l.defaultFilter : "anyone";
  $("input-list-sort").value = l && l.defaultSort ? l.defaultSort : "dueDate";

  syncListOwnerRow();
  showHomeStep("list-edit");
}

function populateOwnerLikeSelect(sel, current) {
  sel.innerHTML = '<option value="">No owner</option>';
  sortedProfileIds.forEach((id) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = profilesCache[id].name;
    sel.appendChild(opt);
  });
  sel.value = current && profilesCache[current] ? current : "";
}

on("btn-save-list", "click", async () => {
  const name = $("input-list-name").value.trim();
  const err = $("list-error");
  err.textContent = "";
  if (!name) { err.textContent = "Give the list a name."; return; }
  const clash = Object.values(listsCache)
    .some((l) => l.id !== editingListId && (l.name || "").toLowerCase() === name.toLowerCase());
  if (clash) { err.textContent = "There's already a list with that name."; return; }

  const isPrivate = $("input-list-private").checked;
  const max = maxTabOrder() + (editingListId ? 0 : 1);
  const data = {
    name,
    emoji: $("input-list-emoji").value.trim(),
    // The top number means "last" rather than a fixed slot, so a list left
    // at the default stays at the end when another is added in front of it.
    order: (() => {
      const n = Math.max(1, Math.min(max, parseInt($("input-list-order").value, 10) || max));
      return n >= max ? null : n;
    })(),
    private: isPrivate,
    privateTo: isPrivate ? (currentProfile ? currentProfile.id : null) : null,
    owner: isPrivate ? null : ($("input-list-owner").value || null),
    includeInSummaries: $("input-list-summaries").checked,
    defaultFilter: $("input-list-filter").value,
    defaultSort: $("input-list-sort").value,
  };

  $("btn-save-list").disabled = true;
  try {
    if (editingListId) {
      await updateDoc(listDoc(editingListId), data);
    } else {
      await addDoc(listsCol(), { ...data, createdBy: currentProfile.id, createdAt: serverTimestamp() });
    }
    renderListAdmin();
    showHomeStep("lists");
    showToast("List saved");
  } catch (e) {
    err.textContent = `Couldn't save — ${e.message || e.code || "unknown error"}.`;
  } finally {
    $("btn-save-list").disabled = false;
  }
});

// ---------- deleting a list ----------
let deletingListId = null;
let deleteListChoice = "keep";

on("btn-delete-list", "click", () => {
  if (editingListId) openDeleteListModal(editingListId);
});

function openDeleteListModal(id) {
  deletingListId = id;
  deleteListChoice = "keep";
  const l = listsCache[id];
  const n = Object.values(tasksById).filter((t) => t.listId === id).length;
  const them = n === 1 ? "it" : "them";

  $("dellist-title").textContent = `Delete “${l ? l.name : "this list"}”?`;
  $("dellist-sub").textContent = n
    ? `There ${n === 1 ? "is" : "are"} ${n} task${n === 1 ? "" : "s"} on this list. What should happen to ${them}?`
    : "The list is empty, so there's nothing else to decide.";
  $("dellist-choices").classList.toggle("hidden", n === 0);
  $("dellist-keep-note").textContent = `${n === 1 ? "It moves" : "They move"} back to the main lists.`;
  $("dellist-delete-note").textContent = `${n === 1 ? "It goes" : "They go"} for good, along with the list.`;

  const note = $("dellist-history-note");
  note.textContent = "Anything already done on this list stays in your log, under the list's name.";
  note.classList.remove("hidden");

  renderDeleteListChoices();
  setModalOpen("dellist-modal-backdrop", true);
}

function renderDeleteListChoices() {
  document.querySelectorAll("#dellist-choices .choice").forEach((btn) => {
    const on_ = btn.dataset.choice === deleteListChoice;
    btn.classList.toggle("selected", on_);
    btn.setAttribute("aria-pressed", on_ ? "true" : "false");
  });
}

document.querySelectorAll("#dellist-choices .choice").forEach((btn) => {
  btn.addEventListener("click", () => {
    deleteListChoice = btn.dataset.choice;
    renderDeleteListChoices();
  });
});

on("btn-cancel-dellist", "click", () => {
  setModalOpen("dellist-modal-backdrop", false);
  deletingListId = null;
});

on("btn-confirm-dellist", "click", async () => {
  const id = deletingListId;
  if (!id) return;
  const used = Object.values(tasksById).filter((t) => t.listId === id);

  $("btn-confirm-dellist").disabled = true;
  try {
    if (deleteListChoice === "delete") {
      await Promise.all(used.map((t) => deleteDoc(taskDoc(t.id))));
    } else {
      await Promise.all(used.map((t) => updateDoc(taskDoc(t.id), { listId: null })));
    }

    // The log is left alone. What was done was done, and whoever could see it
    // at the time still can — including the name of a list that's now gone.
    await deleteDoc(listDoc(id));
    listFilter.delete(id);
    editingListId = null;
    deletingListId = null;
    setModalOpen("dellist-modal-backdrop", false);
    renderListAdmin();
    showHomeStep("lists");
    showToast(deleteListChoice === "delete" ? "List and its tasks deleted" : "List deleted");
  } catch (e) {
    showToast(`Couldn't delete — ${e.message || e.code || "unknown error"}`);
  } finally {
    $("btn-confirm-dellist").disabled = false;
  }
});

// ---------- categories ----------
function subscribeCategories() {
  if (unsubCategories) unsubCategories();
  unsubCategories = onSnapshot(categoriesCol(), (snap) => {
    categoriesCache = {};
    snap.forEach((d) => { categoriesCache[d.id] = d.data(); });
    sortedCategoryIds = Object.keys(categoriesCache).sort((a, b) =>
      (categoriesCache[a].name || "").localeCompare(categoriesCache[b].name || ""));
    pruneCategoryFilter();
    syncCategoryFilterButtons();
    renderCategoryFilterOptions();
    renderTaskCategoryChips();
    renderCategoryAdmin();
    renderAll();
  }, () => showToast("Having trouble syncing categories right now."));
}

const CAT_FILTER_IDS = [
  "filter-cat-home", "filter-cat-due", "filter-cat-done",
  "filter-cat-alltasks", "filter-cat-summary", "filter-cat-list",
];

// Categories are tags, so the filter is a set rather than one choice, and a
// task shows if it carries ANY of the picked ones. Empty set = no filtering.
// A category means the same thing in every tab, so unlike the person filters
// this one setting carries across all of them.
const categoryFilter = new Set();

function categoryFilterLabel() {
  const total = categoryFilter.size + listFilter.size;
  if (total === 0) return "All categories";
  if (total === 1) {
    if (listFilter.size === 1) {
      const only = [...listFilter][0];
      if (only === "main") return "Main lists";
      const l = listById(only);
      return l ? (l.emoji ? `${l.emoji} ${l.name}` : l.name) : "1 list";
    }
    const only = [...categoryFilter][0];
    return only === "none" ? "Untagged" : (categoryName(only) || "1 category");
  }
  return `${total} filters`;
}

function syncCategoryFilterButtons() {
  CAT_FILTER_IDS.forEach((id) => {
    const btn = $(id);
    if (!btn) return;
    btn.textContent = categoryFilterLabel();
    btn.classList.toggle("filtering", categoryFilter.size > 0);
  });
}

function matchesCategoryFilter(task) {
  if (categoryFilter.size === 0) return true;
  const ids = task.categoryIds || [];
  if (categoryFilter.has("none") && ids.length === 0) return true;
  return ids.some((id) => categoryFilter.has(id));
}

// Tags that no longer exist (deleted elsewhere) shouldn't keep filtering.
function pruneCategoryFilter() {
  [...categoryFilter].forEach((id) => {
    if (id !== "none" && !categoriesCache[id]) categoryFilter.delete(id);
  });
}

// ---------- the shared "filter by category" picker ----------
CAT_FILTER_IDS.forEach((id) => {
  const btn = $(id);
  if (btn) btn.addEventListener("click", openCategoryFilterModal);
});

function openCategoryFilterModal() {
  renderCategoryFilterOptions();
  renderListFilterOptions();
  setModalOpen("catfilter-modal-backdrop", true);
}

// Lists sit in the same filter sheet as categories so the tab heads don't
// grow another control.
function renderListFilterOptions() {
  const wrap = $("listfilter-options");
  const lists = visibleLists();
  $("listfilter-field").classList.toggle("hidden", lists.length === 0);
  if (!lists.length) return;
  wrap.innerHTML = "";

  const entries = [["main", "Main lists"]].concat(
    lists.map((l) => [l.id, l.emoji ? `${l.emoji} ${l.name}` : l.name]));

  entries.forEach(([value, label]) => {
    wrap.appendChild(buildChip(label, listFilter.has(value), () => {
      if (listFilter.has(value)) listFilter.delete(value);
      else listFilter.add(value);
      renderListFilterOptions();
      syncCategoryFilterButtons();
      renderAll();
    }));
  });
}

function renderCategoryFilterOptions() {
  const wrap = $("catfilter-options");
  wrap.innerHTML = "";
  $("catfilter-empty").classList.toggle("hidden", sortedCategoryIds.length > 0);

  const entries = sortedCategoryIds.map((id) => [id, categoriesCache[id].name]);
  if (sortedCategoryIds.length) entries.push(["none", "Untagged"]);

  entries.forEach(([value, label]) => {
    wrap.appendChild(buildChip(label, categoryFilter.has(value), () => {
      if (categoryFilter.has(value)) categoryFilter.delete(value);
      else categoryFilter.add(value);
      renderCategoryFilterOptions();
      syncCategoryFilterButtons();
      renderAll();
    }));
  });
}

on("btn-clear-catfilter", "click", () => {
  categoryFilter.clear();
  listFilter.clear();
  renderCategoryFilterOptions();
  renderListFilterOptions();
  syncCategoryFilterButtons();
  renderAll();
});
on("btn-close-catfilter", "click", () => setModalOpen("catfilter-modal-backdrop", false));

// A tappable tag — used for both picking a task's categories and filtering.
function buildChip(label, selected, onToggle) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `chip${selected ? " selected" : ""}`;
  btn.textContent = label;
  btn.setAttribute("aria-pressed", selected ? "true" : "false");
  btn.onclick = onToggle;
  return btn;
}

// ---------- the task modal's category chips ----------
const taskModalCategories = new Set();

function renderTaskCategoryChips() {
  const wrap = $("input-task-categories");
  wrap.innerHTML = "";
  sortedCategoryIds.forEach((id) => {
    wrap.appendChild(buildChip(categoriesCache[id].name, taskModalCategories.has(id), () => {
      if (taskModalCategories.has(id)) taskModalCategories.delete(id);
      else taskModalCategories.add(id);
      renderTaskCategoryChips();
    }));
  });
  const none = sortedCategoryIds.length === 0;
  $("category-empty-hint").classList.toggle("hidden", !none);
  $("category-multi-hint").classList.toggle("hidden", none);
}

on("btn-edit-categories", "click", () => {
  $("category-error").textContent = "";
  $("input-new-category").value = "";
  renderCategoryAdmin();
  showHomeStep("categories");
});
on("btn-back-from-categories", "click", () => showHomeStep("active"));
on("btn-add-category", "click", () => addCategory());
on("input-new-category", "keydown", (e) => { if (e.key === "Enter") addCategory(); });

async function addCategory() {
  const name = $("input-new-category").value.trim();
  const err = $("category-error");
  err.textContent = "";
  if (!name) { err.textContent = "Give the category a name."; return; }
  if (Object.values(categoriesCache).some((c) => (c.name || "").toLowerCase() === name.toLowerCase())) {
    err.textContent = "There's already a category with that name."; return;
  }
  try {
    await addDoc(categoriesCol(), { name, createdAt: serverTimestamp() });
    $("input-new-category").value = "";
  } catch (e) {
    err.textContent = `Couldn't add that — ${e.message || e.code || "unknown error"}.`;
  }
}

function renderCategoryAdmin() {
  const wrap = $("category-admin-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  $("category-list-empty").classList.toggle("hidden", sortedCategoryIds.length > 0);

  sortedCategoryIds.forEach((id) => {
    const row = document.createElement("div");
    row.className = "category-admin-row";

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 30;
    input.value = categoriesCache[id].name || "";
    // Renaming saves when you tab away or press Enter — no extra save button.
    input.onchange = async () => {
      const next = input.value.trim();
      if (!next) { input.value = categoriesCache[id].name || ""; return; }
      try {
        await updateDoc(categoryDoc(id), { name: next });
      } catch (e) {
        showToast("Couldn't rename that category.");
      }
    };
    input.onkeydown = (e) => { if (e.key === "Enter") input.blur(); };
    row.appendChild(input);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "text-btn danger";
    del.textContent = "Delete";
    del.onclick = () => deleteCategory(id);
    row.appendChild(del);

    wrap.appendChild(row);
  });
}

async function deleteCategory(id) {
  const name = categoriesCache[id]?.name || "this category";
  const used = Object.values(tasksById).filter((t) => (t.categoryIds || []).includes(id));
  const msg = used.length
    ? `Delete "${name}"? ${used.length} task${used.length === 1 ? "" : "s"} will lose that tag — any other tags, and the tasks themselves, stay.`
    : `Delete "${name}"?`;
  if (!confirm(msg)) return;
  try {
    await Promise.all(used.map((t) => updateDoc(taskDoc(t.id), {
      categoryIds: t.categoryIds.filter((c) => c !== id),
    })));
    await deleteDoc(categoryDoc(id));
    categoryFilter.delete(id);
    taskModalCategories.delete(id);
    syncCategoryFilterButtons();
    showToast("Category deleted");
  } catch (e) {
    showToast(`Couldn't delete — ${e.message || e.code || "unknown error"}`);
  }
}

// ---------- tabs ----------
const BUILTIN_TABS = [
  { tab: "due", label: "To-do" },
  { tab: "done", label: "Done" },
  { tab: "alltasks", label: "All tasks" },
  { tab: "summary", label: "Summary" },
  { tab: "log", label: "Log" },
];

// How many positions a list's "order" can take: every tab except Home.
function maxTabOrder() {
  return BUILTIN_TABS.length + visibleLists().length;
}

// The built-in tabs with each custom list slotted in at its chosen position —
// order 1 sits right after Home. A list left at the default has no number of
// its own and simply stays last, so adding another list in front of it
// doesn't shuffle it up the bar.
function orderedTabs() {
  const customs = visibleLists();
  const total = BUILTIN_TABS.length + customs.length;
  const slots = new Array(total).fill(null);
  const describe = (l) => ({
    tab: `list:${l.id}`,
    label: l.emoji || l.name,
    title: l.name,
    emoji: !!l.emoji,
  });

  // Numbered lists claim their slot; if two want the same one, the later
  // takes the next free slot along.
  customs.filter((l) => l.order).forEach((l) => {
    let at = Math.max(0, Math.min(total - 1, l.order - 1));
    while (slots[at]) at = (at + 1) % total;
    slots[at] = describe(l);
  });

  // The unnumbered ones fill the last free slots, keeping their own order.
  const unnumbered = customs.filter((l) => !l.order);
  let s = total - 1;
  for (let i = unnumbered.length - 1; i >= 0; i--) {
    while (s >= 0 && slots[s]) s--;
    if (s >= 0) slots[s--] = describe(unnumbered[i]);
  }

  let b = 0;
  for (let i = 0; i < total; i++) if (!slots[i]) slots[i] = BUILTIN_TABS[b++];
  return slots;
}

let tabsLocked = true;

function rebuildTabs() {
  const bar = $("tabbar");
  if (!bar) return;
  bar.innerHTML = "";

  const home = document.createElement("button");
  home.className = "tab-btn";
  home.dataset.tab = "home";
  const homeLabel = document.createElement("span");
  homeLabel.id = "tab-home-label";
  homeLabel.textContent = currentProfile ? currentProfile.name : "Home";
  home.appendChild(homeLabel);
  bar.appendChild(home);

  orderedTabs().forEach((t) => {
    const btn = document.createElement("button");
    btn.className = `tab-btn${t.emoji ? " tab-emoji" : ""}`;
    btn.dataset.tab = t.tab;
    btn.textContent = t.label;
    if (t.title) {
      btn.title = t.title;
      btn.setAttribute("aria-label", t.title);
    }
    btn.disabled = tabsLocked;
    bar.appendChild(btn);
  });

  bar.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // If the tab we were on has gone (a list deleted, or one that turned
  // private while someone else was looking), fall back to Home.
  const stillThere = [...bar.querySelectorAll(".tab-btn")].some((b) => b.dataset.tab === activeTab);
  if (!stillThere) switchTab("home");
  else markActiveTab();
}

function setTabsLocked(locked) {
  tabsLocked = locked;
  document.querySelectorAll("#tabbar .tab-btn[data-tab]").forEach((btn) => {
    if (btn.dataset.tab === "home") return;
    btn.disabled = locked;
  });
}

function markActiveTab() {
  document.querySelectorAll("#tabbar .tab-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === activeTab));
  const paneId = activeTab.startsWith("list:") ? "pane-list" : `pane-${activeTab}`;
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === paneId));
}

// The list whose tab is open, if any.
function activeListId() {
  return activeTab.startsWith("list:") ? activeTab.slice(5) : null;
}

function switchTab(tab) {
  const changedList = tab !== activeTab && tab.startsWith("list:");
  activeTab = tab;
  markActiveTab();
  if (changedList) {
    const l = listById(activeListId());
    if (l) {
      populateListPaneFilter();
      const want = l.defaultFilter || "anyone";
      $("filter-list").value = [...$("filter-list").options].some((o) => o.value === want)
        ? want : "anyone";
      $("sort-list").value = l.defaultSort || "dueDate";
    }
  }
  const noAdd = tab === "home" || tab === "log" || tab === "summary";
  $("btn-add-task").classList.toggle("hidden", !currentProfile || noAdd);
  if (activeListId()) renderCustomList();
  // A new tab always starts at the top, however far down the last one was.
  window.scrollTo(0, 0);
  centreActiveTab();
}

// The tab bar scrolls sideways on a narrow screen, so keep whichever tab
// you're on in view instead of off the edge.
function centreActiveTab() {
  const bar = document.querySelector(".tabbar");
  const btn = bar && bar.querySelector(".tab-btn.active");
  if (!bar || !btn) return;
  if (bar.scrollWidth <= bar.clientWidth) return;
  const target = btn.offsetLeft - (bar.clientWidth - btn.offsetWidth) / 2;
  bar.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
}


// ---------- selects ----------
function populateListSelect() {
  const sel = $("input-task-list");
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = '<option value="">Main lists</option>';
  visibleLists().forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.emoji ? `${l.emoji} ${l.name}` : l.name;
    sel.appendChild(opt);
  });
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  // No point showing the picker at all until there's somewhere else to put it.
  $("wrap-task-list").classList.toggle("hidden", visibleLists().length === 0);
}

function populateOwnerSelect() {
  const sel = $("input-task-owner");
  const keep = sel.value;
  sel.innerHTML = '<option value="">No owner</option>';
  sortedProfileIds.forEach((id) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = profilesCache[id].name;
    sel.appendChild(opt);
  });
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

// Two separate settings, because they answer different questions. The
// assignment filter (To-do tab and the Home checklist) is about who a task
// is *on* right now; the Done one is about who actually did it. Carrying a
// choice between those would answer the wrong question — but the two views
// that share a question do share the setting.
let assignFilter = "mine";
let doneFilter = "mine";

function fillPersonOptions(sel, kind) {
  sel.innerHTML = "";
  const labels = kind === "done"
    ? [["mine", "Done by me"], ["anyone", "Done by anyone"]]
    : [["mine", "Mine"], ["anyone", "Anyone"]];
  labels.forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  });
  sortedProfileIds.forEach((id) => {
    if (currentProfile && id === currentProfile.id) return;
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = profilesCache[id].name;
    sel.appendChild(opt);
  });
  // Unclaimed work still needs somewhere to show up.
  const unassigned = document.createElement("option");
  unassigned.value = "unassigned";
  unassigned.textContent = kind === "done" ? "Skipped / nobody" : "Unassigned";
  sel.appendChild(unassigned);
}

function populateFilterSelect(sel, kind) {
  const current = kind === "done" ? doneFilter : assignFilter;
  fillPersonOptions(sel, kind);
  if (![...sel.options].some((o) => o.value === current)) {
    if (kind === "done") doneFilter = "mine"; else assignFilter = "mine";
  }
  sel.value = kind === "done" ? doneFilter : assignFilter;
}

// A custom list keeps its own filter, seeded from the list's own default,
// rather than sharing the one To-do uses.
function populateListPaneFilter() {
  const sel = $("filter-list");
  const keep = sel.value;
  fillPersonOptions(sel, "due");
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function populatePersonFilters() {
  populateFilterSelect($("filter-due"), "due");
  populateFilterSelect($("filter-checklist"), "due");
  populateFilterSelect($("filter-done"), "done");
  populateListPaneFilter();
}

function onAssignFilterChange(e) {
  assignFilter = e.target.value;
  [$("filter-due"), $("filter-checklist")].forEach((sel) => {
    if ([...sel.options].some((o) => o.value === assignFilter)) sel.value = assignFilter;
  });
  renderDue();
  renderChecklist();
}

function onDoneFilterChange(e) {
  doneFilter = e.target.value;
  renderDoneList();
}

function buildDoneBySelect(currentId) {
  const sel = document.createElement("select");
  sel.className = "done-by-select";
  sortedProfileIds.forEach((id) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = profilesCache[id].name;
    if (id === currentId) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

function buildAssignButton(task) {
  const btn = document.createElement("button");
  btn.className = "text-btn";
  btn.textContent = "Reassign";
  btn.onclick = () => openAssignModal(task, "assign");
  return btn;
}

function buildOwnerButton(task) {
  const btn = document.createElement("button");
  btn.className = "text-btn";
  btn.textContent = task.owner && profilesCache[task.owner]
    ? profilesCache[task.owner].name
    : "Set owner";
  btn.onclick = () => openAssignModal(task, "owner");
  return btn;
}

let assignModalTaskId = null;
let assignModalMode = "assign"; // "assign" = this occurrence, "owner" = the base task

function openAssignModal(task, mode = "assign") {
  assignModalTaskId = task.id;
  assignModalMode = mode;
  const isOwner = mode === "owner";
  const selectedId = isOwner ? task.owner : task.assignedTo;
  $("assign-modal-title").textContent = isOwner ? "Whose task is this?" : "Who's doing this one?";

  const wrap = $("assign-options");
  wrap.innerHTML = "";

  const noneBtn = document.createElement("button");
  noneBtn.className = `profile-pick${!selectedId ? " current" : ""}`;
  noneBtn.appendChild(buildAvatar(null, { small: true }));
  noneBtn.appendChild(document.createTextNode(isOwner ? "No owner" : "Unassigned"));
  noneBtn.onclick = () => commitAssign(null);
  wrap.appendChild(noneBtn);

  sortedProfileIds.forEach((id) => {
    const b = document.createElement("button");
    b.className = `profile-pick${selectedId === id ? " current" : ""}`;
    b.appendChild(buildAvatar(id, { small: true }));
    b.appendChild(document.createTextNode(profilesCache[id].name));
    b.onclick = () => commitAssign(id);
    wrap.appendChild(b);
  });

  setModalOpen("assign-modal-backdrop", true);
}

function commitAssign(idOrNull) {
  if (!assignModalTaskId) return;
  const task = tasksById[assignModalTaskId];
  if (assignModalMode === "owner") {
    // Changing the owner moves the occurrence that's currently open too,
    // unless somebody has deliberately taken it off the owner already.
    const patch = { owner: idOrNull };
    if (task && (!task.assignedTo || task.assignedTo === task.owner)) patch.assignedTo = idOrNull;
    updateDoc(taskDoc(assignModalTaskId), patch);
  } else {
    updateDoc(taskDoc(assignModalTaskId), { assignedTo: idOrNull });
  }
  closeAssignModal();
}

function closeAssignModal() {
  setModalOpen("assign-modal-backdrop", false);
  assignModalTaskId = null;
}

on("btn-cancel-assign", "click", closeAssignModal);

// Priority cycles through four steps on tap: grey outline, thick yellow
// outline, filled yellow, then an exclamation (which also puts a red
// outline round the card). Every step is drawn at the same 18px box so
// nothing around it shifts as you tap through.
const PRIORITY_LABELS = ["Normal priority", "High priority", "Higher priority", "Highest priority"];
const PRIORITY_STEPS = PRIORITY_LABELS.length;
const STAR_PATH = "M12 2.6l2.95 5.98 6.6.96-4.77 4.65 1.12 6.57L12 17.66l-5.9 3.1 1.13-6.57L2.46 9.54l6.6-.96L12 2.6z";

function priorityIconSvg(p) {
  const open = (sw, colour) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="${colour}" stroke-width="${sw}" stroke-linejoin="round"><path d="${STAR_PATH}"/></svg>`;
  switch (p) {
    case 1: return open(2.6, "#D9A520");
    case 2: return `<svg viewBox="0 0 24 24" width="18" height="18" fill="#D9A520" stroke="#D9A520" stroke-width="1.4" stroke-linejoin="round"><path d="${STAR_PATH}"/></svg>`;
    case 3: return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#B3362F" stroke-width="2.9" stroke-linecap="round"><path d="M12 3.6v10.2"/><path d="M12 19.4v.1"/></svg>`;
    default: return open(1.7, "#9AA6B4");
  }
}

function buildStarButton(task) {
  const p = task.priority || 0;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `star-btn p${p}`;
  btn.innerHTML = priorityIconSvg(p);
  btn.title = `${PRIORITY_LABELS[p]} — tap to change`;
  btn.setAttribute("aria-label", PRIORITY_LABELS[p]);
  btn.onclick = (e) => {
    e.stopPropagation();
    updateDoc(taskDoc(task.id), { priority: (p + 1) % PRIORITY_STEPS });
  };
  return btn;
}

// With "take turns" on, a repeat goes to whoever is next in the household
// list after the person who last did it, wrapping back round to the start.
function nextTurnProfile(basisId) {
  if (!sortedProfileIds.length) return null;
  const i = basisId ? sortedProfileIds.indexOf(basisId) : -1;
  if (i === -1) return sortedProfileIds[0];
  return sortedProfileIds[(i + 1) % sortedProfileIds.length];
}

// ---------- tasks / log subscriptions ----------
function subscribeTasks() {
  if (unsubTasks) unsubTasks();
  unsubTasks = onSnapshot(tasksCol(), (snap) => {
    tasksById = {};
    snap.forEach((d) => { tasksById[d.id] = normaliseTask(d.id, d.data()); });
    renderAll();
  }, () => showToast("Having trouble syncing right now."));
}

// Tasks written by older versions of the app don't have owner / priority /
// takeTurns / categoryId. Filling the gaps on the way in means the rest of
// the app can read them plainly, and the old boolean star becomes "high".
const DUE_MODES = ["whenever", "by", "on"];

function normaliseTask(id, raw) {
  const takeTurns = !!raw.takeTurns;
  // Tasks written before due modes existed all carried a date and stayed
  // visible once they'd appeared, so they read as "due by" — picking "due
  // on" would hide most of a list overnight.
  const dueMode = DUE_MODES.includes(raw.dueMode)
    ? raw.dueMode
    : (raw.dueAt ? "by" : "whenever");
  return {
    id,
    ...raw,
    dueMode,
    dueAt: raw.dueAt || null,
    priority: typeof raw.priority === "number" ? raw.priority : (raw.starred ? 1 : 0),
    // Taking turns and having an owner are mutually exclusive. Tasks saved
    // before that was true could carry both, so the owner is dropped here
    // rather than leaving them looking owned forever.
    owner: takeTurns ? null : (raw.owner ?? null),
    assignedTo: raw.assignedTo ?? null,
    takeTurns,
    estimateMins: typeof raw.estimateMins === "number" ? raw.estimateMins : null,
    // Categories are tags now — a task written before that had a single one.
    categoryIds: Array.isArray(raw.categoryIds)
      ? raw.categoryIds
      : (raw.categoryId ? [raw.categoryId] : []),
    listId: raw.listId || null,
  };
}

function subscribeLog() {
  if (unsubLog) unsubLog();
  const q = query(logCol(), orderBy("doneAt", "desc"));
  unsubLog = onSnapshot(q, (snap) => {
    logRows = [];
    // The id rides along so entries can be removed with their list.
    snap.forEach((d) => logRows.push({ __id: d.id, ...d.data() }));
    renderLogList(logRows);
    renderSummary();
  });
}

// Nothing here writes to Firestore any more — a task's appear/overdue state
// is computed live from its stored dueAt, not flipped by a timer. This just
// keeps the To-do tab's "pending" / "upcoming" / "overdue" split current as
// the clock moves (e.g. a task crossing into "overdue" at midnight) without
// needing a page reload.
function startRollover() {
  if (rolloverTimer) clearInterval(rolloverTimer);
  rolloverTimer = setInterval(renderAll, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") renderAll();
  });
}

function renderAll() {
  if (!currentProfile) return;
  // The Log is driven by its own snapshot, which doesn't re-fire when the
  // active profile changes — so it has to be redrawn here too, or switching
  // person leaves the previous one's entries on screen.
  renderLogList(logRows);
  renderCustomList();
  renderChecklist();
  renderDue();
  renderDoneList();
  renderAllTasks();
  renderSummary();
}

// matches an assignment-style filter (To-do tab): "mine" counts unassigned too
// "Mine" means the ones actually on me — nobody else's, and not the ones
// sitting there unclaimed. Those have their own option so they're still easy
// to find.
function matchesAssignFilter(value, assignedTo) {
  if (value === "anyone") return true;
  if (value === "unassigned") return !assignedTo;
  if (value === "mine") return assignedTo === currentProfile.id;
  return assignedTo === value;
}

// matches a "done by" filter (Done tab)
function matchesDoneFilter(value, doneBy) {
  if (value === "anyone") return true;
  if (value === "unassigned") return !doneBy;   // skipped, or nobody recorded
  if (value === "mine") return doneBy === currentProfile.id;
  return doneBy === value;
}

// Whether a task has an occurrence open right now.
// A one-off that's already been done or skipped has no "next occurrence" —
// it only lives on in the Done tab from here. And "pending" (not yet
// appeared) only hides a task once it's already finished a prior cycle and
// is waiting for the next one to open up: a task that has never been
// completed always shows, however far off its due date is, so you can see
// and plan for it ahead of time.
function isOpenNow(task, now) {
  if (task.freq.type === "once" && task.lastCompletion) return false;
  return taskStatus(task, now) !== "pending";
}

function renderDue() {
  const now = new Date();
  const sortVal = $("sort-due").value;

  let list_ = Object.values(tasksById).filter((t) => isOpenNow(t, now));
  list_ = list_.filter((t) => matchesAssignFilter(assignFilter, t.assignedTo)
    && matchesCategoryFilter(t) && passesListRules(t));

  if (sortVal === "alpha") {
    list_.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sortVal === "priority") {
    list_.sort((a, b) => {
      if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
      return dueSortValue(a) - dueSortValue(b);
    });
  } else {
    list_.sort((a, b) => dueSortValue(a) - dueSortValue(b));
  }

  copyBuffers.due = list_;
  const list = $("list-due");
  list.innerHTML = "";
  $("due-empty").classList.toggle("hidden", list_.length > 0);
  list_.forEach((t) => list.appendChild(renderOpenRow(t, now)));
}

// A custom list's own tab: the open tasks on that list, nothing else.
function renderCustomList() {
  const id = activeListId();
  const list = listById(id);
  if (!id || !list || !currentProfile) return;

  $("list-pane-title").textContent = list.emoji ? `${list.emoji} ${list.name}` : list.name;

  const notes = [];
  if (list.private) {
    notes.push("Private to you — nobody else in the household sees this list or its tasks.");
  } else if (list.owner && profilesCache[list.owner]) {
    notes.push(`Shared · ${profilesCache[list.owner].name}'s list.`);
  }
  if (list.includeInSummaries === false) {
    notes.push("Kept out of the Home checklist, the Log and the Summary.");
  }
  const note = $("list-pane-note");
  note.textContent = notes.join(" ");
  note.classList.toggle("hidden", notes.length === 0);

  const now = new Date();
  const filterVal = $("filter-list").value;
  const sortVal = $("sort-list").value;
  let rows = Object.values(tasksById)
    .filter((t) => t.listId === id && isOpenNow(t, now))
    .filter((t) => matchesAssignFilter(filterVal, t.assignedTo) && matchesCategoryFilter(t));

  if (sortVal === "alpha") rows.sort((a, b) => a.title.localeCompare(b.title));
  else if (sortVal === "priority") {
    rows.sort((a, b) => (b.priority || 0) - (a.priority || 0) || dueSortValue(a) - dueSortValue(b));
  } else rows.sort((a, b) => dueSortValue(a) - dueSortValue(b));

  copyBuffers.custom = rows;
  const ul = $("list-custom");
  ul.innerHTML = "";
  $("list-empty").classList.toggle("hidden", rows.length > 0);
  rows.forEach((t) => ul.appendChild(renderOpenRow(t, now)));
}

on("filter-list", "change", renderCustomList);
on("sort-list", "change", renderCustomList);

function renderDoneList() {
  const sortVal = $("sort-done").value;
  let done = Object.values(tasksById).filter((t) => !!t.lastCompletion);
  done = done.filter((t) =>
    matchesDoneFilter(doneFilter, t.lastCompletion.skipped ? null : t.lastCompletion.by)
    && matchesCategoryFilter(t) && passesListRules(t));

  const doneAtMs = (t) => t.lastCompletion.at?.toDate?.()?.getTime() ?? 0;
  if (sortVal === "alpha") done.sort((a, b) => a.title.localeCompare(b.title));
  else if (sortVal === "oldest") done.sort((a, b) => doneAtMs(a) - doneAtMs(b));
  else done.sort((a, b) => doneAtMs(b) - doneAtMs(a));

  copyBuffers.done = done;
  const list = $("list-done");
  list.innerHTML = "";
  $("done-empty").classList.toggle("hidden", done.length > 0);
  done.forEach((t) => list.appendChild(renderDoneRow(t)));
}

on("filter-due", "change", onAssignFilterChange);
on("filter-checklist", "change", onAssignFilterChange);
on("sort-due", "change", renderDue);
on("filter-done", "change", onDoneFilterChange);
on("sort-done", "change", renderDoneList);
on("alltasks-search", "input", renderAllTasks);
on("alltasks-sort", "change", renderAllTasks);
on("summary-period", "change", renderSummary);

function renderAllTasks() {
  if (!currentProfile) return;
  const searchVal = $("alltasks-search").value.trim().toLowerCase();
  const sortVal = $("alltasks-sort").value;

  let all = Object.values(tasksById).filter((t) => matchesCategoryFilter(t) && passesListRules(t));
  if (searchVal) all = all.filter((t) => t.title.toLowerCase().includes(searchVal));

  const createdMs = (t) => t.createdAt?.toDate?.()?.getTime() ?? 0;
  if (sortVal === "alpha") {
    all.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sortVal === "priority") {
    all.sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.title.localeCompare(b.title));
  } else if (sortVal === "freq-most") {
    all.sort((a, b) => freqIntervalDays(a.freq) - freqIntervalDays(b.freq) || a.title.localeCompare(b.title));
  } else if (sortVal === "freq-least") {
    all.sort((a, b) => freqIntervalDays(b.freq) - freqIntervalDays(a.freq) || a.title.localeCompare(b.title));
  } else if (sortVal === "created-new") {
    all.sort((a, b) => createdMs(b) - createdMs(a));
  } else if (sortVal === "created-old") {
    all.sort((a, b) => createdMs(a) - createdMs(b));
  } else {
    all.sort((a, b) => dueSortValue(a) - dueSortValue(b));
  }

  copyBuffers.alltasks = all;
  const list = $("list-alltasks");
  list.innerHTML = "";
  $("alltasks-empty").classList.toggle("hidden", all.length > 0);
  const now = new Date();
  all.forEach((t) => list.appendChild(renderAllTasksRow(t, now)));
}

// Every tag a task carries, as little labels.
function appendCategoryChips(parent, task) {
  (task.categoryIds || []).forEach((id) => {
    const name = categoryName(id);
    if (!name) return;
    const chip = document.createElement("span");
    chip.className = "cat-chip";
    chip.textContent = name;
    parent.appendChild(chip);
  });
}

// The right-hand side of a base card: where its current occurrence stands.
// If one is open you get the due date, the colour of whoever it's on, and
// two small actions — tick it off, or hand it to someone else. If none is
// open (a finished one-off, or a repeat waiting on its next turn) it greys
// out and reports who did it last instead.
function buildInstancePanel(task, now) {
  const wrap = document.createElement("div");
  wrap.className = "base-instance";
  const lc = task.lastCompletion;

  if (isOpenNow(task, now)) {
    const status = taskStatus(task, now);
    wrap.classList.add("live");
    if (status === "overdue") wrap.classList.add(isSoftOverdue(task) ? "overdue-soft" : "overdue");
    wrap.style.setProperty("--inst", task.assignedTo && profilesCache[task.assignedTo]
      ? colorForProfile(task.assignedTo)
      : "var(--grey-done)");

    const when = document.createElement("span");
    when.className = "inst-when";
    when.textContent = dueText(task, status);
    wrap.appendChild(when);

    const actions = document.createElement("div");
    actions.className = "inst-actions";
    actions.appendChild(buildAvatar(task.assignedTo, { small: true }));

    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "inst-btn inst-done";
    doneBtn.innerHTML = checkIconSvg();
    doneBtn.title = "Mark done";
    doneBtn.setAttribute("aria-label", `Mark ${task.title} done`);
    doneBtn.onclick = () => openDoneModal(task);
    actions.appendChild(doneBtn);

    const assignBtn = document.createElement("button");
    assignBtn.type = "button";
    assignBtn.className = "inst-btn inst-assign";
    assignBtn.innerHTML = personIconSvg();
    assignBtn.title = "Give this one to someone";
    assignBtn.setAttribute("aria-label", `Assign ${task.title}`);
    assignBtn.onclick = () => openAssignModal(task, "assign");
    actions.appendChild(assignBtn);

    wrap.appendChild(actions);
  } else {
    wrap.classList.add("dormant");

    // Never been done, just not its turn yet — a "due on" task before its
    // day. Saying "last done —" there would read as though it were overdue.
    if (!lc) {
      const soon = document.createElement("span");
      soon.className = "inst-when";
      soon.textContent = "Not yet";
      wrap.appendChild(soon);
      const when = document.createElement("span");
      when.className = "inst-who";
      when.textContent = dueText(task, "upcoming");
      wrap.appendChild(when);
      return wrap;
    }

    const label = document.createElement("span");
    label.className = "inst-when";
    label.textContent = lc.skipped ? "Skipped" : "Last done";
    wrap.appendChild(label);

    const who = document.createElement("div");
    who.className = "inst-actions";
    if (lc && !lc.skipped) who.appendChild(buildAvatar(lc.by, { small: true }));
    const name = document.createElement("span");
    name.className = "inst-who";
    name.textContent = lc
      ? [lc.skipped ? null : (profilesCache[lc.by]?.name || "Someone"),
         lc.at ? fmtRelative(lc.at.toDate()) : null].filter(Boolean).join(" · ")
      : "—";
    who.appendChild(name);
    wrap.appendChild(who);

    const back = nextAppearanceText(task);
    if (back) {
      const next = document.createElement("span");
      next.className = "inst-next";
      next.textContent = back;
      wrap.appendChild(next);
    }
  }
  return wrap;
}

// The base task itself — not an occurrence of it. Deliberately a different
// shape from the To-do / Done rows: it carries the owner (whose task this is
// by default) rather than a per-occurrence assignment, and it's tinted in
// the owner's colour so you can see at a glance whose things these are.
function renderAllTasksRow(task, now) {
  const li = document.createElement("li");
  li.className = "task-row base-card";
  const urgent = task.priority === 3;
  if (urgent) li.classList.add("prio-urgent");
  if (task.owner && profilesCache[task.owner]) {
    li.style.background = tintForProfile(task.owner, 0.1);
    // At highest priority the red outline wins — an inline border colour
    // here would quietly beat the stylesheet rule that draws it.
    if (!urgent) li.style.borderColor = tintForProfile(task.owner, 0.45);
  }

  const main = document.createElement("div");
  main.className = "task-main";

  const kicker = document.createElement("div");
  kicker.className = "base-kicker";
  kicker.textContent = task.estimateMins
    ? `${freqSummary(task.freq)} · ${fmtMins(task.estimateMins)}`
    : freqSummary(task.freq);
  appendCategoryChips(kicker, task);
  if (task.takeTurns && task.freq.type !== "once") {
    const turns = document.createElement("span");
    turns.className = "turns-chip";
    turns.textContent = "Takes turns";
    kicker.appendChild(turns);
  }

  const titleRow = document.createElement("div");
  titleRow.className = "title-row";
  titleRow.appendChild(buildStarButton(task));
  const title = document.createElement("span");
  title.className = "task-title base-title";
  title.textContent = task.title;
  titleRow.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "task-meta";

  const ownerLabel = document.createElement("span");
  ownerLabel.className = "owner-label";
  ownerLabel.textContent = "Owner";
  meta.appendChild(ownerLabel);
  meta.appendChild(buildAvatar(task.owner, { small: true }));
  meta.appendChild(buildOwnerButton(task));

  const editBtn = document.createElement("button");
  editBtn.className = "text-btn";
  editBtn.textContent = "Edit";
  editBtn.onclick = () => openEditTaskModal(task);
  meta.appendChild(editBtn);

  main.appendChild(kicker);
  main.appendChild(titleRow);
  main.appendChild(meta);

  li.appendChild(main);
  li.appendChild(buildInstancePanel(task, now));
  return li;
}

// ---------- copying a list out ----------
// Whatever each list is showing right now, so "Copy list" hands over exactly
// what's on screen — same filters, same sort, same order.
const copyBuffers = { due: [], done: [], alltasks: [], custom: [], open: [], recent: [] };

async function copyText(text, okMsg = "Copied to clipboard") {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // http / older browsers: the old textarea trick still works.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    showToast(okMsg);
  } catch (e) {
    showToast("Couldn't copy — try selecting the text manually.");
  }
}

function personPhrase(kind) {
  const v = kind === "done" ? doneFilter : assignFilter;
  if (v === "anyone") return kind === "done" ? "Done by anyone" : "Everyone's tasks";
  if (v === "unassigned") return kind === "done" ? "Skipped" : "Unassigned tasks";
  if (v === "mine") return kind === "done" ? "Done by me" : "My tasks";
  const name = profilesCache[v]?.name || "Someone";
  return kind === "done" ? `Done by ${name}` : `${name}'s tasks`;
}

function categoryPhrase() {
  if (categoryFilter.size === 0) return "";
  const names = [...categoryFilter].map((id) =>
    id === "none" ? "no category" : (categoryName(id) || "?"));
  return ` in ${names.join(", ")}`;
}

// Titles only — the point is a list you can paste into a message, not a
// dump of due dates and assignments.
function buildListText(which) {
  let header = "";
  let lines = [];
  if (which === "due") {
    header = personPhrase("due") + categoryPhrase();
    lines = copyBuffers.due.map((t) => `- ${t.title}`);
  } else if (which === "done") {
    header = personPhrase("done") + categoryPhrase();
    lines = copyBuffers.done.map((t) => `✓ ${t.title}`);
  } else if (which === "alltasks") {
    const search = $("alltasks-search").value.trim();
    header = `All tasks${categoryPhrase()}${search ? ` matching "${search}"` : ""}`;
    lines = copyBuffers.alltasks.map((t) => `- ${t.title}`);
  } else if (which === "custom") {
    const list = listById(activeListId());
    header = (list ? list.name : "List") + categoryPhrase();
    lines = copyBuffers.custom.map((t) => `- ${t.title}`);
  } else {
    header = personPhrase("due") + categoryPhrase();
    lines = copyBuffers.open.map((t) => `- ${t.title}`)
      .concat(copyBuffers.recent.map((t) => `✓ ${t.title}`));
  }
  if (!lines.length) lines = ["(nothing on this list)"];
  return `${header}\n${lines.join("\n")}`;
}

on("copy-due", "click", () => copyText(buildListText("due")));
on("copy-done", "click", () => copyText(buildListText("done")));
on("copy-alltasks", "click", () => copyText(buildListText("alltasks")));
on("copy-checklist", "click", () => copyText(buildListText("checklist")));
on("copy-list", "click", () => copyText(buildListText("custom")));

// ---------- Home: at-a-glance checklist ----------
// Everything currently open, as a tickable list, with whatever was finished
// in the last day shown already ticked off underneath. Ticking marks it done
// as whoever's active; unticking puts it back.
const RECENTLY_DONE_MS = 24 * 60 * 60 * 1000;

function renderChecklist() {
  const list = $("home-checklist");
  if (!list || !currentProfile) return;
  const now = new Date();

  const open = Object.values(tasksById)
    .filter((t) => isOpenNow(t, now))
    .filter((t) => matchesAssignFilter(assignFilter, t.assignedTo) && matchesCategoryFilter(t)
      && taskCountsInSummaries(t) && matchesListFilter(t))
    .sort((a, b) => dueSortValue(a) - dueSortValue(b));

  // The ticked-off half matches on who actually did it — that's whose tick
  // it is — rather than on who the next one is assigned to.
  const recent = Object.values(tasksById)
    .filter((t) => {
      const at = t.lastCompletion?.at?.toDate?.();
      return at && now - at <= RECENTLY_DONE_MS;
    })
    .filter((t) =>
      matchesDoneFilter(assignFilter, t.lastCompletion.skipped ? null : t.lastCompletion.by)
      && matchesCategoryFilter(t) && taskCountsInSummaries(t) && matchesListFilter(t))
    .sort((a, b) => b.lastCompletion.at.toDate() - a.lastCompletion.at.toDate());

  copyBuffers.open = open;
  copyBuffers.recent = recent;
  list.innerHTML = "";
  $("checklist-empty").classList.toggle("hidden", open.length + recent.length > 0);

  open.forEach((t) => list.appendChild(buildCheckRow(t, now)));

  if (recent.length) {
    const head = document.createElement("li");
    head.className = "check-divider";
    head.textContent = `Done in the last day (${recent.length})`;
    list.appendChild(head);
    recent.forEach((t) => list.appendChild(buildCheckRow(t, now, true)));
  }
}

function buildCheckRow(task, now, done = false) {
  const li = document.createElement("li");
  li.className = `check-row${done ? " checked" : ""}`;
  const status = done ? null : taskStatus(task, now);
  if (status === "overdue") li.classList.add(isSoftOverdue(task) ? "overdue-soft" : "overdue");
  if (!done && task.priority === 3) li.classList.add("prio-urgent");

  const box = document.createElement("button");
  box.type = "button";
  box.className = "check-box";
  box.setAttribute("role", "checkbox");
  box.setAttribute("aria-checked", done ? "true" : "false");
  box.setAttribute("aria-label", done ? `Undo ${task.title}` : `Mark ${task.title} done`);
  if (done) {
    const lc = task.lastCompletion;
    box.textContent = lc.skipped ? "–" : "✓";
    if (lc.skipped) box.classList.add("skipped");
    else if (lc.by && profilesCache[lc.by]) box.style.background = colorForProfile(lc.by);
    box.onclick = () => undoCompletion(task);
  } else {
    box.onclick = () => completeTask(task, currentProfile.id, false);
  }
  li.appendChild(box);

  const main = document.createElement("div");
  main.className = "check-main";

  const titleRow = document.createElement("div");
  titleRow.className = "check-title-row";
  const title = document.createElement("span");
  title.className = "check-title";
  title.textContent = task.title;
  titleRow.appendChild(title);
  appendCategoryChips(titleRow, task);
  main.appendChild(titleRow);

  const meta = document.createElement("span");
  meta.className = "check-meta";
  if (done) {
    const lc = task.lastCompletion;
    const who = lc.skipped
      ? "Skipped"
      : (profilesCache[lc.by]?.name || "Someone");
    meta.textContent = `${who} · ${fmtRelative(lc.at.toDate())}`;
  } else {
    const whose = task.assignedTo && profilesCache[task.assignedTo]
      ? profilesCache[task.assignedTo].name
      : "Unassigned";
    meta.textContent = `${whose} · ${dueText(task, status)}`;
  }
  main.appendChild(meta);
  li.appendChild(main);

  if (!done && task.priority) {
    const star = document.createElement("span");
    star.className = `check-star p${task.priority}`;
    star.innerHTML = priorityIconSvg(task.priority);
    star.title = PRIORITY_LABELS[task.priority];
    li.appendChild(star);
  }

  return li;
}

// ---------- summary ----------
// The start of the window the Summary tab is reporting on. "This week"
// starts Monday; "this month" starts on the 1st; the numeric options are
// rolling windows counted back from now.
function summaryPeriodStart(value) {
  const now = new Date();
  if (value === "all") return null;
  if (value === "week") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    return addDays(d, -dow);
  }
  if (value === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  const days = parseInt(value, 10) || 7;
  return addDays(now, -days);
}

function summaryPeriodLabel(value) {
  switch (value) {
    case "week": return "this week";
    case "month": return "this month";
    case "all": return "all time";
    default: return `the last ${value} days`;
  }
}

function renderSummary() {
  const body = $("summary-body");
  if (!body || !currentProfile) return;
  const period = $("summary-period").value;
  const start = summaryPeriodStart(period);
  const label = summaryPeriodLabel(period);

  // Older log entries predate the category field (and predate it being a
  // list), so fall back to whatever tags the task carries now.
  const rowCategories = (r) => {
    if (Array.isArray(r.categoryIds)) return r.categoryIds;
    if (r.categoryId) return [r.categoryId];
    return tasksById[r.taskId]?.categoryIds || [];
  };
  const rows = logRows.filter((r) => {
    const at = r.doneAt?.toDate?.();
    if (start && (!at || at < start)) return false;
    if (!logRowAllowed(r) || !logRowMatchesFilter(r)) return false;
    return matchesCategoryFilter({ categoryIds: rowCategories(r) });
  });

  // How long a completion counts for: what was actually entered, else what
  // the task is estimated at, else a flat default so nothing reads as zero.
  const minsFor = (r) => {
    if (typeof r.mins === "number" && r.mins >= 0) return r.mins;
    if (typeof r.estimateMins === "number" && r.estimateMins > 0) return r.estimateMins;
    const t = tasksById[r.taskId];
    if (t && typeof t.estimateMins === "number" && t.estimateMins > 0) return t.estimateMins;
    return DEFAULT_TASK_MINS;
  };

  // Per person: what they did in the window, plus what's on them right now.
  const byPerson = {};
  const ensure = (id) => (byPerson[id] = byPerson[id] || { done: 0, mins: 0, titles: {}, open: 0 });
  sortedProfileIds.forEach(ensure);
  let skipped = 0;
  let totalMins = 0;
  rows.forEach((r) => {
    if (r.skipped) { skipped += 1; return; }
    if (!r.doneBy || !profilesCache[r.doneBy]) return;
    const rec = ensure(r.doneBy);
    const m = minsFor(r);
    rec.done += 1;
    rec.mins += m;
    totalMins += m;
    rec.titles[r.taskTitle] = (rec.titles[r.taskTitle] || 0) + 1;
  });

  const now = new Date();
  Object.values(tasksById).forEach((t) => {
    if (!matchesCategoryFilter(t) || !taskCountsInSummaries(t) || !matchesListFilter(t)) return;
    if (t.freq.type === "once" && t.lastCompletion) return;
    if (t.lastCompletion && taskStatus(t, now) === "pending") return;
    if (t.assignedTo && profilesCache[t.assignedTo]) ensure(t.assignedTo).open += 1;
  });

  const totalDone = rows.filter((r) => !r.skipped).length;
  body.innerHTML = "";
  $("summary-empty").classList.toggle("hidden", totalDone > 0 || skipped > 0);

  const head = document.createElement("p");
  head.className = "summary-total";
  head.textContent = `${totalDone} task${totalDone === 1 ? "" : "s"} done ${label}`
    + ` · ${fmtMins(totalMins)} of work`
    + (skipped ? ` · ${skipped} skipped` : "");
  body.appendChild(head);

  // Ranked by time put in, since that's the "who did what" this answers.
  const ranked = sortedProfileIds.slice().sort((a, b) =>
    (byPerson[b]?.mins || 0) - (byPerson[a]?.mins || 0)
    || (byPerson[b]?.done || 0) - (byPerson[a]?.done || 0)
    || (profilesCache[a].name || "").localeCompare(profilesCache[b].name || ""));

  ranked.forEach((id) => {
    const rec = byPerson[id] || { done: 0, mins: 0, titles: {}, open: 0 };
    const card = document.createElement("div");
    card.className = "summary-card";
    card.style.borderLeftColor = colorForProfile(id);

    const top = document.createElement("div");
    top.className = "summary-card-head";
    top.appendChild(buildAvatar(id, { small: true }));
    const name = document.createElement("span");
    name.className = "summary-name";
    name.textContent = profilesCache[id].name;
    top.appendChild(name);
    const share = totalMins ? Math.round((rec.mins / totalMins) * 100) : 0;
    const count = document.createElement("span");
    count.className = "summary-count";
    count.textContent = totalMins
      ? `${rec.done} done · ${fmtMins(rec.mins)} · ${share}%`
      : `${rec.done} done`;
    top.appendChild(count);
    card.appendChild(top);

    const openNote = document.createElement("p");
    openNote.className = "summary-open";
    openNote.textContent = `${rec.open} on their list right now`;
    card.appendChild(openNote);

    // A bar makes the split between people readable at a glance.
    const bar = document.createElement("div");
    bar.className = "summary-bar";
    const fill = document.createElement("div");
    fill.className = "summary-bar-fill";
    fill.style.width = `${share}%`;
    fill.style.background = colorForProfile(id);
    bar.appendChild(fill);
    card.appendChild(bar);

    const titles = Object.entries(rec.titles).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (titles.length) {
      const ul = document.createElement("ul");
      ul.className = "summary-task-list";
      titles.forEach(([title, n]) => {
        const li = document.createElement("li");
        li.textContent = n > 1 ? `${title} ×${n}` : title;
        ul.appendChild(li);
      });
      card.appendChild(ul);
    } else {
      const none = document.createElement("p");
      none.className = "summary-none";
      none.textContent = "Nothing done in this period.";
      card.appendChild(none);
    }

    body.appendChild(card);
  });
}

function fmtLogWhen(date) {
  let h = date.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  const mins = String(date.getMinutes()).padStart(2, "0");
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
  const month = date.toLocaleDateString(undefined, { month: "long" });
  return `${h}.${mins}${ampm}, ${weekday} ${month} ${date.getDate()}`;
}

// Whether a log entry is for this pair of eyes, decided purely from what was
// stamped on it when it was written. Deleting or changing a list afterwards
// doesn't alter anyone's log — the entry already said who it was for.
//
// Entries written before this was recorded carry no stamp, and count as
// shared, which is what they were at the time.
function logRowAllowed(r) {
  if (r.visibleTo && (!currentProfile || r.visibleTo !== currentProfile.id)) return false;
  if (r.inSummaries === false) return false;
  return true;
}

// The list filter is a live view control, so it only applies to lists that
// still exist. History from a deleted list can't be filtered by a list that
// isn't there any more, so it simply stays visible.
function logRowMatchesFilter(r) {
  if (listFilter.size === 0) return true;
  const id = r.listId || null;
  if (!id) return listFilter.has("main");
  if (!listsCache[id]) return true;
  return listFilter.has(id);
}

function renderLogList(allRows) {
  const rows = allRows.filter((r) => logRowAllowed(r) && logRowMatchesFilter(r));
  const list = $("list-log");
  list.innerHTML = "";
  $("log-empty").classList.toggle("hidden", rows.length > 0);
  rows.forEach((r) => {
    const li = document.createElement("li");
    li.className = "task-row log-row";
    const avatar = buildAvatar(r.skipped ? null : r.doneBy, { small: true });

    const main = document.createElement("div");
    main.className = "task-main";
    const text = document.createElement("div");
    text.className = "log-text";
    const when = r.doneAt ? fmtLogWhen(r.doneAt.toDate()) : "";
    text.innerHTML = r.skipped
      ? `<strong style="color:var(--danger)">Skipped</strong> ${escapeHtml(r.taskTitle)}${when ? ` at ${when}` : ""}`
      : `<strong style="color:${colorForProfile(r.doneBy)}">${escapeHtml(r.doneByName || "Someone")}</strong> completed ${escapeHtml(r.taskTitle)}${when ? ` at ${when}` : ""}`;
    main.appendChild(text);

    // The list is named from what was recorded at the time, so an entry still
    // reads properly once that list has been deleted.
    if (r.listName) {
      const from = document.createElement("span");
      from.className = "log-list";
      from.textContent = r.listName;
      main.appendChild(from);
    }

    li.appendChild(avatar);
    li.appendChild(main);
    list.appendChild(li);
  });
}

// One occurrence of a task — not the task itself. A left stripe in the
// colour of whoever it's on right now, and the actions that apply to this
// time round only.
function renderOpenRow(task, now) {
  const li = document.createElement("li");
  li.className = "task-row instance-row";
  const status = taskStatus(task, now);
  if (status === "overdue") li.classList.add(isSoftOverdue(task) ? "overdue-soft" : "overdue-row");
  if (task.priority === 3) li.classList.add("prio-urgent");
  li.style.setProperty("--stripe", task.assignedTo && profilesCache[task.assignedTo]
    ? colorForProfile(task.assignedTo)
    : "var(--grey-done)");

  const main = document.createElement("div");
  main.className = "task-main";

  const titleRow = document.createElement("div");
  titleRow.className = "title-row";
  titleRow.appendChild(buildStarButton(task));
  const title = document.createElement("span");
  title.className = "task-title";
  title.textContent = task.title;
  titleRow.appendChild(title);
  appendCategoryChips(titleRow, task);
  if (status === "overdue") {
    const badge = document.createElement("span");
    badge.className = `status-badge ${isSoftOverdue(task) ? "overdue-soft" : "overdue"}`;
    badge.textContent = "Overdue";
    titleRow.appendChild(badge);
  }

  const meta = document.createElement("div");
  meta.className = "task-meta";
  meta.appendChild(buildAvatar(task.assignedTo, { small: true }));
  meta.appendChild(buildAssignButton(task));

  const doneBtn = document.createElement("button");
  doneBtn.className = "done-btn";
  doneBtn.textContent = "Done";
  doneBtn.onclick = () => openDoneModal(task);
  meta.appendChild(doneBtn);

  if (status === "overdue") {
    const skipBtn = document.createElement("button");
    skipBtn.className = "skip-btn";
    skipBtn.textContent = "Skip";
    skipBtn.onclick = () => {
      if (confirm(`Skip "${task.title}" for this time? It'll show in Done, marked skipped.`)) {
        completeTask(task, null, true);
      }
    };
    meta.appendChild(skipBtn);
  }

  const editBtn = document.createElement("button");
  editBtn.className = "text-btn";
  editBtn.textContent = "Edit";
  editBtn.onclick = () => openEditTaskModal(task);
  meta.appendChild(editBtn);

  const freqNote = document.createElement("span");
  freqNote.className = "freq-note";
  freqNote.textContent = `${freqSummary(task.freq)} · ${dueText(task, status)}`;

  main.appendChild(titleRow);
  main.appendChild(meta);
  main.appendChild(freqNote);

  li.appendChild(main);
  return li;
}

function renderDoneRow(task) {
  const li = document.createElement("li");
  li.className = "task-row instance-row";
  const lc = task.lastCompletion;
  if (lc.skipped) li.classList.add("skipped-row");
  li.style.setProperty("--stripe", !lc.skipped && lc.by && profilesCache[lc.by]
    ? colorForProfile(lc.by)
    : "var(--grey-done)");

  const main = document.createElement("div");
  main.className = "task-main";
  const titleRow = document.createElement("div");
  titleRow.className = "title-row";
  titleRow.appendChild(buildStarButton(task));
  const title = document.createElement("span");
  title.className = "task-title";
  title.textContent = task.title;
  titleRow.appendChild(title);
  appendCategoryChips(titleRow, task);

  const meta = document.createElement("div");
  meta.className = "task-meta";

  if (lc.skipped) {
    meta.appendChild(buildAvatar(null, { small: true }));
    const label = document.createElement("span");
    label.className = "freq-note skipped-label";
    label.style.margin = "0";
    label.textContent = "Skipped";
    meta.appendChild(label);
  } else {
    meta.appendChild(buildAvatar(lc.by, { small: true }));
    const label = document.createElement("span");
    label.className = "freq-note";
    label.style.margin = "0";
    label.textContent = "Done by";
    meta.appendChild(label);
    const doneBySel = buildDoneBySelect(lc.by);
    doneBySel.onchange = (e) => updateDoc(taskDoc(task.id), { "lastCompletion.by": e.target.value });
    meta.appendChild(doneBySel);
  }

  const when = document.createElement("span");
  when.className = "freq-note";
  when.style.margin = "0";
  when.textContent = lc.at ? fmtRelative(lc.at.toDate()) : "";
  meta.appendChild(when);

  const undoBtn = document.createElement("button");
  undoBtn.className = "text-btn";
  undoBtn.textContent = "Undo";
  undoBtn.onclick = () => undoCompletion(task);
  meta.appendChild(undoBtn);

  const editBtn = document.createElement("button");
  editBtn.className = "text-btn";
  editBtn.textContent = "Edit";
  editBtn.onclick = () => openEditTaskModal(task);
  meta.appendChild(editBtn);

  main.appendChild(titleRow);
  main.appendChild(meta);

  li.appendChild(main);
  return li;
}

// Completing (or skipping) a task advances it to its next occurrence right
// away — that's what makes it drop out of the To-do tab until that next
// occurrence's appear time — while lastCompletion records what just
// happened for the Done tab, independent of that next-occurrence cycle.
async function completeTask(task, byId, skipped, mins = null) {
  const prevDueAt = task.dueAt;
  const nextDue = advanceDue(task);

  // Who the next occurrence lands on: the next person in line if this task
  // takes turns, otherwise straight back to whoever owns it.
  const basis = byId || task.assignedTo || task.owner;
  const nextAssignee = task.takeTurns && task.freq.type !== "once"
    ? nextTurnProfile(basis)
    : (task.owner ?? null);

  // Log first so the completion can point at its own log entry — that's
  // what lets an undo take the entry back out again.
  //
  // A log entry is a record of what happened at the time, so everything it
  // needs is written into it here: which list it came from and what that
  // list was called, who was allowed to see it, and whether it counted
  // towards summaries. None of that is looked up again later, so renaming,
  // re-sharing or deleting a list never rewrites history.
  const srcList = listById(task.listId);
  const logRef = await addDoc(logCol(), {
    taskId: task.id,
    taskTitle: task.title,
    categoryIds: task.categoryIds || [],
    listId: task.listId || null,
    listName: srcList ? srcList.name : null,
    visibleTo: srcList && srcList.private ? (srcList.privateTo || null) : null,
    inSummaries: srcList ? srcList.includeInSummaries !== false : true,
    doneBy: skipped ? null : byId,
    doneByName: skipped ? null : (profilesCache[byId]?.name || "Someone"),
    skipped: !!skipped,
    // What it actually took if that was entered, and what it usually takes,
    // kept here so the Summary still totals correctly if the task is
    // later edited or deleted.
    mins: typeof mins === "number" ? mins : null,
    estimateMins: task.estimateMins ?? null,
    doneAt: serverTimestamp(),
  });
  await updateDoc(taskDoc(task.id), {
    dueAt: nextDue ? Timestamp.fromDate(nextDue) : null,
    prevDueAt: prevDueAt || null,
    prevAssignedTo: task.assignedTo ?? null,
    assignedTo: nextAssignee,
    lastCompletion: {
      by: skipped ? null : byId,
      at: serverTimestamp(),
      skipped: !!skipped,
      mins: typeof mins === "number" ? mins : null,
      logId: logRef.id,
    },
  });

  let msg = skipped ? "Skipped" : "Marked done";
  if (task.takeTurns && task.freq.type !== "once" && nextAssignee && profilesCache[nextAssignee]) {
    msg += ` — next one's ${profilesCache[nextAssignee].name}`;
  }
  showToast(msg);
}

// Undo puts the occurrence back and takes its log entry with it — otherwise
// the Log and the Summary would keep crediting work that didn't happen.
async function undoCompletion(task) {
  const logId = task.lastCompletion && task.lastCompletion.logId;
  await updateDoc(taskDoc(task.id), {
    dueAt: task.prevDueAt || task.dueAt,
    assignedTo: task.prevAssignedTo ?? task.owner ?? null,
    lastCompletion: null,
  });
  if (logId) {
    try {
      await deleteDoc(logDoc(logId));
    } catch (e) {
      // Completions logged before this existed have no id to delete; the
      // task is already back, which is the part that matters.
    }
  }
}

// ---------- "mark done by" modal ----------
let doneModalTaskId = null;
let doneModalSelectedId = null;

function openDoneModal(task) {
  doneModalTaskId = task.id;
  doneModalSelectedId = currentProfile ? currentProfile.id : (sortedProfileIds[0] || null);
  renderDoneModalOptions();
  // The time field starts folded away — most of the time you just tick it off.
  $("done-mins-row").classList.add("hidden");
  $("btn-toggle-done-mins").classList.remove("open");
  $("btn-toggle-done-mins").querySelector(".plus-sign").textContent = "+";
  $("input-done-mins").value = "";
  $("done-mins-hint").textContent = task.estimateMins
    ? `Usually ${fmtMins(task.estimateMins)}. Leave it and that's what gets counted.`
    : `Left empty, this counts as ${DEFAULT_TASK_MINS} minutes.`;
  setModalOpen("done-modal-backdrop", true);
}

on("btn-toggle-done-mins", "click", () => {
  const row = $("done-mins-row");
  const nowOpen = row.classList.toggle("hidden") === false;
  $("btn-toggle-done-mins").classList.toggle("open", nowOpen);
  $("btn-toggle-done-mins").querySelector(".plus-sign").textContent = nowOpen ? "−" : "+";
  if (nowOpen) {
    const task = tasksById[doneModalTaskId];
    if (task && task.estimateMins != null && $("input-done-mins").value === "") {
      $("input-done-mins").value = task.estimateMins;
    }
    $("input-done-mins").focus();
  }
});

function renderDoneModalOptions() {
  const wrap = $("done-options");
  wrap.innerHTML = "";
  sortedProfileIds.forEach((id) => {
    const b = document.createElement("button");
    b.className = `profile-pick${id === doneModalSelectedId ? " current" : ""}`;
    b.appendChild(buildAvatar(id, { small: true }));
    b.appendChild(document.createTextNode(profilesCache[id].name));
    b.onclick = () => { doneModalSelectedId = id; renderDoneModalOptions(); };
    wrap.appendChild(b);
  });
}

on("btn-confirm-done", "click", () => {
  const task = tasksById[doneModalTaskId];
  const typed = $("done-mins-row").classList.contains("hidden")
    ? "" : $("input-done-mins").value.trim();
  const mins = typed === "" ? null : Math.max(0, parseInt(typed, 10) || 0);
  if (task && doneModalSelectedId) completeTask(task, doneModalSelectedId, false, mins);
  closeDoneModal();
});
on("btn-cancel-done", "click", () => closeDoneModal());

function closeDoneModal() {
  setModalOpen("done-modal-backdrop", false);
  doneModalTaskId = null;
}

// ---------- task modal ----------
on("btn-add-task", "click", () => openAddTaskModal());
on("btn-cancel-task", "click", () => closeTaskModal());
on("btn-save-task", "click", () => saveTask());
on("btn-delete-task", "click", () => deleteTask());
on("input-task-freq", "change", updateFreqRows);

function taskModalFreqType() {
  const dated = $("input-task-duemode").value !== "whenever";
  return dated && $("input-task-repeats").checked ? $("input-task-freq").value : "once";
}

const DUE_MODE_HINTS = {
  whenever: "No date at all — it just sits on the list until someone does it.",
  by: "Shows from the day after it was last done, right up to its date. Late is a gentle nudge.",
  on: "Only shows on the day itself — the bins don't need looking at until Wednesday.",
};

function updateFreqRows() {
  const dueMode = $("input-task-duemode").value;
  const dated = dueMode !== "whenever";
  // Dates, times and repeats only make sense once there's a date at all.
  $("dated-block").classList.toggle("hidden", !dated);
  $("duemode-hint").textContent = DUE_MODE_HINTS[dueMode] || "";
  $("label-task-date").textContent = dueMode === "by" ? "Due by" : "Due on";
  if (!dated) $("input-task-repeats").checked = false;

  const repeats = dated && $("input-task-repeats").checked;
  const type = taskModalFreqType();
  // All the repeat machinery stays out of the way until you say it repeats.
  $("repeat-block").classList.toggle("hidden", !repeats);
  $("row-interval-days").classList.toggle("hidden", type !== "custom-days");
  $("row-weekday").classList.toggle("hidden", !(type === "weekly" || type === "custom-weeks"));
  $("wrap-interval-weeks").classList.toggle("hidden", type !== "custom-weeks");
  $("row-monthday").classList.toggle("hidden", type !== "monthly");

  // "Every week on Saturday" still needs a start date, but only Saturdays are
  // valid — so that case gets a list of matching dates rather than a free
  // date field that would happily accept a Tuesday.
  const implied = freqImpliesDate(type);
  $("wrap-task-date").classList.toggle("hidden", !dated || implied);
  $("wrap-task-dateopts").classList.toggle("hidden", !dated || !implied);
  if (dated && implied) populateDateOptions(type);
  updateOwnerRow();
}

// Listens to the weekday / day-of-month / interval inputs so the date list
// re-reads whenever the thing it's derived from changes.
["input-weekday", "input-monthday", "input-interval-weeks"].forEach((id) =>
  on(id, "change", () => updateFreqRows()));

function populateDateOptions(type) {
  const sel = $("input-task-dateopts");
  const keep = sel.value;
  const freq = {
    weekday: parseInt($("input-weekday").value, 10),
    monthDay: Math.min(28, Math.max(1, parseInt($("input-monthday").value, 10) || 1)),
  };
  const dates = matchingDates(type, freq);

  // When editing something already scheduled, its own date belongs in the
  // list even if it's in the past — otherwise saving would quietly shunt an
  // overdue task forward.
  const existing = editingTaskId ? dueDateOf(tasksById[editingTaskId]) : null;
  if (existing) {
    const matches = type === "monthly"
      ? existing.getDate() === freq.monthDay
      : existing.getDay() === freq.weekday;
    if (matches && !dates.some((d) => localDateStr(d) === localDateStr(existing))) {
      dates.unshift(existing);
    }
  }

  const todayStr = localDateStr(new Date());
  sel.innerHTML = "";
  dates.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = localDateStr(d);
    opt.textContent = fmtShortDay(d) + (opt.value === todayStr ? " · today" : "");
    sel.appendChild(opt);
  });

  const wanted = [keep, existing ? localDateStr(existing) : null]
    .find((v) => v && [...sel.options].some((o) => o.value === v));
  sel.value = wanted || sel.options[0].value;

  $("label-task-dateopts").textContent =
    $("input-task-duemode").value === "by" ? "Due by" : "Due on";
  $("dateopts-hint").textContent = type === "monthly"
    ? `Only the ${freq.monthDay}${ordinal(freq.monthDay)} of the month can be picked.`
    : `Only ${WEEKDAY_NAMES[freq.weekday]}s can be picked.`;
}

// A task that takes turns belongs to whoever's next, not to an owner, so
// the owner picker goes away and anything already set is cleared.
function updateOwnerRow() {
  const turns = $("input-task-repeats").checked && $("input-task-taketurns").checked;
  $("wrap-task-owner").classList.toggle("hidden", turns);
  if (turns) $("input-task-owner").value = "";
}

on("input-task-duemode", "change", updateFreqRows);
on("input-task-repeats", "change", updateFreqRows);
on("input-task-taketurns", "change", updateOwnerRow);

function openAddTaskModal() {
  editingTaskId = null;
  $("task-modal-title").textContent = "Add task";
  $("task-modal-sub").classList.add("hidden");
  $("input-task-title").value = "";
  // No date at all is the default — you opt into scheduling, not out of it.
  $("input-task-duemode").value = "whenever";
  // Clear the date list so a leftover selection can't outrank this task's own.
  $("input-task-dateopts").innerHTML = "";
  $("input-task-repeats").checked = false;
  $("input-task-freq").value = "daily";
  $("input-interval-n").value = 2;
  $("input-interval-weeks").value = 2;
  $("input-weekday").value = String(new Date().getDay());
  $("input-monthday").value = 1;
  $("input-task-date").value = localDateStr(new Date());
  $("input-task-time").value = "";
  populateListSelect();
  const standingIn = activeListId();
  $("input-task-list").value = standingIn && listById(standingIn) ? standingIn : "";
  const landing = listById($("input-task-list").value);
  $("input-task-owner").value = landing && landing.owner && profilesCache[landing.owner]
    ? landing.owner : "";
  $("input-task-taketurns").checked = false;
  $("input-task-estimate").value = "";
  $("task-advanced").open = false;
  // If you're filtering by a category, a new task starts tagged with it.
  taskModalCategories.clear();
  categoryFilter.forEach((id) => { if (id !== "none") taskModalCategories.add(id); });
  renderTaskCategoryChips();
  $("task-modal-error").textContent = "";
  $("btn-delete-task").classList.add("hidden");
  updateFreqRows();
  setModalOpen("task-modal-backdrop", true);
}

// Editing always edits the base task, wherever you opened it from — so from
// the To-do or Done tab it says so plainly, since you tapped an occurrence.
function openEditTaskModal(task) {
  editingTaskId = task.id;
  $("task-modal-title").textContent = "Edit task";
  $("task-modal-sub").classList.toggle("hidden", activeTab === "alltasks");
  $("input-task-title").value = task.title;
  $("input-task-duemode").value = task.dueMode || "whenever";
  $("input-task-dateopts").innerHTML = "";
  const repeats = task.freq.type !== "once";
  $("input-task-repeats").checked = repeats;
  $("input-task-freq").value = repeats ? task.freq.type : "daily";
  $("input-interval-n").value = task.freq.intervalDays || 2;
  $("input-interval-weeks").value = task.freq.intervalWeeks || 2;
  const d = dueDateOf(task) || new Date();
  // Older weekly tasks had no weekday of their own — take it from the date.
  $("input-weekday").value = String(task.freq.weekday ?? d.getDay());
  $("input-monthday").value = task.freq.monthDay || d.getDate();
  $("input-task-date").value = localDateStr(d);
  $("input-task-time").value = task.hasTime
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : "";
  populateListSelect();
  $("input-task-list").value = task.listId && listById(task.listId) ? task.listId : "";
  $("input-task-owner").value = task.owner || "";
  $("input-task-taketurns").checked = !!task.takeTurns;
  $("input-task-estimate").value = task.estimateMins == null ? "" : task.estimateMins;
  $("task-advanced").open = task.estimateMins != null;
  taskModalCategories.clear();
  (task.categoryIds || []).forEach((id) => { if (categoriesCache[id]) taskModalCategories.add(id); });
  renderTaskCategoryChips();
  $("task-modal-error").textContent = "";
  $("btn-delete-task").classList.remove("hidden");
  updateFreqRows();
  setModalOpen("task-modal-backdrop", true);
}

function closeTaskModal() {
  setModalOpen("task-modal-backdrop", false);
}

async function saveTask() {
  const title = $("input-task-title").value.trim();
  const err = $("task-modal-error");
  err.textContent = "";
  if (!title) { err.textContent = "Give the task a name."; return; }

  const type = taskModalFreqType();
  let freq = { type };
  if (type === "custom-days") freq.intervalDays = Math.max(1, parseInt($("input-interval-n").value, 10) || 1);
  if (type === "weekly") freq.weekday = parseInt($("input-weekday").value, 10);
  if (type === "custom-weeks") {
    freq.intervalWeeks = Math.max(1, parseInt($("input-interval-weeks").value, 10) || 1);
    freq.weekday = parseInt($("input-weekday").value, 10);
  }
  if (type === "monthly") freq.monthDay = Math.min(28, Math.max(1, parseInt($("input-monthday").value, 10) || 1));

  // Where the due date comes from: nowhere at all for a "whenever" task; the
  // weekday or day-of-month when one of those governs; otherwise the date
  // field. On an edit that didn't change the schedule, the occurrence already
  // in flight is left where it is.
  const dueMode = $("input-task-duemode").value;
  const existing = editingTaskId ? tasksById[editingTaskId] : null;
  const sameFreq = existing && JSON.stringify(existing.freq) === JSON.stringify(freq);
  let dueDate = null;
  let hasTime = false;

  if (dueMode !== "whenever") {
    if (freqImpliesDate(type)) {
      // Whichever matching date was picked from the list.
      const picked = $("input-task-dateopts").value;
      if (picked) dueDate = new Date(`${picked}T00:00`);
      else if (sameFreq && dueDateOf(existing)) dueDate = dueDateOf(existing);
      else if (type === "monthly") dueDate = nextMonthDayDate(freq.monthDay);
      else dueDate = nextWeekdayDate(freq.weekday);
    } else {
      const dateStr = $("input-task-date").value;
      if (!dateStr) { err.textContent = "Pick a date, or set this to “Whenever”."; return; }
      dueDate = new Date(`${dateStr}T00:00`);
    }

    const timeStr = $("input-task-time").value;
    hasTime = !!timeStr;
    dueDate = new Date(dueDate);
    if (hasTime) {
      const [hh, mm] = timeStr.split(":").map((n) => parseInt(n, 10));
      dueDate.setHours(hh || 0, mm || 0, 0, 0);
    } else {
      dueDate.setHours(0, 0, 0, 0);
    }
  }

  const takeTurns = type !== "once" && $("input-task-taketurns").checked;
  // Taking turns and having an owner are mutually exclusive.
  const owner = takeTurns ? null : ($("input-task-owner").value || null);
  const categoryIds = [...taskModalCategories];
  const listId = $("input-task-list").value || null;
  const estimateRaw = $("input-task-estimate").value.trim();
  const estimateMins = estimateRaw === "" ? null : Math.max(0, parseInt(estimateRaw, 10) || 0);

  $("btn-save-task").disabled = true;
  try {
    if (editingTaskId) {
      const existing = tasksById[editingTaskId];
      const patch = {
        title, freq, dueMode, dueAt: dueDate ? Timestamp.fromDate(dueDate) : null, hasTime,
        owner, takeTurns, categoryIds, estimateMins, listId,
      };
      // Changing the owner carries the currently-open occurrence with it,
      // unless somebody has already taken that occurrence off the owner.
      if (existing && owner !== existing.owner
          && (!existing.assignedTo || existing.assignedTo === existing.owner)) {
        patch.assignedTo = owner;
      }
      await updateDoc(taskDoc(editingTaskId), patch);
    } else {
      await addDoc(tasksCol(), {
        title, freq, dueMode, dueAt: dueDate ? Timestamp.fromDate(dueDate) : null, hasTime,
        owner, assignedTo: owner, takeTurns, categoryIds, estimateMins, listId, priority: 0,
        createdBy: currentProfile.id, createdAt: serverTimestamp(),
      });
    }
    closeTaskModal();
    showToast("Task saved");
  } catch (e) {
    err.textContent = "Couldn't save right now — check your connection and try again.";
  } finally {
    $("btn-save-task").disabled = false;
  }
}

async function deleteTask() {
  if (!editingTaskId) return;
  if (!confirm("Delete this task for good?")) return;
  await deleteDoc(taskDoc(editingTaskId));
  closeTaskModal();
  showToast("Task deleted");
}

// ---------- connection status ----------
function updateSyncDot() {
  const offline = !navigator.onLine;
  $("sync-dot").classList.toggle("offline", offline);
  const t = $("sync-text");
  if (t) t.textContent = offline ? "Offline — changes will sync later" : "Synced";
}
window.addEventListener("online", updateSyncDot);
window.addEventListener("offline", updateSyncDot);
updateSyncDot();

// The running build, read from the service worker's own cache name — so it
// reports what's actually loaded rather than a number typed in two places.
// Handy for telling whether a deploy has landed yet.
async function showAppVersion() {
  const el = $("app-version");
  if (!el) return;
  const read = async () => {
    try {
      const names = await caches.keys();
      const shell = names.find((n) => n.startsWith("choretl-shell-"));
      return shell ? shell.replace("choretl-shell-", "") : null;
    } catch (e) {
      return null;
    }
  };
  let version = await read();
  // On a first visit the worker hasn't cached anything yet — wait for it
  // rather than reporting nothing.
  if (!version && navigator.serviceWorker) {
    try {
      await navigator.serviceWorker.ready;
      version = await read();
    } catch (e) { /* no worker — leave it blank */ }
  }
  el.textContent = version || "";
}

// ---------- themes ----------
// Every colour the app paints with lives in these nine tokens, so a theme is
// just a set of them. They're kept on this device rather than in the
// household: how the app looks is a matter of whose phone it is.
const THEME_TOKENS = [
  ["blue-dark", "Primary", "Tab bar, buttons, links"],
  ["blue-dark-2", "Primary dark", "Hover states and headings"],
  ["blue-tint", "Page background", "Behind everything, and soft chips"],
  ["card-bg", "Cards", "Task rows, modals, inputs"],
  ["ink", "Text", "Titles and body text"],
  ["ink-soft", "Muted text", "Labels and notes"],
  ["line", "Borders", "Outlines and dividers"],
  ["grey-done", "Done", "Finished and unassigned things"],
  ["danger", "Warning", "Overdue, delete, highest priority"],
];

const PRESET_THEMES = {
  light: {
    name: "Light",
    colors: {
      "blue-dark": "#1E4E85", "blue-dark-2": "#163A64", "blue-tint": "#E7EFF8",
      "card-bg": "#FFFFFF", ink: "#1C222A", "ink-soft": "#57606E",
      line: "#D6E0EC", "grey-done": "#8E97A3", danger: "#B3362F",
    },
  },
  dark: {
    name: "Dark",
    colors: {
      "blue-dark": "#3E7DC4", "blue-dark-2": "#5A95D8", "blue-tint": "#131820",
      "card-bg": "#1C232E", ink: "#E8EDF4", "ink-soft": "#9AA7B8",
      line: "#2E3845", "grey-done": "#6B7785", danger: "#E0615A",
    },
  },
  miami: {
    name: "Miami",
    colors: {
      "blue-dark": "#E5447F", "blue-dark-2": "#C32F68", "blue-tint": "#FFF1E6",
      "card-bg": "#FFFFFF", ink: "#20303A", "ink-soft": "#6B7F8C",
      line: "#FFD3C2", "grey-done": "#00B2A9", danger: "#FF6B35",
    },
  },
  sewer: {
    name: "Sewer",
    colors: {
      "blue-dark": "#6B7A33", "blue-dark-2": "#4E5A24", "blue-tint": "#1A1C15",
      "card-bg": "#262922", ink: "#DCE3C8", "ink-soft": "#9BA486",
      line: "#3A3E2F", "grey-done": "#6E7560", danger: "#C06A2A",
    },
  },
};

const LS_THEME = "choretl.theme";
const LS_CUSTOM_THEMES = "choretl.customThemes";

let customThemes = [];
let activeThemeId = "light";
let themeDraft = null;        // the theme being edited, or null

function loadThemes() {
  try {
    customThemes = JSON.parse(localStorage.getItem(LS_CUSTOM_THEMES) || "[]");
    if (!Array.isArray(customThemes)) customThemes = [];
  } catch (e) {
    customThemes = [];
  }
  activeThemeId = localStorage.getItem(LS_THEME) || "light";
  applyTheme(activeThemeId);
}

function themeById(id) {
  if (PRESET_THEMES[id]) return PRESET_THEMES[id];
  return customThemes.find((t) => t.id === id) || PRESET_THEMES.light;
}

function applyTheme(id, previewColors) {
  const colors = previewColors || themeById(id).colors;
  const root = document.documentElement;
  THEME_TOKENS.forEach(([token]) => {
    if (colors[token]) root.style.setProperty(`--${token}`, colors[token]);
  });
  // The browser's own chrome follows the primary colour.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && colors["blue-dark"]) meta.setAttribute("content", colors["blue-dark"]);
}

function setActiveTheme(id) {
  activeThemeId = id;
  localStorage.setItem(LS_THEME, id);
  applyTheme(id);
  renderThemeGrid();
}

function saveCustomThemes() {
  try {
    localStorage.setItem(LS_CUSTOM_THEMES, JSON.stringify(customThemes));
  } catch (e) {
    showToast("Couldn't save the theme on this device.");
  }
}

function paletteIconSvg() {
  return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.1 0-1 .8-1.7 1.7-1.7h2A4.6 4.6 0 0 0 21 10.6C21 6.4 16.9 3 12 3z"/><circle cx="7.5" cy="11" r="1.1" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="8" r="1.1" fill="currentColor" stroke="none"/></svg>`;
}

on("btn-edit-theme", "click", () => {
  themeDraft = null;
  renderThemeGrid();
  renderThemeEditor();
  setModalOpen("theme-modal-backdrop", true);
});

on("btn-close-theme", "click", () => {
  // Leaving without saving puts back whatever is actually selected.
  themeDraft = null;
  applyTheme(activeThemeId);
  renderThemeEditor();
  setModalOpen("theme-modal-backdrop", false);
});

function renderThemeGrid() {
  const grid = $("theme-grid");
  if (!grid) return;
  grid.innerHTML = "";
  const entries = Object.entries(PRESET_THEMES).map(([id, t]) => ({ id, ...t, preset: true }))
    .concat(customThemes.map((t) => ({ ...t, preset: false })));

  entries.forEach((t) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `theme-card${t.id === activeThemeId ? " selected" : ""}`;
    btn.onclick = () => setActiveTheme(t.id);

    const strip = document.createElement("span");
    strip.className = "theme-strip";
    ["blue-dark", "blue-tint", "card-bg", "ink", "danger"].forEach((k) => {
      const dot = document.createElement("span");
      dot.style.background = t.colors[k];
      strip.appendChild(dot);
    });
    btn.appendChild(strip);

    const name = document.createElement("span");
    name.className = "theme-name";
    name.textContent = t.name;
    btn.appendChild(name);

    if (!t.preset) {
      const edit = document.createElement("span");
      edit.className = "theme-edit";
      edit.textContent = "Edit";
      edit.onclick = (e) => { e.stopPropagation(); openThemeEditor(t.id); };
      btn.appendChild(edit);
    }
    grid.appendChild(btn);
  });
}

on("btn-new-theme", "click", () => openThemeEditor(null));

function openThemeEditor(id) {
  const existing = id ? customThemes.find((t) => t.id === id) : null;
  themeDraft = existing
    ? { id: existing.id, name: existing.name, colors: { ...existing.colors } }
    : { id: null, name: "My theme", colors: { ...themeById(activeThemeId).colors } };
  renderThemeEditor();
  applyTheme(null, themeDraft.colors);
}

function renderThemeEditor() {
  const block = $("theme-custom-block");
  if (!block) return;
  block.classList.toggle("hidden", !themeDraft);
  if (!themeDraft) return;

  $("input-theme-name").value = themeDraft.name;
  $("btn-delete-theme").classList.toggle("hidden", !themeDraft.id);

  const wrap = $("theme-swatches");
  wrap.innerHTML = "";
  THEME_TOKENS.forEach(([token, label, note]) => {
    const row = document.createElement("label");
    row.className = "swatch-row-item";

    const input = document.createElement("input");
    input.type = "color";
    input.value = themeDraft.colors[token] || "#000000";
    input.oninput = () => {
      themeDraft.colors[token] = input.value;
      applyTheme(null, themeDraft.colors);   // repaint as you pick
    };
    row.appendChild(input);

    const text = document.createElement("span");
    text.className = "swatch-text";
    const t1 = document.createElement("span");
    t1.className = "swatch-label";
    t1.textContent = label;
    const t2 = document.createElement("span");
    t2.className = "swatch-note";
    t2.textContent = note;
    text.appendChild(t1);
    text.appendChild(t2);
    row.appendChild(text);

    wrap.appendChild(row);
  });
}

on("input-theme-name", "input", () => { if (themeDraft) themeDraft.name = $("input-theme-name").value; });

on("btn-reset-theme", "click", () => {
  if (!themeDraft) return;
  themeDraft.colors = { ...PRESET_THEMES.light.colors };
  renderThemeEditor();
  applyTheme(null, themeDraft.colors);
});

on("btn-save-theme", "click", () => {
  if (!themeDraft) return;
  const name = ($("input-theme-name").value || "").trim() || "My theme";
  themeDraft.name = name;
  if (themeDraft.id) {
    const i = customThemes.findIndex((t) => t.id === themeDraft.id);
    if (i >= 0) customThemes[i] = { ...themeDraft };
  } else {
    themeDraft.id = `custom-${Date.now().toString(36)}`;
    customThemes.push({ ...themeDraft });
  }
  saveCustomThemes();
  setActiveTheme(themeDraft.id);
  themeDraft = null;
  renderThemeEditor();
  showToast("Theme saved");
});

on("btn-delete-theme", "click", () => {
  if (!themeDraft || !themeDraft.id) return;
  customThemes = customThemes.filter((t) => t.id !== themeDraft.id);
  saveCustomThemes();
  if (activeThemeId === themeDraft.id) setActiveTheme("light");
  themeDraft = null;
  renderThemeEditor();
  renderThemeGrid();
  showToast("Theme deleted");
});

// ---------- installing it as an app ----------
// Chrome fires beforeinstallprompt when it's willing to install; holding onto
// that event gives a reliable button rather than hunting the browser menu —
// and when it never fires, that itself says the browser already counts this
// as installed, which is worth saying out loud.
let deferredInstall = null;

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: minimal-ui)").matches
    || navigator.standalone === true;
}

function syncInstallUI() {
  const btn = $("btn-install-app");
  const note = $("install-note");
  if (!btn || !note) return;
  if (isStandalone()) {
    btn.classList.add("hidden");
    note.textContent = "Running as an installed app on this device.";
  } else if (deferredInstall) {
    btn.classList.remove("hidden");
    note.textContent = "";
  } else {
    btn.classList.add("hidden");
    note.textContent = "Your browser isn't offering to install right now, which usually "
      + "means it already has a copy registered. Remove it from your browser's app list, "
      + "then reload.";
  }
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  syncInstallUI();
});

window.addEventListener("appinstalled", () => {
  deferredInstall = null;
  showToast("Installed");
  syncInstallUI();
});

on("btn-install-app", "click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  try {
    await deferredInstall.userChoice;
  } catch (e) { /* dismissed */ }
  deferredInstall = null;
  syncInstallUI();
});

// ---------- startup ----------
function init() {
  wireEyeButtons();
  wireSegmented();
  rebuildTabs();
  loadThemes();
  $("theme-btn-icon").innerHTML = paletteIconSvg();
  showAppVersion();
  syncInstallUI();
  const savedHouseholdId = localStorage.getItem(LS_HOUSEHOLD_ID);
  const savedHouseholdName = localStorage.getItem(LS_HOUSEHOLD_NAME);
  if (savedHouseholdId) {
    enterHousehold(savedHouseholdId, savedHouseholdName || savedHouseholdId);
  } else {
    showHomeStep("gate");
    setTabsLocked(true);
    switchTab("home");
  }
}
init();
