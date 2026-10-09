// Vercel Serverless Function — turns text into a real AI voice (male).
// Picks the first provider that has a key set in Vercel:
//   1) OPENAI_API_KEY      -> OpenAI gpt-4o-mini-tts (fast, Egyptian dialect via instructions)
//   2) ELEVENLABS_API_KEY  -> ElevenLabs Flash v2.5   (fast)
//   3) GEMINI_API_KEY      -> Gemini TTS              (slow, fallback only)
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

// Gemini sometimes leaves a burst of noise at the very end. Cut it off:
//  1) drop trailing silence/hiss after the last real speech,
//  2) drop a short isolated "island" of sound that comes after a long pause,
//  3) fade out the last 40ms so there is no click.
function trimTail(pcm, rate = 24000) {
  const total = Math.floor(pcm.length / 2);
  const win = Math.floor(rate * 0.02); // 20ms windows
  const n = Math.floor(total / win);
  if (n < 12) return pcm;
  const rms = new Array(n);
  for (let w = 0; w < n; w++) {
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const v = pcm.readInt16LE((w * win + i) * 2);
      sum += v * v;
    }
    rms[w] = Math.sqrt(sum / win);
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const p90 = sorted[Math.floor(n * 0.9)];
  const thr = Math.max(p90 * 0.12, 150);
  let last = -1;
  for (let w = n - 1; w >= 0; w--) { if (rms[w] >= thr) { last = w; break; } }
  if (last < 0) return pcm;

  // Look for a short island of sound at the end, separated by a long quiet gap.
  let islandStart = last;
  while (islandStart > 0 && rms[islandStart - 1] >= thr) islandStart--;
  const islandLen = last - islandStart + 1;
  let gap = 0;
  for (let w = islandStart - 1; w >= 0 && rms[w] < thr; w--) gap++;
  let lastKeep = last;
  if (islandLen <= 10 && gap >= 8 && islandStart - gap > 0) lastKeep = islandStart - gap - 1;

  let end = Math.min(total, (lastKeep + 1) * win + Math.floor(rate * 0.06));
  const out = Buffer.from(pcm.subarray(0, end * 2));
  const fade = Math.min(Math.floor(rate * 0.04), end);
  for (let i = 0; i < fade; i++) {
    const idx = (end - fade + i) * 2;
    out.writeInt16LE(Math.round(out.readInt16LE(idx) * (1 - i / fade)), idx);
  }
  return out;
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
  const rate = rateMatch ? Number(rateMatch[1]) : 24000;
  return pcmToWav(trimTail(Buffer.from(part.inlineData.data, "base64"), rate), rate);
}

const OPENAI_VOICE = "ash"; // male. Others: "onyx", "echo", "ballad"
const ELEVEN_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB").trim(); // Adam (male)

async function synthesizeOpenAI(apiKey, text, isEnglish) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: OPENAI_VOICE,
      input: text,
      response_format: "mp3",
      instructions: isEnglish
        ? "Speak like a warm, friendly man chatting casually with a friend. Natural pace, no robotic tone."
        : "Speak in a natural Egyptian Arabic dialect (Cairo), like a warm, friendly man chatting casually with a friend. Natural pace, no formal tone.",
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`openai: ${err?.error?.message || r.status}`);
  }
  return { buf: Buffer.from(await r.arrayBuffer()), type: "audio/mpeg" };
}

async function synthesizeEleven(apiKey, text) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
    body: JSON.stringify({
      text,
      model_id: "eleven_flash_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`elevenlabs: ${err?.detail?.message || err?.detail || r.status}`);
  }
  return { buf: Buffer.from(await r.arrayBuffer()), type: "audio/mpeg" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = await verifyUser(token);
    if (!user) return res.status(401).json({ error: "لازم تسجّلي دخول." });

    const raw = String((req.body || {}).text || "").trim().slice(0, 700);
    if (!raw) return res.status(400).json({ error: "No text" });
    const isEnglish = ((req.body || {}).lang || "") === "en";
    const openaiKey = (process.env.OPENAI_API_KEY || "").trim();
    const elevenKey = (process.env.ELEVENLABS_API_KEY || "").trim();
    const geminiKey = (process.env.GEMINI_API_KEY || "").trim();
    const errors = [];

    const send = (audio) => {
      res.setHeader("Content-Type", audio.type);
      if (audio.model) res.setHeader("X-TTS-Model", audio.model);
      if (audio.ms) res.setHeader("X-TTS-Ms", String(audio.ms));
      res.setHeader("Access-Control-Expose-Headers", "X-TTS-Model, X-TTS-Ms");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(audio.buf);
    };

    if (openaiKey) {
      try { return send(await synthesizeOpenAI(openaiKey, raw, isEnglish)); } catch (e) { errors.push(e.message); }
    }
    if (elevenKey) {
      try { return send(await synthesizeEleven(elevenKey, raw)); } catch (e) { errors.push(e.message); }
    }
    if (geminiKey) {
      for (const model of TTS_MODELS) {
        try { const t0 = Date.now(); const buf = await synthesize(model, geminiKey, raw); return send({ buf, type: "audio/wav", model, ms: Date.now() - t0 }); } catch (e) { errors.push(e.message); }
      }
    }
    if (!openaiKey && !elevenKey && !geminiKey) errors.push("No TTS API key is set");
    console.error("SPEAK_FAILED", errors.join(" | "));
    return res.status(500).json({ error: errors.join(" | ") });
  } catch (err) {
    console.error("SPEAK_CATCH", err.message);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
