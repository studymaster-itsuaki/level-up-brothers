# Level Up Brothers — FCM通知対応版

既存のPWA版を基準に、Firebase Cloud Messagingによる端末別プッシュ通知を追加した版です。

## 構成

- `index.html` — 既存アプリと通知設定画面の呼び出し
- `manifest.json` — 既存PWAマニフェスト
- `service-worker.js` — 既存キャッシュ、FCM受信、通知タップ処理
- `js/pwa-register.js` — 既存Service Worker登録・更新処理
- `js/notifications.js` — 通知許可、端末登録、ON/OFF、トークン更新
- `js/photo-worker.js` — 申請時に画像をUIスレッド外で順番に圧縮
- `js/notification-config.js` — 公開VAPIDキーと対象Project ID
- `functions/` — Firestoreトリガー型Cloud Functions
- `firestore.rules` — 認証・ロール・本人データに基づく本番用Rules
- `firebase.json` / `.firebaserc` — Firebase CLI設定
- `docs/INSTALLATION.md` — 導入・テスト・ロールバック手順
- `docs/CHANGES.md` — 調査結果と変更一覧

## 重要

GitHub Pagesへ公開するのは、フロント側ファイルだけです。Cloud Functionsと
Firestore RulesはFirebase CLIからデプロイします。サービスアカウントJSONや
秘密鍵はこのプロジェクトへ追加しないでください。

導入前に `docs/INSTALLATION.md` を最後まで確認してください。
