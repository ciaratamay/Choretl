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
let unsubProfiles = null;
let unsubTasks = null;
let unsubLog = null;
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
function showHomeStep(step) {
  $("home-no-household").classList.toggle("hidden", step !== "gate");
  $("home-pick-profile").classList.toggle("hidden", step !== "profiles");
  $("home-step-profile").classList.toggle("hidden", step !== "profile-edit");
  $("home-signed-in").classList.toggle("hidden", step !== "active");
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
  subscribeTasks();
  subscribeLog();
  startRollover();
}

function leaveHousehold() {
  teardown();
  householdId = null;
  householdName = null;
  currentProfile = null;
  localStorage.removeItem(LS_HOUSEHOLD_ID);
  localStorage.removeItem(LS_HOUSEHOLD_NAME);
  localStorage.removeItem(LS_PROFILE_ID);
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
  if (rolloverTimer) clearInterval(rolloverTimer);
  unsubProfiles = unsubTasks = unsubLog = null;
  rolloverTimer = null;
  tasksById = {};
  profilesCache = {};
  sortedProfileIds = [];
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
  if (currentProfile) {
    if (!profilesCache[currentProfile.id]) {
      // The active profile was deleted (maybe by the other person) — drop back to the picker.
      currentProfile = null;
      localStorage.removeItem(LS_PROFILE_ID);
      renderProfilePicker();
      showHomeStep("profiles");
      setTabsLocked(true);
      switchTab("home");
    } else {
      currentProfile = { id: currentProfile.id, ...profilesCache[currentProfile.id] };
      $("me-badge").textContent = currentProfile.name;
    }
  } else if (pendingAutoSelectProfileId && profilesCache[pendingAutoSelectProfileId]) {
    const id = pendingAutoSelectProfileId;
    pendingAutoSelectProfileId = null;
    selectProfile(id);
  } else if (!currentProfile) {
    renderProfilePicker();
    showHomeStep("profiles");
    setTabsLocked(true);
  }
  populateAssigneeSelect();
  if (currentProfile) {
    populateFilterSelect($("filter-due"));
    populateFilterSelect($("filter-done"));
  }
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
    btn.className = "profile-pick";
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
  populateAssigneeSelect();
  populateFilterSelect($("filter-due"));
  populateFilterSelect($("filter-done"));
  showHomeStep("active");
  setTabsLocked(false);
  renderAll();
  switchTab("due");
}

on("btn-switch-profile", "click", () => {
  currentProfile = null;
  localStorage.removeItem(LS_PROFILE_ID);
  renderProfilePicker();
  showHomeStep("profiles");
  setTabsLocked(true);
  switchTab("home");
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
  if (!confirm(`Delete ${p?.name || "this person"}? Tasks assigned to or done by them will become unassigned.`)) return;
  const id = editingProfileId;
  try {
    const touched = Object.values(tasksById).filter((t) =>
      t.assignedTo === id || (t.lastCompletion && t.lastCompletion.by === id));
    await Promise.all(touched.map((t) => {
      const patch = {};
      if (t.assignedTo === id) patch.assignedTo = null;
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
  $("btn-add-task").classList.toggle("hidden", !currentProfile || tab === "home" || tab === "log");
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// ---------- selects ----------
function populateAssigneeSelect() {
  const sel = $("input-task-assignee");
  sel.innerHTML = '<option value="">Unassigned</option>';
  sortedProfileIds.forEach((id) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = profilesCache[id].name;
    sel.appendChild(opt);
  });
}

function populateFilterSelect(sel) {
  const prev = sel.value;
  sel.innerHTML = '<option value="mine">Mine</option><option value="anyone">Anyone</option>';
  sortedProfileIds.forEach((id) => {
    if (currentProfile && id === currentProfile.id) return;
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = profilesCache[id].name;
    sel.appendChild(opt);
  });
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
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
  btn.textContent = "Assign";
  btn.onclick = () => openAssignModal(task);
  return btn;
}

let assignModalTaskId = null;

function openAssignModal(task) {
  assignModalTaskId = task.id;
  const wrap = $("assign-options");
  wrap.innerHTML = "";

  const unassignedBtn = document.createElement("button");
  unassignedBtn.className = `profile-pick${!task.assignedTo ? " current" : ""}`;
  unassignedBtn.appendChild(buildAvatar(null, { small: true }));
  unassignedBtn.appendChild(document.createTextNode("Unassigned"));
  unassignedBtn.onclick = () => commitAssign(null);
  wrap.appendChild(unassignedBtn);

  sortedProfileIds.forEach((id) => {
    const b = document.createElement("button");
    b.className = `profile-pick${task.assignedTo === id ? " current" : ""}`;
    b.appendChild(buildAvatar(id, { small: true }));
    b.appendChild(document.createTextNode(profilesCache[id].name));
    b.onclick = () => commitAssign(id);
    wrap.appendChild(b);
  });

  $("assign-modal-backdrop").classList.remove("hidden");
}

function commitAssign(idOrNull) {
  if (!assignModalTaskId) return;
  updateDoc(taskDoc(assignModalTaskId), { assignedTo: idOrNull });
  closeAssignModal();
}

function closeAssignModal() {
  $("assign-modal-backdrop").classList.add("hidden");
  assignModalTaskId = null;
}

on("btn-cancel-assign", "click", closeAssignModal);

function buildStarButton(task) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `star-btn${task.starred ? " starred" : ""}`;
  btn.textContent = task.starred ? "★" : "☆";
  btn.title = task.starred ? "Unstar" : "Star to prioritise";
  btn.onclick = () => updateDoc(taskDoc(task.id), { starred: !task.starred });
  return btn;
}

// ---------- tasks / log subscriptions ----------
function subscribeTasks() {
  if (unsubTasks) unsubTasks();
  unsubTasks = onSnapshot(tasksCol(), (snap) => {
    tasksById = {};
    snap.forEach((d) => { tasksById[d.id] = { id: d.id, ...d.data() }; });
    renderAll();
  }, () => showToast("Having trouble syncing right now."));
}

function subscribeLog() {
  if (unsubLog) unsubLog();
  const q = query(logCol(), orderBy("doneAt", "desc"));
  unsubLog = onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((d) => rows.push(d.data()));
    renderLogList(rows);
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
  renderDue();
  renderDoneList();
  renderAllTasks();
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

function renderDue() {
  const now = new Date();
  const filterVal = $("filter-due").value;
  const sortVal = $("sort-due").value;

  let list_ = Object.values(tasksById).filter((t) => {
    // A one-off task that's already been done or skipped has no "next
    // occurrence" to show — it only lives on in the Done tab from here.
    if (t.freq.type === "once" && t.lastCompletion) return false;
    return taskStatus(t, now) !== "pending";
  });
  list_ = list_.filter((t) => matchesAssignFilter(filterVal, t.assignedTo));

  if (sortVal === "alpha") {
    list_.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sortVal === "priority") {
    list_.sort((a, b) => {
      if (!!b.starred !== !!a.starred) return (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
      return a.dueAt.toDate() - b.dueAt.toDate();
    });
  } else {
    list_.sort((a, b) => a.dueAt.toDate() - b.dueAt.toDate());
  }

  const list = $("list-due");
  list.innerHTML = "";
  $("due-empty").classList.toggle("hidden", list_.length > 0);
  list_.forEach((t) => list.appendChild(renderOpenRow(t, now)));
}

function renderDoneList() {
  const filterVal = $("filter-done").value;
  let done = Object.values(tasksById).filter((t) => !!t.lastCompletion);
  done = done.filter((t) => matchesDoneFilter(filterVal, t.lastCompletion.skipped ? null : t.lastCompletion.by));
  done.sort((a, b) => (b.lastCompletion.at?.toDate?.() ?? 0) - (a.lastCompletion.at?.toDate?.() ?? 0));

  const list = $("list-done");
  list.innerHTML = "";
  $("done-empty").classList.toggle("hidden", done.length > 0);
  done.forEach((t) => list.appendChild(renderDoneRow(t)));
}

on("filter-due", "change", renderDue);
on("sort-due", "change", renderDue);
on("filter-done", "change", renderDoneList);
on("alltasks-search", "input", renderAllTasks);
on("alltasks-sort", "change", renderAllTasks);

function renderAllTasks() {
  if (!currentProfile) return;
  const searchVal = $("alltasks-search").value.trim().toLowerCase();
  const sortVal = $("alltasks-sort").value;

  let all = Object.values(tasksById);
  if (searchVal) all = all.filter((t) => t.title.toLowerCase().includes(searchVal));

  if (sortVal === "alpha") all.sort((a, b) => a.title.localeCompare(b.title));
  else all.sort((a, b) => a.dueAt.toDate() - b.dueAt.toDate());

  const list = $("list-alltasks");
  list.innerHTML = "";
  $("alltasks-empty").classList.toggle("hidden", all.length > 0);
  all.forEach((t) => list.appendChild(renderAllTasksRow(t)));
}

// This tab is a plain reference list of the tasks themselves — no done/
// skipped/overdue state, just what the task is and how it repeats.
function renderAllTasksRow(task) {
  const li = document.createElement("li");
  li.className = "task-row";

  const avatar = buildAvatar(task.assignedTo);

  const main = document.createElement("div");
  main.className = "task-main";

  const titleRow = document.createElement("div");
  titleRow.className = "title-row";
  titleRow.appendChild(buildStarButton(task));
  const title = document.createElement("span");
  title.className = "task-title";
  title.textContent = task.title;
  titleRow.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "task-meta";
  meta.appendChild(buildAssignButton(task));

  const freqNote = document.createElement("span");
  freqNote.className = "freq-note";
  freqNote.style.margin = "0";
  freqNote.textContent = freqSummary(task.freq);
  meta.appendChild(freqNote);

  const editBtn = document.createElement("button");
  editBtn.className = "text-btn";
  editBtn.textContent = "Edit";
  editBtn.onclick = () => openEditTaskModal(task);
  meta.appendChild(editBtn);

  main.appendChild(titleRow);
  main.appendChild(meta);

  li.appendChild(avatar);
  li.appendChild(main);
  return li;
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

function renderOpenRow(task, now) {
  const li = document.createElement("li");
  li.className = "task-row";
  const status = taskStatus(task, now);
  if (status === "overdue") li.classList.add("overdue-row");

  const main = document.createElement("div");
  main.className = "task-main";

  const titleRow = document.createElement("div");
  titleRow.className = "title-row";
  titleRow.appendChild(buildStarButton(task));
  const title = document.createElement("span");
  title.className = "task-title";
  title.textContent = task.title;
  titleRow.appendChild(title);
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
  li.className = "task-row";
  const lc = task.lastCompletion;
  if (lc.skipped) li.classList.add("skipped-row");

  const main = document.createElement("div");
  main.className = "task-main";
  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = task.title;

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
  meta.appendChild(buildAssignButton(task));

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

  main.appendChild(title);
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
  await updateDoc(taskDoc(task.id), {
    dueAt: Timestamp.fromDate(nextDue),
    prevDueAt,
    lastCompletion: {
      by: skipped ? null : byId,
      at: serverTimestamp(),
      skipped: !!skipped,
    },
  });
  await addDoc(logCol(), {
    taskId: task.id,
    taskTitle: task.title,
    doneBy: skipped ? null : byId,
    doneByName: skipped ? null : (profilesCache[byId]?.name || "Someone"),
    skipped: !!skipped,
    doneAt: serverTimestamp(),
  });
  showToast(skipped ? "Skipped" : "Marked done");
}

async function undoCompletion(task) {
  await updateDoc(taskDoc(task.id), {
    dueAt: task.prevDueAt || task.dueAt,
    lastCompletion: null,
  });
}

// ---------- "mark done by" modal ----------
let doneModalTaskId = null;
let doneModalSelectedId = null;

function openDoneModal(task) {
  doneModalTaskId = task.id;
  doneModalSelectedId = currentProfile ? currentProfile.id : (sortedProfileIds[0] || null);
  renderDoneModalOptions();
  $("done-modal-backdrop").classList.remove("hidden");
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
  $("done-modal-backdrop").classList.add("hidden");
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
}

function openAddTaskModal() {
  editingTaskId = null;
  $("task-modal-title").textContent = "Add task";
  $("input-task-title").value = "";
  $("input-task-freq").value = "daily";
  $("input-interval-n").value = 2;
  $("input-interval-weeks").value = 2;
  $("input-weekday").value = String(new Date().getDay());
  $("input-monthday").value = 1;
  $("input-task-date").value = localDateStr(new Date());
  $("input-task-time").value = "";
  $("input-task-assignee").value = "";
  $("task-modal-error").textContent = "";
  $("btn-delete-task").classList.add("hidden");
  updateFreqRows();
  $("task-modal-backdrop").classList.remove("hidden");
}

function openEditTaskModal(task) {
  editingTaskId = task.id;
  $("task-modal-title").textContent = "Edit task";
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
  $("input-task-assignee").value = task.assignedTo || "";
  $("task-modal-error").textContent = "";
  $("btn-delete-task").classList.remove("hidden");
  updateFreqRows();
  $("task-modal-backdrop").classList.remove("hidden");
}

function closeTaskModal() {
  $("task-modal-backdrop").classList.add("hidden");
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
  const assignedTo = $("input-task-assignee").value || null;

  $("btn-save-task").disabled = true;
  try {
    if (editingTaskId) {
      await updateDoc(taskDoc(editingTaskId), {
        title, freq, dueAt: Timestamp.fromDate(dueDate), hasTime, assignedTo,
      });
    } else {
      await addDoc(tasksCol(), {
        title, freq, dueAt: Timestamp.fromDate(dueDate), hasTime, assignedTo,
        starred: false, createdBy: currentProfile.id, createdAt: serverTimestamp(),
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
