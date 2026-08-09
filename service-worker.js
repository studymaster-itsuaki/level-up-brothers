const CACHE_VERSION = "lub-beta8-pwa-fcm-v9";
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

function parsePushData(eventData) {
  if (!eventData) return {};
  let payload;
  try {
    payload = eventData.json();
  } catch {
    return { body: eventData.text() };
  }

  let data = payload?.data || payload || {};
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = { body: data };
    }
  }
  if (typeof data?.data === "string") {
    try {
      data = { ...data, ...JSON.parse(data.data) };
    } catch {
      // 通常の文字列データはそのまま利用する。
    }
  }

  return {
    ...data,
    title: data.title || payload?.notification?.title || "Level Up Brothers",
    body: data.body || payload?.notification?.body || "",
    url: data.url || payload?.fcmOptions?.link || payload?.webpush?.fcmOptions?.link || "./"
  };
}

async function tellOpenClients(data) {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });
  windows.forEach(client => client.postMessage({
    type: "LUB_PUSH_RECEIVED",
    data
  }));
}

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    const data = parsePushData(event.data);
    const uniqueId = data.recordId || data.paymentId || Date.now().toString();
    const notificationData = {
      url: data.url || "./",
      type: data.type || "",
      recordId: data.recordId || "",
      paymentId: data.paymentId || "",
      childId: data.childId || ""
    };

    console.info("[LUB SW] FCM push received", {
      type: notificationData.type,
      recordId: notificationData.recordId,
      paymentId: notificationData.paymentId
    });

    try {
      await self.registration.showNotification(
        data.title || "Level Up Brothers",
        {
          body: data.body || "新しいお知らせがあります。",
          icon: new URL("./assets/icons/icon-192.png", self.registration.scope).href,
          badge: new URL("./assets/icons/icon-192.png", self.registration.scope).href,
          tag: `lub-${notificationData.type || "notice"}-${uniqueId}`,
          renotify: false,
          silent: false,
          data: notificationData
        }
      );
      console.info("[LUB SW] showNotification completed", {
        tag: `lub-${notificationData.type || "notice"}-${uniqueId}`
      });
    } catch (error) {
      console.error("[LUB SW] showNotification failed", error);
      throw error;
    } finally {
      await tellOpenClients({
        ...notificationData,
        title: data.title || "Level Up Brothers",
        body: data.body || "新しいお知らせがあります。"
      });
    }
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
      await existing.focus();
      existing.postMessage({
        type: "LUB_NOTIFICATION_CLICK",
        url: targetUrl
      });
      return;
    }
    return self.clients.openWindow(targetUrl);
  })());
});
