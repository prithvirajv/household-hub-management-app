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
  assert.match(css, /padding: 6px 2px calc\(10px \+ env\(safe-area-inset-bottom\)\)/);
});
