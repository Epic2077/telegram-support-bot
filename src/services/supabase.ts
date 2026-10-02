import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Tenant, MatchResult, ChatSession, ChatMessage, LeadSummary, LeadSummaryRecord } from '../types';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY!;

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey);

export async function createTenant(
  telegramUserId: number, 
  telegramUsername: string | undefined,
  fullName?: string,
  phone?: string
): Promise<Tenant | null> {
  const { data, error } = await supabase
    .from('tenants')
    .insert({
      telegram_user_id: telegramUserId,
      telegram_username: telegramUsername || null,
      full_name: fullName || null,
      phone: phone || null,
      status: 'PENDING',
    })
    .select()
    .maybeSingle();

  if (error) {
    console.error('Error creating tenant:', error);
    return null;
  }
  return data;
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('Error getting tenant:', error);
    return null;
  }
  return data;
}

export async function getTenantByTelegramId(telegramUserId: number): Promise<Tenant | null> {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('telegram_user_id', telegramUserId)
    .maybeSingle();

  if (error) {
    console.error('Error getting tenant by telegram ID:', error);
    return null;
  }
  return data;
}

export async function updateTenantStatus(id: string, status: Tenant['status']): Promise<boolean> {
  const { error } = await supabase
    .from('tenants')
    .update({ status })
    .eq('id', id);

  if (error) {
    console.error('Error updating tenant status:', error);
    return false;
  }
  return true;
}

export async function updateTenantBotToken(id: string, token: string, username: string): Promise<boolean> {
  const { error } = await supabase
    .from('tenants')
    .update({ 
      child_bot_token: token,
      child_bot_username: username,
      status: 'APPROVED'
    })
    .eq('id', id);

  if (error) {
    console.error('Error updating tenant bot token:', error);
    return false;
  }
  return true;
}

export async function updateTenantWebsite(id: string, websiteUrl: string): Promise<boolean> {
  const { error } = await supabase
    .from('tenants')
    .update({ website_url: websiteUrl })
    .eq('id', id);

  if (error) {
    console.error('Error updating tenant website:', error);
    return false;
  }
  return true;
}

export async function updateTenantAIProvider(id: string, provider: Tenant['ai_provider'], apiKey: string): Promise<boolean> {
  const { error } = await supabase
    .from('tenants')
    .update({ 
      ai_provider: provider,
      ai_api_key: apiKey
    })
    .eq('id', id);

  if (error) {
    console.error('Error updating tenant AI provider:', error);
    return false;
  }
  return true;
}

export async function updateTenantLeadChannel(id: string, channelId: string | number): Promise<boolean> {
  const { error } = await supabase
    .from('tenants')
    .update({ lead_channel_id: channelId })
    .eq('id', id);

  if (error) {
    console.error('Error updating tenant lead channel:', error);
    return false;
  }
  return true;
}

export async function updateTenantStatusActive(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('tenants')
    .update({ status: 'ACTIVE' })
    .eq('id', id);

  if (error) {
    console.error('Error updating tenant status to ACTIVE:', error);
    return false;
  }
  return true;
}

export async function insertKnowledgeChunks(tenantId: string, chunks: { page_url: string; content: string; embedding: number[] }[]): Promise<boolean> {
  const records = chunks.map(chunk => ({
    tenant_id: tenantId,
    page_url: chunk.page_url,
    content: chunk.content,
    embedding: chunk.embedding,
  }));

  const { error } = await supabase
    .from('knowledge_base')
    .insert(records);

  if (error) {
    console.error('Error inserting knowledge chunks:', error);
    return false;
  }
  return true;
}

/**
 * Insert knowledge chunks in batches of 500 rows.
 * Prevents Supabase/PostgREST payload size limits and improves throughput.
 */
export async function insertKnowledgeChunksBatched(
  tenantId: string,
  chunks: { page_url: string; content: string; embedding: number[] }[],
  batchSize: number = 500,
): Promise<boolean> {
  const records = chunks.map(chunk => ({
    tenant_id: tenantId,
    page_url: chunk.page_url,
    content: chunk.content,
    embedding: chunk.embedding,
  }));

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const { error } = await supabase
      .from('knowledge_base')
      .insert(batch);

    if (error) {
      console.error(`Error inserting knowledge chunks batch ${i}-${i + batch.length}:`, error);
      return false;
    }
  }

  return true;
}

/**
 * Get the last N messages from a chat session for conversation history context.
 * Returns messages in chronological order.
 */
export async function getRecentSessionMessages(
  sessionId: string,
  limit: number = 6,
): Promise<{ role: string; content: string }[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error getting recent session messages:', error);
    return [];
  }

  // Reverse to chronological order
  return (data || []).reverse().map(m => ({ role: m.role, content: m.content }));
}

export async function searchKnowledgeBase(
  tenantId: string, 
  queryEmbedding: number[], 
  threshold: number = 0.25, 
  count: number = 3
): Promise<MatchResult[]> {
  const { data, error } = await supabase.rpc('match_child_bot_knowledge', {
    query_embedding: queryEmbedding,
    target_tenant_id: tenantId,
    match_threshold: threshold,
    match_count: count,
  });

  if (error) {
    console.error('Error searching knowledge base:', error);
    return [];
  }
  return data || [];
}

export async function deleteKnowledgeBase(tenantId: string): Promise<boolean> {
  const { error } = await supabase
    .from('knowledge_base')
    .delete()
    .eq('tenant_id', tenantId);

  if (error) {
    console.error('Error deleting knowledge base:', error);
    return false;
  }
  return true;
}

export async function getPendingTenants(): Promise<Tenant[]> {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('status', 'PENDING')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error getting pending tenants:', error);
    return [];
  }
  return data || [];
}

// Chat Sessions
export async function getOrCreateActiveSession(
  tenantId: string,
  userTelegramId: number,
  userUsername: string | undefined,
  userFirstName: string | undefined,
  userLastName: string | undefined
): Promise<string | null> {
  const { data, error } = await supabase.rpc('get_or_create_active_session', {
    p_tenant_id: tenantId,
    p_user_telegram_id: userTelegramId,
    p_user_username: userUsername || null,
    p_user_first_name: userFirstName || null,
    p_user_last_name: userLastName || null,
  });

  if (error) {
    console.error('Error getting/creating session:', error);
    return null;
  }
  return data;
}

export async function addMessageToSession(
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  telegramMessageId?: number
): Promise<boolean> {
  const { error } = await supabase.rpc('add_message_to_session', {
    p_session_id: sessionId,
    p_role: role,
    p_content: content,
    p_telegram_message_id: telegramMessageId || null,
  });

  if (error) {
    console.error('Error adding message to session:', error);
    return false;
  }
  return true;
}

export async function getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error getting session messages:', error);
    return [];
  }
  return data || [];
}

export async function closeSessionAndSaveLead(
  sessionId: string,
  leadSummary: LeadSummary
): Promise<boolean> {
  const { error } = await supabase.rpc('close_session_and_save_lead', {
    p_session_id: sessionId,
    p_lead_summary: leadSummary,
  });

  if (error) {
    console.error('Error closing session and saving lead:', error);
    return false;
  }
  return true;
}

export async function getSessionById(sessionId: string): Promise<ChatSession | null> {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();

  if (error) {
    console.error('Error getting session:', error);
    return null;
  }
  return data;
}

export async function getTenantSessions(tenantId: string, limit: number = 50): Promise<ChatSession[]> {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error getting tenant sessions:', error);
    return [];
  }
  return data || [];
}

export async function getTenantLeadSummaries(tenantId: string, limit: number = 50): Promise<LeadSummaryRecord[]> {
  const { data, error } = await supabase
    .from('lead_summaries')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error getting lead summaries:', error);
    return [];
  }
  return data || [];
}

export async function getAllLeadSummaries(limit: number = 100): Promise<LeadSummaryRecord[]> {
  const { data, error } = await supabase
    .from('lead_summaries')
    .select('*, tenants(telegram_username, child_bot_username)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error getting all lead summaries:', error);
    return [];
  }
  return data || [];
}

export async function getTenantStats(tenantId: string): Promise<{
  totalSessions: number;
  activeSessions: number;
  totalLeads: number;
  totalMessages: number;
}> {
  const [sessions, leads] = await Promise.all([
    supabase.from('chat_sessions').select('status, message_count', { count: 'exact' }).eq('tenant_id', tenantId),
    supabase.from('lead_summaries').select('id', { count: 'exact' }).eq('tenant_id', tenantId),
  ]);

  const totalSessions = sessions.count || 0;
  const activeSessions = sessions.data?.filter(s => s.status === 'active').length || 0;
  const totalLeads = leads.count || 0;
  const totalMessages = sessions.data?.reduce((sum, s) => sum + (s.message_count || 0), 0) || 0;

  return { totalSessions, activeSessions, totalLeads, totalMessages };
}

export async function getSystemStats(): Promise<{
  totalTenants: number;
  activeTenants: number;
  pendingTenants: number;
  totalSessions: number;
  totalLeads: number;
}> {
  const [tenants, sessions, leads] = await Promise.all([
    supabase.from('tenants').select('status', { count: 'exact' }),
    supabase.from('chat_sessions').select('id', { count: 'exact' }),
    supabase.from('lead_summaries').select('id', { count: 'exact' }),
  ]);

  const totalTenants = tenants.count || 0;
  const activeTenants = tenants.data?.filter(t => t.status === 'ACTIVE').length || 0;
  const pendingTenants = tenants.data?.filter(t => t.status === 'PENDING').length || 0;
  const totalSessions = sessions.count || 0;
  const totalLeads = leads.count || 0;

  return { totalTenants, activeTenants, pendingTenants, totalSessions, totalLeads };
}

export async function updateTenantRole(telegramUserId: number, role: Tenant['role']): Promise<boolean> {
  const { error } = await supabase
    .from('tenants')
    .update({ role })
    .eq('telegram_user_id', telegramUserId);

  if (error) {
    console.error('Error updating tenant role:', error);
    return false;
  }
  return true;
}

export async function getTenantsByRole(role: Tenant['role']): Promise<Tenant[]> {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('role', role)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error getting tenants by role:', error);
    return [];
  }
  return data || [];
}

// User Management Functions
export async function getAllTenants(limit: number = 50, offset: number = 0): Promise<Tenant[]> {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('Error getting all tenants:', error);
    return [];
  }
  return data || [];
}

export async function getTenantCount(): Promise<number> {
  const { count, error } = await supabase
    .from('tenants')
    .select('*', { count: 'exact', head: true });

  if (error) {
    console.error('Error getting tenant count:', error);
    return 0;
  }
  return count || 0;
}

export async function deleteTenant(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('tenants')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('Error deleting tenant:', error);
    return false;
  }
  return true;
}

export async function revokeTenantAccess(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('tenants')
    .update({ 
      status: 'REJECTED',
      child_bot_token: null,
      child_bot_username: null,
      website_url: null,
      ai_provider: null,
      ai_api_key: null,
      lead_channel_id: null,
    })
    .eq('id', id);

  if (error) {
    console.error('Error revoking tenant access:', error);
    return false;
  }
  return true;
}

export async function getTenantWithStats(id: string): Promise<(Tenant & { stats?: any }) | null> {
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (tenantError || !tenant) {
    return null;
  }

  // Get stats
  const stats = await getTenantStats(tenant.id);
  return { ...tenant, stats };
}