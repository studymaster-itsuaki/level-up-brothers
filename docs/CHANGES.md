# 調査結果と変更内容

## 調査結果

### Firebase初期化

Firebase Web設定を端末ごとに入力または設定リンクから保存し、
`localStorage` の `lubAppConfig` を使って初期化しています。設定をHTMLへ
固定する方式には変更していません。

### ユーザーロール

コード上で使用される実ロール値は次の3種類です。

- `admin` — 管理者。承認、修正依頼、却下、支給、金額調整が可能
- `viewer` — 閲覧専用。親画面を閲覧できるが管理操作は不可
- `child` — 子ども。`users/{uid}.childId` で本人を特定

父のFirestoreドキュメントは成果物から直接参照できませんが、既存コードが
閲覧専用として判定している値は `viewer` です。デプロイ前にFirebase Consoleで
父の `role` が `viewer` であることを確認してください。

### records

主要フィールド：

- `childId`, `childUid`, `childDisplayName`
- `periodId`, `ruleId`, `ruleName`, `ruleCategory`
- `calculationType`, `calculatedAmount`, `inputs`
- `status`
- `createdAt`, `updatedAt`, `firstSubmittedAt`, `lastSubmittedAt`
- `submittedBy`, `approvedBy`, `reviewedBy`
- 証拠写真関連フィールド

実際のstatus：

- `pending`
- `resubmitted`
- `approved`
- `revision_requested`
- `rejected`
- `withdrawn`

通常申請は `childUid` と `submittedBy` がログインUIDです。金額調整は管理者作成で
`adminCreated: true`、`childUid: null` です。

### payments

主要フィールド：

- `childId`, `childDisplayName`, `periodId`
- `amount`, `baseAmount`, `adjustmentTotal`, `adjustmentSnapshot`
- `paidDate`, `memo`
- `status`, `locked`
- `createdAt`, `updatedAt`, `createdBy`

支給通知は `status == "paid"` の新規ドキュメントだけを対象にします。

## 通知設計

- 申請作成：`records/{recordId}` の作成を検知
- 再申請：statusが `resubmitted` へ変化した場合を検知
- 承認・修正依頼・却下：statusの実際の遷移を検知
- 支給完了：`payments/{paymentId}` の作成を検知
- 通知対象はFunctionsがusers、settings、devicesから決定
- 親は `role in [admin, viewer]`、子どもは `childId == 対象ID` の
  Firestore Queryでusersの取得対象を限定
- 将来の個別通知ではUIDによるユーザードキュメント直接取得を利用可能
- クライアントから送信先UIDやトークンを指定するAPIは提供しない
- `notificationEvents/{eventId}` にイベントIDを記録して再実行を抑止
- 同じstatusへの再保存では送信しない
- 通知失敗はFunctions内で記録して終了し、元のFirestore書き込みへ影響しない
- 無効なFCMトークンは端末ドキュメントを無効化

## 端末設定

```text
users/{uid}/settings/notifications
  enabled
  createdAt
  updatedAt

users/{uid}/devices/{deviceId}
  deviceId
  token
  platform
  userAgent
  enabled
  createdAt
  updatedAt
  lastSeenAt
  invalidatedAt
```

アカウント設定と端末設定の両方がONの場合だけ送信します。母と子どもは
アカウント既定ON、父（viewer）は既定OFFです。端末はOS許可とトークン登録が
完了するまでOFFです。

ログアウト時は、最大3秒の範囲で現在端末のFCM登録を解除し、端末ドキュメントを
OFFにします。通知解除に失敗してもログアウト処理は続行します。

## 既存機能への最小修正

- Firebase Messaging用モジュールの追加
- ログイン後に通知設定を安全に初期化
- 親ナビゲーションと子どもの「その他」へ通知設定を追加
- ログアウト時の端末通知解除
- 通知タップ時の安全な画面遷移
- 子どもの全件取得を本人の `childId` で絞るよう変更

最後の変更は本番Rulesで兄弟のrecords/paymentsを読ませないために必要です。
申請・承認・修正依頼・却下・支給のFirestore書き込み形式は変更していません。

## Service Worker統合

既存の1つの `service-worker.js` にpush受信と通知タップを統合しました。
別Service Workerは登録しないため、PWAキャッシュとFCMが競合しません。
キャッシュ世代は `lub-beta8-pwa-fcm-v8` です。

## PC通知表示と通知タップの改善

- data-only FCM messageの複数のペイロード形式をService Workerで正規化
- `title`、`body`、`url`、`type`、`recordId`、`paymentId`、`childId`を
  dataから取得して `showNotification()` へ渡す処理を明確化
- FCM受信時と通知表示の成功・失敗をService Workerのコンソールへ記録
- ページ表示中はFirebase Messagingの `onMessage()` とService Workerからの
  メッセージを受け、画面上部に通知を表示
- 通知タップ時は既存PWAウィンドウを先にfocusし、再読込せず通知先画面へ遷移
- PWAが開いていない場合は、Firebase初期化を待たずに `openWindow()` を実行
- PWAキャッシュとFCMは従来どおり同じ1つのService Workerで処理

## PC端末の通知再登録

- 「この端末で通知を受け取る」をONにした時点で端末登録を実行
- PCでも `getToken()` と `saveDevice(token, true)` が実行される導線へ統一
- 既存の「通知を有効にする」ボタンも同じ端末登録処理を使用
- 登録失敗時はチェックをOFFへ戻し、従来どおり画面にエラーを表示

## 正式版前の最終調整

### 夏休み宿題の教科選択

- 長男の夏休み宿題だけ、教科ごとの最新申請状態から選択肢を生成
- `pending`、`resubmitted`、`approved`、`rejected`の教科を非表示
- `revision_requested`の教科は修正・再提出できるよう再表示
- 画面表示後に状態が変わった場合に備え、保存直前にも同じ条件を再確認
- 他の報酬項目の選択肢と申請条件は変更なし

### 管理者用テストデータリセット

- 管理者ナビゲーションへ「管理」を追加
- 確認画面の「リセットする」を押した場合だけCallable Functionを実行
- `records`、`payments`、`notificationEvents`、
  `users/{uid}/notifications`を削除
- users、terms、rules、systemPolicies、settings、devicesは保持
- Cloud Function側でもログイン状態、adminロール、active状態を検証

## 長男・夏休み宿題の証拠必須化

- 長男（`childId = itsuki`）の夏休み（`periodId`末尾が `-summer`）にある
  宿題ルール（`perSubject`かつ名称に「宿題」）だけを対象
- 教科は未選択の初期値を追加し、明示的な選択を必須化
- 「内容（記録）」の必須入力欄を追加
- 単元・定期テストと同じ必須表示・写真選択・プレビューUIを使用
- 教科、内容、証拠写真のいずれかがない場合はFirestoreへ書き込まず、
  既存のステータス欄へエラーを表示
- 既存申請の編集時は、保存済み写真があればその写真を証拠として維持可能

## 起動画面

- 初期HTMLの `body` をブート状態で開始し、通常画面を描画前から非表示
- Firebase設定、初期化、最初の認証状態判定が終わるまでスプラッシュだけを表示
- 判定後にアプリ、ログイン、初期設定の対象画面だけを表示
- 保存済みFirebase設定が有効な未ログイン端末ではログイン画面を表示
- ログイン画面の「接続設定を変更」から従来の初期設定・設定削除へ移動可能
- デモ、設定リンク、無設定、設定読込失敗の各起動経路でもブート状態を確実に解除
