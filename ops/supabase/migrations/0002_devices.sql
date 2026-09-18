-- Native push tokens. Written by POST /v1/device only when NOTIFY_ENABLED is "true". Nothing reads it yet.
create table devices (
  token      text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  platform   text not null check (platform in ('ios', 'android')),
  seen_at    timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index devices_user on devices(user_id);
alter table devices enable row level security;
