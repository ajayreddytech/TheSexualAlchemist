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
    state.days = new Map();
  }
  render();
});

function subscribe(uid) {
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
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = keyOf(d);
    const e = state.days.get(k);
    const wd = parseKey(k).toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2);
    cells.push(`<div class="wd ${e ? e.result : ""} ${k === todayKey() ? "today" : ""}"><span>${esc(wd)}</span><i title="${fmtShort(k)}"></i></div>`);
  }
  return `<div class="week">${cells.join("")}</div>`;
}

function viewToday() {
  const k = todayKey();
  const e = state.days.get(k);
  const s = stats();
  const showAnswers = !e || state.editingToday;
  const cancelEdit = state.editingToday ? `<button class="link" type="button" data-act="cancel-edit">Cancel</button>` : "";
  return `
    <div class="today-layout">
      <section class="card">
        <p class="eyebrow">${esc(fmtLong(new Date()))}</p>
        <h2 class="question">Did you save your life energy today?</h2>
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

const dayDiff = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 864e5);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

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

function groupBy(list, fn) {
  const m = new Map();
  list.forEach((e) => { const k = fn(e); if (!m.has(k)) m.set(k, []); m.get(k).push(e); });
  return m;
}

const kpi = (n, label, cls = "") => `<div class="stat ${cls}"><div class="num">${n}</div><div class="lbl">${label}</div></div>`;
const rowLine = (label, s) => `
  <li class="row-line">
    <b>${esc(label)}</b>
    <span>${s.total} logged</span>
    <span class="h-good">${s.good} good</span>
    <span class="h-bad">${s.bad} bad</span>
    <span>${s.pct}%</span>
  </li>`;

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
// Every calendar day counts toward its period. A day that is not logged as good is red.
function buildSeries(gran) {
  const keys = [...state.days.keys()].sort();
  if (!keys.length) return [];
  const first = parseKey(keys[0]);
  const start = gran === "day" ? first
    : gran === "week" ? mondayOf(first)
    : gran === "month" ? new Date(first.getFullYear(), first.getMonth(), 1)
    : new Date(first.getFullYear(), 0, 1);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const map = new Map();
  for (let d = new Date(start); d <= today; d = addDays(d, 1)) {
    const pk = periodKeyOf(d, gran);
    if (!map.has(pk)) map.set(pk, { key: pk, days: 0, good: 0 });
    const s = map.get(pk);
    s.days++;
    if (state.days.get(keyOf(d))?.result === "good") s.good++;
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
    return `<section class="card wide"><h3>Good rate</h3>${toggles}<p class="sub">Need at least two periods of data to draw the chart.</p></section>`;
  }

  // values in percent
  let values;
  if (cum) {
    let g = 0, d = 0;
    values = series.map((s) => { g += s.good; d += s.days; return d ? (g / d) * 100 : 0; });
  } else if (gran === "day") {
    values = series.map((_, i) => {
      const win = series.slice(Math.max(0, i - 6), i + 1);
      const days = win.reduce((a, s) => a + s.days, 0);
      const good = win.reduce((a, s) => a + s.good, 0);
      return days ? (good / days) * 100 : 0;
    });
  } else {
    values = series.map((s) => (s.days ? (s.good / s.days) * 100 : 0));
  }

  const W = 600, H = 240, L = 40, R = 14, T = 16, B = 30;
  const n = values.length;
  const x = (i) => L + (i * (W - L - R)) / (n - 1);
  const y = (v) => T + (1 - v / 100) * (H - T - B);
  const pts = values.map((v, i) => [x(i), y(v)]);
  const line = smoothPath(pts);
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
    ? "Cumulative good rate from the first logged period to now. Unlogged days count as red."
    : gran === "day"
      ? "Good rate over the last 7 days, day by day. Unlogged days count as red."
      : `Good rate of each ${gran}. Unlogged days count as red; the current ${gran} counts days so far.`;

  return `
    <section class="card wide">
      <div class="chart-title">
        <h3>${cum ? "Cumulative" : "Good rate"} · by ${gran}</h3>
        <b class="chart-now">${last.toFixed(1)}%</b>
      </div>
      ${toggles}
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${cum ? "Cumulative" : "Good rate"} by ${gran}">
        <defs>
          <linearGradient id="progFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="#ffe08a" stop-opacity=".55"/>
            <stop offset="1" stop-color="#ffe08a" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${grid}
        <path d="${area}" fill="url(#progFill)"/>
        <path d="${line}" fill="none" stroke="#ffd77a" stroke-width="3" stroke-linecap="round"/>
        ${dots}
        ${xLabels}
      </svg>
      <p class="sub">${note}</p>
    </section>`;
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
  const elapsedYear = dayDiff(`${yr}-01-01`, tk) + 1;
  const elapsedMonth = now.getDate();

  const goodRuns = runsOf(entries, "good");
  const badRuns = runsOf(entries, "bad");
  const curGood = goodRuns.find((r) => r.active)?.len ?? 0;
  const curBad = badRuns.find((r) => r.active)?.len ?? 0;
  const goodLens = goodRuns.map((r) => r.len);
  const badLens = badRuns.map((r) => r.len);
  const maxOf = (a) => (a.length ? Math.max(...a) : 0);
  const minOf = (a) => (a.length ? Math.min(...a) : 0);

  const badDates = entries.filter((e) => e.result === "bad").map((e) => e.date);
  const gaps = badDates.slice(1).map((d, i) => dayDiff(badDates[i], d) - 1);
  const avgGap = gaps.length ? (gaps.reduce((x, y) => x + y, 0) / gaps.length).toFixed(1) : "—";

  const badEntries = entries.filter((e) => e.result === "bad");
  const buckets = ["Morning", "Afternoon", "Evening", "Night", "Unknown"];
  const bucketCounts = Object.fromEntries(buckets.map((b) => [b, 0]));
  badEntries.forEach((d) => bucketCounts[bucket(d.approxTime)]++);
  const bMax = Math.max(1, ...Object.values(bucketCounts));
  const timeBars = buckets.map((b) => `
    <div class="bar-row"><span>${b}</span><div class="bar"><i style="width:${(bucketCounts[b] / bMax) * 100}%"></i></div><b>${bucketCounts[b]}</b></div>`).join("");

  const wd = Array.from({ length: 7 }, () => ({ good: 0, bad: 0 }));
  entries.forEach((e) => { wd[(parseKey(e.date).getDay() + 6) % 7][e.result]++; });
  const wdMax = Math.max(1, ...wd.map((w) => w.bad));
  const wdBars = wd.map((w, i) => `
    <div class="bar-row"><span>${WEEKDAYS_FULL[i].slice(0, 3)}</span><div class="bar"><i style="width:${(w.bad / wdMax) * 100}%"></i></div><b>${w.bad}/${w.good + w.bad}</b></div>`).join("");

  const causeMap = new Map();
  badEntries.forEach((e) => {
    const t = (e.rootCause || "").trim();
    if (!t) return;
    const k = t.toLowerCase();
    const c = causeMap.get(k) || { text: t, n: 0 };
    c.n++;
    causeMap.set(k, c);
  });
  const topCauses = [...causeMap.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  const causeRows = topCauses.map((c) => `<li class="row-line"><span>${esc(c.text)}</span><b>${c.n}×</b></li>`).join("");
  const avgDepth = badEntries.length
    ? (badEntries.reduce((x, e) => x + (e.chain?.length || 0), 0) / badEntries.length).toFixed(1)
    : "—";

  const monthRows = [...groupBy(entries, (e) => e.date.slice(0, 7))]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([k, list]) => {
      const [y, m] = k.split("-").map(Number);
      return rowLine(new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }), summarize(list));
    }).join("");
  // Year by year: every day of the year counts. Days not logged as good are red.
  // The current year counts days so far.
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const firstYear = Number(entries[0].date.slice(0, 4));
  const curYear = now.getFullYear();
  const yearRows = [];
  for (let y = curYear; y >= firstYear; y--) {
    const ys = String(y);
    const days = y === curYear ? elapsedYear : isLeap(y) ? 366 : 365;
    const green = entries.filter((e) => e.date.startsWith(ys) && e.result === "good").length;
    const red = days - green;
    const pct = ((green / days) * 100).toFixed(1);
    yearRows.push(`
      <li class="row-line">
        <b>${ys}${y === curYear ? " (so far)" : ""}</b>
        <span class="h-good">${green} green</span>
        <span class="h-bad">${red} red</span>
        <span>${pct}%</span>
      </li>`);
  }

  const goodStreakRows = [...goodRuns].sort((a, b) => b.start.localeCompare(a.start)).map((r) => `
    <li class="row-line">
      <b>${r.len} day${r.len > 1 ? "s" : ""}</b>
      <span>${fmtShort(r.start)} → ${fmtShort(r.end)}</span>
      ${r.active ? `<span class="tag">current</span>` : ""}
    </li>`).join("");

  const recentSlips = badEntries.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20).map((d) => `
    <li>
      <div class="entry-head"><b>${fmtShort(d.date)}</b><span>${esc(fmtTime(d.approxTime))}</span></div>
      <p class="root">${esc(d.rootCause || "—")}</p>
      ${trail(d.chain)}
    </li>`).join("");

  return `
    <div class="grid two">
      <section class="card wide">
        <h3>Overall</h3>
        <div class="stat-grid">
          ${kpi(all.total, "Days logged")}
          ${kpi(all.good, "Clean days", "g")}
          ${kpi(all.bad, "Slip days", "b")}
          ${kpi(all.pct + "%", "Good rate", "gold")}
        </div>
      </section>

      <section class="card">
        <h3>This year · ${yr}</h3>
        <div class="stat-grid">
          ${kpi(ySum.total, "Logged")}
          ${kpi(ySum.good, "Good", "g")}
          ${kpi(ySum.bad, "Bad", "b")}
          ${kpi(ySum.pct + "%", "Good rate", "gold")}
          ${kpi(elapsedYear - ySum.total, "Not logged")}
          ${kpi((ySum.good / elapsedYear).toFixed(2), "Points / day")}
        </div>
        <p class="sub">Points / day counts every calendar day since Jan 1, unlogged days as 0.</p>
      </section>

      <section class="card">
        <h3>This month · ${moLabel}</h3>
        <div class="stat-grid">
          ${kpi(mSum.total, "Logged")}
          ${kpi(mSum.good, "Good", "g")}
          ${kpi(mSum.bad, "Bad", "b")}
          ${kpi(mSum.pct + "%", "Good rate", "gold")}
          ${kpi(elapsedMonth - mSum.total, "Not logged")}
          ${kpi((mSum.good / elapsedMonth).toFixed(2), "Points / day")}
        </div>
      </section>

      <section class="card wide">
        <h3>Streaks</h3>
        <div class="stat-grid">
          ${kpi(curGood, "Current clean streak", "g")}
          ${kpi(maxOf(goodLens), "Longest clean streak", "gold")}
          ${kpi(minOf(goodLens), "Shortest clean streak")}
          ${kpi(curBad, "Current slip streak", "b")}
          ${kpi(maxOf(badLens), "Longest slip streak", "b")}
          ${kpi(avgGap, "Avg clean days between slips")}
        </div>
      </section>

      ${progressCard()}

      <section class="card">
        <h3>All clean streaks (${goodRuns.length})</h3>
        <ul class="entries scroll">${goodStreakRows || `<li class="sub">No clean streaks yet.</li>`}</ul>
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
        <h3>Recent slips</h3>
        ${recentSlips ? `<ul class="entries">${recentSlips}</ul>` : `<p class="sub">No slips logged. Keep going.</p>`}
      </section>
    </div>`;
}

/* ---------- render ---------- */
function render() {
  if (!state.user) return;
  const v = $("#view");
  const first = state.user.displayName ? state.user.displayName.split(" ")[0] : "";
  $("#greeting").textContent = first ? `Welcome, ${first}` : "Keep the fire lit";
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  v.innerHTML = state.tab === "calendar" ? viewCalendar() : state.tab === "insights" ? viewInsights() : viewToday();
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
