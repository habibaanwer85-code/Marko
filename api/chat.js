// Vercel Serverless Function — Groq primary, Gemini fallback, real Tavily
// web search as a tool MARKO can call when it decides it needs current
// external information (not simulated — a real HTTP call to Tavily).
//
// Flow:
// - Messages WITH an image go straight to Gemini (Groq's current stable
//   production models are text-only).
// - Text-only messages try Groq first, with a real web_search tool
//   available. If the model asks to search, we call Tavily for real,
//   feed the actual results back, and ask the model for a final answer
//   grounded in what was actually found.
// - Any failure (Groq, Tavily) falls back gracefully — Gemini as the
//   text fallback, and "I couldn't verify this via live search" instead
//   of ever inventing search results.

async function fetchT(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    console.log(`[timing] ${new URL(url).host} ${Date.now() - t0}ms status=${res.status}`);
    return res;
  } catch (e) {
    console.log(`[timing] ${new URL(url).host} FAILED after ${Date.now() - t0}ms: ${e.message}`);
    if (e.name === "AbortError") throw new Error(`timeout after ${ms / 1000}s (${new URL(url).host})`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function hasImage(messages) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image"));
}

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

const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live web for current, external, or verifiable information (prices, competitors, market trends, news, statistics, current products). Only call this when the answer requires up-to-date or external facts that are not already in the conversation or business profile.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "A focused search query in the same language as the user's business context." },
      },
      required: ["query"],
    },
  },
};

async function tavilySearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set.");

  const response = await fetchT("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: 3,
      include_answer: false,
    }),
  }, 8000);

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Tavily search failed");

  const results = (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    content: (r.content || "").slice(0, 600),
  }));
  return results;
}

async function callGroqWithSearch(messages, system) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set.");

  const model = "openai/gpt-oss-120b";
  const hasTavily = !!process.env.TAVILY_API_KEY;
  const openaiMessages = toOpenAIMessages(messages, system);

  const baseBody = {
    model,
    messages: openaiMessages,
    max_completion_tokens: 4096,
    reasoning_effort: "low",
  };
  if (hasTavily) {
    baseBody.tools = [WEB_SEARCH_TOOL];
    baseBody.tool_choice = "auto";
  }

  const firstRes = await fetchT("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(baseBody),
  }, 12000);
  const firstData = await firstRes.json();
  if (!firstRes.ok) throw new Error(firstData.error?.message || "Groq API error");

  const choice = firstData.choices?.[0];
  const toolCalls = choice?.message?.tool_calls;

  if (!toolCalls || toolCalls.length === 0) {
    const text = choice?.message?.content || "";
    return { text, sources: [] };
  }

  // The model asked to search — actually search, for real.
  const allSources = [];
  const toolResultMessages = [];
  for (const call of toolCalls) {
    let query = "";
    try { query = JSON.parse(call.function.arguments || "{}").query || ""; } catch (e) {}
    let resultText;
    try {
      const results = await tavilySearch(query || "");
      allSources.push(...results);
      resultText = JSON.stringify(results.map((r) => ({ title: r.title, url: r.url, snippet: r.content })));
    } catch (e) {
      resultText = JSON.stringify({ error: "Live web research is temporarily unavailable." });
    }
    toolResultMessages.push({
      role: "tool",
      tool_call_id: call.id,
      content: resultText,
    });
  }

  const secondBody = {
    model,
    messages: [
      ...openaiMessages,
      choice.message,
      ...toolResultMessages,
    ],
    max_completion_tokens: 4096,
    reasoning_effort: "low",
  };

  const secondRes = await fetchT("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(secondBody),
  }, 12000);
  const secondData = await secondRes.json();
  if (!secondRes.ok) throw new Error(secondData.error?.message || "Groq API error (after search)");

  const text = secondData.choices?.[0]?.message?.content || "";
  return { text, sources: allSources };
}

async function callGemini(messages, system) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");

  const contents = messages.map((m) => {
    const role = m.role === "assistant" ? "model" : "user";
    if (Array.isArray(m.content)) {
      const parts = m.content.map((block) => {
        if (block.type === "image") {
          return { inline_data: { mime_type: block.source.media_type, data: block.source.data } };
        }
        return { text: block.text || "" };
      });
      return { role, parts };
    }
    return { role, parts: [{ text: m.content || "" }] };
  });

  const model = "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetchT(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      system_instruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: { maxOutputTokens: 8192 },
    }),
  }, 20000);

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Gemini API error");

  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("");
  return { text, sources: [] };
}

function formatWithSources(text, sources) {
  if (!sources || sources.length === 0) return text;
  const list = sources
    .filter((s, i, arr) => arr.findIndex((x) => x.url === s.url) === i) // dedupe
    .slice(0, 5)
    .map((s) => `- [${s.title || s.url}](${s.url})`)
    .join("\n");
  return `${text}\n\n**المصادر / Sources**\n${list}`;
}

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages, system } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }

    if (hasImage(messages)) {
      try {
        const { text } = await callGemini(messages, system);
        return res.status(200).json({ content: [{ type: "text", text }] });
      } catch (geminiErr) {
        return res.status(500).json({ error: `Gemini فشل: ${geminiErr.message}` });
      }
    }

    try {
      const { text, sources } = await callGroqWithSearch(messages, system);
      return res.status(200).json({ content: [{ type: "text", text: formatWithSources(text, sources) }] });
    } catch (groqErr) {
      try {
        const { text } = await callGemini(messages, system);
        return res.status(200).json({ content: [{ type: "text", text }] });
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

module.exports = handler;
