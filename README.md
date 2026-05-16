# Second Brain AI

Second Brain AI is a mobile-first personal cognitive operating system. It is intentionally not a high-volume chatbot: the product centers on memory capture, context retention, reminders, todos, emotional patterns, and long-term personal intelligence.

## Architecture

- `apps/mobile`: Expo / React Native dark-mode mobile app.
- `apps/api`: Node.js + Express backend prepared for Supabase PostgreSQL, pgvector, OpenRouter, Firebase Cloud Messaging, Google Calendar, and Railway.
- `supabase/schema.sql`: PostgreSQL schema with pgvector memory storage, todos, reminders, insights, usage limits, and user context tables.
- `docs/architecture.md`: product and system architecture notes.

## Local Setup

```bash
npm install
cp apps/api/.env.example apps/api/.env
npm run api
npm run mobile
```

The API includes mock-safe fallbacks so the product surface can be developed before all external credentials are configured.

For real voice transcription, set `GROQ_API_KEY` in `apps/api/.env`. For AI memory responses, set `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`.

## iOS Xcode Build

For building an IPA on a Mac with Xcode, see `docs/ios-xcode-build.md`. The mobile app is configured with iOS permissions, bundle id, and Expo prebuild scripts for generating the Xcode workspace.

## Product Principles

- Memory quality matters more than chat volume.
- Every capture is analyzed for goals, emotions, actions, facts, habits, priorities, and recurring topics.
- AI responses should be brief, calm, contextual, and organized.
- The app becomes more valuable as the user's personal context accumulates.
