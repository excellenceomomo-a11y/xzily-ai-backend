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

// ──────────────────────────────────────────────────────────
// EXPRESS
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
// SMART QUERY DETECTOR
// ──────────────────────────────────────────────────────────
function needsWebSearch(message) {
  const msg = message.toLowerCase();

  const realtimePatterns = [
    /\b(today|tonight|yesterday|this week|this month|this year|right now|currently|at the moment|latest|recent|new|newest|just|breaking)\b/,
    /\b(news|headline|happening|trending|viral|update|announcement|release|launch|dropped|revealed)\b/,
    /\b(celebrity|celebs?|actor|actress|singer|rapper|artist|athlete|footballer|player|star|kardashian|beyonce|rihanna|drake|taylor swift|elon musk|trump|biden|kanye|messi|ronaldo|lebron)\b/,
    /\b(score|match|game|season|transfer|signed|traded|won|lost|champion|world cup|nba|nfl|premier league|la liga|champions league|fifa|uefa|super bowl|playoffs|standings)\b/,
    /\b(movie|film|series|show|episode|album|song|track|concert|tour|award|oscar|grammy|billboard|box office|streaming|netflix|spotify|youtube)\b/,
    /\b(stock|price|crypto|bitcoin|ethereum|market|economy|inflation|gdp|company|startup|ipo|acquisition|merger|product|iphone|android|ai model|chatgpt|gemini|openai|google|apple|meta|tesla)\b/,
    /\b(election|president|prime minister|government|war|conflict|peace|deal|treaty|sanction|protest|law|bill|policy|vote)\b/,
    /\b(2024|2025|2026)\b/,
    /\b(who is|what is|where is|how is|is [a-z]+ still|did [a-z]+ just|has [a-z]+ been)\b/,
    /\b(died|dead|death|born|married|divorced|pregnant|baby|engaged|broke up|dating|relationship)\b/,
  ];

  return realtimePatterns.some(pattern => pattern.test(msg));
  }
// ──────────────────────────────────────────────────────────
// WEB SEARCH — SerpAPI
// ──────────────────────────────────────────────────────────
async function webSearch(query) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) { console.warn('SERPAPI_KEY not set'); return null; }

  try {
    const url = 'https://serpapi.com/search.json?q=' + encodeURIComponent(query) +
      '&api_key=' + apiKey + '&num=6&hl=en&gl=us';
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();

    const results = [];

    // Top stories (breaking news)
    if (data.top_stories) {
      data.top_stories.slice(0, 3).forEach(s => {
        results.push({ title: s.title, snippet: s.source + ' — ' + (s.date || ''), url: s.link });
      });
    }

    // Organic results
    if (data.organic_results) {
      data.organic_results.slice(0, 4).forEach(r => {
        results.push({ title: r.title, snippet: r.snippet || '', url: r.link });
      });
    }

    // Knowledge graph (for celebrities/people/places)
    let kgContext = '';
    if (data.knowledge_graph) {
      const kg = data.knowledge_graph;
      const parts = [kg.title, kg.type, kg.description, kg.born, kg.nationality].filter(Boolean);
      if (parts.length) kgContext = 'Quick facts: ' + parts.join(' | ') + '\n\n';
    }

    // Answer box (direct answers)
    let answerBox = '';
    if (data.answer_box) {
      const ab = data.answer_box;
      answerBox = 'Direct answer: ' + (ab.answer || ab.snippet || ab.result || '') + '\n\n';
    }

    if (!results.length && !kgContext && !answerBox) return null;

    const context = kgContext + answerBox +
      results.map((r, i) => '[' + (i+1) + '] ' + r.title + '\n' + r.snippet + '\nSource: ' + r.url).join('\n\n');

    return { context, sources: results.slice(0, 4) };
  } catch (err) {
    console.error('Web search error:', err.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ──────────────────────────────────────────────────────────
function buildSystemPrompt(hasSearchResults) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  return {
    role: 'system',
    content: `You are XZILY AI, an intelligent, up-to-date AI assistant. Today's date is ${today}.

IDENTITY RULES (follow strictly, no exceptions):
- Do NOT introduce yourself unless asked.
- Do NOT mention Groq, Gemini, LLaMA, or any external AI provider under any circumstances.
- Never say your knowledge has a cutoff date. Never say "as of my last update" or "I don't have real-time information."
- If asked who built/created/developed you: reply EXACTLY → "I'm XZILY AI, built and developed by Excellence Omomo, a student of the Federal University of Technology Akure."
- If asked when you were launched: reply EXACTLY → "I was launched on Monday, 13th April, 2026."
- If asked why you were built: reply EXACTLY → "I was created with a vision to explore artificial intelligence and develop solutions that address real human challenges."

KNOWLEDGE RULES:
- You are always up to date. You have access to real-time web search.
- ${hasSearchResults
    ? 'You have been provided with fresh web search results below. Use them to answer accurately. Always synthesize the search results naturally — do not just list them.'
    : 'Answer from your knowledge confidently. Never claim your information is outdated.'}
- For celebrities, sports, entertainment, news, politics — always answer confidently and naturally.
- Format code with markdown code blocks.
- Be concise, natural, and helpful.`
  };
}

// ──────────────────────────────────────────────────────────
// AI PROVIDERS
// ──────────────────────────────────────────────────────────
function parseModel(modelStr = '') {
  const [provider, ...rest] = modelStr.split(':');
  return { provider: provider || 'groq', model: rest.join(':') || 'llama-3.3-70b-versatile' };
}

async function callGroq(messages, model, maxTokens = 1024) {
  if (!process.env.GROQ_API_KEY) throw new Error('Groq API key not configured.');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.7 })
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Groq error'); }
  const d = await res.json();
  return d.choices[0].message.content.trim();
}

async function callGemini(messages, model, maxTokens = 1024) {
  if (!process.env.GEMINI_API_KEY) throw new Error('Gemini API key not configured.');
  const systemText = messages.find(m => m.role === 'system')?.content || '';
  const chatMsgs   = messages.filter(m => m.role !== 'system');
  const contents   = chatMsgs.map((m, idx) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: (idx === 0 && m.role === 'user' && systemText) ? systemText + '\n\n' + m.content : m.content }]
  }));
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + process.env.GEMINI_API_KEY;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 } })
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Gemini error'); }
  const d = await res.json();
  return d.candidates[0].content.parts[0].text.trim();
}

async function callGroqVision(base64Image, mimeType, prompt) {
  if (!process.env.GROQ_API_KEY) throw new Error('Groq API key not configured.');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Groq Vision error'); }
  const d = await res.json();
  return d.choices[0].message.content.trim();
}

async function callGeminiVision(base64Image, mimeType, prompt, model) {
  if (!process.env.GEMINI_API_KEY) throw new Error('Gemini API key not configured.');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + process.env.GEMINI_API_KEY;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: prompt || 'Describe and analyze this image in detail.' },
        { inline_data: { mime_type: mimeType, data: base64Image } }
      ]}],
      generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
    })
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Gemini Vision error'); }
  const d = await res.json();
  return d.candidates[0].content.parts[0].text.trim();
}

async function callAI(messages, modelStr, maxTokens = 1024) {
  const { provider, model } = parseModel(modelStr);
  if (provider === 'gemini') return callGemini(messages, model, maxTokens);
  return callGroq(messages, model, maxTokens);
}

async function callAIVision(base64Image, mimeType, prompt, modelStr) {
  const { provider, model } = parseModel(modelStr || 'gemini:gemini-2.0-flash');
  if (provider === 'gemini') return callGeminiVision(base64Image, mimeType, prompt, model);
  return callGroqVision(base64Image, mimeType, prompt);
}

function cleanupFile(fp) { if (fp && fs.existsSync(fp)) fs.unlink(fp, () => {}); }

// ──────────────────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'XZILY AI', time: new Date().toISOString() }));

// REGISTER
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

// LOGIN
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

// ME
app.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ username: user.username });
  } catch (err) { res.status(500).json({ error: 'Failed to get user info' }); }
});

// CHAT
app.post('/chat', authMiddleware, async (req, res) => {
  try {
    const {
      message,
      chatId,
      model      = 'groq:llama-3.3-70b-versatile',
      webSearch: manualSearch = false
    } = req.body;

    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

    const shouldSearch = manualSearch || needsWebSearch(message);
    let searchResults  = null;
    let sources        = [];

    if (shouldSearch) {
      console.log('Searching web for:', message);
      searchResults = await webSearch(message);
      if (searchResults) {
        sources = searchResults.sources;
        console.log('Got', sources.length, 'search results');
      }
    }

    let chat = chatId ? await Chat.findOne({ _id: chatId, userId: req.user.userId }) : null;
    if (!chat) {
      chat = new Chat({
        userId:   req.user.userId,
        title:    message.substring(0, 40) + (message.length > 40 ? '...' : ''),
        model,
        messages: []
      });
    }

    chat.messages.push({ role: 'user', content: message });

    const systemPrompt = buildSystemPrompt(!!searchResults);
    const history      = chat.messages.slice(-20).map(m => ({ role: m.role, content: m.content }));
    let   aiMessages   = [systemPrompt, ...history];

    if (searchResults) {
      aiMessages = [
        systemPrompt,
        ...history.slice(0, -1),
        {
          role: 'user',
          content: 'Real-time web search results (use these to answer):\n\n' +
                   searchResults.context +
                   '\n\n---\nUser question: ' + message +
                   '\n\nPlease answer naturally using the search results above.'
        }
      ];
    }

    const reply = await callAI(aiMessages, model);

    chat.messages.push({ role: 'assistant', content: reply });
    chat.model = model;
    await chat.save();

    res.json({
      reply,
      chatId:     chat._id,
      model,
      sources,
      searched:   !!searchResults
    });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message || 'Chat failed' });
  }
});

// GET CHATS
app.get('/chats', authMiddleware, async (req, res) => {
  try {
    const chats = await Chat.find({ userId: req.user.userId }).sort({ updatedAt: -1 }).limit(50).select('_id title model messages updatedAt').lean();
    res.json({ chats });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch chats' }); }
});

// FILE UPLOAD
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
      ? message + '\n\nFile: ' + originalname + '\n' + extractedText.substring(0, 8000)
      : 'Summarize and explain this document (' + originalname + '):\n\n' + extractedText.substring(0, 8000);

    let chat = chatId ? await Chat.findOne({ _id: chatId, userId: req.user.userId }) : null;
    if (!chat) chat = new Chat({ userId: req.user.userId, title: 'File: ' + originalname, model, messages: [] });

    chat.messages.push({ role: 'user', content: userMessage });
    const systemPrompt = buildSystemPrompt(false);
    const reply = await callAI([systemPrompt, ...chat.messages.slice(-20).map(m => ({ role: m.role, content: m.content }))], model, 1500);
    chat.messages.push({ role: 'assistant', content: reply });
    chat.model = model;
    await chat.save();

    cleanupFile(filePath);
    res.json({ reply, chatId: chat._id, model });
  } catch (err) { cleanupFile(filePath); console.error('Upload error:', err); res.status(500).json({ error: err.message || 'File upload failed' }); }
});

// IMAGE UPLOAD
app.post('/upload-image', authMiddleware, upload.single('image'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    const { message, chatId, model = 'gemini:gemini-2.0-flash' } = req.body;
    const { mimetype, originalname, path: fPath } = req.file;
    const base64Image = fs.readFileSync(fPath).toString('base64');
    const prompt      = message || 'Describe and analyze this image in detail.';
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

// ERROR HANDLERS
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large. Maximum 10 MB.' });
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// START
app.listen(PORT, () => {
  console.log('\n  XZILY AI Server\n  Port: ' + PORT + '\n  AI: Groq + Gemini\n  Search: SerpAPI (auto-trigger)\n  Built by Excellence Omomo, FUTA\n');
});

module.exports = app;
