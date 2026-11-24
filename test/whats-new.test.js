const test = require("node:test");
const assert = require("node:assert/strict");
const { whatsNewVisible } = require("../lib/shared-logic");

const release = { id: "2026-11-23", releasedAt: "2026-11-24T00:00:00" };

test("the card shows to people whose account existed before the release, until they dismiss it", () => {
  assert.equal(whatsNewVisible({ seenId: "", createdAt: "2026-10-01T10:00:00Z", release }), true);
  assert.equal(whatsNewVisible({ seenId: "2026-11-23", createdAt: "2026-10-01T10:00:00Z", release }), false, "dismissed");
  assert.equal(whatsNewVisible({ seenId: "2026-09-01", createdAt: "2026-10-01T10:00:00Z", release }), true, "an older note was seen, this one was not");
});

test("someone who signs up after the release is not shown what changed", () => {
  assert.equal(whatsNewVisible({ seenId: "", createdAt: "2026-12-05T10:00:00Z", release }), false);
});

test("without a creation date or a valid release it errs on showing, and with no release it shows nothing", () => {
  assert.equal(whatsNewVisible({ seenId: "", createdAt: null, release }), true);
  assert.equal(whatsNewVisible({ seenId: "", createdAt: "2026-10-01", release: null }), false);
});
