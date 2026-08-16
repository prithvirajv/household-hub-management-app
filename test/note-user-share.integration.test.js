const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer } = require("./helpers");

let server;

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

async function signUp(email, overrides = {}) {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email,
      password: "Note-User-Share-Password-123!",
      name: "Note User Share Owner",
      householdName: "Note User Share Household",
      country: "US",
      ...overrides
    })
  });
  assert.equal(signup.status, 201);
  return signup.cookie;
}

async function addNote(cookie, noteId, overrides = {}) {
  const state = await server.request("/api/state", { headers: { cookie } });
  state.body.notes.entries.push({
    id: noteId,
    title: "Weekend chores",
    body: "Before Sunday",
    checklist: [{ id: "item-1", text: "Mow the lawn", done: false, parentId: "" }],
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

test("share-user requires a session", async () => {
  const response = await server.request("/api/notes/share-user", {
    method: "POST",
    body: JSON.stringify({ noteId: "does-not-matter", email: "friend@example.com" })
  });
  assert.equal(response.status, 401);
});

test("share-user 404s for a note that doesn't exist in the caller's household", async () => {
  const cookie = await signUp("note-user-owner-1@example.com");
  const response = await server.request("/api/notes/share-user", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "nonexistent", email: "friend@example.com" })
  });
  assert.equal(response.status, 404);
});

test("share-user 404s when the email isn't a real FamilyLoop account, and rejects sharing with yourself", async () => {
  const cookie = await signUp("note-user-owner-2@example.com");
  await addNote(cookie, "chores-note-2");

  const noAccount = await server.request("/api/notes/share-user", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "chores-note-2", email: "nobody-here@example.com" })
  });
  assert.equal(noAccount.status, 404);

  const self = await server.request("/api/notes/share-user", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "chores-note-2", email: "note-user-owner-2@example.com" })
  });
  assert.equal(self.status, 400);
});

test("share-user rejects sharing with someone who's already a household member, but allows an unrelated real account", async () => {
  const cookie = await signUp("note-user-owner-3@example.com", { householdName: "Owner Household 3" });
  await addNote(cookie, "chores-note-3");

  const invite = await server.request("/api/households/invitations", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ email: "note-user-member-3@example.com", name: "Member Three", role: "Member", scopes: [] })
  });
  assert.equal(invite.status, 201);
  const acceptedMember = await server.request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({
      email: "note-user-member-3@example.com",
      inviteCode: invite.body.invitation.inviteCode,
      password: "Note-User-Member-Password-123!",
      name: "Member Three"
    })
  });
  assert.equal(acceptedMember.status, 200);

  const memberTarget = await server.request("/api/notes/share-user", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "chores-note-3", email: "note-user-member-3@example.com" })
  });
  assert.equal(memberTarget.status, 400);

  // An unrelated real account (not a member of this household) still works
  // - proves the membership check isn't over-triggering on any real email.
  await signUp("note-user-recipient-3@example.com", { householdName: "Recipient Household 3" });
  const outsiderTarget = await server.request("/api/notes/share-user", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ noteId: "chores-note-3", email: "note-user-recipient-3@example.com" })
  });
  assert.equal(outsiderTarget.status, 200);
  assert.equal(outsiderTarget.body.ok, true);
});

test("owner can share a note with a real account holder, see it listed, and remove access - full flow with the recipient editing everything", async () => {
  const ownerCookie = await signUp("note-user-owner-4@example.com", { householdName: "Owner Household" });
  await addNote(ownerCookie, "chores-note-4");
  const recipientCookie = await signUp("note-user-recipient-4@example.com", { householdName: "Recipient Household" });

  const shared = await server.request("/api/notes/share-user", {
    method: "POST",
    headers: { cookie: ownerCookie },
    body: JSON.stringify({ noteId: "chores-note-4", email: "note-user-recipient-4@example.com" })
  });
  assert.equal(shared.status, 200);
  assert.equal(shared.body.shares.length, 1);
  assert.equal(shared.body.shares[0].email, "note-user-recipient-4@example.com");
  const shareId = shared.body.shares[0].id;

  // Owner sees who it's shared with via the dedicated list endpoint too.
  const list = await server.request("/api/notes/chores-note-4/shares", { headers: { cookie: ownerCookie } });
  assert.equal(list.status, 200);
  assert.equal(list.body.shares.length, 1);
  assert.equal(list.body.shares[0].userId, shared.body.shares[0].userId);

  // The recipient sees it under their own login, live-resolved.
  const sharedWithMe = await server.request("/api/notes/shared-with-me", { headers: { cookie: recipientCookie } });
  assert.equal(sharedWithMe.status, 200);
  assert.equal(sharedWithMe.body.notes.length, 1);
  const entry = sharedWithMe.body.notes[0];
  assert.equal(entry.shareId, shareId);
  assert.equal(entry.title, "Weekend chores");
  assert.equal(entry.sharedFromHousehold, "Owner Household");

  // Recipient has full edit: title, body, toggle, edit item text, add item.
  const titleEdit = await server.request(`/api/notes/shared-with-me/${shareId}`, {
    method: "PUT",
    headers: { cookie: recipientCookie },
    body: JSON.stringify({ title: "Weekend chores (updated)" })
  });
  assert.equal(titleEdit.status, 200);

  const bodyEdit = await server.request(`/api/notes/shared-with-me/${shareId}`, {
    method: "PUT",
    headers: { cookie: recipientCookie },
    body: JSON.stringify({ body: "Actually due Saturday" })
  });
  assert.equal(bodyEdit.status, 200);

  const toggle = await server.request(`/api/notes/shared-with-me/${shareId}/toggle`, {
    method: "POST",
    headers: { cookie: recipientCookie },
    body: JSON.stringify({ itemId: "item-1", done: true })
  });
  assert.equal(toggle.status, 200);

  const itemEdit = await server.request(`/api/notes/shared-with-me/${shareId}/items/item-1`, {
    method: "PUT",
    headers: { cookie: recipientCookie },
    body: JSON.stringify({ text: "Mow the lawn (done early)" })
  });
  assert.equal(itemEdit.status, 200);

  const itemAdd = await server.request(`/api/notes/shared-with-me/${shareId}/items`, {
    method: "POST",
    headers: { cookie: recipientCookie },
    body: JSON.stringify({ text: "Water the plants" })
  });
  assert.equal(itemAdd.status, 200);
  assert.equal(itemAdd.body.item.text, "Water the plants");

  // Every change lands in the owner's own note through their normal
  // authenticated state read - same underlying data, not a copy.
  const ownerState = await server.request("/api/state", { headers: { cookie: ownerCookie } });
  const ownerNote = ownerState.body.notes.entries.find((item) => item.id === "chores-note-4");
  assert.equal(ownerNote.title, "Weekend chores (updated)");
  assert.equal(ownerNote.body, "Actually due Saturday");
  assert.equal(ownerNote.checklist.length, 2);
  assert.equal(ownerNote.checklist[0].text, "Mow the lawn (done early)");
  assert.equal(ownerNote.checklist[0].done, true);
  assert.equal(ownerNote.checklist[1].text, "Water the plants");

  // Owner removes access - the recipient loses it immediately.
  const removed = await server.request("/api/notes/share-user", {
    method: "DELETE",
    headers: { cookie: ownerCookie },
    body: JSON.stringify({ noteId: "chores-note-4", sharedWithUserId: shared.body.shares[0].userId })
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.shares.length, 0);

  const afterRemoval = await server.request("/api/notes/shared-with-me", { headers: { cookie: recipientCookie } });
  assert.equal(afterRemoval.body.notes.length, 0);

  const blockedToggle = await server.request(`/api/notes/shared-with-me/${shareId}/toggle`, {
    method: "POST",
    headers: { cookie: recipientCookie },
    body: JSON.stringify({ itemId: "item-1", done: false })
  });
  assert.equal(blockedToggle.status, 404);
});

test("a note shared with one user is invisible to a different signed-in user, even with a guessed shareId", async () => {
  const ownerCookie = await signUp("note-user-owner-5@example.com", { householdName: "Owner Household 5" });
  await addNote(ownerCookie, "chores-note-5");
  await signUp("note-user-recipient-5@example.com", { householdName: "Recipient Household 5" });
  const outsiderCookie = await signUp("note-user-outsider-5@example.com", { householdName: "Outsider Household 5" });

  const shared = await server.request("/api/notes/share-user", {
    method: "POST",
    headers: { cookie: ownerCookie },
    body: JSON.stringify({ noteId: "chores-note-5", email: "note-user-recipient-5@example.com" })
  });
  const shareId = shared.body.shares[0].id;

  const outsiderList = await server.request("/api/notes/shared-with-me", { headers: { cookie: outsiderCookie } });
  assert.equal(outsiderList.body.notes.length, 0);

  const outsiderToggle = await server.request(`/api/notes/shared-with-me/${shareId}/toggle`, {
    method: "POST",
    headers: { cookie: outsiderCookie },
    body: JSON.stringify({ itemId: "item-1", done: true })
  });
  assert.equal(outsiderToggle.status, 404);
});

test("a trashed note drops out of shared-with-me, and add-item validation matches the public link's rules", async () => {
  const ownerCookie = await signUp("note-user-owner-6@example.com", { householdName: "Owner Household 6" });
  await addNote(ownerCookie, "chores-note-6");
  const recipientCookie = await signUp("note-user-recipient-6@example.com", { householdName: "Recipient Household 6" });

  const shared = await server.request("/api/notes/share-user", {
    method: "POST",
    headers: { cookie: ownerCookie },
    body: JSON.stringify({ noteId: "chores-note-6", email: "note-user-recipient-6@example.com" })
  });
  const shareId = shared.body.shares[0].id;

  const blankAdd = await server.request(`/api/notes/shared-with-me/${shareId}/items`, {
    method: "POST",
    headers: { cookie: recipientCookie },
    body: JSON.stringify({ text: "   " })
  });
  assert.equal(blankAdd.status, 400);

  const unknownItemEdit = await server.request(`/api/notes/shared-with-me/${shareId}/items/not-a-real-item`, {
    method: "PUT",
    headers: { cookie: recipientCookie },
    body: JSON.stringify({ text: "Anything" })
  });
  assert.equal(unknownItemEdit.status, 404);

  const state = await server.request("/api/state", { headers: { cookie: ownerCookie } });
  const note = state.body.notes.entries.find((item) => item.id === "chores-note-6");
  note.trashed = true;
  await server.request("/api/state", { method: "PUT", headers: { cookie: ownerCookie }, body: JSON.stringify(state.body) });

  const afterTrash = await server.request("/api/notes/shared-with-me", { headers: { cookie: recipientCookie } });
  assert.equal(afterTrash.body.notes.length, 0);
});
