// Vercel Serverless Function — Groq (أساسي) + Gemini (احتياطي)
// الرسايل النصية بتتبعت لـ Groq الأول لأنه مجاني تمامًا.
// لو في صورة مرفقة، أو Groq فشل لأي سبب، بيرجع تلقائيًا لـ Gemini.
// الفرونت إند (index.html) مش محتاج أي تعديل — نفس الشكل بالظبط.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages, system } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }

    const hasImage = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image")
    );

    // لو في صورة، Groq (على الفري تير) مش بيدعمها بشكل موثوق، فنروح على طول لـ Gemini
    if (hasImage) {
      return await callGemini(req, res, messages, system);
    }

    // حاولي Groq الأول
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      try {
        const text = await callGroqRaw(messages, system, groqKey);
        return res.status(200).json({ content: [{ type: "text", text }] });
      } catch (groqErr) {
        console.error("Groq failed, falling back to Gemini:", groqErr.message);
        // نكمل تحت على Gemini بدل ما نرجع خطأ للمستخدم
      }
    }

    // لو مفيش مفتاح Groq أو فشلت المحاولة، استخدمي Gemini
    return await callGemini(req, res, messages, system);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Unknown server error" });
  }
}

// ---------- Groq ----------
async function callGroqRaw(messages, system, apiKey) {
  // تحويل الرسايل لشكل OpenAI-compatible اللي Groq بتفهمه
  const openaiMessages = [];
  if (system) openaiMessages.push({ role: "system", content: system });

  for (const m of messages) {
    if (Array.isArray(m.content)) {
      const textPart = m.content.find((b) => b.type === "text");
      openaiMessages.push({ role: m.role, content: textPart?.text || "" });
    } else {
      openaiMessages.push({ role: m.role, content: m.content || "" });
    }
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: openaiMessages,
      max_tokens: 8192,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Groq API error");
  }
  return data.choices?.[0]?.message?.content || "";
}

// ---------- Gemini (احتياطي) ----------
async function callGemini(req, res, messages, system) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "GEMINI_API_KEY is not set. Add it in your Vercel project's Environment Variables.",
    });
  }

  const contents = messages.map((m) => {
    const role = m.role === "assistant" ? "model" : "user";
    if (Array.isArray(m.content)) {
      const parts = m.content.map((block) => {
        if (block.type === "image") {
          return {
            inline_data: {
              mime_type: block.source.media_type,
              data: block.source.data,
            },
          };
        }
        return { text: block.text || "" };
      });
      return { role, parts };
    }
    return { role, parts: [{ text: m.content || "" }] };
  });

  const model = "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      system_instruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: { maxOutputTokens: 8192 },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    return res.status(response.status).json({ error: data.error?.message || "Gemini API error" });
  }

  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("");
  return res.status(200).json({ content: [{ type: "text", text }] });
  }
