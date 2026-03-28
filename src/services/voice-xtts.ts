import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import util from 'util';

const execFileAsync = util.promisify(execFile);

export async function generateEnglishVoice(twin: 'max' | 'melini', text: string): Promise<string> {
  const outputPath = path.join(process.cwd(), `tmp_${twin}_${Date.now()}.mp3`);
  
  // Clean text: strip markdown artifacts and dangerous shell chars
  const cleanEnglish = text
    .replace(/[*_~\[\]`#>]/g, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 500) || "What did you say?";

  if (cleanEnglish.length === 0) return "";

  // Christopher = warm male wellness voice; Aria = soothing female voice
  const voiceId = twin === 'max' ? 'en-US-ChristopherNeural' : 'en-US-AriaNeural';

  // Try python3 first (Linux/Railway), fall back to python (Windows)
  const pythonBins = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];

  let lastErr: unknown;
  for (const pythonBin of pythonBins) {
    try {
      await execFileAsync(pythonBin, [
        '-m', 'edge_tts',
        '--voice', voiceId,
        '--text', cleanEnglish,
        '--write-media', outputPath,
      ], { timeout: 30000 });

      // Verify the file was actually created
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        return outputPath;
      }
    } catch (err) {
      lastErr = err;
      // Try the next python binary
    }
  }

  console.error('Failed to generate Neural voice with any Python binary:', lastErr);
  throw lastErr;
}
