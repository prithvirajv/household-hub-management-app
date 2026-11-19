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
      res.writeHead((typeof reply.status === "function" ? reply.status(requests.length) : reply.status) || 200, { "Content-Type": "application/json" });
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
    assert.match(badLink.body.error, /not one I can use/);
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

test("POST /api/recipes/import waits out an overloaded AI by going round the models again, and says plainly when it is still busy", async () => {
  const BUSY = { error: { message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later." } };
  // Busy for the first four requests, then fine: two models x three rounds is seven tries, so the fifth succeeds.
  const recovering = await startGeminiStub({ status: (n) => (n <= 4 ? 503 : 200), body: (n) => (n <= 4 ? BUSY : answer(RECIPE)) });
  const env = { GEMINI_API_KEY: "test-key", GEMINI_MODEL: "model-one", GEMINI_FALLBACK_MODELS: "model-two", GEMINI_RETRY_PAUSE_MS: "5" };
  const server = await startTestServer({ ...env, GEMINI_API_BASE_URL: recovering.url });
  try {
    const cookie = await signedIn(server, "recipe-busy-recovers");
    const response = await server.request("/api/recipes/import", { method: "POST", headers: { cookie }, body: JSON.stringify({ videoUrl: `https://youtu.be/${ID}` }) });
    assert.equal(response.status, 200, "it kept trying until the AI answered");
    assert.equal(response.body.name, "Idli Podi");
    assert.equal(recovering.requests.length, 5);
  } finally { await server.stop(); await recovering.stop(); }

  const alwaysBusy = await startGeminiStub({ status: 503, body: BUSY });
  const server2 = await startTestServer({ ...env, GEMINI_API_BASE_URL: alwaysBusy.url });
  try {
    const cookie = await signedIn(server2, "recipe-busy-always");
    const response = await server2.request("/api/recipes/import", { method: "POST", headers: { cookie }, body: JSON.stringify({ videoUrl: `https://youtu.be/${ID}` }) });
    assert.equal(response.status, 503);
    assert.match(response.body.error, /very busy right now/, "plain words, not the AI service's own message");
    assert.doesNotMatch(response.body.error, /Spikes in demand/);
    assert.equal(alwaysBusy.requests.length, 7, "two models, three rounds, plus one last try of the first");
  } finally { await server2.stop(); await alwaysBusy.stop(); }
});

// A stand-in for the social sites' pages: the server's page reader is pointed here (see RECIPE_CAPTION_TEST_BASE) and asks for /page?u=<address>.
async function startPageStub(pages) {
  const requests = [];
  const stub = http.createServer((req, res) => {
    const address = new URL(req.url, "http://x").searchParams.get("u") || "";
    requests.push(address);
    const page = pages[address];
    if (page?.redirect) { res.writeHead(302, { location: page.redirect }); return res.end(); }
    if (!page) { res.writeHead(404); return res.end("no"); }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(page.html);
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${stub.address().port}`, requests, stop: () => new Promise((resolve) => stub.close(resolve)) };
}

test("POST /api/recipes/import reads an Instagram caption from the post's page and gives it to the AI", async () => {
  const reel = "https://www.instagram.com/reel/Cabc123/";
  const pages = startPageStub({ [reel]: { html: `<html><head><meta property="og:title" content="cook on Instagram: &quot;Idli podi&quot;"><meta property="og:description" content="1,204 likes, 33 comments - cook on March 3, 2025: &quot;Idli podi%0A1 cup urad dal &amp; 1/2 cup chana dal. Roast on low flame.&quot;."></head></html>` } });
  const page = await pages;
  const stub = await startGeminiStub({ body: answer(RECIPE) });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url, RECIPE_CAPTION_TEST_BASE: page.url });
  try {
    const cookie = await signedIn(server, "recipe-instagram");
    const response = await server.request("/api/recipes/import", { method: "POST", headers: { cookie }, body: JSON.stringify({ videoUrl: `${reel}?igsh=tracking` }) });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual([response.body.sourceUrl, response.body.sourceLabel, response.body.used], [reel, "Instagram", ["caption"]], "tracking removed, caption was the source");
    const parts = stub.requests[0].contents[0].parts;
    assert.equal(parts.some((part) => part.fileData), false, "Instagram is not handed over as a video file");
    const text = parts.map((part) => part.text || "").join("\n");
    assert.match(text, /1 cup urad dal & 1\/2 cup chana dal/, "the caption text reached the AI, decoded");
    assert.doesNotMatch(text, /1,204 likes/, "the likes line is not part of the caption");
    assert.deepEqual(page.requests, [reel], "the page was asked for with the tracking removed");
  } finally { await server.stop(); await stub.stop(); await page.stop(); }
});

test("POST /api/recipes/import follows a short link to the real post but never to another site", async () => {
  const short = "https://fb.watch/abc/";
  const target = "https://www.facebook.com/reel/777/";
  const page = await startPageStub({
    [short]: { redirect: target },
    [target]: { html: '<meta property="og:description" content="Paneer wrap: 200 g paneer, 2 rotis, 1 tbsp butter. Fry paneer, wrap.">' },
    "https://www.instagram.com/reel/evil/": { redirect: "https://example.com/steal" },
    "https://example.com/steal": { html: '<meta property="og:description" content="should never be read">' }
  });
  const stub = await startGeminiStub({ body: answer(RECIPE) });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url, RECIPE_CAPTION_TEST_BASE: page.url });
  try {
    const cookie = await signedIn(server, "recipe-redirect");
    const post = (body) => server.request("/api/recipes/import", { method: "POST", headers: { cookie }, body: JSON.stringify(body) });
    const ok = await post({ videoUrl: short });
    assert.equal(ok.status, 200);
    assert.deepEqual(page.requests, [short, target], "followed the short link to the post");
    assert.match(JSON.stringify(stub.requests[0]), /200 g paneer/);
    const bad = await post({ videoUrl: "https://www.instagram.com/reel/evil/" });
    assert.equal(bad.status, 422, "the redirect to another site was refused, so there was no caption");
    assert.equal(bad.body.needsCaption, true);
    assert.ok(!page.requests.includes("https://example.com/steal"), "the other site was never contacted");
    assert.equal(stub.requests.length, 1, "no second AI call");
  } finally { await server.stop(); await stub.stop(); await page.stop(); }
});

test("POST /api/recipes/import asks for the caption when a site hides it, and works with a pasted caption", async () => {
  const page = await startPageStub({ "https://www.tiktok.com/@cook/video/1": { html: "<html><head><title>TikTok - Make Your Day</title><meta property=\"og:description\" content=\"Log in to see more\"></head></html>" } });
  const stub = await startGeminiStub({ body: answer(RECIPE) });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url, RECIPE_CAPTION_TEST_BASE: page.url });
  try {
    const cookie = await signedIn(server, "recipe-hidden");
    const post = (body) => server.request("/api/recipes/import", { method: "POST", headers: { cookie }, body: JSON.stringify(body) });
    const hidden = await post({ videoUrl: "https://www.tiktok.com/@cook/video/1" });
    assert.equal(hidden.status, 422);
    assert.equal(hidden.body.needsCaption, true);
    assert.match(hidden.body.error, /TikTok does not show it/);
    assert.equal(stub.requests.length, 0, "the AI was not asked with nothing to read");
    const pasted = await post({ videoUrl: "https://www.tiktok.com/@cook/video/1", caption: "2 cups rice, 1 tsp salt. Boil 12 minutes." });
    assert.equal(pasted.status, 200);
    assert.deepEqual(pasted.body.used, ["caption"]);
    assert.match(JSON.stringify(stub.requests[0]), /2 cups rice/);
    const captionOnly = await post({ caption: "Rice: 2 cups rice. Boil." });
    assert.equal(captionOnly.status, 200, "a caption alone is enough");
    assert.equal(captionOnly.body.sourceUrl, "");
  } finally { await server.stop(); await stub.stop(); await page.stop(); }
});

test("POST /api/recipes/import also reads a YouTube description and still sends the video itself", async () => {
  const id = "abcdefghijk";
  const page = await startPageStub({ [`https://www.youtube.com/watch?v=${id}`]: { html: '<meta property="og:title" content="Sambar"><script>var x={"shortDescription":"Ingredients:\\n1 cup toor dal\\n2 tomatoes\\nSubscribe!"};</script>' } });
  const stub = await startGeminiStub({ body: answer(RECIPE) });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url, RECIPE_CAPTION_TEST_BASE: page.url });
  try {
    const cookie = await signedIn(server, "recipe-youtube-description");
    const response = await server.request("/api/recipes/import", { method: "POST", headers: { cookie }, body: JSON.stringify({ videoUrl: `https://youtu.be/${id}` }) });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.used, ["video", "caption"]);
    const parts = stub.requests[0].contents[0].parts;
    assert.deepEqual(parts[0], { fileData: { fileUri: `https://www.youtube.com/watch?v=${id}` } });
    assert.match(parts.map((part) => part.text || "").join("\n"), /1 cup toor dal\n2 tomatoes/);
  } finally { await server.stop(); await stub.stop(); await page.stop(); }
});

// A stand-in for Gemini that also has the file service: start an upload, receive the bytes, report the file ACTIVE after one PROCESSING answer.
async function startGeminiFilesStub(reply) {
  const log = [];
  let checks = 0;
  const stub = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://x");
      log.push(`${req.method} ${url.pathname}`);
      const base = `http://127.0.0.1:${stub.address().port}`;
      if (req.method === "POST" && url.pathname === "/upload/v1beta/files") {
        log.push(`type ${req.headers["x-goog-upload-header-content-type"]} length ${req.headers["x-goog-upload-header-content-length"]}`);
        res.writeHead(200, { "x-goog-upload-url": `${base}/upload-target/1` });
        return res.end("{}");
      }
      if (req.method === "POST" && url.pathname === "/upload-target/1") {
        log.push(`bytes ${body.length}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ file: { name: "files/abc123", uri: `${base}/v1beta/files/abc123`, mimeType: "video/mp4", state: "PROCESSING" } }));
      }
      if (req.method === "GET" && url.pathname === "/v1beta/files/abc123") {
        checks += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ name: "files/abc123", uri: `${base}/v1beta/files/abc123`, mimeType: "video/mp4", state: reply.failProcessing ? "FAILED" : "ACTIVE" }));
      }
      if (req.method === "DELETE") { res.writeHead(200); return res.end("{}"); }
      try { log.push(JSON.parse(body)); } catch (_error) { log.push(null); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer(RECIPE)));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${stub.address().port}`, log, checks: () => checks, stop: () => new Promise((resolve) => stub.close(resolve)) };
}

test("a picked video file is sent to Gemini's file service, watched with the caption, and deleted afterwards", async () => {
  const stub = await startGeminiFilesStub({});
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url, GEMINI_FILE_POLL_MS: "10" });
  try {
    const cookie = await signedIn(server, "recipe-video-file");
    const upload = (type, body) => fetch(`${server.baseUrl}/api/recipes/import-video`, { method: "POST", headers: { "content-type": type, cookie }, body });
    assert.equal((await fetch(`${server.baseUrl}/api/recipes/import-video`, { method: "POST", headers: { "content-type": "video/mp4" }, body: Buffer.from("x") })).status, 401);
    assert.equal((await upload("application/pdf", Buffer.from("x"))).status, 400, "not a video");
    assert.equal((await upload("video/mp4", Buffer.alloc(0))).status, 400, "empty");
    const sent = await upload("video/mp4", Buffer.alloc(5000, 1));
    assert.equal(sent.status, 200);
    const { videoUploadId } = await sent.json();
    assert.ok(videoUploadId.length >= 20);
    assert.ok(stub.log.includes("type video/mp4 length 5000") && stub.log.includes("bytes 5000"), "the bytes went to the file service");
    assert.ok(stub.checks() >= 1, "it waited until the file was ready");

    const post = (body, headers = {}) => server.request("/api/recipes/import", { method: "POST", headers: { cookie, ...headers }, body: JSON.stringify(body) });
    const other = await signedIn(server, "recipe-video-other");
    assert.equal((await post({ videoUploadId }, { cookie: other })).status, 410, "someone else cannot use that upload");
    assert.equal((await post({ videoUploadId: "no-such-upload-id-1234" })).status, 410);
    const read = await post({ videoUploadId, caption: "2 cups rice" });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(read.body.used, ["video", "caption"]);
    const request = stub.log.find((entry) => entry && entry.contents);
    assert.deepEqual(request.contents[0].parts[0], { fileData: { mimeType: "video/mp4", fileUri: `${stub.url}/v1beta/files/abc123` } }, "the AI is given the uploaded file");
    assert.ok(stub.log.includes("DELETE /v1beta/files/abc123"), "the file was deleted after reading");
    assert.equal((await post({ videoUploadId })).status, 410, "an upload is used once");
  } finally { await server.stop(); await stub.stop(); }
});

test("a video the AI service cannot process is reported plainly, and an oversize video is refused", async () => {
  const stub = await startGeminiFilesStub({ failProcessing: true });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url, GEMINI_FILE_POLL_MS: "10" });
  try {
    const cookie = await signedIn(server, "recipe-video-bad");
    const upload = (body) => fetch(`${server.baseUrl}/api/recipes/import-video`, { method: "POST", headers: { "content-type": "video/quicktime", cookie }, body });
    const failed = await upload(Buffer.alloc(100, 1));
    assert.equal(failed.status, 422);
    assert.match((await failed.json()).error, /could not read that video file/);
    const big = await upload(Buffer.alloc(31 * 1024 * 1024, 1));
    assert.equal(big.status, 413, "over 30 MB");
  } finally { await server.stop(); await stub.stop(); }
});
