// The read-only report a group's owner can share by link, for partners who have no login: a plain HTML page (no scripts) with the same figures as the
// Partners page. It shows names, amounts and descriptions the owner chose to share, never e-mail addresses, rules or the household behind the group.
const { buildPartnersStatement, partnersKindList, PARTNERS_POOL_ID } = require("../lib/partners-logic");

const PERIODS = [["all", "All time"], ["12", "Last 12 months"], ["3", "Last 3 months"], ["month", "This month"]];
const MAX_TRANSACTION_ROWS = 500;

const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (value) => usd.format(Number(value) || 0);
const signed = (value) => `<span class="${Number(value) < 0 ? "neg" : "pos"}">${Number(value) < 0 ? "-" : ""}${usd.format(Math.abs(Number(value) || 0))}</span>`;
const shortDate = (key) => {
  const [year, month, day] = String(key || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const monthLabel = (key) => {
  const [year, month] = String(key || "").split("-").map(Number);
  return year && month ? new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : key;
};

function rangeFor(period, now) {
  const current = now.toISOString().slice(0, 7);
  const back = (count) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - count + 1, 1)).toISOString().slice(0, 7);
  if (period === "month") return { fromMonth: current, toMonth: current };
  if (period === "3") return { fromMonth: back(3), toMonth: current };
  if (period === "12") return { fromMonth: back(12), toMonth: current };
  return {};
}

function renderPartnerReportHtml({ group, period = "all", showTransactions = false, now = new Date(), path = "" }) {
  const setup = group.setup || {};
  const chosen = PERIODS.some(([key]) => key === period) ? period : "all";
  const statement = buildPartnersStatement({ ...setup, accountIds: [PARTNERS_POOL_ID] }, (group.rows || []).map((row) => ({ ...row, accountId: PARTNERS_POOL_ID })), rangeFor(chosen, now));
  const kinds = partnersKindList(setup);
  const kindLabel = (id) => (kinds.find((kind) => kind.id === id) || {}).label || "";
  const propertyName = (id) => ((setup.properties || []).find((item) => item.id === id) || {}).name || "";
  const partnerName = (id) => ((setup.partners || []).find((item) => item.id === id) || {}).name || "";
  const pool = statement.pool;
  const newest = (group.rows || []).reduce((best, row) => (row.date > best ? row.date : best), "");
  const tile = (label, value, note = "") => `<div class="tile"><span>${escapeHtml(label)}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ""}</div>`;
  const propertyRows = statement.properties.map((row) => `<tr><th>${escapeHtml(row.name)}</th><td>${money(row.income)}</td><td>${money(row.loan)}</td><td>${money(row.hoa)}</td><td>${money(row.repair + row.expense)}</td><td>${signed(row.net)}</td></tr>`).join("");
  const partnerRows = statement.partners.map((row) => `<tr><th>${escapeHtml(row.name)}</th><td>${row.effectivePct.toFixed(0)}%</td><td>${money(row.contributed)}</td><td>${money(row.withdrawn)}</td><td>${signed(row.share)}</td><td>${signed(row.balance)}</td><td>${row.toSquare > 0.005 ? `<b>send ${money(row.toSquare)}</b>` : row.toSquare < -0.005 ? `receive ${money(-row.toSquare)}` : "even"}</td><td>${statement.averageShortfall > 0 ? money(row.suggested) : "-"}</td></tr>`).join("");
  const monthRows = statement.months.slice().reverse().map((row) => `<tr><th>${escapeHtml(monthLabel(row.month))}</th><td>${money(row.income)}</td><td>${money(row.expenses)}</td><td>${signed(row.net)}</td><td>${money(row.contributions)}</td><td>${money(row.withdrawals)}</td></tr>`).join("");
  const kindRows = statement.byKind.map((row) => `<tr><th>${escapeHtml(row.label)}</th><td>${row.group === "income" ? "Income" : row.group === "cost" ? "Cost" : "Partner money"}</td><td>${money(row.total)}</td></tr>`).join("");
  const entryRows = showTransactions ? statement.entries.slice(0, MAX_TRANSACTION_ROWS).map((entry) => {
    const counted = entry.kind ? [kindLabel(entry.kind), propertyName(entry.propertyId), partnerName(entry.partnerId)].filter(Boolean).join(" · ") : "not yet sorted";
    return `<tr><td>${escapeHtml(shortDate(entry.date))}</td><td class="left">${escapeHtml(String(entry.payee || "").slice(0, 90))}</td><td>${signed(entry.money)}${entry.edited ? ` <small title="The bank's own figure was ${escapeHtml(money(entry.originalMoney))}">(corrected)</small>` : ""}</td><td class="left">${escapeHtml(counted)}</td></tr>`;
  }).join("") : "";
  const periodLinks = PERIODS.map(([key, label]) => (key === chosen ? `<b>${label}</b>` : `<a href="${escapeHtml(path)}?period=${key}">${label}</a>`)).join(" · ");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(group.name)} - partners report</title>
<style>
:root { --bg: #fffdf8; --ink: #1d2a24; --muted: #6d6a60; --line: #e5dfd0; --green: #14805e; --soft: #e8f3ee; --red: #c24e4a; }
@media (prefers-color-scheme: dark) { :root { --bg: #17201c; --ink: #eef2ee; --muted: #a3aca5; --line: #2c3a33; --green: #5cc9a1; --soft: #20322a; --red: #ef8d88; } }
* { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1000px; margin: 0 auto; padding: 24px 16px 48px; } h1 { margin: 0 0 4px; font-size: 1.6rem; } h2 { margin: 28px 0 8px; font-size: 1.05rem; }
.muted { color: var(--muted); } .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 16px 0; }
.tile { background: var(--soft); border-radius: 10px; padding: 12px 14px; display: grid; gap: 2px; } .tile span { font-size: 0.7rem; font-weight: 800; text-transform: uppercase; color: var(--muted); } .tile strong { font-size: 1.25rem; } .tile small { color: var(--muted); }
.scroll { overflow-x: auto; } table { width: 100%; border-collapse: collapse; font-size: 0.9rem; } th, td { padding: 7px 10px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th:first-child, td:first-child, td.left { text-align: left; } td.left { white-space: normal; } thead th { font-size: 0.7rem; text-transform: uppercase; color: var(--muted); }
.neg { color: var(--red); font-weight: 700; } .pos { color: var(--green); font-weight: 700; } a { color: var(--green); } footer { margin-top: 32px; font-size: 0.8rem; color: var(--muted); }
</style></head><body><main>
<p class="muted" style="margin:0">Partners report, read-only</p>
<h1>${escapeHtml(group.name)}</h1>
<p class="muted">${newest ? `Latest transaction: ${escapeHtml(shortDate(newest))}. ` : ""}${periodLinks}</p>
<div class="tiles">
${tile("Rent and income in", money(pool.income))}
${tile("Loans, HOA and repairs", money(pool.expenses))}
${tile(pool.net < 0 ? "Shortfall" : "Surplus", signed(pool.net), statement.months.length ? `${money(Math.abs(pool.net) / statement.months.length)} a month on average` : "")}
${tile("Partners sent in", money(pool.contributions), pool.withdrawals ? `${money(pool.withdrawals)} withdrawn` : "")}
${group.poolBalance ? tile("Bank balance", money(group.poolBalance.amount), group.poolBalance.date ? `as of ${escapeHtml(shortDate(group.poolBalance.date))}` : "") : ""}
</div>
<h2>By property</h2><div class="scroll"><table><thead><tr><th></th><th>Rent in</th><th>Loan</th><th>HOA</th><th>Repairs and other</th><th>Result</th></tr></thead><tbody>${propertyRows}</tbody></table></div>
<h2>By partner</h2><div class="scroll"><table><thead><tr><th></th><th>Share</th><th>Sent in</th><th>Withdrawn</th><th>Share of result</th><th>Balance</th><th>To square up</th><th>Suggested a month</th></tr></thead><tbody>${partnerRows}</tbody></table></div>
<p class="muted">Balance is what a partner sent in, less what they withdrew, plus their share of the result. To square up shares the money put in by ownership: "send" means send that much more, "receive" means they put in more than their share.</p>
${kindRows ? `<h2>By category</h2><div class="scroll"><table><thead><tr><th>Category</th><th>Type</th><th>Total</th></tr></thead><tbody>${kindRows}</tbody></table></div>` : ""}
${monthRows ? `<h2>Month by month</h2><div class="scroll"><table><thead><tr><th></th><th>Income</th><th>Costs</th><th>Result</th><th>Sent in</th><th>Withdrawn</th></tr></thead><tbody>${monthRows}</tbody></table></div>` : ""}
${showTransactions ? `<h2>Transactions</h2><div class="scroll"><table><thead><tr><th>Date</th><th class="left">Description</th><th>Money in / out</th><th class="left">Counted as</th></tr></thead><tbody>${entryRows}</tbody></table></div>${statement.entries.length > MAX_TRANSACTION_ROWS ? `<p class="muted">Showing the newest ${MAX_TRANSACTION_ROWS} of ${statement.entries.length}.</p>` : ""}` : ""}
<footer>Shared read-only by the group's owner. This page changes as the group's figures change; ask the owner if you need a new link.</footer>
</main></body></html>`;
}

module.exports = { renderPartnerReportHtml, PERIODS };
