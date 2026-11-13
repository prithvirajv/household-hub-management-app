// Receipt matching: a receipt uploaded before its bank charge exists waits in an inbox, and when the charge arrives this finds it. A match needs the
// SAME TOTAL (to the cent) on a money-out transaction within a few days; the shop name decides how sure it is. A link is made automatically only
// when it is certain (one candidate, the name matches, within 3 days, and no other waiting receipt wants the same transaction); anything less is
// offered as a suggestion for the person to confirm. Pure functions; the Transactions page in app.js only renders and applies them.
//
// Amount convention (the whole app): a positive transaction amount is money OUT of the account, a negative one is money IN.
// Loaded as a classic script beside shared-logic.js and app.js, so every top-level name here starts with `receiptMatch` to stay unique.

const RECEIPT_MATCH_STOPWORDS = new Set([
  "the", "store", "stores", "inc", "llc", "ltd", "co", "corp", "company", "market", "mkt", "wholesale", "whse", "supercenter", "super", "center", "centre",
  "international", "intl", "int", "of", "and", "grocery", "groceries", "foods", "food", "shop", "purchase", "pos", "debit", "card", "visa", "payment",
  "www", "com", "gas", "fuel"
]);

// The distinctive words of a shop or bank payee name: lowercase letters only (digits, store numbers and punctuation dropped), no filler words.
// "HOME-MART #4185" -> home, mart. "Big Box Wholesale" and "BIGBOX WHSE #1175" both -> bigbox/big box.
function receiptMatchTokens(text) {
  return String(text || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z\s-]/g, " ").replace(/-/g, " ").split(/\s+/)
    .filter((token) => token.length >= 3 && !RECEIPT_MATCH_STOPWORDS.has(token));
}

// Whether a receipt's shop name and a bank payee name are the same place: a shared distinctive word, or the same letters once the spaces are gone
// ("home mart" and "homemart").
function receiptMatchSimilar(a, b) {
  const first = receiptMatchTokens(a);
  const second = receiptMatchTokens(b);
  if (!first.length || !second.length) return false;
  if (first.some((x) => second.some((y) => x === y || (x.length >= 5 && y.length >= 5 && (x.startsWith(y) || y.startsWith(x)))))) return true;
  const joinedFirst = first.join("");
  const joinedSecond = second.join("");
  return joinedFirst.length >= 5 && joinedSecond.length >= 5 && (joinedFirst.includes(joinedSecond) || joinedSecond.includes(joinedFirst) || joinedFirst.slice(0, 5) === joinedSecond.slice(0, 5));
}

// Whole days between two YYYY-MM-DD dates (always >= 0), or null when either is not a date.
function receiptMatchDays(a, b) {
  const parse = (value) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || "")); return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null; };
  const x = parse(a);
  const y = parse(b);
  return x === null || y === null ? null : Math.round(Math.abs(x - y) / 86400000);
}

// How many whole cents apart two money amounts are (rounded, so 27.53 against 27.52 is exactly 1, not 1.0000000000001).
function receiptMatchCentsApart(a, b) {
  return Math.abs(Math.round(Number(a) * 100) - Math.round(Number(b) * 100));
}

const RECEIPT_MATCH_WINDOW_DAYS = 4; // a charge can post a few days after the purchase
const RECEIPT_MATCH_CERTAIN_DAYS = 3;

// The ledger rows a receipt could belong to: money out, no receipt yet, the same total to the cent, within the window. Best first (name matches,
// then nearest date). A receipt with no readable total has no candidates.
function receiptMatchCandidates(receipt, transactions) {
  const total = Number(receipt && receipt.total);
  if (receipt.total === null || receipt.total === undefined || !(total > 0)) return [];
  const found = [];
  (transactions || []).forEach((transaction, index) => {
    if ((transaction.receiptIds || []).length) return;
    const amount = Number(transaction.amount);
    if (!(amount > 0) || receiptMatchCentsApart(amount, total) > 1) return;
    const days = receiptMatchDays(receipt.date, transaction.date);
    if (days !== null && days > RECEIPT_MATCH_WINDOW_DAYS) return;
    found.push({ index, days, merchantMatch: receiptMatchSimilar(receipt.merchant, transaction.payee) });
  });
  return found.sort((x, y) => (Number(y.merchantMatch) - Number(x.merchantMatch)) || ((x.days === null ? 99 : x.days) - (y.days === null ? 99 : y.days)));
}

// For every waiting receipt: `certain` (safe to link without asking) or up to three `suggestions` (to confirm). A transaction is never certain for
// two receipts at once: if two waiting receipts want the same row, both are only suggestions.
function receiptMatchPlan(receipts, transactions) {
  const candidatesById = new Map((receipts || []).map((receipt) => [receipt.id, receiptMatchCandidates(receipt, transactions)]));
  const claimants = new Map();
  candidatesById.forEach((list, id) => list.forEach((candidate) => claimants.set(candidate.index, [...(claimants.get(candidate.index) || []), id])));
  const certain = [];
  const suggestions = {};
  (receipts || []).forEach((receipt) => {
    const list = candidatesById.get(receipt.id) || [];
    // A match the person has already undone (the receipt was detached from that transaction) is still offered, but never linked again by itself.
    const declined = list.length === 1 && ((transactions[list[0].index] || {}).receiptsDeclined || []).includes(receipt.id);
    const sure = list.length === 1 && !declined && list[0].merchantMatch && list[0].days !== null && list[0].days <= RECEIPT_MATCH_CERTAIN_DAYS && (claimants.get(list[0].index) || []).length === 1;
    if (sure) certain.push({ receiptId: receipt.id, index: list[0].index });
    else if (list.length) suggestions[receipt.id] = list.slice(0, 3);
  });
  return { certain, suggestions };
}

// Is the receipt's charge still pending at a bank? (Information only: a pending charge is not in the ledger yet.) It needs the same total, the date
// window and a matching shop name, since a pending row has nothing else to go on.
function receiptMatchPending(receipt, accounts) {
  const total = Number(receipt && receipt.total);
  if (receipt.total === null || receipt.total === undefined || !(total > 0)) return null;
  for (const account of accounts || []) {
    for (const row of account.pendingRows || []) {
      if (receiptMatchCentsApart(Number(row.amount), total) > 1) continue;
      const days = receiptMatchDays(receipt.date, row.date);
      if (days !== null && days > RECEIPT_MATCH_WINDOW_DAYS) continue;
      if (receiptMatchSimilar(receipt.merchant, row.payee)) return { accountName: account.name, payee: row.payee };
    }
  }
  return null;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { receiptMatchTokens, receiptMatchSimilar, receiptMatchDays, receiptMatchCandidates, receiptMatchPlan, receiptMatchPending, RECEIPT_MATCH_WINDOW_DAYS, RECEIPT_MATCH_CERTAIN_DAYS };
}
