-- A password login has to be rate limited or it is a guessing oracle. PBKDF2 slows an attacker to
-- roughly forty tries a second per core, which is not protection. Count failures per account and
-- refuse for a while once they pile up; a correct password clears the count.
alter table accounts add column failed_attempts smallint not null default 0;
alter table accounts add column locked_until    timestamptz;
