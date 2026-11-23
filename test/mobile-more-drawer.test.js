const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("app.js");
const css = read("styles.css");
const html = read("index.html");

test("the bottom bar's More button opens and closes the drawer from the button itself, with the backdrop and aria state kept in step", () => {
  assert.match(app, /\$\("#mobileMoreButton"\)\.addEventListener\("click"/);
  assert.match(app, /function setMobileDrawer\(open\)[\s\S]{0,400}mobileSidebarBackdrop"\)\.hidden = !open[\s\S]{0,200}aria-expanded/);
  assert.equal((app.match(/classList\.(remove|toggle)\("mobile-sidebar-open"/g) || []).length, 1, "only setMobileDrawer touches the drawer class");
  assert.match(html, /id="mobileMoreButton"[^>]*aria-controls="sidebar"[^>]*aria-expanded="false"/);
  assert.match(html, /<aside class="sidebar" id="sidebar">/);
});

test("the bar's buttons are real touch targets: pointer cursor, no tap delay, 48px tall, clear of the home-indicator strip", () => {
  const block = css.match(/\.mobile-tab-bar-button \{[^}]*\}/)[0];
  assert.match(block, /cursor: pointer/);
  assert.match(block, /touch-action: manipulation/);
  assert.match(block, /min-height: 48px/);
  assert.match(css, /calc\(8px \+ max\(env\(safe-area-inset-bottom\), 20px\)\)/, "the bar's bottom padding clears the home-indicator strip even when the inset reads 0");
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover"/, "without this the safe-area insets are always 0");
});

test("on phones the top bar's icon buttons share one row, the month field cannot outgrow the screen, and a file's menu is capped to the room above the bottom bar", () => {
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.topbar-actions \{ flex-direction: row; flex-wrap: wrap;/);
  assert.match(css, /\.month-control input\[type="month"\] \{[^}]*max-width: 100%/);
  assert.match(app, /panel\.style\.maxHeight = `\$\{Math\.floor\(room\)\}px`; panel\.style\.overflowY = "auto"/);
  assert.match(css, /body \{\s*padding-left: env\(safe-area-inset-left\);/);
});
