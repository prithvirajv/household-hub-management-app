const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { startTestServer } = require("./helpers");

async function startGeminiStub(reply) {
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(reply.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${stub.address().port}`,
    stop: () => new Promise((resolve) => stub.close(resolve))
  };
}

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("POST /api/calendar/reminder-from-image requires a session", async () => {
  const server = await startTestServer();
  try {
    const response = await server.request("/api/calendar/reminder-from-image", { method: "POST", body: JSON.stringify({ imageBase64: TINY_PNG_BASE64, mimeType: "image/png" }) });
    assert.equal(response.status, 401);
  } finally {
    await server.stop();
  }
});

test("POST /api/calendar/reminder-from-image is disabled when no API key is configured", async () => {
  const server = await startTestServer();
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "reminder-image-no-key@example.com", password: "Reminder-Image-No-Key-Password-123!", name: "No Key", householdName: "No Key Household", country: "US" })
    });
    const cookie = signup.cookie;
    const response = await server.request("/api/calendar/reminder-from-image", { method: "POST", headers: { cookie }, body: JSON.stringify({ imageBase64: TINY_PNG_BASE64, mimeType: "image/png" }) });
    assert.equal(response.status, 503);
  } finally {
    await server.stop();
  }
});

test("POST /api/calendar/reminder-from-image rejects an unsupported mime type and a missing image", async () => {
  const stub = await startGeminiStub({ body: { candidates: [{ content: { parts: [{ text: "{}" }] } }] } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "reminder-image-validation@example.com", password: "Reminder-Image-Validation-Password-123!", name: "Validation", householdName: "Validation Household", country: "US" })
    });
    const cookie = signup.cookie;

    const badType = await server.request("/api/calendar/reminder-from-image", { method: "POST", headers: { cookie }, body: JSON.stringify({ imageBase64: TINY_PNG_BASE64, mimeType: "application/pdf" }) });
    assert.equal(badType.status, 400);

    const noImage = await server.request("/api/calendar/reminder-from-image", { method: "POST", headers: { cookie }, body: JSON.stringify({ imageBase64: "", mimeType: "image/png" }) });
    assert.equal(noImage.status, 400);
  } finally {
    await server.stop();
    await stub.stop();
  }
});

test("POST /api/calendar/reminder-from-image returns the parsed draft on a happy path", async () => {
  const stub = await startGeminiStub({ body: { candidates: [{ content: { parts: [{ text: '```json\n{"title":"Robotics pickup","date":"2026-09-12","time":"17:30","location":"School gym"}\n```' }] } }] } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "reminder-image-happy@example.com", password: "Reminder-Image-Happy-Password-123!", name: "Happy Path", householdName: "Happy Path Household", country: "US" })
    });
    const cookie = signup.cookie;

    const response = await server.request("/api/calendar/reminder-from-image", { method: "POST", headers: { cookie }, body: JSON.stringify({ imageBase64: TINY_PNG_BASE64, mimeType: "image/png" }) });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { title: "Robotics pickup", date: "2026-09-12", time: "17:30", location: "School gym" });
  } finally {
    await server.stop();
    await stub.stop();
  }
});

test("POST /api/calendar/reminder-from-image surfaces an upstream error as a 502", async () => {
  const stub = await startGeminiStub({ status: 500, body: { error: { message: "overloaded" } } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "reminder-image-upstream-error@example.com", password: "Reminder-Image-Upstream-Error-Password-123!", name: "Upstream Error", householdName: "Upstream Error Household", country: "US" })
    });
    const cookie = signup.cookie;

    const response = await server.request("/api/calendar/reminder-from-image", { method: "POST", headers: { cookie }, body: JSON.stringify({ imageBase64: TINY_PNG_BASE64, mimeType: "image/png" }) });
    assert.equal(response.status, 502);
  } finally {
    await server.stop();
    await stub.stop();
  }
});
