const test = require("node:test");
const assert = require("node:assert/strict");
const { calcDefaultSwr, calcDefaultReturn, calcSanitize, calcBalanceAfter, calcRetirement, calcCompound } = require("../lib/calculators");

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
