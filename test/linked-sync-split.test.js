const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");

test("Sync now and the choice of accounts are one split button; More no longer holds a second account picker", () => {
  assert.match(app, /<span class="linked-sync-split"><button type="button" data-linked-sync="\$\{link\.id\}"[^]*?\$\{renderLinkedAccountPicker\(link\)\}<\/span>/);
  const moreBody = app.slice(app.indexOf('<div class="linked-more-body">'), app.indexOf("Remove this connection"));
  assert.ok(!moreBody.includes("renderLinkedAccountPicker"), "the picker is not repeated under More");
  assert.ok(!app.includes("Accounts to sync: ${"), "the old separate button label is gone");
  assert.match(app, /for the accounts chosen in the ▾/);
  assert.ok(app.includes('<summary aria-label="More options" title="More options">⋯</summary>') && app.includes('class="linked-actions"'), "one toolbar with a ⋯ menu");
  assert.match(css, /\.linked-sync-split \.linked-picker-list \{ left: 0;/);
});

test("Import history is merged into Sync now: an optional from date beside it, no separate button", () => {
  assert.match(app, /let linkedHistoryFrom = "";/, "empty by default, so Sync now is the ordinary sync");
  assert.ok(app.includes('data-linked-history-date value="${escapeHtml(linkedHistoryFrom)}"') && app.includes("linkedSyncButtonLabel()"));
  assert.ok(!app.includes("data-linked-history=") && !app.includes(">Import history<"), "the separate button is gone");
  assert.match(app, /const from = link\?\.provider === "simplefin" \? linkedHistoryFrom : "";\s*if \(!from\) return syncLinkedAccount\(/);
  assert.match(app, /sinceDate: from, accountIds/);
});

test("with no date picked a manual sync catches up each account from its own last sync, like the nightly run", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server", "linked-accounts.js"), "utf8");
  assert.match(server, /const catchUpFrom = link\.provider === "simplefin" && !req\.body\?\.sinceDate && link\.lastSyncAt && loadHouseholdState \? behindAccountsSince\(await loadHouseholdState\(sessionHouseholdId\(req\)\), wantedMappings/);
  assert.match(server, /fetchLinkPayload\(link, \{ sinceDate: req\.body\?\.sinceDate, catchUpFrom,/);
  assert.ok(app.includes("Syncs what is new since each account's last sync") && app.includes("· through "), "the screen says what the empty date means, and the picker shows each account's date");
});
