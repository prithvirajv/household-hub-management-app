// Returns on a receipt: a refund that lands after an online order is only a single amount, so the person confirms WHICH items it was for. This finds the
// refunds that look related to a receipt (money in, the same shop, afterwards, on the same card) and suggests the items whose prices add up to a refund
// (with the receipt's tax spread over them). It only suggests: the person ticks "Returned" on the items, and the Prices page then leaves those items out.
//
// Amount convention (the whole app): a positive transaction amount is money OUT of the account, a negative one is money IN.
// Loaded as a classic script after receipt-match.js (it uses its shop-name matching), so every top-level name here starts with `receiptReturn`.

const receiptReturnShared = (typeof module !== "undefined" && module.exports)
  ? require("./receipt-match")
  : { receiptMatchSimilar, receiptMatchDays };

const RECEIPT_RETURN_WINDOW_DAYS = 120; // a refund can take weeks; beyond this it is probably something else
const RECEIPT_RETURN_MAX_SUGGESTIONS = 3;
const RECEIPT_RETURN_TRIPLES_UP_TO = 40; // looking for three items that add up is only done for a receipt this short

// What each item's price is multiplied by to include its share of the tax: the receipt's total over its subtotal (1 when it prints neither).
function receiptReturnTaxRatio(receipt) {
  const subtotal = Number(receipt && receipt.subtotal);
  const total = Number(receipt && receipt.total);
  return subtotal > 0 && total >= subtotal ? total / subtotal : 1;
}

// The refunds (ledger rows) that could be for this receipt: money in, a shop name that matches, no earlier than the receipt and within the window, and
// on the same account as the purchase when both say which. Nearest first. `purchase` is the receipt's own transaction when it has one.
function receiptReturnRefunds(receipt, transactions, purchase = null) {
  const from = (purchase && purchase.date) || (receipt && receipt.date) || "";
  if (!from) return [];
  const found = [];
  (transactions || []).forEach((transaction, index) => {
    const amount = Number(transaction.amount);
    if (!(amount < 0) || transaction === purchase) return;
    if (purchase && purchase.accountId && transaction.accountId && purchase.accountId !== transaction.accountId) return;
    if (!receiptReturnShared.receiptMatchSimilar(receipt.merchant, transaction.payee)) return;
    if (String(transaction.date) < from) return;
    const days = receiptReturnShared.receiptMatchDays(from, transaction.date);
    if (days === null || days > RECEIPT_RETURN_WINDOW_DAYS) return;
    found.push({ index, days, transaction, amount: Math.abs(amount) });
  });
  return found.sort((a, b) => a.days - b.days);
}

// Groups of items (as lists of positions, fewest items first) whose prices add up to the refund, with or without their share of the tax, to within two
// cents. Items already marked returned are not offered again.
function receiptReturnItemSets(items, refundAmount, taxRatio = 1) {
  const target = Math.round(Number(refundAmount) * 100);
  if (!(target > 0)) return [];
  const cents = [];
  (items || []).forEach((item, index) => { if (!item.returned && Number(item.amount) > 0) cents.push({ index, base: Math.round(Number(item.amount) * 100), taxed: Math.round(Number(item.amount) * taxRatio * 100) }); });
  const near = (a, b) => Math.abs(a - b) <= 2;
  const sets = [];
  const add = (picked) => { if (sets.length < RECEIPT_RETURN_MAX_SUGGESTIONS) sets.push(picked.map((entry) => entry.index)); };
  for (const entry of cents) if (near(entry.taxed, target) || near(entry.base, target)) add([entry]);
  if (sets.length < RECEIPT_RETURN_MAX_SUGGESTIONS) {
    for (let i = 0; i < cents.length; i += 1) for (let j = i + 1; j < cents.length; j += 1) {
      if (near(cents[i].taxed + cents[j].taxed, target) || near(cents[i].base + cents[j].base, target)) add([cents[i], cents[j]]);
    }
  }
  if (sets.length < RECEIPT_RETURN_MAX_SUGGESTIONS && cents.length <= RECEIPT_RETURN_TRIPLES_UP_TO) {
    for (let i = 0; i < cents.length; i += 1) for (let j = i + 1; j < cents.length; j += 1) for (let k = j + 1; k < cents.length; k += 1) {
      if (near(cents[i].taxed + cents[j].taxed + cents[k].taxed, target) || near(cents[i].base + cents[j].base + cents[k].base, target)) add([cents[i], cents[j], cents[k]]);
    }
  }
  return sets;
}

// What the items marked returned came to (their prices, before tax).
function receiptReturnedTotal(items) {
  return Math.round((items || []).filter((item) => item.returned).reduce((sum, item) => sum + (Number(item.amount) || 0), 0) * 100) / 100;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { receiptReturnTaxRatio, receiptReturnRefunds, receiptReturnItemSets, receiptReturnedTotal, RECEIPT_RETURN_WINDOW_DAYS };
}
