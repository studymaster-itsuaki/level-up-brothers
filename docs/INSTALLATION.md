# 導入・デプロイ手順

対象Firebaseプロジェクト：`level-up-brothers`  
Cloud Functionsリージョン：`asia-northeast1`

## 1. 導入前確認

Firebase Consoleで次を確認します。

1. 母のusersドキュメント：`role = admin`
2. 父のusersドキュメント：`role = viewer`
3. 長男：`role = child`, `childId = itsuki`
4. 次男：`role = child`, `childId = akito`
5. 全ユーザーの `active` がfalseではない
6. Authenticationの4アカウントが有効
7. Cloud MessagingのWeb Push証明書が
   `js/notification-config.js` の公開VAPIDキーと一致
8. Google Cloud ConsoleでFCM Registration APIが有効

サービスアカウントJSONは作成・配置しません。Firebase CLIでログインした
デプロイ担当者の認証と、Cloud Functions実行環境のデフォルト認証を使います。

## 2. Firebase側の準備

Node.js 20とFirebase CLIを用意します。

```bash
npm install -g firebase-tools
firebase login
firebase use level-up-brothers
cd functions
npm install
cd ..
```

まずFunctionsだけをデプロイします。

```bash
firebase deploy --only functions
```

`resetTestData`は管理者画面のリセット機能に必要です。GitHub Pagesを更新する前に、
他の通知Functionsとあわせてデプロイしてください。リセットはFunctions側でも
`users/{uid}.role == admin`かつ有効なアカウントであることを検証します。

`syncAkitoRewardRules`も同時にデプロイされます。デプロイとGitHub Pages更新後、
adminで「管理」→「暁斗の報酬設定を反映」を一度実行してください。この処理は
`childId == akito`のrulesだけを置き換え、長男のrulesは変更しません。
今回の最終調整では、カラーテストの教科名「英語」と通知表◎の案内文もこの同期で
Firestoreへ反映されます。
暁斗の夏休み自主勉強には「1日1回まで」の説明も反映されるため、今回の更新後も
同じボタンを再実行してください。

デプロイされるFunctions：

- `notifyParentsOnRecordCreated`
- `notifyOnRecordStatusChanged`
- `notifyOnPaymentCreated`

## 3. Firestore Rulesの事前確認

現在の期限付きテストRulesを置き換えるため、いきなり本番へ反映せず、
Firebase Local Emulator SuiteまたはRules Playgroundで確認します。

```bash
firebase emulators:start --only firestore
```

最低限、次を確認します。

- 未認証：すべて拒否
- admin：records全件閲覧、承認系更新、payments作成が可能
- viewer：records/paymentsを閲覧可能、書き込み不可
- 長男：`childId == itsuki` のrecords/paymentsだけ閲覧可能
- 次男：`childId == akito` のrecords/paymentsだけ閲覧可能
- child：本人名義のpending申請を作成可能
- child：pending、resubmitted、revision_requestedの本人申請だけ編集可能
- child：`photos`は配列かつ最大5件の場合だけ保存可能
- child：statusをapproved/rejectedへ変更できない
- child：paymentsを作成・更新できない
- devices：本人のパスだけ読み書き可能
- 他ユーザーのdevicesとFCMトークン：読み取り不可

確認後にRulesをデプロイします。

```bash
firebase deploy --only firestore:rules
```

Rules反映直後に、4ロールそれぞれで既存画面を確認してください。エラーが出た場合は
Rulesを緩める前に、Firebase Consoleの失敗リクエストと対象画面を記録します。

## 4. GitHub Pages側の公開

GitHub Pagesで必要なフロントファイル：

```text
index.html
manifest.json
service-worker.js
assets/icons/*
js/pwa-register.js
js/notifications.js
js/notification-config.js
```

既存GitHub Pagesリポジトリの同名ファイルを置き換え、追加ファイルを配置して
commit/pushします。`functions/`、`firestore.rules`、`firebase.json`、
`.firebaserc`、`docs/` はFirebase側の管理用であり、Pagesの動作には不要です。

公開後、ブラウザで一度オンライン起動します。Service Worker更新が検出されると
新版が即時有効化され、既存利用者の画面は自動再読み込みされます。

## 5. 端末ごとの通知設定

### 母のiPhone

1. iOS 16.4以降でSafariからGitHub Pagesを開く
2. 共有メニューから「ホーム画面に追加」
3. ホーム画面のLevel Up Brothersを起動
4. 母のアカウントでログイン
5. 「通知設定」を開く
6. 「通知を受け取る」がONであることを確認
7. 「この端末で通知を受け取る」をON
8. iOSの確認画面で「許可」

Safariタブ内ではなく、ホーム画面へ追加したPWAから操作します。

### 長男のAndroidスマートフォン

1. Android Chromeでアプリを開く
2. PWAをインストール
3. 長男のアカウントでログイン
4. 「その他」→「通知設定」
5. アカウントと端末の通知をON
6. Androidの通知許可を承認

### 次男のAndroidタブレット

長男と同じ手順を、次男のアカウントで行います。

### 父

父はアカウント既定OFFです。通知を希望する場合のみ通知設定を開き、
「通知を受け取る」と「この端末で通知を受け取る」をONにします。
viewerの操作権限は変わらず、通知から開いても承認操作は表示されません。

## 6. 通知テスト

各端末の登録後、Firestoreで以下を確認します。

```text
users/{uid}/settings/notifications
users/{uid}/devices/{deviceId}
```

deviceドキュメントの `enabled` がtrue、`token` が空でないことを確認します。

テスト順：

1. 長男が新規申請 → 母へ通知。父はOFFなら届かない
2. 母が承認 → 長男だけへ通知
3. 次男が新規申請 → 母へ通知
4. 母が修正依頼 → 次男だけへ通知
5. 次男が再申請 → 母へ通知
6. 母が却下 → 次男だけへ通知
7. 母が長男の支給を確定 → 長男だけへ通知
8. 父をONにして新規申請 → 母と父へ通知
9. 父の画面に管理操作がないことを確認
10. 同じstatusを再保存 → 通知が増えないことを確認

Cloud Functionsのログ：

```bash
firebase functions:log
```

重複抑止状態は `notificationEvents` に保存されます。このコレクションを
クライアントから読み書きすることはできません。

## 7. 通知が届かない場合

1. OSの通知設定が許可されているか
2. PWAの通知設定がアカウント・端末ともONか
3. devicesドキュメントにtokenがあるか
4. Firebase Project IDが `level-up-brothers` か
5. Web Push証明書の公開VAPIDキーが一致するか
6. FCM Registration APIが有効か
7. Functionsログに権限・VAPID・無効トークンエラーがないか

無効トークンが返った端末はFunctionsが自動的にOFFにします。対象端末で通知設定を
一度OFFにしてからONにすると、新しいトークンを登録できます。

## 8. ログアウト時の扱い

ログアウト操作時に現在端末のFCMトークンを削除し、deviceをOFFにします。
再ログイン後は通知設定画面で端末通知をONにしてください。

通信不能時でも3秒後にはログアウトします。その場合、サーバー側の端末無効化が
完了しない可能性があるため、オンライン復帰後に同じアカウントでログインし、
通知をOFFにしてからログアウトしてください。

## 9. ロールバック

導入前にGitHubとFirebase設定のバックアップを保存します。

1. GitHub Pagesを導入前commitへ戻してpush
2. 導入前のFirestore RulesをFirebase Consoleまたは保存済みファイルから再デプロイ
3. 必要に応じてFunctionsを前版へ再デプロイ
4. 通知送信だけを止める場合は、3つのFunctionsをFirebase Consoleで無効化または削除

端末設定データと `notificationEvents` は既存アプリ処理から参照されないため、
残っていても申請・承認・支給には影響しません。削除する場合は、事前にFirestoreの
エクスポートを作成してください。

## 10. 推奨デプロイ順

1. バックアップ
2. Functions
3. GitHub Pagesフロント
4. 端末通知登録
5. 通知テスト
6. Firestore Rulesの事前検証
7. Firestore Rules本番反映
8. 全ロールで回帰確認

FunctionsはAdmin SDKを使うため、Firestore Rulesの影響を受けません。
