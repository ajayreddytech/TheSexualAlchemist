import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithRedirect, signInWithPopup, getRedirectResult,
  onAuthStateChanged, signOut, setPersistence, indexedDBLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, setDoc, deleteDoc, collection, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------- setup ---------- */
// Auth state is kept in IndexedDB (not localStorage, not sessionStorage).
// Firestore's offline cache also uses IndexedDB.
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const persistenceReady = setPersistence(auth, indexedDBLocalPersistence).catch(() => {});

const state = {
  user: null,
  days: new Map(),       // "YYYY-MM-DD" -> day document
  tab: "today",
  lastTab: null,
  month: new Date(),
  selected: null,
  editingToday: false,
  chartGran: "month",     // progress chart: day | week | month | year
  chartMode: "period",    // progress chart: period | cum
  unsub: null
};

const flow = { date: null, time: "unknown", chain: [] };
const WHY_FIRST = "Why did it happen?";
const WHY_NEXT = "Why was that?";

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const todayKey = () => keyOf(new Date());
const fmtLong = (d) => d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const fmtShort = (k) => parseKey(k).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const fmtTime = (t) => {
  if (!t || t === "unknown") return "Time not sure";
  const [h, m] = t.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};
const friendly = (err) => (err?.message || String(err)).replace(/^Firebase: /, "");
const trail = (chain = []) => chain.length
  ? `<ol class="trail">${chain.map((c, i) => `<li><span class="q">Why ${i + 1}</span><span>${esc(c.a)}</span></li>`).join("")}</ol>`
  : "";

function bucket(t) {
  if (!t || t === "unknown") return "Unknown";
  const h = Number(t.split(":")[0]);
  if (h >= 5 && h < 12) return "Morning";
  if (h >= 12 && h < 17) return "Afternoon";
  if (h >= 17 && h < 21) return "Evening";
  return "Night";
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  el.classList.remove("show");
  void el.offsetWidth;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function stats() {
  const all = [...state.days.values()];
  const good = all.filter((d) => d.result === "good").length;
  const bad = all.length - good;
  const goodSet = new Set(all.filter((d) => d.result === "good").map((d) => d.date));

  let cur = 0;
  const c = new Date();
  if (!goodSet.has(keyOf(c))) c.setDate(c.getDate() - 1);
  while (goodSet.has(keyOf(c))) { cur++; c.setDate(c.getDate() - 1); }

  let best = 0, run = 0, prev = null;
  for (const d of all.sort((a, b) => a.date.localeCompare(b.date))) {
    if (d.result !== "good") { run = 0; prev = null; continue; }
    run = prev && Math.round((parseKey(d.date) - parseKey(prev)) / 864e5) === 1 ? run + 1 : 1;
    prev = d.date;
    best = Math.max(best, run);
  }
  return { good, bad, cur, best };
}

/* ---------- auth ---------- */
persistenceReady.then(() => getRedirectResult(auth)).catch((err) => toast(friendly(err)));

onAuthStateChanged(auth, (user) => {
  state.user = user;
  $("#splash").classList.add("hide");
  $("#login").hidden = !!user;
  $("#app").hidden = !user;
  if (user) {
    subscribe(user.uid);
  } else {
    state.unsub?.();
    state.unsub = null;
    state.unsubReflection?.();
    state.unsubReflection = null;
    state.reflection = null;
    state.days = new Map();
  }
  render();
});

function subscribe(uid) {
  state.unsubReflection?.();
  state.unsubReflection = onSnapshot(
    doc(db, "users", uid, "profile", "reflection"),
    (snap) => { state.reflection = snap.data() || null; if (!(state.tab === "why" && state.editingWhy)) render(); },
    (err) => toast("Could not load your why: " + friendly(err))
  );
  state.unsub?.();
  state.unsub = onSnapshot(
    collection(db, "users", uid, "days"),
    (snap) => {
      const m = new Map();
      snap.forEach((d) => m.set(d.id, d.data()));
      state.days = m;
      render();
    },
    (err) => toast("Could not load data: " + friendly(err))
  );
}

/* ---------- writes (Firestore queues them offline and syncs later) ---------- */
function writeDay(date, data) {
  const now = new Date().toISOString();
  const existing = state.days.get(date);
  const ref = doc(db, "users", state.user.uid, "days", date);
  return setDoc(ref, {
    date,
    ...data,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }).catch((err) => toast("Save failed: " + friendly(err)));
}

async function answerGood(btn, date) {
  const existing = state.days.get(date);
  if (existing?.result === "bad" && !confirm("Change this day to good? Its saved reasons will be removed.")) return;
  btn?.classList.add("burst");
  writeDay(date, { result: "good", approxTime: null, chain: [], rootCause: "" });
  state.editingToday = false;
  toast("Energy saved. Beautiful. ✨");
}

/* ---------- bad-day flow (time, then the chain of whys) ---------- */
function openBad(date) {
  Object.assign(flow, { date, time: "unknown", chain: [], step: "time" });
  $("#modal").hidden = false;
  renderFlow();
}

function closeModal() {
  $("#modal").hidden = true;
  $("#modalBody").innerHTML = "";
}

function renderFlow() {
  const body = $("#modalBody");
  if (flow.step === "time") {
    body.innerHTML = `
      <p class="eyebrow">Bad day · step 1 of 2</p>
      <h2>Roughly what time did it happen?</h2>
      <p class="sub">An approximate time is enough.</p>
      <form id="timeForm" class="stack">
        <input id="timeInput" class="input" type="time" />
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-act="cancel">Cancel</button>
          <span class="spacer"></span>
          <button type="button" class="btn ghost" data-act="time-skip">Not sure</button>
          <button class="btn bad" type="submit">Next</button>
        </div>
      </form>`;
    return;
  }

  const level = flow.chain.length + 1;
  const question = flow.chain.length === 0 ? WHY_FIRST : WHY_NEXT;
  body.innerHTML = `
    <p class="eyebrow">Digging for the root · level ${level}</p>
    ${trail(flow.chain)}
    <h2>${question}</h2>
    <form id="whyForm" class="stack">
      ${causePicker()}
      <textarea id="whyInput" class="input" rows="3" placeholder="Be honest. Write what was really going on." required></textarea>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-act="cancel">Cancel</button>
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-act="root" ${flow.chain.length ? "" : "disabled"}>I've hit the root cause</button>
        <button class="btn bad" type="submit">Next why</button>
      </div>
    </form>`;
  setTimeout(() => $("#whyInput")?.focus(), 60);
}

// Drop-down of the top root causes from Insights. Picking one fills the reason box below.
function causePicker() {
  const causes = rankCauses([...state.days.values()].filter((e) => e.result === "bad"));
  if (!causes.length) return "";
  return `
    <select id="causePick" class="input" aria-label="Pick a common root cause">
      <option value="">Pick a common root cause…</option>
      ${causes.map((c) => `<option value="${esc(c.text)}">${esc(c.text)} (${c.n}×)</option>`).join("")}
    </select>`;
}

function finishBad() {
  const pending = $("#whyInput")?.value.trim();
  if (pending) flow.chain.push({ q: flow.chain.length ? WHY_NEXT : WHY_FIRST, a: pending });
  const last = flow.chain[flow.chain.length - 1];
  if (!last) return;
  writeDay(flow.date, { result: "bad", approxTime: flow.time, chain: flow.chain, rootCause: last.a });
  closeModal();
  state.editingToday = false;
  toast("Logged with its root cause. Awareness is the first alchemy. 🔥");
}

/* ---------- views ---------- */
function answers(k) {
  return `
    <div class="answers">
      <button class="answer good" type="button" data-act="good" data-date="${k}">
        <span class="big">Good</span>
      </button>
      <button class="answer bad" type="button" data-act="bad" data-date="${k}">
        <span class="big">Bad</span>
      </button>
    </div>`;
}

function statusCard(e) {
  const good = e.result === "good";
  return `
    <div class="status ${good ? "good" : "bad"}">
      <div>
        <span class="big">${good ? "Good day" : "Bad day"}</span>
        ${good
          ? `<p>Energy saved. Keep building.</p>`
          : `<p>Time: ${esc(fmtTime(e.approxTime))}</p><p>Root cause: ${esc(e.rootCause || "—")}</p>`}
      </div>
      <button class="btn ghost" type="button" data-act="edit">Change answer</button>
    </div>`;
}

function weekStrip() {
  const cells = [];
  // today first on the left, then the six days before it
  for (let i = 0; i <= 6; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = keyOf(d);
    const e = state.days.get(k);
    const wd = parseKey(k).toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2);
    cells.push(`<div class="wd ${e ? e.result : ""} ${k === todayKey() ? "today" : ""}"><span>${esc(wd)}</span><i title="${fmtShort(k)}"></i></div>`);
  }
  return `<div class="week">${cells.join("")}</div>`;
}

// The day the Today card is about. It is the day after the latest logged day before today,
// so an unlogged yesterday stays on screen until it is logged. Once that is done, it moves on,
// and finally shows today.
function pendingKey() {
  const tk = todayKey();
  let anchor = null;
  for (const k of state.days.keys()) if (k < tk && (!anchor || k > anchor)) anchor = k;
  if (!anchor) return tk;
  const next = keyOf(addDays(parseKey(anchor), 1));
  return next <= tk ? next : tk;
}

function viewToday() {
  const k = pendingKey();
  const isToday = k === todayKey();
  const e = state.days.get(k);
  const s = stats();
  const showAnswers = !e || state.editingToday;
  const cancelEdit = state.editingToday ? `<button class="link" type="button" data-act="cancel-edit">Cancel</button>` : "";
  return `
    <div class="today-layout">
      <section class="card">
        <p class="eyebrow">${esc(fmtLong(parseKey(k)))}${isToday ? "" : " · not logged yet"}</p>
        <h2 class="question">${isToday ? "Did you save your life energy today?" : "Did you save your life energy that day?"}</h2>
        <p class="sub">Good means you saved your life-giving energy. Bad means you watched porn or released your life-giving energy. Either way, be honest here.</p>
        ${showAnswers ? answers(k) + cancelEdit : statusCard(e)}
      </section>
      <section class="stack">
        <div class="stat-grid">
          <div class="stat gold"><div class="num">${s.cur}</div><div class="lbl">Current streak</div></div>
          <div class="stat gold"><div class="num">${s.best}</div><div class="lbl">Best streak</div></div>
          <div class="stat g"><div class="num">${s.good}</div><div class="lbl">Good days</div></div>
          <div class="stat b"><div class="num">${s.bad}</div><div class="lbl">Bad days</div></div>
        </div>
        <section class="card">
          <h3>Last 7 days</h3>
          ${weekStrip()}
        </section>
      </section>
    </div>`;
}

function dayDetail(k) {
  const e = state.days.get(k);
  const actions = `
    <div class="row wrap">
      <button class="btn good-btn" type="button" data-act="good" data-date="${k}">Mark good</button>
      <button class="btn bad-btn" type="button" data-act="bad" data-date="${k}">Mark bad</button>
      ${e ? `<button class="btn ghost" type="button" data-act="delete" data-date="${k}">Delete</button>` : ""}
    </div>`;
  if (!e) return `<p class="eyebrow">${fmtShort(k)}</p><h3>No entry for this day</h3>${actions}`;
  if (e.result === "good") return `<p class="eyebrow">${fmtShort(k)}</p><h3 class="h-good">Good day</h3>${actions}`;
  return `
    <p class="eyebrow">${fmtShort(k)}</p>
    <h3 class="h-bad">Bad day · ${esc(fmtTime(e.approxTime))}</h3>
    ${trail(e.chain)}
    <p class="root"><b>Root cause:</b> ${esc(e.rootCause || "—")}</p>
    ${actions}`;
}

function viewCalendar() {
  const y = state.month.getFullYear();
  const m = state.month.getMonth();
  const offset = (new Date(y, m, 1).getDay() + 6) % 7; // Monday first
  const n = new Date(y, m + 1, 0).getDate();
  const today = todayKey();

  let cells = "";
  for (let i = 0; i < offset; i++) cells += `<span class="cell blank"></span>`;
  for (let d = 1; d <= n; d++) {
    const k = `${y}-${pad(m + 1)}-${pad(d)}`;
    const e = state.days.get(k);
    const cls = [e ? e.result : "", k === today ? "today" : "", state.selected === k ? "sel" : ""].join(" ");
    cells += `<button class="cell ${cls}" type="button" data-pick="${k}" aria-label="${fmtShort(k)}">${d}</button>`;
  }

  const detail = state.selected ? dayDetail(state.selected) : `<p class="sub">Tap a day to see it, or to fix it.</p>`;
  const title = new Date(y, m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return `
    <div class="cal-layout">
      <section class="card">
        <div class="cal-head">
          <button class="icon-btn" type="button" data-act="prev" aria-label="Previous month">‹</button>
          <h2>${esc(title)}</h2>
          <button class="icon-btn" type="button" data-act="next" aria-label="Next month">›</button>
        </div>
        <div class="weekdays">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => `<span>${w}</span>`).join("")}</div>
        <div class="cal">${cells}</div>
        <div class="legend"><span class="dot good"></span>Good<span class="dot bad"></span>Bad</div>
      </section>
      <section class="card">${detail}</section>
    </div>`;
}

/* ---------- insights ---------- */
const WEEKDAYS_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const GRACE_DAYS = 2;   // an unlogged day counts as "not logged" only once it is this many days old
const RECENT_N = 3;
// Causes left out of Top root causes (the data stays; only the list hides them).
const HIDDEN_CAUSES = new Set(["Relapse, no trigger noted", "Unclear note", "Heavy lunch", "Sleeping in the evening"]);     // lists show this many; the rest sit behind a dropdown
// Very similar causes that are shown as one line (in Top root causes and in the reason picker).
// The count is the number of bad days that had any of them.
const CAUSE_GROUPS = [
  { label: "Triggering movies, shows or sexual content", members: ["Triggering movies or shows", "Sexual content (soft porn, nudes, erotic dream)"] },
  { label: "Intrusive thoughts or compulsive urges", members: ["Intrusive thoughts (past love)", "Compulsive urge"] },
];
const GROUP_OF = new Map(CAUSE_GROUPS.flatMap((g) => g.members.map((m) => [m.toLowerCase(), g.label])));
// A cause that is no longer shown: each time it is logged, it counts toward these causes instead.
const EXTRA_COUNTS = [
  { match: /slept in the noon/i, labels: ["Noon nap", "Sleep disruption (can't sleep, woke early)"] },
];

// Ranks causes across the given bad days, most days first.
// Buckets for reasons written in free text. Checked in this order; the first match wins.
// A reason that matches none of them stays as it was written.
const BUCKET_RULES = [
  [/nsfw browsing/i, "Casual NSFW browsing"],
  [/sexual|movie|shows?\b|nsfw|porn|nude|erotic/i, "Triggering movies, shows or sexual content"],
  [/triggering person|person/i, "Triggering person (in person or online)"],
  [/divert/i, "Didn't divert at first thought"],
  [/urge|intrusive|thought/i, "Intrusive thoughts or compulsive urges"],
  [/sleep|woke|asleep/i, "Sleep disruption (can't sleep, woke early)"],
  [/\bnap\b/i, "Noon nap"],
  [/late-night|screen|laptop/i, "Late-night screens (laptop, blue light)"],
  [/phone|scroll|web/i, "Phone or web scrolling"],
  [/idle|lying|lazy|laziness|lazily|\bbed\b/i, "Idle time or lying on bed"],
  [/mood|dysphoria|frustrat/i, "Low mood (dysphoria, frustration)"],
  [/practice|mantra|japa/i, "Skipped practice (mantra, japa, simulations)"],
];
const bucketOf = (t) => (BUCKET_RULES.find(([re]) => re.test(t)) || [null, t])[1];

// Words that do not say what a cause is about. Used to find causes that are worded alike.
const CAUSE_STOP = new Set(["the", "and", "was", "were", "with", "for", "that", "this", "from", "into", "about", "just", "some", "very", "lot", "something", "not", "but", "when", "then", "had", "have", "got", "out", "after", "before", "on", "in", "at", "of", "to", "a", "an", "i", "my", "me", "it", "is", "be", "or", "so", "as", "by", "up", "did", "do", "didn", "there", "also"]);
const causeWords = (t) => new Set(t.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
  .filter((w) => w.length > 2 && !CAUSE_STOP.has(w))
  .map((w) => w.replace(/(ing|ed|es|s)$/, "")));
// Two causes are merged when at least half of their words (ignoring small words) match.
const alike = (a, b) => {
  const shared = [...a].filter((w) => b.has(w)).length;
  const all = new Set([...a, ...b]).size;
  return all > 0 && shared / all >= 0.5;
};

// Ranks causes across the given bad days, most days first. Similar causes are merged into one entry,
// which is named after its most frequent member and counts every day that had any of them.
function rankCauses(list) {
  const found = new Map(); // lowercase label -> { text, days }
  list.forEach((e, day) => {
    // Every reason logged on a day counts: the causes list, each "why" answer, and the root cause.
    const raw = [...(Array.isArray(e.causes) ? e.causes : []), ...(e.chain || []).map((s) => s.a), e.rootCause];
    const names = new Map();
    // A reason that lists several causes separated by ";" is split into its parts.
    raw.flatMap((c) => (c || "").split(";")).map((c) => c.trim()).filter((c) => c && !HIDDEN_CAUSES.has(c)).forEach((t) => {
      const extra = EXTRA_COUNTS.find((x) => x.match.test(t));
      if (extra) { extra.labels.forEach((l) => names.set(l.toLowerCase(), l)); return; }
      const label = GROUP_OF.get(t.toLowerCase()) || bucketOf(t);
      names.set(label.toLowerCase(), label);
    });
    names.forEach((text, k) => {
      const f = found.get(k) || { text, days: new Set() };
      f.days.add(day);
      found.set(k, f);
    });
  });

  const merged = [];
  [...found.values()].sort((a, b) => b.days.size - a.days.size).forEach((f) => {
    const words = causeWords(f.text);
    const into = merged.find((m) => alike(m.words, words));
    if (into) { f.days.forEach((d) => into.days.add(d)); return; }
    merged.push({ text: f.text, words, days: new Set(f.days) });
  });
  return merged.map((m) => ({ text: m.text, n: m.days.size })).sort((a, b) => b.n - a.n);
}
// Past slips logged without a time are spread over the day like this. Slips from today on go to Night.
const PAST_UNKNOWN_SPLIT = { Night: 0.55, Morning: 0.25, Afternoon: 0.1, Evening: 0.1 };

const dayDiff = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 864e5);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtDM = (k) => parseKey(k).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const kpi = (n, label, cls = "") => `<div class="stat ${cls}"><div class="num">${n}</div><div class="lbl">${label}</div></div>`;

function summarize(list) {
  const total = list.length;
  const good = list.filter((e) => e.result === "good").length;
  return { total, good, bad: total - good, pct: total ? Math.round((good / total) * 100) : 0 };
}

// Runs of consecutive calendar days with the same result.
function runsOf(list, result) {
  const runs = [];
  let cur = null;
  for (const e of list) {
    if (e.result !== result) { if (cur) runs.push(cur); cur = null; continue; }
    if (cur && dayDiff(cur.end, e.date) === 1) { cur.end = e.date; cur.len++; }
    else { if (cur) runs.push(cur); cur = { start: e.date, end: e.date, len: 1 }; }
  }
  if (cur) runs.push(cur);
  const tk = todayKey();
  const yest = keyOf(addDays(new Date(), -1));
  const todayLogged = state.days.has(tk);
  runs.forEach((r) => { r.active = r.end === tk || (r.end === yest && !todayLogged); });
  return runs;
}

// Counts calendar days from startKey to endKey (capped at today).
// Clean days are good, slip days are bad. An unlogged day is red once it is GRACE_DAYS old;
// newer unlogged days are left out, because there is still time to log them.
function tally(startKey, endKey) {
  const tk = todayKey();
  const end = endKey < tk ? endKey : tk;
  const t = { days: 0, good: 0, notLogged: 0 };
  for (let d = parseKey(startKey); keyOf(d) <= end; d = addDays(d, 1)) {
    const k = keyOf(d);
    const e = state.days.get(k);
    if (e) { t.days++; if (e.result === "good") t.good++; }
    else if (dayDiff(k, tk) >= GRACE_DAYS) { t.days++; t.notLogged++; }
  }
  return t;
}
const pctOf = (t) => (t.days ? `${((t.good / t.days) * 100).toFixed(1)}%` : "—");

// Full lists for the "Show more" popup, keyed by name. Filled in by viewInsights().
const listPopups = {};

// Shows the first RECENT_N items. "Show more" opens a popup with the whole list.
function previewList(key, title, items, render) {
  listPopups[key] = { title, html: items.map(render).join("") };
  const head = items.slice(0, RECENT_N).map(render).join("");
  return `<ul class="entries">${head}</ul>${items.length > RECENT_N
    ? `<button type="button" class="btn ghost more-btn" data-act="open-list" data-list="${key}">Show more (${items.length - RECENT_N})</button>`
    : ""}`;
}

function openList(key) {
  const p = listPopups[key];
  if (!p) return;
  $("#modalBody").innerHTML = `
    <h3>${esc(p.title)}</h3>
    <ul class="entries scroll">${p.html}</ul>
    <div class="modal-actions"><button type="button" class="btn ghost" data-act="close-list">Close</button></div>`;
  $("#modal").hidden = false;
}

/* ---------- progress chart: good rate per day / week / month / year, or cumulative ---------- */
const GRANS = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"]];

function mondayOf(d) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function periodKeyOf(d, gran) {
  const k = keyOf(d);
  if (gran === "day") return k;
  if (gran === "week") return keyOf(mondayOf(d));
  if (gran === "month") return k.slice(0, 7);
  return k.slice(0, 4);
}

function periodLabel(key, gran) {
  if (gran === "day") return fmtShort(key);
  if (gran === "week") return `Week of ${fmtShort(key)}`;
  if (gran === "month") {
    const [y, m] = key.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  return key;
}

function shortLabel(key, gran) {
  if (gran === "day" || gran === "week") return parseKey(key).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (gran === "month") {
    const [y, m] = key.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  return key;
}

// One bucket per period, from the start of the first logged period up to today.
// Each calendar day counts toward its period. A day that is not logged as good is red,
// except unlogged days that are still within GRACE_DAYS (those are left out).
function buildSeries(gran) {
  const keys = [...state.days.keys()].sort();
  if (!keys.length) return [];
  const first = parseKey(keys[0]);
  const start = gran === "day" ? first
    : gran === "week" ? mondayOf(first)
    : gran === "month" ? new Date(first.getFullYear(), first.getMonth(), 1)
    : new Date(first.getFullYear(), 0, 1);
  const tk = todayKey();
  const map = new Map();
  for (let d = new Date(start); keyOf(d) <= tk; d = addDays(d, 1)) {
    const k = keyOf(d);
    const e = state.days.get(k);
    if (!e && dayDiff(k, tk) < GRACE_DAYS) continue;
    const pk = periodKeyOf(d, gran);
    if (!map.has(pk)) map.set(pk, { key: pk, days: 0, good: 0 });
    const s = map.get(pk);
    s.days++;
    if (e?.result === "good") s.good++;
  }
  return [...map.values()];
}

// Catmull-Rom through the points, converted to cubic Bezier segments: a smooth curve.
function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

// Straight segments: used for daily pulses so each day stays at 0% or 100%.
function linePath(pts) {
  return pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
}

function progressCard() {
  const gran = state.chartGran;
  const cum = state.chartMode === "cum";
  const series = buildSeries(gran);

  const toggles = `
    <div class="chart-head">
      <div class="seg">${GRANS.map(([g, label]) =>
        `<button type="button" class="seg-btn ${g === gran ? "active" : ""}" data-gran="${g}">${label}</button>`).join("")}</div>
      <div class="seg">
        <button type="button" class="seg-btn ${!cum ? "active" : ""}" data-cmode="period">Per period</button>
        <button type="button" class="seg-btn ${cum ? "active" : ""}" data-cmode="cum">Cumulative</button>
      </div>
    </div>`;

  if (series.length < 2) {
    return `<section class="card wide"><h3>Green/Good Rate</h3>${toggles}<p class="sub">Need at least two periods of data to draw the chart.</p></section>`;
  }

  // values in percent
  let values;
  if (cum) {
    let g = 0, d = 0;
    values = series.map((s) => { g += s.good; d += s.days; return d ? (g / d) * 100 : 0; });
  } else {
    // Day: each day is 100 (clean) or 0. Week, month, year: clean days as a share of the period.
    values = series.map((s) => (s.days ? (s.good / s.days) * 100 : 0));
  }

  const W = 600, H = 240, L = 40, R = 14, T = 16, B = 30;
  const n = values.length;
  const x = (i) => L + (i * (W - L - R)) / (n - 1);
  const y = (v) => T + (1 - v / 100) * (H - T - B);
  const pts = values.map((v, i) => [x(i), y(v)]);
  const line = gran === "day" && !cum ? linePath(pts) : smoothPath(pts);
  const area = `${line} L${x(n - 1).toFixed(1)} ${H - B} L${x(0).toFixed(1)} ${H - B} Z`;
  const grid = [0, 50, 100].map((v) =>
    `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid-line"/>` +
    `<text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" class="axis-label" text-anchor="end">${v}%</text>`).join("");
  const dots = n <= 60
    ? pts.map(([px, py], i) => `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.4" class="dot-pt"><title>${esc(periodLabel(series[i].key, gran))}: ${values[i].toFixed(1)}%</title></circle>`).join("")
    : "";
  const xLabels = `
    <text x="${x(0).toFixed(1)}" y="${H - 8}" class="axis-label" text-anchor="start">${esc(shortLabel(series[0].key, gran))}</text>
    <text x="${x(n - 1).toFixed(1)}" y="${H - 8}" class="axis-label" text-anchor="end">${esc(shortLabel(series[n - 1].key, gran))}</text>`;

  const last = values[n - 1];
  const note = cum
    ? "Cumulative green/good rate from the first logged period to now. Unlogged days count as red once they are two days old."
    : gran === "day"
      ? "Each day is a pulse: 100% if it was clean, 0% if not. Unlogged days count as red once they are two days old."
      : `Clean days as a share of each ${gran}. Unlogged days count as red once they are two days old; the current ${gran} counts days so far.`;

  return `
    <section class="card wide">
      <div class="chart-title">
        <h3>${cum ? "Cumulative" : "Green/Good Rate"} · by ${gran}</h3>
        <b class="chart-now">${last.toFixed(1)}%</b>
      </div>
      ${toggles}
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${cum ? "Cumulative" : "Green/Good Rate"} by ${gran}">
        <defs>
          <linearGradient id="progFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="#ffe08a" stop-opacity=".55"/>
            <stop offset="1" stop-color="#ffe08a" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${grid}
        <path d="${area}" fill="url(#progFill)"/>
        <path d="${line}" fill="none" stroke="#ffd77a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        ${dots}
        ${xLabels}
      </svg>
      <p class="sub">${note}</p>
    </section>`;
}

// Column chart of the top root causes, largest first. The x-axis is the rank (the names are too long);
// hovering or tapping a column shows its cause in the line above the chart. The y-axis is the number of days.
function causeBars(list) {
  const max = Math.max(1, ...list.map((c) => c.n));
  const pct = (v) => Math.round((v / max) * 100); // 0 to 100, scaled to the tallest bar
  const ticks = [...new Set([max, Math.round(max / 2), 0])];
  const grid = ticks.map((v) => `<i class="cc-grid" style="--p:${pct(v)}"></i><span class="cc-y" style="--p:${pct(v)}">${v}</span>`).join("");
  // Shades of red: the most frequent cause is the darkest, the least frequent the lightest.
  const shade = (i) => (list.length > 1 ? 34 + (i / (list.length - 1)) * 46 : 34);
  const cols = list.map((c, i) => `
    <button type="button" class="col" data-name="${esc(c.text)}" data-n="${c.n}" style="--h:${pct(c.n)};--d:${i * 90}ms;--l:${shade(i).toFixed(0)}%" aria-label="${esc(c.text)}: ${c.n} time${c.n > 1 ? "s" : ""}">
      <span class="col-bar"></span>
      <span class="col-val">${c.n}</span>
      <span class="col-tip">${esc(c.text)}<small>${c.n} time${c.n > 1 ? "s" : ""}</small></span>
    </button>`).join("");
  const names = list.map((c) => `<span class="cc-name" title="${esc(c.text)}">${esc(c.text)}</span>`).join("");
  return `
    <p id="causeInfo" class="cc-info">Hover or tap a bar to see its root cause.</p>
    <div class="cc">
      <div class="cc-body">
        <span class="cc-ytitle">Times</span>
        <div class="cc-area">${grid}${cols}</div>
        <div class="cc-names">${names}</div>
      </div>
    </div>`;
}

function viewInsights() {
  const entries = [...state.days.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!entries.length) {
    return `<section class="card"><h3>No data yet</h3><p class="sub">Insights appear here after your first logged day.</p></section>`;
  }

  const now = new Date();
  const tk = todayKey();
  const yr = String(now.getFullYear());
  const mo = tk.slice(0, 7);
  const moLabel = now.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const all = summarize(entries);
  const ySum = summarize(entries.filter((e) => e.date.startsWith(yr)));
  const mSum = summarize(entries.filter((e) => e.date.startsWith(mo)));
  const yT = tally(`${yr}-01-01`, tk);
  const mT = tally(`${mo}-01`, tk);

  // Clean streaks only.
  const goodRuns = runsOf(entries, "good");
  const curGood = goodRuns.find((r) => r.active)?.len ?? 0;
  const topStreaks = [...goodRuns].sort((a, b) => b.len - a.len || b.start.localeCompare(a.start)).slice(0, 10);
  const recentStreaks = [...goodRuns].sort((a, b) => b.start.localeCompare(a.start));
  const streakRow = (r) => `
    <li class="row-line">
      <b>${r.len} day${r.len > 1 ? "s" : ""}</b>
      <span>${fmtDM(r.start)} → ${fmtDM(r.end)}</span>
      ${r.active ? `<span class="tag">current</span>` : ""}
    </li>`;

  // Slips by time of day. Slips without a time: past ones are spread by PAST_UNKNOWN_SPLIT, today's and later go to Night.
  const badEntries = entries.filter((e) => e.result === "bad");
  const timeCounts = { Morning: 0, Afternoon: 0, Evening: 0, Night: 0 };
  badEntries.forEach((e) => {
    const b = bucket(e.approxTime);
    if (b !== "Unknown") { timeCounts[b]++; return; }
    if (e.date < tk) Object.entries(PAST_UNKNOWN_SPLIT).forEach(([k, w]) => { timeCounts[k] += w; });
    else timeCounts.Night++;
  });
  const tMax = Math.max(1, ...Object.values(timeCounts));
  const timeBars = Object.keys(timeCounts).map((b) => `
    <div class="bar-row"><span>${b}</span><div class="bar"><i style="width:${(timeCounts[b] / tMax) * 100}%"></i></div><b>${Math.round(timeCounts[b])}</b></div>`).join("");

  const wd = Array.from({ length: 7 }, () => ({ good: 0, bad: 0 }));
  entries.forEach((e) => { wd[(parseKey(e.date).getDay() + 6) % 7][e.result]++; });
  const wdMax = Math.max(1, ...wd.map((w) => w.bad));
  const wdBars = wd.map((w, i) => `
    <div class="bar-row"><span>${WEEKDAYS_FULL[i].slice(0, 3)}</span><div class="bar"><i style="width:${(w.bad / wdMax) * 100}%"></i></div><b>${w.bad}/${w.good + w.bad}</b></div>`).join("");

  const topCauses = rankCauses(badEntries);
  const causeRows = topCauses.map((c) => `<li class="row-line cause-row"><span>${esc(c.text)}</span><b>${c.n}×</b></li>`).join("");
  const avgDepth = badEntries.length
    ? (badEntries.reduce((x, e) => x + (e.chain?.length || 0), 0) / badEntries.length).toFixed(1)
    : "—";

  // Month by month: percentage only. Current month counts days so far.
  const tm = tk.slice(0, 7);
  const [fy, fm] = entries[0].date.split("-").map(Number);
  const monthKeys = [];
  for (let y = fy, m = fm; `${y}-${pad(m)}` <= tm;) {
    monthKeys.push(`${y}-${pad(m)}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  const monthRows = monthKeys.reverse().map((k) => {
    const [y, m] = k.split("-").map(Number);
    const isCur = k === tm;
    const t = tally(`${k}-01`, isCur ? tk : keyOf(new Date(y, m, 0)));
    const label = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    return `
      <li class="row-line">
        <b>${esc(label)}${isCur ? " (so far)" : ""}</b>
        <span>${pctOf(t)}</span>
      </li>`;
  }).join("");

  // Year by year: percentage only. Current year counts days so far.
  const firstYear = Number(entries[0].date.slice(0, 4));
  const curYear = now.getFullYear();
  const yearRows = [];
  for (let y = curYear; y >= firstYear; y--) {
    const ys = String(y);
    const t = tally(`${ys}-01-01`, y === curYear ? tk : `${ys}-12-31`);
    yearRows.push(`
      <li class="row-line">
        <b>${ys}${y === curYear ? " (so far)" : ""}</b>
        <span>${pctOf(t)}</span>
      </li>`);
  }


  return `
    <div class="grid two">
      <section class="card wide">
        <h3>Overall</h3>
        <div class="stat-grid">
          ${kpi(all.total, "Days logged")}
          ${kpi(all.good, "Clean days", "g")}
          ${kpi(all.bad, "Slip days", "b")}
          ${kpi(all.pct + "%", "Green/Good Rate", "gold")}
        </div>
      </section>

      <section class="card">
        <h3>This year · ${yr}</h3>
        <div class="stat-grid">
          ${kpi(ySum.total, "Logged")}
          ${kpi(ySum.good, "Good", "g")}
          ${kpi(ySum.bad, "Bad", "b")}
          ${kpi(ySum.pct + "%", "Green/Good Rate", "gold")}
          ${kpi(yT.notLogged, "Not logged")}
        </div>
      </section>

      <section class="card">
        <h3>This month · ${moLabel}</h3>
        <div class="stat-grid">
          ${kpi(mSum.total, "Logged")}
          ${kpi(mSum.good, "Good", "g")}
          ${kpi(mSum.bad, "Bad", "b")}
          ${kpi(mSum.pct + "%", "Green/Good Rate", "gold")}
          ${kpi(mT.notLogged, "Not logged")}
        </div>
      </section>

      <section class="card wide">
        <h3>Top clean streaks</h3>
        <div class="stat-grid">
          ${kpi(curGood, "Current clean streak", "g")}
        </div>
        ${topStreaks.length ? previewList("top", "Top clean streaks", topStreaks, streakRow) : `<p class="sub">No clean streaks yet.</p>`}
      </section>

      ${progressCard()}

      <section class="card">
        <h3>All clean streaks (${goodRuns.length})</h3>
        ${goodRuns.length ? previewList("streaks", "All clean streaks", recentStreaks, streakRow) : `<p class="sub">No clean streaks yet.</p>`}
      </section>

      <section class="card">
        <h3>Month by month</h3>
        <ul class="entries scroll">${monthRows}</ul>
      </section>

      <section class="card">
        <h3>Year by year</h3>
        <ul class="entries">${yearRows.join("")}</ul>
      </section>

      <section class="card">
        <h3>When do slips happen?</h3>
        ${timeBars}
        <p class="sub">Average root-cause depth: ${avgDepth} "why" steps.</p>
      </section>

      <section class="card">
        <h3>Slips by weekday</h3>
        ${wdBars}
      </section>

      <section class="card">
        <h3>Top root causes</h3>
        ${causeRows ? `<ul class="entries">${causeRows}</ul>` : `<p class="sub">No root causes logged yet.</p>`}
      </section>

      <section class="card wide">
        <h3>Root causes chart</h3>
        ${topCauses.length ? causeBars(topCauses) : `<p class="sub">No root causes logged yet.</p>`}
      </section>
    </div>`;
}

const ICON = {"flame":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.8 1 2.8 2.5 3.5C11 8 11.5 5 12 2z\"/></svg>","calendar":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"3\"/><path d=\"M16 2v4M8 2v4M3 10h18\"/></svg>","chart":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M3 3v18h18\"/><path d=\"M7 15l4-4 3 3 5-6\"/></svg>","compass":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M16 8l-2.5 6.5L7 17l2.5-6.5z\"/></svg>","bolt":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M13 2L4 14h7l-1 8 9-12h-7z\"/></svg>","sun":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4\"/></svg>","arrow":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M5 12h14M13 6l6 6-6 6\"/></svg>"};

const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const ICON_SAVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

/* ---------- my why and my doomed life: view and edit modes, saved to your own space in Firestore ---------- */
// Older saves hold single strings (why, doomed) or plain-string triggers; these helpers read both shapes.
const whysOf = (r) => (Array.isArray(r.whys) ? r.whys : r.why ? [r.why] : []);
const doomsOf = (r) => (Array.isArray(r.dooms) ? r.dooms : r.doomed ? [r.doomed] : []);
const triggersOf = (r) => (r.triggers || []).map((x) => (typeof x === "string" ? { trigger: x, action: "" } : x));

// Grows a textarea to fit its text, so each block is only as tall as it needs to be.
const fit = (el) => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; };

// One separate block for a why or a doomed moment (edit mode).
function itemBlock(kind, text = "") {
  const ph = kind === "why" ? "Another reason why" : "Another doomed moment";
  return `
    <div class="item">
      <textarea class="field ${kind}-in" rows="1" placeholder="${ph}">${esc(text)}</textarea>
      <button type="button" class="row-remove" data-act="remove-row" aria-label="Remove">×</button>
    </div>`;
}

// A trigger row (edit mode): the trigger, an arrow, and what you will do about it. No labels: the headers say it.
function triggerRow(trigger = "", action = "") {
  return `
    <div class="trigger-row">
      <textarea class="field trigger-in" rows="1" placeholder="Trigger">${esc(trigger)}</textarea>
      <div class="arrow" aria-hidden="true">${ICON.arrow}</div>
      <textarea class="field action-in" rows="1" placeholder="What I will do">${esc(action)}</textarea>
      <button type="button" class="row-remove" data-act="remove-row" aria-label="Remove">×</button>
    </div>`;
}

function viewWhy() {
  const r = state.reflection || {};
  const edit = !!state.editingWhy;
  const whys = whysOf(r), dooms = doomsOf(r), triggers = triggersOf(r);
  const none = `<p class="sub">Nothing added yet.</p>`;
  const listView = (list) => list.length
    ? `<div class="item-list">${list.map((t) => `<div class="item-view">${esc(t)}</div>`).join("")}</div>`
    : none;
  const listEdit = (list, kind) => `<div id="${kind}List" class="item-list">${(list.length ? list : [""]).map((t) => itemBlock(kind, t)).join("")}</div>`;
  const trigView = triggers.length
    ? `<div class="trigger-list">${triggers.map((x) => `<div class="trigger-row tv-row"><div class="tv">${esc(x.trigger)}</div><div class="arrow" aria-hidden="true">${ICON.arrow}</div><div class="tv">${esc(x.action)}</div></div>`).join("")}</div>`
    : none;
  const trigEdit = `<div id="triggerRows" class="trigger-list">${(triggers.length ? triggers : [{ trigger: "", action: "" }]).map((x) => triggerRow(x.trigger, x.action)).join("")}</div>`;

  return `
    <div class="why-top">
      <button type="button" class="edit-btn${edit ? " on" : ""}" data-act="toggle-edit" aria-label="${edit ? "Save" : "Edit"}" title="${edit ? "Save" : "Edit"}">${edit ? ICON_SAVE : ICON_EDIT}</button>
    </div>

    <section class="card wide">
      <div class="sec-head"><span class="sec-icon">${ICON.compass}</span><h3>My Why</h3></div>
      ${edit
        ? listEdit(whys, "why") + `<button type="button" class="btn ghost add-btn" data-act="add-why">${ICON_PLUS}Add a why</button>`
        : listView(whys)}
    </section>

    <section class="card wide">
      <div class="sec-head"><span class="sec-icon">${ICON.bolt}</span><h3>My Triggers and Actions</h3></div>
      <div class="trigger-head"><span>Trigger</span><span>What I Will Do</span></div>
      ${edit ? trigEdit + `<button type="button" class="btn ghost add-btn" data-act="add-trigger">${ICON_PLUS}Add a trigger</button>` : trigView}
    </section>

    <section class="card wide">
      <div class="sec-head"><span class="sec-icon">${ICON.sun}</span><h3>My Doomed Life</h3></div>
      ${edit
        ? listEdit(dooms, "doom") + `<button type="button" class="btn ghost add-btn" data-act="add-doom">${ICON_PLUS}Add a doomed moment</button>`
        : listView(dooms)}
    </section>`;
}

function addItem(kind) {
  const list = $(`#${kind}List`);
  list.insertAdjacentHTML("beforeend", itemBlock(kind));
  const t = list.lastElementChild.querySelector("textarea");
  t.focus();
}

function addTriggerRow() {
  const list = $("#triggerRows");
  list.insertAdjacentHTML("beforeend", triggerRow());
  list.lastElementChild.querySelector("textarea").focus();
}

// The one edit button: first press opens edit mode, second press saves.
function toggleWhyEdit() {
  if (state.editingWhy) return saveReflection();
  state.editingWhy = true;
  render();
}

async function saveReflection() {
  const whys = [...document.querySelectorAll("#whyList .why-in")].map((t) => t.value.trim()).filter(Boolean);
  const dooms = [...document.querySelectorAll("#doomList .doom-in")].map((t) => t.value.trim()).filter(Boolean);
  const triggers = [...document.querySelectorAll("#triggerRows .trigger-row")]
    .map((row) => ({ trigger: row.querySelector(".trigger-in").value.trim(), action: row.querySelector(".action-in").value.trim() }))
    .filter((x) => x.trigger || x.action);
  try {
    await setDoc(doc(db, "users", state.user.uid, "profile", "reflection"),
      { whys, dooms, triggers, updatedAt: new Date().toISOString() }, { merge: true });
    state.editingWhy = false;
    toast("Saved.");
    render();
  } catch (err) {
    toast("Save failed: " + friendly(err));
  }
}

/* ---------- render ---------- */
function render() {
  if (!state.user) return;
  const v = $("#view");
  const first = state.user.displayName ? state.user.displayName.split(" ")[0] : "";
  $("#greeting").textContent = first ? `Welcome, ${first}` : "Keep the fire lit";
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  // Insights and My Why: every word starts with a capital letter (display only; the saved text is unchanged)
  v.classList.toggle("tc-view", state.tab === "insights" || state.tab === "why");
  if (state.tab === "why" && state.editingWhy && v.querySelector("#triggerRows")) return;
  v.innerHTML = state.tab === "calendar" ? viewCalendar()
    : state.tab === "insights" ? viewInsights()
    : state.tab === "why" ? viewWhy()
    : viewToday();
  if (state.tab === "why") v.querySelectorAll("textarea").forEach(fit);
  if (state.lastTab !== state.tab) {
    v.classList.remove("fade-in");
    void v.offsetWidth;
    v.classList.add("fade-in");
    state.lastTab = state.tab;
  }
}

/* ---------- events ---------- */
// Desktop browsers: popup (avoids the redirect loop). Installed PWA (standalone): redirect.
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

$("#signIn").addEventListener("click", async () => {
  try {
    await persistenceReady;
    if (isStandalone) {
      await signInWithRedirect(auth, provider);
    } else {
      await signInWithPopup(auth, provider);
    }
  } catch (err) {
    if (err?.code === "auth/popup-closed-by-user" || err?.code === "auth/cancelled-popup-request") return;
    toast(friendly(err));
  }
});

$("#signOutBtn").addEventListener("click", () => {
  if (confirm("Sign out of The Sexual Alchemist?")) signOut(auth);
});

$("#tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  state.tab = b.dataset.tab;
  state.selected = null;
  state.editingToday = false;
  render();
});

$("#view").addEventListener("click", (e) => {
  const t = e.target.closest("[data-act],[data-pick],[data-gran],[data-cmode]");
  if (!t) return;

  if (t.dataset.pick) {
    state.selected = t.dataset.pick;
    return render();
  }
  if (t.dataset.gran) {
    state.chartGran = t.dataset.gran;
    return render();
  }
  if (t.dataset.cmode) {
    state.chartMode = t.dataset.cmode;
    return render();
  }

  const act = t.dataset.act;
  const today = todayKey();
  const date = t.dataset.date || today;

  switch (act) {
    case "good":
      return answerGood(t, date);
    case "bad":
      t.classList.add("jump");
      setTimeout(() => openBad(date), 420);
      return;
    case "toggle-edit":
      return toggleWhyEdit();
    case "add-why":
      return addItem("why");
    case "add-doom":
      return addItem("doom");
    case "add-trigger":
      return addTriggerRow();
    case "remove-row":
      return t.closest(".item, .trigger-row")?.remove();
    case "open-list":
      return openList(t.dataset.list);
    case "edit":
      state.editingToday = true;
      return render();
    case "cancel-edit":
      state.editingToday = false;
      return render();
    case "prev":
    case "next":
      state.month = new Date(state.month.getFullYear(), state.month.getMonth() + (act === "next" ? 1 : -1), 1);
      state.selected = null;
      return render();
    case "delete":
      if (confirm("Delete this entry permanently?")) {
        deleteDoc(doc(db, "users", state.user.uid, "days", date))
          .then(() => toast("Entry deleted"))
          .catch((err) => toast(friendly(err)));
        state.selected = null;
      }
      return;
  }
});

$("#modal").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "cancel") closeModal();
  if (act === "time-skip") { flow.time = "unknown"; flow.step = "why"; renderFlow(); }
  if (act === "root") finishBad();
  if (act === "close-list") closeModal();
});

$("#modal").addEventListener("change", (e) => {
  if (e.target.id !== "causePick" || !e.target.value) return;
  const box = $("#whyInput");
  box.value = e.target.value;
  box.focus();
});

$("#modal").addEventListener("submit", (e) => {
  e.preventDefault();
  if (e.target.id === "timeForm") {
    flow.time = $("#timeInput").value || "unknown";
    flow.step = "why";
    renderFlow();
  } else if (e.target.id === "whyForm") {
    const a = $("#whyInput").value.trim();
    if (!a) return;
    flow.chain.push({ q: flow.chain.length ? WHY_NEXT : WHY_FIRST, a });
    renderFlow();
  }
});

// Root causes chart: hovering or tapping a column names its cause.
$("#view").addEventListener("pointerout", (e) => {
  // Mouse only: when the pointer leaves a bar, its tooltip goes away. (Touch keeps the tapped bar selected.)
  const c = e.target.closest(".col");
  if (c && e.pointerType === "mouse" && !c.contains(e.relatedTarget)) c.classList.remove("on");
});

$("#view").addEventListener("pointerover", (e) => {
  const c = e.target.closest(".col");
  const info = $("#causeInfo");
  if (!c || !info) return;
  document.querySelectorAll("#view .col.on").forEach((x) => x.classList.remove("on"));
  c.classList.add("on");
  const n = Number(c.dataset.n);
  const b = document.createElement("b");
  b.textContent = c.dataset.name;
  info.replaceChildren(b, document.createTextNode(` · ${n} day${n > 1 ? "s" : ""}`));
});

$("#view").addEventListener("input", (e) => { if (e.target.tagName === "TEXTAREA") fit(e.target); });

// Text areas fit their content again when the width changes (for example, rotating the phone).
window.addEventListener("resize", () => document.querySelectorAll("#view textarea").forEach(fit));
