# Second Brain AI Architecture

## Product Shape

Second Brain AI behaves like a calm personal cognitive layer. The app prioritizes fast capture, intelligent storage, recurring pattern detection, reminders, todos, and periodic reflection.

The assistant should not maximize conversation. It should preserve the user's context, reduce mental load, and answer from long-term memory.

## Data Flow

1. User captures a thought by text or voice.
2. Mobile app creates an optimistic local item and sends it to the API.
3. API checks the user's beta daily limit.
4. Memory analyzer extracts structured signals:
   - goals
   - emotions
   - action items
   - facts
   - habits
   - priorities
   - recurring topics
   - importance score
5. API creates embeddings and stores the memory in Supabase with pgvector.
6. Agent tool router optionally creates reminders or todos.
7. AI response is streamed or returned as a short contextual reflection.
8. Background jobs synthesize weekly insights and surface forgotten goals.

## Memory Layers

- Short-term: recent captures used for immediate context.
- Long-term: semantically indexed memories.
- Pinned: durable high-priority context.
- Archived: retained but excluded from proactive surfacing.

## Future Agent Tools

Backend services are split so autonomous tools can be added without rewriting chat:

- `create_reminder`
- `update_reminder`
- `create_todo`
- `summarize_week`
- `detect_emotional_shift`
- `detect_recurring_goals`
- `detect_burnout`
- `synthesize_long_term_memory`

## Deployment

- Mobile: Expo Application Services.
- API: Railway.
- Database: Supabase PostgreSQL with `vector`.
- Push: Firebase Cloud Messaging.
- Calendar: Google Calendar API.
