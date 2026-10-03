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

function freqSummary(freq) {
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  switch (freq.type) {
    case "once": return "One-off";
    case "daily": return "Every day";
    case "weekly": return "Every week";
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

function advanceDue(task) {
  const base = task.dueAt.toDate();
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

// A task has an "appear" moment (when it starts showing in the To-do tab)
// and an "overdue" moment (when it starts showing the red warning). A timed
// task appears right at its time; an untimed one defaults to 7am on its due
// day. Either way it goes overdue at the end of that day if not actioned.
function taskWindow(task) {
  const due = task.dueAt.toDate();
  const day = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  let appearAt;
  if (task.hasTime) {
    appearAt = new Date(due);
  } else {
    appearAt = new Date(day);
    appearAt.setHours(7, 0, 0, 0);
  }
  const overdueAt = new Date(day);
  overdueAt.setHours(23, 59, 59, 999);
  return { appearAt, overdueAt };
}

// "pending" = not yet appeared (don't show in To-do), "upcoming" = showing,
// actionable, "overdue" = showing with a warning.
function taskStatus(task, now) {
  const { appearAt, overdueAt } = taskWindow(task);
  if (now < appearAt) return "pending";
  if (now > overdueAt) return "overdue";
  return "upcoming";
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
  syncHouseholdHeader();
  pendingAutoSelectProfileId = localStorage.getItem(LS_PROFILE_ID);
  subscribeProfiles();
  subscribeCategories();
  subscribeTasks();
  subscribeLog();
  startRollover();
}

// Keeps the "Home" tab label and the tab bar's colour in sync with whoever
// is currently active — their name instead of "Home", their colour instead
// of the default blue.
function syncIdentityUI() {
  $("tab-home-label").textContent = currentProfile ? currentProfile.name : "Home";
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
    "* To install on Android, open the browser menu (top right) and choose “Install app”. On iPhone, tap Share then “Add to Home Screen”.",
    `* Join my household called “${householdName || ""}”`,
    `* Enter password - ${password || "(ask me)"}`,
  ].join("\n");
}

function refreshInvitePreview() {
  $("share-preview").value = buildInviteText($("input-share-password").value.trim());
}

on("btn-share-household", "click", () => {
  const saved = localStorage.getItem(LS_HOUSEHOLD_PASSWORD) || "";
  $("input-share-password").value = saved;
  $("share-password-note").textContent = saved
    ? "Saved on this device only — never uploaded."
    : "This device doesn't have the password saved. Type it in to include it.";
  refreshInvitePreview();
  setModalOpen("share-modal-backdrop", true);
});

on("input-share-password", "input", refreshInvitePreview);
on("btn-close-share", "click", () => setModalOpen("share-modal-backdrop", false));

on("btn-copy-share", "click", async () => {
  const typed = $("input-share-password").value.trim();
  // If they filled it in by hand and it's right, remember it for next time.
  if (typed && typed !== localStorage.getItem(LS_HOUSEHOLD_PASSWORD)) {
    try {
      const snap = await getDoc(hhDoc());
      const hash = await sha256Hex(`${householdId}:${typed}`);
      if (snap.exists() && hash === snap.data().passwordHash) {
        localStorage.setItem(LS_HOUSEHOLD_PASSWORD, typed);
        $("share-password-note").textContent = "Saved on this device only — never uploaded.";
      } else {
        $("share-password-note").textContent = "That doesn't match this household's password — copying it anyway.";
      }
    } catch (e) {
      // Offline: copy what they typed and don't make a fuss about it.
    }
  }
  await copyText(buildInviteText(typed), "Invite copied");
});

// The household name rides along in the header, so it's always visible —
// it's the name people need when they join.
function syncHouseholdHeader() {
  const chip = $("header-household");
  chip.textContent = householdName || "";
  chip.classList.toggle("hidden", !householdName);
  document.body.classList.toggle("in-household", !!householdName);
}

function leaveHousehold() {
  teardown();
  householdId = null;
  householdName = null;
  currentProfile = null;
  syncIdentityUI();
  syncHouseholdHeader();
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
  if (rolloverTimer) clearInterval(rolloverTimer);
  unsubProfiles = unsubTasks = unsubLog = unsubCategories = null;
  rolloverTimer = null;
  tasksById = {};
  profilesCache = {};
  sortedProfileIds = [];
  categoriesCache = {};
  sortedCategoryIds = [];
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
  "filter-cat-alltasks", "filter-cat-summary",
];

// Categories are tags, so the filter is a set rather than one choice, and a
// task shows if it carries ANY of the picked ones. Empty set = no filtering.
// A category means the same thing in every tab, so unlike the person filters
// this one setting carries across all of them.
const categoryFilter = new Set();

function categoryFilterLabel() {
  if (categoryFilter.size === 0) return "All categories";
  if (categoryFilter.size === 1) {
    const only = [...categoryFilter][0];
    return only === "none" ? "Untagged" : (categoryName(only) || "1 category");
  }
  return `${categoryFilter.size} categories`;
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
  setModalOpen("catfilter-modal-backdrop", true);
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
  renderCategoryFilterOptions();
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
function setTabsLocked(locked) {
  document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
    if (btn.dataset.tab === "home") return;
    btn.disabled = locked;
  });
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === `pane-${tab}`));
  $("btn-add-task").classList.toggle("hidden",
    !currentProfile || tab === "home" || tab === "log" || tab === "summary");
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

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// ---------- selects ----------
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

function populateFilterSelect(sel, kind) {
  const current = kind === "done" ? doneFilter : assignFilter;
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
  if (![...sel.options].some((o) => o.value === current)) {
    if (kind === "done") doneFilter = "mine"; else assignFilter = "mine";
  }
  sel.value = kind === "done" ? doneFilter : assignFilter;
}

function populatePersonFilters() {
  populateFilterSelect($("filter-due"), "due");
  populateFilterSelect($("filter-checklist"), "due");
  populateFilterSelect($("filter-done"), "done");
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
function normaliseTask(id, raw) {
  return {
    id,
    ...raw,
    priority: typeof raw.priority === "number" ? raw.priority : (raw.starred ? 1 : 0),
    owner: raw.owner ?? null,
    assignedTo: raw.assignedTo ?? null,
    takeTurns: !!raw.takeTurns,
    // Categories are tags now — a task written before that had a single one.
    categoryIds: Array.isArray(raw.categoryIds)
      ? raw.categoryIds
      : (raw.categoryId ? [raw.categoryId] : []),
  };
}

function subscribeLog() {
  if (unsubLog) unsubLog();
  const q = query(logCol(), orderBy("doneAt", "desc"));
  unsubLog = onSnapshot(q, (snap) => {
    logRows = [];
    snap.forEach((d) => logRows.push(d.data()));
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
  renderChecklist();
  renderDue();
  renderDoneList();
  renderAllTasks();
  renderSummary();
}

// matches an assignment-style filter (To-do tab): "mine" counts unassigned too
function matchesAssignFilter(value, assignedTo) {
  if (value === "anyone") return true;
  if (value === "mine") return !assignedTo || assignedTo === currentProfile.id;
  return assignedTo === value;
}

// matches a "done by" filter (Done tab): no unassigned concept
function matchesDoneFilter(value, doneBy) {
  if (value === "anyone") return true;
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
  if (task.lastCompletion && taskStatus(task, now) === "pending") return false;
  return true;
}

function renderDue() {
  const now = new Date();
  const sortVal = $("sort-due").value;

  let list_ = Object.values(tasksById).filter((t) => isOpenNow(t, now));
  list_ = list_.filter((t) => matchesAssignFilter(assignFilter, t.assignedTo) && matchesCategoryFilter(t));

  if (sortVal === "alpha") {
    list_.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sortVal === "priority") {
    list_.sort((a, b) => {
      if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
      return a.dueAt.toDate() - b.dueAt.toDate();
    });
  } else {
    list_.sort((a, b) => a.dueAt.toDate() - b.dueAt.toDate());
  }

  visibleLists.due = list_;
  const list = $("list-due");
  list.innerHTML = "";
  $("due-empty").classList.toggle("hidden", list_.length > 0);
  list_.forEach((t) => list.appendChild(renderOpenRow(t, now)));
}

function renderDoneList() {
  const sortVal = $("sort-done").value;
  let done = Object.values(tasksById).filter((t) => !!t.lastCompletion);
  done = done.filter((t) =>
    matchesDoneFilter(doneFilter, t.lastCompletion.skipped ? null : t.lastCompletion.by)
    && matchesCategoryFilter(t));

  const doneAtMs = (t) => t.lastCompletion.at?.toDate?.()?.getTime() ?? 0;
  if (sortVal === "alpha") done.sort((a, b) => a.title.localeCompare(b.title));
  else if (sortVal === "oldest") done.sort((a, b) => doneAtMs(a) - doneAtMs(b));
  else done.sort((a, b) => doneAtMs(b) - doneAtMs(a));

  visibleLists.done = done;
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

  let all = Object.values(tasksById).filter(matchesCategoryFilter);
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
    all.sort((a, b) => a.dueAt.toDate() - b.dueAt.toDate());
  }

  visibleLists.alltasks = all;
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
    if (status === "overdue") wrap.classList.add("overdue");
    wrap.style.setProperty("--inst", task.assignedTo && profilesCache[task.assignedTo]
      ? colorForProfile(task.assignedTo)
      : "var(--grey-done)");

    const when = document.createElement("span");
    when.className = "inst-when";
    when.textContent = status === "overdue"
      ? `Overdue ${fmtDue(task.dueAt.toDate(), task.hasTime)}`
      : `Due ${fmtDue(task.dueAt.toDate(), task.hasTime)}`;
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
    const label = document.createElement("span");
    label.className = "inst-when";
    label.textContent = lc && lc.skipped ? "Skipped" : "Last done";
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

    if (task.freq.type !== "once") {
      const next = document.createElement("span");
      next.className = "inst-next";
      next.textContent = `Back ${fmtDue(task.dueAt.toDate(), task.hasTime)}`;
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
  kicker.textContent = freqSummary(task.freq);
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
const visibleLists = { due: [], done: [], alltasks: [], open: [], recent: [] };

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
    lines = visibleLists.due.map((t) => `- ${t.title}`);
  } else if (which === "done") {
    header = personPhrase("done") + categoryPhrase();
    lines = visibleLists.done.map((t) => `✓ ${t.title}`);
  } else if (which === "alltasks") {
    const search = $("alltasks-search").value.trim();
    header = `All tasks${categoryPhrase()}${search ? ` matching "${search}"` : ""}`;
    lines = visibleLists.alltasks.map((t) => `- ${t.title}`);
  } else {
    header = personPhrase("due") + categoryPhrase();
    lines = visibleLists.open.map((t) => `- ${t.title}`)
      .concat(visibleLists.recent.map((t) => `✓ ${t.title}`));
  }
  if (!lines.length) lines = ["(nothing on this list)"];
  return `${header}\n${lines.join("\n")}`;
}

on("copy-due", "click", () => copyText(buildListText("due")));
on("copy-done", "click", () => copyText(buildListText("done")));
on("copy-alltasks", "click", () => copyText(buildListText("alltasks")));
on("copy-checklist", "click", () => copyText(buildListText("checklist")));

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
    .filter((t) => matchesAssignFilter(assignFilter, t.assignedTo) && matchesCategoryFilter(t))
    .sort((a, b) => a.dueAt.toDate() - b.dueAt.toDate());

  // The ticked-off half matches on who actually did it — that's whose tick
  // it is — rather than on who the next one is assigned to.
  const recent = Object.values(tasksById)
    .filter((t) => {
      const at = t.lastCompletion?.at?.toDate?.();
      return at && now - at <= RECENTLY_DONE_MS;
    })
    .filter((t) =>
      matchesDoneFilter(assignFilter, t.lastCompletion.skipped ? null : t.lastCompletion.by)
      && matchesCategoryFilter(t))
    .sort((a, b) => b.lastCompletion.at.toDate() - a.lastCompletion.at.toDate());

  visibleLists.open = open;
  visibleLists.recent = recent;
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
  if (status === "overdue") li.classList.add("overdue");
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
    meta.textContent = status === "overdue"
      ? `${whose} · overdue since ${fmtDue(task.dueAt.toDate(), task.hasTime)}`
      : `${whose} · due ${fmtDue(task.dueAt.toDate(), task.hasTime)}`;
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
    return matchesCategoryFilter({ categoryIds: rowCategories(r) });
  });

  // Per person: what they did in the window, plus what's on them right now.
  const byPerson = {};
  const ensure = (id) => (byPerson[id] = byPerson[id] || { done: 0, titles: {}, open: 0 });
  sortedProfileIds.forEach(ensure);
  let skipped = 0;
  rows.forEach((r) => {
    if (r.skipped) { skipped += 1; return; }
    if (!r.doneBy || !profilesCache[r.doneBy]) return;
    const rec = ensure(r.doneBy);
    rec.done += 1;
    rec.titles[r.taskTitle] = (rec.titles[r.taskTitle] || 0) + 1;
  });

  const now = new Date();
  Object.values(tasksById).forEach((t) => {
    if (!matchesCategoryFilter(t)) return;
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
    + (skipped ? ` · ${skipped} skipped` : "");
  body.appendChild(head);

  // Busiest first — that's the question this tab is really answering.
  const ranked = sortedProfileIds.slice().sort((a, b) =>
    (byPerson[b]?.done || 0) - (byPerson[a]?.done || 0)
    || (profilesCache[a].name || "").localeCompare(profilesCache[b].name || ""));

  ranked.forEach((id) => {
    const rec = byPerson[id] || { done: 0, titles: {}, open: 0 };
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
    const share = totalDone ? Math.round((rec.done / totalDone) * 100) : 0;
    const count = document.createElement("span");
    count.className = "summary-count";
    count.textContent = totalDone
      ? `${rec.done} done · ${share}%`
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

function renderLogList(rows) {
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
  if (status === "overdue") li.classList.add("overdue-row");
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
    badge.className = "status-badge overdue";
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
  const dueLabel = status === "overdue" ? "overdue since" : "due";
  freqNote.textContent = `${freqSummary(task.freq)} · ${dueLabel} ${fmtDue(task.dueAt.toDate(), task.hasTime)}`;

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
async function completeTask(task, byId, skipped) {
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
  const logRef = await addDoc(logCol(), {
    taskId: task.id,
    taskTitle: task.title,
    categoryIds: task.categoryIds || [],
    doneBy: skipped ? null : byId,
    doneByName: skipped ? null : (profilesCache[byId]?.name || "Someone"),
    skipped: !!skipped,
    doneAt: serverTimestamp(),
  });
  await updateDoc(taskDoc(task.id), {
    dueAt: Timestamp.fromDate(nextDue),
    prevDueAt,
    prevAssignedTo: task.assignedTo ?? null,
    assignedTo: nextAssignee,
    lastCompletion: {
      by: skipped ? null : byId,
      at: serverTimestamp(),
      skipped: !!skipped,
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
  setModalOpen("done-modal-backdrop", true);
}

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
  if (task && doneModalSelectedId) completeTask(task, doneModalSelectedId, false);
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

function updateFreqRows() {
  const type = $("input-task-freq").value;
  $("row-interval-days").classList.toggle("hidden", type !== "custom-days");
  $("row-weekday").classList.toggle("hidden", type !== "custom-weeks");
  $("wrap-interval-weeks").classList.toggle("hidden", type !== "custom-weeks");
  $("row-monthday").classList.toggle("hidden", type !== "monthly");
  // Taking turns only means anything for something that comes back around.
  $("row-take-turns").classList.toggle("hidden", type === "once");
}

function openAddTaskModal() {
  editingTaskId = null;
  $("task-modal-title").textContent = "Add task";
  $("task-modal-sub").classList.add("hidden");
  $("input-task-title").value = "";
  $("input-task-freq").value = "daily";
  $("input-interval-n").value = 2;
  $("input-interval-weeks").value = 2;
  $("input-weekday").value = String(new Date().getDay());
  $("input-monthday").value = 1;
  $("input-task-date").value = localDateStr(new Date());
  $("input-task-time").value = "";
  $("input-task-owner").value = "";
  $("input-task-taketurns").checked = false;
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
  $("input-task-freq").value = task.freq.type;
  $("input-interval-n").value = task.freq.intervalDays || 2;
  $("input-interval-weeks").value = task.freq.intervalWeeks || 2;
  $("input-weekday").value = String(task.freq.weekday ?? new Date().getDay());
  $("input-monthday").value = task.freq.monthDay || 1;
  const d = task.dueAt.toDate();
  $("input-task-date").value = localDateStr(d);
  $("input-task-time").value = task.hasTime
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : "";
  $("input-task-owner").value = task.owner || "";
  $("input-task-taketurns").checked = !!task.takeTurns;
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

  const type = $("input-task-freq").value;
  let freq = { type };
  if (type === "custom-days") freq.intervalDays = Math.max(1, parseInt($("input-interval-n").value, 10) || 1);
  if (type === "custom-weeks") {
    freq.intervalWeeks = Math.max(1, parseInt($("input-interval-weeks").value, 10) || 1);
    freq.weekday = parseInt($("input-weekday").value, 10);
  }
  if (type === "monthly") freq.monthDay = Math.min(28, Math.max(1, parseInt($("input-monthday").value, 10) || 1));

  const dateStr = $("input-task-date").value;
  if (!dateStr) { err.textContent = "Pick a due date."; return; }
  const timeStr = $("input-task-time").value;
  const hasTime = !!timeStr;
  const dueDate = hasTime ? new Date(`${dateStr}T${timeStr}`) : new Date(`${dateStr}T00:00`);
  const owner = $("input-task-owner").value || null;
  const takeTurns = type !== "once" && $("input-task-taketurns").checked;
  const categoryIds = [...taskModalCategories];

  $("btn-save-task").disabled = true;
  try {
    if (editingTaskId) {
      const existing = tasksById[editingTaskId];
      const patch = {
        title, freq, dueAt: Timestamp.fromDate(dueDate), hasTime,
        owner, takeTurns, categoryIds,
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
        title, freq, dueAt: Timestamp.fromDate(dueDate), hasTime,
        owner, assignedTo: owner, takeTurns, categoryIds, priority: 0,
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

// ---------- startup ----------
function init() {
  wireEyeButtons();
  wireSegmented();
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
