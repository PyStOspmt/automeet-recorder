# AutoMeet Recorder

## Drive smoke test

### GitHub Secrets

- `DRIVE_FOLDER_ID`: ID папки або повний URL папки. Якщо вставили URL, скрипт сам витягне ID.
- `GOOGLE_SERVICE_ACCOUNT_JSON`: або сирий JSON service account, або Base64 від цього JSON.

### Запуск

- GitHub → Actions → `Drive smoke upload` → Run workflow

Після успішного запуску в папці на Google Drive зʼявиться файл `smoke-*.txt`.

