// Vercel Serverless Function — "Designer agent": creates marketing images with
// Gemini image generation, using the same GEMINI_API_KEY already set in Vercel.
// Only logged-in users can call it (same check as api/chat.js).

const SUPABASE_URL = "https://kyicwitbcerzdgirnmlz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt5aWN3aXRiY2VyemRnaXJubWx6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3Njg3MTMsImV4cCI6MjEwNTM0NDcxM30.c46rNEQBVQorhmoitfUg_3jM158tiSfwJks8TdvXl00";

// Tried in order. Set IMAGE_MODEL in Vercel to force a specific one.
const IMAGE_MODELS = ["gemini-3.1-flash-image", "gemini-2.5-flash-image"];

const ASPECTS = ["1:1", "4:5", "9:16", "16:9"];
const STYLES = {
  photo: "high-end commercial photography, natural realistic lighting, shallow depth of field",
  minimal: "clean minimal composition, lots of negative space, soft neutral colors",
  bold: "bold vibrant colors, high contrast, eye-catching social-media look",
  luxury: "premium luxury look, elegant, dark moody tones with gold or soft highlights",
  playful: "fun, warm and friendly, colorful, lively illustration-meets-photo feel",
};

async function verifyUser(token) {
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id ? user : null;
}

async function generate(model, apiKey, parts, aspect) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: aspect },
      },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${model}: ${data?.error?.message || r.status}`);
  if (data?.promptFeedback?.blockReason) throw new Error(`blocked: ${data.promptFeedback.blockReason}`);
  const imgPart = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!imgPart) {
    const why = data?.candidates?.[0]?.finishReason || "no image returned";
    throw new Error(`${model}: ${why}`);
  }
  return { image: imgPart.inlineData.data, mime: imgPart.inlineData.mimeType || "image/png", model };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = await verifyUser(token);
    if (!user) return res.status(401).json({ error: "لازم تسجّلي دخول." });

    const apiKey = (process.env.GEMINI_API_KEY || "").trim();
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY is not set" });

    const body = req.body || {};
    const idea = String(body.prompt || "").trim().slice(0, 1500);
    if (!idea) return res.status(400).json({ error: "اكتبي فكرة الصورة الأول." });
    const aspect = ASPECTS.includes(body.aspect) ? body.aspect : "1:1";
    const style = STYLES[body.style] || STYLES.photo;
    const brand = String(body.brand || "").trim().slice(0, 1500);
    const refImage = typeof body.refImage === "string" ? body.refImage : "";
    const refMime = /^image\/(png|jpeg|webp)$/.test(body.refMime || "") ? body.refMime : "image/jpeg";

    const text = [
      "You are a senior marketing art director. Create ONE ready-to-post marketing image.",
      brand ? `Brand profile (use it to keep the image on-brand):${brand}` : "",
      `Request: ${idea}`,
      `Visual style: ${style}.`,
      refImage ? "A reference photo is attached. Use it as the real product/subject: keep the product accurate and recognizable, and place it in the scene described." : "",
      "Rules: professional composition, no watermarks, no real brand logos. Do not put any text, letters or numbers inside the image unless the request explicitly asks for specific text; if text is requested, write it exactly as given.",
    ].filter(Boolean).join("\n");

    const parts = [{ text }];
    if (refImage) parts.push({ inlineData: { mimeType: refMime, data: refImage } });

    const preferred = (process.env.IMAGE_MODEL || "").trim();
    const models = preferred ? [preferred, ...IMAGE_MODELS.filter((m) => m !== preferred)] : IMAGE_MODELS;
    const errors = [];
    for (const model of models) {
      try {
        const out = await generate(model, apiKey, parts, aspect);
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json(out);
      } catch (e) {
        errors.push(e.message);
      }
    }
    console.error("IMAGE_FAILED", errors.join(" | "));
    return res.status(500).json({ error: errors.join(" | ") });
  } catch (err) {
    console.error("IMAGE_CATCH", err.message);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
