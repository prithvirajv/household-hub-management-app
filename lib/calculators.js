// Planning calculators (Know your number, compound interest, car and house affordability). "Know your number" works out how much you need in retirement accounts to fund the spending you plan, whether you are on track
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
  const car = source.car && typeof source.car === "object" ? source.car : {};
  const house = source.house && typeof source.house === "object" ? source.house : {};
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
    },
    car: {
      income: calcClamp(calcFinite(car.income), 0, 1e8),
      rate: calcClamp(calcFinite(car.rate), 0, 40),
      existing: calcClamp(calcFinite(car.existing), 0, 1e6),
      saved: calcClamp(calcFinite(car.saved), 0, 1e8),
      downPercent: calcClamp(calcFinite(car.downPercent), 0, 90),
      years: calcClamp(calcFinite(car.years), 1, 10),
      incomePercent: calcClamp(calcFinite(car.incomePercent), 1, 50),
      advanced: Boolean(car.advanced)
    },
    house: {
      income: calcClamp(calcFinite(house.income), 0, 1e8),
      down: calcClamp(calcFinite(house.down), 0, 1e9),
      rate: calcClamp(calcFinite(house.rate), 0, 25),
      years: calcClamp(calcFinite(house.years), 5, 40),
      propertyTax: calcClamp(calcFinite(house.propertyTax), 0, 10),
      insurance: calcClamp(calcFinite(house.insurance), 0, 5),
      hoa: calcClamp(calcFinite(house.hoa), 0, 100000),
      mortgageInsurance: calcClamp(calcFinite(house.mortgageInsurance), 0, 5),
      incomePercent: calcClamp(calcFinite(house.incomePercent), 5, 60),
      advanced: Boolean(house.advanced)
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

// The monthly payment that pays off `loan` in `months` equal payments at a yearly rate of `ratePercent` (0% just splits the loan evenly).
function calcPaymentFactor(ratePercent, months) {
  const r = ratePercent / 100 / 12;
  return r === 0 ? 1 / months : r / (1 - (1 + r) ** -months);
}

const CALC_CAR_DEFAULTS = { downPercent: 20, years: 3, incomePercent: 8 }; // the "20/3/8" rule: 20% down, paid off in 3 years, all car payments within 8% of pre-tax income

// How much car the "20/3/8" rule lets you afford: all car payments together stay within 8% of gross monthly income, the loan is paid off in 3 years,
// and 20% of the price is paid up front. Payments you already make on other cars use up part of the 8%.
function calcCar(inputs) {
  const input = inputs || {};
  const income = calcFinite(input.income);
  const rate = calcFinite(input.rate);
  if (income === null || !(income > 0)) return { ok: false, error: "Enter your yearly income before tax." };
  if (rate === null) return { ok: false, error: "Enter the interest rate you expect on the loan." };
  const existing = calcFinite(input.existing) ?? 0;
  const saved = calcFinite(input.saved);
  const downPercent = calcFinite(input.downPercent) ?? CALC_CAR_DEFAULTS.downPercent;
  const years = calcFinite(input.years) ?? CALC_CAR_DEFAULTS.years;
  const incomePercent = calcFinite(input.incomePercent) ?? CALC_CAR_DEFAULTS.incomePercent;
  if (!(downPercent >= 0 && downPercent < 100)) return { ok: false, error: "The down payment share must be from 0% to under 100%." };
  if (!(years >= 1 && years <= 10)) return { ok: false, error: "The loan length must be from 1 to 10 years." };
  const months = Math.round(years * 12);
  const monthlyIncome = income / 12;
  const totalBudget = (monthlyIncome * incomePercent) / 100;
  const payment = Math.max(0, totalBudget - existing);
  const assumptions = { downPercent, years, incomePercent, rate };
  if (!(payment > 0)) return { ok: true, blocked: true, monthlyIncome, totalBudget, existing, payment: 0, loan: 0, price: 0, downNeeded: 0, interest: 0, assumptions };
  const loan = payment / calcPaymentFactor(rate, months);
  const price = loan / (1 - downPercent / 100);
  const downNeeded = price - loan;
  const result = { ok: true, blocked: false, monthlyIncome, totalBudget, existing, payment, loan, price, downNeeded, interest: payment * months - loan, assumptions, saved, savings: null };
  if (saved !== null) {
    if (saved >= downNeeded) {
      // More down payment than the rule asks for buys a dearer car for the same payment: the loan stays, the savings go on top of it.
      result.savings = { enough: true, price: loan + saved, downShare: saved / (loan + saved) * 100 };
    } else {
      // Not enough saved: keep the rule's share down and buy the car that the savings alone allow (a smaller loan, a lower payment).
      const priceFromSaved = downPercent > 0 ? saved / (downPercent / 100) : price;
      const smallerLoan = priceFromSaved - saved;
      result.savings = { enough: false, shortfall: downNeeded - saved, price: priceFromSaved, payment: smallerLoan * calcPaymentFactor(rate, months) };
    }
  }
  return result;
}

const CALC_HOUSE_DEFAULTS = { years: 30, propertyTax: 1, insurance: 0.5, hoa: 0, mortgageInsurance: 0.5, incomePercent: 25 }; // percents a year of the home's price (tax, insurance) or of the loan (mortgage insurance)
const CALC_HOUSE_MIN_DOWN = 3; // the least to put down on a first home, in percent of the price
const CALC_HOUSE_NO_INSURANCE_DOWN = 20; // from this share down, no mortgage insurance is charged

// How much home the "3/5/25" guide lets you afford: a down payment of at least 3% (first home; 20% on later ones), planning to stay at least 5 years,
// and the whole monthly housing cost (loan payment, property tax, insurance, mortgage insurance, HOA dues) within 25% of gross monthly income.
// The price is found from the budget: housing cost grows in a straight line with the price, so it is solved directly, not by guessing.
function calcHouse(inputs) {
  const input = inputs || {};
  const income = calcFinite(input.income);
  const rate = calcFinite(input.rate);
  if (income === null || !(income > 0)) return { ok: false, error: "Enter your yearly household income before tax." };
  if (rate === null) return { ok: false, error: "Enter the mortgage interest rate you expect." };
  const down = calcFinite(input.down) ?? 0;
  const years = calcFinite(input.years) ?? CALC_HOUSE_DEFAULTS.years;
  const propertyTax = calcFinite(input.propertyTax) ?? CALC_HOUSE_DEFAULTS.propertyTax;
  const insurance = calcFinite(input.insurance) ?? CALC_HOUSE_DEFAULTS.insurance;
  const hoa = calcFinite(input.hoa) ?? CALC_HOUSE_DEFAULTS.hoa;
  const mortgageInsurance = calcFinite(input.mortgageInsurance) ?? CALC_HOUSE_DEFAULTS.mortgageInsurance;
  const incomePercent = calcFinite(input.incomePercent) ?? CALC_HOUSE_DEFAULTS.incomePercent;
  if (!(years >= 5 && years <= 40)) return { ok: false, error: "The loan length must be from 5 to 40 years." };
  const months = Math.round(years * 12);
  const monthlyIncome = income / 12;
  const totalBudget = (monthlyIncome * incomePercent) / 100;
  const budget = totalBudget - hoa; // what is left for the loan, tax, insurance and mortgage insurance
  const assumptions = { years, propertyTax, insurance, hoa, mortgageInsurance, incomePercent, rate };
  if (!(budget > 0)) return { ok: true, blocked: true, monthlyIncome, totalBudget, hoa, price: 0, assumptions };
  const k = calcPaymentFactor(rate, months);
  const carry = (propertyTax + insurance) / 100 / 12; // tax and insurance each month, per dollar of price
  const pmi = mortgageInsurance / 100 / 12; // mortgage insurance each month, per dollar borrowed
  // Without mortgage insurance: budget = (P - down) * k + P * carry.
  let price = (budget + down * k) / (k + carry);
  const pmiFrom = down / (CALC_HOUSE_NO_INSURANCE_DOWN / 100); // at or below this price the down payment is 20% or more
  let withMortgageInsurance = false;
  if (price > pmiFrom && pmi > 0) {
    // Over that price mortgage insurance is charged on the loan: budget = (P - down) * (k + pmi) + P * carry.
    const insured = (budget + down * (k + pmi)) / (k + pmi + carry);
    if (insured >= pmiFrom) { price = insured; withMortgageInsurance = true; }
    else price = pmiFrom; // just under 20% down costs more than the budget and 20% down costs less: the dearest home with no insurance
  }
  if (down > price) price = down; // a down payment that covers the whole price borrows nothing
  const loan = Math.max(0, price - down);
  const parts = { loan: loan * k, tax: (price * propertyTax) / 100 / 12, insurance: (price * insurance) / 100 / 12, mortgageInsurance: withMortgageInsurance ? (loan * mortgageInsurance) / 100 / 12 : 0, hoa };
  const monthly = parts.loan + parts.tax + parts.insurance + parts.mortgageInsurance + parts.hoa;
  const downShare = price > 0 ? (down / price) * 100 : 100;
  const minDownNeeded = (price * CALC_HOUSE_MIN_DOWN) / 100;
  const result = { ok: true, blocked: false, monthlyIncome, totalBudget, price, loan, down, downShare, parts, monthly, withMortgageInsurance, minDownNeeded, downShort: down < minDownNeeded - 0.005, fullDownNeeded: (price * CALC_HOUSE_NO_INSURANCE_DOWN) / 100, assumptions };
  if (result.downShort) result.priceAtSavedDown = Math.min(price, down / (CALC_HOUSE_MIN_DOWN / 100)); // the dearest home 3% of which is the money saved
  return result;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { CALC_DEFAULT_INFLATION, CALC_DEFAULT_LIFE_EXPECTANCY, calcDefaultSwr, calcDefaultReturn, calcSanitize, calcBalanceAfter, calcRetirement, calcCompound, calcPaymentFactor, calcCar, calcHouse, CALC_CAR_DEFAULTS, CALC_HOUSE_DEFAULTS };
}
