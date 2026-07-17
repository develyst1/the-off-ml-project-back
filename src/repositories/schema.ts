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
  closed_at timestamptz,
  closed_by text,
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
alter table support_cases add column if not exists closed_at timestamptz;
alter table support_cases add column if not exists closed_by text;
update support_cases set category = case upper(category)
  when 'UNCATEGORIZED' then 'ยังไม่ระบุหมวดหมู่'
  when 'LOGIN_ISSUE' then 'เข้าสู่ระบบไม่ได้'
  when 'LOGIN_FAILURE' then 'เข้าสู่ระบบไม่ได้'
  when 'NETWORK_ISSUE' then 'ปัญหาการเชื่อมต่อเครือข่าย'
  when 'NETWORK_CONNECTIVITY' then 'ปัญหาการเชื่อมต่อเครือข่าย'
  when 'CONNECTIVITY_ISSUE' then 'ปัญหาการเชื่อมต่อเครือข่าย'
  when 'PASSWORD_RESET' then 'รีเซ็ตรหัสผ่าน'
  when 'PASSWORD_RESET_FAILURE' then 'รีเซ็ตรหัสผ่านไม่สำเร็จ'
  when 'PAYMENT_ISSUE' then 'ปัญหาการชำระเงิน'
  when 'BLUE_SCREEN' then 'หน้าจอสีฟ้า (Blue Screen)'
  else category end
where category is not null;
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

update analyses set category = case upper(category)
  when 'UNCATEGORIZED' then 'ยังไม่ระบุหมวดหมู่'
  when 'LOGIN_ISSUE' then 'เข้าสู่ระบบไม่ได้'
  when 'LOGIN_FAILURE' then 'เข้าสู่ระบบไม่ได้'
  when 'NETWORK_ISSUE' then 'ปัญหาการเชื่อมต่อเครือข่าย'
  when 'NETWORK_CONNECTIVITY' then 'ปัญหาการเชื่อมต่อเครือข่าย'
  when 'CONNECTIVITY_ISSUE' then 'ปัญหาการเชื่อมต่อเครือข่าย'
  when 'PASSWORD_RESET' then 'รีเซ็ตรหัสผ่าน'
  when 'PASSWORD_RESET_FAILURE' then 'รีเซ็ตรหัสผ่านไม่สำเร็จ'
  when 'PAYMENT_ISSUE' then 'ปัญหาการชำระเงิน'
  when 'BLUE_SCREEN' then 'หน้าจอสีฟ้า (Blue Screen)'
  else category end
where category is not null;

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

-- The legacy messages table remains intact as a rollback backup. New application writes use case_messages.
create table if not exists case_messages (
  id text primary key,
  case_id text not null references support_cases(id) on delete cascade,
  direction text not null,
  channel text not null,
  sender_type text not null,
  content_type text not null default 'TEXT',
  message_type text not null,
  original_text text not null,
  normalized_text text,
  display_text text not null,
  parent_message_id text references case_messages(id) on delete set null,
  source_message_id text references case_messages(id) on delete set null,
  is_visible_to_customer boolean not null default false,
  external_message_id text,
  webhook_event_id text,
  teams_message_id text,
  delivery_status text not null,
  delivery_error text,
  retry_count integer not null default 0,
  last_retry_at timestamptz,
  received_at timestamptz,
  processed_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into case_messages (
  id, case_id, direction, channel, sender_type, content_type, message_type,
  original_text, normalized_text, display_text, is_visible_to_customer,
  external_message_id, webhook_event_id, delivery_status, received_at,
  processed_at, sent_at, failed_at, created_at, updated_at
)
select
  m.id,
  m.case_id,
  case m.direction
    when 'inbound_customer' then 'INBOUND'
    when 'inbound_tech' then 'INBOUND'
    when 'outbound_customer' then 'OUTBOUND'
    else 'OUTBOUND'
  end,
  m.channel,
  m.sender_type,
  case when m.message_type = 'system' then 'SYSTEM_EVENT' else 'TEXT' end,
  case
    when m.direction = 'inbound_customer' and m.sender_type = 'CUSTOMER' then 'CUSTOMER_MESSAGE'
    when m.direction = 'inbound_tech' and m.sender_type = 'TECH' then 'TECH_RAW_REPLY'
    when m.direction = 'outbound_customer' and m.sender_type = 'BOT' and m.original_text like '%รับเรื่อง%' then 'CASE_ACKNOWLEDGEMENT'
    when m.direction = 'outbound_customer' and m.sender_type = 'BOT' then 'CUSTOMER_REPLY'
    when m.direction = 'outbound_customer' then 'CUSTOMER_REPLY'
    else 'SYSTEM_EVENT'
  end,
  m.original_text,
  m.normalized_text,
  m.original_text,
  case when m.direction = 'inbound_tech' then false else true end,
  m.external_message_id,
  m.webhook_event_id,
  case
    when m.direction in ('inbound_customer', 'inbound_tech') then 'PROCESSED'
    when m.delivery_status = 'failed' then 'FAILED'
    when m.delivery_status in ('sent', 'delivered') then 'API_ACCEPTED'
    else 'PENDING'
  end,
  m.received_at,
  case when m.direction in ('inbound_customer', 'inbound_tech') then m.created_at end,
  case when m.direction like 'outbound_%' and m.delivery_status in ('sent', 'delivered') then m.created_at end,
  case when m.delivery_status = 'failed' then m.created_at end,
  m.created_at,
  m.created_at
from messages m
on conflict (id) do nothing;

create unique index if not exists case_messages_external_message_id_unique
  on case_messages (external_message_id) where external_message_id is not null;
create unique index if not exists case_messages_webhook_event_id_unique
  on case_messages (webhook_event_id) where webhook_event_id is not null;
create unique index if not exists case_messages_teams_message_id_unique
  on case_messages (teams_message_id) where teams_message_id is not null;
create index if not exists case_messages_case_created_at_idx on case_messages(case_id, created_at);
create index if not exists case_messages_case_message_type_idx on case_messages(case_id, message_type);
create index if not exists case_messages_delivery_status_idx on case_messages(delivery_status);
create index if not exists case_messages_parent_message_id_idx on case_messages(parent_message_id);
create index if not exists case_messages_source_message_id_idx on case_messages(source_message_id);

create table if not exists case_match_logs (
  id text primary key,
  customer_id text not null references customers(id) on delete cascade,
  incoming_message text not null,
  candidate_case_ids jsonb not null default '[]'::jsonb,
  ai_intent text not null,
  matched_case_id text,
  confidence numeric not null,
  reason text not null,
  final_user_decision text,
  created_at timestamptz not null default now()
);

create index if not exists case_match_logs_customer_created_at_idx on case_match_logs(customer_id, created_at desc);

-- New application records live in case_messages. Repoint legacy foreign keys after
-- case_messages is available so existing databases migrate without losing history.
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'analyses_message_id_fkey'
      and conrelid = 'analyses'::regclass
      and confrelid <> 'case_messages'::regclass
  ) then
    alter table analyses drop constraint analyses_message_id_fkey;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'analyses_message_id_fkey'
      and conrelid = 'analyses'::regclass
  ) then
    alter table analyses
      add constraint analyses_message_id_fkey
      foreign key (message_id) references case_messages(id) on delete cascade;
  end if;

  if exists (
    select 1
    from pg_constraint
    where conname = 'auto_answer_logs_outbound_message_id_fkey'
      and conrelid = 'auto_answer_logs'::regclass
      and confrelid <> 'case_messages'::regclass
  ) then
    alter table auto_answer_logs drop constraint auto_answer_logs_outbound_message_id_fkey;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'auto_answer_logs_outbound_message_id_fkey'
      and conrelid = 'auto_answer_logs'::regclass
  ) then
    alter table auto_answer_logs
      add constraint auto_answer_logs_outbound_message_id_fkey
      foreign key (outbound_message_id) references case_messages(id) on delete set null;
  end if;
end $$;
`;
