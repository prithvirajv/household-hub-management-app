const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer } = require("./helpers");

let server;

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

async function signUp(email, householdName) {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "Documents-Owner-Password-123!", name: "Documents Owner", householdName, country: "US" })
  });
  assert.equal(signup.status, 201);
  return signup.cookie;
}

async function addNote(cookie, noteId, title) {
  const state = await server.request("/api/state", { headers: { cookie } });
  state.body.notes.entries.push({ id: noteId, title, body: "", checklist: [], pinned: false, archived: false, trashed: false, color: "#ffffff", labels: [] });
  const saved = await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state.body) });
  assert.equal(saved.status, 200);
}

test("documents endpoints require a session", async () => {
  const list = await server.request("/api/documents");
  assert.equal(list.status, 401);
  const folder = await server.request("/api/documents/folders", { method: "POST", body: JSON.stringify({ name: "Property" }) });
  assert.equal(folder.status, 401);
  const uploadUrl = await server.request("/api/documents/upload-url", { method: "POST", body: JSON.stringify({ name: "deed.pdf", contentType: "application/pdf" }) });
  assert.equal(uploadUrl.status, 401);
});

test("full happy path: folder, upload, confirm, list, download, note-link, delete", async () => {
  const cookie = await signUp("documents-owner-1@example.com", "Documents Household One");
  await addNote(cookie, "note-property-1", "Kanampalayam land");

  const folder = await server.request("/api/documents/folders", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Kanampalayam land" }) });
  assert.equal(folder.status, 200);
  assert.equal(folder.body.name, "Kanampalayam land");

  const uploadUrl = await server.request("/api/documents/upload-url", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ name: "Patta.pdf", contentType: "application/pdf", sizeBytes: 1024, folderId: folder.body.id, noteId: "note-property-1" })
  });
  assert.equal(uploadUrl.status, 200);
  assert.ok(uploadUrl.body.documentId);
  assert.ok(uploadUrl.body.uploadUrl);

  const beforeConfirm = await server.request("/api/documents", { headers: { cookie } });
  const pendingDoc = beforeConfirm.body.documents.find((item) => item.id === uploadUrl.body.documentId);
  assert.equal(pendingDoc.status, "pending");

  const confirm = await server.request(`/api/documents/${uploadUrl.body.documentId}/confirm`, { method: "POST", headers: { cookie } });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.status, "ready");

  const afterConfirm = await server.request("/api/documents", { headers: { cookie } });
  const readyDoc = afterConfirm.body.documents.find((item) => item.id === uploadUrl.body.documentId);
  assert.equal(readyDoc.status, "ready");
  assert.equal(readyDoc.noteId, "note-property-1");
  assert.equal(readyDoc.folderId, folder.body.id);

  const downloadUrl = await server.request(`/api/documents/${uploadUrl.body.documentId}/download-url`, { headers: { cookie } });
  assert.equal(downloadUrl.status, 200);
  assert.ok(downloadUrl.body.url);

  const unlink = await server.request(`/api/documents/${uploadUrl.body.documentId}`, { method: "PATCH", headers: { cookie }, body: JSON.stringify({ noteId: null }) });
  assert.equal(unlink.status, 200);
  assert.equal(unlink.body.noteId, null);

  const remove = await server.request(`/api/documents/${uploadUrl.body.documentId}`, { method: "DELETE", headers: { cookie } });
  assert.equal(remove.status, 200);

  const afterDelete = await server.request("/api/documents", { headers: { cookie } });
  assert.ok(!afterDelete.body.documents.some((item) => item.id === uploadUrl.body.documentId));
});

test("PATCH /api/documents/:id moves a document into a different folder", async () => {
  const cookie = await signUp("documents-move@example.com", "Documents Move Household");
  const folderA = await server.request("/api/documents/folders", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Folder A" }) });
  const folderB = await server.request("/api/documents/folders", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Folder B" }) });
  const upload = await server.request("/api/documents/upload-url", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "deed.pdf", contentType: "application/pdf", folderId: folderA.body.id }) });

  const move = await server.request(`/api/documents/${upload.body.documentId}`, { method: "PATCH", headers: { cookie }, body: JSON.stringify({ folderId: folderB.body.id }) });
  assert.equal(move.status, 200);
  assert.equal(move.body.folderId, folderB.body.id);

  const moveToInvalidFolder = await server.request(`/api/documents/${upload.body.documentId}`, { method: "PATCH", headers: { cookie }, body: JSON.stringify({ folderId: "folder-does-not-exist" }) });
  assert.equal(moveToInvalidFolder.status, 404);
});

test("upload-url rejects an unsupported content type and an oversized file", async () => {
  const cookie = await signUp("documents-owner-2@example.com", "Documents Household Two");
  const badType = await server.request("/api/documents/upload-url", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "virus.exe", contentType: "application/x-executable" }) });
  assert.equal(badType.status, 400);

  const tooBig = await server.request("/api/documents/upload-url", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "huge.pdf", contentType: "application/pdf", sizeBytes: 600 * 1024 * 1024 }) });
  assert.equal(tooBig.status, 400);
});

test("upload-url rejects linking to a note that does not exist", async () => {
  const cookie = await signUp("documents-owner-3@example.com", "Documents Household Three");
  const response = await server.request("/api/documents/upload-url", {
    method: "POST", headers: { cookie },
    body: JSON.stringify({ name: "deed.pdf", contentType: "application/pdf", noteId: "note-does-not-exist" })
  });
  assert.equal(response.status, 400);
});

test("cross-household isolation: another household's folders and documents are not visible or mutable", async () => {
  const cookieA = await signUp("documents-isolation-a@example.com", "Household A");
  const cookieB = await signUp("documents-isolation-b@example.com", "Household B");

  const folderA = await server.request("/api/documents/folders", { method: "POST", headers: { cookie: cookieA }, body: JSON.stringify({ name: "Household A folder" }) });
  const uploadA = await server.request("/api/documents/upload-url", { method: "POST", headers: { cookie: cookieA }, body: JSON.stringify({ name: "a.pdf", contentType: "application/pdf" }) });

  const listB = await server.request("/api/documents", { headers: { cookie: cookieB } });
  assert.ok(!listB.body.folders.some((item) => item.id === folderA.body.id));
  assert.ok(!listB.body.documents.some((item) => item.id === uploadA.body.documentId));

  const confirmFromB = await server.request(`/api/documents/${uploadA.body.documentId}/confirm`, { method: "POST", headers: { cookie: cookieB } });
  assert.equal(confirmFromB.status, 404);

  const downloadFromB = await server.request(`/api/documents/${uploadA.body.documentId}/download-url`, { headers: { cookie: cookieB } });
  assert.equal(downloadFromB.status, 404);

  const deleteFromB = await server.request(`/api/documents/${uploadA.body.documentId}`, { method: "DELETE", headers: { cookie: cookieB } });
  assert.equal(deleteFromB.status, 404);

  const moveFolderFromB = await server.request(`/api/documents/folders/${folderA.body.id}`, { method: "PATCH", headers: { cookie: cookieB }, body: JSON.stringify({ name: "Hijacked" }) });
  assert.equal(moveFolderFromB.status, 404);

  const uploadIntoAFromB = await server.request("/api/documents/upload-url", { method: "POST", headers: { cookie: cookieB }, body: JSON.stringify({ name: "b.pdf", contentType: "application/pdf", folderId: folderA.body.id }) });
  assert.equal(uploadIntoAFromB.status, 404);
});

test("folder move rejects creating a cycle", async () => {
  const cookie = await signUp("documents-cycle@example.com", "Documents Cycle Household");
  const root = await server.request("/api/documents/folders", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Root" }) });
  const child = await server.request("/api/documents/folders", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Child", parentId: root.body.id }) });

  const selfMove = await server.request(`/api/documents/folders/${root.body.id}`, { method: "PATCH", headers: { cookie }, body: JSON.stringify({ parentId: root.body.id }) });
  assert.equal(selfMove.status, 400);

  const intoChild = await server.request(`/api/documents/folders/${root.body.id}`, { method: "PATCH", headers: { cookie }, body: JSON.stringify({ parentId: child.body.id }) });
  assert.equal(intoChild.status, 400);
});

test("deleting a non-empty folder is rejected with 409", async () => {
  const cookie = await signUp("documents-nonempty@example.com", "Documents Nonempty Household");
  const folder = await server.request("/api/documents/folders", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Has stuff" }) });
  await server.request("/api/documents/upload-url", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "a.pdf", contentType: "application/pdf", folderId: folder.body.id }) });

  const remove = await server.request(`/api/documents/folders/${folder.body.id}`, { method: "DELETE", headers: { cookie } });
  assert.equal(remove.status, 409);
});
