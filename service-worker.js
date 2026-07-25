const CACHE_VERSION = "lub-beta8-pwa-v2";
const APP_SHELL_CACHE = `${CACHE_VERSION}-app-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./js/pwa-register.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-maskable-512.png",
  "./assets/icons/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then(cache => Promise.all(
        APP_SHELL.map(async path => {
          const request = new Request(path, { cache: "reload" });
          const response = await fetch(request);
          if (!response.ok) throw new Error(`Precache failed: ${path}`);
          await cache.put(request, response);
        })
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  const currentCaches = new Set([APP_SHELL_CACHE, RUNTIME_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith("lub-") && !currentCaches.has(key))
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then(cache => cache.put(request, copy));
          return response;
        })
        .catch(async () =>
          (await caches.match(request)) ||
          (await caches.match("./index.html")) ||
          caches.match("./")
        )
    );
    return;
  }

  const url = new URL(request.url);
  const isLocalAsset = url.origin === self.location.origin;
  const isFirebaseModule = url.hostname === "www.gstatic.com" &&
    url.pathname.startsWith("/firebasejs/");

  if (!isLocalAsset && !isFirebaseModule) return;

  if (isLocalAsset) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (!response.ok) throw new Error(`Request failed: ${response.status}`);
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then(cache => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Firebase SDKのバージョン付きURLは不変なので、取得済みならキャッシュを優先する。
  event.respondWith(
    caches.match(request).then(cached => {
      const update = fetch(request)
        .then(response => {
          if (response.ok || response.type === "opaque") {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || update;
    })
  );
});

/*
 * Firebase Cloud Messaging extension point:
 * When FCM is introduced, initialize Firebase Messaging in this worker and add
 * a "push" or onBackgroundMessage handler here. Keeping one worker at the app
 * scope avoids competing service-worker registrations.
 */
