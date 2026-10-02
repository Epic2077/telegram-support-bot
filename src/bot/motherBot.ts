import { Telegraf, Context, Markup } from "telegraf";
import { validateBotToken, setWebhook } from "../services/telegram";
import {
  createTenant,
  getTenantByTelegramId,
  getTenantById,
  updateTenantStatus,
  updateTenantBotToken,
  updateTenantWebsite,
  updateTenantAIProvider,
  updateTenantStatusActive,
  getPendingTenants,
  getAllTenants,
  getTenantCount,
  deleteTenant,
  revokeTenantAccess,
  getTenantWithStats,
  getSystemStats,
  getAllLeadSummaries,
  getTenantStats,
} from "../services/supabase";
import { supabase } from "../services/supabase";
import { ingestWebsite } from "../services/ingestion";
import { Tenant } from "../types";

const bot = new Telegraf(process.env.MOTHER_BOT_TOKEN!);
const OWNER_CHAT_ID = process.env.OWNER_TELEGRAM_CHAT_ID!;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD!;
const OWNER_USERNAME = process.env.OWNER_USERNAME || "support";
const APPROVAL_CHANNEL_ID = process.env.APPROVAL_CHANNEL_ID!;
const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID!;
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN!;

const ownerAuthState = new Map<number, boolean>(); // Track authenticated owners
const userState = new Map<
  number,
  { step: string; tenantId?: string; data?: any }
>();

function setUserState(userId: number, step: string, data?: any) {
  userState.set(userId, { step, data });
}

function getUserState(userId: number) {
  return userState.get(userId);
}

function clearUserState(userId: number) {
  userState.delete(userId);
}

const PERSIAN_MESSAGES = {
  welcome: `🎉 <b>به ربات‌ساز پشتیبانی هوشمند خوش آمدید!</b>

🤖 <b>این ربات چه می‌کند؟</b>
━━━━━━━━━━━━━━━━━━━━
📚 <b>یاد می‌گیرد</b> — از محتوای کامل وب‌سایت شما
💬 <b>پاسخ می‌دهد</b> — به سوالات مشتریان به زبان فارسی
📊 <b>استخراج می‌کند</b> — لیدها و خلاصه مکالمات

<i>💡 در هر مرحله می‌توانید با دستور <code>/cancel</code> فرآیند را لغو کنید.</i>

👇 <b>برای شروع، یکی از گزینه‌های زیر را انتخاب کنید:</b>`,

  requestSent: `✅ <b>درخواست شما با موفقیت ارسال شد</b>

━━━━━━━━━━━━━━━━━━━━
👤 <b>کاربر:</b> @{username} (ID: {userId})
⏳ <b>وضعیت:</b> در انتظار تایید مالک
📅 <b>زمان ثبت:</b> {timestamp}

💬 <b>برای پیگیری:</b> @{ownerUsername}

<i>پس از تایید، شما را برای مراحل بعدی راهنمایی می‌کنیم.</i>`,

  alreadyPending: `⏳ <b>درخواست در انتظار تایید</b>

━━━━━━━━━━━━━━━━━━━━
شما قبلاً درخواست ثبت ربات داده‌اید.
مالک سیستم در حال بررسی درخواست شماست.

💬 <b>برای تماس و پیگیری:</b> @{ownerUsername}

<i>لطفاً صبر کنید. به محض تایید، به شما اطلاع داده می‌شود.</i>`,

  alreadyApproved: `✅ <b>درخواست تایید شده!</b>

━━━━━━━━━━━━━━━━━━━━
<h3>📋 مرحله ۱: ساخت ربات در BotFather</h3>

1️⃣ به <b>@BotFather</b> بروید
2️⃣ دستور <code>/newbot</code> را بفرستید
3️⃣ نام ربات را انتخاب کنید
4️⃣ نام کاربری انتخاب کنید (باید با <code>bot</code> تمام شود)
5️⃣ <b>توکن (API Token)</b> را اینجا بفرستید

<i>مثال توکن: <code>123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11</code></i>

<i>💡 برای لغو در هر زمان <code>/cancel</code> بزنید.</i>`,

  alreadyActive: `🤖 <b>ربات شما فعال و آماده است!</b>

━━━━━━━━━━━━━━━━━━━━
🔗 <b>آدرس ربات:</b> @{botUsername}

<i>مشتریان شما می‌توانند از این ربات پشتیبانی دریافت کنند.</i>`,

  ownerNewRequest: `🚨 <b>درخواست ثبت ربات جدید</b>

━━━━━━━━━━━━━━━━━━━━
👤 <b>کاربر:</b> @{username} (ID: {userId})
📝 <b>نام کامل:</b> {fullName}
📞 <b>شماره تماس:</b> {phone}
📅 <b>زمان:</b> {timestamp}

<i>لطفاً تصمیم بگیرید:</i>`,

  ownerApproved: `✅ <b>درخواست تایید شد!</b>`,
  ownerRejected: `❌ <b>درخواست رد شد.</b>`,

  userApproved: `✨ <b>درخواست شما تایید شد!</b>

━━━━━━━━━━━━━━━━━━━━
اکنون می‌توانید ربات اختصاصی خود را بسازید.

<h3>📋 مرحله ۱: ساخت ربات در BotFather</h3>

1️⃣ به <b>@BotFather</b> بروید
2️⃣ دستور <code>/newbot</code> را بفرستید
3️⃣ نام ربات را انتخاب کنید
4️⃣ نام کاربری انتخاب کنید (باید با <code>bot</code> تمام شود)
5️⃣ <b>توکن (API Token)</b> را اینجا بفرستید`,

  invalidToken: `❌ <b>توکن نامعتبر است</b>

━━━━━━━━━━━━━━━━━━━━
لطفاً توکن معتبری از <b>@BotFather</b> بفرستید.

<i>فرمت صحیح:</i>
<code>123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11</code>`,

  tokenValid: `✅ <b>توکن تایید شد!</b>

━━━━━━━━━━━━━━━━━━━━
🤖 <b>ربات شما:</b> @{botUsername}

<h3>📋 مرحله ۲: آدرس وب‌سایت</h3>
آدرس کامل وب‌سایت خود را بفرستید:
<i>مثال: <code>https://example.com</code></i>

<b>ما به صورت خودکار:</b>
• <code>sitemap.xml</code> را پیدا می‌کنیم
• محتوای صفحات را استخراج می‌کنیم
• پایگاه دانش هوشمند می‌سازیم`,

  websiteReceived: `✅ <b>آدرس وب‌سایت دریافت شد</b>

━━━━━━━━━━━━━━━━━━━━
🌐 <b>دامنه:</b> {website}

⏳ <b>در حال پردازش...</b>
• یافتن sitemap.xml
• استخراج محتوای صفحات
• ساخت امبدینگ‌ها و ذخیره در پایگاه دانش

<i>این فرآیند چند دقیقه طول می‌کشد...</i>`,

  ingestionSuccess: `✅ <b>پایگاه دانش با موفقیت ساخته شد!</b>

━━━━━━━━━━━━━━━━━━━━
📄 <b>صفحات استخراج شده:</b> {pages}
🧩 <b>بخش‌های دانش (Chunks):</b> {chunks}

<h3>📋 مرحله ۳: انتخاب ارائه‌دهنده AI</h3>
کدام سرویس هوش مصنوعی را ترجیح می‌دهید؟`,

  ingestionFailed: `❌ <b>خطا در استخراج محتوا</b>

━━━━━━━━━━━━━━━━━━━━
<b>دلیل:</b> {error}

<h4>💡 راه‌حل‌ها:</h4>
• آدرس سایت را بررسی کنید
• مطمئن شوید <code>sitemap.xml</code> در دسترس است
• یا تا ۵ آدرس کلیدی را به صورت دستی بفرستید`,

  aiProviderSelected: `✅ <b>{provider} انتخاب شد</b>

━━━━━━━━━━━━━━━━━━━━
🔑 <b>اکنون کلید API خود را بفرستید:</b>

<i>مثال‌ها:</i>
• OpenAI: <code>sk-...</code>
• DeepSeek: <code>sk-...</code>
• GapGPT: <code>gp-...</code>`,

  aiKeyValid: `✅ <b>کلید API تایید و ذخیره شد!</b>

━━━━━━━━━━━━━━━━━━━━
<h3>📋 مرحله ۴: تنظیم کانال لیدها</h3>
برای دریافت <b>خلاصه چت‌ها</b> و <b>اطلاعات تماس مشتریان</b>:

1️⃣ یک <b>کانال خصوصی (Private Channel)</b> در تلگرام بسازید
2️⃣ ربات خود (<b>@{botUsername}</b>) را به عنوان <b>مدیر (Admin)</b> اضافه کنید
3️⃣ کلمه <code>connect</code> را در کانال بفرستید

<i>ربات به‌صورت خودکار کانال را شناسایی و متصل می‌کند.</i>`,

  aiKeyInvalid: `❌ <b>کلید API نامعتبر است</b>

━━━━━━━━━━━━━━━━━━━━
لطفاً کلید معتبری بفرستید و مجدداً تلاش کنید.`,

  channelConnected: `✅ <b>کانال با موفقیت متصل شد!</b>

━━━━━━━━━━━━━━━━━━━━
خلاصه مکالمات کاربران از این لحظه به این کانال ارسال خواهد شد.`,

  hostingChoice: `🎉 <b>تقریباً تمام شد!</b>

━━━━━━━━━━━━━━━━━━━━
<b>چطور می‌خواهید ربات را اجرا کنید؟</b>

🛠️ <b>خودم هاست می‌کنم</b> — راهنما و مستندات دریافت می‌کنید
🚀 <b>توسط شما راه‌اندازی شود</b> — تیم ما سرور و تنظیمات را انجام می‌دهد`,

  selfHostedGuide: `🛠️ <b>راهنمای هاستینگ دستی (Self-Hosted)</b>

━━━━━━━━━━━━━━━━━━━━
<b>پلتفرم‌های پیشنهادی:</b>

🐳 <b>Docker / Docker Compose</b>
   کنترل کامل، قابل اجرا روی هر سروری

☁️ <b>Liara (لیرا)</b>
   پلتفرم ابری ایرانی، استقرار ساده

🚂 <b>Railway</b>
   اتصال مستقیم به GitHub، استقرار خودکار

🎨 <b>Render</b>
   پلن رایگان برای پروژه‌های کوچک

📦 <b>شامل بسته:</b>
• <code>Dockerfile</code> و <code>docker-compose.yml</code>
• فایل <code>.env.example</code>
• مستندات کامل در GitHub

<i>مخزن گیت‌هاب: github.com/Epic2077/telegram-support-bot</i>`,

  customRequest: `🚀 <b>درخواست راه‌اندازی توسط تیم ما ثبت شد!</b>

━━━━━━━━━━━━━━━━━━━━
✅ تیم پشتیبانی در <b>چند ساعت</b> با شما تماس می‌گیرد.

━━━━━━━━━━━━━━━━━━━━
<b>خلاصه اطلاعات شما:</b>
👤 @{username}
🌐 {website}
🤖 AI: {provider}

<i>منتظر تماس باشید.</i>`,

  ownerCustomRequest: `💰 <b>لید جدید: خدمات کانفیگ و هاستینگ!</b>

━━━━━━━━━━━━━━━━━━━━
👤 <b>کاربر:</b> @{username}
🌐 <b>دامنه:</b> {website}
🤖 <b>سرویس AI:</b> {provider}

<i>برای پیگیری در سیستم مدیریت لیدها ثبت شده است.</i>`,

  resyncStarted: `🔄 <b>به‌روزرسانی پایگاه دانش آغاز شد</b>

━━━━━━━━━━━━━━━━━━━━
• واکشی مجدد sitemap
• اسکرپ صفحات جدید/تغییر یافته
• بازسازی امبدینگ‌ها

<i>این فرآیند چند دقیقه طول می‌کشد...</i>`,

  resyncComplete: `✅ <b>پایگاه دانش به‌روزرسانی شد!</b>

━━━━━━━━━━━━━━━━━━━━
📄 <b>صفحات:</b> {pages}
🧩 <b>بخش‌های جدید:</b> {chunks}

<i>ربات اکنون با محتوای جدید پاسخ می‌دهد.</i>`,

  resyncFailed: `❌ <b>خطا در به‌روزرسانی</b>

━━━━━━━━━━━━━━━━━━━━
<b>دلیل:</b> {error}

<i>لطفاً مجدداً تلاش کنید یا با پشتیبانی تماس بگیرید.</i>`,

  requestContactInfo: `📝 <b>اطلاعات تماس برای ثبت درخواست</b>

━━━━━━━━━━━━━━━━━━━━
برای ارسال درخواست به مالک، ابتدا نام کامل خود را وارد کنید:`,

  requestPhone: `📞 <b>شماره تماس</b>

لطفاً شماره تماس خود را وارد کنید:
<i>مثال: 09123456789</i>`,

  help: `📚 <b>راهنما و دستورات</b>

━━━━━━━━━━━━━━━━━━━━
<b>دستورات اصلی:</b>
/start — نمایش منوی اصلی
/resync — به‌روزرسانی پایگاه دانش
/status — وضعیت ربات شما

━━━━━━━━━━━━━━━━━━━━
<b>مراحل ساخت ربات:</b>
1️⃣ درخواست تایید از مالک (با نام و تلفن)
2️⃣ ارسال توکن از @BotFather
3️⃣ دادن آدرس وب‌سایت
4️⃣ انتخاب AI و کلید API
5️⃣ اتصال کانال لیدها (connect)
6️⃣ انتخاب روش هاستینگ

━━━━━━━━━━━━━━━━━━━━
<b>نیاز به کمک دارید؟</b>
با پشتیبانی تماس بگیرید.`,

  error: `❌ <b>خطایی رخ داد</b>

━━━━━━━━━━━━━━━━━━━━
لطفاً مجدداً تلاش کنید یا با پشتیبانی تماس بگیرید.`,
};

async function sendToOwner(text: string, extra?: any) {
  const targetChatId = APPROVAL_CHANNEL_ID || OWNER_CHAT_ID;
  try {
    await bot.telegram.sendMessage(targetChatId, text, {
      parse_mode: "HTML",
      ...extra,
    });
  } catch (error) {
    console.error("Error sending to approval channel/owner:", error);
    if (APPROVAL_CHANNEL_ID) {
      try {
        await bot.telegram.sendMessage(OWNER_CHAT_ID, text, {
          parse_mode: "HTML",
          ...extra,
        });
      } catch (e) {
        console.error("Error sending to owner fallback:", e);
      }
    }
  }
}

async function sendApprovalRequest(text: string, keyboard: any) {
  if (APPROVAL_CHANNEL_ID) {
    try {
      await bot.telegram.sendMessage(APPROVAL_CHANNEL_ID, text, {
        parse_mode: "HTML",
      });
    } catch (error) {
      console.error("Error sending to approval channel:", error);
    }
  }
  try {
    await bot.telegram.sendMessage(OWNER_CHAT_ID, text, {
      parse_mode: "HTML",
      ...keyboard,
    });
  } catch (error) {
    console.error("Error sending to owner:", error);
  }
}

function getMainKeyboard(isOwner: boolean = false) {
  const buttons = [
    [Markup.button.callback("📝 درخواست همکاری / ثبت ربات", "request_bot")],
    [Markup.button.callback("ℹ️ راهنما", "help")],
    [Markup.button.callback("❌ انصراف", "cancel_flow")],
  ];

  if (isOwner) {
    buttons.push([Markup.button.callback("👑 پنل مدیریت", "owner_panel")]);
  }

  return Markup.inlineKeyboard(buttons);
}

function getOwnerKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📋 درخواست‌های معلق", "owner_pending")],
    [Markup.button.callback("👥 مدیریت کاربران", "owner_users")],
    [Markup.button.callback("📊 آمار کلی", "owner_stats")],
    [Markup.button.callback("📈 گزارش‌های پیشرفته", "owner_reports")],
    [Markup.button.callback("🔍 جستجوی داده‌ها", "owner_search")],
    [Markup.button.callback("📤 صادرات داده‌ها", "owner_export")],
    [Markup.button.callback("🔔 لاگ‌های سیستم", "owner_logs")],
    [Markup.button.callback("🔙 بازگشت", "back_to_main")],
  ]);
}

function getAiProviderKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🤖 OpenAI", "ai_openai"),
      Markup.button.callback("⚡ DeepSeek", "ai_deepseek"),
    ],
    [
      Markup.button.callback("🇮🇷 GapGPT", "ai_gapgpt"),
      Markup.button.callback("🌐 Liara AI", "ai_liara"),
    ],
    [Markup.button.callback("❓ راهنمای دریافت کلید API", "ai_help")],
    [Markup.button.callback("❌ انصراف", "cancel_flow")],
  ]);
}

function getHostingKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🛠️ خودم هاست می‌کنم (راهنما)", "hosting_self")],
    [Markup.button.callback("🚀 سپردن راه‌اندازی به ما", "hosting_custom")],
    [Markup.button.callback("❌ انصراف", "cancel_flow")],
  ]);
}

function getOwnerApprovalKeyboard(tenantId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ تایید", `approve_${tenantId}`),
      Markup.button.callback("❌ رد", `reject_${tenantId}`),
    ],
  ]);
}

bot.start(async (ctx) => {
  const userId = ctx.from!.id;
  const username = ctx.from!.username || "بدون آیدی";

  // Check if user is owner
  const isOwner = String(userId) === OWNER_CHAT_ID;

  const existingTenant = await getTenantByTelegramId(userId);

  // Owner always gets owner panel access
  if (isOwner) {
    await ctx.reply(
      "👑 <b>پنل مدیریت مالک</b>\n\nبه عنوان مالک سیستم، شما به پنل مدیریت دسترسی دارید.",
      { parse_mode: "HTML", ...getMainKeyboard(true) },
    );
    // If owner also has a tenant, show status below
    if (existingTenant) {
      await ctx.reply(
        `ℹ️ <b>وضعیت ربات شخصی شما:</b> ${existingTenant.status}`,
        { parse_mode: "HTML", ...getMainKeyboard(true) },
      );
    }
    return;
  }

  if (existingTenant) {
    switch (existingTenant.status) {
      case "PENDING":
        await ctx.reply(
          `⏳ <b>درخواست در انتظار تایید</b>\n\n` +
            `👤 <b>کاربر:</b> @${username} (ID: ${userId})\n` +
            `📅 <b>زمان ثبت:</b> ${new Date(existingTenant.created_at).toLocaleString("fa-IR")}\n` +
            `📊 <b>وضعیت:</b> در انتظار تایید مالک\n\n` +
            `💬 <b>برای تماس و پیگیری:</b> @${OWNER_USERNAME}`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "❌ انصراف از درخواست",
                  `cancel_request_${existingTenant.id}`,
                ),
              ],
              [Markup.button.callback("ℹ️ راهنما", "help")],
            ]),
          },
        );
        break;
      case "APPROVED":
        if (!existingTenant.child_bot_token) {
          await ctx.reply(
            PERSIAN_MESSAGES.alreadyApproved,
            Markup.inlineKeyboard([
              [Markup.button.callback("❌ انصراف", "cancel_request_flow")],
              [Markup.button.callback("ℹ️ راهنما", "help")],
            ]),
          );
        } else if (!existingTenant.website_url) {
          await ctx.reply(
            PERSIAN_MESSAGES.tokenValid.replace(
              "@{botUsername}",
              existingTenant.child_bot_username || "",
            ),
            Markup.inlineKeyboard([
              [Markup.button.callback("❌ انصراف", "cancel_request_flow")],
              [Markup.button.callback("ℹ️ راهنما", "help")],
            ]),
          );
        } else if (!existingTenant.ai_provider) {
          await ctx.reply(
            PERSIAN_MESSAGES.aiProviderSelected.replace("{provider}", ""),
            getAiProviderKeyboard(),
          );
        } else if (!existingTenant.lead_channel_id) {
          await ctx.reply(
            PERSIAN_MESSAGES.aiKeyValid.replace(
              "@{botUsername}",
              existingTenant.child_bot_username || "",
            ),
            Markup.inlineKeyboard([
              [Markup.button.callback("❌ انصراف", "cancel_flow")],
              [Markup.button.callback("ℹ️ راهنما", "help")],
            ]),
          );
        } else {
          await ctx.reply(PERSIAN_MESSAGES.hostingChoice, getHostingKeyboard());
        }
        break;
      case "ACTIVE":
        await ctx.reply(
          PERSIAN_MESSAGES.alreadyActive.replace(
            "@{botUsername}",
            existingTenant.child_bot_username || "",
          ),
          getMainKeyboard(isOwner),
        );
        break;
      case "REJECTED":
        await ctx.reply(
          "❌ درخواست شما رد شده است. برای اطلاعات بیشتر با پشتیبانی تماس بگیرید.",
          getMainKeyboard(isOwner),
        );
        break;
    }
    return;
  }

  await ctx.reply(PERSIAN_MESSAGES.welcome, getMainKeyboard(isOwner));
});

bot.action("request_bot", async (ctx) => {
  const userId = ctx.from!.id;
  const username = ctx.from!.username || "بدون آیدی";

  const existingTenant = await getTenantByTelegramId(userId);
  if (existingTenant && existingTenant.status !== "REJECTED") {
    await ctx.answerCbQuery("شما قبلاً درخواست داده‌اید");
    return;
  }

  // Ask for contact info first
  await ctx.editMessageText(PERSIAN_MESSAGES.requestContactInfo, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("❌ انصراف", "cancel_request_flow")],
    ]),
  });

  setUserState(userId, "awaiting_full_name");
  await ctx.answerCbQuery();
});

bot.action(/^approve_(.+)$/, async (ctx) => {
  const tenantId = ctx.match[1];
  const success = await updateTenantStatus(tenantId, "APPROVED");

  if (success) {
    const tenant = await getTenantById(tenantId);
    if (tenant) {
      await bot.telegram.sendMessage(
        tenant.telegram_user_id,
        PERSIAN_MESSAGES.userApproved,
      );
    }
    await ctx.editMessageText(PERSIAN_MESSAGES.ownerApproved);
  } else {
    await ctx.editMessageText("❌ خطا در تایید");
  }
  await ctx.answerCbQuery();
});

bot.action(/^reject_(.+)$/, async (ctx) => {
  const tenantId = ctx.match[1];
  const success = await updateTenantStatus(tenantId, "REJECTED");

  if (success) {
    const tenant = await getTenantById(tenantId);
    if (tenant) {
      await bot.telegram.sendMessage(
        tenant.telegram_user_id,
        "❌ درخواست شما رد شد. برای اطلاعات بیشتر با پشتیبانی تماس بگیرید.",
      );
    }
    await ctx.editMessageText(PERSIAN_MESSAGES.ownerRejected);
  } else {
    await ctx.editMessageText("❌ خطا در رد درخواست");
  }
  await ctx.answerCbQuery();
});

bot.action(/^cancel_request_(.+)$/, async (ctx) => {
  const tenantId = ctx.match[1];
  const userId = ctx.from!.id;

  // Verify this is the user's own request
  const tenant = await getTenantById(tenantId);
  if (!tenant || tenant.telegram_user_id !== userId) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  // Delete the tenant record
  const { error } = await supabase.from("tenants").delete().eq("id", tenantId);

  if (error) {
    await ctx.editMessageText("❌ خطا در انصراف از درخواست");
  } else {
    await ctx.editMessageText(
      "✅ درخواست شما با موفقیت لغو شد. می‌توانید با زدن /start مجدداً درخواست دهید.",
    );
  }
  await ctx.answerCbQuery();
});

bot.action("cancel_request_flow", async (ctx) => {
  const userId = ctx.from!.id;

  // Find and delete pending tenant for this user
  const tenant = await getTenantByTelegramId(userId);
  if (tenant && tenant.status === "PENDING") {
    await supabase.from("tenants").delete().eq("id", tenant.id);
  }

  clearUserState(userId);
  await ctx.editMessageText(
    "❌ <b>فرآیند لغو شد</b>\n\nبرای شروع مجدد از /start استفاده کنید.",
    { parse_mode: "HTML" },
  );
  await ctx.answerCbQuery();
});

bot.action("cancel_flow", async (ctx) => {
  const userId = ctx.from!.id;
  clearUserState(userId);
  const isOwner = String(userId) === OWNER_CHAT_ID;
  await ctx.editMessageText(PERSIAN_MESSAGES.welcome, getMainKeyboard(isOwner));
  await ctx.answerCbQuery("لغو شد");
});

bot.action("help", async (ctx) => {
  await ctx.editMessageText(PERSIAN_MESSAGES.help, getMainKeyboard());
  await ctx.answerCbQuery();
});

bot.action(/^ai_(.+)$/, async (ctx) => {
  const userId = ctx.from!.id;
  const state = getUserState(userId);
  const provider = ctx.match[1];

  if (provider === "help") {
    await ctx.editMessageText(
      `📖 <b>راهنمای دریافت کلید API</b>

    <b>OpenAI:</b> https://platform.openai.com/api-keys
    <b>DeepSeek:</b> https://platform.deepseek.com/api_keys
    <b>GapGPT:</b> https://gapgpt.app/dashboard/api-keys
    <b>Liara AI:</b> https://ai.liara.ir

اگر کلید ندارید، می‌توانید از مالک سیستم بپرسید.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔙 بازگشت", "back_to_ai")],
        ]),
      },
    );
    await ctx.answerCbQuery();
    return;
  }

  const providerNames: Record<string, string> = {
    openai: "OpenAI",
    deepseek: "DeepSeek",
    gapgpt: "GapGPT",
    liara: "Liara AI",
  };

  setUserState(userId, "awaiting_ai_key", { provider });
  await ctx.editMessageText(
    PERSIAN_MESSAGES.aiProviderSelected.replace(
      "{provider}",
      providerNames[provider],
    ),
    Markup.inlineKeyboard([
      [Markup.button.callback("🔙 بازگشت", "back_to_ai")],
      [Markup.button.callback("❌ انصراف", "cancel_flow")],
    ]),
  );
  await ctx.answerCbQuery();
});

bot.action("back_to_ai", async (ctx) => {
  await ctx.editMessageText(
    PERSIAN_MESSAGES.ingestionSuccess.split("\n\n")[1],
    getAiProviderKeyboard(),
  );
  await ctx.answerCbQuery();
});

bot.action("hosting_self", async (ctx) => {
  const userId = ctx.from!.id;
  const tenant = await getTenantByTelegramId(userId);

  await ctx.editMessageText(
    PERSIAN_MESSAGES.selfHostedGuide,
    getMainKeyboard(),
  );
  await ctx.answerCbQuery("راهنمای هاستینگ ارسال شد");
});

bot.action("hosting_custom", async (ctx) => {
  const userId = ctx.from!.id;
  const tenant = await getTenantByTelegramId(userId);

  if (tenant) {
    const customText = PERSIAN_MESSAGES.ownerCustomRequest
      .replace("{username}", tenant.telegram_username || "بدون آیدی")
      .replace("{website}", tenant.website_url || "")
      .replace("{provider}", tenant.ai_provider || "");
    await sendToOwner(customText);
  }

  await ctx.editMessageText(
    PERSIAN_MESSAGES.customRequest
      .replace("{username}", tenant?.telegram_username || "")
      .replace("{website}", tenant?.website_url || "")
      .replace("{provider}", tenant?.ai_provider || ""),
    getMainKeyboard(),
  );
  await ctx.answerCbQuery("درخواست ثبت شد");
});

bot.hears("/resync", async (ctx) => {
  const userId = ctx.from!.id;
  const tenant = await getTenantByTelegramId(userId);

  if (!tenant || tenant.status !== "ACTIVE") {
    await ctx.reply("❌ شما ربات فعالی ندارید.");
    return;
  }

  if (!tenant.website_url) {
    await ctx.reply("❌ آدرس وب‌سایت تنظیم نشده است.");
    return;
  }

  await ctx.reply(PERSIAN_MESSAGES.resyncStarted);

  const result = await ingestWebsite(tenant.id, tenant.website_url);

  if (result.success) {
    await ctx.reply(
      PERSIAN_MESSAGES.resyncComplete
        .replace("{pages}", result.pagesScraped.toString())
        .replace("{chunks}", result.chunksCreated.toString()),
    );
  } else {
    await ctx.reply(
      PERSIAN_MESSAGES.resyncFailed.replace(
        "{error}",
        result.error || "خطای ناشناخته",
      ),
    );
  }
});

bot.hears("/status", async (ctx) => {
  const userId = ctx.from!.id;
  const tenant = await getTenantByTelegramId(userId);

  if (!tenant) {
    await ctx.reply("شما هنوز درخواستی نداده‌اید. از /start استفاده کنید.");
    return;
  }

  const statusMap: Record<string, string> = {
    PENDING: "⏳ در انتظار تایید",
    APPROVED: "✅ تایید شده - در حال ساخت",
    REJECTED: "❌ رد شده",
    ACTIVE: "🟢 فعال",
  };

  let msg = `📊 <b>وضعیت ربات شما</b>\n\n`;
  msg += `<b>وضعیت:</b> ${statusMap[tenant.status]}\n`;
  if (tenant.child_bot_username)
    msg += `<b>ربات:</b> @${tenant.child_bot_username}\n`;
  if (tenant.website_url) msg += `<b>وب‌سایت:</b> ${tenant.website_url}\n`;
  if (tenant.ai_provider) msg += `<b>AI:</b> ${tenant.ai_provider}\n`;
  if (tenant.lead_channel_id) msg += `<b>کانال لیدها:</b> متصل ✅\n`;

  await ctx.reply(msg, { parse_mode: "HTML" });
});

bot.on("text", async (ctx) => {
  const userId = ctx.from!.id;
  const text = ctx.message.text;
  const state = getUserState(userId);

  if (
    state?.step === "awaiting_owner_password" &&
    String(userId) === OWNER_CHAT_ID
  ) {
    if (text === OWNER_PASSWORD) {
      ownerAuthState.set(userId, true);
      clearUserState(userId);
      await ctx.reply(
        "✅ احراز هویت موفقیت‌آمیز! به پنل مدیریت خوش آمدید.",
        getOwnerKeyboard(),
      );
    } else {
      await ctx.reply("❌ رمز عبور اشتباه است. دوباره تلاش کنید.");
    }
    return;
  }

  if (state?.step === "awaiting_full_name") {
    const fullName = text.trim();
    if (!fullName) {
      await ctx.reply("❌ لطفاً نام کامل خود را وارد کنید.");
      return;
    }

    setUserState(userId, "awaiting_phone", { fullName });
    await ctx.reply(PERSIAN_MESSAGES.requestPhone, { parse_mode: "HTML" });
    return;
  }

  if (state?.step === "awaiting_phone") {
    const phone = text.trim();
    if (!/^\+?[0-9][0-9\s-]{6,14}$/.test(phone)) {
      await ctx.reply(
        "❌ شماره تماس نامعتبر است. لطفاً شماره را دوباره وارد کنید.",
      );
      return;
    }

    const tenant = await createTenant(
      userId,
      ctx.from!.username,
      state.data?.fullName,
      phone,
    );
    if (!tenant) {
      await ctx.reply(PERSIAN_MESSAGES.error);
      clearUserState(userId);
      return;
    }

    clearUserState(userId);
    const username = ctx.from!.username || "بدون آیدی";
    const timestamp = new Date().toLocaleString("fa-IR");

    await ctx.reply(
      PERSIAN_MESSAGES.requestSent
        .replace("{username}", username)
        .replace("{userId}", userId.toString())
        .replace("{timestamp}", timestamp)
        .replace("{ownerUsername}", OWNER_USERNAME),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("ℹ️ راهنما", "help")],
        ]),
      },
    );

    const requestText = PERSIAN_MESSAGES.ownerNewRequest
      .replace("{username}", username)
      .replace("{userId}", userId.toString())
      .replace("{fullName}", state.data?.fullName || "")
      .replace("{phone}", phone)
      .replace("{timestamp}", timestamp);

    await sendApprovalRequest(requestText, getOwnerApprovalKeyboard(tenant.id));
    return;
  }

  // Handle owner managing user by ID
  if (
    state?.step === "awaiting_user_id_for_management" &&
    String(userId) === OWNER_CHAT_ID
  ) {
    const targetTelegramId = parseInt(text.trim());
    if (isNaN(targetTelegramId)) {
      await ctx.reply("❌ شناسه نامعتبر است. لطفاً یک عدد وارد کنید.");
      return;
    }

    const targetTenant = await getTenantByTelegramId(targetTelegramId);
    if (!targetTenant) {
      await ctx.reply("❌ کاربری با این ID یافت نشد.", {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_users")]]),
      });
      clearUserState(userId);
      return;
    }

    await showUserManagement(ctx, targetTenant);
    clearUserState(userId);
    return;
  }

  const tenant = await getTenantByTelegramId(userId);

  if (!tenant) {
    await ctx.reply("لطفاً ابتدا از /start استفاده کنید.");
    return;
  }

  if (tenant.status === "PENDING" || tenant.status === "REJECTED") {
    await ctx.reply("درخواست شما در انتظار تایید یا رد شده است.");
    return;
  }

  // Step: awaiting bot token
  if (
    state?.step === "awaiting_bot_token" ||
    (tenant.status === "APPROVED" && !tenant.child_bot_token)
  ) {
    const botInfo = await validateBotToken(text.trim());

    if (!botInfo || !botInfo.ok) {
      await ctx.reply(PERSIAN_MESSAGES.invalidToken);
      return;
    }

    const success = await updateTenantBotToken(
      tenant.id,
      text.trim(),
      botInfo.result.username,
    );
    if (!success) {
      await ctx.reply(PERSIAN_MESSAGES.error);
      return;
    }

    clearUserState(userId);
    await ctx.reply(
      PERSIAN_MESSAGES.tokenValid.replace(
        "@{botUsername}",
        botInfo.result.username,
      ),
      Markup.removeKeyboard(),
    );
    return;
  }

  // Step: awaiting website
  if (
    state?.step === "awaiting_website" ||
    (tenant.child_bot_token && !tenant.website_url)
  ) {
    setUserState(userId, "awaiting_website");

    const url = text.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      await ctx.reply("❌ آدرس باید با http:// یا https:// شروع شود.");
      return;
    }

    await updateTenantWebsite(tenant.id, url);
    await ctx.reply(PERSIAN_MESSAGES.websiteReceived.replace("{website}", url));

    const result = await ingestWebsite(tenant.id, url);

    if (result.success) {
      clearUserState(userId);
      await ctx.reply(
        PERSIAN_MESSAGES.ingestionSuccess
          .replace("{pages}", result.pagesScraped.toString())
          .replace("{chunks}", result.chunksCreated.toString()),
        getAiProviderKeyboard(),
      );
    } else {
      await ctx.reply(
        PERSIAN_MESSAGES.ingestionFailed.replace(
          "{error}",
          result.error || "خطای ناشناخته",
        ),
      );
    }
    return;
  }

  // Step: awaiting AI API key
  if (state?.step === "awaiting_ai_key" && state.data?.provider) {
    const provider = state.data.provider;
    const apiKey = text.trim();

    // Quick validation
    let isValid = false;
    try {
      if (provider === "openai") {
        const testClient = new (await import("openai")).OpenAI({ apiKey });
        await testClient.models.list();
        isValid = true;
      } else if (provider === "deepseek") {
        const testClient = new (await import("openai")).OpenAI({
          apiKey,
          baseURL: "https://api.deepseek.com/v1",
        });
        await testClient.models.list();
        isValid = true;
      } else if (provider === "gapgpt") {
        const testClient = new (await import("openai")).OpenAI({
          apiKey,
          baseURL: "https://api.gapgpt.app/v1",
        });
        await testClient.models.list();
        isValid = true;
      } else if (provider === "liara") {
        const testClient = new (await import("openai")).OpenAI({
          apiKey,
          baseURL: process.env.AI_LIARA_BASE_URL || "https://ai.liara.ir/api/6abe8dfc7ce6d9a9e0475844/v1",
        });
        await testClient.models.list();
        isValid = true;
      }
    } catch (e) {
      isValid = false;
    }

    if (!isValid) {
      await ctx.reply(PERSIAN_MESSAGES.aiKeyInvalid);
      return;
    }

    await updateTenantAIProvider(tenant.id, provider as any, apiKey);
    clearUserState(userId);

    await ctx.reply(
      PERSIAN_MESSAGES.aiKeyValid.replace(
        "@{botUsername}",
        tenant.child_bot_username || "",
      ),
      Markup.removeKeyboard(),
    );
    return;
  }

  // Default: show help
  await ctx.reply(PERSIAN_MESSAGES.help, getMainKeyboard());
});

bot.action("owner_panel", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }
  await ctx.editMessageText(
    "👑 <b>پنل مدیریت</b>\n\nچه کاری می‌خواهید انجام دهید؟",
    { parse_mode: "HTML", ...getOwnerKeyboard() },
  );
  await ctx.answerCbQuery();
});

bot.action("owner_pending", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const tenants = await getPendingTenants();
  if (tenants.length === 0) {
    await ctx.editMessageText(
      "هیچ درخواست معلقی وجود ندارد.",
      getOwnerKeyboard(),
    );
    await ctx.answerCbQuery();
    return;
  }

  for (const t of tenants) {
    await ctx.reply(
      `👤 @${t.telegram_username || "بدون آیدی"} (ID: ${t.telegram_user_id})\n📅 ${new Date(t.created_at).toLocaleString("fa-IR")}`,
      getOwnerApprovalKeyboard(t.id),
    );
  }
  await ctx.answerCbQuery(`${tenants.length} درخواست معلق`);
});

bot.action("owner_stats", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const { data: allTenants } = await supabase.from("tenants").select("status");
  const stats =
    allTenants?.reduce(
      (acc, t) => {
        acc[t.status] = (acc[t.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    ) || {};

  const statsText = Object.entries(stats)
    .map(([status, count]) => `${status}: ${count}`)
    .join("\n");

  await ctx.editMessageText(
    `📊 <b>آمار کلی</b>\n\n${statsText || "هیچ داده‌ای"}`,
    { parse_mode: "HTML", ...getOwnerKeyboard() },
  );
  await ctx.answerCbQuery();
});

// Advanced Reports
bot.action("owner_reports", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const [systemStats, recentLeads] = await Promise.all([
    getSystemStats(),
    getAllLeadSummaries(20),
  ]);

  // Top tenants by activity
  const { data: topTenants } = await supabase
    .from("tenants")
    .select("id, telegram_username, child_bot_username, status, created_at")
    .eq("status", "ACTIVE")
    .limit(10);

  const topTenantsWithStats = await Promise.all(
    (topTenants || []).map(async (t) => {
      const stats = await getTenantStats(t.id);
      return { ...t, stats };
    })
  );

  const sortedTenants = topTenantsWithStats.sort((a, b) => 
    (b.stats.totalSessions || 0) - (a.stats.totalSessions || 0)
  );

  let reportText = `📈 <b>گزارش‌های پیشرفته</b>\n\n`;
  
  reportText += `📊 <b>آمار کلی سیستم:</b>\n`;
  reportText += `  • کل کاربران: ${systemStats.totalTenants}\n`;
  reportText += `  • کاربران فعال: ${systemStats.activeTenants}\n`;
  reportText += `  • در انتظار تایید: ${systemStats.pendingTenants}\n`;
  reportText += `  • کل جلسات: ${systemStats.totalSessions}\n`;
  reportText += `  • کل لیدها: ${systemStats.totalLeads}\n\n`;

  reportText += `🏆 <b>پرفعال‌ترین ربات‌ها:</b>\n`;
  for (const t of sortedTenants.slice(0, 5)) {
    const botName = t.child_bot_username ? `@${t.child_bot_username}` : t.telegram_username || 'بدون آیدی';
    reportText += `  • ${botName}: ${t.stats.totalSessions} جلسات، ${t.stats.totalLeads} لید\n`;
  }

  reportText += `\n📋 <b>آخرین ۲۰ لید:</b>\n`;
  for (const lead of recentLeads.slice(0, 10)) {
    const botName = (lead as any).tenants?.child_bot_username || 'نامشخص';
    reportText += `  • @${botName}: ${lead.lead_name} (${lead.intent_level}) - ${new Date(lead.created_at).toLocaleString("fa-IR")}\n`;
  }

  await ctx.editMessageText(reportText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("📊 آمار لیدها", "owner_leads_stats")],
      [Markup.button.callback("📈 آمار پیام‌ها", "owner_messages_stats")],
      [Markup.button.callback("🔙 بازگشت", "owner_panel")],
    ]),
  });
  await ctx.answerCbQuery();
});

// Search Data
bot.action("owner_search", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  await ctx.editMessageText(
    `🔍 <b>جستجوی داده‌ها</b>\n\n` +
    `برای جستجو، یکی از گزینه‌های زیر را انتخاب کنید:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("👤 جستجوی کاربر (ID/Username)", "search_user")],
        [Markup.button.callback("🤖 جستجوی ربات", "search_bot")],
        [Markup.button.callback("📋 جستجوی لیدها", "search_leads")],
        [Markup.button.callback("💬 جستجوی جلسات", "search_sessions")],
        [Markup.button.callback("🔙 بازگشت", "owner_panel")],
      ]),
    }
  );
  await ctx.answerCbQuery();
});

// Export Data
bot.action("owner_export", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  await ctx.editMessageText(
    `📤 <b>صادرات داده‌ها</b>\n\n` +
    `فرمت و نوع داده را انتخاب کنید:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("👥 کاربران (CSV)", "export_users_csv"),
          Markup.button.callback("👥 کاربران (JSON)", "export_users_json"),
        ],
        [
          Markup.button.callback("📋 لیدها (CSV)", "export_leads_csv"),
          Markup.button.callback("📋 لیدها (JSON)", "export_leads_json"),
        ],
        [
          Markup.button.callback("💬 جلسات (CSV)", "export_sessions_csv"),
          Markup.button.callback("💬 جلسات (JSON)", "export_sessions_json"),
        ],
        [Markup.button.callback("📦 کل داده‌ها (ZIP)", "export_all_zip")],
        [Markup.button.callback("🔙 بازگشت", "owner_panel")],
      ]),
    }
  );
  await ctx.answerCbQuery();
});

// System Logs
bot.action("owner_logs", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  // Get recent errors/failed webhooks
  const { data: failedSessions } = await supabase
    .from("chat_sessions")
    .select("id, tenant_id, user_telegram_id, status, created_at, ended_at, message_count")
    .eq("status", "closed")
    .order("ended_at", { ascending: false })
    .limit(20);

  const { data: rejectedTenants } = await supabase
    .from("tenants")
    .select("id, telegram_user_id, telegram_username, status, created_at")
    .eq("status", "REJECTED")
    .order("created_at", { ascending: false })
    .limit(10);

  const { data: pendingTenants } = await supabase
    .from("tenants")
    .select("id, telegram_user_id, telegram_username, status, created_at")
    .eq("status", "PENDING")
    .order("created_at", { ascending: false })
    .limit(10);

  let logsText = `🔔 <b>لاگ‌های سیستم و هشدارها</b>\n\n`;

  logsText += `⏳ <b>درخواست‌های معلق (${pendingTenants?.length || 0}):</b>\n`;
  for (const t of pendingTenants || []) {
    logsText += `  • @${t.telegram_username || 'بدون آیدی'} (ID: ${t.telegram_user_id}) - ${new Date(t.created_at).toLocaleString("fa-IR")}\n`;
  }

  logsText += `\n❌ <b>کاربران رد شده اخیر (${rejectedTenants?.length || 0}):</b>\n`;
  for (const t of rejectedTenants || []) {
    logsText += `  • @${t.telegram_username || 'بدون آیدی'} (ID: ${t.telegram_user_id}) - ${new Date(t.created_at).toLocaleString("fa-IR")}\n`;
  }

  logsText += `\n📋 <b>جلسات بسته شده اخیر (${failedSessions?.length || 0}):</b>\n`;
  for (const s of failedSessions || []) {
    logsText += `  • Session: ${s.id.slice(0,8)} | User: ${s.user_telegram_id} | Msgs: ${s.message_count} | ${new Date(s.ended_at).toLocaleString("fa-IR")}\n`;
  }

  await ctx.editMessageText(logsText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🔄 تازه‌سازی", "owner_logs")],
      [Markup.button.callback("📋 لاگ‌های خطا", "owner_error_logs")],
      [Markup.button.callback("🔙 بازگشت", "owner_panel")],
    ]),
  });
  await ctx.answerCbQuery();
});

bot.action("owner_users", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  await showUsersList(ctx, 0);
  await ctx.answerCbQuery();
});

// Pagination handler
bot.action(/^owner_users_page_(-?\d+)$/, async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const page = parseInt(ctx.match[1]);
  if (page < 0) {
    await ctx.answerCbQuery("صفحه اول است");
    return;
  }

  await showUsersList(ctx, page);
  await ctx.answerCbQuery();
});

async function showUsersList(ctx: any, page: number) {
  const limit = 15;
  const tenants = await getAllTenants(limit, page * limit);
  const total = await getTenantCount();

  if (tenants.length === 0) {
    await ctx.editMessageText("هیچ کاربری وجود ندارد.", getOwnerKeyboard());
    return;
  }

  const statusEmoji: Record<string, string> = {
    PENDING: "⏳",
    APPROVED: "✅",
    REJECTED: "❌",
    ACTIVE: "🟢",
  };

  let listText = `👥 <b>لیست کاربران</b> (صفحه ${page + 1} از ${Math.ceil(total / limit)})\n`;
  listText += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const t of tenants) {
    const emoji = statusEmoji[t.status] || "❓";
    const botInfo = t.child_bot_username ? `@${t.child_bot_username}` : "—";
    const name = t.full_name || "نامشخص";
    const phone = t.phone || "نامشخص";
    const username = t.telegram_username || "بدون آیدی";

    listText += `${emoji} <b>${name}</b>\n`;
    listText += `   👤 @${username} | 🆔 ${t.telegram_user_id}\n`;
    listText += `   📞 ${phone} | 🤖 ${botInfo}\n`;
    listText += `   📊 ${t.status} | 🌐 ${t.website_url || "—"}\n\n`;
  }

  listText += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  listText += `💡 <b>برای مدیریت کاربر، ID تلگرام او را بفرستید.</b>\n`;
  listText += `مثال: <code>5774707521</code>`;

  const totalPages = Math.ceil(total / limit);
  const buttons: any[][] = [];

  if (totalPages > 1) {
    const navButtons = [];
    if (page > 0) navButtons.push(Markup.button.callback("⬅️ قبلی", `owner_users_page_${page - 1}`));
    if (page < totalPages - 1) navButtons.push(Markup.button.callback("بعدی ➡️", `owner_users_page_${page + 1}`));
    buttons.push(navButtons);
  }

  buttons.push([Markup.button.callback("🔍 جستجو", "owner_search")]);
  buttons.push([Markup.button.callback("🔙 بازگشت", "owner_panel")]);

  await ctx.editMessageText(listText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
}

// Show user management panel (by ID input)
async function showUserManagement(ctx: any, tenant: any) {
  const statusEmoji: Record<string, string> = {
    PENDING: "⏳",
    APPROVED: "✅",
    REJECTED: "❌",
    ACTIVE: "🟢",
  };

  const emoji = statusEmoji[tenant.status] || "❓";
  const stats = await getTenantStats(tenant.id);

  const buttons = [
    [Markup.button.callback("🔙 بازگشت", "owner_users")],
  ];

  // Add action buttons based on current status
  if (tenant.status === "ACTIVE") {
    buttons.unshift([
      Markup.button.callback("🔴 غیرفعال کردن (Revoke)", `revoke_user_${tenant.id}`),
      Markup.button.callback("🗑 حذف کامل", `delete_user_${tenant.id}`),
    ]);
  } else if (tenant.status === "APPROVED") {
    buttons.unshift([
      Markup.button.callback("🔴 رد کردن", `reject_user_${tenant.id}`),
      Markup.button.callback("🗑 حذف", `delete_user_${tenant.id}`),
    ]);
  } else if (tenant.status === "PENDING") {
    buttons.unshift([
      Markup.button.callback("✅ تایید", `approve_user_${tenant.id}`),
      Markup.button.callback("❌ رد", `reject_user_${tenant.id}`),
    ]);
  } else if (tenant.status === "REJECTED") {
    buttons.unshift([
      Markup.button.callback("🗑 حذف", `delete_user_${tenant.id}`),
    ]);
  }

  const botInfo = tenant.child_bot_username ? `@${tenant.child_bot_username}` : "بدون ربات";

  await ctx.editMessageText(
    `${emoji} <b>مدیریت کاربر</b>\n\n` +
      `👤 <b>@${tenant.telegram_username || "بدون آیدی"}</b> (ID: ${tenant.telegram_user_id})\n` +
      `📝 <b>نام:</b> ${tenant.full_name || "نامشخص"}\n` +
      `📞 <b>تلفن:</b> ${tenant.phone || "نامشخص"}\n` +
      `🤖 <b>ربات:</b> ${botInfo}\n` +
      `📊 <b>وضعیت:</b> ${tenant.status}\n` +
      `🌐 <b>وب‌سایت:</b> ${tenant.website_url || "تنظیم نشده"}\n` +
      `🤖 <b>AI:</b> ${tenant.ai_provider || "تنظیم نشده"}\n` +
      `📅 <b>ثبت‌نام:</b> ${new Date(tenant.created_at).toLocaleString("fa-IR")}\n\n` +
      `📈 <b>آمار:</b>\n` +
      `  • جلسات کل: ${stats.totalSessions || 0}\n` +
      `  • جلسات فعال: ${stats.activeSessions || 0}\n` +
      `  • کل لیدها: ${stats.totalLeads || 0}\n` +
      `  • کل پیام‌ها: ${stats.totalMessages || 0}\n\n` +
      `<b>عملیات مورد نظر را انتخاب کنید:</b>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    },
  );
}

// Trigger user management by typing ID
bot.action("owner_manage_by_id", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  await ctx.editMessageText(
    `🔍 <b>مدیریت کاربر بر اساس ID</b>\n\n` +
    `شناسه تلگرام (ID) کاربر را بفرستید:\n` +
    `مثال: <code>5774707521</code>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_users")]]),
    }
  );
  setUserState(ctx.from!.id, "awaiting_user_id_for_management");
  await ctx.answerCbQuery();
});

// Action handlers for user management
bot.action(/^approve_user_(.+)$/, async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const tenantId = ctx.match[1];
  const success = await updateTenantStatus(tenantId, "APPROVED");

  if (success) {
    const tenant = await getTenantById(tenantId);
    if (tenant) {
      await bot.telegram.sendMessage(
        tenant.telegram_user_id,
        PERSIAN_MESSAGES.userApproved,
      );
    }
    await ctx.answerCbQuery("✅ تایید شد");
    // Refresh the management view
    ctx.match[1] = tenantId; // Reuse for user_manage
    await ctx.editMessageText(
      "✅ کاربر تایید شد",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔙 بازگشت", "owner_users")],
      ]),
    );
  } else {
    await ctx.answerCbQuery("❌ خطا در تایید");
  }
});

bot.action(/^reject_user_(.+)$/, async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const tenantId = ctx.match[1];
  const success = await updateTenantStatus(tenantId, "REJECTED");

  if (success) {
    const tenant = await getTenantById(tenantId);
    if (tenant) {
      await bot.telegram.sendMessage(
        tenant.telegram_user_id,
        "❌ درخواست شما رد شد. برای اطلاعات بیشتر با پشتیبانی تماس بگیرید.",
      );
    }
    await ctx.answerCbQuery("❌ رد شد");
    await ctx.editMessageText(
      "❌ کاربر رد شد",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔙 بازگشت", "owner_users")],
      ]),
    );
  } else {
    await ctx.answerCbQuery("❌ خطا در رد");
  }
});

bot.action(/^revoke_user_(.+)$/, async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const tenantId = ctx.match[1];
  const success = await revokeTenantAccess(tenantId);

  if (success) {
    const tenant = await getTenantById(tenantId);
    if (tenant) {
      await bot.telegram.sendMessage(
        tenant.telegram_user_id,
        "⚠️ دسترسی ربات شما توسط مدیریت لغو شده است. برای اطلاعات بیشتر با پشتیبانی تماس بگیرید.",
      );
    }
    await ctx.answerCbQuery("🔴 دسترسی لغو شد");
    await ctx.editMessageText(
      "🔴 دسترسی کاربر لغو و وضعیت به REJECTED تغییر یافت",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔙 بازگشت", "owner_users")],
      ]),
    );
  } else {
    await ctx.answerCbQuery("❌ خطا در لغو دسترسی");
  }
});

bot.action(/^delete_user_(.+)$/, async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const tenantId = ctx.match[1];

  // Ask for confirmation
  await ctx.editMessageText(
    `⚠️ <b>تأیید حذف کاربر</b>\n\n` +
      `آیا مطمئن هستید که می‌خواهید این کاربر و تمام داده‌های او (پایگاه دانش، جلسات، لیدها) حذف شود؟\n` +
      `<b>این عملیات غیرقابل بازگشت است!</b>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ بله، حذف کن",
            `confirm_delete_user_${tenantId}`,
          ),
          Markup.button.callback("❌ انصراف", `user_manage_${tenantId}`),
        ],
      ]),
    },
  );
  await ctx.answerCbQuery();
});

bot.action(/^confirm_delete_user_(.+)$/, async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const tenantId = ctx.match[1];
  const success = await deleteTenant(tenantId);

  if (success) {
    await ctx.answerCbQuery("🗑 کاربر حذف شد");
    await ctx.editMessageText(
      "🗑 کاربر و تمام داده‌های او حذف شدند",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔙 بازگشت", "owner_users")],
      ]),
    );
  } else {
    await ctx.answerCbQuery("❌ خطا در حذف");
  }
});

// Hidden owner authentication command
bot.command("ashkan2077", async (ctx) => {
  const userId = ctx.from!.id;

  // Only allow if user is the owner
  if (String(userId) !== OWNER_CHAT_ID) {
    return; // Silently ignore for non-owners
  }

  // Check if already authenticated
  if (ownerAuthState.get(userId)) {
    await ctx.reply("✅ شما قبلاً احراز هویت شده‌اید.", getOwnerKeyboard());
    return;
  }

  // Ask for password
  await ctx.reply("🔐 <b>احراز هویت مالک</b>\n\nرمز عبور را وارد کنید:", {
    parse_mode: "HTML",
  });
  setUserState(userId, "awaiting_owner_password");
});

// Handle owner password input
bot.hears(/.*/, async (ctx) => {
  const userId = ctx.from!.id;
  const state = getUserState(userId);
  const text = ctx.message.text;

  // Check if awaiting owner password
  if (
    state?.step === "awaiting_owner_password" &&
    String(userId) === OWNER_CHAT_ID
  ) {
    if (text === OWNER_PASSWORD) {
      ownerAuthState.set(userId, true);
      clearUserState(userId);
      await ctx.reply(
        "✅ احراز هویت موفقیت‌آمیز! به پنل مدیریت خوش آمدید.",
        getOwnerKeyboard(),
      );
    } else {
      await ctx.reply("❌ رمز عبور اشتباه است. دوباره تلاش کنید.");
    }
    return;
  }

  // Check if awaiting contact info for request
  if (state?.step === "awaiting_contact_info") {
    const parts = text.split("|").map((p) => p.trim());
    if (parts.length < 2) {
      await ctx.reply(
        "❌ فرمت نادرست. لطفاً به صورت <b>نام کامل | شماره تماس</b> بفرستید.",
        { parse_mode: "HTML" },
      );
      return;
    }

    const fullName = parts[0];
    const phone = parts[1];

    // Create tenant with contact info
    const tenant = await createTenant(
      userId,
      ctx.from!.username,
      fullName,
      phone,
    );
    if (!tenant) {
      await ctx.reply(PERSIAN_MESSAGES.error);
      clearUserState(userId);
      return;
    }

    clearUserState(userId);

    const username = ctx.from!.username || "بدون آیدی";
    const timestamp = new Date().toLocaleString("fa-IR");

    await ctx.reply(
      PERSIAN_MESSAGES.requestSent
        .replace("{username}", username)
        .replace("{userId}", userId.toString())
        .replace("{timestamp}", timestamp)
        .replace("{ownerUsername}", OWNER_USERNAME),
      Markup.inlineKeyboard([[Markup.button.callback("ℹ️ راهنما", "help")]]),
    );

    const requestText = PERSIAN_MESSAGES.ownerNewRequest
      .replace("{username}", username)
      .replace("{userId}", userId.toString())
      .replace("{timestamp}", timestamp)
      .replace("{fullName}", fullName)
      .replace("{phone}", phone);

    await sendApprovalRequest(requestText, getOwnerApprovalKeyboard(tenant.id));
    return;
  }

  // Search handlers for owner
  if (String(userId) === OWNER_CHAT_ID) {
    if (state?.step === "awaiting_search_user") {
      const query = text.trim();
      const { data: tenants } = await supabase
        .from("tenants")
        .select("*")
        .or(`telegram_user_id.eq.${query},telegram_username.ilike.%${query}%`)
        .limit(20);

      if (!tenants || tenants.length === 0) {
        await ctx.reply("❌ کاربری یافت نشد.", { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_search")]]) });
        clearUserState(userId);
        return;
      }

      for (const t of tenants) {
        await ctx.reply(
          `👤 <b>@${t.telegram_username || 'بدون آیدی'}</b> (ID: ${t.telegram_user_id})\n` +
          `📝 نام: ${t.full_name || 'نامشخص'}\n📞 تلفن: ${t.phone || 'نامشخص'}\n` +
          `🤖 ربات: ${t.child_bot_username ? '@' + t.child_bot_username : 'بدون ربات'}\n` +
          `📊 وضعیت: ${t.status}\n🌐 وب‌سایت: ${t.website_url || 'تنظیم نشده'}\n` +
          `📅 ثبت‌نام: ${new Date(t.created_at).toLocaleString('fa-IR')}\n\n` +
          `💡 برای مدیریت، ID کاربر را بفرستید: <code>${t.telegram_user_id}</code>`,
          { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_search")]]) }
        );
      }
      clearUserState(userId);
      return;
    }

    if (state?.step === "awaiting_search_bot") {
      const query = text.trim().replace("@", "");
      const { data: tenants } = await supabase
        .from("tenants")
        .select("*")
        .ilike("child_bot_username", `%${query}%`)
        .limit(20);

      if (!tenants || tenants.length === 0) {
        await ctx.reply("❌ رباتی یافت نشد.", { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_search")]]) });
        clearUserState(userId);
        return;
      }

      for (const t of tenants) {
        await ctx.reply(
          `🤖 <b>@${t.child_bot_username}</b>\n` +
          `👤 مالک: @${t.telegram_username || 'بدون آیدی'} (ID: ${t.telegram_user_id})\n` +
          `📊 وضعیت: ${t.status}\n🌐 وب‌سایت: ${t.website_url || 'تنظیم نشده'}\n` +
          `📅 ثبت‌نام: ${new Date(t.created_at).toLocaleString('fa-IR')}\n\n` +
          `💡 برای مدیریت، ID مالک را بفرستید: <code>${t.telegram_user_id}</code>`,
          { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_search")]]) }
        );
      }
      clearUserState(userId);
      return;
    }

    if (state?.step === "awaiting_search_leads") {
      const query = text.trim();
      const { data: leads } = await supabase
        .from("lead_summaries")
        .select("*, tenants(telegram_username, child_bot_username)")
        .or(`lead_name.ilike.%${query}%,contact_info.ilike.%${query}%,summary.ilike.%${query}%`)
        .order("created_at", { ascending: false })
        .limit(20);

      if (!leads || leads.length === 0) {
        await ctx.reply("❌ لیدی یافت نشد.", { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_search")]]) });
        clearUserState(userId);
        return;
      }

      for (const l of leads) {
        const tenant = (l as any).tenants;
        await ctx.reply(
          `📋 <b>لید یافت شده</b>\n` +
          `🤖 ربات: @${tenant?.child_bot_username || 'نامشخص'}\n` +
          `👤 مالک: @${tenant?.telegram_username || 'نامشخص'}\n` +
          `🏷️ نام: ${l.lead_name || 'نامشخص'}\n📞 تماس: ${l.contact_info || 'نامشخص'}\n` +
          `🔥 تمایل: ${l.intent_level || 'نامشخص'}\n📝 خلاصه: ${l.summary || 'بدون خلاصه'}\n` +
          `📅 تاریخ: ${new Date(l.created_at).toLocaleString('fa-IR')}`,
          { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_search")]]) }
        );
      }
      clearUserState(userId);
      return;
    }

    if (state?.step === "awaiting_search_sessions") {
      const query = text.trim();
      const userIdNum = parseInt(query);
      if (isNaN(userIdNum)) {
        await ctx.reply("❌ شناسه نامعتبر است.", { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_search")]]) });
        clearUserState(userId);
        return;
      }

      const { data: sessions } = await supabase
        .from("chat_sessions")
        .select("*")
        .eq("user_telegram_id", userIdNum)
        .order("started_at", { ascending: false })
        .limit(20);

      if (!sessions || sessions.length === 0) {
        await ctx.reply("❌ جلسه‌ای یافت نشد.", { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_search")]]) });
        clearUserState(userId);
        return;
      }

      for (const s of sessions) {
        const { data: messages } = await supabase
          .from("chat_messages")
          .select("role, content, created_at")
          .eq("session_id", s.id)
          .order("created_at", { ascending: true })
          .limit(10);

        let msgText = `💬 <b>جلسه: ${s.id.slice(0,8)}</b>\n` +
          `👤 کاربر: ${s.user_telegram_id}\n` +
          `📊 وضعیت: ${s.status}\n📨 تعداد پیام: ${s.message_count}\n` +
          `📅 شروع: ${new Date(s.started_at).toLocaleString('fa-IR')}\n`;

        if (messages && messages.length > 0) {
          msgText += `\n📝 <b>پیام‌های اخیر:</b>\n`;
          for (const m of messages.slice(-5)) {
            msgText += `  ${m.role === 'user' ? '👤' : '🤖'} ${m.content.slice(0, 100)}\n`;
          }
        }

        await ctx.reply(msgText, { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_search")]]) });
      }
      clearUserState(userId);
      return;
    }
  }

  // Check if owner is authenticated for owner panel access
  const isOwner = String(userId) === OWNER_CHAT_ID;
  const isOwnerAuthed = isOwner && ownerAuthState.get(userId);

  // If owner but not authenticated, show help without owner panel
  if (isOwner && !isOwnerAuthed) {
    await ctx.reply(PERSIAN_MESSAGES.help, getMainKeyboard(false));
    return;
  }

  // Rest of existing text handler for tenants
  const tenant = await getTenantByTelegramId(userId);

  if (!tenant) {
    await ctx.reply(PERSIAN_MESSAGES.help, getMainKeyboard(isOwnerAuthed));
    return;
  }

  if (tenant.status === "PENDING" || tenant.status === "REJECTED") {
    await ctx.reply(
      "درخواست شما در انتظار تایید یا رد شده است.",
      getMainKeyboard(isOwnerAuthed),
    );
    return;
  }

  // Step: awaiting bot token
  if (
    state?.step === "awaiting_bot_token" ||
    (tenant.status === "APPROVED" && !tenant.child_bot_token)
  ) {
    const botInfo = await validateBotToken(text.trim());

    if (!botInfo || !botInfo.ok) {
      await ctx.reply(PERSIAN_MESSAGES.invalidToken);
      return;
    }

    const success = await updateTenantBotToken(
      tenant.id,
      text.trim(),
      botInfo.result.username,
    );
    if (!success) {
      await ctx.reply(PERSIAN_MESSAGES.error);
      return;
    }

    clearUserState(userId);
    await ctx.reply(
      PERSIAN_MESSAGES.tokenValid.replace(
        "@{botUsername}",
        botInfo.result.username,
      ),
      Markup.removeKeyboard(),
    );
    return;
  }

  // Step: awaiting website
  if (
    state?.step === "awaiting_website" ||
    (tenant.child_bot_token && !tenant.website_url)
  ) {
    setUserState(userId, "awaiting_website");

    const url = text.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      await ctx.reply("❌ آدرس باید با http:// یا https:// شروع شود.");
      return;
    }

    await updateTenantWebsite(tenant.id, url);
    await ctx.reply(PERSIAN_MESSAGES.websiteReceived.replace("{website}", url));

    const result = await ingestWebsite(tenant.id, url);

    if (result.success) {
      clearUserState(userId);
      await ctx.reply(
        PERSIAN_MESSAGES.ingestionSuccess
          .replace("{pages}", result.pagesScraped.toString())
          .replace("{chunks}", result.chunksCreated.toString()),
        getAiProviderKeyboard(),
      );
    } else {
      await ctx.reply(
        PERSIAN_MESSAGES.ingestionFailed.replace(
          "{error}",
          result.error || "خطای ناشناخته",
        ),
      );
    }
    return;
  }

  // Step: awaiting AI API key
  if (state?.step === "awaiting_ai_key" && state.data?.provider) {
    const provider = state.data.provider;
    const apiKey = text.trim();

    // Quick validation
    let isValid = false;
    try {
      if (provider === "openai") {
        const testClient = new (await import("openai")).OpenAI({ apiKey });
        await testClient.models.list();
        isValid = true;
      } else if (provider === "deepseek") {
        const testClient = new (await import("openai")).OpenAI({
          apiKey,
          baseURL: "https://api.deepseek.com/v1",
        });
        await testClient.models.list();
        isValid = true;
      } else if (provider === "gapgpt") {
        const testClient = new (await import("openai")).OpenAI({
          apiKey,
          baseURL: "https://api.gapgpt.app/v1",
        });
        await testClient.models.list();
        isValid = true;
      } else if (provider === "liara") {
        const testClient = new (await import("openai")).OpenAI({
          apiKey,
          baseURL: process.env.AI_LIARA_BASE_URL || "https://ai.liara.ir/api/6abe8dfc7ce6d9a9e0475844/v1",
        });
        await testClient.models.list();
        isValid = true;
      }
    } catch (e) {
      isValid = false;
    }

    if (!isValid) {
      await ctx.reply(PERSIAN_MESSAGES.aiKeyInvalid);
      return;
    }

    await updateTenantAIProvider(tenant.id, provider as any, apiKey);
    clearUserState(userId);

    await ctx.reply(
      PERSIAN_MESSAGES.aiKeyValid.replace(
        "@{botUsername}",
        tenant.child_bot_username || "",
      ),
      Markup.removeKeyboard(),
    );
    return;
  }

  // Default: show help
  await ctx.reply(PERSIAN_MESSAGES.help, getMainKeyboard(isOwnerAuthed));
});

// ==================== EXPORT HANDLERS ====================

bot.action("export_users_csv", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const tenants = await getAllTenants(10000, 0);
  const csv = [
    "ID,Telegram User ID,Username,Full Name,Phone,Role,Status,Bot Username,Website,AI Provider,Created At",
    ...tenants.map(t => 
      `"${t.id}","${t.telegram_user_id}","${t.telegram_username || ''}","${t.full_name || ''}","${t.phone || ''}","${t.role}","${t.status}","${t.child_bot_username || ''}","${t.website_url || ''}","${t.ai_provider || ''}","${t.created_at}"`
    )
  ].join("\n");

  await ctx.telegram.sendDocument(OWNER_CHAT_ID, {
    source: Buffer.from(csv, "utf-8"),
    filename: `users_export_${new Date().toISOString().split('T')[0]}.csv`,
  });
  await ctx.answerCbQuery("✅ فایل CSV کاربران ارسال شد");
});

bot.action("export_users_json", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const tenants = await getAllTenants(10000, 0);
  const json = JSON.stringify(tenants, null, 2);

  await ctx.telegram.sendDocument(OWNER_CHAT_ID, {
    source: Buffer.from(json, "utf-8"),
    filename: `users_export_${new Date().toISOString().split('T')[0]}.json`,
  });
  await ctx.answerCbQuery("✅ فایل JSON کاربران ارسال شد");
});

bot.action("export_leads_csv", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const leads = await getAllLeadSummaries(10000);
  const csv = [
    "ID,Session ID,Tenant ID,User Telegram ID,Lead Name,Contact Info,Intent Level,Summary,Message Count,Created At",
    ...leads.map(l => 
      `"${l.id}","${l.session_id}","${l.tenant_id}","${l.user_telegram_id}","${l.lead_name || ''}","${l.contact_info || ''}","${l.intent_level || ''}","${(l.summary || '').replace(/"/g, '""')}","${l.message_count}","${l.created_at}"`
    )
  ].join("\n");

  await ctx.telegram.sendDocument(OWNER_CHAT_ID, {
    source: Buffer.from(csv, "utf-8"),
    filename: `leads_export_${new Date().toISOString().split('T')[0]}.csv`,
  });
  await ctx.answerCbQuery("✅ فایل CSV لیدها ارسال شد");
});

bot.action("export_leads_json", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const leads = await getAllLeadSummaries(10000);
  const json = JSON.stringify(leads, null, 2);

  await ctx.telegram.sendDocument(OWNER_CHAT_ID, {
    source: Buffer.from(json, "utf-8"),
    filename: `leads_export_${new Date().toISOString().split('T')[0]}.json`,
  });
  await ctx.answerCbQuery("✅ فایل JSON لیدها ارسال شد");
});

bot.action("export_sessions_csv", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  const { data: sessions } = await supabase
    .from("chat_sessions")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(10000);

  const csv = [
    "ID,Tenant ID,User Telegram ID,Username,First Name,Last Name,Status,Started At,Ended At,Message Count",
    ...(sessions || []).map(s => 
      `"${s.id}","${s.tenant_id}","${s.user_telegram_id}","${s.user_username || ''}","${s.user_first_name || ''}","${s.user_last_name || ''}","${s.status}","${s.started_at}","${s.ended_at || ''}","${s.message_count}"`
    )
  ].join("\n");

  await ctx.telegram.sendDocument(OWNER_CHAT_ID, {
    source: Buffer.from(csv, "utf-8"),
    filename: `sessions_export_${new Date().toISOString().split('T')[0]}.csv`,
  });
  await ctx.answerCbQuery("✅ فایل CSV جلسات ارسال شد");
});

bot.action("export_all_zip", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  await ctx.answerCbQuery("⏳ در حال تهیه بسته کامل...");
  
  const [tenants, leads, sessions] = await Promise.all([
    getAllTenants(10000, 0),
    getAllLeadSummaries(10000),
    supabase.from("chat_sessions").select("*").order("started_at", { ascending: false }).limit(10000),
  ]);

  const exportData = {
    exported_at: new Date().toISOString(),
    tenants: tenants,
    leads: leads,
    sessions: sessions.data || [],
  };

  const json = JSON.stringify(exportData, null, 2);

  await ctx.telegram.sendDocument(OWNER_CHAT_ID, {
    source: Buffer.from(json, "utf-8"),
    filename: `full_export_${new Date().toISOString().split('T')[0]}.json`,
  });
  await ctx.answerCbQuery("✅ بسته کامل صادراتی ارسال شد");
});

// ==================== SEARCH HANDLERS ====================

bot.action("search_user", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  await ctx.editMessageText(
    `🔍 <b>جستجوی کاربر</b>\n\n` +
    `شناسه تلگرام (ID) یا نام کاربری (@username) کاربر را بفرستید:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_search")]]),
    }
  );
  setUserState(ctx.from!.id, "awaiting_search_user");
  await ctx.answerCbQuery();
});

bot.action("search_bot", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  await ctx.editMessageText(
    `🤖 <b>جستجوی ربات</b>\n\n` +
    `نام کاربری ربات (@botusername) را بفرستید:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_search")]]),
    }
  );
  setUserState(ctx.from!.id, "awaiting_search_bot");
  await ctx.answerCbQuery();
});

bot.action("search_leads", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  await ctx.editMessageText(
    `📋 <b>جستجوی لیدها</b>\n\n` +
    `کلیدواژه برای جستجو در نام، تماس یا خلاصه لیدها را بفرستید:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_search")]]),
    }
  );
  setUserState(ctx.from!.id, "awaiting_search_leads");
  await ctx.answerCbQuery();
});

bot.action("search_sessions", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) {
    await ctx.answerCbQuery("دسترسی ندارید");
    return;
  }

  await ctx.editMessageText(
    `💬 <b>جستجوی جلسات</b>\n\n` +
    `شناسه کاربر (Telegram ID) را بفرستید:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 بازگشت", "owner_search")]]),
    }
  );
  setUserState(ctx.from!.id, "awaiting_search_sessions");
  await ctx.answerCbQuery();
});

bot.command("cancel", async (ctx) => {
  const userId = ctx.from!.id;

  // Find and delete pending tenant for this user if exists
  const tenant = await getTenantByTelegramId(userId);
  if (tenant && tenant.status === "PENDING") {
    await supabase.from("tenants").delete().eq("id", tenant.id);
    await ctx.reply(
      "❌ <b>درخواست معلق شما لغو و حذف شد.</b>\n\nمی‌توانید با /start مجدداً درخواست دهید.",
      { parse_mode: "HTML" },
    );
  } else {
    clearUserState(userId);
    const isOwner = String(userId) === OWNER_CHAT_ID;
    await ctx.reply(PERSIAN_MESSAGES.welcome, getMainKeyboard(isOwner));
  }
});

bot.command("pending", async (ctx) => {
  if (String(ctx.from!.id) !== OWNER_CHAT_ID) return;

  const tenants = await getPendingTenants();
  if (tenants.length === 0) {
    await ctx.reply("هیچ درخواست معلقی وجود ندارد.");
    return;
  }

  for (const t of tenants) {
    await ctx.reply(
      `👤 @${t.telegram_username || "بدون آیدی"} (ID: ${t.telegram_user_id})\n📅 ${new Date(t.created_at).toLocaleString("fa-IR")}`,
      getOwnerApprovalKeyboard(t.id),
    );
  }
});

export async function startMotherBot() {
  console.log("Starting Mother Bot...");

  // Set webhook for mother bot if needed
  const webhookUrl = `https://${WEBHOOK_DOMAIN}/webhook/mother`;
  await setWebhook(process.env.MOTHER_BOT_TOKEN!, webhookUrl);

  await bot.launch();
  console.log("Mother Bot is running!");

  // Enable graceful stop
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

export { bot };
