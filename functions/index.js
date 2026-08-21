"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const {
  onDocumentCreated,
  onDocumentUpdated
} = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");

initializeApp();

const db = getFirestore();
const REGION = "asia-northeast1";
const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered"
]);

async function deleteCollectionDocuments(collectionRef) {
  let deleted = 0;
  while (true) {
    const snapshot = await collectionRef.limit(400).get();
    if (snapshot.empty) return deleted;
    const batch = db.batch();
    snapshot.docs.forEach(document => batch.delete(document.ref));
    await batch.commit();
    deleted += snapshot.size;
  }
}

exports.resetTestData = onCall({ region: REGION }, async request => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }

  const profileSnapshot = await db.collection("users").doc(request.auth.uid).get();
  const profile = profileSnapshot.data();
  if (
    !profileSnapshot.exists ||
    profile?.role !== "admin" ||
    profile?.active === false
  ) {
    throw new HttpsError("permission-denied", "管理者だけが実行できます。");
  }

  const users = await db.collection("users").get();
  const notificationCounts = await Promise.all(
    users.docs.map(userDoc =>
      deleteCollectionDocuments(userDoc.ref.collection("notifications"))
    )
  );
  const [records, payments, notificationEvents] = await Promise.all([
    deleteCollectionDocuments(db.collection("records")),
    deleteCollectionDocuments(db.collection("payments")),
    deleteCollectionDocuments(db.collection("notificationEvents"))
  ]);
  const notifications = notificationCounts.reduce((sum, count) => sum + count, 0);

  logger.warn("Test data reset completed", {
    adminUid: request.auth.uid,
    records,
    payments,
    notifications,
    notificationEvents
  });
  return { records, payments, notifications, notificationEvents };
});

async function requireAdmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }
  const profileSnapshot = await db.collection("users").doc(request.auth.uid).get();
  const profile = profileSnapshot.data();
  if (
    !profileSnapshot.exists ||
    profile?.role !== "admin" ||
    profile?.active === false
  ) {
    throw new HttpsError("permission-denied", "管理者だけが実行できます。");
  }
}

function akitoRule(periodId, id, data) {
  return {
    ref: db.collection("rules").doc(`akito-${periodId}-${id}`),
    data: {
      childId: "akito",
      periodId,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...data
    }
  };
}

function akitoSchoolRules(periodId) {
  return [
    akitoRule(periodId, "color-test", {
      name: "カラーテスト100点",
      description: "カラーテストで100点",
      category: "school",
      calculationType: "fixedTest",
      amount: 100,
      subjects: ["国語", "算数", "理科", "社会", "英語"],
      evidenceType: "photoRequired",
      sortOrder: 10
    }),
    akitoRule(periodId, "kanji-test", {
      name: "漢字テスト100点",
      description: "漢字テストで100点",
      category: "school",
      calculationType: "fixedTest",
      amount: 50,
      evidenceType: "photoRequired",
      sortOrder: 20
    }),
    akitoRule(periodId, "challenge-touch", {
      name: "チャレンジタッチ（月完了）",
      description: "その月のチャレンジタッチを完了",
      category: "school",
      calculationType: "fixedMonthly",
      amount: 200,
      evidenceType: "parentConfirmation",
      sortOrder: 30
    }),
    akitoRule(periodId, "report-circle-double", {
      name: "通知表◎",
      description: "通知表の◎の個数 × 100円",
      category: "school",
      calculationType: "countMultiplier",
      unitAmount: 100,
      countLabel: "◎はいくつありましたか？",
      countUnit: "個",
      evidenceType: "parentConfirmation",
      sortOrder: 40
    })
  ];
}

function akitoSummerRules(periodId) {
  return [
    akitoRule(periodId, "summer-homework", {
      name: "夏休み宿題完成",
      description: "夏休みの宿題を完成",
      category: "summer",
      calculationType: "fixed",
      amount: 500,
      evidenceType: "parentConfirmation",
      sortOrder: 10
    }),
    akitoRule(periodId, "self-study", {
      name: "自主勉強30分以上",
      description: "自主勉強を30分以上（1日1回まで）",
      category: "summer",
      calculationType: "fixedPerSession",
      amount: 50,
      minimumMinutes: 30,
      evidenceType: "photoOrRecord",
      sortOrder: 20
    }),
    akitoRule(periodId, "challenge-touch", {
      name: "チャレンジタッチ（月完了）",
      description: "その月のチャレンジタッチを完了",
      category: "summer",
      calculationType: "fixedMonthly",
      amount: 200,
      evidenceType: "parentConfirmation",
      sortOrder: 30
    })
  ];
}

exports.syncAkitoRewardRules = onCall({ region: REGION }, async request => {
  await requireAdmin(request);
  const terms = await db.collection("terms").get();
  if (terms.empty) {
    throw new HttpsError("failed-precondition", "学期設定がありません。");
  }

  const existing = await db.collection("rules")
    .where("childId", "==", "akito")
    .get();
  const targetTerms = terms.docs.filter(term => term.id !== "2026-1");
  const rules = targetTerms.flatMap(term =>
    String(term.id).endsWith("-summer")
      ? akitoSummerRules(term.id)
      : akitoSchoolRules(term.id)
  );
  const writer = db.bulkWriter();
  existing.docs.forEach(document => writer.delete(document.ref));
  rules.forEach(rule => writer.set(rule.ref, rule.data));
  await writer.close();

  logger.info("Akito reward rules synchronized", {
    adminUid: request.auth.uid,
    deleted: existing.size,
    created: rules.length,
    terms: targetTerms.length
  });
  return { deleted: existing.size, created: rules.length, terms: targetTerms.length };
});

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

async function recipientDevices(target, debugContext = null) {
  const users = await queryRecipientUsers(target);
  const recipients = [];

  if (debugContext) {
    logger.info("Record status notification recipient users", {
      recordId: debugContext.recordId,
      childId: debugContext.childId,
      userIds: users.docs.map(userDoc => userDoc.id)
    });

    for (const userDoc of users.docs) {
      const user = userDoc.data();
      const [settings, allDevices] = await Promise.all([
        userDoc.ref.collection("settings").doc("notifications").get(),
        userDoc.ref.collection("devices").get()
      ]);
      logger.info("Record status notification user details", {
        recordId: debugContext.recordId,
        childId: debugContext.childId,
        userId: userDoc.id,
        role: user.role || null,
        notificationsEnabled: settings.exists
          ? settings.data().enabled === true
          : null,
        deviceCount: allDevices.size,
        devices: allDevices.docs.map(device => ({
          deviceId: device.id,
          enabled: device.data().enabled === true,
          hasToken: typeof device.data().token === "string" &&
            device.data().token.length > 0
        }))
      });
    }
  }

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
  if (debugContext) {
    logger.info("Record status notification final recipients", {
      recordId: debugContext.recordId,
      childId: debugContext.childId,
      tokenCount: recipients.length
    });
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

async function processNotification(
  event,
  kind,
  sourcePath,
  recipientTarget,
  notification,
  debugContext = null
) {
  const claimed = await claimEvent(event.id, kind, sourcePath);
  if (!claimed) {
    logger.info("Duplicate notification event skipped", { eventId: event.id, kind });
    return;
  }

  try {
    const devices = await recipientDevices(recipientTarget, debugContext);
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

async function saveChildNotification(childUid, notification, recordId, status) {
  await db.collection("users")
    .doc(childUid)
    .collection("notifications")
    .add({
      type: notification.type,
      title: notification.title,
      body: notification.body,
      createdAt: FieldValue.serverTimestamp(),
      isRead: false,
      recordId,
      status,
      childUid
    });
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
  logger.info("Record status changed", {
    recordId: snapshot.id,
    childId: after.childId || null,
    beforeStatus: before.status,
    afterStatus: after.status
  });
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

  const childNotification = {
    ...message,
    type: "record",
    childId: after.childId,
    recordId: snapshot.id,
    url: `./?notification=record&recordId=${encodeURIComponent(snapshot.id)}`
  };

  if (after.childUid) {
    try {
      await saveChildNotification(
        after.childUid,
        childNotification,
        snapshot.id,
        after.status
      );
    } catch (error) {
      logger.error("Failed to save child notification", {
        recordId: snapshot.id,
        childUid: after.childUid,
        status: after.status,
        error: error?.message || String(error)
      });
    }
  } else {
    logger.warn("Child notification was not saved because childUid is missing", {
      recordId: snapshot.id,
      childId: after.childId,
      status: after.status
    });
  }

  await processNotification(
    event,
    `record-${after.status}`,
    snapshot.ref.path,
    childTarget,
    childNotification,
    {
      recordId: snapshot.id,
      childId: after.childId
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
