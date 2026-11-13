// Price analysis over the items read from receipts: what each product costs per unit, what you usually pay, whether the latest price is dear or cheap
// against that, and which shop is cheapest. Pure functions; the Prices page and the hints in the receipt pop-up only render them.
//
// What makes a comparison fair, and so what this does:
//  - Items are grouped by a generic product name (the AI gives one per item: "roma tomato"; older receipts fall back to the item name, tidied), the
//    same unit family (weight, volume, count or dozen: a price per lb is never compared with a price per package), and, for items sold by the package,
//    the package size ("eggs 5 dozen" is not "eggs 1 dozen"). Weighted items are compared per lb whatever the package.
//  - The price is what was PAID per unit (the line's amount after its discount, divided by the quantity), converted to one base unit
//    (oz and kg to lb, ml and litres to gal).
//  - "Dear" and "cheap" are against the average of the EARLIER purchases of the same product, by 10% and at least 5 cents a unit, so one purchase
//    is never compared with itself and a few cents on a cheap item is not news.
// Loaded as a classic script beside shared-logic.js and app.js, so every top-level name here starts with `price` / `PRICE` to stay unique.

const PRICE_DEARER_PERCENT = 10;
const PRICE_MIN_DIFFERENCE = 0.05;

// Words that say who made a product or how it is packed, not what it is (the AI's generic name already drops them; this is for older receipts).
const PRICE_FILLER = new Set(["the", "of", "and", "with", "fresh", "bag", "box", "pkg", "kirkland", "ks", "signature", "gv", "great", "value", "kroger", "marketside", "equate", "members", "mark"]);

const PRICE_UNITS = {
  lb: { family: "weight", factor: 1 }, oz: { family: "weight", factor: 1 / 16 }, kg: { family: "weight", factor: 2.20462 }, g: { family: "weight", factor: 0.00220462 },
  gal: { family: "volume", factor: 1 }, l: { family: "volume", factor: 0.264172 }, ml: { family: "volume", factor: 0.000264172 },
  each: { family: "count", factor: 1 }, ct: { family: "count", factor: 1 }, pack: { family: "count", factor: 1 }, dozen: { family: "dozen", factor: 1 }
};
const PRICE_FAMILY_LABEL = { weight: "per lb", volume: "per gal", count: "each", dozen: "per dozen" };

const priceRound = (value) => Math.round(value * 100) / 100;

// A word reduced to its singular so "bananas", "tomatoes" and "berries" match "banana", "tomato" and "berry".
function priceSingular(word) {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("oes")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

function priceWords(text) {
  return String(text || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word && !PRICE_FILLER.has(word));
}

// The package sizes written in a name ("5 dozen", "48 count", "12oz", "1.2kg"), normalised so "48ct" and "48 count" are the same.
function priceSizes(name) {
  const found = [];
  const pattern = /(\d+(?:\.\d+)?)\s*(dozen|doz|count|ct|pk|pack|fl\s*oz|oz|lbs?|kg|g|gal|ml|l)\b/gi;
  let match;
  while ((match = pattern.exec(String(name || "").toLowerCase())) !== null) {
    const unit = match[2].replace(/\s+/g, "");
    const normal = { doz: "dozen", count: "ct", pk: "pack", lbs: "lb" }[unit] || unit;
    found.push(`${Number(match[1])}${normal}`);
  }
  return found.sort();
}

// The unit family and conversion for an item's unit (an unknown unit counts as "each").
function priceUnit(unit) { return PRICE_UNITS[String(unit || "").toLowerCase()] || PRICE_UNITS.each; }

// The key that decides what an item is compared with.
function priceKey(item) {
  const unit = priceUnit(item.unit);
  const base = (item.product ? priceWords(item.product) : priceWords(item.name).filter((word) => !/\d/.test(word))).map(priceSingular).filter(Boolean).sort();
  const sizes = unit.family === "weight" || unit.family === "volume" ? [] : priceSizes(item.name);
  return `${[...base, ...sizes].join(" ") || String(item.name || "").toLowerCase().trim()}|${unit.family}`;
}

// What was paid for one base unit (per lb, per gal, each, per dozen), or null when the line cannot say.
function priceUnitPrice(item) {
  const amount = Number(item.amount);
  const quantity = Number(item.qty) * priceUnit(item.unit).factor;
  return amount > 0 && quantity > 0 ? amount / quantity : null;
}

// Words that are on a shop's name but do not tell shops apart ("Riverside International Market" and "RIVERSIDE INTL MKT" are one shop).
const PRICE_SHOP_FILLER = new Set(["market", "mkt", "international", "intl", "int", "store", "stores", "inc", "llc", "ltd", "co", "corp", "wholesale", "whse", "supercenter", "super", "center", "centre", "grocery", "foods", "food"]);

function priceShopKey(merchant) {
  return priceWords(merchant).filter((word) => !PRICE_SHOP_FILLER.has(word)).map(priceSingular).filter((word) => word.length > 2).join(" ") || "unknown";
}

const priceTitle = (text) => String(text || "").replace(/^./, (letter) => letter.toUpperCase());
const priceDay = (receipt) => String(receipt.date || String(receipt.createdAt || "").slice(0, 10) || "");

// How the latest price compares with what was paid before: { kind: "first" | "dearer" | "cheaper" | "usual", percent, average }.
function priceVerdict(latest, earlier) {
  if (!earlier.length) return { kind: "first", percent: 0, average: null };
  const average = earlier.reduce((sum, price) => sum + price, 0) / earlier.length;
  const difference = latest - average;
  const percent = Math.round((difference / average) * 100);
  const kind = Math.abs(difference) < PRICE_MIN_DIFFERENCE || Math.abs(percent) < PRICE_DEARER_PERCENT ? "usual" : (difference > 0 ? "dearer" : "cheaper");
  return { kind, percent, average: priceRound(average) };
}

// Every product bought on the receipts given ({ id, merchant, date, createdAt, items[] }): its purchases, average, range, latest price and verdict,
// and the shops compared. Newest-bought first within the chosen order by the caller.
function priceAnalyze(receipts) {
  const groups = new Map();
  (receipts || []).forEach((receipt) => {
    const day = priceDay(receipt);
    const shop = priceShopKey(receipt.merchant);
    (receipt.items || []).forEach((item) => {
      const price = priceUnitPrice(item);
      if (price === null) return;
      const key = priceKey(item);
      const unit = priceUnit(item.unit);
      if (!groups.has(key)) groups.set(key, { key, family: unit.family, unitLabel: PRICE_FAMILY_LABEL[unit.family], names: new Map(), purchases: [] });
      const group = groups.get(key);
      const shown = item.product || item.name;
      group.names.set(shown, (group.names.get(shown) || 0) + 1);
      group.purchases.push({ receiptId: receipt.id, date: day, shop, shopName: receipt.merchant || "Unknown shop", name: item.name, qty: Number(item.qty), unit: item.unit, amount: Number(item.amount), discount: Number(item.discount) || 0, price: priceRound(price), order: group.purchases.length });
    });
  });
  return [...groups.values()].map((group) => {
    group.purchases.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
    const prices = group.purchases.map((purchase) => purchase.price);
    const last = group.purchases[group.purchases.length - 1];
    const shops = new Map();
    group.purchases.forEach((purchase) => {
      const entry = shops.get(purchase.shop) || { shop: purchase.shop, shopName: purchase.shopName, prices: [] };
      entry.prices.push(purchase.price);
      shops.set(purchase.shop, entry);
    });
    const byShop = [...shops.values()].map((entry) => ({ shop: entry.shop, shopName: entry.shopName, count: entry.prices.length, average: priceRound(entry.prices.reduce((sum, price) => sum + price, 0) / entry.prices.length) })).sort((a, b) => a.average - b.average);
    const gap = byShop.length > 1 ? Math.round(((byShop[byShop.length - 1].average - byShop[0].average) / byShop[0].average) * 100) : 0;
    const label = [...group.names.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    // A packaged product shows its pack size, so "Eggs (5 dozen)" and "Eggs (1 dozen)" are not two rows that both just say "Eggs".
    const sizes = group.family === "weight" || group.family === "volume" ? [] : priceSizes(group.purchases[0].name).map((size) => size.replace(/^(\d+(?:\.\d+)?)/, "$1 "));
    return {
      key: group.key, label: `${priceTitle(label)}${sizes.length ? ` (${sizes.join(", ")})` : ""}`, family: group.family, unitLabel: group.unitLabel, purchases: group.purchases, count: prices.length,
      last, average: priceRound(prices.reduce((sum, price) => sum + price, 0) / prices.length), min: Math.min(...prices), max: Math.max(...prices),
      spent: priceRound(group.purchases.reduce((sum, purchase) => sum + purchase.amount, 0)),
      verdict: priceVerdict(last.price, prices.slice(0, -1)),
      byShop, cheapestShop: byShop.length > 1 ? byShop[0] : null, dearestShop: byShop.length > 1 ? byShop[byShop.length - 1] : null, shopGapPercent: gap
    };
  });
}

// For ONE item on ONE receipt (the pop-up's hint): how its price compares with what was paid for the same product on OTHER receipts, or null when
// there is nothing to compare with.
function priceHintFor(receipts, receiptId, item) {
  const key = priceKey(item);
  const price = priceUnitPrice(item);
  if (price === null) return null;
  const earlier = [];
  (receipts || []).forEach((receipt) => {
    if (receipt.id === receiptId) return;
    (receipt.items || []).forEach((other) => { if (priceKey(other) === key) { const otherPrice = priceUnitPrice(other); if (otherPrice !== null) earlier.push(otherPrice); } });
  });
  if (!earlier.length) return null;
  const verdict = priceVerdict(price, earlier);
  return { ...verdict, count: earlier.length, unitLabel: PRICE_FAMILY_LABEL[priceUnit(item.unit).family], price: priceRound(price) };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { priceSingular, priceWords, priceSizes, priceKey, priceUnitPrice, priceShopKey, priceVerdict, priceAnalyze, priceHintFor, PRICE_DEARER_PERCENT, PRICE_MIN_DIFFERENCE };
}
