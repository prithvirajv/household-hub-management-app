// Receipts by email, the server side. Each household has its own receipts address (the shared mailbox with a private token after a plus). An order
// email forwarded there is found by that token, turned into text, read by the AI and saved as a receipt waiting for its transaction, exactly like a
// receipt photo. The mailbox itself is read by server/receipt-mailbox.js (or a provider can post the email to the webhook route below); both end up in
// ingestReceiptEmail. Nothing is kept of an email except what became a receipt: its sender, subject and date, and its message id (so a forward that
// arrives twice is one receipt).

const crypto = require("node:crypto");
const { newMailToken, recipientTokens, receiptMailAddress, emailBodyText, forwardingConfirmation, looksLikeReceiptEmail } = require("../lib/receipt-email");

const MAX_EMAIL_RECEIPTS_PER_DAY = 60; // per household: a stuck forwarding loop or a flood must not run up AI cost
const DUPLICATE_WINDOW_DAYS = 7;

// ---- The household's receipts address: a token per household, and the Gmail forwarding confirmation waiting to be shown.
function createMailboxStore({ pool = null, memory = false } = {}) {
  if (memory) {
    const rows = new Map();
    const get = (householdId) => rows.get(householdId);
    return {
      async getOrCreate(householdId) {
        if (!get(householdId)) rows.set(householdId, { householdId, token: newMailToken(), pending: null });
        const row = get(householdId);
        return { token: row.token, pending: row.pending };
      },
      async reset(householdId) { rows.set(householdId, { householdId, token: newMailToken(), pending: null }); return { token: get(householdId).token, pending: null }; },
      async findByToken(token) { for (const row of rows.values()) if (row.token === token) return { householdId: row.householdId, token: row.token }; return null; },
      async setPending(householdId, pending) { const row = get(householdId); if (row) row.pending = pending; }
    };
  }
  const shape = (row) => ({ token: row.token, pending: row.pending_forwarding || null });
  return {
    async getOrCreate(householdId) {
      await pool.query("INSERT INTO receipt_mailboxes (household_id, token) VALUES ($1, $2) ON CONFLICT (household_id) DO NOTHING", [householdId, newMailToken()]);
      return shape((await pool.query("SELECT token, pending_forwarding FROM receipt_mailboxes WHERE household_id = $1", [householdId])).rows[0]);
    },
    async reset(householdId) {
      const result = await pool.query(
        `INSERT INTO receipt_mailboxes (household_id, token) VALUES ($1, $2)
         ON CONFLICT (household_id) DO UPDATE SET token = EXCLUDED.token, pending_forwarding = NULL, updated_at = now() RETURNING token, pending_forwarding`,
        [householdId, newMailToken()]);
      return shape(result.rows[0]);
    },
    async findByToken(token) {
      const result = await pool.query("SELECT household_id, token FROM receipt_mailboxes WHERE token = $1", [token]);
      return result.rows[0] ? { householdId: result.rows[0].household_id, token: result.rows[0].token } : null;
    },
    async setPending(householdId, pending) {
      await pool.query("UPDATE receipt_mailboxes SET pending_forwarding = $2::jsonb, updated_at = now() WHERE household_id = $1", [householdId, pending ? JSON.stringify(pending) : null]);
    }
  };
}

const cents = (value) => (value === null || value === undefined ? null : Math.round(Number(value) * 100));
const nameWords = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word.length > 2 && !["inc", "llc", "the", "com", "store", "stores"].includes(word));
const daysBetween = (a, b) => Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

// The same order arrives as an order email, a shipping email and a delivery email, and may also have been uploaded as a photo: one receipt, not three.
// Same total to the cent, a shop name in common, and dates within a week.
function findDuplicate(receipts, draft) {
  const total = cents(draft.total);
  if (total === null || !draft.merchant) return null;
  const words = nameWords(draft.merchant);
  return receipts.find((other) => cents(other.total) === total
    && nameWords(other.merchant).some((word) => words.includes(word))
    && (!draft.date || !other.date || daysBetween(draft.date, other.date) <= DUPLICATE_WINDOW_DAYS)) || null;
}

const normalizeMessageId = (value) => String(value || "").trim().replace(/^<|>$/g, "").slice(0, 300);

// One email in. Returns { status, ... }: created | duplicate | forwarding-confirmation | not-a-receipt | unknown-recipient | limit. Throws when the AI is busy
// (the caller leaves the email to be tried again) - a permanent "no items" answer is not an error, just not-a-receipt.
async function ingestReceiptEmail({ mailStore, receiptStore, readEmail, message, now = () => new Date() }) {
  const recipients = [message.to, message.deliveredTo, message.cc].flat().filter(Boolean);
  let mailbox = null;
  for (const token of recipientTokens(recipients)) {
    mailbox = await mailStore.findByToken(token);
    if (mailbox) break;
  }
  if (!mailbox) return { status: "unknown-recipient" };
  const householdId = mailbox.householdId;

  const confirmation = forwardingConfirmation(message);
  if (confirmation) {
    await mailStore.setPending(householdId, { ...confirmation, receivedAt: now().toISOString() });
    return { status: "forwarding-confirmation", householdId };
  }

  const messageId = normalizeMessageId(message.messageId) || `hash:${crypto.createHash("sha256").update(`${message.from}|${message.subject}|${message.date}|${String(message.text || message.html || "").slice(0, 2000)}`).digest("hex").slice(0, 40)}`;
  const text = emailBodyText(message);
  if (!looksLikeReceiptEmail(text)) return { status: "not-a-receipt", householdId };

  const existing = await receiptStore.list(householdId, 500);
  if (existing.some((receipt) => receipt.sourceMessageId === messageId)) return { status: "duplicate", householdId };
  const since = now().getTime() - 24 * 3600 * 1000;
  if (existing.filter((receipt) => receipt.source === "email" && Date.parse(receipt.createdAt) >= since).length >= MAX_EMAIL_RECEIPTS_PER_DAY) return { status: "limit", householdId };

  let draft;
  try {
    draft = await readEmail({ from: message.from, subject: message.subject, date: message.date, text });
  } catch (error) {
    if (error && error.statusCode === 422) return { status: "not-a-receipt", householdId }; // the AI found no items: a notice, not an order
    throw error;
  }
  const duplicate = findDuplicate(existing, draft);
  if (duplicate) return { status: "duplicate", householdId, receiptId: duplicate.id };

  const receipt = await receiptStore.createFromEmail(householdId, { ...draft, status: "read", readAt: now().toISOString() }, {
    messageId, info: { from: String(message.from || "").slice(0, 200), subject: String(message.subject || "").slice(0, 300), date: String(message.date || "").slice(0, 40) }
  });
  return { status: "created", householdId, receiptId: receipt.id };
}

// `config`: { mailbox } is the shared mailbox's address (null when email receipts are not set up); `poll()` reads it (null when there is no mailbox login).
function registerReceiptMailRoutes({ app, mailStore, receiptStore, requireSession, requireEditAccess, requireJobSecret, readEmail, config, poll = null }) {
  const householdOf = (req) => req.sessionUser.household_id;
  const view = (mailbox) => ({ configured: true, address: receiptMailAddress(config.mailbox, mailbox.token), pending: mailbox.pending || null });

  app.get("/api/receipt-mail/address", requireSession, async (req, res, next) => {
    try {
      if (!config.mailbox) return res.json({ configured: false });
      res.json(view(await mailStore.getOrCreate(householdOf(req))));
    } catch (error) { next(error); }
  });

  // A new address: the old one stops working (for when it has been shared or leaked).
  app.post("/api/receipt-mail/address/reset", requireSession, requireEditAccess, async (req, res, next) => {
    try {
      if (!config.mailbox) return res.status(404).json({ error: "Email receipts are not set up" });
      res.json(view(await mailStore.reset(householdOf(req))));
    } catch (error) { next(error); }
  });

  app.post("/api/receipt-mail/address/clear-confirmation", requireSession, requireEditAccess, async (req, res, next) => {
    try {
      if (!config.mailbox) return res.status(404).json({ error: "Email receipts are not set up" });
      await mailStore.setPending(householdOf(req), null);
      res.json(view(await mailStore.getOrCreate(householdOf(req))));
    } catch (error) { next(error); }
  });

  // For a provider (or a small worker) that receives the email and posts it here: { to, from, subject, text, html, messageId, date }.
  app.post("/api/internal/receipt-mail", requireJobSecret, async (req, res, next) => {
    try {
      const body = req.body || {};
      const result = await ingestReceiptEmail({
        mailStore, receiptStore, readEmail,
        message: { to: body.to, deliveredTo: body.deliveredTo, cc: body.cc, from: body.from, subject: body.subject, text: body.text, html: body.html, messageId: body.messageId, date: body.date }
      });
      res.json({ status: result.status });
    } catch (error) {
      if (error && (error.statusCode === 503 || error.statusCode === 504)) return res.status(503).json({ error: "The AI is busy; send it again later" });
      next(error);
    }
  });

  // Reads the shared mailbox now (a scheduler calls this every few minutes).
  app.post("/api/internal/receipt-mail/poll", requireJobSecret, async (req, res, next) => {
    try {
      if (!poll) return res.status(503).json({ error: "The receipts mailbox is not configured" });
      res.json(await poll());
    } catch (error) { next(error); }
  });
}

module.exports = { createMailboxStore, ingestReceiptEmail, findDuplicate, registerReceiptMailRoutes, MAX_EMAIL_RECEIPTS_PER_DAY };
