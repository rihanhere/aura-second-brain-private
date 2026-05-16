create extension if not exists vector;
create extension if not exists pgcrypto;

create type memory_layer as enum ('short_term', 'long_term', 'pinned', 'archived', 'core_profile', 'episodic', 'session_summary');
create type importance_level as enum ('low', 'medium', 'critical');
create type todo_status as enum ('open', 'completed', 'archived');
create type reminder_status as enum ('scheduled', 'sent', 'paused', 'cancelled');

do $$
begin
  alter type memory_layer add value if not exists 'core_profile';
  alter type memory_layer add value if not exists 'episodic';
  alter type memory_layer add value if not exists 'session_summary';
end $$;

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  is_guest boolean not null default false,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now()
);

create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  content text not null,
  summary text not null,
  emotional_state text,
  goals text[] not null default '{}',
  action_items text[] not null default '{}',
  important_facts text[] not null default '{}',
  recurring_topics text[] not null default '{}',
  habits text[] not null default '{}',
  priorities text[] not null default '{}',
  auto_tags text[] not null default '{}',
  importance importance_level not null default 'low',
  memory_layer memory_layer not null default 'long_term',
  embedding vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists memories_user_created_idx on memories (user_id, created_at desc);
create index if not exists memories_tags_idx on memories using gin (auto_tags);
create index if not exists memories_topics_idx on memories using gin (recurring_topics);
create index if not exists memories_embedding_idx on memories using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create table if not exists conversation_turns (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  input_mode text not null default 'text',
  timezone text not null default 'UTC',
  session_id text not null,
  searchable_text text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists conversation_turns_user_created_idx on conversation_turns (user_id, created_at desc);
create index if not exists conversation_turns_user_session_idx on conversation_turns (user_id, session_id, created_at asc);
create index if not exists conversation_turns_search_idx on conversation_turns using gin (to_tsvector('simple', searchable_text));

create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  title text not null,
  scheduled_at timestamptz not null,
  recurrence_rule text,
  timezone text not null default 'UTC',
  google_calendar_event_id text,
  status reminder_status not null default 'scheduled',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reminders_due_idx on reminders (status, scheduled_at);

create table if not exists emotional_signals (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  label text not null,
  confidence real not null default 0,
  intensity integer not null default 1,
  topic text,
  source_turn_id uuid,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now()
);

create index if not exists emotional_signals_user_created_idx on emotional_signals (user_id, created_at desc);
create index if not exists emotional_signals_user_label_idx on emotional_signals (user_id, label, created_at desc);

create table if not exists memory_theme_scores (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  theme text not null,
  theme_type text not null default 'topic',
  mention_count integer not null default 1,
  intensity_total integer not null default 0,
  latest_intensity integer not null default 1,
  current_polarity text not null default 'neutral',
  previous_polarity text,
  unresolved boolean not null default false,
  related_people text[] not null default '{}',
  related_topics text[] not null default '{}',
  summary text not null default '',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_surfaced_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, theme, theme_type)
);

create index if not exists memory_theme_scores_user_seen_idx on memory_theme_scores (user_id, last_seen_at desc);
create index if not exists memory_theme_scores_user_theme_idx on memory_theme_scores (user_id, theme);

create table if not exists relationship_continuity (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  label text not null,
  aliases text[] not null default '{}',
  mention_count integer not null default 1,
  emotional_tone text,
  related_topics text[] not null default '{}',
  last_mentioned_at timestamptz not null default now(),
  last_surfaced_at timestamptz,
  summary text not null default '',
  updated_at timestamptz not null default now(),
  unique (user_id, label)
);

create index if not exists relationship_continuity_user_seen_idx on relationship_continuity (user_id, last_mentioned_at desc);

create table if not exists todos (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  title text not null,
  status todo_status not null default 'open',
  priority text not null default 'medium',
  due_at timestamptz,
  connected_goal_memory_id uuid references memories(id) on delete set null,
  last_surfaced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists insights (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  insight_type text not null,
  title text not null,
  body text not null,
  evidence_memory_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists daily_usage (
  user_id text not null,
  usage_day date not null,
  message_count integer not null default 0,
  primary key (user_id, usage_day)
);

create or replace function increment_daily_usage(target_user_id text, target_day date, max_count integer)
returns jsonb
language plpgsql
as $$
declare
  current_count integer;
begin
  insert into daily_usage (user_id, usage_day, message_count)
  values (target_user_id, target_day, 0)
  on conflict (user_id, usage_day) do nothing;

  select message_count into current_count
  from daily_usage
  where user_id = target_user_id and usage_day = target_day
  for update;

  if current_count >= max_count then
    return jsonb_build_object('allowed', false, 'used', current_count);
  end if;

  update daily_usage
  set message_count = message_count + 1
  where user_id = target_user_id and usage_day = target_day
  returning message_count into current_count;

  return jsonb_build_object('allowed', true, 'used', current_count);
end;
$$;

create or replace function match_memories(query_embedding vector(1536), match_user_id text, match_count int default 10)
returns table (
  id uuid,
  content text,
  summary text,
  emotional_state text,
  auto_tags text[],
  recurring_topics text[],
  importance importance_level,
  memory_layer memory_layer,
  created_at timestamptz,
  similarity float
)
language sql stable
as $$
  select
    memories.id,
    memories.content,
    memories.summary,
    memories.emotional_state,
    memories.auto_tags,
    memories.recurring_topics,
    memories.importance,
    memories.memory_layer,
    memories.created_at,
    1 - (memories.embedding <=> query_embedding) as similarity
  from memories
  where memories.user_id = match_user_id
    and memories.memory_layer <> 'archived'
    and memories.embedding is not null
  order by memories.embedding <=> query_embedding
  limit match_count;
$$;
