// Receipts: a photo (or PDF) of a shop receipt attached to a transaction, and what was bought, read from it (items with quantity, unit and price per
// unit). The files are ordinary Documents (uploaded to storage like any other file); the household's saved state keeps only a small receiptIds
// pointer on the transaction. The items live HERE, in their own table, because a year of grocery receipts would soon pass the ~1 MB the household
// state can hold. Items are saved as a household's own, so the price history that comes later (what things cost, what is dear) can read them.
//
// Reading is a separate step from attaching on purpose: the file is kept even when the AI is busy or cannot read it, and "Read again" retries.

const crypto = require("node:crypto");
const { cleanReceiptFields, receiptCheck, validateReceiptReadRequest } = require("../lib/receipt-read");
const { createImportLimiter } = require("../lib/recipe-import");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILES_PER_RECEIPT = 6;

function documentList(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_FILES_PER_RECEIPT).map((doc) => ({
    documentId: String(doc.documentId || ""),
    name: String(doc.name || "receipt").slice(0, 200),
    contentType: String(doc.contentType || "").slice(0, 100)
  })).filter((doc) => UUID.test(doc.documentId));
}

// What the page gets: the stored receipt plus whether its items add up to what the receipt itself printed.
function toClient(row) {
  const draft = { items: row.items || [], subtotal: row.subtotal, tax: row.tax, total: row.total };
  return {
    id: row.id,
    documents: row.documents || [],
    merchant: row.merchant || "",
    location: row.location || "",
    date: row.date || "",
    subtotal: row.subtotal, tax: row.tax, total: row.total, savings: row.savings,
    items: row.items || [],
    status: row.status,
    readAt: row.readAt || null,
    createdAt: row.createdAt,
    check: draft.items.length ? receiptCheck(draft) : null
  };
}

const num = (value) => (value === null || value === undefined ? null : Number(value));

function fromDatabaseRow(row) {
  return {
    id: row.id, documents: row.documents || [], merchant: row.merchant, location: row.location, date: row.receipt_day || "",
    subtotal: num(row.subtotal), tax: num(row.tax), total: num(row.total), savings: num(row.savings),
    items: row.items || [], status: row.status, readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString()
  };
}

const COLUMNS = "*, to_char(receipt_date, 'YYYY-MM-DD') AS receipt_day";

// The two stores share one shape. `householdId` always scopes the query, so one household can never read or change another's receipts.
function createReceiptStore({ pool = null, memory = false } = {}) {
  if (memory) {
    const rows = [];
    return {
      async create(householdId, userId, documents) {
        const row = { id: crypto.randomUUID(), householdId, documents, merchant: "", location: "", date: "", subtotal: null, tax: null, total: null, savings: null, items: [], status: "attached", readAt: null, createdAt: new Date().toISOString() };
        rows.push(row);
        return { ...row };
      },
      async get(householdId, id) { const row = rows.find((item) => item.id === id && item.householdId === householdId); return row ? { ...row } : null; },
      async list(householdId, limit) { return rows.filter((item) => item.householdId === householdId).slice(-limit).reverse().map((item) => ({ ...item })); },
      async update(householdId, id, fields) {
        const row = rows.find((item) => item.id === id && item.householdId === householdId);
        if (!row) return null;
        Object.assign(row, fields);
        return { ...row };
      },
      async remove(householdId, id) {
        const index = rows.findIndex((item) => item.id === id && item.householdId === householdId);
        if (index < 0) return null;
        return rows.splice(index, 1)[0];
      }
    };
  }
  return {
    async create(householdId, userId, documents) {
      const result = await pool.query(`INSERT INTO receipts (household_id, created_by, documents) VALUES ($1, $2, $3::jsonb) RETURNING ${COLUMNS}`, [householdId, userId, JSON.stringify(documents)]);
      return fromDatabaseRow(result.rows[0]);
    },
    async get(householdId, id) {
      const result = await pool.query(`SELECT ${COLUMNS} FROM receipts WHERE household_id = $1 AND id = $2`, [householdId, id]);
      return result.rows[0] ? fromDatabaseRow(result.rows[0]) : null;
    },
    async list(householdId, limit) {
      const result = await pool.query(`SELECT ${COLUMNS} FROM receipts WHERE household_id = $1 ORDER BY COALESCE(receipt_date, created_at::date) DESC, created_at DESC LIMIT $2`, [householdId, limit]);
      return result.rows.map(fromDatabaseRow);
    },
    async update(householdId, id, fields) {
      const result = await pool.query(
        `UPDATE receipts SET merchant = $3, location = $4, receipt_date = NULLIF($5, '')::date, subtotal = $6, tax = $7, total = $8, savings = $9,
                items = $10::jsonb, status = $11, read_at = $12, updated_at = now()
         WHERE household_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
        [householdId, id, fields.merchant, fields.location, fields.date, fields.subtotal, fields.tax, fields.total, fields.savings, JSON.stringify(fields.items), fields.status, fields.readAt]
      );
      return result.rows[0] ? fromDatabaseRow(result.rows[0]) : null;
    },
    async remove(householdId, id) {
      const result = await pool.query("DELETE FROM receipts WHERE household_id = $1 AND id = $2 RETURNING id, documents", [householdId, id]);
      return result.rows[0] || null;
    }
  };
}

// `findDocuments(req, ids)` -> the household's Documents rows for those ids ({ id, name, content_type, storage_object });
// `loadDocumentFiles(docs)` -> [{ mimeType, imageBase64 }] read from storage (null where there is no storage, as in the demo);
// `readReceipt(files)` -> a cleaned draft from the AI. Both of the last two are supplied by the server so this module stays testable.
function registerReceiptRoutes({ app, store, requireSession, requireEditAccess, findDocuments, loadDocumentFiles, readReceipt, aiConfigured }) {
  const limiter = createImportLimiter({ max: 40, windowMs: 60 * 60 * 1000 });
  const householdOf = (req) => req.sessionUser.household_id;
  const validId = (req, res) => {
    if (UUID.test(String(req.params.id || ""))) return true;
    res.status(404).json({ error: "Receipt not found" });
    return false;
  };

  // Attach: the files are already uploaded as Documents; this records the receipt that groups them. Nothing is read yet.
  app.post("/api/receipts", requireSession, requireEditAccess, async (req, res, next) => {
    try {
      const wanted = documentList(req.body && req.body.documents);
      if (!wanted.length) return res.status(400).json({ error: "Add at least one receipt photo or PDF" });
      const found = await findDocuments(req, wanted.map((doc) => doc.documentId));
      if (found.length !== wanted.length) return res.status(400).json({ error: "One of the receipt files could not be found" });
      const documents = wanted.map((doc) => { const stored = found.find((item) => item.id === doc.documentId); return { ...doc, name: stored.name || doc.name, contentType: stored.content_type || doc.contentType }; });
      res.status(201).json({ receipt: toClient(await store.create(householdOf(req), req.sessionUser.id, documents)) });
    } catch (error) { next(error); }
  });

  app.get("/api/receipts", requireSession, async (req, res, next) => {
    try {
      const rows = await store.list(householdOf(req), 500);
      res.json({ receipts: rows.map((row) => { const receipt = toClient(row); return { id: receipt.id, merchant: receipt.merchant, date: receipt.date, total: receipt.total, itemCount: receipt.items.length, status: receipt.status }; }) });
    } catch (error) { next(error); }
  });

  app.get("/api/receipts/:id", requireSession, async (req, res, next) => {
    try {
      if (!validId(req, res)) return;
      const row = await store.get(householdOf(req), req.params.id);
      if (!row) return res.status(404).json({ error: "Receipt not found" });
      res.json({ receipt: toClient(row) });
    } catch (error) { next(error); }
  });

  // Read (or read again): the AI turns the stored photos into items. The page sends the photos too when it still has them; otherwise they are
  // read back from storage. The files stay attached whatever happens here.
  app.post("/api/receipts/:id/read", requireSession, requireEditAccess, async (req, res, next) => {
    try {
      if (!validId(req, res)) return;
      const row = await store.get(householdOf(req), req.params.id);
      if (!row) return res.status(404).json({ error: "Receipt not found" });
      if (!aiConfigured) return res.status(503).json({ error: "AI receipt reading is not configured for this deployment" });
      let files;
      if (Array.isArray(req.body && req.body.images) && req.body.images.length) {
        const checked = validateReceiptReadRequest(req.body);
        if (checked.error) return res.status(400).json({ error: checked.error });
        files = checked.files;
      } else {
        const docs = await findDocuments(req, row.documents.map((doc) => doc.documentId));
        files = docs.length ? await loadDocumentFiles(docs) : null;
        if (!files || !files.length) return res.status(409).json({ error: "The receipt file could not be read back from storage. Remove the receipt and attach it again." });
      }
      if (!limiter.take(req.sessionUser.id)) return res.status(429).json({ error: "You have read many receipts in the last hour - try again a little later" });
      let draft;
      try { draft = await readReceipt(files); } catch (error) {
        if (error && error.userMessage) return res.status(error.statusCode || 503).json({ error: error.userMessage });
        if (error && error.statusCode) return res.status(error.statusCode).json({ error: error.message });
        throw error;
      }
      const updated = await store.update(householdOf(req), row.id, { ...draft, status: "read", readAt: new Date().toISOString() });
      res.json({ receipt: toClient(updated) });
    } catch (error) { next(error); }
  });

  // The person's own corrections to what was read (or entering items by hand).
  app.patch("/api/receipts/:id", requireSession, requireEditAccess, async (req, res, next) => {
    try {
      if (!validId(req, res)) return;
      const row = await store.get(householdOf(req), req.params.id);
      if (!row) return res.status(404).json({ error: "Receipt not found" });
      const fields = cleanReceiptFields(req.body || {});
      const updated = await store.update(householdOf(req), row.id, { ...fields, status: fields.items.length ? "read" : row.status, readAt: row.readAt || (fields.items.length ? new Date().toISOString() : null) });
      res.json({ receipt: toClient(updated) });
    } catch (error) { next(error); }
  });

  // Removes the receipt record; the page then deletes the attached files (the same way Decisions attachments are removed).
  app.delete("/api/receipts/:id", requireSession, requireEditAccess, async (req, res, next) => {
    try {
      if (!validId(req, res)) return;
      const removed = await store.remove(householdOf(req), req.params.id);
      if (!removed) return res.status(404).json({ error: "Receipt not found" });
      res.json({ deleted: true, documents: (removed.documents || []).map((doc) => doc.documentId) });
    } catch (error) { next(error); }
  });
}

module.exports = { registerReceiptRoutes, createReceiptStore };
