const { spawn } = require("node:child_process");
const { once } = require("node:events");

function pickPort() {
  return 43000 + Math.floor(Math.random() * 5000);
}

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      if (response.ok) return;
    } catch (_error) {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not become ready");
}

async function startTestServer(env = {}) {
  const port = pickPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      MEMORY_DB: "true",
      NODE_ENV: "test",
      SESSION_SECRET: "test-session-secret-with-sufficient-entropy",
      APP_BASE_URL: baseUrl,
      SMTP_HOST: "",
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer(baseUrl);

  return {
    baseUrl,
    async stop() {
      if (server.exitCode !== null) return;
      server.kill("SIGTERM");
      await once(server, "exit");
    },
    async request(path, options = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers || {}) }
      });
      // Mirrors the client's own api() wrapper (app.js): most endpoints are
      // JSON, but a couple (the public shared-note page) send back real
      // HTML, so tests checking those need the actual markup rather than
      // the old always-{} fallback from a failed .json() parse.
      const responseContentType = response.headers.get("content-type") || "";
      const body = responseContentType.includes("application/json")
        ? await response.json().catch(() => ({}))
        : await response.text();
      const setCookies = typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
      return {
        status: response.status,
        body,
        cookie: setCookies.map((cookie) => cookie.split(";")[0]).join("; ")
      };
    }
  };
}

function combineCookies(...cookieHeaders) {
  const cookies = new Map();
  cookieHeaders.filter(Boolean).forEach((header) => {
    header.split(";").map((item) => item.trim()).filter(Boolean).forEach((cookie) => {
      const separator = cookie.indexOf("=");
      cookies.set(cookie.slice(0, separator), cookie.slice(separator + 1));
    });
  });
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

module.exports = { startTestServer, combineCookies };
