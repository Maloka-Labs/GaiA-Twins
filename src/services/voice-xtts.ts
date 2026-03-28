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

  // ── STRATEGY 1: Try Gradio XTTS voice cloning ──
  const xttsSpace = process.env.XTTS_GRADIO_SPACE;
  if (xttsSpace) {
    try {
      const referenceAudio = path.join(
        process.cwd(), 
        twin === 'max' ? 'max_voice.aac' : 'melini_voice.aac'
      );
      
      if (fs.existsSync(referenceAudio)) {
        logger.info({ twin, space: xttsSpace }, 'Attempting XTTS voice clone');
        const { Client } = await import('@gradio/client');
        const app = await Client.connect(xttsSpace);
        
        const result = await app.predict('/predict', [
          cleanEnglish,
          "en",
          fs.readFileSync(referenceAudio)
        ]);
        
        if (result?.data?.[0]?.url) {
          const response = await fetch(result.data[0].url);
          const buffer = await response.arrayBuffer();
          fs.writeFileSync(outputPath, Buffer.from(buffer));
          logger.info({ twin }, 'XTTS clone voice generated successfully');
          return outputPath;
        }
      }
    } catch (err) {
      logger.warn({ twin, err }, 'XTTS clone failed, falling back to Edge-TTS');
    }
  }

  // ── STRATEGY 2: Edge-TTS (reliable fallback) ──
  // These are Microsoft's best natural-sounding neural voices:
  // Guy = warm male conversational; Jenny = warm female conversational
  const voiceId = twin === 'max' 
    ? 'en-US-GuyNeural'      // More natural than Christopher
    : 'en-US-JennyNeural';   // More natural than Aria
  
  // SSML prosody to sound more human: slightly slower, natural pitch
  const ssmlRate = '-5%';
  const ssmlPitch = twin === 'max' ? '-2Hz' : '+0Hz';

  const pythonBins = process.platform === 'win32' 
    ? ['python', 'python3', 'py'] 
    : ['python3', 'python'];

  let lastErr: unknown;
  for (const pythonBin of pythonBins) {
    try {
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
      lastErr = err;
    }
  }

  logger.error({ lastErr }, 'All voice generation methods failed');
  throw lastErr;
}
