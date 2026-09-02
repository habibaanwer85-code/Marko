// Vercel Serverless Function — Groq primary, Gemini fallback
// Both API keys stay secret on the server. The frontend (index.html)
// doesn't need any changes — this function converts the request/response
// shape so it matches what index.html expects (Anthropic-style).
//
// Flow: try Groq first. If Groq fails (missing key, network error, or a
// non-OK response), fall back to Gemini automatically.

function toOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      const parts = m.content.map((block) => {
        if (block.type === "image") {
          return {
            type: "image_url",
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          };
        }
        return { type: "text", text: block.text || "" };
      });
      out.push({ role: m.role, content: parts });
    } else {
      out.push({ role: m.role, content: m.content || "" });
    }
  }
  return out;
}

async function callGroq(messages, system) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set.");

  const model = "meta-llama/llama-4-maverick-17b-128e-instruct";
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: toOpenAIMessages(messages, system),
      max_completion_tokens: 4096,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Groq API error");
  }

  const text = data.choices?.[0]?.message?.content || "";
  return { content: [{ type: "text", text }] };
}

async function callGemini(messages, system) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");

  const contents = messages.map((m) => {
    const role = m.role === "assistant" ? "model" : "user";
    if (Array.isArray(m.content)) {
      const parts = m.content.map((block) => {
        if (block.type === "image") {
          return {
            inline_data: { mime_type: block.source.media_type, data: block.source.data },
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
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      system_instruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: { maxOutputTokens: 8192 },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Gemini API error");
  }

  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("");
  return { content: [{ type: "text", text }] };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages, system } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }

    // Try Groq first.
    try {
      const result = await callGroq(messages, system);
      return res.status(200).json(result);
    } catch (groqErr) {
      // Fall back to Gemini if Groq fails for any reason.
      try {
        const result = await callGemini(messages, system);
        return res.status(200).json(result);
      } catch (geminiErr) {
        return res.status(500).json({
          error: `Groq فشل (${groqErr.message}) وGemini فشل كمان (${geminiErr.message}).`,
        });
      }
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || "Unknown server error" });
  }
}
