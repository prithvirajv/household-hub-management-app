const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer } = require("./helpers");

let server;

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

test("calendar members are scoped to shared households and update on revoke", async () => {
  const ownerA = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "owner-a@example.com", password: "Owner-A-Password-123!", name: "Owner A", householdName: "Household A", country: "US" })
  });
  assert.equal(ownerA.status, 201);

  const ownerB = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "owner-b@example.com", password: "Owner-B-Password-123!", name: "Owner B", householdName: "Household B", country: "US" })
  });
  assert.equal(ownerB.status, 201);

  const invite = await server.request("/api/households/invitations", {
    method: "POST",
    headers: { cookie: ownerA.cookie },
    body: JSON.stringify({ email: "member-c@example.com", name: "Member C", role: "Member", scopes: [] })
  });
  assert.equal(invite.status, 201);

  const accept = await server.request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({
      email: "member-c@example.com",
      inviteCode: invite.body.invitation.inviteCode,
      password: "Member-C-Password-123!",
      name: "Member C"
    })
  });
  assert.equal(accept.status, 200);

  const membersAsOwnerA = await server.request("/api/calendar/members", { headers: { cookie: ownerA.cookie } });
  assert.equal(membersAsOwnerA.status, 200);
  assert.deepEqual(membersAsOwnerA.body.map((member) => member.email).sort(), ["member-c@example.com", "owner-a@example.com"]);

  const membersAsOwnerB = await server.request("/api/calendar/members", { headers: { cookie: ownerB.cookie } });
  assert.equal(membersAsOwnerB.status, 200);
  assert.deepEqual(membersAsOwnerB.body.map((member) => member.email), ["owner-b@example.com"]);

  const membersAsMemberC = await server.request("/api/calendar/members", { headers: { cookie: accept.cookie } });
  assert.equal(membersAsMemberC.status, 200);
  assert.deepEqual(membersAsMemberC.body.map((member) => member.email).sort(), ["member-c@example.com", "owner-a@example.com"]);

  const revoke = await server.request("/api/households/access", {
    method: "DELETE",
    headers: { cookie: ownerA.cookie },
    body: JSON.stringify({ email: "member-c@example.com" })
  });
  assert.equal(revoke.status, 200);

  const membersAfterRevoke = await server.request("/api/calendar/members", { headers: { cookie: ownerA.cookie } });
  assert.equal(membersAfterRevoke.status, 200);
  assert.deepEqual(membersAfterRevoke.body.map((member) => member.email), ["owner-a@example.com"]);
});
