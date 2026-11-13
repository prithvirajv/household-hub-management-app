const test = require("node:test");
const assert = require("node:assert/strict");
const { calcDefaultSwr, calcDefaultReturn, calcSanitize, calcBalanceAfter, calcRetirement, calcCompound, calcCar, calcHouse } = require("../lib/calculators");

const near = (actual, expected, tolerance = 0.5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test("the automatic withdrawal rate falls as retirement gets longer, between the known points", () => {
  assert.equal(calcDefaultSwr(30), 4, "the familiar 4% for about thirty years");
  assert.equal(calcDefaultSwr(20), 5);
  assert.equal(calcDefaultSwr(10), 5, "shorter than the table: the top rate");
  assert.equal(calcDefaultSwr(50), 3);
  assert.equal(calcDefaultSwr(70), 3, "longer than the table: the bottom rate");
  assert.equal(calcDefaultSwr(27.5), 4.25, "halfway between 25 and 30 years");
  assert.ok(calcDefaultSwr(33) < calcDefaultSwr(28) && calcDefaultSwr(28) < calcDefaultSwr(22), "always falling");
  assert.equal(calcDefaultSwr(0), 5);
  assert.equal(calcDefaultSwr("x"), 5);
});

test("the automatic return is set from age: 10% when young, a tenth of a point less each year, 5.5% from 65", () => {
  assert.equal(calcDefaultReturn(18), 10);
  assert.equal(calcDefaultReturn(20), 10);
  assert.equal(calcDefaultReturn(21), 9.9);
  assert.equal(calcDefaultReturn(40), 8);
  assert.equal(calcDefaultReturn(65), 5.5);
  assert.equal(calcDefaultReturn(80), 5.5, "never lower than 5.5");
});

test("the form is made safe: numbers only, bounded, and a blank stays blank so the automatic value is used", () => {
  const clean = calcSanitize({ kyn: { age: "41", retireAge: 200, monthlySpend: "-5", balance: "abc", annualSaving: "", returnRate: "", swr: "4.5", advanced: 1 }, compound: { years: 500, rate: "7" } });
  assert.deepEqual([clean.kyn.age, clean.kyn.retireAge, clean.kyn.monthlySpend, clean.kyn.balance, clean.kyn.annualSaving], [41, 100, 0, null, null], "bounded; nonsense and blanks become null");
  assert.deepEqual([clean.kyn.returnRate, clean.kyn.swr, clean.kyn.advanced], [null, 4.5, true]);
  assert.deepEqual([clean.compound.years, clean.compound.rate], [80, 7]);
  assert.deepEqual(calcSanitize("junk").kyn.age, null);
  assert.deepEqual(calcSanitize(undefined).compound.years, null);
});

test("the balance grows by the return each year with a contribution added at the end of each year", () => {
  near(calcBalanceAfter(1000, 0, 10, 0, 2), 1210, 0.001);
  near(calcBalanceAfter(0, 100, 10, 0, 3), 331, 0.001, "100 + 100*1.1 + 100*1.21 = 331");
  near(calcBalanceAfter(0, 100, 0, 10, 3), 331, 0.001, "contributions that grow 10% a year, with no return: 100 + 110 + 121");
  assert.equal(calcBalanceAfter(500, 100, 7, 0, 0), 500, "no years, no change");
});

test("the retirement number is the spending at retirement, grown by inflation, divided by the withdrawal rate", () => {
  const result = calcRetirement({ age: 40, retireAge: 65, monthlySpend: 5000, balance: 100000, annualSaving: 20000 });
  assert.equal(result.ok, true);
  assert.deepEqual([result.years, result.retirementYears], [25, 30]);
  near(result.yearlySpendThen, 5000 * 12 * 1.03 ** 25, 0.01);
  near(result.number, (5000 * 12 * 1.03 ** 25) / 0.04, 0.5);
  near(result.numberToday, 60000 / 0.04, 0.5, "in today's dollars: $60,000 a year at 4% = $1.5 million");
  assert.deepEqual([result.assumptions.returnRate, result.assumptions.inflation, result.assumptions.swr, result.assumptions.lifeExpectancy], [8, 3, 4, 95], "the automatic assumptions are returned for the page to show");
  near(result.projected, calcBalanceAfter(100000, 20000, 8, 3, 25), 0.01, "saving grows with inflation unless told otherwise");
});

test("what is still needed, and the extra saving that closes it, are consistent with the projection", () => {
  const result = calcRetirement({ age: 35, retireAge: 62, monthlySpend: 6000, balance: 60000, annualSaving: 12000 });
  assert.equal(result.verdict, "behind");
  near(result.gap, result.number - result.projected, 0.01);
  assert.ok(result.extraMonthly > 0);
  // Saving that much more each month (growing like the rest) from the first year really does reach the number.
  const withExtra = calcBalanceAfter(60000, 12000 + result.extraYearly, 8.5, 3, result.years);
  const inputs = calcRetirement({ age: 35, retireAge: 62, monthlySpend: 6000, balance: 60000, annualSaving: 12000 });
  near(withExtra, calcBalanceAfter(60000, 12000 + inputs.extraYearly, inputs.assumptions.returnRate, 3, inputs.years), 0.01);
  near(calcBalanceAfter(60000, 12000 + inputs.extraYearly, inputs.assumptions.returnRate, 3, inputs.years), inputs.number, 1, "the extra closes the gap to the dollar");
});

test("on track, close and behind are told apart, and someone who is ahead needs nothing more", () => {
  const rich = calcRetirement({ age: 50, retireAge: 65, monthlySpend: 3000, balance: 2000000, annualSaving: 30000 });
  assert.deepEqual([rich.verdict, rich.gap, rich.extraMonthly, rich.fundedPercent], ["on_track", 0, 0, 100]);
  const baseline = calcRetirement({ age: 50, retireAge: 65, monthlySpend: 3000, balance: 0, annualSaving: 0 });
  const closeBalance = (baseline.number * 0.95) / (1.0 + 0) / (1 + baseline.assumptions.returnRate / 100) ** 15;
  const close = calcRetirement({ age: 50, retireAge: 65, monthlySpend: 3000, balance: closeBalance, annualSaving: 0 });
  assert.equal(close.verdict, "close", "within 10% short");
  assert.equal(baseline.verdict, "behind");
  assert.equal(baseline.fundedPercent, 0);
});

test("the age at which you would reach your number is the earliest age the savings cover that age's own need", () => {
  const result = calcRetirement({ age: 40, retireAge: 55, monthlySpend: 5000, balance: 150000, annualSaving: 25000 });
  assert.equal(result.verdict, "behind");
  assert.ok(result.reach && result.reach.age > 55, "later than wanted");
  // At the age before it the savings do not cover the need; at that age they do.
  const at = (age) => ({ built: calcBalanceAfter(150000, 25000, 8, 3, age - 40), needed: (5000 * 12 * 1.03 ** (age - 40)) / (calcDefaultSwr(95 - age) / 100) });
  assert.ok(at(result.reach.age).built >= at(result.reach.age).needed);
  assert.ok(at(result.reach.age - 1).built < at(result.reach.age - 1).needed);
  const hopeless = calcRetirement({ age: 30, retireAge: 60, monthlySpend: 20000, balance: 0, annualSaving: 500 });
  assert.equal(hopeless.reach, null, "not by 80");
  assert.equal(calcRetirement({ age: 60, retireAge: 60, monthlySpend: 1000, balance: 2000000, annualSaving: 0 }).years, 0, "retiring now has no years of saving");
});

test("a withdrawal rate above the real return is warned about, and the advanced settings are used", () => {
  const warned = calcRetirement({ age: 60, retireAge: 65, monthlySpend: 4000, balance: 500000, annualSaving: 10000, swr: 4, returnRate: 5, inflation: 3 });
  assert.equal(warned.warnWithdrawal, true, "4% withdrawal against a 2% real return");
  assert.equal(calcRetirement({ age: 40, retireAge: 65, monthlySpend: 4000, balance: 1, annualSaving: 1 }).warnWithdrawal, false);
  const custom = calcRetirement({ age: 40, retireAge: 65, monthlySpend: 4000, balance: 100000, annualSaving: 10000, inflation: 2, lifeExpectancy: 90, returnRate: 7, swr: 3.5, savingsGrowth: 0 });
  assert.deepEqual([custom.assumptions.inflation, custom.assumptions.lifeExpectancy, custom.assumptions.returnRate, custom.assumptions.swr, custom.assumptions.savingsGrowth, custom.retirementYears], [2, 90, 7, 3.5, 0, 25]);
  near(custom.projected, calcBalanceAfter(100000, 10000, 7, 0, 25), 0.01);
});

test("bad or missing inputs give a plain message instead of a number", () => {
  assert.match(calcRetirement({}).error, /Enter your age/);
  assert.match(calcRetirement({ age: 40, retireAge: 35, monthlySpend: 3000 }).error, /earlier than your age/);
  assert.match(calcRetirement({ age: 40, retireAge: 65, monthlySpend: 0 }).error, /each month in retirement/);
  assert.match(calcRetirement({ age: 40, retireAge: 65, monthlySpend: 3000, lifeExpectancy: 60 }).error, /Life expectancy/);
  assert.equal(calcRetirement(undefined).ok, false);
});

test("compound interest grows a start and a monthly saving, month by month, and splits the end into what went in and what it earned", () => {
  const result = calcCompound({ start: 10000, monthly: 500, rate: 7, years: 20 });
  assert.equal(result.ok, true);
  let balance = 10000;
  for (let month = 1; month <= 240; month += 1) balance = balance * (1 + 0.07 / 12) + 500;
  near(result.final, balance, 0.01);
  near(result.contributed, 10000 + 500 * 240, 0.001);
  near(result.interest, result.final - result.contributed, 0.001);
  assert.equal(result.rows.length, 20, "a row for every year");
  assert.deepEqual([result.rows[0].year, result.rows[19].year], [1, 20]);
  near(result.rows[19].balance, result.final, 0.001);
  assert.equal(result.finalToday, null, "no inflation given: no today's-dollars figure");
  near(calcCompound({ start: 10000, monthly: 0, rate: 0, years: 5 }).final, 10000, 0.001, "no return and no saving changes nothing");
  near(calcCompound({ start: 1000, monthly: 0, rate: 10, years: 10, inflation: 3 }).finalToday, calcCompound({ start: 1000, monthly: 0, rate: 10, years: 10 }).final / 1.03 ** 10, 0.001);
  assert.match(calcCompound({ rate: 7, years: 10 }).error, /starting amount or a monthly amount/);
  assert.match(calcCompound({ start: 1000 }).error, /yearly return and the number of years/);
});

test("the car limit is the 20/3/8 rule: the payment is 8% of monthly income, paid off in 3 years, with 20% of the price down (Money Guy's own worked example)", () => {
  // $5,000 a month before tax, 5%: $400 a month borrows $13,346, and with 20% down the car costs $16,683.
  const result = calcCar({ income: 60000, rate: 5 });
  assert.equal(result.ok, true);
  near(result.payment, 400, 0.001);
  near(result.loan, 13346, 1);
  near(result.price, 16683, 1);
  near(result.downNeeded, result.price * 0.2, 0.001);
  near(result.interest, 400 * 36 - result.loan, 0.001);
  // The payment really does pay the loan off in 36 months.
  let balance = result.loan;
  for (let month = 0; month < 36; month += 1) balance = balance * (1 + 0.05 / 12) - result.payment;
  near(balance, 0, 0.01);
  near(calcCar({ income: 60000, rate: 0 }).loan, 400 * 36, 0.001, "no interest: the payments are the loan");
});

test("payments on other cars use up part of the 8%, and a car that already takes all of it leaves no room", () => {
  const some = calcCar({ income: 60000, rate: 5, existing: 150 });
  near(some.payment, 250, 0.001);
  assert.ok(some.price < calcCar({ income: 60000, rate: 5 }).price);
  const none = calcCar({ income: 60000, rate: 5, existing: 400 });
  assert.deepEqual([none.blocked, none.price, none.payment], [true, 0, 0]);
  assert.equal(calcCar({ income: 60000, rate: 5, existing: 900 }).blocked, true, "more than the limit already");
});

test("the car down payment saved is compared with what the rule asks: enough lets you stretch, too little shrinks the car", () => {
  const base = calcCar({ income: 60000, rate: 5 });
  const enough = calcCar({ income: 60000, rate: 5, saved: 5000 });
  assert.equal(enough.savings.enough, true);
  near(enough.savings.price, base.loan + 5000, 0.001, "the loan stays and the savings go on top");
  assert.ok(enough.savings.price > base.price);
  const short = calcCar({ income: 60000, rate: 5, saved: 2000 });
  assert.equal(short.savings.enough, false);
  near(short.savings.shortfall, base.downNeeded - 2000, 0.001);
  near(short.savings.price, 10000, 0.001, "$2,000 is 20% of $10,000");
  assert.ok(short.savings.payment < base.payment, "a smaller loan, a smaller payment");
});

test("the rule can be changed, and bad car inputs give a plain message", () => {
  const custom = calcCar({ income: 120000, rate: 6, downPercent: 10, years: 4, incomePercent: 10 });
  near(custom.payment, 1000, 0.001);
  near(custom.price, custom.loan / 0.9, 0.001);
  assert.equal(custom.assumptions.years, 4);
  assert.match(calcCar({ rate: 5 }).error, /yearly income/);
  assert.match(calcCar({ income: 50000 }).error, /interest rate/);
  assert.match(calcCar({ income: 50000, rate: 5, years: 20 }).error, /1 to 10 years/);
  assert.match(calcCar({ income: 50000, rate: 5, downPercent: 100 }).error, /down payment share/);
});

test("the house limit puts the whole monthly cost (loan, tax, insurance, mortgage insurance, HOA) at 25% of monthly income", () => {
  const result = calcHouse({ income: 120000, down: 30000, rate: 6.5 });
  assert.equal(result.ok, true);
  near(result.totalBudget, 2500, 0.001);
  near(result.monthly, 2500, 0.01, "the pieces add up to exactly the budget");
  const p = result.parts;
  near(p.loan + p.tax + p.insurance + p.mortgageInsurance + p.hoa, 2500, 0.01);
  // The loan payment really is the standard 30-year payment on the loan, and the tax and insurance are a share of the price.
  const r = 0.065 / 12;
  near(p.loan, (result.loan * r) / (1 - (1 + r) ** -360), 0.01);
  near(p.tax, (result.price * 0.01) / 12, 0.01);
  near(p.insurance, (result.price * 0.005) / 12, 0.01);
  near(result.price, result.loan + 30000, 0.001);
  assert.equal(result.withMortgageInsurance, true, "under 20% down");
  near(p.mortgageInsurance, (result.loan * 0.005) / 12, 0.01);
});

test("with 20% down or more there is no mortgage insurance, and at the 20% line the price is the dearest home that needs none", () => {
  const big = calcHouse({ income: 120000, down: 150000, rate: 6.5 });
  assert.equal(big.withMortgageInsurance, false);
  assert.equal(big.parts.mortgageInsurance, 0);
  assert.ok(big.downShare >= 20);
  near(big.monthly, 2500, 0.01);
  // A down payment whose 20% line falls where insured homes cost too much and uninsured ones fit: the answer is exactly the 20% price (5 x the down payment).
  const edge = calcHouse({ income: 120000, down: 77000, rate: 6.5 });
  near(edge.price, 385000, 0.001);
  near(edge.downShare, 20, 0.0001);
  assert.equal(edge.withMortgageInsurance, false);
  assert.ok(edge.monthly < 2500, "a little under the budget: one dollar more of price would add mortgage insurance and go over it");
  const over = calcHouse({ income: 120000, down: 77000, rate: 6.5 }).price + 1;
  const r = 0.065 / 12;
  const k = r / (1 - (1 + r) ** -360);
  assert.ok((over - 77000) * (k + 0.005 / 12) + (over * 0.015) / 12 > 2500, "the next dollar really would go over");
});

test("HOA dues come out of the budget first, and a smaller or bigger set of assumptions moves the price the right way", () => {
  const base = calcHouse({ income: 120000, down: 30000, rate: 6.5 });
  const hoa = calcHouse({ income: 120000, down: 30000, rate: 6.5, hoa: 400 });
  assert.ok(hoa.price < base.price);
  near(hoa.monthly, 2500, 0.01);
  assert.equal(calcHouse({ income: 120000, down: 30000, rate: 6.5, hoa: 2600 }).blocked, true);
  assert.ok(calcHouse({ income: 120000, down: 30000, rate: 5 }).price > base.price, "a lower rate buys more");
  assert.ok(calcHouse({ income: 120000, down: 30000, rate: 6.5, years: 15 }).price < base.price, "a shorter loan has a bigger payment, so buys less");
  assert.ok(calcHouse({ income: 120000, down: 30000, rate: 6.5, propertyTax: 2 }).price < base.price);
  assert.ok(calcHouse({ income: 120000, down: 30000, rate: 6.5, mortgageInsurance: 0 }).price > base.price);
});

test("a down payment under 3% is flagged with what it would buy at 3%, and a very big down payment borrows nothing", () => {
  const thin = calcHouse({ income: 120000, down: 5000, rate: 6.5 });
  assert.equal(thin.downShort, true);
  near(thin.minDownNeeded, thin.price * 0.03, 0.001);
  near(thin.priceAtSavedDown, 5000 / 0.03, 0.001);
  assert.ok(thin.priceAtSavedDown < thin.price);
  const none = calcHouse({ income: 120000, rate: 6.5 });
  assert.equal(none.down, 0);
  assert.equal(none.downShort, true);
  const cash = calcHouse({ income: 120000, down: 2000000, rate: 6.5 });
  assert.deepEqual([cash.loan, cash.price], [0, 2000000]);
  assert.match(calcHouse({ rate: 6 }).error, /household income/);
  assert.match(calcHouse({ income: 90000 }).error, /mortgage interest rate/);
  assert.match(calcHouse({ income: 90000, rate: 6, years: 2 }).error, /5 to 40 years/);
});

test("the car and house forms are kept safe and bounded like the others", () => {
  const clean = calcSanitize({ car: { income: "60000", rate: "99", downPercent: "", advanced: 1 }, house: { income: "-5", years: 1, hoa: "abc", mortgageInsurance: "0" } });
  assert.deepEqual([clean.car.income, clean.car.rate, clean.car.downPercent, clean.car.advanced], [60000, 40, null, true]);
  assert.deepEqual([clean.house.income, clean.house.years, clean.house.hoa, clean.house.mortgageInsurance], [0, 5, null, 0], "0 stays 0 (insurance switched off), a blank stays blank");
  assert.equal(calcSanitize({}).car.income, null);
  assert.equal(calcSanitize(undefined).house.rate, null);
});
