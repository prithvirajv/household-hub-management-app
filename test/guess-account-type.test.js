const assert = require("node:assert/strict");
const test = require("node:test");
const { guessAccountType } = require("../lib/shared-logic.js");

const guess = (orgName, name, balance = null) => guessAccountType({ orgName, name, balance });

test("retirement, brokerage and education-savings accounts are guessed as Investment", () => {
  assert.equal(guess("Vanguard", "Brokerage Account"), "investment");
  assert.equal(guess("Vanguard", "Traditional"), "investment", "the institution alone is enough");
  assert.equal(guess("Employer plan", "401(k)"), "investment");
  assert.equal(guess("", "Roth IRA"), "investment");
  assert.equal(guess("State plan", "College 529"), "investment");
});

test("cards, savings and checking are recognised from their words", () => {
  assert.equal(guess("Capital One", "Quicksilver (6479)"), "credit_card");
  assert.equal(guess("Apple", "Apple Card"), "credit_card");
  assert.equal(guess("Bank of America", "Platinum Plus Mastercard"), "credit_card");
  assert.equal(guess("Discover", "Online Savings"), "savings", "savings beats the card issuer's name");
  assert.equal(guess("DCU", "Free Checking"), "checking");
});

test("an explicit word beats the institution, and a negative balance is the last hint for a card", () => {
  assert.equal(guess("Schwab", "Bank Savings"), "savings");
  assert.equal(guess("Schwab", "Investor Checking"), "checking");
  assert.equal(guess("Some Bank", "Account 1234", -250.5), "credit_card");
  assert.equal(guess("Some Bank", "Account 1234", 250.5), "checking");
  assert.equal(guess("Some Bank", "Account 1234", null), "checking");
  assert.equal(guessAccountType(), "checking");
});
