import 'dotenv/config';
import axios from 'axios';
import { BotInfo } from '../types';

const TELEGRAM_API = 'https://api.telegram.org/bot';

export async function validateBotToken(token: string): Promise<BotInfo | null> {
  try {
    const response = await axios.get<BotInfo>(`${TELEGRAM_API}${token}/getMe`, {
      timeout: 10000,
    });
    return response.data;
  } catch (error) {
    console.error('Error validating bot token:', error);
    return null;
  }
}

export async function setWebhook(token: string, webhookUrl: string): Promise<boolean> {
  try {
    const response = await axios.post(`${TELEGRAM_API}${token}/setWebhook`, {
      url: webhookUrl,
      allowed_updates: ['message', 'channel_post', 'callback_query'],
    }, {
      timeout: 10000,
    });
    return response.data.ok;
  } catch (error) {
    console.error('Error setting webhook:', error);
    return false;
  }
}

export async function deleteWebhook(token: string): Promise<boolean> {
  try {
    const response = await axios.post(`${TELEGRAM_API}${token}/deleteWebhook`, {}, {
      timeout: 10000,
    });
    return response.data.ok;
  } catch (error) {
    console.error('Error deleting webhook:', error);
    return false;
  }
}

export async function sendMessage(token: string, chatId: number | string, text: string, parseMode?: string): Promise<boolean> {
  try {
    const response = await axios.post(`${TELEGRAM_API}${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    }, {
      timeout: 10000,
    });
    return response.data.ok;
  } catch (error) {
    console.error('Error sending message:', error);
    return false;
  }
}

export async function sendMessageWithKeyboard(
  token: string, 
  chatId: number | string, 
  text: string, 
  keyboard: { text: string; callback_data: string }[][],
  parseMode?: string
): Promise<boolean> {
  try {
    const response = await axios.post(`${TELEGRAM_API}${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, {
      timeout: 10000,
    });
    return response.data.ok;
  } catch (error) {
    console.error('Error sending message with keyboard:', error);
    return false;
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
  try {
    const response = await axios.post(`${TELEGRAM_API}${process.env.MOTHER_BOT_TOKEN}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text,
    }, {
      timeout: 10000,
    });
    return response.data.ok;
  } catch (error) {
    console.error('Error answering callback query:', error);
    return false;
  }
}