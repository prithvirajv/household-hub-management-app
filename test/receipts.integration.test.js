const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { startTestServer } = require("./helpers");

async function startGeminiStub(reply) {
  const requests = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { requests.push(JSON.parse(body)); } catch (_error) { requests.push(null); }
      res.writeHead(reply.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(typeof reply.body === "function" ? reply.body(requests.length) : reply.body));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${stub.address().port}`, requests, stop: () => new Promise((resolve) => stub.close(resolve)) };
}

const JPEG = "/9j/4AAQSkZJRg==";
const answer = (object) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(object) }] } }] });
const RECEIPT = {
  merchant: "Corner Market", location: "Springfield", date: "2026-11-12",
  items: [
    { name: "Roma tomatoes", product: "roma tomato", qty: 1.31, unit: "lb", unit_price: 2.59, amount: 3.39, discount: 0 },
    { name: "Eggs 5 dozen", qty: 1, unit: "each", unit_price: 10.39, amount: 10.39, discount: 0 },
    { name: "Parchment paper", qty: 1, unit: "each", unit_price: 14.99, amount: 11.49, discount: 3.5 }
  ],
  subtotal: 25.27, tax: 0.8, total: 26.07, savings: 3.5
};

async function signedIn(server, name) {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: `${name}@example.com`, password: `${name}-Password-123!`, name, householdName: `${name} household`, country: "US" })
  });
  return signup.cookie;
}

// A stored file the way the page makes one: a signed upload, then confirm. (The demo server has no storage to read it back from.)
async function uploadDocument(server, cookie, name = "receipt.jpg") {
  const created = await server.request("/api/documents/upload-url", { method: "POST", headers: { cookie }, body: JSON.stringify({ name, contentType: "image/jpeg", sizeBytes: 1000 }) });
  assert.equal(created.status, 200);
  await server.request(`/api/documents/${created.body.documentId}/confirm`, { method: "POST", headers: { cookie } });
  return created.body.documentId;
}

test("receipt routes need a session, and attaching needs real files", async () => {
  const server = await startTestServer();
  try {
    assert.equal((await server.request("/api/receipts")).status, 401);
    assert.equal((await server.request("/api/receipts", { method: "POST", body: JSON.stringify({ documents: [] }) })).status, 401);
    const cookie = await signedIn(server, "receipt-validation");
    const post = (body) => server.request("/api/receipts", { method: "POST", headers: { cookie }, body: JSON.stringify(body) });
    assert.equal((await post({})).status, 400, "no files");
    assert.equal((await post({ documents: [{ documentId: "not-an-id" }] })).status, 400);
    const missing = await post({ documents: [{ documentId: "11111111-1111-4111-8111-111111111111" }] });
    assert.equal(missing.status, 400, "a file that is not in this household's documents");
    assert.match(missing.body.error, /could not be found/);
    assert.equal((await server.request("/api/receipts/not-a-uuid", { headers: { cookie } })).status, 404);
  } finally { await server.stop(); }
});

test("a receipt is attached, read into items, corrected, listed and removed", async () => {
  const stub = await startGeminiStub({ body: answer(RECEIPT) });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const cookie = await signedIn(server, "receipt-flow");
    const documentId = await uploadDocument(server, cookie);
    const attached = await server.request("/api/receipts", { method: "POST", headers: { cookie }, body: JSON.stringify({ documents: [{ documentId, name: "ignored.jpg" }] }) });
    assert.equal(attached.status, 201);
    const id = attached.body.receipt.id;
    assert.deepEqual([attached.body.receipt.status, attached.body.receipt.items.length, attached.body.receipt.documents[0].name], ["attached", 0, "receipt.jpg"], "attached, nothing read yet; the stored file name wins");
    assert.equal(stub.requests.length, 0, "attaching does not call the AI");

    // The demo has no storage to read the file back from, so reading without photos is a clear 409, never a guess.
    const noFiles = await server.request(`/api/receipts/${id}/read`, { method: "POST", headers: { cookie }, body: JSON.stringify({}) });
    assert.equal(noFiles.status, 409);
    assert.match(noFiles.body.error, /attach it again/);

    const read = await server.request(`/api/receipts/${id}/read`, { method: "POST", headers: { cookie }, body: JSON.stringify({ images: [{ mimeType: "image/jpeg", imageBase64: JPEG }] }) });
    assert.equal(read.status, 200);
    const receipt = read.body.receipt;
    assert.deepEqual([receipt.status, receipt.merchant, receipt.date, receipt.items.length, receipt.total], ["read", "Corner Market", "2026-11-12", 3, 26.07]);
    assert.deepEqual(receipt.items[2], { name: "Parchment paper", product: "", qty: 1, unit: "each", unitPrice: 14.99, amount: 11.49, discount: 3.5 });
    assert.equal(receipt.items[0].product, "roma tomato");
    assert.deepEqual([receipt.check.itemsTotal, receipt.check.adds_up], [25.27, true], "the items add up to the printed subtotal");
    assert.deepEqual(stub.requests[0].contents[0].parts[0], { inlineData: { mimeType: "image/jpeg", data: JPEG } });
    assert.match(stub.requests[0].systemInstruction.parts[0].text, /ONE shop receipt/);

    // Corrections: a fixed price, a removed line, an added one; junk is cleaned.
    const patched = await server.request(`/api/receipts/${id}`, { method: "PATCH", headers: { cookie }, body: JSON.stringify({ ...RECEIPT, merchant: "  Corner   Market  ", items: [RECEIPT.items[0], { name: "Bag", qty: 1, unit: "each", amount: 0.1 }, { name: "", amount: 5 }] }) });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.receipt.items.map((item) => item.name), ["Roma tomatoes", "Bag"]);
    assert.equal(patched.body.receipt.merchant, "Corner Market");
    assert.equal(patched.body.receipt.check.adds_up, false, "now the items no longer add up, and it says so");

    const fetched = await server.request(`/api/receipts/${id}`, { headers: { cookie } });
    assert.equal(fetched.body.receipt.items.length, 2, "what was saved is what comes back");
    const listed = await server.request("/api/receipts", { headers: { cookie } });
    assert.deepEqual(listed.body.receipts.map((entry) => [entry.id, entry.merchant, entry.itemCount, entry.status]), [[id, "Corner Market", 2, "read"]]);
    assert.deepEqual(listed.body.receipts[0].documents.map((doc) => doc.documentId), [documentId], "the list carries each receipt's files, so the inbox can show them");
    assert.equal(listed.body.receipts[0].items, undefined, "the plain list stays small: no items");
    const withItems = await server.request("/api/receipts?items=1", { headers: { cookie } });
    assert.deepEqual(withItems.body.receipts[0].items.map((entry) => entry.name), ["Roma tomatoes", "Bag"], "?items=1 carries them, for the price analysis");
    assert.match(withItems.body.receipts[0].createdAt, /^\d{4}-\d{2}-\d{2}T/, "and when the receipt was added, for dating a receipt that has no date");
    assert.deepEqual([listed.body.receipts[0].date, listed.body.receipts[0].total], ["2026-11-12", 26.07], "and the date and total the inbox matches on");

    const removed = await server.request(`/api/receipts/${id}`, { method: "DELETE", headers: { cookie } });
    assert.deepEqual([removed.status, removed.body.documents], [200, [documentId]], "the page is told which files to delete");
    assert.equal((await server.request(`/api/receipts/${id}`, { headers: { cookie } })).status, 404);
  } finally { await server.stop(); await stub.stop(); }
});

test("one household can never see, read, change or remove another's receipts", async () => {
  const stub = await startGeminiStub({ body: answer(RECEIPT) });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const owner = await signedIn(server, "receipt-owner");
    const stranger = await signedIn(server, "receipt-stranger");
    const documentId = await uploadDocument(server, owner);
    const id = (await server.request("/api/receipts", { method: "POST", headers: { cookie: owner }, body: JSON.stringify({ documents: [{ documentId }] }) })).body.receipt.id;
    assert.equal((await server.request(`/api/receipts/${id}`, { headers: { cookie: stranger } })).status, 404);
    assert.equal((await server.request(`/api/receipts/${id}`, { method: "PATCH", headers: { cookie: stranger }, body: JSON.stringify(RECEIPT) })).status, 404);
    assert.equal((await server.request(`/api/receipts/${id}/read`, { method: "POST", headers: { cookie: stranger }, body: JSON.stringify({ images: [{ mimeType: "image/jpeg", imageBase64: JPEG }] }) })).status, 404);
    assert.equal((await server.request(`/api/receipts/${id}`, { method: "DELETE", headers: { cookie: stranger } })).status, 404);
    assert.deepEqual((await server.request("/api/receipts", { headers: { cookie: stranger } })).body.receipts, [], "their list is empty");
    // And a stranger cannot attach someone else's file either.
    const stolen = await server.request("/api/receipts", { method: "POST", headers: { cookie: stranger }, body: JSON.stringify({ documents: [{ documentId }] }) });
    assert.equal(stolen.status, 400);
    assert.equal((await server.request(`/api/receipts/${id}`, { headers: { cookie: owner } })).status, 200, "the owner still has it");
  } finally { await server.stop(); await stub.stop(); }
});

test("the receipt stays attached when the AI is busy or not configured, and says so plainly", async () => {
  const BUSY = { error: { message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later." } };
  const busy = await startGeminiStub({ status: 503, body: BUSY });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: busy.url, GEMINI_MODEL: "m1", GEMINI_FALLBACK_MODELS: "m2", GEMINI_RETRY_PAUSE_MS: "5" });
  try {
    const cookie = await signedIn(server, "receipt-busy");
    const documentId = await uploadDocument(server, cookie);
    const id = (await server.request("/api/receipts", { method: "POST", headers: { cookie }, body: JSON.stringify({ documents: [{ documentId }] }) })).body.receipt.id;
    const read = await server.request(`/api/receipts/${id}/read`, { method: "POST", headers: { cookie }, body: JSON.stringify({ images: [{ mimeType: "image/jpeg", imageBase64: JPEG }] }) });
    assert.equal(read.status, 503);
    assert.match(read.body.error, /very busy right now/);
    assert.match(read.body.error, /receipt is saved/);
    assert.doesNotMatch(read.body.error, /Spikes in demand/);
    assert.equal((await server.request(`/api/receipts/${id}`, { headers: { cookie } })).body.receipt.status, "attached", "still attached, unread");
    assert.equal(busy.requests.length, 7, "two models, three rounds, one last try of the first");
  } finally { await server.stop(); await busy.stop(); }

  const none = await startTestServer();
  try {
    const cookie = await signedIn(none, "receipt-nokey");
    const documentId = await uploadDocument(none, cookie);
    const attached = await none.request("/api/receipts", { method: "POST", headers: { cookie }, body: JSON.stringify({ documents: [{ documentId }] }) });
    assert.equal(attached.status, 201, "attaching works without an AI key");
    const read = await none.request(`/api/receipts/${attached.body.receipt.id}/read`, { method: "POST", headers: { cookie }, body: JSON.stringify({ images: [{ mimeType: "image/jpeg", imageBase64: JPEG }] }) });
    assert.equal(read.status, 503);
  } finally { await none.stop(); }

  const empty = await startGeminiStub({ body: answer({ merchant: "X", items: [] }) });
  const server3 = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: empty.url });
  try {
    const cookie = await signedIn(server3, "receipt-empty");
    const documentId = await uploadDocument(server3, cookie);
    const id = (await server3.request("/api/receipts", { method: "POST", headers: { cookie }, body: JSON.stringify({ documents: [{ documentId }] }) })).body.receipt.id;
    const read = await server3.request(`/api/receipts/${id}/read`, { method: "POST", headers: { cookie }, body: JSON.stringify({ images: [{ mimeType: "image/jpeg", imageBase64: JPEG }] }) });
    assert.equal(read.status, 422);
    assert.match(read.body.error, /could not find any items/);
  } finally { await server3.stop(); await empty.stop(); }
});

test("when the items do not add up to the receipt's own subtotal it is read again, the closest reading is kept, and a receipt with no subtotal is read once", async () => {
  const missingDiscount = { ...RECEIPT, items: [RECEIPT.items[0], RECEIPT.items[1], { ...RECEIPT.items[2], amount: 14.99, discount: 0 }] }; // 3.50 too high
  const slightlyOff = { ...RECEIPT, items: [RECEIPT.items[0], RECEIPT.items[1], { ...RECEIPT.items[2], amount: 11.99 }] }; // 0.50 too high
  const attachAndRead = async (server, cookie) => {
    const documentId = await uploadDocument(server, cookie);
    const id = (await server.request("/api/receipts", { method: "POST", headers: { cookie }, body: JSON.stringify({ documents: [{ documentId }] }) })).body.receipt.id;
    return server.request(`/api/receipts/${id}/read`, { method: "POST", headers: { cookie }, body: JSON.stringify({ images: [{ mimeType: "image/jpeg", imageBase64: JPEG }] }) });
  };

  // The first reading misses the discount; the second gets it right and is kept; no third reading is made.
  const recovering = await startGeminiStub({ body: (n) => answer(n === 1 ? missingDiscount : RECEIPT) });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: recovering.url });
  try {
    const cookie = await signedIn(server, "receipt-reread");
    const read = await attachAndRead(server, cookie);
    assert.equal(read.status, 200);
    assert.deepEqual([read.body.receipt.check.adds_up, read.body.receipt.items[2].discount], [true, 3.5], "the reading that adds up is the one saved");
    assert.equal(recovering.requests.length, 2);
    assert.deepEqual(recovering.requests.map((request) => request.generationConfig.temperature), [0, 0.4], "the first reading is the steadiest, a re-reading varies");
  } finally { await server.stop(); await recovering.stop(); }

  // None of three readings adds up: the closest (0.50 off) is kept, not the last or the first.
  const never = await startGeminiStub({ body: (n) => answer(n === 2 ? slightlyOff : missingDiscount) });
  const server2 = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: never.url });
  try {
    const cookie = await signedIn(server2, "receipt-closest");
    const read = await attachAndRead(server2, cookie);
    assert.equal(read.status, 200);
    assert.deepEqual([never.requests.length, read.body.receipt.check.adds_up, read.body.receipt.check.difference], [3, false, 0.5], "three readings, the closest kept, and the page is still told it does not add up");
  } finally { await server2.stop(); await never.stop(); }

  // Nothing printed to check against: read once.
  const noSubtotal = await startGeminiStub({ body: answer({ ...RECEIPT, subtotal: null, total: null, tax: null }) });
  const server3 = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: noSubtotal.url });
  try {
    const cookie = await signedIn(server3, "receipt-nosubtotal");
    const read = await attachAndRead(server3, cookie);
    assert.equal(read.status, 200);
    assert.deepEqual([noSubtotal.requests.length, read.body.receipt.check.adds_up], [1, null]);
  } finally { await server3.stop(); await noSubtotal.stop(); }
});
