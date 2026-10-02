## Executive System Overview

```
[ Customer ] ──► Mother Bot ──► Approval Request ──► [ Owner Telegram Alert ]
                                                          │
   ┌──────────────────────────────────────────────────────┘ (Owner Approves)
   ▼
1. Client Token Validation (`/getMe`)
2. Sitemap Discovery & Web Scraping (`/sitemap.xml`)
3. Chunking & Embedding Storage (Supabase `pgvector`)
4. AI Provider Key Binding (OpenAI / DeepSeek / GapGPT)
   │
   ▼
[ Dynamic Express Webhook Engine ] ──► Routes Messages for Unlimited Child Bots

```

---

## Phase 1: Database Architecture (Supabase & `pgvector`)

### 1. Enable Vector Extensions

In your Supabase SQL Editor, enable the `vector` extension to handle embedding similarity searches.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

```

### 2. Table Schemas

#### `tenants` Table (Mother & Child Bot Configurations)

Stores client state, authentication tokens, API credentials, and bot settings.

| Column               | Type        | Description                                                           |
| -------------------- | ----------- | --------------------------------------------------------------------- |
| `id`                 | `UUID` (PK) | Unique tenant / child bot ID.                                         |
| `telegram_user_id`   | `BIGINT`    | Client's personal Telegram ID.                                        |
| `telegram_username`  | `TEXT`      | Client's Telegram `@username`.                                        |
| `status`             | `TEXT`      | `PENDING`, `APPROVED`, `REJECTED`, `ACTIVE`.                          |
| `child_bot_token`    | `TEXT`      | Encrypted Telegram Bot Token from BotFather.                          |
| `child_bot_username` | `TEXT`      | Username of the created child bot.                                    |
| `website_url`        | `TEXT`      | Client's domain (e.g., `[https://example.com](https://example.com)`). |
| `ai_provider`        | `TEXT`      | `openai`, `deepseek`, or `gapgpt`.                                    |
| `ai_api_key`         | `TEXT`      | Client's API key.                                                     |
| `hosting_choice`     | `TEXT`      | `MANAGED`, `SELF_HOSTED_GUIDE`, or `CUSTOM_REQUEST`.                  |
| `created_at`         | `TIMESTAMP` | Record creation timestamp.                                            |

#### `knowledge_base` Table (Vector Storage)

Stores scraped page chunks and embeddings tied to each child bot.

```sql
CREATE TABLE knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  page_url TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536), -- Vector array for text-embedding-3-small
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ON knowledge_base USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

```

### 3. Isolated Similarity Search RPC Function

Creates a tenant-isolated search function so Child Bot A never accesses Child Bot B's data.

```sql
CREATE OR REPLACE FUNCTION match_child_bot_knowledge (
  query_embedding VECTOR(1536),
  target_tenant_id UUID,
  match_threshold FLOAT,
  match_count INT
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  page_url TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kb.id,
    kb.content,
    kb.page_url,
    1 - (kb.embedding <=> query_embedding) AS similarity
  FROM knowledge_base kb
  WHERE kb.tenant_id = target_tenant_id
    AND 1 - (kb.embedding <=> query_embedding) > match_threshold
  ORDER BY kb.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

```

---

## Phase 2: Mother Bot Onboarding Flow

```
User Start ──► Auth Request ──► [ Owner Alert ] ──► Approved ──► Submit Bot Token
                                                                       │
Done For You ◄── Hosting Choice ◄── AI API Key ◄── Sitemap Sync ◄──────┘

```

### Step 1: Authorization Request & Owner Approval

1. **User Action:** Customer opens the Mother Bot and clicks **درخواست همکاری / ثبت ربات** (Work with us / Request Bot).
2. **Mother Bot Action:**

- Creates a row in `tenants` with status `PENDING`.
- Displays the Owner's `@username` to the client so they can send payment or message directly.
- Sends an inline message to your personal Telegram Chat ID:
  > 🚨 **درخواست ثبت ربات جدید**
  > **کاربر:** `@username` (`ID: 12345678`)
  > `[ ✅ تایید درخواست ]` `[ ❌ رد درخواست ]`

3. **Owner Action:**

- Clicking **✅ تایید درخواست** updates the database status to `APPROVED`.
- Mother Bot automatically notifies the customer in Farsi:
  > ✨ درخواست شما تایید شد! حالا می‌توانید ربات اختصاصی خود را بسازید.

### Step 2: Bot Creation Guide & Token Verification

1. **Instruction:** Mother Bot sends a visual guide in Farsi:

- Open [@BotFather](https://t.me/botfather?utm_source=gemini).
- Send `/newbot`, name the bot, and choose a username.
- Copy the API Token provided by BotFather and paste it here.

2. **Verification Logic:** When the user posts the token, Node.js calls:
   `GET [https://api.telegram.org/bot](https://api.telegram.org/bot)<CLIENT_TOKEN>/getMe`

- **If valid (`ok: true`):** Save `child_bot_token` and `child_bot_username`, then proceed to the next step.
- **If invalid:** Reply with an error message in Farsi requesting a re-submission.

### Step 3: Domain Capture & Sitemap Ingestion

1. **Prompt:** Mother Bot asks for the client's domain (e.g., `[https://mysite.com](https://mysite.com)`).
2. **Ingestion Pipeline:**

- Append `/sitemap.xml` to the domain.
- Fetch XML using `axios` and parse URLs using `fast-xml-parser`.
- Scrape each URL's HTML using `cheerio`, removing headers, footers, `<script>`, and `<style>` elements.
- Chunk text into ~1,000-character segments.
- Generate vector embeddings via `text-embedding-3-small` (or equivalent).
- Bulk-insert chunks and vectors into `knowledge_base` linked to `tenant_id`.

3. **Fallback Handling:** If `/sitemap.xml` returns a `404` or is blocked by Cloudflare/ArvanCloud, prompt the user to input up to 5 key URLs manually.

### Step 4: AI Provider & API Key Selection

1. **Selection Menu:** Display an inline keyboard:
   `[ OpenAI ]` `[ DeepSeek ]` `[ GapGPT ]` `[ ❓ راهنمای دریافت کلید API ]`
2. **Key Capture:** Prompt user to paste their secret API Key (`sk-...`).
3. **Validation & Storage:** Perform a light test call (`GET /models` or a dummy completion) to verify the key, then save the encrypted key under `ai_api_key` in Supabase.
4. **Help Branch:** If the user doesn't have an API key, provide a step-by-step guide to register on **GapGPT** or offer direct contact with the Owner to purchase an API key package.

Insert this new step right after the client inputs their AI API Key (Step 4), but before the Hosting Options (Step 5).

### Step 4.5: Lead Channel Setup

Instruction: Mother Bot sends a guide on creating a channel:

📢 تنظیم کانال دریافت لید (مشتریان بالقوه)
برای اینکه خلاصه‌ی چت‌ها و شماره تماس مشتریان برای شما ارسال شود:

یک کانال خصوصی (Private Channel) در تلگرام بسازید.

ربات خود (@child_bot_username) را به عنوان مدیر (Admin) به آن اضافه کنید.

کلمه‌ی connect را داخل کانال ارسال کنید.

**_Channel ID Capture:_**
When the client posts connect in their channel, the Child Bot's webhook receives a channel_post update. The webhook reads the chat.id (which will be a negative number like -100123456789), saves it to lead_channel_id in Supabase, and replies in the channel:

✅ کانال با موفقیت متصل شد! خلاصه‌ی مکالمات به اینجا ارسال خواهد شد.

### Step 5: Hosting Strategy & Upsell Hand-Off

1. **Prompt:** Mother Bot asks:

   > آیا ربات خود را سرور اختصاصی هاست کرده‌اید یا نیاز به راهنمایی / راه‌اندازی توسط ما دارید؟
   > `[ 🛠️ خودم هاست می‌کنم (راهنما) ]` `[ 🚀 سپردن راه‌اندازی به ما ]`

2. **Branch A (Self-Hosted Guide):** Provide documentation detailing how to deploy using Docker, Liara, Railway, or Render.
3. **Branch B ("Do It For Me" - Upsell):**

- Mother Bot updates `hosting_choice` to `CUSTOM_REQUEST`.
- Sends a high-priority alert to your personal Telegram account:

  > 💰 **لید جدید برای خدمات کانفیگ و هاستینگ!**
  > **کاربر:** `@username`
  > **دامنه:** `[https://mysite.com](https://mysite.com)`
  > **سرویس AI:** `DeepSeek`

- Displays a confirmation message to the customer stating that support will reach out within a few hours.

---

Phase 3: Dynamic Multi-Tenant Webhook Engine
Instead of running separate server instances for every child bot, run a single Express.js application that routes webhooks dynamically based on the child bot ID, tracks active chats, and sends summaries to the admin's private channel.

[ Telegram User ] ──► POST /webhook/child/:tenantId ──► Express Server
│
┌─────────────────────────────────────────┴────────────────────────────────────────┐
▼ ▼ ▼
[ Channel Setup / `connect` ] Fetch Tenant Config & Keys Query Supabase Vectors
│ │ │
└─────────────────────────────────────────┼────────────────────────────────────────┘
▼
Execute RAG & Call AI
│
▼
Reply via Telegram Bot API
│
(After 3 mins of silence / Session ends)
▼
Extract Lead JSON & Send to Channel

1. Webhook Registration Logic
   When a client completes setup, the Mother Bot registers their webhook endpoint on Telegram:

TypeScript
const webhookUrl = `https://your-mother-server.com/webhook/child/${tenant.id}`;
await axios.post(
`https://api.telegram.org/bot${tenant.child_bot_token}/setWebhook`,
{
url: webhookUrl,
},
); 2. Express Dynamic Webhook Handler (Fully Updated)

```TypeScript
// src/server.ts
import express from "express";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

// --- In-Memory Session Tracker ---
const activeSessions = new Map<string, {
  messages: {role: string, content: string}[],
  timer: NodeJS.Timeout
}>();

const INACTIVITY_LIMIT_MS = 3 * 60 * 1000; // 3 minutes

// --- Helper: Extract Lead & Send to Channel ---
async function extractLeadAndSendToChannel(tenant: any, userMeta: any, messages: any[]) {
  if (!tenant.lead_channel_id || messages.length <= 2) return; // Skip if no channel or chat is too short

  const transcript = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');

  let baseURL = "https://api.openai.com/v1";
  if (tenant.ai_provider === "deepseek") baseURL = "https://api.deepseek.com/v1";
  if (tenant.ai_provider === "gapgpt") baseURL = "https://api.gapgpt.app/v1";

  const aiClient = new OpenAI({ apiKey: tenant.ai_api_key, baseURL });

  try {
    const completion = await aiClient.chat.completions.create({
      model: tenant.ai_provider === "deepseek" ? "deepseek-chat" : "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Analyze this customer chat transcript in Persian and extract lead info in JSON:
          {
            "lead_name": "Name if provided, else 'نامشخص'",
            "contact": "Phone/Email if provided, else 'نامشخص'",
            "intent": "High / Medium / Low / Inquiry Only",
            "summary": "Concise 2-sentence summary in Persian."
          }`
        },
        { role: "user", content: transcript }
      ],
      response_format: { type: "json_object" }
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
  } catch (error) {
    console.error(`Failed to extract lead for tenant ${tenant.id}:`, error);
  }
}

// --- Main Webhook Route ---
app.post("/webhook/child/:tenantId", async (req, res) => {
  // Acknowledge Telegram instantly to prevent webhook retries
  res.sendStatus(200);

  const { tenantId } = req.params;
  const update = req.body;

  // 1. Handle Channel Connection (Admin types 'connect' in their channel)
  if (update.channel_post && update.channel_post.text === 'connect') {
    const channelId = update.channel_post.chat.id;

    // Update DB
    await supabase.from("tenants").update({ lead_channel_id: channelId }).eq("id", tenantId);

    // Fetch bot token to send confirmation
    const { data: tenant } = await supabase.from("tenants").select("child_bot_token").eq("id", tenantId).single();
    if (tenant) {
      await axios.post(`https://api.telegram.org/bot${tenant.child_bot_token}/sendMessage`, {
        chat_id: channelId,
        text: '✅ کانال لیدها با موفقیت متصل شد! خلاصه‌ی مکالمات کاربران به این کانال ارسال خواهد شد.'
      });
    }
    return;
  }

  // 2. Process Normal User Text Messages
  if (!update.message || !update.message.text) return;

  const chatId = update.message.chat.id;
  const userQuery = update.message.text;
  const sessionKey = `${tenantId}_${chatId}`;

  try {
    // Fetch Tenant configuration & API keys from Supabase
    const { data: tenant } = await supabase
      .from("tenants")
      .select("*")
      .eq("id", tenantId)
      .single();

    if (!tenant || tenant.status !== "ACTIVE") return;

    // --- Session & Timer Logic ---
    if (!activeSessions.has(sessionKey)) {
      activeSessions.set(sessionKey, { messages: [], timer: setTimeout(() => {}, 0) });
    }
    const session = activeSessions.get(sessionKey)!;

    // Log User Message
    session.messages.push({ role: "user", content: userQuery });

    // Reset Inactivity Timer
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      extractLeadAndSendToChannel(tenant, update.message.from, session.messages);
      activeSessions.delete(sessionKey); // Clean up memory
    }, INACTIVITY_LIMIT_MS);

    // --- RAG & AI Logic ---
    let baseURL = "https://api.openai.com/v1";
    if (tenant.ai_provider === "deepseek") baseURL = "https://api.deepseek.com/v1";
    if (tenant.ai_provider === "gapgpt") baseURL = "https://api.gapgpt.app/v1";

    const aiClient = new OpenAI({
      apiKey: tenant.ai_api_key,
      baseURL: baseURL,
    });

    const embeddingClient = new OpenAI({
      apiKey: process.env.SYSTEM_OPENAI_KEY!,
    });

    const queryEmbed = await embeddingClient.embeddings.create({
      model: "text-embedding-3-small",
      input: userQuery,
    });

    const { data: matches } = await supabase.rpc("match_child_bot_knowledge", {
      query_embedding: queryEmbed.data[0].embedding,
      target_tenant_id: tenantId,
      match_threshold: 0.25,
      match_count: 3,
    });

    const contextText = matches?.map((m: any) => m.content).join("\n---\n") || "اطلاعاتی یافت نشد.";

    const completion = await aiClient.chat.completions.create({
      model: tenant.ai_provider === "deepseek" ? "deepseek-chat" : "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `شما یک دستیار پشتیبانی مشتریان هستید. فقط بر اساس اطلاعات زیر به زبان فارسی پاسخ دهید:\n\n${contextText}`,
        },
        { role: "user", content: userQuery },
      ],
    });

    const responseText = completion.choices[0].message.content || "پاسخی یافت نشد.";

    // Log Assistant Response
    session.messages.push({ role: "assistant", content: responseText });

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

app.listen(3000, () =>
  console.log("Mother Bot Dynamic Engine running on port 3000"),
);
```

---

## Phase 4: Implementation Checklist

### Step 1: Infrastructure Setup

- [ ] Create a Supabase project and execute the SQL schema script (Tables, Extensions, RPC functions).
- [ ] Set up an Express server project with TypeScript, Axios, Telegraf, and Supabase JS SDK.
- [ ] Configure environment variables (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `MOTHER_BOT_TOKEN`, `OWNER_TELEGRAM_CHAT_ID`, `SYSTEM_OPENAI_KEY`).

### Step 2: Mother Bot Development

- [ ] Build `/start` and request authorization handlers in Farsi.
- [ ] Implement owner approval inline-button listener (`approve_tenant_${id}`).
- [ ] Add Token validation logic via `[https://api.telegram.org/bot](https://api.telegram.org/bot)<TOKEN>/getMe`.
- [ ] Add Sitemap discovery, Cheerio HTML scraper, and OpenAI embedding generator.
- [ ] Build provider selection menu (OpenAI, DeepSeek, GapGPT) and API key input parser.

### Step 3: Dynamic Webhook & Routing

- [ ] Create Express route `POST /webhook/child/:tenantId`.
- [ ] Implement multi-tenant RAG pipeline using `match_child_bot_knowledge`.
- [ ] Add dynamic OpenAI client configuration matching chosen providers (OpenAI, DeepSeek, GapGPT).

### Step 4: Maintenance & Edge Case Commands

- [ ] **`/resync` Command:** Allow client admins to type `/resync` in their child bot to trigger a re-scraping of their website.
- [ ] **Rate Limiting:** Implement per-chat rate limiting using `express-rate-limit` to prevent API key depletion.
- [ ] **Fail-Safe Alerting:** Notify the Mother Bot owner if a child bot encounters repeated API key authorization failures.
