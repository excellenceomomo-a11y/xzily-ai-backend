/**
 * ═══════════════════════════════════════════════════════
 *  XZILY AI — Backend Server
 *  Stack: Express · MongoDB/Mongoose · JWT · Groq (Free)
 *  Unlimited usage — no daily restrictions
 * ═══════════════════════════════════════════════════════
 */

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const mongoose  = require('mongoose');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const multer    = require('multer');
const fs        = require('fs');
const path      = require('path');

// Optional parsers
let pdfParse, mammoth;
try { pdfParse = require('pdf-parse'); } catch { console.warn('pdf-parse not found'); }
try { mammoth  = require('mammoth');   } catch { console.warn('mammoth not found'); }

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ──────────────────────────────────────────────────────────
// EXPRESS SETUP
// ──────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: 'https://xzily-ai-frontend.vercel.app', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ──────────────────────────────────────────────────────────
// MONGODB CONNECTION
// ──────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI environment variable is not set!');
  process.exit(1);
}
console.log('🔗 Connecting to MongoDB...');
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected successfully'))
  .catch(err => { console.error('❌ MongoDB connection failed:', err.message); process.exit(1); });

// ──────────────────────────────────────────────────────────
// MONGOOSE SCHEMAS
// ──────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, minlength: 3 },
  password: { type: String, required: true }
}, { timestamps: true });

const chatSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:    { type: String, default: 'New Chat' },
  messages: [{
    role:      { type: String, enum: ['user', 'assistant'], required: true },
    content:   { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Chat = mongoose.model('Chat', chatSchema);

// ──────────────────────────────────────────────────────────
// MULTER
// ──────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp'
    ];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Unsupported file type'));
  }
});

// ──────────────────────────────────────────────────────────
// JWT MIDDLEWARE
// ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ──────────────────────────────────────────────────────────
// GROQ API HELPERS
// Free API — Get your key at: https://console.groq.com
// ──────────────────────────────────────────────────────────
const GROQ_API_URL      = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL        = 'llama-3.3-70b-versatile';
const GROQ_VISION_MODEL = 'llama-3.2-11b-vision-preview';

async function callGroq(messages, maxTokens = 1024) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      messages,
      max_tokens:  maxTokens,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'Groq API error');
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

async function callGroqVision(base64Image, mimeType, prompt) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text',      text: prompt || 'Describe and analyze this image in detail.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
        ]
      }],
      max_tokens: 1024
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'Groq Vision error');
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

function cleanupFile(fp) {
  if (fp && fs.existsSync(fp)) fs.unlink(fp, () => {});
}

const SYSTEM_PROMPT = {
  role: 'system',
  content: `You are XZILY AI, a highly capable and friendly AI assistant. You are knowledgeable, concise, and helpful. Format code with proper markdown code blocks.`
};

// ──────────────────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────────────────

// HEALTH CHECK
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'XZILY AI' }));

// REGISTER
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)  return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 3)     return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 6)     return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (await User.findOne({ username: username.trim() })) return res.status(409).json({ error: 'Username already taken' });

    const user = new User({ username: username.trim(), password: await bcrypt.hash(password, 12) });
    await user.save();
    res.status(201).json({ message: 'Account created successfully' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// LOGIN
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = await User.findOne({ username: username.trim() });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { userId: user._id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, username: user.username });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET USER INFO
app.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ username: user.username });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// CHAT
app.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { message, chatId } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

    let chat = chatId ? await Chat.findOne({ _id: chatId, userId: req.user.userId }) : null;
    if (!chat) {
      chat = new Chat({
        userId:   req.user.userId,
        title:    message.substring(0, 40) + (message.length > 40 ? '…' : ''),
        messages: []
      });
    }

    chat.messages.push({ role: 'user', content: message });

    const reply = await callGroq([
      SYSTEM_PROMPT,
      ...chat.messages.slice(-20).map(m => ({ role: m.role, content: m.content }))
    ]);

    chat.messages.push({ role: 'assistant', content: reply });
    await chat.save();

    res.json({ reply, chatId: chat._id });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message || 'Chat failed' });
  }
});

// GET CHATS
app.get('/chats', authMiddleware, async (req, res) => {
  try {
    const chats = await Chat
      .find({ userId: req.user.userId })
      .sort({ updatedAt: -1 })
      .limit(50)
      .select('_id title messages updatedAt')
      .lean();
    res.json({ chats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch chats' });
  }
});

// FILE UPLOAD (PDF / DOCX / TXT)
app.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const { message, chatId }                     = req.body;
    const { mimetype, originalname, path: fPath } = req.file;
    let extractedText = '';

    if (mimetype === 'application/pdf') {
      if (!pdfParse) throw new Error('PDF parsing not available. Run: npm install pdf-parse');
      extractedText = (await pdfParse(fs.readFileSync(fPath))).text;
    } else if (mimetype.includes('wordprocessingml') || originalname.endsWith('.docx')) {
      if (!mammoth) throw new Error('DOCX parsing not available. Run: npm install mammoth');
      extractedText = (await mammoth.extractRawText({ path: fPath })).value;
    } else if (mimetype === 'text/plain') {
      extractedText = fs.readFileSync(fPath, 'utf8');
    } else {
      throw new Error('Unsupported file type');
    }

    if (!extractedText.trim()) throw new Error('Could not extract text from the file');

    const userMessage = message
      ? `${message}\n\nFile content (${originalname}):\n${extractedText.substring(0, 8000)}`
      : `Please summarize and explain this document (${originalname}):\n\n${extractedText.substring(0, 8000)}`;

    let chat = chatId ? await Chat.findOne({ _id: chatId, userId: req.user.userId }) : null;
    if (!chat) {
      chat = new Chat({ userId: req.user.userId, title: `📄 ${originalname}`, messages: [] });
    }

    chat.messages.push({ role: 'user', content: userMessage });

    const reply = await callGroq([
      SYSTEM_PROMPT,
      ...chat.messages.slice(-20).map(m => ({ role: m.role, content: m.content }))
    ], 1500);

    chat.messages.push({ role: 'assistant', content: reply });
    await chat.save();

    cleanupFile(filePath);
    res.json({ reply, chatId: chat._id });
  } catch (err) {
    cleanupFile(filePath);
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'File upload failed' });
  }
});

// IMAGE UPLOAD
app.post('/upload-image', authMiddleware, upload.single('image'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const { message, chatId }                     = req.body;
    const { mimetype, originalname, path: fPath } = req.file;
    const base64Image = fs.readFileSync(fPath).toString('base64');
    const prompt      = message || 'Please describe and analyze this image in detail.';
    const reply       = await callGroqVision(base64Image, mimetype, prompt);

    let chat = chatId ? await Chat.findOne({ _id: chatId, userId: req.user.userId }) : null;
    if (!chat) {
      chat = new Chat({ userId: req.user.userId, title: `🖼️ ${originalname}`, messages: [] });
    }

    chat.messages.push({ role: 'user',      content: `[Image: ${originalname}] ${prompt}` });
    chat.messages.push({ role: 'assistant', content: reply });
    await chat.save();

    cleanupFile(filePath);
    res.json({ reply, chatId: chat._id });
  } catch (err) {
    cleanupFile(filePath);
    console.error('Image upload error:', err);
    res.status(500).json({ error: err.message || 'Image analysis failed' });
  }
});

// ──────────────────────────────────────────────────────────
// ERROR HANDLERS
// ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large. Maximum 10 MB.' });
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// ──────────────────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────────────────
setInterval(() => {
  fetch(`https://your-backend.onrender.com/health`)
    .then(() => console.log('Keep-alive ping sent'))
    .catch(() => {});
}, 14 * 60 * 1000);
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║        XZILY AI — Server         ║
  ║  Powered by Groq (Free API)      ║
  ║  Unlimited usage — no limits     ║
  ║  http://localhost:${PORT}           ║
  ╚══════════════════════════════════╝
  `);
});

module.exports = app;
  
