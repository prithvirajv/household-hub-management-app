const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer } = require("./helpers");

let server;

test.before(async () => {
  server = await startTestServer({ TEST_EXPOSE_NOTIFICATIONS: "true" });
});
test.after(async () => { await server.stop(); });

async function jobsFor(sourceId) {
  const jobs = await server.request("/api/test/notification-jobs");
  assert.equal(jobs.status, 200);
  return jobs.body.filter((job) => job.source_id === sourceId);
}

test("saving state syncs notification jobs without duplicating unchanged reminders", async () => {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "reminder-owner@example.com", password: "Reminder-Owner-Password-123!", name: "Reminder Owner", householdName: "Reminder Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  const cookie = signup.cookie;

  const initialState = await server.request("/api/state", { headers: { cookie } });
  assert.equal(initialState.status, 200);
  const state = initialState.body;

  const pastDueAt = new Date(Date.now() - 60_000).toISOString();
  state.calendar.events = [{ id: "evt-reminder-1", title: "Past due event", type: "event", owner: "reminder-owner@example.com", notifyAt: pastDueAt }];

  const firstSave = await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) });
  assert.equal(firstSave.status, 200);

  let jobs = await jobsFor("evt-reminder-1");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].due_at ? new Date(jobs[0].due_at).toISOString() : null, pastDueAt);
  assert.equal(jobs[0].sent_at, null);

  const secondSave = await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) });
  assert.equal(secondSave.status, 200);

  jobs = await jobsFor("evt-reminder-1");
  assert.equal(jobs.length, 1, "resaving unchanged state should not duplicate the reminder job");

  const newDueAt = new Date(Date.now() - 30_000).toISOString();
  state.calendar.events[0].notifyAt = newDueAt;
  const thirdSave = await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) });
  assert.equal(thirdSave.status, 200);

  jobs = await jobsFor("evt-reminder-1");
  assert.equal(jobs.length, 1, "changing notifyAt should replace, not add, the reminder job");
  assert.equal(new Date(jobs[0].due_at).toISOString(), newDueAt);
});
