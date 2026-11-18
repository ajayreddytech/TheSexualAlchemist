// Converts a plain "Date  Good/Bad" list into scripts/history.json for the importer.
// Usage: node scripts/convert-history.mjs <raw.txt> <client-email>
import fs from "node:fs";

const [rawFile, email] = process.argv.slice(2);
if (!rawFile || !email) {
  console.error("Usage: node scripts/convert-history.mjs <raw.txt> <client-email>");
  process.exit(1);
}

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const lines = fs.readFileSync(rawFile, "utf8").trim().split(/\r?\n/);
const days = [];
const problems = [];

for (const line of lines) {
  const m = line.trim().match(/^\w{3}, (\w{3}) (\d{1,2}), (\d{4})\s+(Good|Bad)$/);
  if (!m) { problems.push("unparsed: " + line); continue; }
  const date = `${m[3]}-${String(MONTHS[m[1]]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  const result = m[4].toLowerCase();
  days.push({ date, result, approxTime: result === "bad" ? "unknown" : null, chain: [], rootCause: "" });
}

const seen = new Set();
const unique = days.filter((d) => (seen.has(d.date) ? false : seen.add(d.date)));
fs.writeFileSync("scripts/history.json", JSON.stringify({ clients: [{ email, days: unique }] }, null, 2));

console.log("parsed:", days.length, "unique:", unique.length,
  "good:", unique.filter((d) => d.result === "good").length,
  "bad:", unique.filter((d) => d.result === "bad").length);
console.log("first:", unique[0]?.date, "last:", unique.at(-1)?.date);
console.log("problems:", problems.length ? problems : "none");
