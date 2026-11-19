// Saves your "My Why" page (why, triggers, doomed life) to your own space in Firestore.
//
// Usage:
//   set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
//   node scripts/apply-reflection.mjs scripts/reflection.json --dry-run    (check first, writes nothing)
//   node scripts/apply-reflection.mjs scripts/reflection.json              (writes)
//
// Writes users/{uid}/profile/reflection with merge, so fields left out of the file are kept.

import { readFileSync } from "node:fs";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const file = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!file) {
  console.error("Usage: node scripts/apply-reflection.mjs <reflection.json> [--dry-run]");
  process.exit(1);
}

const input = JSON.parse(readFileSync(file, "utf8"));
const email = String(input.email || "").trim().toLowerCase();
if (!email) { console.error("reflection.json needs an \"email\" field."); process.exit(1); }

const data = {
  why: String(input.why ?? "").trim(),
  triggers: (input.triggers ?? []).map((t) => String(t).trim()).filter(Boolean),
  doomed: String(input.doomed ?? "").trim(),
  updatedAt: new Date().toISOString()
};

initializeApp({ credential: applicationDefault() });
const uid = (await getAuth().getUserByEmail(email)).uid;
const ref = getFirestore().collection("users").doc(uid).collection("profile").doc("reflection");

console.log(`${dryRun ? "DRY RUN: " : ""}account ${email} (uid ${uid})`);
console.log(`why: ${data.why ? "set" : "empty"}; triggers: ${data.triggers.length}; doomed life: ${data.doomed ? "set" : "empty (to fill later)"}`);
if (!dryRun) {
  await ref.set(data, { merge: true });
  console.log("written: users/" + uid + "/profile/reflection");
}
