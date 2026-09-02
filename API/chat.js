// Vercel Serverless Function — Claude (Anthropic) version
// This runs on the server, so the Anthropic API key stays secret.
// index.html already sends messages in Anthropic's native shape
// ({ role, content }) and expects a response shaped like
// { content: [{ type: "text", text }] } — so this function is a
// thin, direct passthrough to the Anthropic Messages API.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY is not set. Add it in your Vercel project's Environment Variables.",
    });
  }

  try {
    const { messages, system } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: system || undefined,
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || "Anthropic API error",
      });
    }

    // Already in the shape index.html expects: { content: [{ type: "text", text }] }
    return res.status(200).json({ content: data.content || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Unknown server error" });
  }
}
