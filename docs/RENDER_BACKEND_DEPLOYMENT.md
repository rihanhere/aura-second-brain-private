# AURA Render Backend Deployment

This deployment is for beta testing only. It deploys `apps/api` without changing AURA cognition, memory behavior, mobile voice, WhisperKit, Supertonic, VAD, or launch flow.

## Render Service

Create a Render Web Service from the repository using `render.yaml`.

- Environment: Node.js
- Root directory: repository root (`.`)
- Build command: `npm install --include=dev && npm run build --workspace apps/api`
- Start command: `npm run start --workspace apps/api`
- Health check path: `/health`
- Host/port: app uses `HOST=0.0.0.0` and Render-provided `PORT`

## Required Render Environment Variables

Set secrets only in Render. Do not commit real values.

- `OPENROUTER_API_KEYS`
- `GROQ_API_KEYS`
- `GEMINI_API_KEYS`
- `OPENROUTER_MODEL`
- `OPENROUTER_FALLBACK_MODELS`
- `GEMINI_TTS_MODEL`
- `GEMINI_TTS_VOICE`
- `GEMINI_EMBEDDING_MODEL`
- `GEMINI_EMBEDDING_DIMENSIONS`

Recommended staging values are already reflected in `render.yaml` for non-secret keys.

## Persistence Warning

Current local JSON/in-memory persistence is acceptable for Render beta testing only. Render free-tier storage can reset on deploy/restart. After the HTTPS backend is verified, migrate persistence to Supabase/Postgres before production launch.

## Post-Deploy Validation

Replace `https://YOUR_RENDER_URL.onrender.com` with the real Render URL.

```bash
curl https://YOUR_RENDER_URL.onrender.com/health
```

Confirm `/health` returns:

- `ok: true`
- providers/brain configured
- memory/persistence status visible
- reminders status visible
- realtime metrics visible

Smoke test endpoints:

```bash
curl -X POST https://YOUR_RENDER_URL.onrender.com/capture \
  -H 'Content-Type: application/json' \
  -H 'x-user-id: render-smoke' \
  -d '{"content":"bro say one short natural line","inputMode":"text","timezone":"Asia/Kolkata","appSession":{"id":"render-smoke-session","newActiveSession":true}}'

curl -X POST https://YOUR_RENDER_URL.onrender.com/capture \
  -H 'Content-Type: application/json' \
  -H 'x-user-id: render-smoke' \
  -d '{"content":"remember that my test dog name is max","inputMode":"text","timezone":"Asia/Kolkata","appSession":{"id":"render-smoke-session"}}'

curl -X POST https://YOUR_RENDER_URL.onrender.com/reminders \
  -H 'Content-Type: application/json' \
  -H 'x-user-id: render-smoke' \
  -d '{"text":"remind me tomorrow at 7","timezone":"Asia/Kolkata"}'
```

`/capture` also accepts `x-aura-app-session-id`, but the mobile app sends the structured `appSession` body shown above.

## Mobile Switch After Deploy

After the Render URL is live, set the mobile backend URL to:

```bash
EXPO_PUBLIC_API_URL=https://YOUR_RENDER_URL.onrender.com
```

Then rebuild the IPA. Do not leave LAN-only URLs like `http://192.168.1.7:4000` in the final real-device beta build.
