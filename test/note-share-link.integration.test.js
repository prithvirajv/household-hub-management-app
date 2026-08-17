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
  return url.split("/shared-notes/")[1].split("/")[0];
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

test("the share link includes a slugified title so the URL hints at the note before it's opened, but only the token is actually looked up", async () => {
  const cookie = await signUp("note-link-owner-5@example.com");
  await addNote(cookie, "titled-note", { title: "Weekend Trip Packing List!!" });

  const created = await server.request("/api/notes/share-link", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "titled-note" })
  });
  assert.ok(created.body.url.endsWith("/weekend-trip-packing-list"), created.body.url);

  // The slug is cosmetic - a wrong or missing slug still resolves the note.
  const token = tokenFromUrl(created.body.url);
  const withWrongSlug = await server.request(`/shared-notes/${token}/not-the-real-slug`);
  assert.equal(withWrongSlug.status, 200);
  assert.ok(withWrongSlug.body.includes("Weekend Trip Packing List!!"));
});

test("note share-link email includes a link to view and edit when a real noteId is sent", async () => {
  const cookie = await signUp("note-link-owner-6@example.com");
  await addNote(cookie, "emailed-note", { title: "Emailed note" });

  const withNoteId = await server.request("/api/notes/share", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ to: "friend@example.com", noteId: "emailed-note", title: "Emailed note", body: "" })
  });
  assert.equal(withNoteId.status, 200);
  assert.ok(withNoteId.body.url.includes("/shared-notes/"));

  // No noteId (or a note that isn't real/is trashed) - no link, but the
  // email still sends with just the point-in-time content, same as before.
  const withoutNoteId = await server.request("/api/notes/share", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ to: "friend@example.com", title: "Untracked note", body: "" })
  });
  assert.equal(withoutNoteId.status, 200);
  assert.equal(withoutNoteId.body.url, "");
});

test("a link recipient can add a new checklist item and edit an existing item's text, with no account", async () => {
  const cookie = await signUp("note-link-owner-7@example.com");
  await addNote(cookie, "editable-note");
  const created = await server.request("/api/notes/share-link", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "editable-note" })
  });
  const token = tokenFromUrl(created.body.url);

  const added = await server.request(`/api/shared-notes/${token}/items`, {
    method: "POST",
    body: JSON.stringify({ text: "Sunscreen" })
  });
  assert.equal(added.status, 200);
  assert.equal(added.body.item.text, "Sunscreen");
  assert.equal(added.body.item.done, false);

  const edited = await server.request(`/api/shared-notes/${token}/items/item-1`, {
    method: "PUT",
    body: JSON.stringify({ text: "Passport (renewed)" })
  });
  assert.equal(edited.status, 200);

  const page = await server.request(`/shared-notes/${token}`);
  assert.ok(page.body.includes("Sunscreen"), "new item shows up on the page");
  assert.ok(page.body.includes("Passport (renewed)"), "edited item text shows up on the page");

  // Both changes land in the real note through the owner's authenticated
  // state read too.
  const state = await server.request("/api/state", { headers: { cookie } });
  const note = state.body.notes.entries.find((item) => item.id === "editable-note");
  assert.equal(note.checklist.length, 2);
  assert.equal(note.checklist[0].text, "Passport (renewed)");
  assert.equal(note.checklist[1].text, "Sunscreen");
});

test("adding an item with no text 400s, editing an unknown item 404s", async () => {
  const cookie = await signUp("note-link-owner-8@example.com");
  await addNote(cookie, "validation-note");
  const created = await server.request("/api/notes/share-link", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "validation-note" })
  });
  const token = tokenFromUrl(created.body.url);

  const blankAdd = await server.request(`/api/shared-notes/${token}/items`, {
    method: "POST",
    body: JSON.stringify({ text: "   " })
  });
  assert.equal(blankAdd.status, 400);

  const unknownEdit = await server.request(`/api/shared-notes/${token}/items/not-a-real-item`, {
    method: "PUT",
    body: JSON.stringify({ text: "Anything" })
  });
  assert.equal(unknownEdit.status, 404);
});

test("a link recipient can delete a checklist item with no account, and the removal lands in the owner's real note", async () => {
  const cookie = await signUp("note-link-owner-9@example.com");
  await addNote(cookie, "deletable-note", {
    checklist: [
      { id: "item-1", text: "Passport", done: false, parentId: "" },
      { id: "item-2", text: "Sunscreen", done: false, parentId: "" }
    ]
  });
  const created = await server.request("/api/notes/share-link", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "deletable-note" })
  });
  const token = tokenFromUrl(created.body.url);

  const deleted = await server.request(`/api/shared-notes/${token}/items/item-1`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.ok, true);

  const page = await server.request(`/shared-notes/${token}`);
  assert.ok(!page.body.includes("Passport"), "deleted item no longer shows up on the page");
  assert.ok(page.body.includes("Sunscreen"), "the other item is untouched");

  const state = await server.request("/api/state", { headers: { cookie } });
  const note = state.body.notes.entries.find((item) => item.id === "deletable-note");
  assert.equal(note.checklist.length, 1);
  assert.equal(note.checklist[0].id, "item-2");
});

test("deleting an unknown item 404s", async () => {
  const cookie = await signUp("note-link-owner-10@example.com");
  await addNote(cookie, "delete-validation-note");
  const created = await server.request("/api/notes/share-link", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "delete-validation-note" })
  });
  const token = tokenFromUrl(created.body.url);

  const response = await server.request(`/api/shared-notes/${token}/items/not-a-real-item`, { method: "DELETE" });
  assert.equal(response.status, 404);
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
