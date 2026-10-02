import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import OpenAI from 'openai';
import { startMotherBot } from './bot/motherBot';
import { supabase } from './services/supabase';
import {
  getOrCreateActiveSession,
  addMessageToSession,
  getSessionMessages,
  getRecentSessionMessages,
  closeSessionAndSaveLead,
} from './services/supabase';
import { getOpenAIClient, getTenantEmbeddingClient } from './services/embeddings';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN!;

const INACTIVITY_LIMIT_MS = 3 * 60 * 1000; // 3 minutes
const sessionTimers = new Map<string, NodeJS.Timeout>();

// --- Rate Limiter (per-tenant sliding window) ---
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '30', 10);
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(tenantId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(tenantId);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(tenantId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  entry.count++;
  return false;
}

// --- Error Alerting ---
async function alertTenantError(tenant: any, errorMessage: string) {
  if (!tenant.child_bot_token) return;
  try {
    // Notify the tenant that there's an issue with their AI configuration
    await axios.post(`https://api.telegram.org/bot${tenant.child_bot_token}/sendMessage`, {
      chat_id: tenant.telegram_user_id,
      text: `⚠️ خطا در سرویس هوش مصنوعی:\n\n${errorMessage}\n\nلطفاً تنظیمات API Key خود را بررسی کنید.`,
    }).catch(() => {}); // Silently fail if notification itself fails
  } catch {
    // Non-critical: don't crash on alert failures
  }
}

async function alertOwnerError(errorMessage: string) {
  const ownerChatId = process.env.OWNER_TELEGRAM_CHAT_ID;
  const motherBotToken = process.env.MOTHER_BOT_TOKEN;
  if (!ownerChatId || !motherBotToken) return;
  try {
    await axios.post(`https://api.telegram.org/bot${motherBotToken}/sendMessage`, {
      chat_id: ownerChatId,
      text: `🚨 <b>خطای سیستم</b>\n\n${errorMessage}`,
      parse_mode: 'HTML',
    }).catch(() => {});
  } catch {
    // Non-critical
  }
}

// --- Helper: Extract Lead & Send to Channel ---
async function extractLeadAndSendToChannel(tenant: any, userMeta: any, sessionId: string) {
  if (!tenant.lead_channel_id) return;

  const messages = await getSessionMessages(sessionId);
  if (messages.length <= 2) return; // Skip if chat is too short

  const transcript = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');

  let baseURL = 'https://api.openai.com/v1';
  if (tenant.ai_provider === 'deepseek') baseURL = 'https://api.deepseek.com/v1';
  if (tenant.ai_provider === 'gapgpt') baseURL = 'https://api.gapgpt.app/v1';
  if (tenant.ai_provider === 'liara') baseURL = process.env.AI_LIARA_BASE_URL || 'https://ai.liara.ir/api/6abe8dfc7ce6d9a9e0475844/v1';

  // Use cached client instead of creating new one each time
  const aiClient = getOpenAIClient(tenant.ai_api_key, baseURL);

  let model = 'gpt-4o-mini';
  if (tenant.ai_provider === 'deepseek') model = 'deepseek-chat';
  if (tenant.ai_provider === 'liara') model = process.env.AI_LIARA_MODEL || 'gpt-4o-mini';

  try {
    const completion = await aiClient.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: `Analyze this customer chat transcript in Persian and extract lead info in JSON:
          {
            "lead_name": "Name if provided, else 'نامشخص'",
            "contact": "Phone/Email if provided, else 'نامشخص'",
            "intent": "High / Medium / Low / Inquiry Only",
            "summary": "Concise 2-sentence summary in Persian."
          }`
        },
        { role: 'user', content: transcript }
      ],
      response_format: { type: 'json_object' }
    });

    const leadData = JSON.parse(completion.choices[0].message.content || '{}');

    // Format the channel card
    const card = `🚨 **گزارش چت جدید و اطلاعات مشتری**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 **کاربر:** ${userMeta.first_name || 'کاربر'} (@${userMeta.username || 'بدون آیدی'})\n` +
      `🏷️ **نام استخراج شده:** ${leadData.lead_name}\n` +
      `📞 **اطلاعات تماس:** ${leadData.contact}\n` +
      `🔥 **میزان تمایل:** ${leadData.intent}\n\n` +
      `📝 **خلاصه درخواست:**\n${leadData.summary}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `💬 *تعداد پیام‌ها:* ${messages.length}`;

    // Post to the Tenant's Lead Channel
    await axios.post(`https://api.telegram.org/bot${tenant.child_bot_token}/sendMessage`, {
      chat_id: tenant.lead_channel_id,
      text: card,
      parse_mode: 'Markdown'
    });

    // Save lead summary to database
    await closeSessionAndSaveLead(sessionId, leadData);

  } catch (error: any) {
    console.error(`Failed to extract lead for tenant ${tenant.id}:`, error);
    // Alert on API key errors (401, 403, or specific error codes)
    if (error?.status === 401 || error?.status === 403 || error?.message?.includes('API key')) {
      await alertTenantError(tenant, `کلید API هوش مصنوعی نامعتبر یا منقضی شده است. (${tenant.ai_provider})`);
      await alertOwnerError(`Tenant ${tenant.telegram_username || tenant.id} (${tenant.ai_provider}): AI API key failed during lead extraction.`);
    }
  }
}

// --- Main Webhook Route for Child Bots ---
app.post('/webhook/child/:tenantId', async (req, res) => {
  // Acknowledge Telegram instantly to prevent webhook retries
  res.sendStatus(200);

  const { tenantId } = req.params;
  const update = req.body;

  // 1. Handle Channel Connection (Admin types 'connect' in their channel)
  if (update.channel_post && update.channel_post.text === 'connect') {
    const channelId = update.channel_post.chat.id;

    // Update DB
    await supabase.from('tenants').update({ lead_channel_id: channelId }).eq('id', tenantId);

    // Fetch bot token to send confirmation
    const { data: tenant } = await supabase.from('tenants').select('child_bot_token').eq('id', tenantId).maybeSingle();
    if (tenant) {
      await axios.post(`https://api.telegram.org/bot${tenant.child_bot_token}/sendMessage`, {
        chat_id: channelId,
        text: '✅ کانال لیدها با موفقیت متصل شد! خلاصه مکالمات کاربران به این کانال ارسال خواهد شد.'
      });
    }
    return;
  }

  // 2. Process Normal User Text Messages
  if (!update.message || !update.message.text) return;

  const chatId = update.message.chat.id;
  const userQuery = update.message.text;
  const telegramMessageId = update.message.message_id;
  const userMeta = update.message.from;

  // --- Rate Limit Check ---
  if (isRateLimited(tenantId)) {
    const { data: rlTenant } = await supabase
      .from('tenants')
      .select('child_bot_token')
      .eq('id', tenantId)
      .maybeSingle();
    if (rlTenant?.child_bot_token) {
      await axios.post(
        `https://api.telegram.org/bot${rlTenant.child_bot_token}/sendMessage`,
        { chat_id: chatId, text: '⏳ لطفاً چند لحظه صبر کنید. تعداد درخواست‌ها بیش از حد مجاز است.' },
      ).catch(() => {});
    }
    return;
  }

  try {
    // Fetch Tenant configuration & API keys from Supabase
    const { data: tenant } = await supabase
      .from('tenants')
      .select('*')
      .eq('id', tenantId)
      .maybeSingle();

    if (!tenant || tenant.status !== 'ACTIVE') return;

    // --- Session Management (Database-backed) ---
    const sessionId = await getOrCreateActiveSession(
      tenantId,
      chatId,
      userMeta.username,
      userMeta.first_name,
      userMeta.last_name
    );

    if (!sessionId) {
      console.error('Failed to get/create session');
      return;
    }

    // Save user message to database
    await addMessageToSession(sessionId, 'user', userQuery, telegramMessageId);

    // Reset Inactivity Timer
    const timerKey = `${tenantId}_${chatId}`;
    if (sessionTimers.has(timerKey)) {
      clearTimeout(sessionTimers.get(timerKey)!);
    }
    const timer = setTimeout(() => {
      extractLeadAndSendToChannel(tenant, userMeta, sessionId);
      sessionTimers.delete(timerKey);
    }, INACTIVITY_LIMIT_MS);
    sessionTimers.set(timerKey, timer);

    // --- RAG & AI Logic ---
    let baseURL = 'https://api.openai.com/v1';
    if (tenant.ai_provider === 'deepseek') baseURL = 'https://api.deepseek.com/v1';
    if (tenant.ai_provider === 'gapgpt') baseURL = 'https://api.gapgpt.app/v1';
    if (tenant.ai_provider === 'liara') baseURL = process.env.AI_LIARA_BASE_URL || 'https://ai.liara.ir/api/6abe8dfc7ce6d9a9e0475844/v1';

    // Use cached clients (avoids creating new OpenAI instances per request)
    const aiClient = getOpenAIClient(tenant.ai_api_key, baseURL);
    const embeddingClient = getTenantEmbeddingClient(tenant);

    let queryEmbed;
    try {
      queryEmbed = await embeddingClient.embeddings.create({
        model: 'text-embedding-3-small',
        input: userQuery,
      });
    } catch (embedError: any) {
      console.error(`Embedding API failed for tenant ${tenantId}:`, embedError);
      if (embedError?.status === 401 || embedError?.status === 403 || embedError?.message?.includes('API key')) {
        await alertTenantError(tenant, `کلید API embedding نامعتبر یا منقضی شده است.`);
        await alertOwnerError(`Tenant ${tenant.telegram_username || tenant.id}: Embedding API key failed (provider: ${tenant.embedding_provider || 'system'}).`);
      }
      await axios.post(
        `https://api.telegram.org/bot${tenant.child_bot_token}/sendMessage`,
        { chat_id: chatId, text: '⚠️ متأسفانه در حال حاضر قادر به پاسخگویی نیستیم. لطفاً بعداً تلاش کنید.' },
      ).catch(() => {});
      return;
    }

    const { data: matches } = await supabase.rpc('match_child_bot_knowledge', {
      query_embedding: queryEmbed.data[0].embedding,
      target_tenant_id: tenantId,
      match_threshold: 0.25,
      match_count: 3,
    });

    const contextText = matches?.map((m: any) => m.content).join('\n---\n') || 'اطلاعاتی یافت نشد.';

    // --- Inject Conversation History (last 6 messages) ---
    const historyMessages = await getRecentSessionMessages(sessionId, 6);

    let model = 'gpt-4o-mini';
    if (tenant.ai_provider === 'deepseek') model = 'deepseek-chat';
    if (tenant.ai_provider === 'liara') model = process.env.AI_LIARA_MODEL || 'gpt-4o-mini';

    // Build messages array with conversation history for better context
    const chatMessages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `شما یک دستیار پشتیبانی مشتریان هستید. فقط بر اساس اطلاعات زیر به زبان فارسی پاسخ دهید:\n\n${contextText}` +
          (historyMessages.length > 1 ? '\n\nبا توجه به مکالمه قبلی کاربر پاسخ مناسب بدهید.' : ''),
      },
    ];

    // Add recent history as actual message turns (excluding the latest user message already saved)
    if (historyMessages.length > 1) {
      for (const msg of historyMessages.slice(0, -1)) {
        chatMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    // Current user query
    chatMessages.push({ role: 'user', content: userQuery });

    let completion;
    try {
      completion = await aiClient.chat.completions.create({
        model,
        messages: chatMessages,
      });
    } catch (aiError: any) {
      console.error(`AI completion failed for tenant ${tenantId}:`, aiError);
      if (aiError?.status === 401 || aiError?.status === 403 || aiError?.message?.includes('API key')) {
        await alertTenantError(tenant, `کلید API ${tenant.ai_provider} نامعتبر یا منقضی شده است.`);
        await alertOwnerError(`Tenant ${tenant.telegram_username || tenant.id} (${tenant.ai_provider}): AI completion API key failed.`);
      }
      await axios.post(
        `https://api.telegram.org/bot${tenant.child_bot_token}/sendMessage`,
        { chat_id: chatId, text: '⚠️ متأسفانه در حال حاضر قادر به پاسخگویی نیستیم. لطفاً بعداً تلاش کنید.' },
      ).catch(() => {});
      return;
    }

    const responseText = completion.choices[0].message.content || 'پاسخی یافت نشد.';

    // Save assistant response to database
    await addMessageToSession(sessionId, 'assistant', responseText);

    // Send response back to user via Telegram API
    await axios.post(
      `https://api.telegram.org/bot${tenant.child_bot_token}/sendMessage`,
      {
        chat_id: chatId,
        text: responseText,
      },
    );
  } catch (error) {
    console.error(`Error processing webhook for tenant ${tenantId}:`, error);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await startMotherBot();
});