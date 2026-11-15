const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("app.js");
const css = read("styles.css");

test("the action buttons on ledger and bank stream rows share one set of line icons instead of emoji and text glyphs", () => {
  [["data-split-transaction-edit=\"${index}\" type=\"button\" aria-label=\"Split", "split"], ["data-assign-iou-ledger=", "friend"], ["data-move-to-transfer-ledger=", "transfer"], ["data-receipt-ledger=", "receipt"], ["data-delete-transaction=", "close"], ["data-accept-import=", "check"], ["data-assign-iou=\"${transaction.id}\"", "friend"], ["data-move-to-transfer=\"${transaction.id}\"", "transfer"], ["data-dismiss-import=", "close"]].forEach(([marker, icon]) => {
    const line = app.split("\n").find((text) => text.includes(marker) && text.includes("<button"));
    assert.ok(line, `has the ${icon} button`);
    assert.ok(line.trimEnd().endsWith(`\${rowIconHtml("${icon}")}</button>`), `the ${icon} button draws the ${icon} line icon`);
  });
});

test("every icon the buttons ask for exists, is hidden from screen readers (the button has its own label) and draws in the button's text colour", () => {
  ["split", "friend", "transfer", "receipt", "close", "check"].forEach((name) => assert.match(app, new RegExp(`  ${name}: '<`), `defines ${name}`));
  assert.match(app, /const rowIconHtml = \(name\) => `<svg class="row-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">/);
  assert.match(css, /\.icon-button \.row-icon \{ width: 20px; height: 20px; display: block; fill: none; stroke: currentColor;/);
});
