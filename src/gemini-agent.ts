/**
 * Gemini Direct Agent — for Railway deployment (no Docker)
 *
 * When running on Railway, Docker containers are unavailable.
 * This module provides a direct Gemini API integration that:
 * 1. Reads the group's CLAUDE.md and SOUL.md as system instructions
 * 2. Calls the Gemini API directly
 * 3. Returns the response text
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';

export interface GeminiAgentInput {
    prompt: string;
    groupFolder: string;
    chatJid: string;
    assistantName?: string;
}

export interface GeminiAgentOutput {
    status: 'success' | 'error';
    result: string | null;
    error?: string;
}

/** Read the group's persona from CLAUDE.md and SOUL.md */
function loadPersona(groupFolder: string): string {
    const parts: string[] = [];

    // Read SOUL.md (global identity)
    const soulPath = path.resolve(process.cwd(), 'workspace', 'SOUL.md');
    if (fs.existsSync(soulPath)) {
        parts.push(fs.readFileSync(soulPath, 'utf-8'));
    }

    // Read the group's CLAUDE.md (specific persona)
    const claudePath = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
    if (fs.existsSync(claudePath)) {
        parts.push(fs.readFileSync(claudePath, 'utf-8'));
    }

    // If no persona files found, use a default
    if (parts.length === 0) {
        return 'You are a helpful wellness assistant. Be warm, encouraging, and keep responses short (3-4 sentences).';
    }

    return parts.join('\n\n---\n\n');
}

/** Call Gemini API directly */
export async function runGeminiAgent(
    input: GeminiAgentInput,
): Promise<GeminiAgentOutput> {
    // Read API key from environment or .env file
    const envConfig = readEnvFile(['GEMINI_API_KEY', 'LLM_MODEL']);
    const apiKey = process.env.GEMINI_API_KEY || envConfig.GEMINI_API_KEY;
    const model = process.env.LLM_MODEL || envConfig.LLM_MODEL || 'gemini-2.0-flash-lite';

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

        // Build request body
        const requestBody = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: input.prompt }],
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

        return {
            status: 'success',
            result: text,
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
