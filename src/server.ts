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
  closeSessionAndSaveLead,
} from './services/supabase';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN!;

const INACTIVITY_LIMIT_MS = 3 * 60 * 1000; // 3 minutes
const sessionTimers = new Map<string, NodeJS.Timeout>();

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

  const aiClient = new OpenAI({ apiKey: tenant.ai_api_key, baseURL });

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

  } catch (error) {
    console.error(`Failed to extract lead for tenant ${tenant.id}:`, error);
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

    const aiClient = new OpenAI({
      apiKey: tenant.ai_api_key,
      baseURL: baseURL,
    });

    const embeddingClient = new OpenAI({
      apiKey: process.env.SYSTEM_OPENAI_KEY!,
    });

    const queryEmbed = await embeddingClient.embeddings.create({
      model: 'text-embedding-3-small',
      input: userQuery,
    });

    const { data: matches } = await supabase.rpc('match_child_bot_knowledge', {
      query_embedding: queryEmbed.data[0].embedding,
      target_tenant_id: tenantId,
      match_threshold: 0.25,
      match_count: 3,
    });

    const contextText = matches?.map((m: any) => m.content).join('\n---\n') || 'اطلاعاتی یافت نشد.';

    let model = 'gpt-4o-mini';
    if (tenant.ai_provider === 'deepseek') model = 'deepseek-chat';
    if (tenant.ai_provider === 'liara') model = process.env.AI_LIARA_MODEL || 'gpt-4o-mini';

    const completion = await aiClient.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: `شما یک دستیار پشتیبانی مشتریان هستید. فقط بر اساس اطلاعات زیر به زبان فارسی پاسخ دهید:\n\n${contextText}`,
        },
        { role: 'user', content: userQuery },
      ],
    });

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