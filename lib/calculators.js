// Planning calculators. "Know your number" works out how much you need in retirement accounts to fund the spending you plan, whether you are on track
// to retire when you want, and what closing a gap would take; the compound interest calculator grows a starting amount and regular saving. Pure
// functions: the Calculators page in app.js only collects the inputs and shows these results. Nothing here is advice; every result depends on the
// assumptions it returns (return, inflation, withdrawal rate, retirement length), which the page shows beside it.
//
// All percentages are given and returned as plain percent numbers (3 means 3%). Money is in dollars. "Today's dollars" means after taking inflation out.
// Loaded as a classic script beside shared-logic.js and app.js, so every top-level name here starts with `calc` / `CALC` to stay unique.

const CALC_DEFAULT_INFLATION = 3; // percent a year: about the long-run U.S. average
const CALC_DEFAULT_LIFE_EXPECTANCY = 95; // deliberately long, so the plan does not run out early
const CALC_MAX_REACH_AGE = 80; // "when would I reach my number" looks no further than this

// Safe withdrawal rate by length of retirement (years -> percent of the portfolio spent each year): the familiar 4% for about 30 years, more for
// a short retirement and less for a long one. In between, the rate is read off a straight line between the points.
const CALC_SWR_TABLE = [[20, 5], [25, 4.5], [30, 4], [35, 3.6], [40, 3.3], [45, 3.1], [50, 3]];

function calcDefaultSwr(retirementYears) {
  const years = Number(retirementYears);
  if (!(years > 0)) return CALC_SWR_TABLE[0][1];
  if (years <= CALC_SWR_TABLE[0][0]) return CALC_SWR_TABLE[0][1];
  const last = CALC_SWR_TABLE[CALC_SWR_TABLE.length - 1];
  if (years >= last[0]) return last[1];
  for (let i = 1; i < CALC_SWR_TABLE.length; i += 1) {
    const [y0, r0] = CALC_SWR_TABLE[i - 1];
    const [y1, r1] = CALC_SWR_TABLE[i];
    if (years <= y1) return Math.round((r0 + ((r1 - r0) * (years - y0)) / (y1 - y0)) * 100) / 100;
  }
  return last[1];
}

// The assumed average yearly return of the whole portfolio, set from today's age: 10% at 20 or younger, a tenth of a point less for each year older,
// down to 5.5% from 65: a younger saver can hold more stocks, an older one is assumed to hold safer things.
function calcDefaultReturn(age) {
  const years = Number(age);
  if (!(years > 20)) return 10;
  return Math.max(5.5, Math.round((10 - 0.1 * (years - 20)) * 100) / 100);
}

const calcFinite = (value) => (value === null || value === undefined || value === "" ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
const calcClamp = (value, low, high) => (value === null ? null : Math.min(high, Math.max(low, value)));
const calcRound = (value, places = 2) => { const f = 10 ** places; return Math.round(value * f) / f; };

// What the form held, made safe and bounded; a blank optional field stays null (meaning "use the automatic value").
function calcSanitize(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const kyn = source.kyn && typeof source.kyn === "object" ? source.kyn : {};
  const compound = source.compound && typeof source.compound === "object" ? source.compound : {};
  return {
    kyn: {
      age: calcClamp(calcFinite(kyn.age), 16, 100),
      retireAge: calcClamp(calcFinite(kyn.retireAge), 16, 100),
      monthlySpend: calcClamp(calcFinite(kyn.monthlySpend), 0, 1000000),
      balance: calcClamp(calcFinite(kyn.balance), 0, 1e10),
      annualSaving: calcClamp(calcFinite(kyn.annualSaving), 0, 1e8),
      inflation: calcClamp(calcFinite(kyn.inflation), -5, 20),
      lifeExpectancy: calcClamp(calcFinite(kyn.lifeExpectancy), 50, 120),
      returnRate: calcClamp(calcFinite(kyn.returnRate), -10, 30),
      swr: calcClamp(calcFinite(kyn.swr), 0.5, 15),
      savingsGrowth: calcClamp(calcFinite(kyn.savingsGrowth), -10, 20),
      advanced: Boolean(kyn.advanced)
    },
    compound: {
      start: calcClamp(calcFinite(compound.start), 0, 1e10),
      monthly: calcClamp(calcFinite(compound.monthly), 0, 1e7),
      rate: calcClamp(calcFinite(compound.rate), -10, 30),
      years: calcClamp(calcFinite(compound.years), 1, 80),
      inflation: calcClamp(calcFinite(compound.inflation), -5, 20)
    }
  };
}

// The balance after saving for `years`: it grows by the return each year, and a contribution is added at the end of the year (the first one is
// `annualSaving`, each later one grows by `growth` percent).
function calcBalanceAfter(balance, annualSaving, returnPercent, growthPercent, years) {
  let total = balance;
  for (let t = 0; t < years; t += 1) total = total * (1 + returnPercent / 100) + annualSaving * (1 + growthPercent / 100) ** t;
  return total;
}

// Know your number. `inputs`: age, retireAge, monthlySpend (in today's dollars), balance (all retirement and invested accounts), annualSaving, and the
// optional inflation, lifeExpectancy, returnRate, swr, savingsGrowth (null or missing = automatic). Returns { ok: false, error } or the whole picture.
function calcRetirement(inputs) {
  const input = inputs || {};
  const age = calcFinite(input.age);
  const retireAge = calcFinite(input.retireAge);
  const monthlySpend = calcFinite(input.monthlySpend);
  if (age === null || retireAge === null || monthlySpend === null) return { ok: false, error: "Enter your age, the age you want to retire, and what you expect to spend each month in retirement." };
  if (retireAge < age) return { ok: false, error: "The age you want to retire at is earlier than your age now." };
  if (!(monthlySpend > 0)) return { ok: false, error: "Enter what you expect to spend each month in retirement." };
  const balance = calcFinite(input.balance) ?? 0;
  const annualSaving = calcFinite(input.annualSaving) ?? 0;
  const inflation = calcFinite(input.inflation) ?? CALC_DEFAULT_INFLATION;
  const lifeExpectancy = calcFinite(input.lifeExpectancy) ?? CALC_DEFAULT_LIFE_EXPECTANCY;
  if (lifeExpectancy <= retireAge) return { ok: false, error: "Life expectancy has to be later than the age you retire." };
  const returnRate = calcFinite(input.returnRate) ?? calcDefaultReturn(age);
  const growth = calcFinite(input.savingsGrowth) ?? inflation;
  const years = Math.round(retireAge - age);
  const retirementYears = lifeExpectancy - retireAge;
  const swr = calcFinite(input.swr) ?? calcDefaultSwr(retirementYears);
  const inflate = (years_) => (1 + inflation / 100) ** years_;

  const yearlySpendThen = monthlySpend * 12 * inflate(years);
  const number = yearlySpendThen / (swr / 100);
  const projected = calcBalanceAfter(balance, annualSaving, returnRate, growth, years);
  const gap = Math.max(0, number - projected);
  // What one extra dollar saved in the first year (growing like the rest of the saving) is worth at retirement, so the extra needed can be solved for.
  let factor = 0;
  for (let t = 0; t < years; t += 1) factor += (1 + growth / 100) ** t * (1 + returnRate / 100) ** (years - 1 - t);
  const extraFirstYear = gap > 0 ? (factor > 0 ? gap / factor : gap) : 0;

  // The earliest age at which what has built up covers what retirement at THAT age needs (the need grows with inflation and the withdrawal rate
  // falls as retirement gets longer, for retiring later it is also shorter).
  let reach = null;
  for (let a = Math.ceil(age); a <= CALC_MAX_REACH_AGE && lifeExpectancy - a >= 5; a += 1) {
    const built = calcBalanceAfter(balance, annualSaving, returnRate, growth, a - age);
    const needed = (monthlySpend * 12 * inflate(a - age)) / ((calcFinite(input.swr) ?? calcDefaultSwr(lifeExpectancy - a)) / 100);
    if (built >= needed) { reach = { age: a, balance: built, balanceToday: built / inflate(a - age), needed }; break; }
  }
  const ratio = number > 0 ? projected / number : 1;
  return {
    ok: true,
    years, retirementYears,
    number, numberToday: number / inflate(years), yearlySpendThen, monthlySpendThen: yearlySpendThen / 12,
    projected, projectedToday: projected / inflate(years),
    fundedPercent: Math.min(100, Math.round(ratio * 100)),
    gap, gapToday: gap / inflate(years), extraMonthly: extraFirstYear / 12, extraYearly: extraFirstYear,
    reach,
    verdict: ratio >= 1 ? "on_track" : ratio >= 0.9 ? "close" : "behind",
    // A withdrawal rate above the real (after inflation) return slowly eats the savings: say so.
    warnWithdrawal: swr > returnRate - inflation,
    assumptions: { returnRate: calcRound(returnRate), inflation, swr: calcRound(swr), lifeExpectancy, savingsGrowth: growth, retirementYears }
  };
}

// Compound interest: a starting amount plus a regular monthly saving, compounded monthly for some years. Returns the end balance, what was put in, what
// it earned, and a row for every year; `finalToday` is the end balance in today's dollars when an inflation rate is given.
function calcCompound(inputs) {
  const input = inputs || {};
  const start = calcFinite(input.start) ?? 0;
  const monthly = calcFinite(input.monthly) ?? 0;
  const rate = calcFinite(input.rate);
  const years = calcFinite(input.years);
  if (rate === null || years === null || !(years >= 1)) return { ok: false, error: "Enter a yearly return and the number of years." };
  if (!(start > 0) && !(monthly > 0)) return { ok: false, error: "Enter a starting amount or a monthly amount to save." };
  const inflation = calcFinite(input.inflation);
  const months = Math.round(years * 12);
  const monthlyRate = rate / 100 / 12;
  let balance = start;
  let contributed = start;
  const rows = [];
  for (let month = 1; month <= months; month += 1) {
    balance = balance * (1 + monthlyRate) + monthly;
    contributed += monthly;
    if (month % 12 === 0 || month === months) rows.push({ year: Math.ceil(month / 12), balance, contributed, interest: balance - contributed });
  }
  return {
    ok: true, final: balance, contributed, interest: balance - contributed, rows,
    finalToday: inflation === null ? null : balance / (1 + inflation / 100) ** (months / 12)
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { CALC_DEFAULT_INFLATION, CALC_DEFAULT_LIFE_EXPECTANCY, calcDefaultSwr, calcDefaultReturn, calcSanitize, calcBalanceAfter, calcRetirement, calcCompound };
}
