# messenger-ui

Интерфейс мессенджера: чаты, секретные чаты со сквозным шифрованием, вложения, аудио- и видеозвонки, уведомления. React, TypeScript, Vite.

Один код собирается в двух видах:

| | Веб-сборка | Сборка для приложения |
|---|---|---|
| Где работает | в браузере, раздаётся сервером | внутри APK [`wolp-android`](https://github.com/android-messenger/wolp-android) |
| Команда (из `front/`) | `npx vite build --base=/messenger-ui/` | `VITE_API_ORIGIN=https://app.<host>[:port] npm run build:app` |
| Результат | `front/dist/` | `front/dist-app/` |
| Адреса API, WebSocket, Kratos | относительные, тот же origin | абсолютные, на `VITE_API_ORIGIN` |
| Service Worker, PWA | есть | нет: приложение обновляется вместе с APK |
| Ключи шифрования | в браузере (WebCrypto) | в защищённом хранилище приложения, через мост |

Сборка для приложения без `VITE_API_ORIGIN` не собирается.

## Структура

| Путь | Что там |
|---|---|
| `front/src` | код интерфейса; тесты лежат рядом с кодом в `__tests__` |
| `front/public` | значки и обработчик push-уведомлений для Service Worker |
| `front/server.mjs` | статический сервер для веб-сборки (порт 5555) |
| `front/Dockerfile` | образ веб-сборки: `docker build --build-arg BASE=/messenger-ui/ ./front` |
| `specs/` | спецификации и задачи |

## Сборка и проверка

Нужен Node 24. Все команды — из `front/`.

```bash
npm ci
npm run dev          # локальный запуск
npm run ci           # линтер, проверка типов, тесты, веб-сборка
npm run build:app    # сборка для приложения (нужен VITE_API_ORIGIN)
```

Те же проверки запускаются автоматически на каждом PR (`.github/workflows/ci.yml`).

## Настройка сборки

Переменные читаются при сборке; пример — `front/.env.example`.

| Переменная | Назначение |
|---|---|
| `VITE_API_ORIGIN` | адрес сервера для сборки в приложение |
| `VITE_MESSENGER_BASE` | префикс API мессенджера, по умолчанию `/messenger` |
| `VITE_KRATOS_URL` | адрес Ory Kratos, по умолчанию `/.ory/kratos/public` |
| `VITE_PEOPLE_BASE` | префикс каталога пользователей |
| `VITE_WEBPUSH_BASE` | префикс службы push-уведомлений |
| `VITE_TURN_HOST`, `VITE_TURN_PORT` | адрес и порт STUN/TURN для звонков |

Секретов в сборке нет.

## Лицензия

GPL-3.0-or-later, см. [LICENSE](LICENSE).
