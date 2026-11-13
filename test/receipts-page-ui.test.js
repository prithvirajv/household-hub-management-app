const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("app.js");
const css = read("styles.css");
const server = read("server/index.js");
const schema = read("server/schema.sql");

test("every ledger row has a receipt button, highlighted when a receipt is attached, and the pop-up lives on the Transactions page", () => {
  assert.match(app, /<button class="icon-button \$\{\(transaction\.receiptIds \|\| \[\]\)\.length \? "has-receipt" : ""\}" data-receipt-ledger="\$\{index\}"/);
  assert.match(app, /<\/aside>\s*\$\{receiptDialogHtml\(\)\}\s*<\/section>`;/, "drawn at the end of the Transactions page");
  assert.match(app, /bindPartnersEvents\(\);\s*bindReceiptEvents\(\);/);
  assert.match(css, /\.icon-button\.has-receipt \{/);
});

test("the ledger grid has one column for each of its five icon buttons, in rows and header alike", () => {
  const rows = css.match(/\.ledger-entry-row(?:\.has-accounts)? \{[^}]*grid-template-columns:[^;]*;/g) || [];
  assert.equal(rows.length, 2);
  rows.forEach((rule) => assert.match(rule, /(?:40px ){4}40px;$/, "five 40px icon columns: split, friend, transfer, receipt, delete"));
  const heads = css.match(/\.ledger-entry-head(?:\.has-accounts)? \{[^}]*grid-template-columns:[^;]*;/g) || [];
  assert.equal(heads.length, 2);
  heads.forEach((rule) => assert.match(rule, /(?:40px ){3}40px;$/, "the header keeps its one-column difference from the rows"));
});

test("attaching stores the files as Documents first, then records the receipt; reading is a separate step so a busy AI never loses the file", () => {
  const attach = app.slice(app.indexOf("async function receiptAttach("), app.indexOf("async function receiptRead("));
  const order = ["uploadDocumentFile(entry.file, null)", 'api("/api/receipts", { method: "POST"', "transaction.receiptIds = [receipt.id]", "autosaveState()", "if (readNow)"].map((marker) => attach.indexOf(marker));
  assert.ok(order.every((position, index) => position > 0 && (index === 0 || position > order[index - 1])), "upload, then record, then point the transaction at it, then (only if asked) read");
  assert.match(app, /id="receiptAttachOnly"/, "Attach only is offered next to Attach and read items");
  assert.match(app, /receiptRead\(inline\.length === documents\.length \? inline : null\)/, "the photos already in the browser are sent along; otherwise the server reads them back from storage");
  assert.match(app, /The receipt is attached\. Its items have not been read yet\./, "an unread receipt says so and offers to read it");
  assert.match(app, /await showConfirm\("Read the photos again\? Items you corrected by hand are replaced/, "reading again warns before replacing corrections");
  assert.match(app, /const result = await api\(`\/api\/receipts\/\$\{receiptData\.id\}`, \{ method: "DELETE" \}\);\s*for \(const documentId of result\.documents/, "removing a receipt also removes its files");
});

test("corrections are kept as you type without a redraw, the notes update in place, and a price of one follows the amount unless typed", () => {
  assert.match(app, /input\.addEventListener\("input", \(\) => \{ update\(\); refreshReceiptNotes\(\); \}\);/);
  assert.match(app, /function refreshReceiptNotes\(\) \{[\s\S]*?\$\("#receiptMatchNote"\)[\s\S]*?\$\("#receiptCheckNote"\)/);
  assert.match(app, /if \(key === "unitPrice"\) item\.unitPriceTyped = true;/);
  assert.match(app, /\(key === "amount" \|\| key === "qty"\) && !item\.unitPriceTyped && Number\(item\.qty\) > 0/);
  assert.match(css, /@media \(max-width: 560px\) \{ \.receipt-table \{ min-width: 0; \} \.receipt-table \.receipt-opt \{ display: none; \} \}/, "on a phone Item, Qty and Amount fit without sideways scrolling");
  assert.match(css, /\.receipt-dialog\[open\] \{ display: grid;/, "only an open dialog is displayed");
});

test("receipts are kept in their own table, scoped to the household, and the routes are registered with a large enough body limit", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS receipts \([\s\S]*household_id UUID NOT NULL REFERENCES households\(id\) ON DELETE CASCADE[\s\S]*items JSONB NOT NULL DEFAULT '\[\]'/);
  assert.match(server, /app\.use\("\/api\/receipts", express\.json\(\{ limit: "40mb" \}\)\);/, "the read route can carry several photos");
  assert.match(server, /registerReceiptRoutes\(\{/);
  assert.match(server, /if \(MEMORY_DB\) return null; \/\/ the demo has no storage to read back from/);
});
