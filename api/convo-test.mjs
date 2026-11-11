// MARKO conversation A/B test: OLD prompt (your original index.html) vs NEW prompt.
// Usage:  GROQ_API_KEY=xxx node tools/convo-test.mjs old-index.html new-index.html > report.md
//         node tools/convo-test.mjs old-index.html new-index.html --dry   (no API, checks extraction + heuristics)
import fs from "fs";
import vm from "vm";

const [oldPath, newPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const DRY = process.argv.includes("--dry");
if (!oldPath || !newPath) { console.error("need: old-index.html new-index.html"); process.exit(1); }

function extract(path) {
  const src = fs.readFileSync(path, "utf8");
  const grab = (name) => {
    const i = src.indexOf(`const ${name} = \``);
    if (i < 0) return "";
    const j = src.indexOf("`;", i);
    return vm.runInNewContext(src.slice(i, j + 2) + `;${name}`);
  };
  return { base: grab("BASE_SYSTEM_PROMPT"), layer: grab("ADVISOR_LAYER") };
}
const OLD = extract(oldPath), NEW = extract(newPath);
const variants = { OLD: OLD.base + OLD.layer, NEW: NEW.base + NEW.layer };

const SCENARIOS = [
  ["1 vague problem", ["عملائي بيسألوا وقليل بيشتري."]],
  ["2 one short sentence", ["مبيعاتي قليلة"]],
  ["3 gradual info", ["عملائي بيسألوا وقليل بيشتري.", "أغلبهم بيسألوا عن السعر وبعدها بيختفوا.", "بقولهم السعر بس."]],
  ["4 contradiction", ["بشتغل في القهوة المحمصة", "كل عملائي شركات كبيرة", "أغلب عملائي أفراد بيشتروا من إنستجرام"]],
  ["5 solution before diagnosis", ["مبيعاتي واقفة، قولي أعمل إيه دلوقتي من غير أسئلة"]],
  ["6 detailed strategy", ["اعمل لي استراتيجية تسويق مفصلة لمحل قهوة مختصة في القاهرة"]],
  ["7 user corrects assumption", ["عملائي بيسألوا وقليل بيشتري", "أكيد المشكلة في السعر", "لا السعر مش المشكلة، أسعاري أقل من المنافسين"]],
  ["8 return to earlier topic", ["بيع قهوة مختصة لطلبة جامعة", "عملائي بيسألوا وقليل بيشتري", "نرجع لموضوع الطلبة اللي قلتلك عليه، قلت إيه عنهم؟"]],
  ["9 frustrated", ["تعبت جدًا، بقالي شهور بصرف على إعلانات ومفيش مبيعات"]],
  ["10 asks to execute", ["احفظ لي في التقويم بوست عن القهوة بكرة الساعة 9"]],
];

// Heuristic flags only — they catch obvious failures, they do NOT replace reading the replies.
export function flags(reply, userText, isFirstOfProblem, wantsReport) {
  const f = [];
  const q = (reply.match(/[?؟]/g) || []).length;
  if (q > 1) f.push(`asks ${q} questions`);
  if (!wantsReport && reply.length > 900) f.push("long for a conversational turn");
  if (!wantsReport && (/^#{1,3}\s/m.test(reply) || (reply.match(/^\s*[-•*]\s/gm) || []).length > 4)) f.push("report-style formatting");
  if (/اتحفظ|اتضاف|اتنفذ|اتبعت|تم (الحفظ|التنفيذ|الإرسال)|\b(saved|scheduled|published)\b/i.test(reply)) f.push("claims an action was done");
  const nums = reply.match(/\d+\s?%/g) || [];
  if (nums.some((n) => !userText.includes(n))) f.push("number not given by the user");
  if (isFirstOfProblem && /خصم|عرض ترويجي|discount|توصية|أنصحك/.test(reply)) f.push("recommends/discounts before understanding");
  return f.length ? f.join("; ") : "no obvious issues";
}

async function ask(system, messages) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set");
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "openai/gpt-oss-120b", max_completion_tokens: 1500, messages: [{ role: "system", content: system }, ...messages] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || r.status);
  return d.choices?.[0]?.message?.content || "";
}

if (DRY) {
  console.log("OLD prompt chars:", variants.OLD.length, "| NEW prompt chars:", variants.NEW.length);
  console.log("NEW has staged layer:", /الحوار الاستشاري/.test(variants.NEW), "| OLD has it:", /الحوار الاستشاري/.test(variants.OLD));
  const bad = "ملخص:\n# عنوان\n- a\n- b\n- c\n- d\n- e\nجرب خصم 30% وتمت الحفظ. اتحفظت؟ ليه؟";
  console.log("heuristic self-test (should flag many):", flags(bad, "", true, false));
  console.log("heuristic self-test (clean):", flags("فاهمك. إيه اللي بيحصل لما بيسألوا؟", "", true, false));
  process.exit(0);
}

console.log("# MARKO conversation A/B report\n");
for (const [name, turns] of SCENARIOS) {
  console.log(`## ${name}\n`);
  for (const [label, system] of Object.entries(variants)) {
    const msgs = []; console.log(`### ${label}\n`);
    for (let i = 0; i < turns.length; i++) {
      msgs.push({ role: "user", content: turns[i] });
      let reply; try { reply = await ask(system, msgs); } catch (e) { reply = `[ERROR: ${e.message}]`; }
      msgs.push({ role: "assistant", content: reply });
      const allUser = msgs.filter((m) => m.role === "user").map((m) => m.content).join(" ");
      const wantsReport = name.startsWith("6");
      console.log(`**User:** ${turns[i]}\n\n**MARKO:** ${reply}\n\n_Flags:_ ${flags(reply, allUser, i === 0 && !wantsReport, wantsReport)}\n`);
    }
  }
}
