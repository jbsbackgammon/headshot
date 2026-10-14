# headshot → member 直接反映 初回設定

## 1. GitHub Appを作成
GitHub → Settings → Developer settings → GitHub Apps → New GitHub App

設定:
- GitHub App name: 任意（例: JBS Headshot Member Writer）
- Homepage URL: https://jbsbackgammon.github.io/headshot/
- Callback URL: `https://＜作成するWorkerのURL＞/auth/callback`
- Repository permissions → Contents: Read and write
- その他の権限は原則不要
- 作成後、Appを `jbsbackgammon` にInstall
- Repository access は `Only select repositories`
- `member` だけを選択

GitHub App設定画面の
- Client ID
- Client secret（Generate a new client secret）
を控える。

## 2. Cloudflare Workerを作成
Cloudflare Dashboard → Workers & Pages → Worker作成。

`cloudflare-worker.js` の内容をWorkerへ貼り付けてDeploy。

## 3. KVを作成してWorkerへBinding
Workers KVでNamespaceを1つ作成（例: `headshot-github-sessions`）。

Worker → Settings → Bindings → Add → KV Namespace
- Variable name: `SESSIONS`
- Namespace: 上で作成したもの

## 4. WorkerのVariables / Secrets
Worker → Settings → Variables and Secrets に追加:

Secrets:
- `GITHUB_CLIENT_ID` = GitHub AppのClient ID
- `GITHUB_CLIENT_SECRET` = GitHub AppのClient secret

Variable:
- `FRONTEND_ORIGIN` = `https://jbsbackgammon.github.io`

保存してDeploy。

## 5. GitHub AppのCallback URLを確定
Worker URLが例えば
`https://jbs-headshot-member.example.workers.dev`
なら、GitHub AppのCallback URLを
`https://jbs-headshot-member.example.workers.dev/auth/callback`
にする。

## 6. headshot側
このZIPの `index.html` をheadshotリポジトリへアップロード。

初回の「member反映」クリック時だけWorker URL入力欄が出る。
例:
`https://jbs-headshot-member.example.workers.dev`

ブラウザにWorker URLが保存され、その後GitHub認可画面が開く。
認可完了後は同じクリック処理のまま `member/images/` へPNGを保存する。

同名ファイルが既にある場合は上書き確認が出る。

## 普段の動作
1. 写真調整
2. 日本語名・英語名確認
3. `member反映`
4. そのまま `member/images/日本語名_英語名.png` に保存
5. memberリポジトリのGitHub Actionsが起動
6. memberの選手素材一覧へ反映

GitHub Appのアクセストークン切れはWorker側でrefresh tokenを使って自動更新する。
長期間使わずrefresh token自体が失効した場合や認可を取り消した場合のみ、再認可画面が出る。
