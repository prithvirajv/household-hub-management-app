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
  assert.match(app, /uses the same accounts as Sync now/);
  assert.match(css, /\.linked-sync-split \.linked-picker-list \{ left: 0;/);
});
