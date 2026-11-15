// Reads the shared receipts mailbox (one Gmail or other IMAP mailbox that every household's forwarded order emails land in) and hands each unread email to
// ingestReceiptEmail. Run by a scheduler through POST /api/internal/receipt-mail/poll. An email is marked read once it has been dealt with; one that could
// not be read because the AI was busy is left unread, so the next run tries it again.

const MAX_PER_RUN = 40; // keeps one run short; the rest wait for the next

function headerValues(headers, name) {
  const value = headers && typeof headers.get === "function" ? headers.get(name) : undefined;
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => (item && typeof item === "object" ? (item.text || item.value?.map?.((entry) => entry.address).join(" ") || "") : String(item))).filter(Boolean);
}

// An email date as an ISO string, or "" when it is missing or not a real date (a badly formed Date header must not stop the email being read).
function isoDate(value) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

// A parsed email (mailparser's shape) as the message ingestReceiptEmail takes. The household's address is in Delivered-To when Gmail forwards, and in
// To or X-Original-To for other providers, so all of them are offered.
function messageFromParsed(parsed) {
  return {
    to: [parsed.to?.text, ...headerValues(parsed.headers, "x-original-to"), ...headerValues(parsed.headers, "x-forwarded-to")].filter(Boolean),
    deliveredTo: headerValues(parsed.headers, "delivered-to"),
    cc: parsed.cc?.text || "",
    from: parsed.from?.text || "",
    subject: parsed.subject || "",
    text: parsed.text || "",
    html: typeof parsed.html === "string" ? parsed.html : "",
    messageId: parsed.messageId || "",
    date: isoDate(parsed.date)
  };
}

function defaultDependencies() {
  const { ImapFlow } = require("imapflow");
  const { simpleParser } = require("mailparser");
  return { createClient: (config) => new ImapFlow({ host: config.host, port: config.port, secure: true, auth: { user: config.user, pass: config.pass }, logger: false }), parse: (source) => simpleParser(source) };
}

// `config`: { host, port, user, pass }. `ingest(message)` returns { status } or throws when the email should be retried.
// `dependencies` is for tests: { createClient(config), parse(buffer) }.
async function pollReceiptMailbox({ config, ingest, dependencies = null, maxPerRun = MAX_PER_RUN }) {
  const { createClient, parse } = dependencies || defaultDependencies();
  const counts = { checked: 0, created: 0, duplicate: 0, notReceipt: 0, forwardingConfirmation: 0, unknownRecipient: 0, limit: 0, retry: 0, failed: 0 };
  const client = createClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const unread = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of unread.slice(0, maxPerRun)) {
        counts.checked += 1;
        let done = true;
        try {
          const fetched = await client.fetchOne(uid, { source: true }, { uid: true });
          const result = await ingest(messageFromParsed(await parse(fetched.source)));
          const key = { created: "created", duplicate: "duplicate", "not-a-receipt": "notReceipt", "forwarding-confirmation": "forwardingConfirmation", "unknown-recipient": "unknownRecipient", limit: "limit" }[result.status];
          if (key) counts[key] += 1;
        } catch (error) {
          if (error && (error.statusCode === 503 || error.statusCode === 504)) { counts.retry += 1; done = false; } // the AI is busy: leave it unread
          else { counts.failed += 1; console.warn("Receipt email could not be processed:", error && error.message); }
        }
        if (done) await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      }
    } finally { lock.release(); }
  } finally {
    try { await client.logout(); } catch (_error) { /* already closed */ }
  }
  return counts;
}

module.exports = { pollReceiptMailbox, messageFromParsed, headerValues, MAX_PER_RUN };
