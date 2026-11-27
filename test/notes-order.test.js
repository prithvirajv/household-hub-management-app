const test = require("node:test");
const assert = require("node:assert/strict");
const { compareNotes, reorderNotes, moveNoteBy, noteMatchLocations } = require("../lib/shared-logic");

const note = (id, extra = {}) => ({ id, title: id, createdAt: `2026-11-0${id.length}T00:00:00Z`, pinned: false, labels: [], checklist: [], ...extra });
const board = (entries) => [...entries].sort(compareNotes).map((item) => item.id);

test("a board shows pinned first, hand-placed notes in their order, and never-placed notes (new ones) above them, newest first", () => {
  const entries = [
    note("a", { createdAt: "2026-11-01T00:00:00Z", sortOrder: 0 }),
    note("b", { createdAt: "2026-11-02T00:00:00Z", sortOrder: 1 }),
    note("c", { createdAt: "2026-11-03T00:00:00Z" }),
    note("d", { createdAt: "2026-11-04T00:00:00Z" }),
    note("p", { createdAt: "2026-10-01T00:00:00Z", pinned: true })
  ];
  assert.deepEqual(board(entries), ["p", "d", "c", "a", "b"]);
});

test("without any hand-placing the order is exactly what it was: pinned, then newest first", () => {
  const entries = [note("x", { createdAt: "2026-11-01T00:00:00Z" }), note("y", { createdAt: "2026-11-05T00:00:00Z" }), note("z", { createdAt: "2026-11-03T00:00:00Z", pinned: true })];
  assert.deepEqual(board(entries), ["z", "y", "x"]);
});

test("dropping a note on another puts it just before that one, and the order is remembered on the notes", () => {
  const entries = ["a", "b", "c", "d"].map((id, index) => note(id, { createdAt: `2026-11-0${4 - index}T00:00:00Z` }));
  const shown = board(entries);
  assert.deepEqual(shown, ["a", "b", "c", "d"]);
  assert.equal(reorderNotes(entries, shown, "d", "b"), true);
  assert.deepEqual(board(entries), ["a", "d", "b", "c"]);
  assert.equal(reorderNotes(entries, board(entries), "a", ""), true, "no target: to the end");
  assert.deepEqual(board(entries), ["d", "b", "c", "a"]);
});

test("a note cannot be dropped into the other pinned group, onto itself, or onto something not shown", () => {
  const entries = [note("a", { pinned: true }), note("b"), note("c")];
  const shown = board(entries);
  assert.equal(reorderNotes(entries, shown, "b", "a"), false);
  assert.equal(reorderNotes(entries, shown, "b", "b"), false);
  assert.equal(reorderNotes(entries, shown, "b", "zzz"), false);
  assert.equal(reorderNotes(entries, shown, "missing", "b"), false);
});

test("Move earlier / later steps one place inside the same group and stops at the ends", () => {
  const entries = ["a", "b", "c"].map((id, index) => note(id, { createdAt: `2026-11-0${3 - index}T00:00:00Z` }));
  let shown = board(entries);
  assert.equal(moveNoteBy(entries, shown, "a", -1), false, "already first");
  assert.equal(moveNoteBy(entries, shown, "a", 1), true);
  assert.deepEqual(board(entries), ["b", "a", "c"]);
  shown = board(entries);
  assert.equal(moveNoteBy(entries, shown, "c", 1), false, "already last");
  assert.equal(moveNoteBy(entries, shown, "c", -1), true);
  assert.deepEqual(board(entries), ["b", "c", "a"]);
});

test("a search hint says where the term was found", () => {
  const n = note("n", { title: "Weekend Milk run", body: "buy milk", labels: ["Groceries"], checklist: [{ text: "Milk" }, { text: "Oat milk" }, { text: "Whole milk" }, { text: "Bread" }] });
  assert.deepEqual(noteMatchLocations(n, "milk"), ["title", "note text", 'item "Milk"', 'item "Oat milk"', "1 more items"]);
  assert.deepEqual(noteMatchLocations(n, "grocer"), ["label Groceries"]);
  assert.deepEqual(noteMatchLocations(n, ""), []);
  assert.deepEqual(noteMatchLocations(n, "zzz"), []);
});
