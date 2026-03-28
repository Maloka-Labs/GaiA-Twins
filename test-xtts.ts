import { generateEnglishVoice } from './src/services/voice-xtts.js';
async function test() {
  console.log('Testing XTTS Generation...');
  try {
    const res = await generateEnglishVoice('max', 'Hello world, this is an architect test');
    console.log('Success:', res);
  } catch (err) {
    console.error('Error:', err);
  }
}
test();
