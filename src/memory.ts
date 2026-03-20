/**
 * MIT RLM User Memory — Supabase Integration
 *
 * Implements the "Longitudinal Memory" layer from the Skunkworks architecture plan.
 * Each conversation turn is stored in Supabase and retrieved to give the AI Twin
 * an evolving memory of the user over days/weeks/months.
 *
 * Table Schema (run in Supabase SQL editor):
 *
 *   CREATE TABLE user_memories (
 *     id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 *     chat_jid    TEXT NOT NULL,
 *     twin        TEXT NOT NULL,
 *     role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
 *     content     TEXT NOT NULL,
 *     created_at  TIMESTAMPTZ DEFAULT NOW()
 *   );
 *   CREATE INDEX idx_user_memories_chat ON user_memories (chat_jid, created_at DESC);
 */

import { logger } from './logger.js';
import { readEnvFile } from './env.js';

interface MemoryTurn {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

function getSupabaseConfig(): { url: string; key: string } | null {
  const env = readEnvFile(['SUPABASE_URL', 'SUPABASE_KEY']);
  const url = process.env.SUPABASE_URL || env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY || env.SUPABASE_KEY;
  if (!url || !key) {
    logger.warn('Supabase not configured — memory disabled. Set SUPABASE_URL and SUPABASE_KEY.');
    return null;
  }
  return { url, key };
}

/**
 * Saves a conversation turn (user message or assistant response) to memory.
 */
export async function saveMemory(
  chatJid: string,
  twin: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<void> {
  const config = getSupabaseConfig();
  if (!config) return;

  try {
    const response = await fetch(`${config.url}/rest/v1/user_memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ chat_jid: chatJid, twin, role, content }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn({ chatJid, status: response.status, errorText }, 'Failed to save memory to Supabase');
    } else {
      logger.debug({ chatJid, twin, role }, 'Memory saved to Supabase');
    }
  } catch (err) {
    logger.warn({ err, chatJid }, 'Supabase memory save error — continuing without memory');
  }
}

/**
 * Retrieves the last N conversation turns for a user.
 * Returns a formatted string ready to inject into the system prompt.
 */
export async function loadMemory(chatJid: string, twin: string, maxTurns = 10): Promise<string> {
  const config = getSupabaseConfig();
  if (!config) return '';

  try {
    const params = new URLSearchParams({
      select: 'role,content,created_at',
      chat_jid: `eq.${chatJid}`,
      twin: `eq.${twin}`,
      order: 'created_at.desc',
      limit: String(maxTurns * 2), // Each turn = user + assistant
    });

    const response = await fetch(`${config.url}/rest/v1/user_memories?${params}`, {
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
      },
    });

    if (!response.ok) {
      logger.warn({ chatJid, status: response.status }, 'Failed to load memory from Supabase');
      return '';
    }

    const turns: MemoryTurn[] = (await response.json()) as MemoryTurn[];
    if (!turns || turns.length === 0) return '';

    // Reverse to chronological order
    turns.reverse();

    const contextLines = turns.map(t =>
      `[${t.role === 'user' ? 'User' : 'You'}]: ${t.content}`,
    );

    logger.debug({ chatJid, twin, turns: turns.length }, 'Memory loaded from Supabase');

    return `\n\n## CONVERSATION MEMORY (Previous sessions with this user):\n${contextLines.join('\n')}\n\n(Use this memory to make the conversation feel continuous and personal. Reference it naturally when relevant.)\n`;
  } catch (err) {
    logger.warn({ err, chatJid }, 'Supabase memory load error — continuing without memory');
    return '';
  }
}
