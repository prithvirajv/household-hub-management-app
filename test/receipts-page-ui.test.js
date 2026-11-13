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

test("what is stored for a receipt is the shrunk copy, not the original phone photo, and only when it really is smaller", () => {
  assert.match(app, /const prepared = await recipeImportPrepareImage\(file, 2600\);/);
  assert.match(app, /if \(prepared\.mimeType !== file\.type\) \{\s*const bytes = Uint8Array\.from\(atob\(prepared\.imageBase64\)/);
  assert.match(app, /if \(bytes\.length < file\.size\) uploadFile = new File\(\[bytes\]/, "the copy replaces the original only if it is smaller");
  assert.match(app, /return \{ \.\.\.prepared, previewUrl: URL\.createObjectURL\(file\), file: uploadFile \};/, "the file that is uploaded is the chosen copy");
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

test("a receipt can be added on its own, waits in an inbox, and is linked when its transaction arrives", () => {
  const html = read("index.html");
  assert.match(app, /\$\{receiptInboxHtml\(\)\}\s*<details class="new-transaction" id="newTransactionDetails"/, "the inbox and its Add a receipt button sit above New transaction");
  assert.match(app, /id="addReceiptButton">🧾 Add a receipt<\/button>/);
  assert.match(app, /Receipts waiting for a transaction \(\$\{waiting\.length\}\)/);
  assert.ok(html.indexOf("/lib/receipt-match.js") > html.indexOf("/lib/shared-logic.js") && html.indexOf("/lib/receipt-match.js") < html.indexOf("/app.js?v="), "the matcher loads before the page code");
  // Waiting means no transaction points at the receipt, so deleting a transaction simply returns its receipt to the inbox.
  assert.match(app, /const linked = new Set\(state\.transactions\.flatMap\(\(transaction\) => transaction\.receiptIds \|\| \[\]\)\);\s*return receiptInbox\.filter\(\(receipt\) => !linked\.has\(receipt\.id\)\);/);
  // Only the certain matches are linked without asking; the rest are offered.
  assert.match(app, /const certain = receiptMatchPlan\(receiptsWaiting\(\), state\.transactions\)\.certain;/);
  assert.match(app, /data-inbox-link="\$\{escapeHtml\(receipt\.id\)\}\|\$\{suggestion\.index\}">Attach<\/button>/, "a suggestion is one tap");
  assert.match(app, /Its charge is still pending at \$\{escapeHtml\(pending\.accountName\)\}/, "a pending charge is noticed");
});

test("the list of receipts is loaded when Transactions opens and every couple of minutes, and a failure can never loop", () => {
  assert.match(app, /if \(currentView === "transactions" && !receiptInboxLoading && \(receiptInbox === null \|\| Date\.now\(\) - receiptInboxLoadedAt > 120000\)\) void receiptRefreshInbox\(\);/);
  const refresh = app.slice(app.indexOf("function receiptsLinkWaiting("), app.indexOf("function receiptInboxHtml("));
  assert.match(refresh, /catch \(_error\) \{ receiptInbox \|\|= \[\]; \}\s*receiptInboxLoading = false;\s*receiptInboxLoadedAt = Date\.now\(\);/, "the time is stamped even when the load fails, so a failure is not retried on every redraw");
  assert.match(refresh, /showToast\(`\$\{linked\.length === 1 \? "A receipt was" : /, "the person is told when receipts were linked for them");
  assert.match(app, /void receiptRefreshInbox\(\); \/\/ its total may now match a transaction/, "reading a receipt looks for its transaction");
});

test("the pop-up works before a receipt has a transaction: attach to a suggestion, create a transaction for cash, or detach and keep it", () => {
  assert.match(app, /<h3>Which transaction is this\?<\/h3>/);
  assert.match(app, /data-receipt-link="\$\{candidate\.index\}">Attach to this<\/button>/);
  assert.match(app, /id="receiptCreateTransaction">Create a transaction from this receipt<\/button>/);
  assert.match(app, /const lineId = categorizationRuleForPayee\(payee\) \|\| suggestSubcategoryFromHistory\(payee, state\.transactions\) \|\| "";/, "the new row is categorized the way the household usually does");
  assert.match(app, /memo: "From a receipt"/);
  assert.match(app, /transaction\.receiptsDeclined = \[\.\.\.new Set\(\[\.\.\.\(transaction\.receiptsDeclined \|\| \[\]\), receiptData\.id\]\)\];/, "detaching remembers the undone match");
  assert.match(app, /if \(transaction\) \{ transaction\.receiptIds = \[receipt\.id\]; autosaveState\(\); \}/, "attaching with no transaction only records the receipt");
  assert.match(css, /\.receipt-waiting-row \{/);
});

test("a receipt is linked the moment a matching transaction is on the page, whichever way it arrived, and reading is the default", () => {
  assert.match(app, /if \(currentView === "transactions" && receiptInbox\) receiptsLinkWaiting\(\);\s*view\.innerHTML = \(renderers\[currentView\] \|\| renderers\.budget\)\(\);/, "linked before the page is drawn, on every redraw of Transactions");
  const link = app.slice(app.indexOf("function receiptsLinkWaiting("), app.indexOf("async function receiptRefreshInbox("));
  assert.doesNotMatch(link, /\brender\(\)/, "the shared linker never redraws, so it is safe inside render()");
  assert.match(app, /receiptsLinkWaiting\(\);\s*if \(currentView === "transactions"\) render\(\);/, "the reload of the list uses the same linker");
  assert.match(app, /if \(receiptFiles\.length && !receiptBusy\) \$\("#receiptAttachRead"\)\?\.focus\(\);/, "Attach and read items has the focus once photos are chosen");
  assert.match(app, /class="receipt-quiet" id="receiptAttachOnly"/, "Attach only is the quiet choice");
  assert.match(css, /\.receipt-quiet \{ background: none; border: 0;/);
});

test("several photos added together become one receipt each unless they are said to be parts of one, and one failure never stops the rest", () => {
  assert.match(app, /let receiptFileMode = "separate";/, "different receipts is the default");
  assert.match(app, /\$\{!transaction && receiptFiles\.length > 1 \? `<fieldset class="receipt-mode"><legend>These \$\{receiptFiles\.length\} photos are<\/legend>/, "the choice appears only for several photos added on their own");
  assert.match(app, /different receipts: one receipt for each photo/);
  assert.match(app, /parts of one receipt \(a long receipt photographed in pieces\)/);
  assert.match(app, /if \(!transaction && receiptFiles\.length > 1 && receiptFileMode === "separate"\) \{ await receiptAttachSeparately\(readNow\); return; \}/);
  const separate = app.slice(app.indexOf("async function receiptAttachSeparately("), app.indexOf("async function receiptRead("));
  assert.equal((separate.match(/\bcontinue;/g) || []).length, 3, "an upload, a record or (when not reading) a read step that fails or is skipped moves on to the next photo");
  assert.match(separate, /documents: \[\{ documentId, name: entry\.name, contentType: entry\.mimeType \}\]/, "each receipt gets only its own photo");
  assert.match(separate, /could not be read yet: open \$\{unread === 1 \? "it" : "them"\} from the waiting list and press Read/, "an unread one is still attached and says how to read it");
  assert.match(separate, /await receiptRefreshInbox\(\);\s*\}\s*$/, "afterwards the certain ones link at once");
  assert.match(app, /const limit = receiptTransaction\(\) \? 6 : 12;/, "more photos at a time when each is its own receipt");
});
