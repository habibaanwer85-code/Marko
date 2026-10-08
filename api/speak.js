// Vercel Serverless Function — turns text into a real AI voice (male) using
// Gemini text-to-speech. Uses the same GEMINI_API_KEY already set in Vercel.
// Only logged-in users can call it (same check as api/chat.js).

const SUPABASE_URL = "https://kyicwitbcerzdgirnmlz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt5aWN3aXRiY2VyemRnaXJubWx6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3Njg3MTMsImV4cCI6MjEwNTM0NDcxM30.c46rNEQBVQorhmoitfUg_3jM158tiSfwJks8TdvXl00";

// Male voice. Other male options to try: "Orus", "Puck", "Fenrir", "Algenib".
const VOICE_NAME = "Charon";

// Tried in order — the first one that works is used.
const TTS_MODELS = [
  "gemini-3.8-flash-tts",
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
];

async function verifyUser(token) {
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id ? user : null;
}

// Gemini returns raw 16-bit PCM @ 24kHz mono. Browsers need a WAV header.
function pcmToWav(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function synthesize(model, apiKey, text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
      },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${model}: ${data?.error?.message || r.status}`);
  const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new Error(`${model}: no audio returned`);
  const rateMatch = /rate=(\d+)/.exec(part.inlineData.mimeType || "");
  return pcmToWav(Buffer.from(part.inlineData.data, "base64"), rateMatch ? Number(rateMatch[1]) : 24000);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = await verifyUser(token);
    if (!user) return res.status(401).json({ error: "لازم تسجّلي دخول." });

    const apiKey = (process.env.GEMINI_API_KEY || "").trim();
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY is not set" });

    const raw = String((req.body || {}).text || "").trim().slice(0, 700);
    if (!raw) return res.status(400).json({ error: "No text" });
    const isEnglish = ((req.body || {}).lang || "") === "en";

    const style = isEnglish
      ? "Say in a warm, natural, friendly conversational tone, like a real person talking: "
      : "قل بلهجة مصرية طبيعية ودافئة ومحادثة حقيقية، زي شخص بيتكلم مع صاحبه: ";

    const errors = [];
    for (const model of TTS_MODELS) {
      try {
        const wav = await synthesize(model, apiKey, style + raw);
        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).send(wav);
      } catch (e) {
        errors.push(e.message);
      }
    }
    console.error("SPEAK_FAILED", errors.join(" | "));
    return res.status(500).json({ error: errors.join(" | ") });
  } catch (err) {
    console.error("SPEAK_CATCH", err.message);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
