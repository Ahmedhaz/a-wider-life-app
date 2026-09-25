-- Accounts live apart from users on purpose. A users row needs the onboarding answers (timezone,
-- open_day, day_names, first_local_date), all NOT NULL and all given at entry, while an account has
-- to exist before entry. So credentials hang off their own table and a copy points back at it.
create table accounts (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  password_hash  text not null,                 -- pbkdf2$<iterations>$<salt b64>$<hash b64>
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);

-- Case-insensitive: Ahmed@x and ahmed@x must not be two accounts.
create unique index accounts_email_key on accounts (lower(email));

alter table books    add column account_id uuid references accounts(id) on delete cascade;
alter table sessions add column account_id uuid references accounts(id) on delete cascade;
create index books_account    on books(account_id);
create index sessions_account on sessions(account_id);

-- Same posture as every other table: only the Worker's service key reads or writes this.
alter table accounts enable row level security;
