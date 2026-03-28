import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export async function generateEnglishVoice(twin: 'max' | 'melini', text: string): Promise<string> {
  const outputPath = path.join(process.cwd(), `tmp_${twin}_${Date.now()}.mp3`);
  
  // Clean text to avoid breaking the TTS command line
  const cleanEnglish = text.replace(/["\\]/g, '').replace(/[*_~\[\]]/g, '').trim() || "What did you say?";
  if (cleanEnglish.length === 0) return "";

  // Assign incredibly realistic Neural USA voices
  // Christopher is a warm, deep wellness male speaker
  // Aria is a soothing, clear female speaker
  const voiceId = twin === 'max' ? 'en-US-ChristopherNeural' : 'en-US-AriaNeural';

  try {
    // Generate the audio securely 100% free using Edge's WebSocket Neural Engine
    // Requires python edge-tts pip package installed globally
    const command = `python -m edge_tts --voice ${voiceId} --text "${cleanEnglish}" --write-media "${outputPath}"`;
    await execAsync(command);
    
    return outputPath;
  } catch (err) {
    console.error(`Failed to generate Neural voice (make sure 'pip install edge-tts' is run):`, err);
    throw err;
  }
}
