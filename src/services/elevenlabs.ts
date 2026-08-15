import type { TTSResult, WordTimestamp } from '../types';

export async function generateSpeech(text: string, voiceId: string, apiKey: string): Promise<TTSResult> {
  if (!apiKey) {
    throw new Error("ElevenLabs API key is required");
  }

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        output_format: 'mp3_44100_128'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `ElevenLabs API Error: ${response.status} ${response.statusText}`;
      try {
        const errJson = JSON.parse(errorText);
        if (errJson.detail && errJson.detail.message) {
            errorMessage += ` - ${errJson.detail.message}`;
        }
      } catch (e) {
          errorMessage += ` - ${errorText}`;
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    
    if (!data.audio_base64 || !data.alignment) {
      throw new Error("Invalid response format from ElevenLabs API");
    }

    const characters = data.alignment.characters as string[];
    const startTimes = data.alignment.character_start_times_seconds as number[];
    const endTimes = data.alignment.character_end_times_seconds as number[];

    const wordTimestamps: WordTimestamp[] = [];
    let currentWord = "";
    let wordStart = -1;
    let wordEnd = -1;

    for (let i = 0; i < characters.length; i++) {
      const char = characters[i];
      const start = startTimes[i];
      const end = endTimes[i];

      if (char === ' ' || char === '\n') {
        if (currentWord.trim().length > 0) {
          wordTimestamps.push({
            word: currentWord.trim(),
            start: wordStart,
            end: wordEnd
          });
          currentWord = "";
          wordStart = -1;
        }
      } else {
        if (wordStart === -1) {
          wordStart = start;
        }
        currentWord += char;
        wordEnd = end;
      }
    }

    if (currentWord.trim().length > 0) {
      wordTimestamps.push({
        word: currentWord.trim(),
        start: wordStart,
        end: wordEnd
      });
    }

    const binaryString = atob(data.audio_base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const audioBlob = new Blob([bytes.buffer], { type: 'audio/mp3' });
    const audioUrl = URL.createObjectURL(audioBlob);

    const durationMs = wordTimestamps.length > 0 
        ? wordTimestamps[wordTimestamps.length - 1].end * 1000 
        : 0;

    return {
      audioBlob,
      audioUrl,
      wordTimestamps,
      durationMs
    };
  } catch (error) {
    console.error("Error in generateSpeech:", error);
    throw error instanceof Error ? error : new Error("Failed to generate speech");
  }
}
