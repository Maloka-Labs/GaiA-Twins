import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import util from 'util';
import { logger } from '../logger.js';

const execFileAsync = util.promisify(execFile);

/**
 * Voice generation with two strategies:
 * 1. PRIMARY: Gradio XTTS voice cloning (uses max_voice.aac / melini_voice.aac)
 * 2. FALLBACK: Edge-TTS with warm neural voices (always works)
 */
export async function generateEnglishVoice(twin: 'max' | 'melini', text: string): Promise<string> {
  const outputPath = path.join(process.cwd(), `tmp_${twin}_${Date.now()}.mp3`);
  
  // Clean text: strip ALL markdown so TTS doesn't read asterisks/hashes
  const cleanEnglish = text
    .replace(/[*_~\[\]`#>•]/g, '')
    .replace(/\n+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || "Hmm, what was that?";

  if (cleanEnglish.length === 0) return "";

  // ── STRATEGY 1: ElevenLabs (High Fidelity Clone) ──
  const elKey = process.env.ELEVENLABS_API_KEY;
  const elVoiceId = twin === 'max' 
    ? process.env.ELEVENLABS_MAX_VOICE_ID 
    : process.env.ELEVENLABS_MELINI_VOICE_ID;

  if (elKey && elVoiceId && !elVoiceId.startsWith('PENDING')) {
    try {
      logger.info({ twin, voiceId: elVoiceId }, 'Attempting ElevenLabs voice clone');
      
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elVoiceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': elKey,
        },
        body: JSON.stringify({
          text: cleanEnglish,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.75,
            similarity_boost: 0.85,
          },
        }),
      });

      if (response.ok) {
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(outputPath, Buffer.from(buffer));
        logger.info({ twin }, 'ElevenLabs voice generated successfully');
        return outputPath;
      } else {
        const errorText = await response.text();
        logger.warn({ twin, status: response.status, errorText }, 'ElevenLabs failed, falling back');
      }
    } catch (err) {
      logger.warn({ twin, err }, 'ElevenLabs error, falling back');
    }
  }

  // ── STRATEGY 2: Try Gradio XTTS voice cloning (Legacy Fallback) ──
  // Using a community XTTS space as default if NOT provided in .env
  const xttsSpace = process.env.XTTS_GRADIO_SPACE || "coqui/xtts"; 
  
  if (xttsSpace) {
    try {
      const referenceAudio = path.join(
        process.cwd(), 
        twin === 'max' ? 'max_voice.aac' : 'melini_voice.aac'
      );
      
      if (fs.existsSync(referenceAudio)) {
        logger.info({ twin, space: xttsSpace }, 'Attempting XTTS voice clone');
        // Dynamic import to avoid issues on systems without @gradio/client
        const { Client } = await import('@gradio/client');
        const app = await Client.connect(xttsSpace);
        
        const result = await app.predict('/predict', [
          cleanEnglish, // text
          "en",         // language
          fs.readFileSync(referenceAudio), // reference audio file
          null,         // microphone (not used)
          false,        // use mic (false)
          true,         // cleanup (true)
          0,            // no-cloning (0)
        ]);
        
        if (result?.data?.[0]?.url) {
          const response = await fetch(result.data[0].url);
          const buffer = await response.arrayBuffer();
          fs.writeFileSync(outputPath, Buffer.from(buffer));
          logger.info({ twin }, 'XTTS clone voice generated successfully from ' + referenceAudio);
          return outputPath;
        }
      } else {
        logger.warn({ referenceAudio }, 'Voice reference file missing, skipping XTTS clone');
      }
    } catch (err) {
      logger.warn({ twin, err }, 'XTTS clone failed, falling back to Edge-TTS');
    }
  }

  // ── STRATEGY 2: Edge-TTS (reliable fallback) ──
  // Guy = warm male conversational; Jenny = warm female conversational
  const voiceId = twin === 'max' 
    ? 'en-US-GuyNeural'      
    : 'en-US-JennyNeural';   
  
  const ssmlRate = '-2%'; // Slightly faster than before for better energy
  const ssmlPitch = twin === 'max' ? '-1Hz' : '+0Hz';

  const pythonBins = process.platform === 'win32' 
    ? ['python', 'python3', 'py'] 
    : ['python3', 'python'];

  let lastErr: unknown;
  for (const pythonBin of pythonBins) {
    try {
      logger.info({ pythonBin, twin }, 'Trying Edge-TTS with python binary');
      await execFileAsync(pythonBin, [
        '-m', 'edge_tts',
        '--voice', voiceId,
        '--rate', ssmlRate,
        '--pitch', ssmlPitch,
        '--text', cleanEnglish,
        '--write-media', outputPath,
      ], { timeout: 30000 });

      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        logger.info({ twin, voice: voiceId }, 'Edge-TTS voice generated');
        return outputPath;
      }
    } catch (err) {
      logger.warn({ pythonBin, err }, 'Edge-TTS failed with this Python binary');
      lastErr = err;
    }
  }

  // ── STRATEGY 3: Google Translate TTS (pure HTTP, no Python, always works) ──
  logger.warn({ twin }, 'Edge-TTS failed completely, trying Google Translate TTS fallback');
  try {
    // Split text into chunks of ~180 chars to stay within Google TTS limit
    const chunks = [];
    const words = cleanEnglish.split(' ');
    let current = '';
    for (const word of words) {
      if ((current + ' ' + word).length > 180) {
        if (current) chunks.push(current.trim());
        current = word;
      } else {
        current += ' ' + word;
      }
    }
    if (current.trim()) chunks.push(current.trim());

    // Download each chunk and concatenate
    const audioChunks: Buffer[] = [];
    for (const chunk of chunks) {
      const encodedText = encodeURIComponent(chunk);
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodedText}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        audioChunks.push(buf);
      }
    }

    if (audioChunks.length > 0) {
      fs.writeFileSync(outputPath, Buffer.concat(audioChunks));
      if (fs.statSync(outputPath).size > 0) {
        logger.info({ twin, chunks: chunks.length }, 'Google TTS fallback generated successfully');
        return outputPath;
      }
    }
  } catch (gttsErr) {
    logger.error({ gttsErr }, 'Google TTS fallback also failed');
  }

  logger.error({ lastErr }, 'All voice generation methods failed');
  throw lastErr;
}
