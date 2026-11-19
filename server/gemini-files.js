// Hands one short video to Gemini's file service so the model can watch it (the model's own web fetch only reaches YouTube). The file lives there for
// the length of one recipe reading and is deleted afterwards; it expires on Google's side after about two days at the latest, and nothing is stored here.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Uploads `bytes` (a Buffer) and waits until Gemini has processed them. Returns { name, uri, mimeType }. Throws an Error with a statusCode.
async function uploadGeminiVideo({ baseUrl, apiKey, bytes, mimeType, displayName = "recipe-video", fetchImpl = fetch, pollMs = 1500, maxWaitMs = 90000 }) {
  const fail = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode });
  const key = encodeURIComponent(apiKey);
  const start = await fetchImpl(`${baseUrl}/upload/v1beta/files?key=${key}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "content-type": "application/json"
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
    signal: AbortSignal.timeout(30000)
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) throw fail("The AI service would not take that video. Try a shorter one.");
  const sent = await fetchImpl(uploadUrl, {
    method: "POST",
    headers: { "Content-Length": String(bytes.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: bytes,
    signal: AbortSignal.timeout(120000)
  });
  const created = await sent.json().catch(() => ({}));
  let file = created.file;
  if (!sent.ok || !file?.name) throw fail("Sending the video to the AI service failed. Try again, or a shorter video.");
  const deadline = Date.now() + maxWaitMs;
  while (file.state && file.state !== "ACTIVE") {
    if (file.state === "FAILED") throw fail("The AI service could not read that video file. Try recording it again.", 422);
    if (Date.now() > deadline) throw fail("The AI service took too long to prepare that video. Try a shorter one.", 504);
    await sleep(pollMs);
    const check = await fetchImpl(`${baseUrl}/v1beta/${file.name}?key=${key}`, { signal: AbortSignal.timeout(15000) });
    file = await check.json().catch(() => file);
  }
  return { name: file.name, uri: file.uri, mimeType: file.mimeType || mimeType };
}

// Best effort: the file would expire on its own, so a failure here is not worth reporting.
async function deleteGeminiFile({ baseUrl, apiKey, name, fetchImpl = fetch }) {
  try { await fetchImpl(`${baseUrl}/v1beta/${name}?key=${encodeURIComponent(apiKey)}`, { method: "DELETE", signal: AbortSignal.timeout(10000) }); } catch (_error) { /* expires by itself */ }
}

module.exports = { uploadGeminiVideo, deleteGeminiFile };
