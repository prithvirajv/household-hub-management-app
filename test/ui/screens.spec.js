// Loads every screen behind a real session and asserts it renders without
// throwing - the exact class of bug that shipped silently for a while
// (renderMeals() crashing on a corrupted user_shared_modules row) because
// nothing exercised the client at the DOM level, only the server/API layer.
const { test, expect } = require("@playwright/test");

// Every key in app.js's `renderers` map except "admin", which redirects a
// non-admin session straight to "home" and so isn't meaningfully testable
// with the plain demo account.
const VIEWS = [
  "home", "budget", "bills", "transactions", "paychecks", "calendar",
  "notes", "journal", "plan", "documents", "decisions", "ious", "meals",
  "recipes", "goals", "wealth", "sharing", "reports", "profile", "help"
];

for (const view of VIEWS) {
  test(`${view} screen renders without console or page errors`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
    });

    const demoLogin = await page.request.post("/api/auth/demo", { data: {} });
    expect(demoLogin.ok(), "demo login should succeed").toBeTruthy();

    await page.goto(`/index.html#${view}`);
    await page.waitForFunction(
      (id) => document.getElementById(id) && document.getElementById(id).innerHTML.trim().length > 0,
      "view",
      { timeout: 10000 }
    );
    // Let any async per-view data loads (documents, sharing, calendar
    // members, wealth prices) settle before checking for errors they'd throw.
    await page.waitForTimeout(500);

    expect(errors, `unexpected errors on "${view}":\n${errors.join("\n")}`).toEqual([]);
  });
}
