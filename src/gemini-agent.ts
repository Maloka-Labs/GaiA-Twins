/**
 * Gemini Direct Agent — for Railway deployment (no Docker)
 *
 * When running on Railway, Docker containers are unavailable.
 * This module provides a direct Gemini API integration that:
 * 1. Reads the group's SEED.md and SOUL.md as system instructions
 * 2. Calls the Gemini API directly
 * 3. Returns the response text
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { createGovernanceGate } from './governance/gate.js';

/** Multimodal content part (forward-compatible with Flash-Lite 3.1) */
export interface MediaPart {
    type: 'image' | 'audio' | 'video';
    mimeType: string;
    data: string; // base64 or URI
}

export interface GeminiAgentInput {
    prompt: string;
    groupFolder: string;
    chatJid: string;
    assistantName?: string;
    /** Multimodal attachments — ready for Flash-Lite 3.1 native processing */
    media?: MediaPart[];
}

export interface GeminiAgentOutput {
    status: 'success' | 'error';
    result: string | null;
    error?: string;
}

/** Read the group's persona from SEED.md and SOUL.md */
function loadPersona(groupFolder: string): string {
    const parts: string[] = [];

    // Read SOUL.md (global identity)
    const soulPath = path.resolve(process.cwd(), 'workspace', 'SOUL.md');
    if (fs.existsSync(soulPath)) {
        parts.push(fs.readFileSync(soulPath, 'utf-8'));
    }

    // Read the group's SEED.md (AI-Twin Seed File)
    const seedPath = path.join(GROUPS_DIR, groupFolder, 'SEED.md');
    if (fs.existsSync(seedPath)) {
        parts.push(fs.readFileSync(seedPath, 'utf-8'));
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

/** Call Gemini API directly */
export async function runGeminiAgent(
    input: GeminiAgentInput,
): Promise<GeminiAgentOutput> {
    // Read API key from environment or .env file
    const envConfig = readEnvFile(['GEMINI_API_KEY', 'LLM_MODEL']);
    const apiKey = process.env.GEMINI_API_KEY || envConfig.GEMINI_API_KEY;
    const model = process.env.LLM_MODEL || envConfig.LLM_MODEL || 'gemini-3.1-flash';

    if (!apiKey) {
        logger.error('GEMINI_API_KEY not configured');
        return {
            status: 'error',
            result: null,
            error: 'Gemini API key not configured',
        };
    }

    try {
        // Load persona instructions
        const persona = loadPersona(input.groupFolder);

        logger.info(
            { group: input.groupFolder, model, promptLength: input.prompt.length },
            'Calling Gemini API directly (no container)',
        );

        // ── LOVEval Governance Gate: PRE-FILTER ──
        const gate = createGovernanceGate(input.groupFolder);
        const preCheck = gate.checkInput(input.prompt);

        if (!preCheck.allowed) {
            // Crisis detected — return redirect message instead of calling LLM
            logger.warn(
                { group: input.groupFolder, flags: preCheck.flags },
                'LOVEval Gate BLOCKED input — returning crisis redirect',
            );
            return {
                status: 'success',
                result: preCheck.redirectMessage || 'I\'m unable to help with that. Please reach out to a professional.',
            };
        }

        // Build content parts (text + optional multimodal)
        const contentParts: Array<Record<string, unknown>> = [{ text: input.prompt }];

        // Add multimodal parts if present (forward-compatible with Flash-Lite 3.1)
        if (input.media && input.media.length > 0) {
            for (const media of input.media) {
                contentParts.push({
                    inlineData: {
                        mimeType: media.mimeType,
                        data: media.data,
                    },
                });
            }
            logger.info(
                { mediaCount: input.media.length, types: input.media.map(m => m.type) },
                'Multimodal content attached to Gemini request',
            );
        }

        // Build request body
        const requestBody = {
            contents: [
                {
                    role: 'user',
                    parts: contentParts,
                },
            ],
            systemInstruction: {
                parts: [{ text: persona }],
            },
            generationConfig: {
                temperature: 0.8,
                topP: 0.95,
                maxOutputTokens: 1024,
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
            ],
        };

        // Call Gemini REST API
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(
                { status: response.status, error: errorText },
                'Gemini API error',
            );
            return {
                status: 'error',
                result: null,
                error: `Gemini API returned ${response.status}: ${errorText}`,
            };
        }

        const data = (await response.json()) as {
            candidates?: Array<{
                content?: { parts?: Array<{ text?: string }> };
                finishReason?: string;
            }>;
            error?: { message?: string };
        };

        // Extract response text
        const candidate = data.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text;

        if (!text) {
            logger.warn({ data }, 'Gemini returned empty response');
            return {
                status: 'error',
                result: null,
                error: 'Gemini returned empty response',
            };
        }

        logger.info(
            { group: input.groupFolder, responseLength: text.length },
            'Gemini response received',
        );

        // ── LOVEval Governance Gate: POST-FILTER ──
        const postCheck = gate.checkOutput(text, preCheck.flags);
        const finalText = postCheck.modifiedText || text;

        if (postCheck.flags.length > 0) {
            logger.info(
                { group: input.groupFolder, flags: postCheck.flags },
                'LOVEval Gate post-filter applied',
            );
        }

        // Strip <internal>...</internal> reasoning blocks — MUST NEVER reach the user
        const cleanText = finalText
            .replace(/<internal>[\s\S]*?<\/internal>/gi, '')
            .trim();

        if (!cleanText) {
            logger.warn({ group: input.groupFolder }, 'Gemini response was entirely internal reasoning — retrying with default fallback');
            return {
                status: 'error',
                result: null,
                error: 'Model response was all internal reasoning with no user-facing text',
            };
        }

        return {
            status: 'success',
            result: cleanText,
        };
    } catch (err) {
        logger.error({ err }, 'Failed to call Gemini API');
        return {
            status: 'error',
            result: null,
            error: `Gemini API call failed: ${err}`,
        };
    }
}
/**
 * Get vector embeddings for a piece of text using Gemini
 */
export async function getGeminiEmbedding(text: string): Promise<number[] | null> {
    const envConfig = readEnvFile(['GEMINI_API_KEY']);
    const apiKey = process.env.GEMINI_API_KEY || envConfig.GEMINI_API_KEY;

    if (!apiKey) {
        logger.error('GEMINI_API_KEY not configured for embeddings');
        return null;
    }

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'models/text-embedding-004',
                content: { parts: [{ text }] },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.warn({ status: response.status, error: errorText }, 'Gemini Embedding API error');
            return null;
        }

        const data = (await response.json()) as { embedding?: { values?: number[] } };
        return data.embedding?.values || null;
    } catch (err) {
        logger.error({ err }, 'Failed to call Gemini Embedding API');
        return null;
    }
}
