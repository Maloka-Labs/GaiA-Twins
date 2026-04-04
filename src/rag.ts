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
import { getGeminiEmbedding } from './gemini-agent.js';

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
    // ── PHASE 2: REAL GEMINI EMBEDDINGS ──
    const vector = await getGeminiEmbedding(text);
    if (!vector) {
      logger.warn({ twin }, 'Failed to get gemini embedding — skipping indexing');
      return;
    }

    const pointId = Date.now() + Math.floor(Math.random() * 1000); // Random offset for bulk indexing
    const res = await fetch(`${config.url}/collections/${name}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': config.key },
      body: JSON.stringify({
        points: [{ id: pointId, vector, payload: { text, source, twin } }],
      }),
    });

    if (res.ok) {
      logger.info({ twin, source, length: text.length }, 'Knowledge indexed in Qdrant with real embeddings');
    } else {
      const errorText = await res.text();
      logger.warn({ twin, status: res.status, errorText }, 'Qdrant index failed');
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
    // ── PHASE 2: VECTOR SIMILARITY SEARCH ──
    const vector = await getGeminiEmbedding(query);
    if (!vector) {
       logger.warn({ twin }, 'Embedding failed for query — falling back to keyword scroll');
       return ''; // Or handle with scroll if desired
    }

    const res = await fetch(`${config.url}/collections/${name}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': config.key },
      body: JSON.stringify({ 
        vector, 
        limit: maxResults, 
        with_payload: true,
        score_threshold: 0.5 // Threshold for relevance
      }),
    });

    if (!res.ok) {
      if (res.status === 404) return ''; 
      logger.warn({ twin, status: res.status }, 'Qdrant vector search failed');
      return '';
    }

    const data = (await res.json()) as { result?: QdrantPoint[] };
    const points = data.result || [];

    if (points.length === 0) return '';

    const contextLines = points.map(p => `- ${p.payload.text}`).join('\n');
    logger.debug({ twin, query, resultsFound: points.length }, 'RAG semantic knowledge retrieved from Qdrant');

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
