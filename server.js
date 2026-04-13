/**
 * ═══════════════════════════════════════════════════════
 *  XZILY AI — Backend Server
 *  Stack: Express · MongoDB/Mongoose · JWT · OpenAI
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

// ── Optional parsers (graceful fallback if not installed) ──
let pdfParse, mammoth;
try { pdfParse = require('pdf-parse'); } catch { console.warn('pdf-parse not found – PDF uploads disabled'); }
try { mammoth  = require('mammoth');   } catch { console.warn('mammoth not found – DOCX uploads disabled'); }

// ── node-fetch compatibility (v2 for CommonJS) ──
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ──────────────────────────────────────────────────────────
// EXPRESS SETUP
// ──────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: 'https://xzily-ai-frontend.vercel.app',  // In production, restrict to your frontend domain
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ──────────────────────────────────────────────────────────
// MONGODB CONNECTION
// ──────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI environment variable is not set!');
  console.error('Please add MONGO_URI to your Render environment variables.');
  process.exit(1);
}
console.log('🔗 Connecting to MongoDB...');
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected successfully'))
  .catch(err => { console.error('❌ MongoDB connection failed:', err.message); process.exit(1); });

// ──────────────────────────────────────────────────────────
// MONGOOSE SCHEMAS
// ──────────────────────────────────────────────────────────

/** User schema — stores credentials */
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, minlength: 3 },
  password: { type: String, required: true }                 // bcrypt hash
}, { timestamps: true });

/** Chat schema — stores per-user conversation threads */
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
// MULTER — FILE UPLOAD STORAGE
// ──────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },  // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'image/jpeg', 'image/png', 'image/gif', 'image/webp'
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Unsupported file type: ' + file.mimetype));
  }
});

// ──────────────────────────────────────────────────────────
// JWT MIDDLEWARE
// ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ──────────────────────────────────────────────────────────
// OPENAI HELPER
// ──────────────────────────────────────────────────────────
/**
 * Call the OpenAI Chat Completions API.
 * @param {Array}  messages  - Array of { role, content } objects
 * @param {number} maxTokens - Maximum tokens for the response
 * @returns {Promise<string>} The assistant's reply text
 */
async function callOpenAI(messages, maxTokens = 1024) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model:       'gpt-4o-mini',
      messages,
      max_tokens:  maxTokens,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'OpenAI API error');
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

/**
 * Call OpenAI Vision API with an image.
 * @param {string} base64Image - Base64-encoded image data
 * @param {string} mimeType    - e.g. 'image/jpeg'
 * @param {string} prompt      - Text prompt for the vision model
 * @returns {Promise<string>}
 */
async function callOpenAIVision(base64Image, mimeType, prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model:      'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt || 'Please describe and analyze this image in detail.' },
          {
            type:      'image_url',
            image_url: { url: `data:${mimeType};base64,${base64Image}` }
          }
        ]
      }],
      max_tokens: 1024
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'OpenAI Vision error');
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

/** Delete a temp file safely */
function cleanupFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, () => {});
  }
}

// ──────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = {
  role: 'system',
  content: `You are XZILY AI, a highly capable and friendly AI assistant. 
You are knowledgeable, concise, and helpful. 
You can explain complex topics simply, write and debug code, analyze documents, and understand images.
Always be honest about your limitations. Format code with proper markdown code blocks.
Keep responses clear and well-structured.`
};

// ──────────────────────────────────────────────────────────
// ─── ROUTES ───────────────────────────────────────────────
// ──────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'XZILY AI' }));

// ─────────────────────────
// AUTH: REGISTER
// POST /register
// Body: { username, password }
// ─────────────────────────
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    if (username.length < 3)
      return res.status(400).json({ error: 'Username must be at least 3 characters' });

    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Check if username already exists
    const existing = await User.findOne({ username: username.trim() });
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    // Hash password and save user
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = new User({ username: username.trim(), password: hashedPassword });
    await user.save();

    res.status(201).json({ message: 'Account created successfully' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─────────────────────────
// AUTH: LOGIN
// POST /login
// Body: { username, password }
// Returns: { token }
// ─────────────────────────
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    // Find user
    const user = await User.findOne({ username: username.trim() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    // Compare password
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Sign JWT (expires in 7 days)
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

// ─────────────────────────
// CHAT: SEND MESSAGE
// POST /chat  [Auth required]
// Body: { message, chatId? }
// Returns: { reply, chatId }
// ─────────────────────────
app.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { message, chatId } = req.body;
    if (!message || !message.trim())
      return res.status(400).json({ error: 'Message is required' });

    let chat;

    // Load existing chat or create new one
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, userId: req.user.userId });
    }

    if (!chat) {
      // New chat — generate a title from the first message
      const shortTitle = message.length > 40
        ? message.substring(0, 40) + '…'
        : message;
      chat = new Chat({ userId: req.user.userId, title: shortTitle, messages: [] });
    }

    // Add user message to history
    chat.messages.push({ role: 'user', content: message });

    // Build messages array for OpenAI (last 20 messages for context window)
    const history  = chat.messages.slice(-20).map(m => ({ role: m.role, content: m.content }));
    const payload  = [SYSTEM_PROMPT, ...history];

    // Call OpenAI
    const reply = await callOpenAI(payload);

    // Save assistant reply
    chat.messages.push({ role: 'assistant', content: reply });
    await chat.save();

    res.json({ reply, chatId: chat._id });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message || 'Chat failed' });
  }
});

// ─────────────────────────
// CHAT: LIST ALL CHATS
// GET /chats  [Auth required]
// Returns: { chats: [...] }
// ─────────────────────────
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
    console.error('Get chats error:', err);
    res.status(500).json({ error: 'Failed to fetch chats' });
  }
});

// ─────────────────────────
// FILE UPLOAD: PDF / DOCX / TXT
// POST /upload  [Auth required]
// Form: file (multipart), message? (string), chatId? (string)
// Returns: { reply, chatId }
// ─────────────────────────
app.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const { message, chatId } = req.body;
    const { mimetype, originalname, path: fPath } = req.file;

    let extractedText = '';

    // ── Extract text based on file type ──
    if (mimetype === 'application/pdf') {
      if (!pdfParse) throw new Error('PDF parsing not available. Install pdf-parse.');
      const buffer = fs.readFileSync(fPath);
      const parsed = await pdfParse(buffer);
      extractedText = parsed.text;
    } else if (mimetype.includes('wordprocessingml') || originalname.endsWith('.docx')) {
      if (!mammoth) throw new Error('DOCX parsing not available. Install mammoth.');
      const result = await mammoth.extractRawText({ path: fPath });
      extractedText = result.value;
    } else if (mimetype === 'text/plain') {
      extractedText = fs.readFileSync(fPath, 'utf8');
    } else {
      throw new Error('Unsupported file type for text extraction');
    }

    if (!extractedText.trim()) throw new Error('Could not extract text from the file');

    // Limit to ~8000 chars to stay within token limits
    const truncated = extractedText.substring(0, 8000);
    const userMessage = message
      ? `${message}\n\nFile content (${originalname}):\n${truncated}`
      : `Please summarize and explain the following document (${originalname}):\n\n${truncated}`;

    // Load or create chat
    let chat;
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, userId: req.user.userId });
    }
    if (!chat) {
      chat = new Chat({
        userId:   req.user.userId,
        title:    `📄 ${originalname}`,
        messages: []
      });
    }

    chat.messages.push({ role: 'user', content: userMessage });
    const history = chat.messages.slice(-20).map(m => ({ role: m.role, content: m.content }));
    const reply   = await callOpenAI([SYSTEM_PROMPT, ...history], 1500);

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

// ─────────────────────────
// IMAGE UPLOAD (VISION)
// POST /upload-image  [Auth required]
// Form: image (multipart), message? (string), chatId? (string)
// Returns: { reply, chatId }
// ─────────────────────────
app.post('/upload-image', authMiddleware, upload.single('image'), async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const { message, chatId } = req.body;
    const { mimetype, originalname, path: fPath } = req.file;

    // Convert image to base64
    const imageBuffer = fs.readFileSync(fPath);
    const base64Image = imageBuffer.toString('base64');

    const prompt = message
      ? message
      : 'Please describe and analyze this image in detail. What do you see?';

    // Call OpenAI Vision
    const reply = await callOpenAIVision(base64Image, mimetype, prompt);

    // Save to chat history
    let chat;
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, userId: req.user.userId });
    }
    if (!chat) {
      chat = new Chat({
        userId:   req.user.userId,
        title:    `🖼️ ${originalname}`,
        messages: []
      });
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
// GLOBAL ERROR HANDLER
// ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large. Maximum size is 10 MB.' });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ──────────────────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║        XZILY AI — Server         ║
  ║  http://localhost:${PORT}           ║
  ╚══════════════════════════════════╝
  `);
});

module.exports = app;
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },  // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'image/jpeg', 'image/png', 'image/gif', 'image/webp'
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Unsupported file type: ' + file.mimetype));
  }
});

// ──────────────────────────────────────────────────────────
// JWT MIDDLEWARE
// ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ──────────────────────────────────────────────────────────
// OPENAI HELPER
// ──────────────────────────────────────────────────────────
/**
 * Call the OpenAI Chat Completions API.
 * @param {Array}  messages  - Array of { role, content } objects
 * @param {number} maxTokens - Maximum tokens for the response
 * @returns {Promise<string>} The assistant's reply text
 */
async function callOpenAI(messages, maxTokens = 1024) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model:       'gpt-4o-mini',
      messages,
      max_tokens:  maxTokens,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'OpenAI API error');
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

/**
 * Call OpenAI Vision API with an image.
 * @param {string} base64Image - Base64-encoded image data
 * @param {string} mimeType    - e.g. 'image/jpeg'
 * @param {string} prompt      - Text prompt for the vision model
 * @returns {Promise<string>}
 */
async function callOpenAIVision(base64Image, mimeType, prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model:      'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt || 'Please describe and analyze this image in detail.' },
          {
            type:      'image_url',
            image_url: { url: `data:${mimeType};base64,${base64Image}` }
          }
        ]
      }],
      max_tokens: 1024
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'OpenAI Vision error');
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

/** Delete a temp file safely */
function cleanupFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, () => {});
  }
}

// ──────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = {
  role: 'system',
  content: `You are XZILY AI, a highly capable and friendly AI assistant. 
You are knowledgeable, concise, and helpful. 
You can explain complex topics simply, write and debug code, analyze documents, and understand images.
Always be honest about your limitations. Format code with proper markdown code blocks.
Keep responses clear and well-structured.`
};

// ──────────────────────────────────────────────────────────
// ─── ROUTES ───────────────────────────────────────────────
// ──────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'XZILY AI' }));

// ─────────────────────────
// AUTH: REGISTER
// POST /register
// Body: { username, password }
// ─────────────────────────
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    if (username.length < 3)
      return res.status(400).json({ error: 'Username must be at least 3 characters' });

    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Check if username already exists
    const existing = await User.findOne({ username: username.trim() });
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    // Hash password and save user
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = new User({ username: username.trim(), password: hashedPassword });
    await user.save();

    res.status(201).json({ message: 'Account created successfully' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─────────────────────────
// AUTH: LOGIN
// POST /login
// Body: { username, password }
// Returns: { token }
// ─────────────────────────
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    // Find user
    const user = await User.findOne({ username: username.trim() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    // Compare password
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Sign JWT (expires in 7 days)
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

// ─────────────────────────
// CHAT: SEND MESSAGE
// POST /chat  [Auth required]
// Body: { message, chatId? }
// Returns: { reply, chatId }
// ─────────────────────────
app.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { message, chatId } = req.body;
    if (!message || !message.trim())
      return res.status(400).json({ error: 'Message is required' });

    let chat;

    // Load existing chat or create new one
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, userId: req.user.userId });
    }

    if (!chat) {
      // New chat — generate a title from the first message
      const shortTitle = message.length > 40
        ? message.substring(0, 40) + '…'
        : message;
      chat = new Chat({ userId: req.user.userId, title: shortTitle, messages: [] });
    }

    // Add user message to history
    chat.messages.push({ role: 'user', content: message });

    // Build messages array for OpenAI (last 20 messages for context window)
    const history  = chat.messages.slice(-20).map(m => ({ role: m.role, content: m.content }));
    const payload  = [SYSTEM_PROMPT, ...history];

    // Call OpenAI
    const reply = await callOpenAI(payload);

    // Save assistant reply
    chat.messages.push({ role: 'assistant', content: reply });
    await chat.save();

    res.json({ reply, chatId: chat._id });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message || 'Chat failed' });
  }
});

// ─────────────────────────
// CHAT: LIST ALL CHATS
// GET /chats  [Auth required]
// Returns: { chats: [...] }
// ─────────────────────────
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
    console.error('Get chats error:', err);
    res.status(500).json({ error: 'Failed to fetch chats' });
  }
});

// ─────────────────────────
// FILE UPLOAD: PDF / DOCX / TXT
// POST /upload  [Auth required]
// Form: file (multipart), message? (string), chatId? (string)
// Returns: { reply, chatId }
// ─────────────────────────
app.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const { message, chatId } = req.body;
    const { mimetype, originalname, path: fPath } = req.file;

    let extractedText = '';

    // ── Extract text based on file type ──
    if (mimetype === 'application/pdf') {
      if (!pdfParse) throw new Error('PDF parsing not available. Install pdf-parse.');
      const buffer = fs.readFileSync(fPath);
      const parsed = await pdfParse(buffer);
      extractedText = parsed.text;
    } else if (mimetype.includes('wordprocessingml') || originalname.endsWith('.docx')) {
      if (!mammoth) throw new Error('DOCX parsing not available. Install mammoth.');
      const result = await mammoth.extractRawText({ path: fPath });
      extractedText = result.value;
    } else if (mimetype === 'text/plain') {
      extractedText = fs.readFileSync(fPath, 'utf8');
    } else {
      throw new Error('Unsupported file type for text extraction');
    }

    if (!extractedText.trim()) throw new Error('Could not extract text from the file');

    // Limit to ~8000 chars to stay within token limits
    const truncated = extractedText.substring(0, 8000);
    const userMessage = message
      ? `${message}\n\nFile content (${originalname}):\n${truncated}`
      : `Please summarize and explain the following document (${originalname}):\n\n${truncated}`;

    // Load or create chat
    let chat;
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, userId: req.user.userId });
    }
    if (!chat) {
      chat = new Chat({
        userId:   req.user.userId,
        title:    `📄 ${originalname}`,
        messages: []
      });
    }

    chat.messages.push({ role: 'user', content: userMessage });
    const history = chat.messages.slice(-20).map(m => ({ role: m.role, content: m.content }));
    const reply   = await callOpenAI([SYSTEM_PROMPT, ...history], 1500);

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

// ─────────────────────────
// IMAGE UPLOAD (VISION)
// POST /upload-image  [Auth required]
// Form: image (multipart), message? (string), chatId? (string)
// Returns: { reply, chatId }
// ─────────────────────────
app.post('/upload-image', authMiddleware, upload.single('image'), async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const { message, chatId } = req.body;
    const { mimetype, originalname, path: fPath } = req.file;

    // Convert image to base64
    const imageBuffer = fs.readFileSync(fPath);
    const base64Image = imageBuffer.toString('base64');

    const prompt = message
      ? message
      : 'Please describe and analyze this image in detail. What do you see?';

    // Call OpenAI Vision
    const reply = await callOpenAIVision(base64Image, mimetype, prompt);

    // Save to chat history
    let chat;
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, userId: req.user.userId });
    }
    if (!chat) {
      chat = new Chat({
        userId:   req.user.userId,
        title:    `🖼️ ${originalname}`,
        messages: []
      });
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
// GLOBAL ERROR HANDLER
// ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large. Maximum size is 10 MB.' });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ──────────────────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║        XZILY AI — Server         ║
  ║  http://localhost:${PORT}           ║
  ╚══════════════════════════════════╝
  `);
});

module.exports = app;
                    
