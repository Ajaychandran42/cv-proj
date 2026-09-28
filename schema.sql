-- ============================================================
-- Phoenix — AI Proctoring Platform — Supabase (PostgreSQL) Schema
-- Accessed only via the backend, using the Service Role Key.
-- RLS intentionally left off per spec (backend is trusted).
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- Exams (created by teachers) ----------
create table if not exists exams (
  id               uuid primary key default gen_random_uuid(),
  teacher_id       text not null,           -- Clerk user id
  name             text not null,
  total_questions  integer not null,
  duration_minutes integer not null,
  live_at          timestamptz not null,
  dead_at          timestamptz not null,
  created_at       timestamptz not null default now()
);

create index if not exists idx_exams_teacher on exams (teacher_id);
create index if not exists idx_exams_window on exams (live_at, dead_at);

-- ---------- Questions (MCQ, 4 options, one correct) ----------
create table if not exists questions (
  id             uuid primary key default gen_random_uuid(),
  exam_id        uuid not null references exams (id) on delete cascade,
  question_text  text not null,
  option_1       text not null,
  option_2       text not null,
  option_3       text not null,
  option_4       text not null,
  correct_option smallint not null check (correct_option between 1 and 4),
  created_at     timestamptz not null default now()
);

create index if not exists idx_questions_exam on questions (exam_id);

-- ---------- One row per student exam attempt ----------
create table if not exists candidate_sessions (
  id              uuid primary key default gen_random_uuid(),
  clerk_user_id   text not null,
  candidate_name  text,
  candidate_email text,
  exam_id         uuid not null references exams (id),
  status          text not null default 'in_progress'
                  check (status in ('in_progress', 'completed', 'terminated')),
  answers         jsonb,       -- { "<question_id>": <selected_option 1-4> }
  score           integer,
  total_questions integer,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz
);

create index if not exists idx_sessions_user on candidate_sessions (clerk_user_id);
create index if not exists idx_sessions_exam on candidate_sessions (exam_id);

-- ---------- One row per detected anomaly / violation ----------
create table if not exists anomaly_logs (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references candidate_sessions (id) on delete cascade,
  clerk_user_id  text not null,
  violation_type text not null,
  -- 'FACE_NOT_VISIBLE' | 'MULTIPLE_FACES' | 'GAZE_DEVIATION' | 'WEBCAM_TAMPERED'
  -- | 'TAB_SWITCH' | 'FULLSCREEN_EXIT' | 'CELL_PHONE_DETECTED'
  -- | 'PROHIBITED_OBJECT_DETECTED' | 'EXAM_TERMINATED'
  detail         text,
  warning_count_at_log integer not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists idx_logs_session on anomaly_logs (session_id);
create index if not exists idx_logs_user on anomaly_logs (clerk_user_id);
