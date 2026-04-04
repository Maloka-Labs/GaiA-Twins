#!/usr/bin/env npx tsx
/**
 * 🌿 Maloka AI Twins — RAG Content Ingestion Pipeline
 *
 * This script feeds the Qdrant knowledge base with real content from Max & Melini.
 * Run manually or on a schedule to keep the twins' knowledge fresh.
 *
 * Sources:
 *   1. SEED.md files (local, always available)
 *   2. YouTube transcripts via yt-dlp (free)
 *   3. Custom text chunks you can add below
 *
 * Usage:
 *   npx tsx scripts/ingest-rag.ts          # Ingest all sources
 *   npx tsx scripts/ingest-rag.ts seed     # Only SEED.md
 *   npx tsx scripts/ingest-rag.ts youtube  # Only YouTube
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Load .env ──
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
  for (const line of lines) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const QDRANT_URL = process.env.QDRANT_URL!;
const QDRANT_KEY = process.env.QDRANT_KEY!;
const GEMINI_KEY = process.env.GEMINI_API_KEY!;

// ── Config ──
const TWINS = {
  max: {
    twin: 'max',
    collection: 'gaia_healingmotions',
    seedPath: path.join(ROOT, 'groups', 'healingmotions', 'SEED.md'),
    youtubeUrls: [
      // Max's breathwork & yoga videos - replace with actual URLs for more content
      'https://www.youtube.com/watch?v=4nW8RInC5cw',  // Melini's yoga (shared)
    ],
    extraKnowledge: [
      // Add more knowledge chunks manually here
      `Max Lowenstein is a Registered Dietitian (RD) and certified yoga instructor with 218K followers on Instagram (@healingmotions). He specializes in breathwork, nutrition, and holistic wellness.`,
      `Max's signature breathwork technique is extended exhale breathing: inhale for 4 counts, hold for 4, exhale for 6-8 counts. This activates the parasympathetic nervous system and is ideal for stress and anxiety.`,
      `Box breathing is one of Max's favorite techniques for acute anxiety: inhale 4 counts, hold 4, exhale 4, hold 4. Used by Navy SEALs for performance under pressure.`,
      `Max teaches that nutrition starts with addition, not subtraction. His #1 tip: add one serving of leafy greens to a meal you already eat before removing any foods.`,
      `Max's approach to sleep optimization includes: no screens 1 hour before bed, extended exhale breathing to calm the nervous system, and a consistent sleep schedule to regulate circadian rhythm.`,
      `As a Registered Dietitian, Max focuses on anti-inflammatory foods: leafy greens, berries, fatty fish, turmeric, ginger, olive oil. He avoids recommending supplements without medical supervision.`,
      `Max's yoga practice is rooted in vinyasa (breath-movement synchronization), yin yoga for deep tissue release, and restorative yoga for nervous system recovery.`,
      `Max and his partner Liz Lowenstein co-create wellness content under "Heal with Max & Liz" with a combined audience of 3M+ followers.`,
      `Max's Maloka program is called "Change Your Breath, Change Your Life" — a structured breathwork curriculum for stress, anxiety, and performance optimization.`,
      `The vagus nerve is central to Max's wellness philosophy. Activities that stimulate it include: cold water exposure, humming/singing, deep diaphragmatic breathing, and social connection.`,
    ],
  },
  melini: {
    twin: 'melini',
    collection: 'gaia_meliniseri',
    seedPath: path.join(ROOT, 'groups', 'meliniseri', 'SEED.md'),
    youtubeUrls: [
      'https://www.youtube.com/watch?v=4nW8RInC5cw',  // Melini's yoga class
    ],
    extraKnowledge: [
      `Melini Jesudason is a world-renowned yoga instructor, Reiki Master, and spiritual medium with 400K followers on Instagram (@meliniseri). She teaches Ashtanga, inversions, and energy healing.`,
      `Melini's Ashtanga practice follows the traditional Mysore series. It builds internal heat (tapas) through breath-movement synchronization (vinyasa) and the three bandhas: mula, uddiyana, and jalandhara.`,
      `Melini specializes in yoga inversions including handstands, forearm stands, headstands, and shoulderstands. She teaches these as tools for shifting perspective both physically and mentally.`,
      `Melini is a Reiki Master certified in Usui Reiki. She channels universal life force energy (ki/prana) to support emotional, physical, and spiritual healing in her clients.`,
      `As a spiritual medium, Melini connects with higher consciousness and guides clients in accessing their own intuition and inner wisdom through yoga, meditation, and energy work.`,
      `Melini's teaching philosophy: "The body is the vehicle, the breath is the guide, and the spirit is the destination." She integrates physical practice with deep spiritual inquiry.`,
      `Melini's signature class format for beginners: 5 minutes breathwork centering → 15 minutes warm-up flow → 20 minutes peak practice → 10 minutes cool down → 5 minutes Savasana/meditation.`,
      `Melini has taught workshops at Alo Yoga, Wanderlust festivals, and retreat centers worldwide. Her online platform reaches practitioners in 50+ countries.`,
      `For energy healing, Melini recommends daily practices: morning sun salutations to activate solar plexus energy, evening yin yoga for releasing suppressed emotions from the hips.`,
      `Melini's approach to spirituality is non-dogmatic — she draws from yoga philosophy, Reiki principles, and universal consciousness teachings without imposing specific religious beliefs.`,
      `Melini's Maloka program focuses on "Body as Temple" — integrating Ashtanga discipline with Reiki energy work for a complete physical and spiritual transformation.`,
    ],
  },
};

// ── Utilities ──

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

/** Split text into ~500 character chunks at sentence boundaries */
function chunkText(text: string, maxChars = 500): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + ' ' + sentence).length > maxChars && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter(c => c.length > 50);
}

/** Get embeddings from Gemini */
async function getEmbedding(text: string): Promise<number[] | null> {
  if (!GEMINI_KEY) {
    log('⚠️  No GEMINI_API_KEY — using dummy vectors');
    return Array.from({ length: 768 }, (_, i) =>
      Math.sin(i + text.charCodeAt(i % text.length) * 0.01) * 0.5,
    );
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/text-embedding-004',
          content: { parts: [{ text }] },
        }),
      },
    );
    if (!res.ok) {
      log(`❌ Gemini embedding failed: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { embedding?: { values?: number[] } };
    return data.embedding?.values || null;
  } catch (err) {
    log(`❌ Embedding error: ${err}`);
    return null;
  }
}

/** Ensure Qdrant collection exists */
async function ensureCollection(collectionName: string) {
  if (!QDRANT_URL || !QDRANT_KEY || QDRANT_KEY === 'PENDING_QDRANT_KEY') {
    log(`⏭️  Skipping Qdrant (no key) — collection: ${collectionName}`);
    return false;
  }

  const checkRes = await fetch(`${QDRANT_URL}/collections/${collectionName}`, {
    headers: { 'api-key': QDRANT_KEY },
  });

  if (checkRes.status === 404) {
    log(`📦 Creating collection: ${collectionName}`);
    const createRes = await fetch(`${QDRANT_URL}/collections/${collectionName}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_KEY },
      body: JSON.stringify({ vectors: { size: 768, distance: 'Cosine' } }),
    });
    if (!createRes.ok) {
      log(`❌ Failed to create collection: ${await createRes.text()}`);
      return false;
    }
    log(`✅ Collection created: ${collectionName}`);
  }
  return true;
}

/** Index a text chunk into Qdrant */
async function indexChunk(collectionName: string, text: string, source: string, twin: string) {
  const vector = await getEmbedding(text);
  if (!vector) return false;

  if (!QDRANT_KEY || QDRANT_KEY === 'PENDING_QDRANT_KEY') {
    // Dry run — log what would be indexed
    log(`  [DRY RUN] Would index: "${text.slice(0, 80)}..." (source: ${source})`);
    return true;
  }

  const pointId = Date.now() + Math.floor(Math.random() * 9999);
  const res = await fetch(`${QDRANT_URL}/collections/${collectionName}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_KEY },
    body: JSON.stringify({
      points: [{ id: pointId, vector, payload: { text, source, twin } }],
    }),
  });

  return res.ok;
}

/** Ingest a SEED.md file */
async function ingestSeed(config: typeof TWINS.max) {
  log(`\n📖 Ingesting SEED.md for ${config.twin}...`);

  if (!fs.existsSync(config.seedPath)) {
    log(`⚠️  SEED.md not found: ${config.seedPath}`);
    return;
  }

  await ensureCollection(config.collection);
  const content = fs.readFileSync(config.seedPath, 'utf-8');
  const chunks = chunkText(content);
  log(`  Found ${chunks.length} chunks in SEED.md`);

  let success = 0;
  for (const chunk of chunks) {
    const ok = await indexChunk(config.collection, chunk, 'SEED.md', config.twin);
    if (ok) success++;
    await new Promise(r => setTimeout(r, 200)); // Rate limit safety
  }
  log(`  ✅ Seeded ${success}/${chunks.length} chunks`);
}

/** Ingest manual extra knowledge */
async function ingestExtraKnowledge(config: typeof TWINS.max) {
  log(`\n🧠 Ingesting extra knowledge for ${config.twin}...`);
  await ensureCollection(config.collection);

  let success = 0;
  for (const knowledge of config.extraKnowledge) {
    const ok = await indexChunk(config.collection, knowledge, 'curated-knowledge', config.twin);
    if (ok) success++;
    await new Promise(r => setTimeout(r, 200));
  }
  log(`  ✅ Indexed ${success}/${config.extraKnowledge.length} knowledge chunks`);
}

/** Ingest YouTube transcripts via yt-dlp */
async function ingestYouTube(config: typeof TWINS.max) {
  log(`\n🎬 Ingesting YouTube transcripts for ${config.twin}...`);

  // Check if yt-dlp is available
  try {
    execSync('yt-dlp --version', { stdio: 'pipe' });
  } catch {
    log(`⚠️  yt-dlp not found. Install with: pip install yt-dlp`);
    return;
  }

  await ensureCollection(config.collection);

  const tmpDir = path.join(ROOT, 'tmp_transcripts');
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const url of config.youtubeUrls) {
    log(`  📥 Downloading transcript: ${url}`);
    try {
      // Download transcript as VTT subtitle file
      const outputTemplate = path.join(tmpDir, '%(id)s.%(ext)s');
      execSync(
        `yt-dlp --write-auto-sub --sub-lang en --sub-format vtt --skip-download -o "${outputTemplate}" "${url}"`,
        { stdio: 'pipe' },
      );

      // Find downloaded files
      const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.vtt') || f.endsWith('.en.vtt'));

      for (const file of files) {
        const content = fs.readFileSync(path.join(tmpDir, file), 'utf-8');

        // Parse VTT: strip timestamps, deduplicate lines
        const lines = content
          .split('\n')
          .filter(l => l && !l.match(/^\d+:\d+/) && !l.match(/^WEBVTT/) && !l.match(/^NOTE/))
          .map(l => l.replace(/<[^>]+>/g, '').trim())
          .filter(l => l.length > 0);

        // Deduplicate consecutive duplicates (VTT repeats lines)
        const unique: string[] = [];
        for (const line of lines) {
          if (unique[unique.length - 1] !== line) unique.push(line);
        }

        const transcript = unique.join(' ');
        if (transcript.length < 100) {
          log(`  ⚠️  Transcript too short, skipping: ${file}`);
          continue;
        }

        const chunks = chunkText(transcript);
        log(`  Found ${chunks.length} chunks in transcript: ${file}`);

        let success = 0;
        for (const chunk of chunks) {
          const ok = await indexChunk(config.collection, chunk, `youtube:${url}`, config.twin);
          if (ok) success++;
          await new Promise(r => setTimeout(r, 300)); // Respect rate limits
        }
        log(`  ✅ Indexed ${success}/${chunks.length} transcript chunks`);

        // Cleanup
        fs.unlinkSync(path.join(tmpDir, file));
      }
    } catch (err) {
      log(`  ❌ Failed to process: ${url} — ${err}`);
    }
  }

  // Cleanup tmp dir
  try { fs.rmdirSync(tmpDir); } catch { /* ignore if not empty */ }
}

// ── Main ──
async function main() {
  const mode = process.argv[2] || 'all';

  log('🌿 Maloka RAG Content Ingestion Pipeline');
  log(`Mode: ${mode}`);
  log(`Qdrant: ${QDRANT_URL || 'NOT CONFIGURED'}`);
  log(`Qdrant Key: ${QDRANT_KEY && QDRANT_KEY !== 'PENDING_QDRANT_KEY' ? '✅ SET' : '⏸️  PENDING — running in DRY RUN mode'}`);
  log(`Gemini Key: ${GEMINI_KEY ? '✅ SET' : '❌ MISSING'}`);
  log('─'.repeat(60));

  for (const config of Object.values(TWINS)) {
    log(`\n${'═'.repeat(50)}`);
    log(`👤 Processing twin: ${config.twin.toUpperCase()}`);
    log(`${'═'.repeat(50)}`);

    if (mode === 'all' || mode === 'seed') {
      await ingestSeed(config);
    }

    if (mode === 'all' || mode === 'knowledge') {
      await ingestExtraKnowledge(config);
    }

    if (mode === 'all' || mode === 'youtube') {
      await ingestYouTube(config);
    }
  }

  log('\n✅ Pipeline complete!');

  if (!QDRANT_KEY || QDRANT_KEY === 'PENDING_QDRANT_KEY') {
    log('\n⚠️  DRY RUN completed. To activate:');
    log('  1. Go to https://cloud.qdrant.io');
    log('  2. Copy your API key');
    log('  3. Set QDRANT_KEY=your_key in .env and Railway');
    log('  4. Run this script again: npx tsx scripts/ingest-rag.ts');
  }
}

main().catch(console.error);
