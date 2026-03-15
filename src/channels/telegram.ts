import { Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Called when a private chat needs auto-registration */
  onAutoRegister?: (chatJid: string, chatName: string, targetFolder?: string) => void;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online. 🌿\nAI Twins: Max (@healingmotions) & Melini (@meliniseri)`);
    });

    // /start command — welcome message + deep link routing
    this.bot.command('start', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const chatName = ctx.from?.first_name || 'friend';

      // Parse deep link payload (e.g. t.me/bot?start=melini -> ctx.match = 'melini')
      const payload = (ctx.match || '').toString().toLowerCase().trim();
      let targetFolder = 'healingmotions'; // default = Max
      if (payload === 'melini' || payload === 'meliniseri') {
        targetFolder = 'meliniseri';
      }

      // Register or switch twin for private chats
      if (ctx.chat.type === 'private' && this.opts.onAutoRegister) {
        this.opts.onAutoRegister(chatJid, chatName, targetFolder);
      }

      ctx.reply(
        `🌿 *Welcome to Good Vibes!*\n\n` +
        `I'm your AI-powered wellness guide. Chat with two amazing AI Twins:\n\n` +
        `🧘‍♂️ *Max Lowenstein* (@healingmotions)\n` +
        `  Breathwork • Yoga • Nutrition\n\n` +
        `🧘‍♀️ *Melini Jesudason* (@meliniseri)\n` +
        `  Ashtanga • Inversions • Energy Healing\n\n` +
        `Switch twins anytime: /max or /melini\n` +
        `Just send a message to start chatting! 💨`,
        { parse_mode: 'Markdown' },
      );
    });

    // /help command
    this.bot.command('help', (ctx) => {
      ctx.reply(
        `🌿 *Good Vibes Commands*\n\n` +
        `/start — Welcome & intro\n` +
        `/max — Switch to Max Lowenstein 🧘‍♂️\n` +
        `/melini — Switch to Melini Jesudason 🧘‍♀️\n` +
        `/ping — Check bot status\n` +
        `/help — This menu\n\n` +
        `Or just type your question! 💬`,
        { parse_mode: 'Markdown' },
      );
    });

    // /max command — switch to Max
    this.bot.command('max', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const chatName = ctx.from?.first_name || 'friend';
      if (this.opts.onAutoRegister) {
        this.opts.onAutoRegister(chatJid, chatName, 'healingmotions');
      }
      ctx.reply(
        `🧘‍♂️ *Switched to Max!*\n` +
        `How can I help with your breathwork, nutrition or yoga today?`,
        { parse_mode: 'Markdown' },
      );
    });

    // /melini command — switch to Melini
    this.bot.command('melini', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const chatName = ctx.from?.first_name || 'friend';
      if (this.opts.onAutoRegister) {
        this.opts.onAutoRegister(chatJid, chatName, 'meliniseri');
      }
      ctx.reply(
        `🧘‍♀️ *Switched to Melini!*\n` +
        `Ready to explore Ashtanga, inversions and deep energy healing?`,
        { parse_mode: 'Markdown' },
      );
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

      // Auto-register private chats that aren't registered yet
      const groups = this.opts.registeredGroups();
      if (!groups[chatJid] && ctx.chat.type === 'private') {
        if (this.opts.onAutoRegister) {
          this.opts.onAutoRegister(chatJid, chatName);
          logger.info({ chatJid, chatName }, 'Auto-registered private Telegram chat');
        } else {
          logger.debug(
            { chatJid, chatName },
            'Message from unregistered Telegram chat (no auto-register)',
          );
          return;
        }
      }

      // Check registration again after potential auto-register
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid, chatName }, 'Message from unregistered Telegram chat');
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) =>
      storeNonText(ctx, '[Voice message]'),
    );
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}
