#!/usr/bin/env node
// Layout check: opens every page of the app (a throwaway in-memory server, the demo household) at phone, tablet and laptop widths, in light and
// dark, and reports what has gone wrong on screen before anyone sees it:
//   - sideways overflow (the page is wider than the screen)            -> failure
//   - a script error or a failed request while drawing the page        -> failure
//   - tall cards with almost nothing in them                           -> warning
//   - text below WCAG AA contrast (4.5:1, 3:1 for large/bold text)     -> warning (failure with --strict)
//   - buttons smaller than 24px in either direction                    -> warning
// Usage: npm run check:layout [-- --strict] [-- --views=notes,plan] [-- --widths=375,1440] [-- --themes=dark]
// Needs the Playwright browser that `npm run test:ui` already uses (npx playwright install chromium).

const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const args = process.argv.slice(2);
const flag = (name) => (args.find((arg) => arg.startsWith(`--${name}=`)) || "").split("=")[1];
const strict = args.includes("--strict");
const only = flag("views") ? flag("views").split(",") : null;
const VIEWPORTS = [
  { name: "phone", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "small-laptop", width: 1024, height: 768 },
  { name: "laptop", width: 1440, height: 900 }
].filter((viewport) => !flag("widths") || flag("widths").split(",").map(Number).includes(viewport.width));
const THEMES = (flag("themes") ? flag("themes").split(",") : ["light", "dark"]);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

async function waitForServer(baseUrl, server) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`The test server exited early (code ${server.exitCode})`);
    try { if ((await fetch(`${baseUrl}/readyz`)).ok) return; } catch (_error) { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The test server did not become ready");
}

// Runs inside the page: everything wrong with the view that is currently drawn.
function inspectView({ strictContrast }) {
  const problems = { overflow: [], tallEmpty: [], contrast: [], small: [] };
  const clientWidth = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > clientWidth + 1) {
    // Something inside a box that scrolls on its own (a week of meals, a wide table) is fine; only what pushes the page itself counts.
    const clipped = (el) => { for (let node = el.parentElement; node && node.id !== "view"; node = node.parentElement) { const x = getComputedStyle(node).overflowX; if (["auto", "scroll", "hidden", "clip"].includes(x) && node.getBoundingClientRect().right <= clientWidth + 1) return true; } return false; };
    const wide = [...document.querySelectorAll("body *")].filter((el) => el.offsetParent && el.getBoundingClientRect().right > clientWidth + 1 && !clipped(el)).slice(0, 3);
    problems.overflow.push(`page is ${document.documentElement.scrollWidth}px wide on a ${clientWidth}px screen${wide.length ? ` (${wide.map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`).join(", ")})` : ""}`);
  }
  document.querySelectorAll("#view .card").forEach((card) => {
    if (!card.offsetParent) return;
    const box = card.getBoundingClientRect();
    if (box.height > 260 && card.innerText.trim().length < 60 && !card.querySelector("canvas, svg, img, textarea, input")) problems.tallEmpty.push(`${Math.round(box.height)}px card with "${card.innerText.trim().slice(0, 30)}"`);
  });
  const canvas = document.createElement("canvas").getContext("2d");
  const rgba = (color) => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = "#000"; canvas.fillStyle = color; canvas.fillRect(0, 0, 1, 1); const d = canvas.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const luminance = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const background = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const color = rgba(getComputedStyle(node).backgroundColor);
      if (color[3] > 0) { layers.push(color); if (color[3] >= 1) break; }
    }
    let base = getComputedStyle(document.documentElement).colorScheme === "dark" ? [20, 20, 20] : [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i -= 1) { const [r, g, b, a] = layers[i]; base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)]; }
    return base;
  };
  const seen = new Set();
  document.querySelectorAll("#view *").forEach((el) => {
    if (!el.offsetParent) return;
    const text = [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join("").trim();
    // Decorative glyphs (x, arrows, drag dots), disabled controls, completed (struck) items and placeholders-only boxes are muted on purpose.
    if (!/[A-Za-z0-9]/.test(text) || el.closest("[aria-hidden='true'], .done, .note-completed, [disabled]")) return;
    const style = getComputedStyle(el);
    const fg = rgba(style.color);
    const bg = background(el);
    const mixed = [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3])];
    const l1 = luminance(mixed); const l2 = luminance(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(style.fontSize);
    const needed = size >= 18.66 || (size >= 14 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
    const key = `${el.tagName}.${String(el.className).split(" ")[0]}|${text.slice(0, 18)}`;
    if (ratio < needed && !seen.has(key)) { seen.add(key); problems.contrast.push(`${ratio.toFixed(2)}:1 ${key}`); }
  });
  document.querySelectorAll("#view button, #view summary").forEach((el) => {
    if (!el.offsetParent) return;
    const box = el.getBoundingClientRect();
    if ((box.width < 24 || box.height < 24) && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).opacity !== "0") problems.small.push(`${Math.round(box.width)}x${Math.round(box.height)} ${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 18)}"`);
  });
  if (!strictContrast) problems.contrast = problems.contrast.slice(0, 6);
  problems.tallEmpty = problems.tallEmpty.slice(0, 3);
  problems.small = [...new Set(problems.small)].slice(0, 4);
  return problems;
}

async function main() {
  let chromium;
  try { ({ chromium } = require("playwright-core")); } catch (_error) { console.error("playwright-core is not installed (npm install)."); process.exit(2); }
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), MEMORY_DB: "true", NODE_ENV: "test", SESSION_SECRET: "layout-check-session-secret-with-enough-entropy", APP_BASE_URL: baseUrl, SMTP_HOST: "" },
    stdio: ["ignore", "ignore", "ignore"]
  });
  let browser;
  const failures = [];
  const warnings = [];
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch();
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: theme });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(`script error: ${error.message}`));
        page.on("requestfailed", (request) => { if (!/favicon|fonts\./.test(request.url())) errors.push(`request failed: ${request.url().slice(0, 80)}`); });
        await page.goto(`${baseUrl}/index.html`); // "/" is the public landing page; the app itself is index.html
        await page.click("#demoLoginButton"); // the page's own "Try the demo" button: the same way a person gets in
        await page.waitForSelector("#workspace:not([hidden])", { timeout: 15000 });
        await page.evaluate((wanted) => { document.documentElement.dataset.theme = wanted; }, theme);
        const views = await page.evaluate(() => views.map((view) => view[0]));
        for (const view of views.filter((name) => !only || only.includes(name))) {
          errors.length = 0;
          await page.evaluate((name) => { currentView = name; render(); }, view);
          await page.waitForTimeout(350);
          const problems = await page.evaluate(inspectView, { strictContrast: strict });
          const where = `${view} @ ${viewport.name} ${viewport.width}px, ${theme}`;
          problems.overflow.forEach((item) => failures.push(`${where}: ${item}`));
          errors.forEach((item) => failures.push(`${where}: ${item}`));
          problems.contrast.forEach((item) => (strict ? failures : warnings).push(`${where}: contrast ${item}`));
          problems.tallEmpty.forEach((item) => warnings.push(`${where}: ${item}`));
          problems.small.forEach((item) => warnings.push(`${where}: small target ${item}`));
        }
        // Speed: Notes with 100 notes of six checklist items each must draw in under 1.5s (a CSS multi-column board once took 15s for this).
        if (viewport.width === 1440 && theme === "light" && (!only || only.includes("notes"))) {
          const ms = await page.evaluate(() => {
            const make = (i) => ({ id: `perf-${i}`, title: `Note ${i}`, body: "", color: "#ffffff", pinned: false, archived: false, trashed: false, labels: [], showChecklist: true, createdAt: new Date(Date.now() - i * 60000).toISOString(), checklist: Array.from({ length: 6 }, (_, k) => ({ id: `it${i}_${k}`, text: `Checklist item ${k} of note ${i}`, done: k === 5, parentId: "" })), reminder: "" });
            state.notes.entries = Array.from({ length: 100 }, (_, i) => make(i));
            currentView = "notes"; notesRowLimit = 30;
            const start = performance.now(); render();
            return Math.round(performance.now() - start);
          });
          console.log(`speed Notes with 100 notes: ${ms}ms`);
          if (ms > 1500) failures.push(`notes @ laptop: drawing 100 notes took ${ms}ms (limit 1500ms)`);
        }
        await context.close();
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGTERM");
  }
  warnings.slice(0, 40).forEach((line) => console.log(`warn  ${line}`));
  if (warnings.length > 40) console.log(`warn  ... and ${warnings.length - 40} more`);
  failures.forEach((line) => console.log(`FAIL  ${line}`));
  console.log(`\nLayout check: ${failures.length} failure${failures.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"} (${VIEWPORTS.length} widths x ${THEMES.length} themes).`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => { console.error(error.message || error); process.exit(2); });
