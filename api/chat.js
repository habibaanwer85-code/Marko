export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "GEMINI_API_KEY is not set. Add it in your Vercel project's Environment Variables.",
    });
  }

  try {
    const { messages, system } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
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
        generationConfig: { maxOutputTokens: 4096 },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || "Gemini API error" });
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || "").join("");

    return res.status(200).json({ content: [{ type: "text", text }] });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Unknown server error" });
  }
}
