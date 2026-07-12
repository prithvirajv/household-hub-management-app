const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer, combineCookies } = require("./helpers");

let server;

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

test("decisions are identical regardless of which of the owner's households is selected", async () => {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "decisions-owner@example.com", password: "Decisions-Owner-Password-123!", name: "Decisions Owner", householdName: "First Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  const cookie = signup.cookie;

  const state = await server.request("/api/state", { headers: { cookie } });
  assert.deepEqual(state.body.decisions, [], "a brand new household starts with no decisions");

  const decision = {
    id: "decision-1",
    title: "Should we get a dog?",
    notes: "",
    status: "open",
    outcome: "",
    decidedAt: "",
    pros: [{ id: "pro-1", text: "Teaches responsibility", authorKey: "decisions-owner@example.com", authorName: "Decisions Owner" }],
    cons: [],
    createdAt: "2026-07-12T00:00:00.000Z"
  };
  const nextState = { ...state.body, decisions: [decision] };
  const saved = await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(nextState) });
  assert.equal(saved.status, 200);

  // Create and switch to a second household for the same owner; decisions must follow.
  const secondHousehold = await server.request("/api/households", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Second Household", country: "IN" }) });
  assert.equal(secondHousehold.status, 201);
  const combinedCookie = combineCookies(cookie, secondHousehold.cookie);

  const afterSwitch = await server.request("/api/state", { headers: { cookie: combinedCookie } });
  assert.equal(afterSwitch.status, 200);
  assert.deepEqual(afterSwitch.body.decisions, [decision], "decisions must be identical regardless of which household is selected");
  assert.notEqual(afterSwitch.body.household.country, "US", "sanity check: this really is the second (India) household, not the first");

  // Adding a decision while the second household is selected must also show up back on the first.
  const secondDecision = { ...decision, id: "decision-2", title: "Should we repaint the kitchen?" };
  const nextState2 = { ...afterSwitch.body, decisions: [decision, secondDecision] };
  const savedFromSecond = await server.request("/api/state", { method: "PUT", headers: { cookie: combinedCookie }, body: JSON.stringify(nextState2) });
  assert.equal(savedFromSecond.status, 200);

  // Re-fetch under the original (first-household) cookie - a valid check that the shared
  // bucket, not the per-household blob, was updated by the save made under the second household.
  const afterSecondSave = await server.request("/api/state", { headers: { cookie } });
  assert.deepEqual(afterSecondSave.body.decisions, [decision, secondDecision], "a decision added under the second household must also appear under the first");
});

test("decisions added by an invited household member are visible to the owner across their other households", async () => {
  const owner = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "decisions-owner-2@example.com", password: "Decisions-Owner-Password-123!", name: "Owner Two", householdName: "Shared Household", country: "US" })
  });
  assert.equal(owner.status, 201);

  const invite = await server.request("/api/households/invitations", {
    method: "POST",
    headers: { cookie: owner.cookie },
    body: JSON.stringify({ email: "decisions-member@example.com", name: "Member Two", role: "member", scopes: [] })
  });
  assert.equal(invite.status, 201);

  const accept = await server.request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({ email: "decisions-member@example.com", inviteCode: invite.body.invitation.inviteCode, password: "Decisions-Member-Password-123!" })
  });
  assert.equal(accept.status, 200);

  const memberState = await server.request("/api/state", { headers: { cookie: accept.cookie } });
  const decision = {
    id: "decision-member-1",
    title: "Should we switch daycare?",
    notes: "",
    status: "open",
    outcome: "",
    decidedAt: "",
    pros: [],
    cons: [{ id: "con-1", text: "Farther from home", authorKey: "decisions-member@example.com", authorName: "Member Two" }],
    createdAt: "2026-07-12T00:00:00.000Z"
  };
  await server.request("/api/state", { method: "PUT", headers: { cookie: accept.cookie }, body: JSON.stringify({ ...memberState.body, decisions: [decision] }) });

  const ownerState = await server.request("/api/state", { headers: { cookie: owner.cookie } });
  assert.deepEqual(ownerState.body.decisions, [decision], "the household owner must see decisions an invited member added");
});
