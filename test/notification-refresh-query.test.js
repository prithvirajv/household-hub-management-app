const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");

// The reminder refresh runs every 30 minutes for every household. Downloading each whole state (the ledger is most of it) made it the
// biggest reader of the database, and a host that bills data transfer counts every byte, so it fetches only what the reminders use.

test("the 30-minute reminder refresh reads a trimmed state, not every household's whole app_state", () => {
  const match = server.match(/const NOTIFICATION_STATE_SQL = `([\s\S]*?)`;/);
  assert.ok(match, "the trimmed query constant exists");
  const sql = match[1];
  assert.doesNotMatch(sql, /SELECT\s+id,\s*app_state\s+FROM\s+households/i, "never selects the whole state");
  assert.match(sql, /app_state->'household'->'timeZone'/, "keeps the time zone the reminder emails use");
  assert.match(sql, /'calendar',\s*app_state->'calendar'/, "keeps the whole calendar (events and chores)");
  assert.match(sql, /\$\.notes\.entries\[\*\] \? \(@\.reminderAt != null\)/, "keeps only notes that carry a reminder");
  assert.match(sql, /AS app_state/, "returns it under the same name so the candidate code is unchanged");
  assert.match(server, /await client\.query\(NOTIFICATION_STATE_SQL\)/, "the refresh uses it");
});

test("the trimmed query keeps every field notificationCandidates reads", () => {
  const body = server.slice(server.indexOf("function notificationCandidates("), server.indexOf("// A client autosave calls this"));
  const reads = new Set([...body.matchAll(/appState\??\.([a-zA-Z]+)/g)].map((m) => m[1]));
  assert.deepEqual([...reads].sort(), ["calendar", "household", "notes"], "if candidates start reading another part of the state, the query must carry it");
});
