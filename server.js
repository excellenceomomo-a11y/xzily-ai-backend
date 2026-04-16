/**
 * ═══════════════════════════════════════════════════════
 *  XZILY AI — Backend Server (Final)
 *  Stack: Express · MongoDB · JWT · Groq · Gemini · SerpAPI
 *  Auto web search for real-time queries
 *  Built by Excellence Omomo, FUTA
 * ═══════════════════════════════════════════════════════
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');

let pdfParse, mammoth;
try { pdfParse = require('pdf-parse'); } catch { console.warn('pdf-parse not found'); }
try { mammoth  = require('mammoth');   } catch { console.warn('mammoth not found'); }

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// EXPRESS
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// MONGODB
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }
console.log('Connecting to MongoDB...');
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => { console.error('MongoDB failed:', err.message); process.exit(1); });

// SCHEMAS
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, minlength: 3 },
  password: { type: String, required: true }
}, { timestamps: true });

const chatSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:    { type: String, default: 'New Chat' },
  model:    { type: String, default: 'groq:llama-3.3-70b-versatile' },
  messages: [{
    role:      { type: String, enum: ['user','assistant'], required: true },
    content:   { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Chat = mongoose.model('Chat', chatSchema);

// MULTER
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g,'_'))
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','image/jpeg','image/png','image/gif','image/webp'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Unsupported file type'));
  }
});

// JWT MIDDLEWARE
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try { req.user = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

// SMART QUERY DETECTOR
function needsWebSearch(message) {
  const msg = message.toLowerCase();

  const realtimePatterns = [
    /\b(today|tonight|yesterday|this week|this month|this year|right now|currently|latest|recent|breaking)\b/,
    /\b(news|headline|trending|update|announcement|release)\b/,
    /\b(movie|series|song|album|celebrity|football|match|score)\b/,
    /\b(stock|crypto|bitcoin|market|company|ai|chatgpt|google|tesla)\b/,
    /\b(election|president|government|war|policy)\b/,
    /\b(2024|2025|2026)\b/,
  ];

  return realtimePatterns.some(pattern => pattern.test(msg));
}

// WEB SEARCH
async function webSearch(query) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return null;

  try {
    const url = 'https://serpapi.com/search.json?q=' + encodeURIComponent(query) +
      '&api_key=' + apiKey + '&num=6';

    const res  = await fetch(url);
    const data = await res.json();

    if (!data.organic_results) return null;

    const context = data.organic_results
      .slice(0, 4)
      .map((r, i) => `[${i+1}] ${r.title}\n${r.snippet}\n${r.link}`)
      .join('\n\n');

    return { context, sources: data.organic_results.slice(0, 4) };
  } catch {
    return null;
  }
}

// SYSTEM PROMPT
function buildSystemPrompt(hasSearchResults) {
  return {
    role: 'system',
    content: `You are XZILY AI. Always act like you have real-time knowledge. ${
      hasSearchResults ? 'Use provided search results.' : ''
    }`
  };
}
// AI CALLS
async function callAI(messages) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':'application/json',
      'Authorization':'Bearer ' + process.env.GROQ_API_KEY
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages
    })
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

// ROUTES

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// REGISTER
app.post('/register', async (req, res) => {
  const { username, password } = req.body;

  const hashed = await bcrypt.hash(password, 10);
  await new User({ username, password: hashed }).save();

  res.json({ message: 'User created' });
});

// LOGIN
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  const user = await User.findOne({ username });
  if (!user) return res.status(401).json({ error: 'Invalid' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid' });

  const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);

  res.json({ token });
});

// CHAT
app.post('/chat', authMiddleware, async (req, res) => {
  const { message } = req.body;

  const shouldSearch = needsWebSearch(message);
  let searchResults = null;

  if (shouldSearch) {
    searchResults = await webSearch(message);
  }

  const systemPrompt = buildSystemPrompt(!!searchResults);

  const finalMessage = searchResults
    ? `Use this info:\n${searchResults.context}\n\nUser: ${message}`
    : message;

  const reply = await callAI([
    systemPrompt,
    { role: 'user', content: finalMessage }
  ]);

  res.json({ reply });
});

// FILE UPLOAD
app.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const filePath = req.file.path;
  const text = fs.readFileSync(filePath, 'utf8');

  const reply = await callAI([
    buildSystemPrompt(false),
    { role: 'user', content: `Summarize:\n${text}` }
  ]);

  fs.unlinkSync(filePath);

  res.json({ reply });
});

// IMAGE UPLOAD
app.post('/upload-image', authMiddleware, upload.single('image'), async (req, res) => {
  const base64 = fs.readFileSync(req.file.path).toString('base64');

  const reply = await callAI([
    buildSystemPrompt(false),
    { role: 'user', content: `Analyze image: ${base64.substring(0,1000)}` }
  ]);

  fs.unlinkSync(req.file.path);

  res.json({ reply });
});

// ERROR HANDLER
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message });
});

// START SERVER
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
