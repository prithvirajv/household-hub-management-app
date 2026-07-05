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

module.exports = { createSignedUploadUrl, createSignedDownloadUrl, deleteObject };
