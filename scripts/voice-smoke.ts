import { startVoiceOnboarding, voiceOnboardingTurn } from "../src/sarvam.js";
import { config } from "../src/config.js";

const start = await startVoiceOnboarding("hi-IN");
const answerResponse = await fetch("https://api.sarvam.ai/text-to-speech", {
  method: "POST",
  headers: {
    "api-subscription-key": config.SARVAM_API_KEY,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    text: "मेरा नाम अमन है। मेरा लक्ष्य इकतीस दिसंबर दो हज़ार छब्बीस तक पाँच किलोमीटर दौड़ना है। मैं सोमवार, बुधवार और शुक्रवार सुबह अभ्यास कर सकता हूँ, हफ्ते में तीन बार। मुझे जेंटल प्रोग्रेस पसंद है और कोई विशेष बाधा नहीं है।",
    target_language_code: "hi-IN",
    speaker: "ritu",
    model: "bulbul:v3",
    output_audio_codec: "wav",
  }),
});
if (!answerResponse.ok) throw new Error(`Test speech generation failed: ${answerResponse.status}`);
const answerPayload = await answerResponse.json() as { audios: string[] };
const turn = await voiceOnboardingTurn({
  audioBase64: answerPayload.audios[0]!,
  mimeType: "audio/wav",
  answers: {},
});

console.log(JSON.stringify({
  startLanguage: start.languageCode,
  startAudioBytes: Buffer.from(start.audioBase64, "base64").length,
  detectedLanguage: turn.languageCode,
  transcriptPresent: turn.transcript.length > 0,
  replyPresent: turn.reply.length > 0,
  replyAudioBytes: Buffer.from(turn.audioBase64, "base64").length,
  complete: turn.complete,
  goalPresent: Boolean(turn.answers.objective),
  schedulePresent: Boolean(turn.answers.preferredDays?.length && turn.answers.preferredTime && turn.answers.workingFrequency),
}));
