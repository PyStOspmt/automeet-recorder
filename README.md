# AutoMeet Recorder

## Drive smoke test

### GitHub Secrets

- `DRIVE_FOLDER_ID`: ID папки або повний URL папки. Якщо вставили URL, скрипт сам витягне ID.

#### Варіант 1 (рекомендовано для звичайного Gmail): OAuth (пише у твій Drive, використовує твою квоту)

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`

Згенерувати refresh token:

1) У Google Cloud Console створи OAuth Client ID.

Рекомендація:

- Якщо обереш тип **Web application**: додай Authorized redirect URI рівно `http://127.0.0.1:53682/oauth2callback`
- Якщо обереш тип **Desktop app**: redirect URI для loopback зазвичай не треба реєструвати вручну
2) Локально в репо:

```
npm install
GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... npm run drive:oauth:token
$env:GOOGLE_OAUTH_CLIENT_ID="..."
$env:GOOGLE_OAUTH_CLIENT_SECRET="..."
npm run drive:oauth:token

3) Відкрий URL з термінала, пройди consent, після редіректу скрипт виведе `refresh_token`. Його поклади в `GOOGLE_OAUTH_REFRESH_TOKEN`.

Примітка: workflow `Drive smoke upload` у GitHub Actions форсує OAuth (щоб випадково не впасти в service account quota).


#### Варіант 2 (Workspace): Service Account + Shared Drive


- `GOOGLE_SERVICE_ACCOUNT_JSON`: або сирий JSON service account, або Base64 від цього JSON.

### Запуск

- GitHub → Actions → `Drive smoke upload` → Run workflow

Після успішного запуску в папці на Google Drive зʼявиться файл `smoke-*.txt`.
