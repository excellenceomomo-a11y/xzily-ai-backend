require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const fs = require("fs");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());

// ───────── ENV ─────────
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SERP_API_KEY = process.env.SERP_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

// ───────── DB ─────────
mongoose.connect(process.env.MONGO_URI);

const User = mongoose.model("User", {
  username: String,
  password: String
});

const Chat = mongoose.model("Chat", {
  userId: String,
  title: String,
  messages: Array
});

// ───────── AUTH ─────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ───────── AI SETUP ─────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

async function callGroq(messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages
    })
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "Error";
}

async function callGemini(messages) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const prompt = messages.map(m => m.content).join("\n");
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function searchWeb(q) {
  const res = await fetch(`https://serpapi.com/search.json?q=${q}&api_key=${SERP_API_KEY}`);
  const data = await res.json();
  return (data.organic_results || []).slice(0, 3).map(r => r.snippet).join("\n");
}

async function AI(messages) {
  try {
    return await callGroq(messages);
  } catch {
    return await callGemini(messages);
  }
}

// ───────── AUTH ROUTES ─────────
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  await User.create({ username, password: hash });
  res.json({ success: true });
});

app.post("/login", async (req, res) => {
  const user = await User.findOne({ username: req.body.username });
  if (!user) return res.status(400).json({ error: "User not found" });

  const ok = await bcrypt.compare(req.body.password, user.password);
  if (!ok) return res.status(400).json({ error: "Wrong password" });

  const token = jwt.sign({ userId: user._id }, JWT_SECRET);
  res.json({ token });
});

// ───────── CHAT ─────────
app.post("/chat", auth, async (req, res) => {
  const { message, chatId } = req.body;

  let chat = chatId
    ? await Chat.findOne({ _id: chatId, userId: req.user.userId })
    : null;

  if (!chat) {
    chat = await Chat.create({
      userId: req.user.userId,
      title: message.slice(0, 30),
      messages: []
    });
  }

  let context = "";
  if (/latest|news|today/i.test(message)) {
    context = await searchWeb(message);
  }

  const reply = await AI([
    { role: "system", content: "You are XZILY AI" },
    { role: "user", content: message + "\n" + context }
  ]);

  chat.messages.push({ role: "user", content: message });
  chat.messages.push({ role: "assistant", content: reply });
  await chat.save();

  res.json({ reply, chatId: chat._id });
});

// ───────── GET CHATS ─────────
app.get("/chats", auth, async (req, res) => {
  const chats = await Chat.find({ userId: req.user.userId });
  res.json({ chats });
});

// ───────── IMAGE ─────────
app.post("/upload-image", auth, upload.single("image"), async (req, res) => {
  const file = req.file;
  const base64 = fs.readFileSync(file.path).toString("base64");

  const reply = await callGemini([
    { role: "user", content: "Analyze this image" }
  ]);

  fs.unlinkSync(file.path);

  res.json({ reply });
});

app.listen(PORT, () => console.log("Server running"));
