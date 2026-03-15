# AutoMeet Recorder

Використовуй тільки там, де є згода на запис/конспект (вимога законів/політик закладу).

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

## Запуск запису Meet (гість, відео + субтитри)

### Secrets

- `MEET_GUEST_NAME`: імʼя, під яким бот заходить (наприклад `Student`).
- `SCHEDULE_JSON`: JSON (або Base64 від JSON) з розкладом.

Формат `SCHEDULE_JSON`:

```json
{
  "sessions": [
    {
      "id": "math-2026-03-16-0900",
      "title": "Math",
      "meetUrl": "https://meet.google.com/xxx-xxxx-xxx",
      "start": "2026-03-16T09:00:00+02:00",
      "end": "2026-03-16T10:30:00+02:00"
    }
  ]
}
```

### Workflows

- `AutoMeet Recorder`:
  - `schedule` запускається кожні 5 хв і підхоплює сесію, якщо “зараз” потрапляє в вікно `start/end`
  - `workflow_dispatch` дає змогу протестувати одну сесію вручну (Meet URL задається інпутом)
