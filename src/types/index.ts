export type UserRole = 'owner' | 'admin' | 'client';

export interface Tenant {
  id: string;
  telegram_user_id: number;
  telegram_username: string | null;
  full_name: string | null;
  phone: string | null;
  role: UserRole;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ACTIVE';
  child_bot_token: string | null;
  child_bot_username: string | null;
  website_url: string | null;
  ai_provider: 'openai' | 'deepseek' | 'gapgpt' | 'liara' | null;
  ai_api_key: string | null;
  hosting_choice: 'MANAGED' | 'SELF_HOSTED_GUIDE' | 'CUSTOM_REQUEST' | null;
  lead_channel_id: string | number | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeBase {
  id: string;
  tenant_id: string;
  page_url: string;
  content: string;
  embedding: number[];
  created_at: string;
}

export interface MatchResult {
  id: string;
  content: string;
  page_url: string;
  similarity: number;
}

export interface ChatSession {
  id: string;
  tenant_id: string;
  user_telegram_id: number;
  user_username: string | null;
  user_first_name: string | null;
  user_last_name: string | null;
  status: 'active' | 'closed' | 'archived';
  started_at: string;
  ended_at: string | null;
  message_count: number;
  lead_summary: LeadSummary | null;
  lead_sent_to_channel: boolean;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  telegram_message_id: number | null;
  created_at: string;
}

export interface LeadSummary {
  lead_name: string;
  contact: string;
  intent: 'High' | 'Medium' | 'Low' | 'Inquiry Only';
  summary: string;
}

export interface LeadSummaryRecord {
  id: string;
  session_id: string;
  tenant_id: string;
  user_telegram_id: number;
  lead_name: string | null;
  contact_info: string | null;
  intent_level: 'High' | 'Medium' | 'Low' | 'Inquiry Only' | null;
  summary: string | null;
  full_transcript: string | null;
  message_count: number;
  created_at: string;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: {
    id: number | string;
    type: string;
    title?: string;
    username?: string;
    first_name?: string;
  };
  date: number;
  text?: string;
  channel_post?: {
    chat: {
      id: number | string;
    };
    text: string;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
  };
}

export interface BotInfo {
  ok: boolean;
  result: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username: string;
    can_join_groups: boolean;
    can_read_all_group_messages: boolean;
    supports_inline_queries: boolean;
  };
}