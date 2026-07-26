import {
  getDoc,
  setDoc,
  doc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import {
  deleteToken,
  getMessaging,
  getToken,
  isSupported
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging.js";
import { NOTIFICATION_CONFIG } from "./notification-config.js";

let context = null;

function defaultEnabled(role) {
  return role === "admin" || role === "child";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  })[character]);
}

function getDeviceId() {
  const key = "lubNotificationDeviceId";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID?.() ||
      `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

function platformName() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "web";
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
}

function settingsRef() {
  return doc(context.db, "users", context.user.uid, "settings", "notifications");
}

function deviceRef() {
  return doc(
    context.db,
    "users",
    context.user.uid,
    "devices",
    getDeviceId()
  );
}

async function loadSettings() {
  const ref = settingsRef();
  const snapshot = await getDoc(ref);
  if (snapshot.exists()) return snapshot.data();

  const enabled = defaultEnabled(context.profile.role);
  await setDoc(ref, {
    enabled,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return { enabled };
}

async function loadDevice() {
  const snapshot = await getDoc(deviceRef());
  return snapshot.exists() ? snapshot.data() : null;
}

async function saveDevice(token, enabled) {
  const ref = deviceRef();
  const existing = await getDoc(ref);
  const data = {
    deviceId: getDeviceId(),
    token: token || null,
    platform: platformName(),
    userAgent: navigator.userAgent.slice(0, 500),
    enabled,
    updatedAt: serverTimestamp(),
    lastSeenAt: serverTimestamp()
  };
  if (!existing.exists()) data.createdAt = serverTimestamp();
  await setDoc(ref, data, { merge: true });
}

async function messagingSupport() {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    return { supported: false, reason: "このブラウザでは通知を利用できません。" };
  }
  if (platformName() === "ios" && !isStandalone()) {
    return {
      supported: false,
      reason: "iPhoneではホーム画面へ追加したアプリから設定してください。"
    };
  }
  if (!(await isSupported())) {
    return { supported: false, reason: "この環境はFirebase通知に対応していません。" };
  }
  return { supported: true, reason: "" };
}

async function registerCurrentDevice() {
  const support = await messagingSupport();
  if (!support.supported) throw new Error(support.reason);

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "通知が拒否されています。端末の設定から許可してください。"
        : "通知はまだ許可されていません。"
    );
  }

  await setDoc(settingsRef(), {
    enabled: true,
    updatedAt: serverTimestamp()
  }, { merge: true });

  const registration = await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(context.app), {
    vapidKey: NOTIFICATION_CONFIG.vapidKey,
    serviceWorkerRegistration: registration
  });
  if (!token) throw new Error("通知用の端末情報を取得できませんでした。");
  await saveDevice(token, true);
}

async function unregisterCurrentDevice() {
  const device = await loadDevice();
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      await deleteToken(getMessaging(context.app));
    }
  } finally {
    if (device) await saveDevice(null, false);
  }
}

async function refreshExistingToken() {
  const [settings, device, support] = await Promise.all([
    loadSettings(),
    loadDevice(),
    messagingSupport()
  ]);
  if (!support.supported || !settings.enabled || !device?.enabled) return;
  if (Notification.permission !== "granted") return;

  const registration = await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(context.app), {
    vapidKey: NOTIFICATION_CONFIG.vapidKey,
    serviceWorkerRegistration: registration
  });
  if (token) await saveDevice(token, true);
}

export async function initializeNotifications(nextContext) {
  context = nextContext;
  if (context.app.options.projectId !== NOTIFICATION_CONFIG.projectId) {
    console.warn("通知設定のFirebase Project IDが一致しません。");
    return;
  }
  try {
    await loadSettings();
    await refreshExistingToken();
  } catch (error) {
    console.warn("通知設定の初期化に失敗しました。", error);
  }
}

function permissionLabel(support) {
  if (!support.supported) return support.reason;
  if (Notification.permission === "granted") return "ブラウザの通知許可：許可済み";
  if (Notification.permission === "denied") return "ブラウザの通知許可：拒否済み";
  return "ブラウザの通知許可：未許可";
}

export async function showNotificationSettings(view) {
  if (!context) return;
  view.innerHTML =
    '<section class="card"><h2>通知設定</h2><div class="muted">読み込み中…</div></section>';

  try {
    const [settings, device, support] = await Promise.all([
      loadSettings(),
      loadDevice(),
      messagingSupport()
    ]);
    const deviceEnabled = Boolean(device?.enabled && device?.token);
    const canEnable = support.supported && Notification.permission !== "denied";

    view.innerHTML = `
      <section class="card">
        <h2>通知設定</h2>
        <p class="muted">申請の確認や承認結果を、この端末へお知らせします。通知は本人が有効にした端末だけに届きます。</p>
        <label class="inline-check">
          <input id="notificationUserEnabled" type="checkbox" ${settings.enabled ? "checked" : ""}>
          <span>通知を受け取る</span>
        </label>
        <div class="section-note">アカウント全体の設定です。OFFにすると、登録済みのすべての端末への通知を停止します。</div>
      </section>
      <section class="card">
        <h2>この端末</h2>
        <div id="notificationPermission" class="status">${permissionLabel(support)}</div>
        <label class="inline-check">
          <input id="notificationDeviceEnabled" type="checkbox" ${deviceEnabled ? "checked" : ""} ${!canEnable && !deviceEnabled ? "disabled" : ""}>
          <span>この端末で通知を受け取る</span>
        </label>
        ${!deviceEnabled
          ? `<button id="enableNotifications" class="primary" ${canEnable ? "" : "disabled"}>通知を有効にする</button>`
          : ""}
        ${platformName() === "ios" && !isStandalone()
          ? '<div class="status warning">Safariの共有メニューから「ホーム画面に追加」し、追加したアプリで設定してください。</div>'
          : ""}
        <div id="notificationStatus" class="status">設定を変更する場合は、上の項目を操作してください。</div>
      </section>`;

    const userToggle = document.getElementById("notificationUserEnabled");
    const deviceToggle = document.getElementById("notificationDeviceEnabled");
    const enableButton = document.getElementById("enableNotifications");
    const output = document.getElementById("notificationStatus");

    userToggle.onchange = async () => {
      userToggle.disabled = true;
      try {
        await setDoc(settingsRef(), {
          enabled: userToggle.checked,
          updatedAt: serverTimestamp()
        }, { merge: true });
        output.textContent = userToggle.checked
          ? "アカウントの通知をONにしました。"
          : "アカウントの通知をOFFにしました。";
        output.className = "status ok";
      } catch (error) {
        userToggle.checked = !userToggle.checked;
        output.textContent = `設定を保存できませんでした：${error.message}`;
        output.className = "status error";
      } finally {
        userToggle.disabled = false;
      }
    };

    deviceToggle.onchange = async () => {
      if (deviceToggle.checked) {
        deviceToggle.checked = false;
        output.textContent = "「通知を有効にする」ボタンから設定してください。";
        output.className = "status warning";
        return;
      }
      deviceToggle.disabled = true;
      output.textContent = "端末の通知を解除しています…";
      output.className = "status";
      try {
        await unregisterCurrentDevice();
        output.textContent = "この端末の通知をOFFにしました。";
        output.className = "status ok";
        document.getElementById("notificationPermission").textContent =
          permissionLabel(await messagingSupport());
      } catch (error) {
        deviceToggle.checked = true;
        output.textContent = error.message;
        output.className = "status error";
      } finally {
        deviceToggle.disabled = false;
      }
    };

    if (enableButton) enableButton.onclick = async () => {
      enableButton.disabled = true;
      output.textContent = "端末を登録しています…";
      output.className = "status";
      try {
        await registerCurrentDevice();
        userToggle.checked = true;
        deviceToggle.checked = true;
        output.textContent = "この端末の通知をONにしました。";
        output.className = "status ok";
        document.getElementById("notificationPermission").textContent =
          permissionLabel(await messagingSupport());
        enableButton.classList.add("hidden");
      } catch (error) {
        output.textContent = error.message;
        output.className = "status error";
        enableButton.disabled = false;
      }
    };
  } catch (error) {
    view.innerHTML = `<section class="card"><h2>通知設定</h2><div class="status error">${escapeHtml(error.message || error)}</div></section>`;
  }
}

export async function prepareNotificationLogout() {
  if (!context) return;
  try {
    await unregisterCurrentDevice();
  } catch (error) {
    console.warn("ログアウト時の通知解除に失敗しました。", error);
  } finally {
    context = null;
  }
}
