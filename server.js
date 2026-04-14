require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const fetch = require("node-fetch");
const multer = require("multer");
const FormData = require("form-data");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const upload = multer();

app.use(cors({ origin: "*" }));
app.use(express.json());

// ================== ENV ==================
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SERP_API_KEY = process.env.SERP_API_KEY;

// ================== DB ==================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error(err));

// ================== MEMORY ==================
const Memory = mongoose.model("Memory", {
  userId: String,
  memory: String
});

async function getMemory(userId) {
  let user = await Memory.findOne({ userId });
  if (!user) user = await Memory.create({ userId, memory: "" });
  return user.memory;
}

async function saveMemory(userId, text) {
  await Memory.updateOne(
    { userId },
    { $set: { memory: text } },
    { upsert: true }
  );
}

// ================== SYSTEM PROMPT ==================
const SYSTEM_PROMPT = {
  role: "system",
  content: `
You are XZILY AI, built by Excellence Omomo.

Do NOT introduce yourself unless asked.
Do NOT mention Groq, Gemini, Meta, or any external provider.

If real-time data is provided, use it to answer accurately.

Be intelligent, helpful, and natural.
`
};

// ================== AI SETUP ==================
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ================== RATE LIMIT ==================
let rateLimitResetTime = null;

function getWaitTime() {
  if (!rateLimitResetTime) return null;

  const diff = rateLimitResetTime - Date.now();
  if (diff <= 0) return null;

  const m = Math.floor(diff / 60000);
  const s = Math.floor((diff % 60000) / 1000);

  return `${m}m ${s}s`;
}

// ================== GROQ ==================
const KEEP_ALIVE_URL =
  process.env.KEEP_ALIVE_URL ||
  'https://xzily-ai-backend-8.onrender.com/health';

async function pingServer() {
  try {
    const res = await fetch(KEEP_ALIVE_URL);
    console.log(res.ok ? '🔄 Keep-alive success' : '⚠️ Keep-alive issue');
  } catch (err) {
    console.log('❌ Keep-alive failed:', err.message);
  }
}

// run once on startup
pingServer();

// repeat every 12 minutes (BEST PRACTICE)
setInterval(pingServer, 12 * 60 * 1000);
async function callGroq(messages) {
  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      max_tokens: 1024
    })
  });

  if (!res.ok) {
    const txt = await res.text();

    if (txt.includes("rate_limit")) {
      rateLimitResetTime = Date.now() + 3 * 60 * 1000;
      throw new Error("RATE_LIMIT");
    }

    throw new Error("Groq failed");
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// ================== GEMINI ==================
async function callGemini(messages) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = messages.map(m => m.content).join("\n");

  const result = await model.generateContent(prompt);
  return result.response.text();
}

// ================== SERPAPI ==================
async function searchWeb(query) {
  try {
    const res = await fetch(
      `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERP_API_KEY}`
    );

    const data = await res.json();

    if (!data.organic_results) return "";

    return data.organic_results.slice(0, 3).map(r =>
      `${r.title}: ${r.snippet}`
    ).join("\n");

  } catch (err) {
    console.error("Search error:", err);
    return "";
  }
}

// ================== MASTER AI ==================
async function callAI(messages) {

  const wait = getWaitTime();
  if (wait) {
    return `You have reached the limit for chats, wait until ${wait}`;
  }

  try {
    return await callGroq(messages);

  } catch (err) {

    if (err.message === "RATE_LIMIT") {
      return `You have reached the limit for chats, wait until ${getWaitTime()}`;
    }

    try {
      return await callGemini(messages);
    } catch {
      return "AI services are unavailable. Try again later.";
    }
  }
}

// ================== CHAT ==================
app.post("/chat", async (req, res) => {
  try {
    const { userId, messages } = req.body;

    const userMessage = messages[messages.length - 1].content;

    const memory = await getMemory(userId);

    // 🔍 Detect real-time queries
    const needsSearch = /news|latest|today|current|trend|happening|update/i.test(userMessage);

    let searchContext = "";

    if (needsSearch) {
      const results = await searchWeb(userMessage);
      searchContext = `Live web results:\n${results}`;
    }

    const finalMessages = [
      SYSTEM_PROMPT,
      { role: "system", content: `Memory: ${memory}` },
      { role: "system", content: searchContext },
      ...messages.slice(-6)
    ];

    const reply = await callAI(finalMessages);

    await saveMemory(userId, reply.slice(-1000));

    res.json({ reply });

  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Server error" });
  }
});

// ================== VOICE ==================
app.post('/upload-image', authMiddleware, upload.single('image'), async (req, res) => {
  try {

    // CHECK IF FILE EXISTS
    if (!req.file) {
      return res.status(400).json({
        error: 'No image provided (field name must be "image")'
      });
    }

    // DEBUG LOG
    console.log("UPLOAD DEBUG:", {
      file: req.file.originalname,
      type: req.file.mimetype,
      size: req.file.size
    });

    const { message, chatId } = req.body;
    const { mimetype, originalname, path: fPath } = req.file;

    // CONVERT IMAGE TO BASE64
    const base64Image = fs.readFileSync(fPath).toString('base64');

    const prompt = message || 'Please describe and analyze this image in detail.';

    // CALL AI VISION MODEL
    const reply = await callGroqVision(base64Image, mimetype, prompt);

    // CHAT HANDLING
    let chat = chatId
      ? await Chat.findOne({ _id: chatId, userId: req.user.userId })
      : null;

    if (!chat) {
      chat = new Chat({
        userId: req.user.userId,
        title: `🖼️ ${originalname}`,
        messages: []
      });
    }

    chat.messages.push({
      role: 'user',
      content: `[Image: ${originalname}] ${prompt}`
    });

    chat.messages.push({
      role: 'assistant',
      content: reply
    });

    await chat.save();

    cleanupFile(fPath);

    res.json({
      reply,
      chatId: chat._id
    });

  } catch (err) {
    console.error('Image upload error:', err);
    res.status(500).json({
      error: err.message || 'Image analysis failed'
    });
  }
});

// ================== HEALTH ==================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ================== START ==================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
