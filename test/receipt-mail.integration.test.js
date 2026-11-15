const http = require("node:http");
const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer } = require("./helpers");
const { pollReceiptMailbox, messageFromParsed } = require("../server/receipt-mailbox");

const SECRET = "test-notification-secret-value";

async function startGeminiStub(reply) {
  const requests = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { requests.push(JSON.parse(body)); } catch (_error) { requests.push(null); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(typeof reply === "function" ? reply(requests.length) : reply));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${stub.address().port}`, requests, stop: () => new Promise((resolve) => stub.close(resolve)) };
}

const answer = (object) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(object) }] } }] });
const ORDER = {
  merchant: "Amazon", location: "", date: "2026-09-24",
  items: [
    { name: "Original Big Block stress cube", product: "stress cube", qty: 1, unit: "each", unit_price: 16.99, amount: 16.99, discount: 0 },
    { name: "Caliart 176pc sketching kit", product: "sketching kit", qty: 1, unit: "each", unit_price: 25.99, amount: 25.99, discount: 0 },
    { name: "LEGO Jack-O-Lantern pickup truck", product: "lego set", qty: 1, unit: "each", unit_price: 14.95, amount: 14.95, discount: 0 },
    { name: "LEGO Technic off-road race buggy", product: "lego set", qty: 1, unit: "each", unit_price: 19.99, amount: 19.99, discount: 0 }
  ],
  subtotal: 77.92, tax: 5.46, total: 83.38, savings: null
};
const ORDER_EMAIL_TEXT = [
  "Thanks for your order, Prithvi!", "Order #111-9528568-3013019", "Original Big Block Stress Cube   Qty: 1   $16.99", "Caliart 176PCS Art Supplies   Qty: 1   $25.99",
  "LEGO Jack-O'-Lantern Pickup Truck 40822   Qty: 1   $14.95", "LEGO Technic Off-Road Race Buggy   Qty: 1   $19.99", "Item(s) Subtotal: $77.92", "Estimated tax to be collected: $5.46", "Grand Total: $83.38",
  "Track your package: https://www.amazon.com/progress-tracker/package/ref=ppx_yo?orderId=111-9528568-3013019&secret=abcdef"
].join("\n");

async function signedIn(server, name) {
  const signup = await server.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: `${name}@example.com`, password: `${name}-Password-123!`, name, householdName: `${name} household`, country: "US" }) });
  return signup.cookie;
}
const addressOf = async (server, cookie) => (await server.request("/api/receipt-mail/address", { headers: { cookie } })).body;
const deliver = (server, body, secret = SECRET) => server.request("/api/internal/receipt-mail", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
const order = (address, extra = {}) => ({ to: [`Prithvi <${address}>`], from: "Amazon.com <auto-confirm@amazon.com>", subject: "Your Amazon.com order of Original Big Block...", text: ORDER_EMAIL_TEXT, messageId: "<order-1@amazon.com>", date: "2026-09-24T10:00:00Z", ...extra });
const receiptsOf = async (server, cookie) => (await server.request("/api/receipts?items=1", { headers: { cookie } })).body.receipts;

test("the receipts address needs a session, is private to the household, stays the same until reset, and reset retires the old one", async () => {
  const server = await startTestServer({ NOTIFICATION_SECRET: SECRET, RECEIPT_MAILBOX_ADDRESS: "receipts@example.com" });
  try {
    assert.equal((await server.request("/api/receipt-mail/address")).status, 401);
    assert.equal((await server.request("/api/receipt-mail/address/reset", { method: "POST" })).status, 401);
    const cookie = await signedIn(server, "mail-address");
    const first = await addressOf(server, cookie);
    assert.equal(first.configured, true);
    assert.match(first.address, /^receipts\+[0-9a-f]{24}@example\.com$/);
    assert.equal(first.pending, null);
    assert.equal((await addressOf(server, cookie)).address, first.address, "the same address every time");
    const other = await signedIn(server, "mail-address-other");
    assert.notEqual((await addressOf(server, other)).address, first.address, "each household has its own");
    const reset = await server.request("/api/receipt-mail/address/reset", { method: "POST", headers: { cookie } });
    assert.equal(reset.status, 200);
    assert.notEqual(reset.body.address, first.address);
    assert.equal((await deliver(server, order(first.address))).body.status, "unknown-recipient", "the old address no longer reaches the household");
  } finally { await server.stop(); }
});

test("with no mailbox set up there is nothing to show and nothing to receive", async () => {
  const server = await startTestServer({ NOTIFICATION_SECRET: SECRET });
  try {
    const cookie = await signedIn(server, "mail-off");
    assert.deepEqual((await addressOf(server, cookie)), { configured: false });
    assert.equal((await server.request("/api/receipt-mail/address/reset", { method: "POST", headers: { cookie } })).status, 404);
    assert.equal((await server.request("/api/internal/receipt-mail/poll", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })).status, 503, "no mailbox login to read");
  } finally { await server.stop(); }
});

test("only the job secret can deliver an email", async () => {
  const server = await startTestServer({ NOTIFICATION_SECRET: SECRET, RECEIPT_MAILBOX_ADDRESS: "receipts@example.com" });
  try {
    assert.equal((await server.request("/api/internal/receipt-mail", { method: "POST", body: JSON.stringify({}) })).status, 401);
    assert.equal((await deliver(server, {}, "wrong-secret")).status, 401);
    assert.equal((await deliver(server, {})).body.status, "unknown-recipient");
    assert.equal((await server.request("/api/internal/receipt-mail/poll", { method: "POST" })).status, 401);
  } finally { await server.stop(); }
});

test("a forwarded order email becomes a read receipt waiting for its transaction; the same email or the same order again is not added twice", async () => {
  const stub = await startGeminiStub(answer(ORDER));
  const server = await startTestServer({ NOTIFICATION_SECRET: SECRET, RECEIPT_MAILBOX_ADDRESS: "receipts@example.com", GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const cookie = await signedIn(server, "mail-order");
    const { address } = await addressOf(server, cookie);
    const created = await deliver(server, order(address));
    assert.equal(created.body.status, "created");
    const sent = JSON.stringify(stub.requests[0]);
    assert.match(sent, /Original Big Block Stress Cube/, "the email's text is what the AI reads");
    assert.match(sent, /From: Amazon\.com/);
    assert.ok(!/progress-tracker|secret=abcdef/.test(sent), "tracking links never reach the AI");
    const receipts = await receiptsOf(server, cookie);
    assert.equal(receipts.length, 1);
    assert.deepEqual([receipts[0].merchant, receipts[0].total, receipts[0].items.length, receipts[0].status, receipts[0].source, receipts[0].documents.length], ["Amazon", 83.38, 4, "read", "email", 0]);
    const detail = await server.request(`/api/receipts/${receipts[0].id}`, { headers: { cookie } });
    assert.equal(detail.body.receipt.source, "email");
    assert.deepEqual([detail.body.receipt.sourceInfo.from.includes("amazon.com"), detail.body.receipt.sourceInfo.subject.startsWith("Your Amazon.com order")], [true, true], "where it came from is kept");
    assert.equal(detail.body.receipt.check.adds_up, true, "the items add up to the order's own subtotal");

    assert.equal((await deliver(server, order(address))).body.status, "duplicate", "the very same email");
    assert.equal((await deliver(server, order(address, { messageId: "<shipped-1@amazon.com>", subject: "Shipped: your order" }))).body.status, "duplicate", "the shipping email for the same order");
    assert.equal(stub.requests.length, 2, "the first email was read, the same email again was not; the shipping email was read and found to be the same order");
    assert.equal((await receiptsOf(server, cookie)).length, 1);
  } finally { await server.stop(); await stub.stop(); }
});

test("an email that is not an order never reaches the AI, and one the AI finds no items in is dropped", async () => {
  const stub = await startGeminiStub(answer({ merchant: "", date: "", items: [] }));
  const server = await startTestServer({ NOTIFICATION_SECRET: SECRET, RECEIPT_MAILBOX_ADDRESS: "receipts@example.com", GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const cookie = await signedIn(server, "mail-notorder");
    const { address } = await addressOf(server, cookie);
    const reset = await deliver(server, order(address, { subject: "Reset your password", text: "Click the link to reset your password. It expires in 1 hour.", messageId: "<r@x>" }));
    assert.equal(reset.body.status, "not-a-receipt");
    assert.equal(stub.requests.length, 0, "dropped before the AI");
    const notice = await deliver(server, order(address, { subject: "Your package was delivered", text: "Your order was delivered. Total items: 4. Save $5 on your next order.", messageId: "<d@x>" }));
    assert.equal(notice.body.status, "not-a-receipt");
    assert.equal(stub.requests.length >= 1, true, "it looked like an order, so the AI was asked");
    assert.equal((await receiptsOf(server, cookie)).length, 0, "and found nothing to save");
  } finally { await server.stop(); await stub.stop(); }
});

test("Gmail's forwarding confirmation is shown to the person, with a code and a Google link, until they dismiss it", async () => {
  const server = await startTestServer({ NOTIFICATION_SECRET: SECRET, RECEIPT_MAILBOX_ADDRESS: "receipts@example.com" });
  try {
    const cookie = await signedIn(server, "mail-confirm");
    const { address } = await addressOf(server, cookie);
    const result = await deliver(server, {
      to: address, from: "Gmail Team <forwarding-noreply@google.com>", subject: "(#987654321) Gmail Forwarding Confirmation - Receive Mail from someone@gmail.com", messageId: "<g1@google.com>",
      text: "Confirmation code: 987654321\nhttps://mail-settings.google.com/mail/vf-%5BANGjdJ%5D-abc?x=1"
    });
    assert.equal(result.body.status, "forwarding-confirmation");
    const shown = await addressOf(server, cookie);
    assert.deepEqual([shown.pending.code, shown.pending.link], ["987654321", "https://mail-settings.google.com/mail/vf-%5BANGjdJ%5D-abc?x=1"]);
    const other = await signedIn(server, "mail-confirm-other");
    assert.equal((await addressOf(server, other)).pending, null, "another household never sees it");
    const cleared = await server.request("/api/receipt-mail/address/clear-confirmation", { method: "POST", headers: { cookie } });
    assert.equal(cleared.body.pending, null);
    assert.equal((await addressOf(server, cookie)).pending, null);
    assert.equal((await receiptsOf(server, cookie)).length, 0, "a confirmation is never a receipt");
  } finally { await server.stop(); }
});

// ---- The mailbox reader, with a fake mailbox: no network.
function fakeMailbox(messages, options = {}) {
  const flagged = [];
  const state = { connected: false, loggedOut: false, released: false };
  const client = {
    async connect() { state.connected = true; },
    async getMailboxLock(name) { assert.equal(name, "INBOX"); return { release() { state.released = true; } }; },
    async search(query) { assert.deepEqual(query, { seen: false }); return messages.map((_m, index) => index + 1); },
    async fetchOne(uid) { return { source: Buffer.from(String(uid)) }; },
    async messageFlagsAdd(uid, flags) { flagged.push([uid, flags]); },
    async logout() { state.loggedOut = true; if (options.logoutThrows) throw new Error("closed"); }
  };
  return { flagged, state, dependencies: { createClient: () => client, parse: async (source) => messages[Number(source.toString()) - 1] } };
}
const parsedOrder = (extra = {}) => ({ to: { text: "Prithvi <someone@gmail.com>" }, headers: new Map([["delivered-to", "receipts+0123456789abcdef01234567@gmail.com"]]), from: { text: "Amazon.com <auto-confirm@amazon.com>" }, subject: "Your order", text: "x", html: "<p>x</p>", messageId: "<m@x>", date: new Date("2026-09-24T10:00:00Z"), ...extra });

test("the mailbox reader hands each unread email on, marks the ones dealt with as read, and leaves one the AI was too busy for", async () => {
  const mailbox = fakeMailbox([parsedOrder(), parsedOrder({ subject: "busy one" }), parsedOrder({ subject: "broken one" }), parsedOrder({ subject: "confirm" })]);
  const seen = [];
  const counts = await pollReceiptMailbox({
    config: {}, dependencies: mailbox.dependencies,
    ingest: async (message) => {
      seen.push(message);
      if (message.subject === "busy one") throw Object.assign(new Error("busy"), { statusCode: 503 });
      if (message.subject === "broken one") throw new Error("boom");
      return { status: message.subject === "confirm" ? "forwarding-confirmation" : "created" };
    }
  });
  assert.deepEqual(counts, { checked: 4, created: 1, duplicate: 0, notReceipt: 0, forwardingConfirmation: 1, unknownRecipient: 0, limit: 0, retry: 1, failed: 1 });
  assert.deepEqual(mailbox.flagged.map(([uid]) => uid), [1, 3, 4], "the busy one stays unread so the next run tries it again");
  assert.deepEqual(mailbox.flagged[0][1], ["\\Seen"]);
  assert.equal(mailbox.state.released && mailbox.state.loggedOut, true, "the mailbox is always released and logged out");
  assert.equal(seen[0].deliveredTo[0], "receipts+0123456789abcdef01234567@gmail.com", "the household's address is read from Delivered-To, which is where Gmail puts it");
  assert.equal(seen[0].date, "2026-09-24T10:00:00.000Z");
});

test("the mailbox reader stops at its per-run limit, and a failing logout does not lose the result", async () => {
  const mailbox = fakeMailbox(Array.from({ length: 7 }, () => parsedOrder()), { logoutThrows: true });
  const counts = await pollReceiptMailbox({ config: {}, dependencies: mailbox.dependencies, maxPerRun: 3, ingest: async () => ({ status: "duplicate" }) });
  assert.deepEqual([counts.checked, counts.duplicate], [3, 3]);
  assert.equal(mailbox.flagged.length, 3);
});

test("a parsed email is turned into the message the ingest reads, from whichever header names the household", () => {
  const message = messageFromParsed({
    to: { text: "a@x.com" }, cc: { text: "c@x.com" }, from: { text: "Shop <s@shop.com>" }, subject: "Order", text: "t", html: false,
    headers: new Map([["x-original-to", "receipts+aaaaaaaaaaaaaaaaaaaaaaaa@gmail.com"], ["delivered-to", ["one@x.com", "two@x.com"]], ["x-forwarded-to", ["f@x.com"]]]),
    messageId: "<id@x>", date: "not a date"
  });
  assert.deepEqual(message.to, ["a@x.com", "receipts+aaaaaaaaaaaaaaaaaaaaaaaa@gmail.com", "f@x.com"]);
  assert.deepEqual(message.deliveredTo, ["one@x.com", "two@x.com"]);
  assert.deepEqual([message.cc, message.html, message.messageId], ["c@x.com", "", "<id@x>"]);
  assert.equal(messageFromParsed({ headers: new Map() }).from, "");
});
