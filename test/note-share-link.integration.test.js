const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer } = require("./helpers");

let server;

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

async function signUp(email) {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "Note-Link-Owner-Password-123!", name: "Note Link Owner", householdName: "Note Link Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  return signup.cookie;
}

async function addNote(cookie, noteId, overrides = {}) {
  const state = await server.request("/api/state", { headers: { cookie } });
  state.body.notes.entries.push({
    id: noteId,
    title: "Packing list",
    body: "Before Sunday",
    checklist: [{ id: "item-1", text: "Passport", done: false, parentId: "" }],
    pinned: false,
    archived: false,
    trashed: false,
    color: "#ffffff",
    labels: [],
    ...overrides
  });
  const saved = await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state.body) });
  assert.equal(saved.status, 200);
}

function tokenFromUrl(url) {
  return url.split("/shared-notes/")[1];
}

test("note share-link requires a session", async () => {
  const response = await server.request("/api/notes/share-link", {
    method: "POST",
    body: JSON.stringify({ noteId: "does-not-matter" })
  });
  assert.equal(response.status, 401);
});

test("note share-link 404s for a note that doesn't exist in the caller's household", async () => {
  const cookie = await signUp("note-link-owner-1@example.com");
  const response = await server.request("/api/notes/share-link", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "nonexistent" })
  });
  assert.equal(response.status, 404);
});

test("note share-link creates a link, the page renders with no session, and checking off an item persists back to the note - all with no account", async () => {
  const cookie = await signUp("note-link-owner-2@example.com");
  await addNote(cookie, "packing-note");

  const created = await server.request("/api/notes/share-link", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "packing-note" })
  });
  assert.equal(created.status, 200);
  assert.ok(created.body.url.includes("/shared-notes/"));
  const token = tokenFromUrl(created.body.url);

  // Repeat calls are idempotent - same note, same token.
  const createdAgain = await server.request("/api/notes/share-link", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "packing-note" })
  });
  assert.equal(tokenFromUrl(createdAgain.body.url), token);

  // The page itself needs no cookie/session at all.
  const page = await server.request(`/shared-notes/${token}`);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("Packing list"));
  assert.ok(page.body.includes("Passport"));
  // Checking the exact attribute form, not just the substring "checked" -
  // the page's own inline <script> references checkbox.checked as a JS
  // property, which would false-positive a plain "includes('checked')".
  assert.ok(page.body.includes('data-item-id="item-1" >'), "item starts unchecked");

  const toggled = await server.request(`/api/shared-notes/${token}/toggle`, {
    method: "POST",
    body: JSON.stringify({ itemId: "item-1", done: true })
  });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.body.ok, true);

  const pageAfterToggle = await server.request(`/shared-notes/${token}`);
  assert.ok(pageAfterToggle.body.includes('data-item-id="item-1" checked>'), "item now shows checked after the toggle");

  // And it's reflected in the real note through the normal authenticated
  // state read too, not just the public page - same underlying data.
  const state = await server.request("/api/state", { headers: { cookie } });
  const note = state.body.notes.entries.find((item) => item.id === "packing-note");
  assert.equal(note.checklist[0].done, true);
});

test("toggling with an unknown token 404s", async () => {
  const response = await server.request("/api/shared-notes/not-a-real-token/toggle", {
    method: "POST",
    body: JSON.stringify({ itemId: "item-1", done: true })
  });
  assert.equal(response.status, 404);
});

test("an unknown share link renders an unavailable page instead of the note", async () => {
  const response = await server.request("/shared-notes/not-a-real-token");
  assert.equal(response.status, 404);
  assert.ok(response.body.includes("no longer available"));
});

test("stopping sharing revokes the link, and re-sharing mints a fresh token", async () => {
  const cookie = await signUp("note-link-owner-3@example.com");
  await addNote(cookie, "grocery-note");

  const created = await server.request("/api/notes/share-link", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "grocery-note" })
  });
  const firstToken = tokenFromUrl(created.body.url);

  const revoked = await server.request("/api/notes/share-link", {
    method: "DELETE",
    headers: { cookie },
    body: JSON.stringify({ noteId: "grocery-note" })
  });
  assert.equal(revoked.status, 200);

  const pageAfterRevoke = await server.request(`/shared-notes/${firstToken}`);
  assert.equal(pageAfterRevoke.status, 404);

  const recreated = await server.request("/api/notes/share-link", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "grocery-note" })
  });
  assert.notEqual(tokenFromUrl(recreated.body.url), firstToken);
});

test("a trashed note's share link stops resolving", async () => {
  const cookie = await signUp("note-link-owner-4@example.com");
  await addNote(cookie, "trash-me-note");
  const created = await server.request("/api/notes/share-link", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "trash-me-note" })
  });
  const token = tokenFromUrl(created.body.url);

  const state = await server.request("/api/state", { headers: { cookie } });
  const note = state.body.notes.entries.find((item) => item.id === "trash-me-note");
  note.trashed = true;
  await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state.body) });

  const page = await server.request(`/shared-notes/${token}`);
  assert.equal(page.status, 404);
});
