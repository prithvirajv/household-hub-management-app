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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ID = "abcdefghijk";
const answer = (object) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(object) }] } }] });
const RECIPE = { name: "Idli Podi", ingredients: ["1 cup urad dal, roasted", "1/2 cup chana dal", "10 dried red chillies"], steps: ["Roast the dals on low flame.", "Grind with salt."], tips: ["Roast on a low flame only.", "Store in a dry jar."], calories: 40, protein: 2 };

async function signedIn(server, name) {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: `${name}@example.com`, password: `${name}-Password-123!`, name, householdName: `${name} household`, country: "US" })
  });
  return signup.cookie;
}

test("POST /api/recipes/import needs a session and an AI key", async () => {
  const noKey = await startTestServer();
  try {
    assert.equal((await noKey.request("/api/recipes/import", { method: "POST", body: JSON.stringify({ videoUrl: `https://youtu.be/${ID}` }) })).status, 401);
    const cookie = await signedIn(noKey, "recipe-nokey");
    assert.equal((await noKey.request("/api/recipes/import", { method: "POST", headers: { cookie }, body: JSON.stringify({ videoUrl: `https://youtu.be/${ID}` }) })).status, 503);
  } finally { await noKey.stop(); }
});

test("POST /api/recipes/import rejects a bad link, a missing source and a bad photo without calling the AI", async () => {
  const stub = await startGeminiStub({ body: answer(RECIPE) });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const cookie = await signedIn(server, "recipe-validation");
    const post = (body) => server.request("/api/recipes/import", { method: "POST", headers: { cookie }, body: JSON.stringify(body) });
    assert.equal((await post({})).status, 400);
    const badLink = await post({ videoUrl: "https://example.com/watch?v=" + ID });
    assert.equal(badLink.status, 400);
    assert.match(badLink.body.error, /YouTube link/);
    assert.equal((await post({ images: [{ mimeType: "application/pdf", imageBase64: PNG }] })).status, 400);
    assert.equal(stub.requests.length, 0, "nothing reached the AI");
  } finally { await server.stop(); await stub.stop(); }
});

test("POST /api/recipes/import sends the canonical video link and the photos, and returns a cleaned draft", async () => {
  const stub = await startGeminiStub({ body: answer(RECIPE) });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const cookie = await signedIn(server, "recipe-happy");
    const response = await server.request("/api/recipes/import", { method: "POST", headers: { cookie }, body: JSON.stringify({ videoUrl: `https://youtu.be/${ID}?si=tracking`, images: [{ mimeType: "image/png", imageBase64: PNG }] }) });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.ingredients, ["1 cup urad dal - roasted", "1/2 cup chana dal", "10 dried red chillies"]);
    assert.deepEqual(response.body.tips, [{ text: "Roast on a low flame only.", important: true }, { text: "Store in a dry jar.", important: true }]);
    assert.deepEqual([response.body.name, response.body.sourceUrl, response.body.calories], ["Idli Podi", `https://www.youtube.com/watch?v=${ID}`, 40]);
    assert.equal(stub.requests.length, 1);
    const parts = stub.requests[0].contents[0].parts;
    assert.deepEqual(parts[0], { fileData: { fileUri: `https://www.youtube.com/watch?v=${ID}` } }, "the tracking parameter is stripped");
    assert.deepEqual(parts[1], { inlineData: { mimeType: "image/png", data: PNG } });
    assert.match(stub.requests[0].systemInstruction.parts[0].text, /photos of the ingredient list are authoritative/);

    const photosOnly = await server.request("/api/recipes/import", { method: "POST", headers: { cookie }, body: JSON.stringify({ images: [{ mimeType: "image/png", imageBase64: PNG }] }) });
    assert.equal(photosOnly.status, 200);
    assert.equal(photosOnly.body.sourceUrl, "", "no video, no source link");
    assert.equal(stub.requests[1].contents[0].parts.some((part) => part.fileData), false);
  } finally { await server.stop(); await stub.stop(); }
});

test("POST /api/recipes/import says so when the AI finds no recipe or fails, and limits repeated reads", async () => {
  const empty = await startGeminiStub({ body: answer({ name: "Nothing", ingredients: [], steps: [] }) });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: empty.url });
  try {
    const cookie = await signedIn(server, "recipe-limit");
    const post = () => server.request("/api/recipes/import", { method: "POST", headers: { cookie }, body: JSON.stringify({ videoUrl: `https://youtu.be/${ID}` }) });
    const none = await post();
    assert.equal(none.status, 422);
    assert.match(none.body.error, /could not find a recipe/);
    for (let i = 0; i < 9; i += 1) await post();
    const limited = await post();
    assert.equal(limited.status, 429);
    assert.match(limited.body.error, /try again a little later/);
  } finally { await server.stop(); await empty.stop(); }

  const failing = await startGeminiStub({ status: 400, body: { error: { message: "Video is private" } } });
  const server2 = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: failing.url });
  try {
    const cookie = await signedIn(server2, "recipe-fail");
    const response = await server2.request("/api/recipes/import", { method: "POST", headers: { cookie }, body: JSON.stringify({ videoUrl: `https://youtu.be/${ID}` }) });
    assert.equal(response.status, 502);
    assert.match(response.body.error, /Video is private/);
  } finally { await server2.stop(); await failing.stop(); }
});
