const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { startTestServer } = require("./helpers");

const NOTIFICATION_SECRET = "test-notification-secret-value";

let server;

test.before(async () => {
  server = await startTestServer({ NOTIFICATION_SECRET, TEST_EXPOSE_NOTIFICATIONS: "true" });
});
test.after(async () => { await server.stop(); });

async function signupAndSeedPastDueEvent(email, eventId) {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "Process-Owner-Password-123!", name: "Process Owner", householdName: `Household ${eventId}`, country: "US" })
  });
  assert.equal(signup.status, 201);
  const cookie = signup.cookie;
  const current = await server.request("/api/state", { headers: { cookie } });
  const state = current.body;
  state.calendar.events = [{ id: eventId, title: `Reminder ${eventId}`, type: "event", owner: email, notifyAt: new Date(Date.now() - 60_000).toISOString() }];
  const save = await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) });
  assert.equal(save.status, 200);
  return cookie;
}

async function jobFor(eventId) {
  const jobs = await server.request("/api/test/notification-jobs");
  return jobs.body.find((job) => job.source_id === eventId);
}

test("processing endpoint requires the notification secret", async () => {
  const noHeader = await server.request("/api/internal/notifications/process", { method: "POST", body: "{}" });
  assert.equal(noHeader.status, 401);

  const wrongSecret = await server.request("/api/internal/notifications/process", {
    method: "POST",
    headers: { authorization: "Bearer wrong-secret" },
    body: "{}"
  });
  assert.equal(wrongSecret.status, 401);
});

test("processing endpoint is disabled when NOTIFICATION_SECRET is unset", async () => {
  const unconfigured = await startTestServer({ NOTIFICATION_SECRET: "" });
  try {
    const response = await unconfigured.request("/api/internal/notifications/process", {
      method: "POST",
      headers: { authorization: "Bearer anything" },
      body: "{}"
    });
    assert.equal(response.status, 503);
  } finally {
    await unconfigured.stop();
  }
});

test("a past-due job is sent, marked sent, and not double-processed on the next run", async () => {
  await signupAndSeedPastDueEvent("process-owner-1@example.com", "evt-process-1");

  const firstRun = await server.request("/api/internal/notifications/process", {
    method: "POST",
    headers: { authorization: `Bearer ${NOTIFICATION_SECRET}` },
    body: "{}"
  });
  assert.equal(firstRun.status, 200);
  assert.ok(firstRun.body.sent >= 1);

  const jobAfterFirstRun = await jobFor("evt-process-1");
  assert.ok(jobAfterFirstRun.sent_at, "job should be marked sent after successful processing");

  const secondRun = await server.request("/api/internal/notifications/process", {
    method: "POST",
    headers: { authorization: `Bearer ${NOTIFICATION_SECRET}` },
    body: "{}"
  });
  assert.equal(secondRun.status, 200);

  const jobAfterSecondRun = await jobFor("evt-process-1");
  assert.equal(jobAfterSecondRun.sent_at, jobAfterFirstRun.sent_at, "job should not be reprocessed once sent");
});

test("a weekly chores next occurrence still gets a reminder even if no client reopens the app to advance it", async () => {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "chore-rollover-owner@example.com", password: "Chore-Rollover-Password-123!", name: "Chore Rollover Owner", householdName: "Chore Rollover Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  const cookie = signup.cookie;

  const current = await server.request("/api/state", { headers: { cookie } });
  const state = current.body;
  const firstDueInstant = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const firstDueKey = firstDueInstant.toISOString().slice(0, 10);
  state.calendar.chores = [{
    id: "chore-rollover-1",
    title: "Weekly chore rollover test",
    recurrence: "weekly",
    startDate: firstDueKey,
    time: "00:00",
    assignees: [],
    completedBy: { [firstDueKey]: ["household"] },
    notifyAt: firstDueInstant.toISOString(),
    notifyAtDateKey: firstDueKey,
    notifyAtSourceTime: "00:00"
  }];
  const save = await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) });
  assert.equal(save.status, 200);

  const choreJobs = async () => {
    const jobs = await server.request("/api/test/notification-jobs");
    return jobs.body.filter((job) => job.source_id === "chore-rollover-1");
  };

  // The stored state already has the first occurrence marked complete (as a
  // real household would after checking it off), but the chore's notifyAt
  // was never advanced past that first occurrence by any client - nobody
  // reopened the app between the two due dates to recompute it. The worker
  // must discover the next (already-due) occurrence purely from the chore's
  // own recurrence rule and completion state, without any client's help.
  const run = await server.request("/api/internal/notifications/process", {
    method: "POST",
    headers: { authorization: `Bearer ${NOTIFICATION_SECRET}` },
    body: "{}"
  });
  assert.equal(run.status, 200);
  const jobs = await choreJobs();
  assert.equal(jobs.length, 2, "both the first and next occurrence get their own distinct job, discovered without any client re-saving state");
  const [earlier, later] = [...jobs].sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  assert.ok(earlier.sent_at && later.sent_at, "both occurrences are sent");
  assert.ok(new Date(later.due_at).getTime() > new Date(earlier.due_at).getTime(), "the next occurrence's due date is a week later than the first");
  assert.equal(Math.round((new Date(later.due_at) - new Date(earlier.due_at)) / 86400000), 7, "the next weekly occurrence is exactly 7 days after the first");
});

test("a future-due job is not processed", async () => {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "future-owner@example.com", password: "Future-Owner-Password-123!", name: "Future Owner", householdName: "Future Household", country: "US" })
  });
  const cookie = signup.cookie;
  const current = await server.request("/api/state", { headers: { cookie } });
  const state = current.body;
  state.calendar.events = [{ id: "evt-future-1", title: "Future reminder", type: "event", owner: "future-owner@example.com", notifyAt: new Date(Date.now() + 60 * 60_000).toISOString() }];
  await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) });

  await server.request("/api/internal/notifications/process", {
    method: "POST",
    headers: { authorization: `Bearer ${NOTIFICATION_SECRET}` },
    body: "{}"
  });

  const job = await jobFor("evt-future-1");
  assert.equal(job.sent_at, null);
  assert.equal(job.claimed_at, null);
});

test("concurrent processing calls never double-count the same due jobs", async () => {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "concurrent-owner@example.com", password: "Concurrent-Owner-Password-123!", name: "Concurrent Owner", householdName: "Concurrent Household", country: "US" })
  });
  const cookie = signup.cookie;
  const current = await server.request("/api/state", { headers: { cookie } });
  const state = current.body;
  const eventIds = ["evt-concurrent-1", "evt-concurrent-2", "evt-concurrent-3", "evt-concurrent-4", "evt-concurrent-5"];
  state.calendar.events = eventIds.map((id) => ({ id, title: `Reminder ${id}`, type: "event", owner: "concurrent-owner@example.com", notifyAt: new Date(Date.now() - 60_000).toISOString() }));
  await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) });

  const call = () => server.request("/api/internal/notifications/process", {
    method: "POST",
    headers: { authorization: `Bearer ${NOTIFICATION_SECRET}` },
    body: "{}"
  });
  const [first, second] = await Promise.all([call(), call()]);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.sent + second.body.sent, eventIds.length, "every due job should be sent exactly once across concurrent calls");

  for (const eventId of eventIds) {
    const job = await jobFor(eventId);
    assert.ok(job.sent_at, `${eventId} should end up sent`);
  }
});

test("email failures are retried up to the attempt limit, then given up on", async () => {
  const retryServer = await startTestServer({
    NOTIFICATION_SECRET,
    TEST_EXPOSE_NOTIFICATIONS: "true",
    NOTIFICATION_TEST_FORCE_EMAIL_FAILURE: "true",
    NOTIFICATION_LEASE_MS: "100",
    NOTIFICATION_MAX_ATTEMPTS: "2"
  });
  try {
    const signup = await retryServer.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "retry-owner@example.com", password: "Retry-Owner-Password-123!", name: "Retry Owner", householdName: "Retry Household", country: "US" })
    });
    const cookie = signup.cookie;
    const current = await retryServer.request("/api/state", { headers: { cookie } });
    const state = current.body;
    state.calendar.events = [{ id: "evt-retry-1", title: "Retry reminder", type: "event", owner: "retry-owner@example.com", notifyAt: new Date(Date.now() - 60_000).toISOString() }];
    await retryServer.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) });

    const process = () => retryServer.request("/api/internal/notifications/process", {
      method: "POST",
      headers: { authorization: `Bearer ${NOTIFICATION_SECRET}` },
      body: "{}"
    });
    const jobFor = async (eventId) => {
      const jobs = await retryServer.request("/api/test/notification-jobs");
      return jobs.body.find((job) => job.source_id === eventId);
    };

    const firstAttempt = await process();
    assert.equal(firstAttempt.body.retried, 1);
    assert.equal(firstAttempt.body.sent, 0);
    let job = await jobFor("evt-retry-1");
    assert.equal(job.sent_at, null);
    assert.equal(job.attempts, 1);

    const immediateRetry = await process();
    assert.equal(immediateRetry.body.processed, 0, "job should stay claimed until the lease expires");

    await new Promise((resolve) => setTimeout(resolve, 150));

    const secondAttempt = await process();
    assert.equal(secondAttempt.body.failed, 1, "job should be given up on after reaching the max attempts");
    job = await jobFor("evt-retry-1");
    assert.ok(job.sent_at, "given-up jobs are marked terminal so they stop being retried");
    assert.equal(job.attempts, 2);

    const afterGiveUp = await process();
    assert.equal(afterGiveUp.body.processed, 0);
  } finally {
    await retryServer.stop();
  }
});

test("push notifications are sent and invalid tokens are pruned", async () => {
  const receivedTokenBatches = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body || "[]");
      receivedTokenBatches.push(payload.map((item) => item.to));
      const data = payload.map((item) => (
        String(item.to).includes("invalid")
          ? { status: "error", message: "DeviceNotRegistered", details: { error: "DeviceNotRegistered" } }
          : { status: "ok", id: "receipt-id" }
      ));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;

  const pushServer = await startTestServer({
    NOTIFICATION_SECRET,
    TEST_EXPOSE_NOTIFICATIONS: "true",
    NOTIFICATION_TEST_EXPO_URL: stubUrl
  });
  try {
    const signup = await pushServer.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "push-owner@example.com", password: "Push-Owner-Password-123!", name: "Push Owner", householdName: "Push Household", country: "US" })
    });
    const cookie = signup.cookie;

    await pushServer.request("/api/push-devices", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ token: "ExponentPushToken[valid-device]", platform: "ios" })
    });
    await pushServer.request("/api/push-devices", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ token: "ExponentPushToken[invalid-device]", platform: "android" })
    });

    const current = await pushServer.request("/api/state", { headers: { cookie } });
    const state = current.body;
    state.calendar.events = [{ id: "evt-push-1", title: "Push reminder", type: "event", owner: "push-owner@example.com", notifyAt: new Date(Date.now() - 60_000).toISOString() }];
    await pushServer.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) });

    const run = await pushServer.request("/api/internal/notifications/process", {
      method: "POST",
      headers: { authorization: `Bearer ${NOTIFICATION_SECRET}` },
      body: "{}"
    });
    assert.equal(run.status, 200);
    assert.equal(run.body.pushSent, 1);
    assert.equal(run.body.pushPruned, 1);
    assert.ok(receivedTokenBatches.flat().includes("ExponentPushToken[valid-device]"));

    const devices = await pushServer.request("/api/test/push-devices");
    assert.deepEqual(devices.body.map((device) => device.token), ["ExponentPushToken[valid-device]"]);
  } finally {
    await pushServer.stop();
    await new Promise((resolve) => stub.close(resolve));
  }
});

test("a reminder is also sent as a carrier-gateway SMS when the recipient has a phone and carrier on file", async () => {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email: "sms-owner@example.com", password: "Sms-Owner-Password-123!", name: "SMS Owner", householdName: "SMS Household", country: "US",
      phone: "(555) 234-5678", carrier: "verizon"
    })
  });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.user.phone, "5552345678");
  assert.equal(signup.body.user.carrier, "verizon");
  const cookie = signup.cookie;
  const current = await server.request("/api/state", { headers: { cookie } });
  const state = current.body;
  state.calendar.events = [{ id: "evt-sms-1", title: "SMS reminder", type: "event", owner: "sms-owner@example.com", notifyAt: new Date(Date.now() - 60_000).toISOString() }];
  await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) });

  const run = await server.request("/api/internal/notifications/process", {
    method: "POST",
    headers: { authorization: `Bearer ${NOTIFICATION_SECRET}` },
    body: "{}"
  });
  assert.equal(run.status, 200);
  assert.equal(run.body.smsSent, 1);
});

test("a reminder is not sent as SMS when the recipient has no phone/carrier on file", async () => {
  await signupAndSeedPastDueEvent("no-sms-owner@example.com", "evt-no-sms-1");

  const run = await server.request("/api/internal/notifications/process", {
    method: "POST",
    headers: { authorization: `Bearer ${NOTIFICATION_SECRET}` },
    body: "{}"
  });
  assert.equal(run.status, 200);
  assert.equal(run.body.smsSent, 0);
});
