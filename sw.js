// FamilyLoop's service worker exists so the phone offers "Install app" (and lists FamilyLoop in the Share menu). It deliberately caches nothing:
// the app and its data must always come fresh from the server, so a deploy is never hidden behind a stale copy.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
