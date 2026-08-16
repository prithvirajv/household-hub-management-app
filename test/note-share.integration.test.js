const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer } = require("./helpers");

let server;

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

async function signUp(email) {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "Note-Share-Owner-Password-123!", name: "Note Share Owner", householdName: "Note Share Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  return signup.cookie;
}

test("note share requires a session", async () => {
  const response = await server.request("/api/notes/share", {
    method: "POST",
    body: JSON.stringify({ to: "grandma@example.com", title: "Grocery list", body: "Milk, eggs" })
  });
  assert.equal(response.status, 401);
});

test("note share rejects an invalid email", async () => {
  const cookie = await signUp("note-share-owner-1@example.com");
  const response = await server.request("/api/notes/share", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ to: "not-an-email", title: "Grocery list", body: "Milk, eggs" })
  });
  assert.equal(response.status, 400);
});

test("note share sends (preview mode under the test SMTP config) to any email, no account required", async () => {
  const cookie = await signUp("note-share-owner-2@example.com");
  const response = await server.request("/api/notes/share", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({
      to: "grandma-not-a-member@example.com",
      title: "Grocery list",
      body: "Pick up before Sunday",
      message: "Can you grab this on your way over?",
      checklist: [{ text: "Milk", done: false }, { text: "Eggs", done: true }]
    })
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.email.preview, true);
});

test("note share drops empty/whitespace-only checklist items and caps text length rather than erroring", async () => {
  const cookie = await signUp("note-share-owner-3@example.com");
  const response = await server.request("/api/notes/share", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({
      to: "friend@example.com",
      title: "Trip packing",
      body: "",
      checklist: [{ text: "  ", done: false }, { text: "Passport", done: false }]
    })
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
});
