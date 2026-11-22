// Vercel Serverless Function — DU Admission Assistant (Gemini proxy)
//
// কেন এই ফাইলটি লাগে:
//   - Gemini API Key ব্রাউজারে (ক্লায়েন্টে) কখনো যায় না। Key থাকে শুধু
//     Vercel-এর Environment Variable-এ: GEMINI_API_KEY
//   - index.html চ্যাট মেসেজ POST করে /api/chat-এ; এই function সার্ভার-সাইডে
//     Key পড়ে Gemini-কে কল করে শুধু উত্তরটি ফেরত দেয়।
//   - Key না থাকলে বা Gemini ব্যর্থ হলে 503/500 আসে, আর ব্রাউজার তখন
//     বিল্ট-ইন অফলাইন নলেজ বেস থেকে উত্তর দেয় — চ্যাট কখনো থামে না।
//
// Vercel সেটআপ:
//   1. Vercel Dashboard → আপনার প্রজেক্ট → Settings → Environment Variables
//   2. Name: GEMINI_API_KEY | Value: Google AI Studio-র ফ্রি Key (aistudio.google.com)
//   3. Environment: Production (এবং Preview, যদি চান) → Save
//   4. Deployments → ⋯ → Redeploy (env var বদলালে redeploy লাগে)
//
// চুক্তি (index.html-এর callGemini-এর সাথে মিলিয়ে):
//   Request:  POST /api/chat  { "message": "...", "history": [{role, text}, ...], "lang": "bn" | "en" }
//   Response: 200 { "text": "..." }  — ব্যর্থ হলে 4xx/5xx JSON { "error": "..." }

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// ফ্রন্টএন্ড (index.html) অনুরোধের সাথে lang পাঠায়: 'bn' বা 'en'।
// উত্তর সেই ভাষাতেই দিতে হবে; ফলব্যাক বার্তায় কোনো "[ ]" ব্র্যাকেট নেই।
function systemPrompt(lang) {
  if (lang === "en") {
    return [
      "You are the admission assistant of the University of Dhaka.",
      "Answer politely, briefly and helpfully in English.",
      "Help only with admission-related topics: eligibility, units, deadlines, application fees,",
      "required documents, application steps, departments and career guidance.",
      "If you do not know the answer, or the question is not admission-related, reply with exactly this message:",
      "Sorry, I don't have specific information on this. Please contact the Admission Office: Phone: +88 01903-446970 | Email: registrar@du.ac.bd",
      "Official admission portal: admission.eis.du.ac.bd. Dates and fees may change, so ask the user to verify the official circular.",
    ].join(" ");
  }
  return [
    "তুমি ঢাকা বিশ্ববিদ্যালয়ের (University of Dhaka) অ্যাডমিশন অ্যাসিস্ট্যান্ট।",
    "ভদ্র, সংক্ষিপ্ত ও সহায়ক বাংলায় উত্তর দাও।",
    "শুধু ভর্তি-সংক্রান্ত বিষয়ে সাহায্য করো: যোগ্যতা, ইউনিট, ডেডলাইন, আবেদন ফি,",
    "প্রয়োজনীয় ডকুমেন্টস, আবেদনের ধাপ, ডিপার্টমেন্ট ও ক্যারিয়ার গাইড।",
    "তথ্য না জানলে বা প্রশ্ন ভর্তি-সংক্রান্ত না হলে হুবহু এই বার্তাটি দাও:",
    "দুঃখিত, এই বিষয়ে আমার কাছে নির্দিষ্ট তথ্য নেই। অনুগ্রহ করে অ্যাডমিশন অফিসে যোগাযোগ করুন: ফোন নম্বর: +88 01903-446970 | ইমেইল: registrar@du.ac.bd",
    "অফিসিয়াল ভর্তি পোর্টাল: admission.eis.du.ac.bd। তারিখ ও ফি বদলাতে পারে, তাই সার্কুলার যাচাই করতে বলো।",
  ].join(" ");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res
      .status(503)
      .json({ error: "GEMINI_API_KEY is not set in Vercel environment variables" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const message = body && typeof body.message === "string" ? body.message.trim() : "";
  const history = Array.isArray(body && body.history) ? body.history : [];
  const lang = body && body.lang === "en" ? "en" : "bn";

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  const contents = history
    .filter((h) => h && typeof h.text === "string")
    .slice(-6)
    .map((h) => ({
      role: h.role === "user" ? "user" : "model",
      parts: [{ text: h.text }],
    }));
  contents.push({ role: "user", parts: [{ text: message }] });

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt(lang) }] },
          contents,
          generationConfig: { temperature: 0.4, maxOutputTokens: 800 },
        }),
      }
    );

    if (!geminiRes.ok) {
      const detail = await geminiRes.text().catch(() => "");
      return res.status(502).json({ error: "Gemini request failed", detail: detail.slice(0, 300) });
    }

    const data = await geminiRes.json();
    const text =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts
        ? data.candidates[0].content.parts.map((p) => p.text || "").join("").trim()
        : "";

    if (!text) {
      return res.status(502).json({ error: "Empty response from Gemini" });
    }
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(502).json({ error: "Gemini request failed", detail: String(err).slice(0, 300) });
  }
};
