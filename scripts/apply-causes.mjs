// Attaches cause labels to existing bad days in Firestore, for one account.
//
// Usage:
//   set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
//   node scripts/apply-causes.mjs scripts/causes.json --dry-run    (check first, writes nothing)
//   node scripts/apply-causes.mjs scripts/causes.json              (writes)
//
// Safety rules:
//   * Only touches days that already exist and are logged as bad. Never creates or deletes days.
//   * Sets `causes` (the list) on each day. Sets `rootCause` only if it is currently empty.
//   * Reports days that are missing or not bad, and writes nothing for them.

import { readFileSync } from "node:fs";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const file = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!file) {
  console.error("Usage: node scripts/apply-causes.mjs <causes.json> [--dry-run]");
  process.exit(1);
}

const input = JSON.parse(readFileSync(file, "utf8"));
const email = String(input.email || "").trim().toLowerCase();
if (!email) { console.error("causes.json needs an \"email\" field."); process.exit(1); }

initializeApp({ credential: applicationDefault() });
const uid = (await getAuth().getUserByEmail(email)).uid;
const daysCol = getFirestore().collection("users").doc(uid).collection("days");

const problems = [];
const updates = [];
for (const d of input.days ?? []) {
  const causes = (d.causes ?? []).map((c) => String(c).trim()).filter(Boolean);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !causes.length) { problems.push(`bad entry: ${JSON.stringify(d)}`); continue; }
  const snap = await daysCol.doc(d.date).get();
  if (!snap.exists) { problems.push(`${d.date}: no day in Firestore, skipped`); continue; }
  const data = snap.data();
  if (data.result !== "bad") { problems.push(`${d.date}: logged as ${data.result}, skipped`); continue; }
  const patch = { causes, updatedAt: new Date().toISOString() };
  if (!data.rootCause) patch.rootCause = causes.join("; ");
  updates.push({ date: d.date, patch });
}

console.log(`${dryRun ? "DRY RUN: " : ""}account ${email} (uid ${uid})`);
console.log(`would update ${updates.length} bad day(s):`);
updates.forEach((u) => console.log(`  ${u.date}: ${u.patch.causes.length} cause(s)${u.patch.rootCause ? "" : " (rootCause kept)"}`));

if (!dryRun) {
  for (let i = 0; i < updates.length; i += 400) {
    const batch = getFirestore().batch();
    for (const u of updates.slice(i, i + 400)) batch.update(daysCol.doc(u.date), u.patch);
    await batch.commit();
  }
  console.log(`written: ${updates.length}`);
}

if (problems.length) {
  console.log("\nSkipped:");
  problems.forEach((p) => console.log(" - " + p));
}
