const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer } = require("./helpers");

const NOTIFICATION_SECRET = "test-notification-secret-value";

let server;

test.before(async () => {
  server = await startTestServer({ NOTIFICATION_SECRET });
});
test.after(async () => { await server.stop(); });

test("backup endpoint requires the notification secret", async () => {
  const noHeader = await server.request("/api/internal/backup-db", { method: "POST", body: "{}" });
  assert.equal(noHeader.status, 401);

  const wrongSecret = await server.request("/api/internal/backup-db", {
    method: "POST",
    headers: { authorization: "Bearer wrong-secret" },
    body: "{}"
  });
  assert.equal(wrongSecret.status, 401);
});

test("backup endpoint is disabled when NOTIFICATION_SECRET is unset", async () => {
  const unconfigured = await startTestServer({ NOTIFICATION_SECRET: "" });
  try {
    const response = await unconfigured.request("/api/internal/backup-db", {
      method: "POST",
      headers: { authorization: "Bearer anything" },
      body: "{}"
    });
    assert.equal(response.status, 503);
  } finally {
    await unconfigured.stop();
  }
});

// The test suite runs against MEMORY_DB, which has no real Postgres to
// pg_dump - this just confirms the endpoint recognizes that and skips
// cleanly instead of trying (and failing) to shell out to pg_dump.
test("backup endpoint skips cleanly under MEMORY_DB (no real database to dump)", async () => {
  const response = await server.request("/api/internal/backup-db", {
    method: "POST",
    headers: { authorization: `Bearer ${NOTIFICATION_SECRET}` },
    body: "{}"
  });
  assert.equal(response.status, 200);
  assert.ok(response.body.skipped);
});
