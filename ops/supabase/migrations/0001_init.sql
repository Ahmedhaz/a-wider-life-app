-- A Wider Life · schema v1 · nine tables plus sessions.
-- Six single-line text fields in the whole product: weeks.anchor_text, act_full, act_half, act_min, sign_text, users.witness_name.
-- No notes column anywhere, by design (PRD edition 2, section 9).

create extension if not exists pgcrypto;

create type lang_t   as enum ('ar', 'en');
create type edition_t as enum ('print', 'digital');
create type arc_t    as enum ('self', 'home', 'work', 'people');
create type dose_t   as enum ('full', 'half', 'min');
create type answer_t as enum ('done', 'smaller', 'empty', 'question');
create type status_t as enum ('active', 'paused', 'left');

-- the copies · one code per printed copy, or per digital purchase
create table books (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (char_length(code) = 15),
  edition       edition_t not null default 'print',
  lang          lang_t not null,
  batch         text not null,
  first_scan_at timestamptz,
  user_id       uuid,
  created_at    timestamptz not null default now()
);

create table users (
  id            uuid primary key default gen_random_uuid(),
  book_id       uuid not null unique references books(id),
  email         text unique,
  lang          lang_t not null,
  timezone      text not null,
  open_day      smallint not null check (open_day between 0 and 6),   -- 0 Sunday .. 6 Saturday
  day_names     text[] not null check (array_length(day_names, 1) = 7),
  witness_name  text check (char_length(witness_name) <= 140),
  status        status_t not null default 'active',
  first_local_date date not null,
  created_at    timestamptz not null default now()
);
alter table books add constraint books_user_fk foreign key (user_id) references users(id) on delete set null;

-- a session is bound to a copy; user_id fills in once the entry steps are done
create table sessions (
  token_hash    text primary key,
  book_id       uuid not null references books(id) on delete cascade,
  user_id       uuid references users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index sessions_book on sessions(book_id);

create table program_state (
  user_id           uuid primary key references users(id) on delete cascade,
  arc               arc_t not null,
  arc_order         arc_t[] not null,                 -- the four circles in the reader's chosen order
  week_no           smallint not null default 1 check (week_no between 1 and 52),
  dose              dose_t not null default 'full',
  consecutive_empty smallint not null default 0,
  last_answer_at    timestamptz,
  last_closed_date  date,                             -- the last local date the day-close job handled
  pair_user_id      uuid,
  ceiling_flag      boolean not null default false
);

create table articles (
  id         uuid primary key default gen_random_uuid(),
  lang       lang_t not null,
  arc        arc_t not null,
  week_no    smallint not null check (week_no between 1 and 13),   -- week within the arc
  trait_id   text not null,
  title      text not null,
  body_md    text not null,
  act_full   text not null,
  act_half   text not null,
  act_min    text not null,
  sign_hint  text not null,
  question   text not null,
  options    text[] not null check (array_length(options, 1) = 3),
  version    text not null,                                         -- content file hash
  unique (lang, arc, week_no)
);

create table pulses (
  id             uuid primary key default gen_random_uuid(),
  article_id     uuid not null references articles(id) on delete cascade,
  day_index      smallint not null check (day_index between 1 and 5),
  observation    text not null,
  audio_key      text,
  act_audio_keys jsonb,                                               -- {"full": key, "half": key, "min": key}
  unique (article_id, day_index)
);

create table weeks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  week_no      smallint not null,
  article_id   uuid references articles(id),
  circle       arc_t not null,
  trait_id     text,
  anchor_text  text check (char_length(anchor_text) <= 140),
  act_full     text check (char_length(act_full) <= 140),
  act_half     text check (char_length(act_half) <= 140),
  act_min      text check (char_length(act_min) <= 140),
  sign_text    text check (char_length(sign_text) <= 140),
  started_on   date not null,
  locked_at    timestamptz,
  unique (user_id, week_no)
);

create table entries (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  week_id      uuid not null references weeks(id) on delete cascade,
  local_date   date not null,
  day_index    smallint not null check (day_index between 1 and 7),
  answer       answer_t not null,
  dose_served  dose_t,
  option       smallint check (option between 0 and 2),
  responded_at timestamptz not null default now(),
  unique (user_id, local_date)
);

create table checkins (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  kind       text not null check (kind in ('monthly5', 'who5')),
  local_date date not null,
  answers    jsonb not null
);

create table flags (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references users(id) on delete cascade,
  kind      text not null check (kind in ('three_empty')),
  raised_on date not null,
  seen_at   timestamptz
);

-- Row level security: the anon and authenticated roles see nothing. Only the Worker, with the service key, reads and writes.
alter table books         enable row level security;
alter table users         enable row level security;
alter table sessions      enable row level security;
alter table program_state enable row level security;
alter table articles      enable row level security;
alter table pulses        enable row level security;
alter table weeks         enable row level security;
alter table entries       enable row level security;
alter table checkins      enable row level security;
alter table flags         enable row level security;

-- A schema test in CI fails if any text column is added to these tables beyond the six fields.
comment on table weeks is 'Five of the six free-text fields live here. No notes column, ever.';
comment on column users.witness_name is 'The sixth free-text field. A name only.';
