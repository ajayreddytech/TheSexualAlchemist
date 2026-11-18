// Imports past daily records into Firestore, mapped to each client's Google account email.
//
// Usage:
//   npm install firebase-admin
//   set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
//   node scripts/import-history.mjs scripts/history.json --dry-run    (check first, writes nothing)
//   node scripts/import-history.mjs scripts/history.json              (writes)
//
// Safety rules:
//   * Never deletes anything.
//   * Never overwrites a day that already exists in Firestore; those are reported and skipped.
//   * The account must have signed in to the app at least once, so the email maps to a real user id.

import { readFileSync } from "node:fs";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const file = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!file) {
  console.error("Usage: node scripts/import-history.mjs <history.json> [--dry-run]");
  process.exit(1);
}

const input = JSON.parse(readFileSync(file, "utf8"));
const clients = input.clients ?? [];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{2}:\d{2}|unknown)$/;

initializeApp({ credential: applicationDefault() });
const auth = getAuth();
const db = getFirestore();

let totalWritten = 0;
let totalSkipped = 0;
const problems = [];

for (const client of clients) {
  const email = String(client.email || "").trim().toLowerCase();
  console.log(`\n== ${email} (${client.days?.length ?? 0} records)`);

  let uid;
  try {
    uid = (await auth.getUserByEmail(email)).uid;
  } catch {
    problems.push(`${email}: no user yet. Ask them to sign in to the app once, then re-run.`);
    continue;
  }

  const daysCol = db.collection("users").doc(uid).collection("days");
  const seen = new Set();
  const valid = [];

  for (const d of client.days ?? []) {
    if (!DATE_RE.test(d.date)) { problems.push(`${email}: bad date "${d.date}"`); continue; }
    if (seen.has(d.date)) { problems.push(`${email}: duplicate date ${d.date} in file, kept first`); continue; }
    seen.add(d.date);
    if (d.result !== "good" && d.result !== "bad") { problems.push(`${email} ${d.date}: result must be good or bad`); continue; }
    valid.push(d);
  }

  // Check what already exists, so nothing gets overwritten.
  const existing = new Set();
  for (let i = 0; i < valid.length; i += 300) {
    const refs = valid.slice(i, i + 300).map((d) => daysCol.doc(d.date));
    const snaps = await db.getAll(...refs);
    snaps.forEach((s, idx) => { if (s.exists) existing.add(valid[i + idx].date); });
  }

  const toWrite = valid.filter((d) => !existing.has(d.date));
  totalSkipped += existing.size;
  if (existing.size) console.log(`   skipping ${existing.size} day(s) that already exist: ${[...existing].slice(0, 10).join(", ")}${existing.size > 10 ? " ..." : ""}`);

  if (dryRun) {
    console.log(`   would write ${toWrite.length} day(s) (uid ${uid})`);
    totalWritten += toWrite.length;
    continue;
  }

  const now = new Date().toISOString();
  for (let i = 0; i < toWrite.length; i += 400) {
    const batch = db.batch();
    for (const d of toWrite.slice(i, i + 400)) {
      const time = d.result === "bad" ? (TIME_RE.test(d.approxTime ?? "") ? d.approxTime : "unknown") : null;
      batch.create(daysCol.doc(d.date), {
        date: d.date,
        result: d.result,
        approxTime: time,
        chain: d.result === "bad" && Array.isArray(d.chain) ? d.chain : [],
        rootCause: d.result === "bad" ? (d.rootCause ?? "") : "",
        source: "import",
        createdAt: now,
        updatedAt: now
      });
    }
    await batch.commit();
  }
  totalWritten += toWrite.length;
  console.log(`   wrote ${toWrite.length} day(s)`);
}

console.log(`\n${dryRun ? "DRY RUN: " : ""}written: ${totalWritten}, skipped (already existed): ${totalSkipped}`);
if (problems.length) {
  console.log("\nProblems:");
  problems.forEach((p) => console.log(" - " + p));
}
