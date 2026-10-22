# AI Voice Desk

A self-hosted, browser-based AI voice assistant. Talk to any OpenAI-compatible
chat model using your microphone, watch the reply stream in, and hear it spoken
back — all from a single Node.js server with no Docker and no cloud account.

```
  Browser (mic + speakers)            Node.js server                 Your AI endpoint
  ┌──────────────────────┐   REST    ┌───────────────────┐  HTTPS   ┌────────────────┐
  │  public/index.html   │◀─────────▶│  Express + SQLite │─────────▶│ /chat/...      │
  │  Web Speech + Web Audio│ Socket.IO│  server.js        │          │ /audio/...     │
  └──────────────────────┘           └───────────────────┘          └────────────────┘
```

- **Voice in** — push-to-talk or continuous listening, using the browser's
  native speech recognition, with an optional server-side Whisper-style
  transcription fallback for browsers that lack the API.
- **AI out** — streaming responses from any OpenAI-compatible
  `/chat/completions` endpoint (OpenAI, Ollama, LM Studio, llama.cpp,
  OpenRouter, vLLM, …).
- **Speech out** — the browser's built-in voice, or an external
  OpenAI-compatible `/audio/speech` endpoint.
- **History** — conversations, search, export and a retention policy, stored
  locally in SQLite.
- **Private by default** — binds to `127.0.0.1`, API keys stay on the server,
  and nothing is sent anywhere until you configure an endpoint.

---

## Requirements

| Component | Version / notes |
|-----------|-----------------|
| Node.js   | **22.5.0 or newer** (uses the built-in `node:sqlite`) |
| OS        | Linux, macOS or Windows. Tested on Ubuntu, Debian and Raspberry Pi OS (64-bit / ARM64) |
| Browser   | Chrome, Edge, Brave or any Chromium browser for voice input. Firefox and Safari work for text + speech output but have limited/experimental speech recognition |
| Network   | Only needed for your chosen AI endpoint |

There are **no native dependencies** and **no Docker requirement** — `node:sqlite`
ships with Node, and Express/Socket.IO are pure JavaScript.

> Raspberry Pi: use a 64-bit OS (Bookworm 64-bit) so Node 22+ is available.
> The app runs comfortably on a Pi 5 and also on a Pi 4.

---

## Installation

### Quick install (Ubuntu / Debian / Raspberry Pi OS)

```bash
cd Web-Apps/AI-Voice-Desk
./install.sh
```

The installer:

1. Detects the OS and architecture (including ARM64).
2. Checks the Node.js version and offers to install Node 22 from NodeSource.
3. Installs dependencies (`npm ci` / `npm install`).
4. Creates `data/` and `logs/` and initialises the SQLite database.
5. Copies `.env.example` to `.env` **only if `.env` does not already exist**.
6. Optionally installs and starts a **systemd user service**.

Flags: `--service`, `--no-service`, `--yes`. Re-running is safe — existing
configuration, settings and secrets are never overwritten.

### Manual install

```bash
npm install
cp .env.example .env     # then edit it
npm start
```

### First run

1. Open <http://127.0.0.1:8381>.
2. Open **Settings → AI** and set the **Base URL**, **Model** and **API key**.
3. Press **Test connection**. A green result means you are ready.
4. Hold the microphone button and talk, or type a message.

---

## Configuration

Configuration comes from two layers:

1. **`.env`** — read at startup and used as the initial defaults.
2. **In-app Settings** — saved to `data/settings.json` and `data/secrets.json`
   (permissions `0600`) and take precedence over `.env`.

API keys are **never** sent to the browser: the UI only ever receives a masked
hint such as `••••••••abcd`.

### `.env` reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8381` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address when not in LAN mode |
| `LAN_ACCESS` | `false` | Set `true` to listen on all interfaces |
| `AUTH_PASSWORD` | *(empty)* | Password for remote sessions. **Required** when `LAN_ACCESS=true` |
| `SESSION_SECRET` | *(generated)* | Signs session cookies. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `SESSION_HOURS` | `24` | Session lifetime |
| `AI_PROVIDER` | `OpenAI-compatible` | Label only |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Chat completions base URL |
| `AI_MODEL` | `gpt-4o-mini` | Model name |
| `AI_API_KEY` | *(empty)* | Bearer token for the chat endpoint |
| `AI_TIMEOUT_MS` | `120000` | Request timeout |
| `TRANSCRIPTION_BASE_URL` | *(empty)* | Transcription base URL (server fallback) |
| `TRANSCRIPTION_API_STYLE` | `openai` | `openai` (`/audio/transcriptions`) or `whisper.cpp` (`/inference`) |
| `TRANSCRIPTION_MODEL` | `whisper-1` | Transcription model |
| `TRANSCRIPTION_API_KEY` | *(empty)* | Bearer token for transcription |
| `TTS_PROVIDER` | `browser` | `browser`, `api` or `piper` |
| `TTS_BASE_URL` | *(empty)* | OpenAI-compatible `/audio/speech` base URL |
| `TTS_MODEL` | `tts-1` | Speech model |
| `TTS_VOICE` | `alloy` | Speech voice |
| `TTS_API_KEY` | *(empty)* | Bearer token for speech |
| `PIPER_PATH` | *(empty)* | Piper executable (used when `TTS_PROVIDER=piper`) |
| `PIPER_VOICE` | *(empty)* | Piper `.onnx` voice model |
| `DATA_DIR` | `./data` | SQLite database, settings and secrets |
| `RETENTION_DAYS` | `0` | Delete conversations older than N days (0 = keep forever) |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |

### Provider examples

**OpenAI**

```
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
AI_API_KEY=sk-...
```

**Ollama (local, no key)**

```
AI_BASE_URL=http://127.0.0.1:11434/v1
AI_MODEL=llama3.1
AI_API_KEY=ollama
```

**LM Studio / llama.cpp server**

```
AI_BASE_URL=http://127.0.0.1:1234/v1
AI_MODEL=your-loaded-model
```

**Local speech, e.g. a Whisper and Piper/Kokoro OpenAI-compatible shim**

```
TRANSCRIPTION_BASE_URL=http://127.0.0.1:9000/v1
TRANSCRIPTION_MODEL=whisper-1
TTS_BASE_URL=http://127.0.0.1:9000/v1
TTS_MODEL=tts-1
TTS_VOICE=alloy
```

Anything that speaks the OpenAI API shapes works; nothing is hardcoded to a
specific vendor.

**whisper.cpp server + local Piper (fully offline, no API keys)**

```
TRANSCRIPTION_BASE_URL=http://127.0.0.1:8182/
TRANSCRIPTION_API_STYLE=whisper.cpp
PIPER_PATH=/path/to/piper-venv/bin/piper
PIPER_VOICE=/path/to/voices/en_GB-alba-medium.onnx
TTS_PROVIDER=piper
```

`whisper.cpp` posts to `/inference`; Piper is run locally as a subprocess and
returns WAV audio. Neither requires a key or a third party.

---

## Running

```bash
npm start                 # run the server
npm run dev               # run with file watching
npm test                  # end-to-end smoke test
```

### systemd user service

```bash
npm run service:install   # create, enable and start the unit
npm run service:status
npm run service:restart
npm run service:logs
npm run service:uninstall
```

To keep the service running when you are logged out:

```bash
sudo loginctl enable-linger "$USER"
```

---

## Security

- **Local by default.** The server binds to `127.0.0.1`. Only loopback clients
  are served when no password is set.
- **LAN access** requires `LAN_ACCESS=true` **and** `AUTH_PASSWORD`; the server
  refuses to start otherwise. Remote clients sign in and receive a signed,
  `HttpOnly`, `SameSite=Strict` session cookie.
- **CSRF protection** on every state-changing request via the `x-csrf-token`
  header (token delivered through `/api/bootstrap`).
- **Origin validation** for REST and WebSocket connections.
- **Rate limiting** per IP and request-size limits on all endpoints.
- **Parameterised SQL** everywhere; conversation IDs are validated and never
  trusted from the client.
- **No secret leakage** — keys, environment variables, internal errors and
  filesystem paths are never sent to clients or written to logs.
- **Content Security Policy** blocks inline and third-party scripts.

### HTTPS and microphone access

Browsers only allow microphone access in a **secure context**:

- `http://localhost` and `http://127.0.0.1` are treated as secure — voice works.
- Any other host (including a LAN IP) **must use HTTPS**, or the microphone
  will be blocked.

To expose the app on your LAN, put it behind a TLS-terminating reverse proxy
(e.g. Caddy or nginx) and set `LAN_ACCESS=true` with a strong `AUTH_PASSWORD`.
The server sets `Secure` cookies automatically when it sees `X-Forwarded-Proto:
https` from a trusted proxy.

---

## Project structure

```
AI-Voice-Desk/
├── server.js               # Express routes, Socket.IO, streaming chat
├── config.js               # env + persisted settings/secrets, validation
├── database.js             # node:sqlite schema and queries
├── lib/
│   ├── auth.js             # sessions, cookies, CSRF, password login
│   └── providers.js        # outbound chat / transcription / speech calls
├── public/
│   ├── index.html          # complete single-page interface
│   ├── css/style.css       # dark theme, responsive layout
│   └── js/
│       ├── app.js          # UI state, chat, voice, settings wiring
│       └── audio.js        # mic capture, waveform, recognition, playback
├── scripts/service.js      # systemd user-service manager
├── test/smoke.js           # end-to-end test (mock provider + real server)
├── install.sh              # Ubuntu / Raspberry Pi OS installer
├── .env.example
└── data/                   # created at runtime (database, settings, secrets)
```

### HTTP / Socket.IO surface

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Liveness probe |
| `GET /api/bootstrap` | Session, capabilities, settings, CSRF token |
| `POST /api/login` · `POST /api/logout` | Password session |
| `GET/PUT /api/settings` | Read / update settings |
| `POST /api/settings/test` | Test `ai`, `transcription` or `tts` connectivity |
| `GET/POST /api/conversations` | List / create conversations |
| `GET/PATCH/DELETE /api/conversations/:id` | Open / rename / delete |
| `GET /api/conversations/:id/export?format=txt\|json` | Export |
| `GET /api/search` | Full-text message search |
| `POST /api/transcribe` | Server-side speech-to-text fallback |
| `POST /api/tts` | Server-side text-to-speech |
| `chat:send` / `chat:delta` / `chat:done` / `chat:error` / `chat:cancel` | Socket.IO streaming chat |

---

## Testing

`npm test` boots the real server against a throwaway data directory and a mock
OpenAI-compatible provider, then exercises the whole stack: health, static
assets, bootstrap, settings validation, CSRF enforcement, connection tests,
conversation CRUD, streaming chat over Socket.IO, persistence, search, export
and error handling.

```
31 passed, 0 failed
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `Cannot find module 'node:sqlite'` | Node.js is too old. Install Node 22.5+. The server re-executes itself with `--experimental-sqlite` on Node < 23.4 automatically |
| Microphone button does nothing | The page must be a secure context. Use `localhost`, or serve over HTTPS. Check Settings → Voice → *Browser support detected* |
| "Speech recognition ✗" in Settings | Firefox/Safari do not expose the Web Speech API. Set a `TRANSCRIPTION_BASE_URL` to use the server fallback instead |
| `Authentication failed (401)` on test | Wrong API key or the endpoint expects a different auth scheme |
| `Endpoint not found (404)` on test | The base URL is wrong — it should point at the API root (e.g. `.../v1`), not the full path |
| Replies are silent | Speech synthesis may need one user gesture first. Click once on the page; check the mute button and the volume slider |
| Port already in use | Another service owns `8381`. Set `PORT` in `.env` |
| Conversations disappear | A non-zero `RETENTION_DAYS` is pruning them, or you deleted them |

### Browser / provider limitations

- **Speech recognition** is Chromium-only in practice; it also sends audio to
  the browser vendor's speech service. Use the server transcription fallback
  for a fully local pipeline.
- **Speech synthesis** voices and their availability differ per OS/browser;
  the voice list is populated from whatever the browser exposes.
- Some OpenAI-compatible servers ignore `stream: true` and return a single
  JSON body; the client handles both cases.
- Continuous listening with the server fallback uses simple voice-activity
  detection, so very noisy rooms may split utterances differently.

---

## License

MIT.
