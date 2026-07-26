"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const {
  onDocumentCreated,
  onDocumentUpdated
} = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");

initializeApp();

const db = getFirestore();
const REGION = "asia-northeast1";
const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered"
]);

function defaultNotificationsEnabled(role) {
  return role === "admin" || role === "child";
}

function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? `${new Intl.NumberFormat("ja-JP").format(amount)}円`
    : "";
}

function periodLabel(value) {
  const period = String(value || "");
  if (period.endsWith("-summer")) return `${period.slice(0, 4)}年度 夏休み`;
  if (/^\d{4}-[123]$/.test(period)) {
    return `${period.slice(0, 4)}年度 ${period.slice(-1)}学期`;
  }
  return period;
}

function shortText(value, maxLength = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

async function claimEvent(eventId, kind, sourcePath) {
  const ref = db.collection("notificationEvents").doc(eventId);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists) return false;
    transaction.create(ref, {
      kind,
      sourcePath,
      status: "processing",
      createdAt: FieldValue.serverTimestamp()
    });
    return true;
  });
}

async function finishEvent(eventId, status, details = {}) {
  await db.collection("notificationEvents").doc(eventId).set({
    status,
    ...details,
    completedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

async function queryRecipientUsers(target) {
  const users = db.collection("users");
  if (target.type === "parents") {
    return users.where("role", "in", ["admin", "viewer"]).get();
  }
  if (target.type === "child") {
    return users.where("childId", "==", target.childId).get();
  }
  if (target.type === "uid") {
    const user = await users.doc(target.uid).get();
    return {
      docs: user.exists ? [user] : []
    };
  }
  return { docs: [] };
}

function matchesRecipientTarget(user, userId, target) {
  if (target.type === "parents") {
    return user.role === "admin" || user.role === "viewer";
  }
  if (target.type === "child") {
    return user.role === "child" && user.childId === target.childId;
  }
  return target.type === "uid" && userId === target.uid;
}

async function recipientDevices(target) {
  const users = await queryRecipientUsers(target);
  const recipients = [];

  for (const userDoc of users.docs) {
    const user = userDoc.data();
    if (
      user.active === false ||
      !matchesRecipientTarget(user, userDoc.id, target)
    ) continue;

    const settings = await userDoc.ref
      .collection("settings")
      .doc("notifications")
      .get();
    const userEnabled = settings.exists
      ? settings.data().enabled === true
      : defaultNotificationsEnabled(user.role);
    if (!userEnabled) continue;

    const devices = await userDoc.ref
      .collection("devices")
      .where("enabled", "==", true)
      .get();
    for (const device of devices.docs) {
      const token = device.data().token;
      if (typeof token === "string" && token) {
        recipients.push({
          token,
          ref: device.ref,
          uid: userDoc.id
        });
      }
    }
  }
  return recipients;
}

async function sendToDevices(devices, notification) {
  if (!devices.length) return { sent: 0, failed: 0 };

  const messages = devices.map(device => ({
    token: device.token,
    data: {
      title: shortText(notification.title, 120),
      body: shortText(notification.body, 180),
      url: notification.url,
      type: notification.type,
      childId: notification.childId || "",
      recordId: notification.recordId || "",
      paymentId: notification.paymentId || ""
    },
    webpush: {
      headers: {
        Urgency: "high"
      }
    }
  }));

  const response = await getMessaging().sendEach(messages);
  const invalidations = [];
  response.responses.forEach((result, index) => {
    if (result.success) return;
    const code = result.error?.code || "";
    logger.warn("FCM send failed", { code, uid: devices[index].uid });
    if (INVALID_TOKEN_CODES.has(code)) {
      invalidations.push(devices[index].ref.set({
        enabled: false,
        token: null,
        invalidatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true }));
    }
  });
  await Promise.allSettled(invalidations);
  return {
    sent: response.successCount,
    failed: response.failureCount
  };
}

async function processNotification(event, kind, sourcePath, recipientTarget, notification) {
  const claimed = await claimEvent(event.id, kind, sourcePath);
  if (!claimed) {
    logger.info("Duplicate notification event skipped", { eventId: event.id, kind });
    return;
  }

  try {
    const devices = await recipientDevices(recipientTarget);
    const result = await sendToDevices(devices, notification);
    await finishEvent(event.id, "completed", result);
  } catch (error) {
    logger.error("Notification processing failed", {
      eventId: event.id,
      kind,
      error: error?.message || String(error)
    });
    await finishEvent(event.id, "failed", {
      error: shortText(error?.message || error, 300)
    });
  }
}

exports.notifyParentsOnRecordCreated = onDocumentCreated({
  document: "records/{recordId}",
  region: REGION
}, async event => {
  const snapshot = event.data;
  if (!snapshot) return;
  const record = snapshot.data();
  if (record.adminCreated === true || record.status !== "pending") return;

  const amount = money(record.calculatedAmount);
  const childName = shortText(record.childDisplayName || record.childId, 30);
  const ruleName = shortText(record.ruleName || "実績", 50);
  const body = `${childName}が「${ruleName}」${amount ? `${amount}を` : "を"}申請しました`;

  await processNotification(
    event,
    "record-created",
    snapshot.ref.path,
    { type: "parents" },
    {
      title: "新しい申請があります",
      body,
      type: "approval",
      childId: record.childId || "",
      recordId: snapshot.id,
      url: `./?notification=approval&childId=${encodeURIComponent(record.childId || "")}&recordId=${encodeURIComponent(snapshot.id)}`
    }
  );
});

exports.notifyOnRecordStatusChanged = onDocumentUpdated({
  document: "records/{recordId}",
  region: REGION
}, async event => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after || before.status === after.status) return;

  const snapshot = event.data.after;
  const childTarget = { type: "child", childId: after.childId };
  const parentTarget = { type: "parents" };
  const ruleName = shortText(after.ruleName || "実績", 50);
  const amount = money(after.calculatedAmount);

  if (after.status === "resubmitted") {
    const childName = shortText(after.childDisplayName || after.childId, 30);
    await processNotification(
      event,
      "record-resubmitted",
      snapshot.ref.path,
      parentTarget,
      {
        title: "申請が再提出されました",
        body: `${childName}が「${ruleName}」${amount ? `${amount}を` : "を"}再申請しました`,
        type: "approval",
        childId: after.childId || "",
        recordId: snapshot.id,
        url: `./?notification=approval&childId=${encodeURIComponent(after.childId || "")}&recordId=${encodeURIComponent(snapshot.id)}`
      }
    );
    return;
  }

  const messages = {
    approved: {
      title: "申請が承認されました",
      body: `「${ruleName}」が承認されました${amount ? `（${amount}）` : ""}`
    },
    revision_requested: {
      title: "修正をお願いします",
      body: `「${ruleName}」の内容を確認してください${
        after.revisionReason ? `：${shortText(after.revisionReason, 45)}` : ""
      }`
    },
    rejected: {
      title: "申請が承認されませんでした",
      body: `「${ruleName}」の申請内容を確認してください`
    }
  };
  const message = messages[after.status];
  if (!message || !after.childId) return;

  await processNotification(
    event,
    `record-${after.status}`,
    snapshot.ref.path,
    childTarget,
    {
      ...message,
      type: "record",
      childId: after.childId,
      recordId: snapshot.id,
      url: `./?notification=record&recordId=${encodeURIComponent(snapshot.id)}`
    }
  );
});

exports.notifyOnPaymentCreated = onDocumentCreated({
  document: "payments/{paymentId}",
  region: REGION
}, async event => {
  const snapshot = event.data;
  if (!snapshot) return;
  const payment = snapshot.data();
  if (payment.status !== "paid" || !payment.childId) return;

  const label = periodLabel(payment.periodId);
  const amount = money(payment.amount);
  const body = `${label ? `${label}の` : ""}お小遣い${amount ? `${amount}が` : "が"}支給されました`;

  await processNotification(
    event,
    "payment-created",
    snapshot.ref.path,
    { type: "child", childId: payment.childId },
    {
      title: "お小遣いが支給されました",
      body,
      type: "payment",
      childId: payment.childId,
      paymentId: snapshot.id,
      url: "./?notification=payment"
    }
  );
});
