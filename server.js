/**
 * ═══════════════════════════════════════════════════════
 *  XZILY AI — Backend Server (Part 1 of 2)
 *  Stack: Express · MongoDB · JWT · Groq · Gemini · SerpAPI
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

// ──────────────────────────────────────────────────────────
// EXPRESS SETUP
// ──────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ──────────────────────────────────────────────────────────
// MONGODB
// ──────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }
console.log('Connecting to MongoDB...');
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => { console.error('MongoDB failed:', err.message); process.exit(1); });

// ──────────────────────────────────────────────────────────
// SCHEMAS
// ──────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────
// MULTER
// ──────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────
// JWT MIDDLEWARE
// ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try { req.user = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ──────────────────────────────────────────────────────────
// SYSTEM PROMPT — Identity rules baked in
// ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = {
  role: 'system',
  content: `You are XZILY AI, an intelligent and helpful AI assistant.

IDENTITY RULES (follow strictly):
- Do NOT introduce yourself unless asked.
- Do NOT mention Groq, Gemini, or any external AI provider under any circumstances.
- If asked who created/built/developed you, reply EXACTLY: "I'm XZILY AI, built and developed by Excellence Omomo, a student of the Federal University of Technology Akure."
- If asked when you were launched, reply EXACTLY: "I was launched on Monday, 13th April, 2026."
- If asked why you were built, reply EXACTLY: "I was created with a vision to explore artificial intelligence and develop solutions that address real human challenges."
- For all other questions, respond naturally, intelligently, and helpfully.

RESPONSE RULES:
- Be concise, accurate, and helpful.
- Format code with proper markdown code blocks.
- When given web search results, use them to provide accurate up-to-date answers.`
};

// ──────────────────────────────────────────────────────────
// MULTI-AI ENGINE — Groq + Gemini
// ──────────────────────────────────────────────────────────

/**
 * Parse model string → { provider, model }
 * Format: "groq:llama-3.3-70b-versatile" or "gemini:gemini-2.0-flash"
 */
function parseModel(modelStr = '') {
  const [provider, ...rest] = modelStr.split(':');
  const model = rest.join(':') || 'llama-3.3-70b-versatile';
  return { provider: provider || 'groq', model };
}

/**
 * Call Groq API (OpenAI-compatible format)
 */
async function callGroq(messages, model = 'llama-3.3-70b-versatile', maxTokens = 1024) {
  if (!process.env.GROQ_API_KEY) throw new Error('Groq API key not configured.');
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.7 })
  });
  if (!response.ok) { const err = await response.json(); throw new Error(err.error?.message || 'Groq API error'); }
  const data = await response.json();
  return data.choices[0].message.content.trim();
}

/**
 * Call Gemini API
 */
async function callGemini(messages, model = 'gemini-2.0-flash', maxTokens = 1024) {
  if (!process.env.GEMINI_API_KEY) throw new Error('Gemini API key not configured.');

  // Convert messages to Gemini format
  // System prompt gets prepended to first user message
  const systemText = messages.find(m => m.role === 'system')?.content || '';
  const chatMessages = messages.filter(m => m.role !== 'system');

  const contents = chatMessages.map((m, idx) => {
    let text = m.content;
    // Prepend system prompt to first user message
    if (idx === 0 && m.role === 'user' && systemText) {
      text = systemText + '\n\nUser: ' + text;
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text }]
    };
  });

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + process.env.GEMINI_API_KEY;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
    })
  });

  if (!response.ok) { const err = await response.json(); throw new Error(err.error?.message || 'Gemini API error'); }
  const data = await response.json();
  return data.candidates[0].content.parts[0].text.trim();
}

/**
 * Call Gemini Vision API with image
 */
async function callGeminiVision(base64Image, mimeType, prompt, model = 'gemini-2.0-flash') {
  if (!process.env.GEMINI_API_KEY) throw new Error('Gemini API key not configured.');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + process.env.GEMINI_API_KEY;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt || 'Describe and analyze this image in detail.' },
          { inline_data: { mime_type: mimeType, data: base64Image } }
        ]
      }],
      generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
    })
  });
  if (!response.ok) { const err = await response.json(); throw new Error(err.error?.message || 'Gemini Vision error'); }
  const data = await response.json();
  return data.candidates[0].content.parts[0].text.trim();
}

/**
 * Groq Vision API
 */
async function callGroqVision(base64Image, mimeType, prompt) {
  if (!process.env.GROQ_API_KEY) throw new Error('Groq API key not configured.');
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({
      model: 'llama-3.2-11b-vision-preview',
      messages: [{ role:'user', content:[
        { type:'text', text: prompt || 'Describe and analyze this image in detail.' },
        { type:'image_url', image_url:{ url:'data:' + mimeType + ';base64,' + base64Image } }
      ]}],
      max_tokens: 1024
    })
  });
  if (!response.ok) { const err = await response.json(); throw new Error(err.error?.message || 'Groq Vision error'); }
  const data = await response.json();
  return data.choices[0].message.content.trim();
}

/**
 * Master AI dispatcher — routes to correct provider
 */
async function callAI(messages, modelStr = 'groq:llama-3.3-70b-versatile', maxTokens = 1024) {
  const { provider, model } = parseModel(modelStr);
  if (provider === 'gemini') return callGemini(messages, model, maxTokens);
  return callGroq(messages, model, maxTokens);
}

/**
 * Master Vision dispatcher
 */
async function callAIVision(base64Image, mimeType, prompt, modelStr = 'groq:llama-3.2-11b-vision-preview') {
  const { provider, model } = parseModel(modelStr);
  if (provider === 'gemini') return callGeminiVision(base64Image, mimeType, prompt, model);
  return callGroqVision(base64Image, mimeType, prompt);
}

// ──────────────────────────────────────────────────────────
// WEB SEARCH — SerpAPI
// Get free key at serpapi.com (100 searches/month free)
// ──────────────────────────────────────────────────────────
async function webSearch(query) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) { console.warn('SERPAPI_KEY not set — web search disabled'); return null; }
  try {
    const url = 'https://serpapi.com/search.json?q=' + encodeURIComponent(query) + '&api_key=' + apiKey + '&num=5&hl=en';
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data    = await res.json();
    const results = (data.organic_results || []).slice(0, 4).map(r => ({
      title: r.title, snippet: r.snippet, url: r.link
    }));
    if (!results.length) return null;
    const context = results.map((r,i) => '[' + (i+1) + '] ' + r.title + '\n' + r.snippet + '\nURL: ' + r.url).join('\n\n');
    return { context, sources: results };
  } catch (err) { console.error('Web search error:', err.message); return null; }
}

function cleanupFile(fp) { if (fp && fs.existsSync(fp)) fs.unlink(fp, () => {}); }

module.exports = { app, User, Chat, upload, authMiddleware, callAI, callAIVision, webSearch, SYSTEM_PROMPT, cleanupFile, pdfParse, mammoth, PORT };
/**
 * ═══════════════════════════════════════════════════════
 *  XZILY AI — Backend Server (Part 2 of 2)
 *  PASTE THIS BELOW Part 1 — replace the module.exports
 *  line at the bottom of Part 1 with this entire file
 * ═══════════════════════════════════════════════════════
 */

// ──────────────────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────────────────

// Health check — frontend pings this every 12 mins
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'XZILY AI', timestamp: new Date().toISOString() }));

// ── REGISTER ──
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 3)    return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 6)    return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (await User.findOne({ username: username.trim() })) return res.status(409).json({ error: 'Username already taken' });
    await new User({ username: username.trim(), password: await bcrypt.hash(password, 12) }).save();
    res.status(201).json({ message: 'Account created successfully' });
  } catch (err) { console.error('Register error:', err); res.status(500).json({ error: 'Registration failed' }); }
});

// ── LOGIN ──
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const user = await User.findOne({ username: username.trim() });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user._id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username });
  } catch (err) { console.error('Login error:', err); res.status(500).json({ error: 'Login failed' }); }
});

// ── GET ME ──
app.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ username: user.username });
  } catch (err) { res.status(500).json({ error: 'Failed to get user info' }); }
});

// ── CHAT — Multi-AI + optional web search ──
app.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { message, chatId, model = 'groq:llama-3.3-70b-versatile', webSearch: useSearch = false } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

    let chat = chatId ? await Chat.findOne({ _id: chatId, userId: req.user.userId }) : null;
    if (!chat) {
      chat = new Chat({
        userId:   req.user.userId,
        title:    message.substring(0, 40) + (message.length > 40 ? '...' : ''),
        model,
        messages: []
      });
    }

    // Web search if enabled
    let searchResults = null;
    let sources       = [];
    if (useSearch) {
      searchResults = await webSearch(message);
      if (searchResults) sources = searchResults.sources;
    }

    chat.messages.push({ role: 'user', content: message });
    const history = chat.messages.slice(-20).map(m => ({ role: m.role, content: m.content }));

    // Inject search results into context if available
    let aiMessages = [SYSTEM_PROMPT, ...history];
    if (searchResults) {
      aiMessages = [
        SYSTEM_PROMPT,
        ...history.slice(0, -1),
        { role: 'user', content: 'Web search results for "' + message + '":\n\n' + searchResults.context + '\n\nBased on these search results, please answer: ' + message }
      ];
    }

    const reply = await callAI(aiMessages, model);
    chat.messages.push({ role: 'assistant', content: reply });
    chat.model = model;
    await chat.save();

    res.json({ reply, chatId: chat._id, model, sources });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message || 'Chat failed' });
  }
});

// ── GET CHATS ──
app.get('/chats', authMiddleware, async (req, res) => {
  try {
    const chats = await Chat.find({ userId: req.user.userId }).sort({ updatedAt: -1 }).limit(50).select('_id title model messages updatedAt').lean();
    res.json({ chats });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch chats' }); }
});

// ── FILE UPLOAD ──
app.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const { message, chatId, model = 'groq:llama-3.3-70b-versatile' } = req.body;
    const { mimetype, originalname, path: fPath } = req.file;
    let extractedText = '';

    if (mimetype === 'application/pdf') {
      if (!pdfParse) throw new Error('PDF parsing not available');
      extractedText = (await pdfParse(fs.readFileSync(fPath))).text;
    } else if (mimetype.includes('wordprocessingml') || originalname.endsWith('.docx')) {
      if (!mammoth) throw new Error('DOCX parsing not available');
      extractedText = (await mammoth.extractRawText({ path: fPath })).value;
    } else if (mimetype === 'text/plain') {
      extractedText = fs.readFileSync(fPath, 'utf8');
    } else { throw new Error('Unsupported file type'); }

    if (!extractedText.trim()) throw new Error('Could not extract text from file');

    const userMessage = message
      ? message + '\n\nFile content (' + originalname + '):\n' + extractedText.substring(0, 8000)
      : 'Please summarize and explain this document (' + originalname + '):\n\n' + extractedText.substring(0, 8000);

    let chat = chatId ? await Chat.findOne({ _id: chatId, userId: req.user.userId }) : null;
    if (!chat) chat = new Chat({ userId: req.user.userId, title: 'File: ' + originalname, model, messages: [] });

    chat.messages.push({ role: 'user', content: userMessage });
    const reply = await callAI([SYSTEM_PROMPT, ...chat.messages.slice(-20).map(m => ({ role: m.role, content: m.content }))], model, 1500);
    chat.messages.push({ role: 'assistant', content: reply });
    chat.model = model;
    await chat.save();

    cleanupFile(filePath);
    res.json({ reply, chatId: chat._id, model });
  } catch (err) { cleanupFile(filePath); console.error('Upload error:', err); res.status(500).json({ error: err.message || 'File upload failed' }); }
});

// ── IMAGE UPLOAD (VISION) ──
app.post('/upload-image', authMiddleware, upload.single('image'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    const { message, chatId, model = 'gemini:gemini-2.0-flash' } = req.body;
    const { mimetype, originalname, path: fPath } = req.file;
    const base64Image = fs.readFileSync(fPath).toString('base64');
    const prompt      = message || 'Please describe and analyze this image in detail.';
    const reply       = await callAIVision(base64Image, mimetype, prompt, model);

    let chat = chatId ? await Chat.findOne({ _id: chatId, userId: req.user.userId }) : null;
    if (!chat) chat = new Chat({ userId: req.user.userId, title: 'Image: ' + originalname, model, messages: [] });

    chat.messages.push({ role: 'user',      content: '[Image: ' + originalname + '] ' + prompt });
    chat.messages.push({ role: 'assistant', content: reply });
    chat.model = model;
    await chat.save();

    cleanupFile(filePath);
    res.json({ reply, chatId: chat._id, model });
  } catch (err) { cleanupFile(filePath); console.error('Image error:', err); res.status(500).json({ error: err.message || 'Image analysis failed' }); }
});

// ── ERROR HANDLERS ──
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large. Maximum 10 MB.' });
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// ── START ──
app.listen(PORT, () => {
  console.log('\n  XZILY AI Server running on port ' + PORT + '\n  Multi-AI: Groq + Gemini\n  Web Search: SerpAPI\n  Built by Excellence Omomo, FUTA\n');
});

module.exports = app;
         
