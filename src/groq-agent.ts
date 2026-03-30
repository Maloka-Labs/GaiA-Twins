import { logger } from './logger.js';
import { readEnvFile } from './env.js';

/**
 * Groq API Agent — Uses Llama 3.3 via Groq for ultra-fast, quota-free responses.
 * This is a drop-in replacement for runGeminiAgent.
 */
export async function runGroqAgent(input: {
  prompt: string;
  groupFolder?: string;
  chatJid?: string;
  assistantName?: string;
  media?: Array<{ type: string; mimeType: string; data: string }>;
}): Promise<{ status: 'success' | 'error'; result: string | null; error?: string }> {
  const env = readEnvFile(['GROQ_API_KEY', 'GROQ_MODEL']);
  const apiKey = process.env.GROQ_API_KEY || env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  if (!apiKey) {
    logger.error('GROQ_API_KEY not configured');
    return { status: 'error', result: null, error: 'GROQ_API_KEY not configured' };
  }

  // Split system instruction from user prompt if present
  const systemMatch = input.prompt.match(/\[SYSTEM INSTRUCTION:([\s\S]*?)\]$/);
  const systemContent = systemMatch ? systemMatch[1].trim() : 'You are a helpful wellness AI assistant.';
  const userContent = systemMatch
    ? input.prompt.replace(/\[SYSTEM INSTRUCTION:[\s\S]*?\]$/, '').trim()
    : input.prompt;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent },
        ],
        temperature: 0.8,
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error({ status: response.status, errText }, 'Groq API error');
      return { status: 'error', result: null, error: errText };
    }

    const data = await response.json() as any;
    const text = data?.choices?.[0]?.message?.content;

    if (text) {
      logger.info({ model, chars: text.length }, 'Groq response received');
      return { status: 'success', result: text };
    }

    return { status: 'error', result: null, error: 'Empty response from Groq' };
  } catch (err: any) {
    logger.error({ err }, 'Groq fetch error');
    return { status: 'error', result: null, error: err?.message || 'Unknown error' };
  }
}
