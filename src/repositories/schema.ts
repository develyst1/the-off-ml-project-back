export const schemaSql = `
create table if not exists customers (
  id text primary key,
  line_user_id text not null unique,
  display_name text,
  active_case_id text,
  pending_case_selection jsonb,
  conversation_state text not null default 'IDLE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists support_cases (
  id text primary key,
  case_number text,
  sequence_number bigint,
  sequence_year integer,
  customer_id text not null references customers(id),
  title text,
  ai_status text,
  data_status text not null default 'COMPLETE',
  customer_sent_at timestamptz,
  system_received_at timestamptz,
  ai_analyzed_at timestamptz,
  teams_sent_at timestamptz,
  tech_replied_at timestamptz,
  line_sent_at timestamptz,
  line_delivered_at timestamptz,
  status text not null,
  category text,
  priority text,
  confidence_score numeric,
  teams_thread_id text,
  teams_delivery_status text not null default 'not_sent',
  teams_delivery_at timestamptz,
  teams_delivery_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table customers add column if not exists active_case_id text;
alter table customers add column if not exists pending_case_selection jsonb;
alter table customers add column if not exists conversation_state text not null default 'IDLE';

alter table support_cases add column if not exists sequence_number bigint;
alter table support_cases add column if not exists sequence_year integer;
alter table support_cases add column if not exists title text;
alter table support_cases add column if not exists ai_status text;
alter table support_cases add column if not exists data_status text not null default 'COMPLETE';
alter table support_cases add column if not exists customer_sent_at timestamptz;
alter table support_cases add column if not exists system_received_at timestamptz;
alter table support_cases add column if not exists ai_analyzed_at timestamptz;
alter table support_cases add column if not exists teams_sent_at timestamptz;
alter table support_cases add column if not exists tech_replied_at timestamptz;
alter table support_cases add column if not exists line_sent_at timestamptz;
alter table support_cases add column if not exists line_delivered_at timestamptz;
alter table support_cases alter column case_number type text using case_number::text;
update support_cases
set sequence_year = coalesce(sequence_year, extract(year from created_at)::integer),
    sequence_number = coalesce(sequence_number, nullif(substring(case_number from '([0-9]+)$'), '')::bigint)
where sequence_year is null or sequence_number is null;
update support_cases
set case_number = 'OFF-' || sequence_year::text || '-' || lpad(sequence_number::text, 5, '0')
where case_number is null or case_number not like 'OFF-%';
create table if not exists case_number_counters (
  sequence_year integer primary key,
  next_number bigint not null
);
insert into case_number_counters (sequence_year, next_number)
select sequence_year, coalesce(max(sequence_number), 0) + 1
from support_cases
where sequence_year is not null and sequence_number is not null
group by sequence_year
on conflict (sequence_year) do update
set next_number = greatest(case_number_counters.next_number, excluded.next_number);
alter table support_cases alter column case_number set not null;
alter table support_cases add column if not exists teams_delivery_status text not null default 'not_sent';
alter table support_cases add column if not exists teams_delivery_at timestamptz;
alter table support_cases add column if not exists teams_delivery_error text;

create table if not exists messages (
  id text primary key,
  case_id text not null references support_cases(id) on delete cascade,
  direction text not null,
  channel text not null,
  original_text text not null,
  sender_type text not null default 'SYSTEM',
  message_type text not null default 'text',
  delivery_status text not null default 'sent',
  external_message_id text,
  webhook_event_id text,
  normalized_text text,
  received_at timestamptz,
  created_at timestamptz not null default now()
);

alter table messages add column if not exists sender_type text not null default 'SYSTEM';
alter table messages add column if not exists message_type text not null default 'text';
alter table messages add column if not exists delivery_status text not null default 'sent';
alter table messages add column if not exists webhook_event_id text;
alter table messages add column if not exists normalized_text text;
alter table messages add column if not exists received_at timestamptz;

create table if not exists analyses (
  id text primary key,
  case_id text not null references support_cases(id) on delete cascade,
  message_id text not null references messages(id) on delete cascade,
  analysis_type text not null,
  summary text,
  category text,
  confidence numeric not null,
  raw_json jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists solutions (
  id text primary key,
  case_id text not null references support_cases(id) on delete cascade,
  raw_reply_text text not null,
  root_cause text,
  solution_steps text[] not null default '{}',
  rewritten_customer_text text not null,
  confidence numeric not null,
  validated_by_team boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists tech_agents (
  id text primary key,
  ms_teams_user_id text not null unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists confidence_matches (
  id text primary key,
  case_id text not null references support_cases(id) on delete cascade,
  matched_solution_id text references solutions(id) on delete set null,
  case_understanding_confidence numeric not null,
  case_discrimination_confidence numeric not null,
  confidence_pct numeric not null,
  tech_confirmed boolean,
  rejection_reason text,
  learning_note text,
  created_at timestamptz not null default now()
);

create table if not exists automation_settings (
  id text primary key default 'default',
  enabled boolean not null default false,
  case_understanding_threshold numeric not null default 98,
  case_discrimination_threshold numeric not null default 98,
  emergency_disabled_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint automation_settings_singleton check (id = 'default')
);

insert into automation_settings (id)
values ('default')
on conflict (id) do nothing;

create table if not exists auto_answer_logs (
  id text primary key,
  case_id text not null references support_cases(id) on delete cascade,
  solution_id text references solutions(id) on delete set null,
  customer_id text not null references customers(id),
  outbound_message_id text references messages(id) on delete set null,
  answer_text text not null,
  teams_notification_id text,
  disabled_after_send boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists support_cases_created_at_idx on support_cases(created_at desc);
create unique index if not exists support_cases_case_number_uidx on support_cases(case_number);
create index if not exists messages_case_id_idx on messages(case_id);
create unique index if not exists messages_external_message_id_uidx on messages(external_message_id) where external_message_id is not null;
create unique index if not exists messages_webhook_event_id_uidx on messages(webhook_event_id) where webhook_event_id is not null;
create index if not exists analyses_case_id_idx on analyses(case_id);
create index if not exists solutions_case_id_idx on solutions(case_id);
create index if not exists confidence_matches_case_id_idx on confidence_matches(case_id);
create index if not exists auto_answer_logs_case_id_idx on auto_answer_logs(case_id);
`;
