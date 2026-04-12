const express = require("express");
const cors = require("cors");
const axios = require("axios");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// ===== DATABASE =====
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("MongoDB Connected"))
.catch(err => console.log(err));

const User = mongoose.model("User", {
  email: String,
  password: String,
});

// ===== AUTH =====
app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  const exists = await User.findOne({ email });
  if (exists) return res.json({ error: "User exists" });

  const hash = await bcrypt.hash(password, 10);
  const user = new User({ email, password: hash });
  await user.save();

  res.json({ message: "Registered" });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) return res.json({ error: "Invalid" });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.json({ error: "Invalid" });

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

  res.json({ token });
});

// ===== CHAT =====
app.post("/chat", async (req, res) => {
  const { messages } = req.body;

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    }
  );

  res.json(response.data);
});

// ===== IMAGE =====
app.post("/image", async (req, res) => {
  const { prompt } = req.body;

  const response = await axios.post(
    "https://api.openai.com/v1/images/generations",
    {
      model: "gpt-image-1",
      prompt,
      size: "1024x1024",
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    }
  );

  res.json(response.data);
});

// ===== PDF =====
app.post("/pdf", upload.single("file"), async (req, res) => {
  const data = await pdfParse(req.file.buffer);

  const text = data.text.substring(0, 6000);

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Summarize with bullet points" },
        { role: "user", content: text },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    }
  );

  res.json(response.data);
});

// ===== QUIZ =====
app.post("/quiz", upload.single("file"), async (req, res) => {
  const data = await pdfParse(req.file.buffer);

  const text = data.text.substring(0, 6000);

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Generate MCQs" },
        { role: "user", content: text },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    }
  );

  res.json(response.data);
});

app.get("/", (req, res) => {
  res.send("XZILY AI Backend Running 🚀");
});

app.listen(3000);
