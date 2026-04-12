const express = require("express");
const cors = require("cors");
const axios = require("axios");
const multer = require("multer");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const app = express();

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// ===== HEALTH CHECK (IMPORTANT FOR DEPLOYMENT) =====
app.get("/", (req, res) => {
  res.send("XZILY AI Backend is Running 🚀");
});

// ===== DATABASE CONNECTION =====
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log("MongoDB Error:", err));

// ===== USER MODEL =====
const User = mongoose.model("User", {
  email: String,
  password: String,
});

// ===== REGISTER ROUTE =====
app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const exists = await User.findOne({ email });
    if (exists) {
      return res.status(400).json({ error: "User already exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    const user = new User({ email, password: hash });
    await user.save();

    return res.json({ message: "User registered successfully" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ===== LOGIN ROUTE =====
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: "User not found" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid password" });
    }

    const token = jwt.sign({ id: user._id }, "secretkey", {
      expiresIn: "1d",
    });

    return res.json({ message: "Login successful", token });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ===== AI CHAT ROUTE =====
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: message }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    return res.json({
      reply: response.data.choices[0].message.content,
    });
  } catch (err) {
    return res.status(500).json({
      error: "AI request failed",
      details: err.message,
    });
  }
});

// ===== START SERVER (THIS WAS MISSING BEFORE ❌) =====
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`XZILY AI running on port ${PORT}`);
});
