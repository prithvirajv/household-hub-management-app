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

async function addWealthItem(cookie, type, itemId, name) {
  const state = await server.request("/api/state", { headers: { cookie } });
  state.body.goals ||= { sinkingFunds: [], debts: [], netWorth: { assets: [], liabilities: [] } };
  state.body.goals.netWorth ||= { assets: [], liabilities: [] };
  const collection = type === "asset" ? state.body.goals.netWorth.assets : state.body.goals.netWorth.liabilities;
  collection.push({ id: itemId, name, value: 1000 });
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

test("PATCH /api/documents/:id sets and clears an expiration date", async () => {
  const cookie = await signUp("documents-expiry@example.com", "Documents Expiry Household");
  const upload = await server.request("/api/documents/upload-url", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "insurance.pdf", contentType: "application/pdf" }) });

  const listBefore = await server.request("/api/documents", { headers: { cookie } });
  assert.equal(listBefore.body.documents.find((item) => item.id === upload.body.documentId).expiryDate, null);

  const setExpiry = await server.request(`/api/documents/${upload.body.documentId}`, { method: "PATCH", headers: { cookie }, body: JSON.stringify({ expiryDate: "2027-03-15" }) });
  assert.equal(setExpiry.status, 200);
  assert.equal(setExpiry.body.expiryDate, "2027-03-15");

  const listAfter = await server.request("/api/documents", { headers: { cookie } });
  assert.equal(listAfter.body.documents.find((item) => item.id === upload.body.documentId).expiryDate, "2027-03-15");

  const clearExpiry = await server.request(`/api/documents/${upload.body.documentId}`, { method: "PATCH", headers: { cookie }, body: JSON.stringify({ expiryDate: null }) });
  assert.equal(clearExpiry.status, 200);
  assert.equal(clearExpiry.body.expiryDate, null);
});

test("PATCH /api/documents/folders/:id renames a folder without disturbing its parent or wealth tag", async () => {
  const cookie = await signUp("documents-rename@example.com", "Documents Rename Household");
  await addWealthItem(cookie, "asset", "asset-rename", "Rename Test Asset");
  const parent = await server.request("/api/documents/folders", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Property" }) });
  const folder = await server.request("/api/documents/folders", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Kanampalayam Land", parentId: parent.body.id }) });
  await server.request(`/api/documents/folders/${folder.body.id}`, { method: "PATCH", headers: { cookie }, body: JSON.stringify({ wealthItemType: "asset", wealthItemId: "asset-rename" }) });

  const rename = await server.request(`/api/documents/folders/${folder.body.id}`, { method: "PATCH", headers: { cookie }, body: JSON.stringify({ name: "Kanampalayam Land (Updated)" }) });
  assert.equal(rename.status, 200);
  assert.equal(rename.body.name, "Kanampalayam Land (Updated)");
  assert.equal(rename.body.parentId, parent.body.id, "renaming should not change the parent folder");
  assert.equal(rename.body.wealthItemType, "asset", "renaming should not clear the wealth tag");
  assert.equal(rename.body.wealthItemId, "asset-rename", "renaming should not clear the wealth tag");
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

test("PATCH /api/documents/:id links and unlinks a document to a wealth asset or liability", async () => {
  const cookie = await signUp("documents-wealth-1@example.com", "Documents Wealth Household");
  await addWealthItem(cookie, "asset", "asset-checking", "Checking account");
  await addWealthItem(cookie, "liability", "liability-mortgage", "Mortgage");
  const upload = await server.request("/api/documents/upload-url", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "statement.pdf", contentType: "application/pdf" }) });

  const linkAsset = await server.request(`/api/documents/${upload.body.documentId}`, {
    method: "PATCH", headers: { cookie }, body: JSON.stringify({ wealthItemType: "asset", wealthItemId: "asset-checking" })
  });
  assert.equal(linkAsset.status, 200);
  assert.equal(linkAsset.body.wealthItemType, "asset");
  assert.equal(linkAsset.body.wealthItemId, "asset-checking");

  const relinkLiability = await server.request(`/api/documents/${upload.body.documentId}`, {
    method: "PATCH", headers: { cookie }, body: JSON.stringify({ wealthItemType: "liability", wealthItemId: "liability-mortgage" })
  });
  assert.equal(relinkLiability.status, 200);
  assert.equal(relinkLiability.body.wealthItemType, "liability");
  assert.equal(relinkLiability.body.wealthItemId, "liability-mortgage");

  const unlink = await server.request(`/api/documents/${upload.body.documentId}`, {
    method: "PATCH", headers: { cookie }, body: JSON.stringify({ wealthItemType: null, wealthItemId: null })
  });
  assert.equal(unlink.status, 200);
  assert.equal(unlink.body.wealthItemType, null);
  assert.equal(unlink.body.wealthItemId, null);
});

test("PATCH /api/documents/:id rejects linking to a wealth item that does not exist", async () => {
  const cookie = await signUp("documents-wealth-2@example.com", "Documents Wealth Household Two");
  const upload = await server.request("/api/documents/upload-url", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "statement.pdf", contentType: "application/pdf" }) });
  const response = await server.request(`/api/documents/${upload.body.documentId}`, {
    method: "PATCH", headers: { cookie }, body: JSON.stringify({ wealthItemType: "asset", wealthItemId: "asset-does-not-exist" })
  });
  assert.equal(response.status, 400);
});

test("PATCH /api/documents/folders/:id links and unlinks a folder to a wealth asset", async () => {
  const cookie = await signUp("documents-wealth-folder-1@example.com", "Documents Wealth Folder Household");
  await addWealthItem(cookie, "asset", "asset-kanam", "Kanampalayam Land");
  const folder = await server.request("/api/documents/folders", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Kanampalayam Land" }) });

  const link = await server.request(`/api/documents/folders/${folder.body.id}`, {
    method: "PATCH", headers: { cookie }, body: JSON.stringify({ wealthItemType: "asset", wealthItemId: "asset-kanam" })
  });
  assert.equal(link.status, 200);
  assert.equal(link.body.wealthItemType, "asset");
  assert.equal(link.body.wealthItemId, "asset-kanam");

  const unlink = await server.request(`/api/documents/folders/${folder.body.id}`, {
    method: "PATCH", headers: { cookie }, body: JSON.stringify({ wealthItemType: null, wealthItemId: null })
  });
  assert.equal(unlink.status, 200);
  assert.equal(unlink.body.wealthItemType, null);
  assert.equal(unlink.body.wealthItemId, null);
});

test("PATCH /api/documents/folders/:id rejects linking to a wealth item that does not exist", async () => {
  const cookie = await signUp("documents-wealth-folder-2@example.com", "Documents Wealth Folder Household Two");
  const folder = await server.request("/api/documents/folders", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Some Folder" }) });
  const response = await server.request(`/api/documents/folders/${folder.body.id}`, {
    method: "PATCH", headers: { cookie }, body: JSON.stringify({ wealthItemType: "asset", wealthItemId: "asset-does-not-exist" })
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

test("deleting a folder cascades to its subfolders and every document inside them", async () => {
  const cookie = await signUp("documents-nonempty@example.com", "Documents Nonempty Household");
  const root = await server.request("/api/documents/folders", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Has stuff" }) });
  const child = await server.request("/api/documents/folders", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Nested", parentId: root.body.id }) });
  const rootDoc = await server.request("/api/documents/upload-url", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "a.pdf", contentType: "application/pdf", folderId: root.body.id }) });
  const childDoc = await server.request("/api/documents/upload-url", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "b.pdf", contentType: "application/pdf", folderId: child.body.id }) });

  const remove = await server.request(`/api/documents/folders/${root.body.id}`, { method: "DELETE", headers: { cookie } });
  assert.equal(remove.status, 200);
  assert.deepEqual(new Set(remove.body.deletedFolderIds), new Set([root.body.id, child.body.id]));
  assert.equal(remove.body.deletedDocumentCount, 2);

  const remaining = await server.request("/api/documents", { headers: { cookie } });
  assert.equal(remaining.body.folders.some((item) => item.id === root.body.id || item.id === child.body.id), false);
  assert.equal(remaining.body.documents.some((item) => item.id === rootDoc.body.documentId || item.id === childDoc.body.documentId), false);
});
