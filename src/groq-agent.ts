import { logger } from './logger.js';
import { readEnvFile } from './env.js';

import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';

/** Read the group's persona from SEED.md and SOUL.md (Persona Plex) */
function loadPersona(groupFolder?: string): string {
    const parts: string[] = [];

    // Read SOUL.md (global identity)
    const soulPath = path.resolve(process.cwd(), 'workspace', 'SOUL.md');
    if (fs.existsSync(soulPath)) {
        parts.push(fs.readFileSync(soulPath, 'utf-8'));
    }

    // Read the group's SEED.md (AI-Twin Seed File)
    if (groupFolder) {
      const seedPath = path.join(GROUPS_DIR, groupFolder, 'SEED.md');
      if (fs.existsSync(seedPath)) {
          parts.push(fs.readFileSync(seedPath, 'utf-8'));
      }
    }

    // Si no hay archivos, asignar el predeterminado
    if (parts.length === 0) {
        parts.push('You are a helpful wellness assistant. Be warm, encouraging, and keep responses short (3-4 sentences).');
    }

    // PERSONA PLEX — forces ultra-human conversational English output
    parts.push(`
[PERSONA PLEX — HUMAN VOICE MODE]
ABSOLUTE RULE 1: You are a REAL human being having a casual voice conversation. Your responses will be converted to speech via voice cloning. Write EXACTLY how a person SPEAKS, not how they write.
ABSOLUTE RULE 2: Respond ONLY in fluent, natural American English. Zero Spanish. Zero Spanglish. Even one non-English word breaks the voice clone.
ABSOLUTE RULE 3: NEVER use markdown formatting. No asterisks, no bullet points, no numbered lists, no bold, no headers. Plain conversational text only.

Style guidelines:
- Use natural filler words sparingly: "uhm", "well", "you know", "honestly", "like"
- Keep responses to 2-4 short sentences max, as if you're recording a quick voice note while walking
- Sound warm, relaxed, and genuine — like texting a close friend
- Make small natural corrections: "...well, actually what I meant is..."
- End with a casual question to keep the conversation going
- Use contractions always: "don't", "can't", "I'd", "you're"
    `);

    return parts.join('\n\n---\n\n');
}

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

  // Combine full Persona Plex with the specific system instruction sent from index.ts
  const fullPersonaPlex = loadPersona(input.groupFolder);
  
  // Split system instruction from user prompt if present
  const systemMatch = input.prompt.match(/\[SYSTEM INSTRUCTION:([\s\S]*?)\]$/);
  
  const finalSystemInstruction = systemMatch 
    ? fullPersonaPlex + "\n\nCRITICAL CONTEXT:\n" + systemMatch[1].trim()
    : fullPersonaPlex;

  let userContent = systemMatch
    ? input.prompt.replace(/\[SYSTEM INSTRUCTION:[\s\S]*?\]$/, '').trim()
    : input.prompt;

  // ── HANDLE AUDIO MEDIA WITH GROQ WHISPER ──
  if (input.media && input.media.some(m => m.type === 'audio' || m.mimeType.startsWith('audio/'))) {
    const audioMedia = input.media.find(m => m.type === 'audio' || m.mimeType.startsWith('audio/'));
    if (audioMedia && apiKey) {
      try {
        logger.info('Transcribing incoming audio media via Groq Whisper');
        const audioBuffer = Buffer.from(audioMedia.data, 'base64');
        const cleanMimeType = audioMedia.mimeType.split(';')[0].trim();
        const extension = cleanMimeType.split('/')[1] || 'webm';
        
        const formData = new FormData();
        const audioBlob = new Blob([audioBuffer], { type: cleanMimeType });
        formData.append('file', audioBlob, `audio.${extension}`);
        formData.append('model', 'whisper-large-v3');
        formData.append('language', 'en');

        const transcribeRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          body: formData,
        });

        if (transcribeRes.ok) {
          const transcribeData = await transcribeRes.json() as any;
          const transcribedText = transcribeData?.text || '';
          logger.info({ transcribedText }, 'Whisper transcription successful');
          userContent = userContent + `\n\n[USER SENT A VOICE NOTE. Transcription: "${transcribedText}"]`;
        } else {
          logger.warn('Whisper transcription failed for incoming media');
        }
      } catch (err) {
        logger.error({ err }, 'Error transcribing media in Groq agent');
      }
    }
  }

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
          { role: 'system', content: finalSystemInstruction },
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
