const CACHE_VERSION = "lub-beta8-pwa-fcm-v4";
const APP_SHELL_CACHE = `${CACHE_VERSION}-app-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./js/pwa-register.js",
  "./js/notification-config.js",
  "./js/notifications.js",
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

self.addEventListener("push", event => {
  if (!event.data) return;

  event.waitUntil((async () => {
    let payload;
    try {
      payload = event.data.json();
    } catch {
      payload = { data: { body: event.data.text() } };
    }
    const data = payload.data || payload;
    const title = data.title || "Level Up Brothers";
    const body = data.body || "";
    const uniqueId = data.recordId || data.paymentId || Date.now().toString();

    await self.registration.showNotification(title, {
      body,
      icon: new URL("./assets/icons/icon-192.png", self.registration.scope).href,
      badge: new URL("./assets/icons/icon-192.png", self.registration.scope).href,
      tag: `lub-${data.type || "notice"}-${uniqueId}`,
      renotify: false,
      data: {
        url: data.url || "./",
        type: data.type || "",
        recordId: data.recordId || "",
        paymentId: data.paymentId || ""
      }
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = new URL(
    event.notification.data?.url || "./",
    self.registration.scope
  ).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });
    const existing = windows.find(client =>
      client.url.startsWith(self.registration.scope)
    );
    if (existing) {
      if ("navigate" in existing) await existing.navigate(targetUrl);
      return existing.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});
