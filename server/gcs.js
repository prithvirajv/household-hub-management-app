const { Storage } = require("@google-cloud/storage");

const MEMORY_DB = String(process.env.MEMORY_DB || "false").toLowerCase() === "true";
const GCS_BUCKET = String(process.env.GCS_BUCKET || "").trim();
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

let storageClient = null;
let bucketRef = null;

function getBucket() {
  if (bucketRef) return bucketRef;
  if (!GCS_BUCKET) {
    throw new Error("GCS_BUCKET is not configured");
  }
  storageClient = storageClient || new Storage();
  bucketRef = storageClient.bucket(GCS_BUCKET);
  return bucketRef;
}

async function createSignedUploadUrl(objectPath, contentType) {
  const expiresAt = Date.now() + SIGNED_URL_TTL_MS;
  if (MEMORY_DB) {
    return { url: `memory://upload/${objectPath}`, expiresAt };
  }
  const file = getBucket().file(objectPath);
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: expiresAt,
    contentType
  });
  return { url, expiresAt };
}

async function createSignedDownloadUrl(objectPath) {
  const expiresAt = Date.now() + SIGNED_URL_TTL_MS;
  if (MEMORY_DB) {
    return { url: `memory://download/${objectPath}`, expiresAt };
  }
  const file = getBucket().file(objectPath);
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: expiresAt
  });
  return { url, expiresAt };
}

async function deleteObject(objectPath) {
  if (MEMORY_DB) return;
  await getBucket().file(objectPath).delete({ ignoreNotFound: true });
}

async function copyObject(sourcePath, destPath) {
  if (MEMORY_DB) return;
  await getBucket().file(sourcePath).copy(getBucket().file(destPath));
}

// Used by folder zip-download, which reads real file bytes rather than
// handing out a signed URL - has no memory-mode equivalent since
// MEMORY_DB never stores real content behind its fake upload/download URLs.
function getObjectStream(objectPath) {
  if (MEMORY_DB) throw new Error("Object content is not available in MEMORY_DB mode");
  return getBucket().file(objectPath).createReadStream();
}

// Used by the nightly DB backup job, which already has the full dump in
// memory (piped from pg_dump) rather than a client-side upload needing a
// signed URL.
async function uploadBuffer(objectPath, buffer, contentType) {
  if (MEMORY_DB) return;
  await getBucket().file(objectPath).save(buffer, { contentType, resumable: false });
}

// Used to prune old dated backups down to a retention window - returns
// {name, updated} for each object under the prefix, oldest-relevant fields
// only, not full metadata.
async function listObjects(prefix) {
  if (MEMORY_DB) return [];
  const [files] = await getBucket().getFiles({ prefix });
  return files.map((file) => ({ name: file.name, updated: file.metadata.updated }));
}

module.exports = { createSignedUploadUrl, createSignedDownloadUrl, deleteObject, copyObject, getObjectStream, uploadBuffer, listObjects };
