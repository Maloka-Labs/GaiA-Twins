/**
 * RAG (Retrieval-Augmented Generation) — Qdrant Integration
 *
 * Implements the practitioner knowledge silo architecture.
 * Each twin (Max, Melini) has their own Qdrant collection.
 * User queries are embedded via Gemini and matched to relevant knowledge.
 *
 * Phase 1 (current): Simple keyword-based search (no GPU needed).
 * Phase 2: Replace with real Gemini embedding vectors once quota allows.
 *
 * Qdrant Collection Schema:
 *   - vector: 768 dimensions (Gemini text-embedding-004)
 *   - payload: { text: string, source: string, twin: string }
 */

import { logger } from './logger.js';
import { readEnvFile } from './env.js';

interface QdrantPoint {
  id: number | string;
  payload: { text: string; source: string; twin: string };
  score?: number;
}

function getQdrantConfig(): { url: string; key: string } | null {
  const env = readEnvFile(['QDRANT_URL', 'QDRANT_KEY']);
  const url = process.env.QDRANT_URL || env.QDRANT_URL;
  const key = process.env.QDRANT_KEY || env.QDRANT_KEY;
  if (!url || !key || key === 'PENDING_QDRANT_KEY') {
    logger.debug('Qdrant not configured — RAG disabled. Set QDRANT_URL and QDRANT_KEY.');
    return null;
  }
  return { url, key };
}

/** Get the collection name for a twin */
function collectionName(twin: string): string {
  return `gaia_${twin === 'melini' ? 'meliniseri' : 'healingmotions'}`;
}

/**
 * Ensure a Qdrant collection exists for the twin.
 * Creates it if not found (idempotent).
 */
export async function ensureCollection(twin: string): Promise<void> {
  const config = getQdrantConfig();
  if (!config) return;

  const name = collectionName(twin);
  try {
    // Check if collection exists
    const checkRes = await fetch(`${config.url}/collections/${name}`, {
      headers: { 'api-key': config.key },
    });

    if (checkRes.status === 404) {
      // Create collection with Gemini embedding dimensions (768)
      const createRes = await fetch(`${config.url}/collections/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'api-key': config.key },
        body: JSON.stringify({
          vectors: { size: 768, distance: 'Cosine' },
        }),
      });
      if (createRes.ok) {
        logger.info({ twin, collection: name }, 'Qdrant collection created');
      }
    }
  } catch (err) {
    logger.warn({ err, twin }, 'Qdrant collection check/create error');
  }
}

/**
 * Index a piece of knowledge (text) into the twin's Qdrant collection.
 * Since we can't call Gemini embeddings cheaply, we store a dummy vector
 * and use Qdrant's scroll+filter for keyword search in Phase 1.
 */
export async function indexKnowledge(
  twin: string,
  text: string,
  source: string,
): Promise<void> {
  const config = getQdrantConfig();
  if (!config) return;

  await ensureCollection(twin);
  const name = collectionName(twin);

  try {
    // Use a simple hash-based placeholder vector for Phase 1 (no GPU needed)
    const vector = Array.from({ length: 768 }, (_, i) =>
      Math.sin(i + text.charCodeAt(i % text.length) * 0.01) * 0.5,
    );

    const pointId = Date.now();
    const res = await fetch(`${config.url}/collections/${name}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': config.key },
      body: JSON.stringify({
        points: [{ id: pointId, vector, payload: { text, source, twin } }],
      }),
    });

    if (res.ok) {
      logger.info({ twin, source, length: text.length }, 'Knowledge indexed in Qdrant');
    } else {
      logger.warn({ twin, status: res.status }, 'Qdrant index failed');
    }
  } catch (err) {
    logger.warn({ err, twin }, 'Qdrant indexKnowledge error');
  }
}

/**
 * Search for relevant knowledge for a user query using Qdrant scroll+filter (Phase 1).
 * Returns a formatted context block ready to inject into the AI prompt.
 */
export async function searchKnowledge(query: string, twin: string, maxResults = 3): Promise<string> {
  const config = getQdrantConfig();
  if (!config) return '';

  const name = collectionName(twin);

  try {
    // Phase 1: Scroll all points and keyword-filter in-process
    // Phase 2: Replace with proper vector similarity search using Gemini embeddings
    const res = await fetch(`${config.url}/collections/${name}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': config.key },
      body: JSON.stringify({ limit: 50, with_payload: true }),
    });

    if (!res.ok) {
      if (res.status === 404) return ''; // Collection doesn't exist yet — fine
      logger.warn({ twin, status: res.status }, 'Qdrant scroll failed');
      return '';
    }

    const data = (await res.json()) as { result?: { points?: QdrantPoint[] } };
    const points = data.result?.points || [];

    if (points.length === 0) return '';

    // Keyword match (case-insensitive)
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const scored = points
      .map((p) => {
        const textLower = (p.payload.text || '').toLowerCase();
        const score = queryWords.filter(w => textLower.includes(w)).length;
        return { text: p.payload.text, score };
      })
      .filter(p => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    if (scored.length === 0) return '';

    const contextLines = scored.map(p => `- ${p.text}`).join('\n');
    logger.debug({ twin, query, resultsFound: scored.length }, 'RAG knowledge retrieved from Qdrant');

    return `\n\n## RELEVANT KNOWLEDGE FROM YOUR PRACTICE:\n${contextLines}\n\n(Use this knowledge naturally in your response when it fits the conversation.)\n`;
  } catch (err) {
    logger.warn({ err, twin }, 'Qdrant searchKnowledge error — continuing without RAG');
    return '';
  }
}

/**
 * One-time indexing of the SEED.md practitioner knowledge.
 * Call this at startup to populate Qdrant with the twin's core knowledge.
 */
export async function seedTwinKnowledge(twin: string, seedContent: string): Promise<void> {
  const config = getQdrantConfig();
  if (!config) return;

  // Split SEED.md into chunks by double newline
  const chunks = seedContent
    .split(/\n\n+/)
    .map(c => c.trim())
    .filter(c => c.length > 50 && !c.startsWith('#'));

  logger.info({ twin, chunks: chunks.length }, 'Seeding twin knowledge into Qdrant');

  for (const chunk of chunks) {
    await indexKnowledge(twin, chunk, 'SEED.md');
  }
}
