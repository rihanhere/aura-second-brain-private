# AURA Backend Deploy

## Supabase

1. Create a free Supabase project.
2. Open SQL Editor.
3. Run `supabase/schema.sql`.
4. Copy:
   - Project URL into `SUPABASE_URL`
   - Service role key into `SUPABASE_SERVICE_ROLE_KEY`

## Render

1. Create a free Render Web Service from this repo/folder.
2. Use the blueprint in `render.yaml`, or set manually:
   - Build command: `npm install && npm run build --workspace apps/api`
   - Start command: `npm run start --workspace apps/api`
   - Health path: `/health`
3. Add environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `OPENROUTER_API_KEYS`
   - `GROQ_API_KEY`
   - `GEMINI_API_KEY`
   - `OPENROUTER_MODEL=z-ai/glm-4.5-air`
   - `OPENROUTER_FALLBACK_MODELS=google/gemini-flash-1.5`
   - `GROQ_TRANSCRIPTION_MODEL=whisper-large-v3-turbo`
   - `GEMINI_TTS_MODEL=gemini-2.5-flash-preview-tts`
   - `GEMINI_TTS_VOICE=Sulafat`
   - `BETA_DAILY_MESSAGE_LIMIT=100`

## Mobile IPA

After Render gives you a public URL, update:

```text
apps/mobile/.env
EXPO_PUBLIC_API_URL=https://your-render-service.onrender.com
```

Then rebuild the IPA:

```bash
npm install
npm run ipa:ios
```

Check backend status:

```bash
curl https://your-render-service.onrender.com/health
```
