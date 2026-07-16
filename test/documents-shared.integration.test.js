const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer, combineCookies } = require("./helpers");

let server;

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

test("documents and folders are identical regardless of which of the owner's households is selected", async () => {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "documents-sync-owner@example.com", password: "Documents-Sync-Owner-Password-123!", name: "Documents Sync Owner", householdName: "First Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  const cookie = signup.cookie;

  const folder = await server.request("/api/documents/folders", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Property records" }) });
  assert.equal(folder.status, 200);
  const upload = await server.request("/api/documents/upload-url", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ name: "deed.pdf", contentType: "application/pdf", folderId: folder.body.id })
  });
  assert.equal(upload.status, 200);
  await server.request(`/api/documents/${upload.body.documentId}/confirm`, { method: "POST", headers: { cookie } });

  // Create and switch to a second household for the same owner; documents must follow.
  const secondHousehold = await server.request("/api/households", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Second Household", country: "IN" }) });
  assert.equal(secondHousehold.status, 201);
  const combinedCookie = combineCookies(cookie, secondHousehold.cookie);

  const afterSwitch = await server.request("/api/documents", { headers: { cookie: combinedCookie } });
  assert.equal(afterSwitch.status, 200);
  assert.ok(afterSwitch.body.folders.some((item) => item.id === folder.body.id), "the folder must be visible under the second household too");
  assert.ok(afterSwitch.body.documents.some((item) => item.id === upload.body.documentId && item.status === "ready"), "the document must be visible under the second household too");

  // Adding a document while the second household is selected must also show up back on the first.
  const secondUpload = await server.request("/api/documents/upload-url", {
    method: "POST",
    headers: { cookie: combinedCookie },
    body: JSON.stringify({ name: "tax-receipt.pdf", contentType: "application/pdf" })
  });
  assert.equal(secondUpload.status, 200);

  const afterSecondUpload = await server.request("/api/documents", { headers: { cookie } });
  assert.ok(afterSecondUpload.body.documents.some((item) => item.id === secondUpload.body.documentId), "a document added under the second household must also appear under the first");

  // Deleting the household that a document was originally uploaded under must not delete the document.
  const householdList = await server.request("/api/households", { headers: { cookie: combinedCookie } });
  const firstHouseholdId = householdList.body.find((item) => item.name === "First Household").id;
  const removeFirst = await server.request(`/api/households/${firstHouseholdId}`, { method: "DELETE", headers: { cookie: combinedCookie } });
  assert.equal(removeFirst.status, 200);

  const afterRemoval = await server.request("/api/documents", { headers: { cookie: combineCookies(cookie, removeFirst.cookie) } });
  assert.equal(afterRemoval.status, 200);
  assert.ok(afterRemoval.body.documents.some((item) => item.id === upload.body.documentId), "documents must survive the removal of the household they were originally uploaded under");
});

test("documents added by an invited household member are visible to the owner across their other households", async () => {
  const owner = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "documents-sync-owner-2@example.com", password: "Documents-Sync-Owner-Password-123!", name: "Owner Two", householdName: "Shared Household", country: "US" })
  });
  assert.equal(owner.status, 201);

  const invite = await server.request("/api/households/invitations", {
    method: "POST",
    headers: { cookie: owner.cookie },
    body: JSON.stringify({ email: "documents-sync-member@example.com", name: "Member Two", role: "member", scopes: [] })
  });
  assert.equal(invite.status, 201);

  const accept = await server.request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({ email: "documents-sync-member@example.com", inviteCode: invite.body.invitation.inviteCode, password: "Documents-Sync-Member-Password-123!" })
  });
  assert.equal(accept.status, 200);

  const upload = await server.request("/api/documents/upload-url", {
    method: "POST",
    headers: { cookie: accept.cookie },
    body: JSON.stringify({ name: "member-upload.pdf", contentType: "application/pdf" })
  });
  assert.equal(upload.status, 200);

  const ownerDocuments = await server.request("/api/documents", { headers: { cookie: owner.cookie } });
  assert.ok(ownerDocuments.body.documents.some((item) => item.id === upload.body.documentId), "the household owner must see documents an invited member added");
});
