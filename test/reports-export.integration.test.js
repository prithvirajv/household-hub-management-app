const assert = require("node:assert/strict");
const test = require("node:test");
const ExcelJS = require("exceljs");
const { startTestServer } = require("./helpers");

let server;

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

async function signUp(email) {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "Report-Owner-Password-123!", name: "Report Owner", householdName: "Report Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  return signup.cookie;
}

async function postExport(cookie, payload) {
  const response = await fetch(`${server.baseUrl}/api/reports/export`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload)
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, buffer };
}

test("report export requires a session", async () => {
  const { status } = await postExport(null, { sheets: [{ name: "Sheet1", rows: [["a"]] }] });
  assert.equal(status, 401);
});

test("rejects a request with no sheets", async () => {
  const cookie = await signUp("report-owner-1@example.com");
  const { status, buffer } = await postExport(cookie, { sheets: [] });
  assert.equal(status, 400);
  assert.match(JSON.parse(buffer.toString()).error, /sheet/i);
});

test("rejects a sheet missing a rows array", async () => {
  const cookie = await signUp("report-owner-2@example.com");
  const { status } = await postExport(cookie, { sheets: [{ name: "Bad" }] });
  assert.equal(status, 400);
});

test("rejects a report with too many sheets", async () => {
  const cookie = await signUp("report-owner-3@example.com");
  const sheets = Array.from({ length: 41 }, (_, index) => ({ name: `Sheet${index}`, rows: [["a"]] }));
  const { status } = await postExport(cookie, { sheets });
  assert.equal(status, 400);
});

test("builds a real xlsx workbook with the right sheet names, cell values, and an embedded image", async () => {
  const cookie = await signUp("report-owner-4@example.com");
  const { status, headers, buffer } = await postExport(cookie, {
    fileName: "familyloop-transactions-2026.xlsx",
    sheets: [
      {
        name: "Jan2026",
        columnWidths: [12, 20, 10],
        rows: [["Date", "Payee", "Amount"], ["2026-01-03", "Costco", 84.21]],
        images: [{ base64: TINY_PNG_BASE64, cell: "E2", widthPx: 200, heightPx: 100 }]
      },
      { name: "Feb2026", rows: [["Date", "Payee", "Amount"], ["2026-02-14", "Publix", 42.5]] }
    ]
  });

  assert.equal(status, 200);
  assert.equal(headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.match(headers.get("content-disposition"), /familyloop-transactions-2026\.xlsx/);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Jan2026", "Feb2026"]);

  const januarySheet = workbook.worksheets[0];
  assert.equal(januarySheet.getCell("A1").value, "Date");
  assert.equal(januarySheet.getCell("B2").value, "Costco");
  assert.equal(januarySheet.getCell("C2").value, 84.21);
  assert.equal(januarySheet.getImages().length, 1, "the embedded chart image should survive the round trip");

  const februarySheet = workbook.worksheets[1];
  assert.equal(februarySheet.getCell("B2").value, "Publix");
  assert.equal(februarySheet.getImages().length, 0);
});

test("sanitizes invalid characters and de-duplicates colliding sheet names instead of throwing", async () => {
  const cookie = await signUp("report-owner-5@example.com");
  const { status, buffer } = await postExport(cookie, {
    sheets: [
      { name: "Q1/Report:2026", rows: [["a"]] },
      { name: "Q1/Report:2026", rows: [["b"]] }
    ]
  });
  assert.equal(status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  assert.equal(names.length, 2);
  assert.ok(names.every((name) => !/[*?:\\/[\]]/.test(name)));
  assert.notEqual(names[0], names[1]);
});

test("a single corrupt image is dropped without failing the whole export", async () => {
  const cookie = await signUp("report-owner-6@example.com");
  const { status, buffer } = await postExport(cookie, {
    sheets: [{ name: "Sheet1", rows: [["a"]], images: [{ base64: "not-valid-base64-png-data", cell: "B2" }] }]
  });
  assert.equal(status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.worksheets[0].getCell("A1").value, "a");
});
