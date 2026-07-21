const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer } = require("./helpers");

let server;

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

async function signUp(email) {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "Statement-Owner-Password-123!", name: "Statement Owner", householdName: "Statement Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  return signup.cookie;
}

test("bank statement PDF parsing requires a session", async () => {
  const response = await server.request("/api/bank-statement/parse-pdf", {
    method: "POST",
    body: JSON.stringify({ fileBase64: Buffer.from("not a pdf").toString("base64") })
  });
  assert.equal(response.status, 401);
});

test("rejects a request with no file", async () => {
  const cookie = await signUp("statement-owner-1@example.com");
  const response = await server.request("/api/bank-statement/parse-pdf", { method: "POST", headers: { cookie }, body: JSON.stringify({}) });
  assert.equal(response.status, 400);
});

test("rejects a file that is not a real PDF with a friendly error, not a crash", async () => {
  const cookie = await signUp("statement-owner-2@example.com");
  const response = await server.request("/api/bank-statement/parse-pdf", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ fileBase64: Buffer.from("this is plainly not a pdf file").toString("base64") })
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /pdf/i);
});
