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
import { storeUserMemory, getUserMemories } from './db.js';

interface MemoryTurn {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

/**
 * Saves a conversation turn (user message or assistant response) to memory.
 * Primary: SQLite local. Fallback to Supabase if ever enabled.
 */
export async function saveMemory(
  chatJid: string,
  twin: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<void> {
  try {
    // ── PRIMARY: Local SQLite ──
    storeUserMemory(chatJid, twin, role, content);
    logger.debug({ chatJid, twin, role }, 'Memory saved to SQLite');

  } catch (err) {
    logger.warn({ err, chatJid }, 'Memory save error — continuing without memory');
  }
}

/**
 * Retrieves the last N conversation turns for a user.
 * Returns a formatted string ready to inject into the system prompt.
 */
export async function loadMemory(chatJid: string, twin: string, maxTurns = 10): Promise<string> {
  try {
    // ── PRIMARY: Local SQLite ──
    const turns: MemoryTurn[] = getUserMemories(chatJid, twin, maxTurns * 2);
    
    if (!turns || turns.length === 0) return '';

    // Reverse to chronological order (db returns DESC)
    turns.reverse();

    const contextLines = turns.map(t =>
      `[${t.role === 'user' ? 'User' : 'You'}]: ${t.content}`,
    );

    logger.debug({ chatJid, twin, turns: turns.length }, 'Memory loaded from SQLite');

    return `\n\n## CONVERSATION MEMORY (Previous sessions with this user):\n${contextLines.join('\n')}\n\n(Use this memory to make the conversation feel continuous and personal. Reference it naturally when relevant.)\n`;
  } catch (err) {
    logger.warn({ err, chatJid }, 'Memory load error — continuing without memory');
    return '';
  }
}
