const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const config = require(path.join(__dirname, 'config.js'));
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080; // Using port from environment or 8080 as fallback

// Chatwoot Configuration from config.js
const CHATWOOT_API_URL = config.CHATWOOT_CONFIG.apiUrl;
const CHATWOOT_API_TOKEN = config.CHATWOOT_CONFIG.apiToken;
const CHATWOOT_ACCOUNT_ID = parseInt(config.CHATWOOT_CONFIG.accountId, 10);

// Mapping of Hostaway channels to Chatwoot inbox IDs from config.js
const CHANNEL_TO_INBOX = config.CHANNEL_TO_INBOX;

// Rate limiting variables
const API_RATE_LIMIT = {
  maxRequests: 3, // Reduced maximum requests per window
  windowMs: 60 * 1000, // 1 minute in milliseconds
  retryAfterMs: 10000, // Increased wait time to 10 seconds before retrying after a 429
  maxRetries: 5, // Increased maximum number of retries for a request
  backoffFactor: 2 // Exponential backoff factor
};

// Request tracking for rate limiting
const requestTimestamps = [];

// Function to check if we should throttle requests
function shouldThrottleRequest() {
  const now = Date.now();
  // Remove timestamps older than the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - API_RATE_LIMIT.windowMs) {
    requestTimestamps.shift();
  }
  
  // Check if we've hit the rate limit
  return requestTimestamps.length >= API_RATE_LIMIT.maxRequests;
}

// Add timestamp when making a request
function trackRequest() {
  requestTimestamps.push(Date.now());
}

// Create axios instance with retry logic for rate limiting
const createApiWithRetry = (config) => {
  const api = axios.create(config);
  
  // Add request interceptor for rate limiting
  api.interceptors.request.use(async (config) => {
    // Check if we should throttle
    if (shouldThrottleRequest()) {
      console.log('🚦 Rate limiting in effect, waiting before making request...');
      await new Promise(resolve => setTimeout(resolve, API_RATE_LIMIT.retryAfterMs));
    }
    
    // Track this request
    trackRequest();
    return config;
  });
  
  // Add response interceptor for handling 429 errors and other network issues
  api.interceptors.response.use(
    response => response,
    async error => {
      const config = error.config;
      
      // Initialize retry count if it doesn't exist
      config.retryCount = config.retryCount || 0;
      
      // Check if we should retry (429 rate limit or network errors)
      const shouldRetry = (
        (error.response?.status === 429 || !error.response) && 
        config.retryCount < API_RATE_LIMIT.maxRetries
      );
      
      if (shouldRetry) {
        config.retryCount += 1;
        
        // Calculate backoff time with exponential increase
        let retryAfter;
        
        if (error.response?.headers['retry-after']) {
          // Use server-provided retry time if available
          retryAfter = parseInt(error.response.headers['retry-after']) * 1000;
        } else {
          // Otherwise use exponential backoff
          retryAfter = API_RATE_LIMIT.retryAfterMs * Math.pow(API_RATE_LIMIT.backoffFactor, config.retryCount - 1);
        }
        
        console.log(`🔄 ${error.response?.status === 429 ? 'Rate limit (429)' : 'Network error'}, retrying after ${retryAfter/1000}s (attempt ${config.retryCount}/${API_RATE_LIMIT.maxRetries})`);
        
        // Wait before retrying with exponential backoff
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        
        // Clear request timestamps to avoid cascading failures
        if (requestTimestamps.length > 0) {
          console.log('🧹 Clearing request timestamps to reset rate limiting');
          requestTimestamps.length = 0;
        }
        
        return api(config);
      }
      
      return Promise.reject(error);
    }
  );
  
  return api;
};
// Hostaway API instance with retry logic
const hostawayApi = createApiWithRetry({
  baseURL: 'https://api.hostaway.com/v1',
  headers: {
    'Authorization': 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI4MDA2NiIsImp0aSI6ImM5MDQ4NTgzNTBhYWNiOTdiMzBkNDAxMjczMDBjYTkyZmE1Njg0ZTU0MzJiMjMyNWM2YTIzYmVkMTQ5ZGE4YTQyNjUwMzgwMWY0YmI0YmNlIiwiaWF0IjoxNzM3OTc5NDcwLjk3NzYxMiwibmJmIjoxNzM3OTc5NDcwLjk3NzYxNCwiZXhwIjoyMDUzNTEyMjcwLjk3NzYxOCwic3ViIjoiIiwic2NvcGVzIjpbImdlbmVyYWwiXSwic2VjcmV0SWQiOjUzMDQzfQ.ItaGLJwySFtroyXsLdS_zMIeEDPivN-MjjHPxOvCjoHvFqAHuX4HBX-HCjAp-5f2gKLilxPsRcdYRkDvViILKr73qyo6nSnNPokYj3JUYXsuBLoKMejzwuvYMn_DQc2HbbdDAmV_iREKMfiPyJu2vJjRSKI5xc033CGFm5Tng-c',
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

// Chatwoot API instance with retry logic
const chatwootApi = createApiWithRetry({
  baseURL: CHATWOOT_API_URL,
  headers: {
    'api_access_token': CHATWOOT_API_TOKEN,
    'Content-Type': 'application/json'
  }
});

// Configuration files
const LAST_TIMESTAMP_FILE = 'last_timestamp.json';
const MESSAGE_CACHE_FILE = 'message_cache.json';
const PROCESSED_IDS_FILE = 'processed_ids.json';
const CONVERSATION_CACHE_FILE = 'conversation_cache.json';
const SENT_MESSAGES_LOG_FILE = 'sent_messages_log.json';
const LAST_PROCESSED_ID_FILE = 'last_processed_id.json';
const CHANNEL_MESSAGE_IDS_FILE = 'channel_message_ids.json';

// Define allowed inboxes
const ALLOWED_INBOXES = new Set([5, 6, 8, 10]); // Airbnb, Booking.com, Vrbo, Website inboxes
// Explicitly exclude inbox 2 (already not in the set above)

// Global variables for tracking message processing
let lastProcessedMessageId = null;
let lastProcessedMessageIdByChannel = {};
let isPolling = false;
let isInitializing = true;
let serverStartTimestamp = Date.now();
let mostRecentMessageId = null;
// Set to track all processed message IDs to prevent duplicates
let processedMessageIds = new Set();
let isVrboPolling = false; // Flag to prevent concurrent VRBO polling

// Channel identification constants
const CHANNEL_TYPES = {
  AIRBNB: '2018',
  BOOKING: '2005',
  VRBO: '2002',
  VRBO_ALT1: '2007',
  VRBO_ALT2: '2010',
  WEBSITE: '2013',
  UNKNOWN: 'unknown'
};

// Channel detection patterns
const CHANNEL_PATTERNS = {
  [CHANNEL_TYPES.AIRBNB]: ['airbnb', 'air bnb', 'air-bnb'],
  [CHANNEL_TYPES.BOOKING]: ['booking.com', 'booking', 'bookingcom'],
  [CHANNEL_TYPES.VRBO]: ['vrbo', 'homeaway', 'expedia', 'vrbo.com'],
  [CHANNEL_TYPES.WEBSITE]: ['website', 'direct', 'booking engine', 'bookingengine']
};

// Function to get readable channel name from channel ID
function getChannelName(channelId) {
  // Convert channelId to string for consistent comparison
  const channelIdStr = String(channelId);
  
  switch(channelIdStr) {
    case '2018':
      return 'Airbnb';
    case '2005':
      return 'Booking.com';
    case '2002':
    case '2007':
    case '2010':
      return 'VRBO';
    case '2013':
      return 'Website/Booking Engine';
    default:
      return `Unknown Channel (${channelIdStr})`;
  }
}

/**
 * Detects the channel type from various message properties
 * @param {Object} data - The message data
 * @returns {string} - The detected channel ID
 */
function detectChannelType(data) {
  // If we already have a valid channel ID that exists in our mapping, use it
  if (data.channelId && CHANNEL_TO_INBOX[data.channelId]) {
    console.log(`Using existing channel ID: ${data.channelId}`);
    return data.channelId;
  }
  
  // If we have a numeric channel ID as a string, use it
  if (data.channelId && /^\d+$/.test(data.channelId)) {
    console.log(`Using numeric channel ID: ${data.channelId}`);
    return data.channelId;
  }
  
  // Check various properties for channel name patterns
  const textToCheck = [
    data.channelId,
    data.channel,
    data.source,
    data.platform,
    data.origin,
    data.from,
    data.sender,
    data.senderName,
    data.message,
    data.content,
    data.body,
    JSON.stringify(data).toLowerCase() // Check the entire object as a last resort
  ].filter(Boolean).join(' ').toLowerCase();
  
  // Check for channel-specific patterns
  for (const [channelId, patterns] of Object.entries(CHANNEL_PATTERNS)) {
    if (patterns.some(pattern => textToCheck.includes(pattern))) {
      console.log(`Detected channel ${channelId} from pattern match in: ${textToCheck.substring(0, 50)}...`);
      return channelId;
    }
  }
  
  // If we have a reservation ID, try to get the channel from there
  if (data.reservationId) {
    // This would be handled asynchronously elsewhere
    console.log(`Could use reservation ID ${data.reservationId} to determine channel`);
  }
  
  // Default to Website/Booking Engine if we can't determine
  console.log(`Could not determine channel, defaulting to Website/Booking Engine (${CHANNEL_TYPES.WEBSITE})`);
  return CHANNEL_TYPES.WEBSITE;
}
// Initialize the lastProcessedMessageIdByChannel with default values
lastProcessedMessageIdByChannel = {
  2018: null, // Airbnb
  2005: null, // Booking.com
  2002: null, // Vrbo
  2013: null  // Website
};
const processingMessages = new Set();

// Contact cache to prevent duplicate contact creation
const contactCache = new Map();

// Track message sources to prevent echo
const MESSAGE_SOURCES = {
  CHATWOOT: 'chatwoot',
  HOSTAWAY: 'hostaway'
};

// Message retention period
const MESSAGE_RETENTION_HOURS = 24; // For messageCache

// Maximum age of messages to process (in seconds)
const MAX_MESSAGE_AGE_SECONDS = 60; // Only process messages from the last minute

// Message cache with TTL
class MessageCache {
  constructor(ttlMs = 15 * 1000) { // 15 seconds TTL
    this.cache = new Map();
    this.ttl = ttlMs;
  }

  add(key) {
    this.cache.set(key, Date.now());
  }

  has(key) {
    if (!this.cache.has(key)) return false;
    const timestamp = this.cache.get(key);
    if (Date.now() - timestamp > this.ttl) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, timestamp] of this.cache.entries()) {
      if (now - timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  clear() {
    this.cache.clear();
  }

  toJSON() {
    const entries = {};
    for (const [key, timestamp] of this.cache.entries()) {
      entries[key] = timestamp;
    }
    return entries;
  }

  fromJSON(data) {
    try {
      this.clear();
      if (Array.isArray(data)) {
        for (const key of data) {
          this.add(key);
        }
      } else {
        for (const [key, timestamp] of Object.entries(data)) {
          this.cache.set(key, timestamp);
        }
      }
      this.cleanup();
    } catch (error) {
      console.error('Error parsing message cache data:', error.stack);
      this.clear();
    }
  }
}

// Initialize message tracking
const messageCache = new MessageCache();
// isPolling is already declared above
// Polling configuration with adaptive backoff
const POLLING_CONFIG = {
  initialInterval: 3000, // Start with 3 seconds (more frequent checking)
  currentInterval: 3000, // Current interval (will change based on errors)
  maxInterval: 15000, // Maximum 15 seconds (reduced from 30s)
  minInterval: 2000, // Minimum 2 seconds (more responsive)
  backoffFactor: 1.3, // Increase by 30% after errors (less aggressive backoff)
  successReductionFactor: 0.8, // Reduce by 20% after success (more aggressive reduction)
  consecutiveErrors: 0,
  maxConsecutiveErrors: 3 // Reset to max interval after this many errors (reduced threshold)
};

// Initialize or load tracking state
try {
  // Always start with current timestamp to avoid processing old messages
  // This ensures we only process messages that arrive after the server starts
  lastMessageTimestamp = Date.now();
  console.log(`📅 Setting initial timestamp to ${new Date(lastMessageTimestamp).toISOString()} to only process new messages`);
  fs.writeFileSync(LAST_TIMESTAMP_FILE, JSON.stringify({ timestamp: lastMessageTimestamp }));
  
  if (fs.existsSync(MESSAGE_CACHE_FILE)) {
    const fileContent = fs.readFileSync(MESSAGE_CACHE_FILE, 'utf8');
    const data = JSON.parse(fileContent);
    messageCache.fromJSON(data);
    console.log('✅ Loaded message cache with', messageCache.cache.size, 'entries');
  }

  if (fs.existsSync(PROCESSED_IDS_FILE)) {
    processedMessageIds = new Set(JSON.parse(fs.readFileSync(PROCESSED_IDS_FILE, 'utf8')));
  }

  if (fs.existsSync(CONVERSATION_CACHE_FILE)) {
    const cached = JSON.parse(fs.readFileSync(CONVERSATION_CACHE_FILE, 'utf8'));
    conversationCache = new Map(Object.entries(cached));
  }

  if (fs.existsSync(SENT_MESSAGES_LOG_FILE)) {
    const data = JSON.parse(fs.readFileSync(SENT_MESSAGES_LOG_FILE, 'utf8'));
    sentMessagesLog = new Map(Object.entries(data));
    console.log(`✅ Loaded sent messages log with ${sentMessagesLog.size} entries`);
  }

  if (fs.existsSync(LAST_PROCESSED_ID_FILE)) {
    lastProcessedMessageId = JSON.parse(fs.readFileSync(LAST_PROCESSED_ID_FILE, 'utf8')).id;
    console.log(`✅ Loaded last processed message ID: ${lastProcessedMessageId}`);
  }
  
  // Load channel-specific message IDs
  if (fs.existsSync(CHANNEL_MESSAGE_IDS_FILE)) {
    lastProcessedMessageIdByChannel = JSON.parse(fs.readFileSync(CHANNEL_MESSAGE_IDS_FILE, 'utf8'));
    console.log(`✅ Loaded channel-specific message IDs:`, lastProcessedMessageIdByChannel);
  }
} catch (error) {
  console.error('Error loading tracking state:', error.stack);
  lastMessageTimestamp = Date.now() - (5 * 60 * 1000);
  processedMessageIds = new Set();
  sentMessagesLog = new Map();
  lastProcessedMessageId = null;
}

// Save tracking state
function saveTrackingState() {
  try {
    // In Vercel's serverless environment, file writes may fail
    // We'll try to save state, but handle gracefully if it fails
    try {
      // Save last processed message ID
      fs.writeFileSync(LAST_PROCESSED_ID_FILE, JSON.stringify({
        lastProcessedMessageId,
        timestamp: new Date().toISOString()
      }));
      
      // Save channel-specific message IDs
      fs.writeFileSync(CHANNEL_MESSAGE_IDS_FILE, JSON.stringify(lastProcessedMessageIdByChannel));
      
      // Save processed message IDs
      fs.writeFileSync(PROCESSED_IDS_FILE, JSON.stringify(Array.from(processedMessageIds)));
      
      // Save sent messages log
      const sentMessagesArray = Array.from(sentMessagesLog.entries()).map(([key, value]) => ({ key, ...value }));
      fs.writeFileSync(SENT_MESSAGES_LOG_FILE, JSON.stringify(sentMessagesArray));
      console.log(`✅ Saved sent messages log with ${sentMessagesLog.size} entries`);
    } catch (fsError) {
      // In serverless environments like Vercel, file system operations may fail
      // Just log the error and continue - this is expected in serverless
      console.log(`ℹ️ File system operation skipped (expected in serverless): ${fsError.message}`);
    }
  } catch (error) {
    console.error('❌ Error saving tracking state:', error.message);
  }
}

// Start the server with port fallback mechanism
const startServer = (port) => {
  try {
    const serverInstance = app.listen(port, async () => {
      console.log(`Server running on port ${port}`);
      console.log(`Time: ${formatPakistanTime()}`);
      
      console.log('\n🔔 INITIALIZING TRIGGER-BASED MESSAGE SYSTEM');
      console.log('During initialization, existing messages will be recorded but not processed.');
      console.log('Only new messages that arrive after initialization will be shown and processed.');
      
      console.log('\n=== Hostaway-Chatwoot Integration ===');
      console.log(`Started at: ${formatPakistanTime()}`);
      console.log(`Server running on port: ${port}`);
      console.log(`Initial polling interval: ${POLLING_CONFIG.initialInterval}ms (adaptive: ${POLLING_CONFIG.minInterval}-${POLLING_CONFIG.maxInterval}ms)`);
      console.log('🔍 Enhanced with comprehensive debugging and rate limiting');
      console.log('===================================');
      
      // Initial check for new messages
      try {
        await checkNewMessages();
        // Also check VRBO messages specifically
        await checkVrboMessages();
      } catch (error) {
        console.error('Error in initial message check:', error.message);
      }
    });
    
    return serverInstance;
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      console.log(`Port ${port} is in use, trying next port...`);
      return null;
    }
    throw error;
  }
};

// Try to start the server on port 8080 first (for ngrok compatibility)
let server = startServer(8080);

// If port 8080 is in use, try port 3000
if (!server) {
  server = startServer(3000);
}

// If port 3000 is also in use, try port 5000
if (!server) {
  server = startServer(5000);
}

// Export the Express app for serverless environments like Vercel
module.exports = app;

// If all preferred ports are in use, try a random port
if (!server) {
  server = startServer(0); // Port 0 means the OS will assign a random available port
}

// Regular polling for new messages
setInterval(async () => {
  try {
    await checkNewMessages();
  } catch (error) {
    console.error('Error in polling interval:', error.message);
  }
}, 1500); // Check every 1.5 seconds for faster response to new messages

// Dedicated VRBO message polling (runs every 3 seconds)
setInterval(async () => {
  try {
    await checkVrboMessages();
  } catch (error) {
    console.error('Error in VRBO polling interval:', error.message);
  }
}, 3000); // Check every 3 seconds specifically for VRBO messages

// Clean old messages from cache (older than 24 hours)
function cleanMessageCache() {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  const oldMessages = [...messageCache].filter(msgId => {
    const [timestamp] = msgId.split('_');
    return parseInt(timestamp) < oneDayAgo;
  });
  oldMessages.forEach(msgId => messageCache.delete(msgId));
  saveTrackingState();
}

// Clean old sent messages from log (older than 30 days)
setInterval(() => {
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  let removed = 0;
  for (const [key, data] of sentMessagesLog.entries()) {
    if (new Date(data.timestamp).getTime() < thirtyDaysAgo) {
      sentMessagesLog.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`🧹 Cleaned ${removed} old sent messages from log`);
    saveSentMessagesLog();
  }
}, 24 * 60 * 60 * 1000); // Run daily

// Enable CORS for all routes with specific configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Endpoints
app.get('/api/conversations', async (req, res) => {
  try {
    const response = await hostawayApi.get('/conversations', {
      params: {
        sortOrder: 'desc',
        sortField: 'createdAt',
        limit: 20
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching conversations:', error.stack);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const response = await hostawayApi.get(`/conversations/${req.params.id}/messages`, {
      params: {
        sortOrder: 'desc',
        sortField: 'createdAt',
        limit: 20
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching messages:', error.stack);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.post('/webhook/chatwoot', async (req, res) => {
  try {
    await handleChatwootWebhook(req.body);
    res.status(200).send('Webhook processed successfully');
  } catch (error) {
    console.error('Error processing Chatwoot webhook:', error.stack);
    res.status(500).send('Error processing webhook');
  }
});

// Webhook endpoint for Hostway to trigger when new messages arrive
app.post('/webhook/hostway', async (req, res) => {
  try {
    console.log('\n🔔 HOSTWAY WEBHOOK TRIGGERED!');
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    
    // Extract conversation and message information from the webhook payload
    const { conversationId, messageId } = req.body;
    
    if (conversationId) {
      console.log(`Processing webhook for conversation: ${conversationId}`);
      
      // Immediately check for new messages in this conversation
      await processConversation(conversationId);
      
      res.status(200).send('Hostway webhook processed successfully');
    } else {
      console.log('No conversation ID provided in webhook, triggering general check');
      // If no specific conversation ID, trigger a general check
      await checkNewMessages();
      res.status(200).send('General message check triggered');
    }
  } catch (error) {
    console.error('Error processing Hostway webhook:', error.stack);
    res.status(500).send('Error processing webhook');
  }
});

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    port: PORT,
    time: formatPakistanTime(),
    messagesProcessed: processedMessageIds.size,
    sentMessages: sentMessagesLog.size,
    processingMessages: processingMessages.size
  });
});

// Enhanced Health Check Endpoint
app.get('/api/health', async (req, res) => {
  try {
    await hostawayApi.get('/conversations?limit=1');
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        hostaway: 'connected',
        chatwoot: 'connected'
      },
      stats: {
        processedMessages: processedMessageIds.size,
        sentMessages: sentMessagesLog.size,
        cachedConversations: conversationCache.size,
        processingMessages: processingMessages.size
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.stack,
      timestamp: new Date().toISOString()
    });
  }
});

// Handle root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Enhanced retry mechanism for Hostaway API calls
async function sendToHostawayWithRetry(conversationId, content, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🚀 HOSTAWAY API CALL - Attempt ${attempt}/${maxRetries}:`, {
        conversationId,
        contentLength: content.length,
        content: content.substring(0, 100) + (content.length > 100 ? '...' : ''),
        timestamp: new Date().toISOString(),
        url: `https://api.hostaway.com/v1/conversations/${conversationId}/messages`
      });

      const response = await hostawayApi.post(`/conversations/${conversationId}/messages`, {
        body: content,
        type: 'text'
      });
      
      console.log(`✅ HOSTAWAY SUCCESS - Attempt ${attempt}:`, {
        status: response.status,
        statusText: response.statusText,
        responseData: response.data
      });

      return response;
    } catch (error) {
      console.error(`❌ HOSTAWAY ERROR - Attempt ${attempt}:`, {
        error: error.stack,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      });
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      const waitTime = 1000 * Math.pow(2, attempt - 1);
      console.log(`⏳ WAITING ${waitTime}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

// Enhanced retry mechanism for Chatwoot API calls
async function sendToChatwootWithRetry(message, conversation, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Safely extract content for logging, handling different message formats
      let contentForLog = '';
      if (message.body) {
        contentForLog = message.body.substring(0, 100) + (message.body.length > 100 ? '...' : '');
      } else if (message.content) {
        contentForLog = message.content.substring(0, 100) + (message.content.length > 100 ? '...' : '');
      } else if (typeof message === 'string') {
        contentForLog = message.substring(0, 100) + (message.length > 100 ? '...' : '');
      } else {
        contentForLog = 'No message content available';
      }
      
      console.log(`🚀 CHATWOOT API CALL - Attempt ${attempt}/${maxRetries}:`, {
        conversationId: conversation.id,
        content: contentForLog,
        timestamp: new Date().toISOString()
      });

      await sendToChatwoot(message, conversation);
      
      console.log(`✅ CHATWOOT SUCCESS - Attempt ${attempt}: Message sent successfully`);
      return;
    } catch (error) {
      console.error(`❌ CHATWOOT ERROR - Attempt ${attempt}:`, {
        error: error.stack,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      });
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      const waitTime = 1000 * Math.pow(2, attempt - 1);
      console.log(`⏳ WAITING ${waitTime}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

// Helper function to normalize message content
function normalizeContent(content) {
  if (!content) return '';
  return content.trim().toLowerCase();
}

// Helper function to create message key
function createMessageKey(content, conversationId, channelId) {
  // Normalize the content by removing HTML tags and whitespace
  const normalizedContent = content.replace(/<[^>]*>/g, '').trim().toLowerCase();
  return `${normalizedContent}_${conversationId}_${channelId}`;
}

// Map Chatwoot inbox ID to Hostaway channel ID
function getHostawayChannelId(inboxId) {
  const inboxToChannel = {
    5: 2018,  // Airbnb
    6: 2005,  // Booking.com
    8: 2002,  // Vrbo
    10: 2013  // Website/Booking Engine
  };
  return inboxToChannel[inboxId];
}

// Enhanced duplicate check function
function isDuplicateMessage(content, conversationId, channelId) {
  const messageKey = createMessageKey(content, conversationId, channelId);
  
  // Check in messageCache first (short-term memory)
  if (messageCache.has(messageKey)) {
    console.log('⏭️ Skipping duplicate message (found in cache):', {
      content: content.substring(0, 50),
      conversationId,
      channelId
    });
    return true;
  }

  // Check in sentMessagesLog (long-term memory) - only if within 15 seconds
  if (sentMessagesLog.has(messageKey)) {
    const logEntry = sentMessagesLog.get(messageKey);
    const messageTime = new Date(logEntry.timestamp).getTime();
    const currentTime = Date.now();
    const timeDiff = currentTime - messageTime;
    
    // Only consider as duplicate if sent within the last 60 seconds (1 minute)
    if (timeDiff <= 60 * 1000) {
      console.log('⏭️ Skipping duplicate message (found in log):', {
        content: content.substring(0, 50),
        conversationId,
        channelId,
        timeDiff: Math.round(timeDiff / 1000) + ' seconds ago'
      });
      return true;
    } else {
      console.log('✅ Message previously seen but outside 1-minute window:', {
        content: content.substring(0, 50),
        timeDiff: Math.round(timeDiff / 1000) + ' seconds ago'
      });
    }
  }

  return false;
}

// Check if message was already sent (regardless of source)
function isAlreadySent(content, conversationId, channelId) {
  return isDuplicateMessage(content, conversationId, channelId);
}

// Function to add message to cache and log
function trackMessage(content, conversationId, channelId, messageId, source) {
  const messageKey = createMessageKey(content, conversationId, channelId);
  
  // Add to sent messages log
  sentMessagesLog.set(messageKey, {
    messageId,
    source,
    timestamp: new Date().toISOString(),
    content: content.substring(0, 100),
    conversationId,
    channelId
  });
  
  // Add to short-term cache
  messageCache.add(messageKey);
  
  console.log(`✅ Tracked message: ${messageId} from ${source}`);
  saveSentMessagesLog();
  saveTrackingState();
}

// Clean message cache every minute and save state
setInterval(() => {
  const sizeBefore = messageCache.cache.size;
  messageCache.cleanup();
  const sizeAfter = messageCache.cache.size;
  if (sizeBefore !== sizeAfter) {
    console.log(`🧹 Cleaned message cache: ${sizeBefore - sizeAfter} entries removed`);
    saveTrackingState();
  }
}, 60 * 1000);

// Store the last checked message IDs for each conversation
const lastCheckedMessageByConversation = new Map();

// Function to process a specific conversation when triggered by webhook
async function processConversation(conversationId) {
  if (isPolling) {
    console.log(`Already polling, will process conversation ${conversationId} in next cycle`);
    return;
  }
  
  // If we're still initializing, don't process any messages yet
  if (isInitializing) {
    console.log(`Still initializing, will process conversation ${conversationId} after initialization`);
    return;
  }
  
  console.log(`\n🔔 TRIGGER RECEIVED for conversation ${conversationId}`);
  
  try {
    // Get conversation details
    const conversationResponse = await hostawayApi.get(`/conversations/${conversationId}`);
    
    if (!conversationResponse.data?.result) {
      console.log(`❌ Could not find conversation ${conversationId}`);
      return;
    }
    
    const conversation = conversationResponse.data.result;
    
    // Get the most recent message for this conversation
    const messagesResponse = await hostawayApi.get(`/conversations/${conversationId}/messages`, {
      params: {
        sortOrder: 'desc',
        sortField: 'createdAt',
        limit: 1 // Only get the latest message
      }
    });
    
    if (!messagesResponse.data?.result || messagesResponse.data.result.length === 0) {
      console.log(`ℹ️ No messages found for conversation ${conversationId}`);
      return;
    }
    
    const message = messagesResponse.data.result[0];
    const messageId = message.id;
    const channelId = message.channelId;
    
    // Check if this is a new message we haven't seen before
    const lastCheckedMessageId = lastCheckedMessageByConversation.get(conversationId);
    
    if (lastCheckedMessageId === messageId) {
      // Silent skip for already processed messages
      return;
    }
    
    // Skip messages sent using Hostaway (these are messages we sent)
    if (message.sentUsingHostaway === 1) {
      // Update the last checked message ID for this conversation silently
      lastCheckedMessageByConversation.set(conversationId, messageId);
      return;
    }
    
    // Create a unique key for this message
    const messageKey = createMessageKey(message.body, conversationId, channelId);
    
    // Skip if already processing
    if (processingMessages.has(messageKey)) {
      return;
    }
    
    processingMessages.add(messageKey);
    
    // Log the new message
    console.log(`\n🔔 NEW MESSAGE DETECTED FROM TRIGGER!`);
    console.log(`Time: ${formatPakistanTime()}`);
    console.log(`Message ID: ${messageId}`);
    console.log(`Conversation ID: ${conversationId}`);
    console.log(`Content: ${message.body}`);
    console.log(`From: ${conversation.recipientName}`);
    console.log(`Channel: ${channelId} (${getChannelName(channelId)})`);
    console.log(`Source: ${MESSAGE_SOURCES.HOSTAWAY}`);
    
    try {
      // Send the message to Chatwoot
      await sendToChatwootWithRetry(message, conversation);
      
      // Track the message
      trackMessage(message.body, conversationId, channelId, messageId, MESSAGE_SOURCES.HOSTAWAY);
      
      // Update the last processed message IDs
      lastProcessedMessageId = messageId;
      lastProcessedMessageIdByChannel[channelId] = messageId;
      
      // Update the last checked message ID for this conversation
      lastCheckedMessageByConversation.set(conversationId, messageId);
      
      // Save tracking state
      saveTrackingState();
      
      console.log(`✅ Successfully forwarded triggered message to Chatwoot`);
    } catch (error) {
      console.error(`❌ Error processing triggered message:`, error.message);
    } finally {
      processingMessages.delete(messageKey);
    }
  } catch (error) {
    console.error(`❌ Error processing conversation ${conversationId}:`, error.message);
  }
}

// Global flag to determine if we're in initialization mode
// isInitializing is already declared above

// VRBO-specific message checking function
async function checkVrboMessages() {
  // Return a promise that resolves or rejects based on the operation
  return new Promise(async (resolve, reject) => {
    if (isVrboPolling) {
      return resolve(); // Already polling, just resolve silently
    }

    isVrboPolling = true;
    
    try {
      // Fetch conversations from all VRBO channels (2002, 2007, 2010)
      // We'll fetch conversations for each VRBO channel ID separately and combine them
      const vrboChannelIds = [2002, 2007, 2010];
      let allVrboConversations = [];
      
      // Get conversations for each VRBO channel ID
      for (const vrboChannelId of vrboChannelIds) {
        try {
          const response = await hostawayApi.get('/conversations', {
            params: {
              sortOrder: 'desc',
              sortField: 'updatedAt',
              limit: 10, // Get 10 conversations per channel
              channelId: vrboChannelId
            }
          });
          
          if (response.data?.result && response.data.result.length > 0) {
            allVrboConversations = [...allVrboConversations, ...response.data.result];
          }
        } catch (error) {
          console.error(`Error fetching VRBO channel ${vrboChannelId} conversations:`, error.message);
        }
      }
      
      // Create a response object similar to what the API would return
      const vrboConversationsResponse = {
        data: {
          result: allVrboConversations
        }
      };
      
      if (!vrboConversationsResponse.data?.result || vrboConversationsResponse.data.result.length === 0) {
        isVrboPolling = false;
        return resolve();
      }
      
      // Silently check VRBO conversations without logging
      
      // Process each VRBO conversation
      for (const conversation of vrboConversationsResponse.data.result) {
        const conversationId = conversation.id;
        
        // Get messages for this VRBO conversation
        const messagesResponse = await hostawayApi.get(`/conversations/${conversationId}/messages`, {
          params: {
            sortOrder: 'desc',
            sortField: 'createdAt',
            limit: 5 // Get several recent messages to ensure we don't miss any
          }
        });
        
        if (!messagesResponse.data?.result || messagesResponse.data.result.length === 0) {
          continue;
        }
        
        // Process each message in this conversation
        for (const message of messagesResponse.data.result) {
          const messageId = message.id;
          const channelId = message.channelId;
          
          // Get the proper channel name for this message
          const channelIdStr = String(channelId);
          const channelName = getChannelName(channelIdStr);
          
          // Always process the message regardless of channel
          // But we'll use the correct channel name in the logs
          
          // If we're initializing, just record the message IDs without processing
          if (isInitializing) {
            lastCheckedMessageByConversation.set(conversationId, messageId);
            lastProcessedMessageIdByChannel[channelId] = messageId;
            continue;
          }
          
          // Check if this is a new message we haven't seen before
          const lastCheckedMessageId = lastCheckedMessageByConversation.get(conversationId);
          
          // Skip if we've already seen this message
          if (lastCheckedMessageId === messageId) {
            continue;
          }
          
          // Skip if this is an old message (created before server start)
          if (!isNewMessage(message)) {
            // Update tracking but don't process
            lastCheckedMessageByConversation.set(conversationId, messageId);
            continue;
          }
          
          // Skip messages sent using Hostaway (these are messages we sent)
          if (message.sentUsingHostaway === 1) {
            // Update the last checked message ID for this conversation
            lastCheckedMessageByConversation.set(conversationId, messageId);
            continue;
          }
          
          // Create a unique key for this message
          const messageKey = createMessageKey(message.body, conversationId, channelId);
          
          // Skip if already processing
          if (processingMessages.has(messageKey)) {
            continue;
          }
          
          processingMessages.add(messageKey);
          
          // Only show the message if it's newer than the most recent one we've seen
          if (!mostRecentMessageId || messageId > mostRecentMessageId) {
            mostRecentMessageId = messageId;
            
            // Log the message with the correct channel name
            console.log(`\n🔔 LATEST MESSAGE FROM ${channelName.toUpperCase()} CHANNEL (ID: ${channelId})`);
            console.log(`Time: ${formatPakistanTime()}`);
            console.log(`Message ID: ${messageId}`);
            console.log(`Content: ${message.body}`);
            console.log(`From: ${conversation.recipientName}`);
          }
          
          try {
            // Send the VRBO message to Chatwoot
            await sendToChatwootWithRetry(message, conversation);
            
            // Track the message
            trackMessage(message.body, conversationId, channelId, messageId, MESSAGE_SOURCES.HOSTAWAY);
            
            // Update the last processed message IDs
            lastProcessedMessageId = messageId;
            lastProcessedMessageIdByChannel[channelId] = messageId;
            
            // Update the last checked message ID for this conversation
            lastCheckedMessageByConversation.set(conversationId, messageId);
            
            // Save tracking state
            saveTrackingState();
            
            console.log(`✅ Successfully forwarded VRBO message to Chatwoot`);
          } catch (error) {
            console.error(`❌ Error processing VRBO message:`, error.message);
          } finally {
            processingMessages.delete(messageKey);
          }
        }
      }
    } catch (error) {
      console.error('❌ Error checking for VRBO messages:', error.message);
      isVrboPolling = false;
      return reject(error);
    } finally {
      isVrboPolling = false;
      resolve();
    }
  });
}
  
// Function to check if a message is new (created after server start)
function isNewMessage(message) {
  // First, check if we've already processed this message ID
  if (processedMessageIds.has(message.id)) {
    return false;
  }
  
  // If message has a createdAt timestamp, use it
  if (message.createdAt) {
    const messageTimestamp = new Date(message.createdAt).getTime();
    return messageTimestamp > serverStartTimestamp;
  }
  
  // If we have a last processed ID for this channel, use that
  const channelId = String(message.channelId);
  if (lastProcessedMessageIdByChannel[channelId] && 
      message.id <= lastProcessedMessageIdByChannel[channelId]) {
    return false;
  }
  
  // If no timestamp, use the message ID as a fallback
  // Higher IDs are newer messages
  return !lastProcessedMessageId || message.id > lastProcessedMessageId;
}

// Function to check for new messages using a trigger-based approach
async function checkNewMessages() {
  // Return a promise that resolves or rejects based on the operation
  return new Promise(async (resolve, reject) => {
    if (isPolling) {
      return resolve(); // Already polling, just resolve silently
    }

    isPolling = true;
    
    try {
      // Fetch all active conversations first
      const conversationsResponse = await hostawayApi.get('/conversations', {
        params: {
          sortOrder: 'desc',
          sortField: 'updatedAt', // Sort by most recently updated
          limit: 10 // Get the 10 most recent conversations
        }
      });
      
      if (!conversationsResponse.data?.result || conversationsResponse.data.result.length === 0) {
        isPolling = false;
        return resolve();
      }
      
      // Process each conversation
      for (const conversation of conversationsResponse.data.result) {
        const conversationId = conversation.id;
        
        // Get the most recent message for this conversation
        const messagesResponse = await hostawayApi.get(`/conversations/${conversationId}/messages`, {
          params: {
            sortOrder: 'desc',
            sortField: 'createdAt',
            limit: 1 // Only get the latest message
          }
        });
        
        if (!messagesResponse.data?.result || messagesResponse.data.result.length === 0) {
          continue;
        }
        
        const message = messagesResponse.data.result[0];
        const messageId = message.id;
        const channelId = message.channelId;
        
        // If we're initializing, just record the message IDs without processing
        if (isInitializing) {
          lastCheckedMessageByConversation.set(conversationId, messageId);
          lastProcessedMessageIdByChannel[channelId] = messageId;
          continue;
        }
        
        // Check if this is a new message we haven't seen before
        const lastCheckedMessageId = lastCheckedMessageByConversation.get(conversationId);
        
        // Skip if we've already seen this message
        if (lastCheckedMessageId === messageId) {
          continue;
        }
        
        // Skip if this is an old message (created before server start)
        if (!isNewMessage(message)) {
          // Update tracking but don't process
          lastCheckedMessageByConversation.set(conversationId, messageId);
          continue;
        }
        
        // Skip messages sent using Hostaway (these are messages we sent)
        if (message.sentUsingHostaway === 1) {
          // Update the last checked message ID for this conversation
          lastCheckedMessageByConversation.set(conversationId, messageId);
          continue;
        }
        
        // Create a unique key for this message
        const messageKey = createMessageKey(message.body, conversationId, channelId);
        
        // Skip if already processing
        if (processingMessages.has(messageKey)) {
          continue;
        }
        
        processingMessages.add(messageKey);
        
        // Get the channel name for better display
        const channelName = getChannelName(channelId);
        
        // Only show the message if it's newer than the most recent one we've seen
        if (!mostRecentMessageId || messageId > mostRecentMessageId) {
          mostRecentMessageId = messageId;
          
          // Log the new message with clear channel identification
          console.log(`\n🔔 LATEST MESSAGE FROM ${channelName.toUpperCase()} CHANNEL (ID: ${channelId})`);
          console.log(`Time: ${formatPakistanTime()}`);
          console.log(`Message ID: ${messageId}`);
          console.log(`Content: ${message.body}`);
          console.log(`From: ${conversation.recipientName}`);
        }
        
        try {
          // Send the message to Chatwoot
          await sendToChatwootWithRetry(message, conversation);
          
          // Track the message
          trackMessage(message.body, conversationId, channelId, messageId, MESSAGE_SOURCES.HOSTAWAY);
          
          // Update the last processed message IDs
          lastProcessedMessageId = messageId;
          lastProcessedMessageIdByChannel[channelId] = messageId;
          
          // Update the last checked message ID for this conversation
          lastCheckedMessageByConversation.set(conversationId, messageId);
          
          // Save tracking state
          saveTrackingState();
          
          console.log(`✅ Successfully forwarded message to Chatwoot`);
        } catch (error) {
          console.error(`❌ Error processing message:`, error.message);
        } finally {
          processingMessages.delete(messageKey);
        }
      }
      
      // After first run, turn off initialization mode
      if (isInitializing) {
        isInitializing = false;
        console.log('✅ Initialization complete. Now only showing new messages.');
        console.log(`🔄 Messages created before ${new Date(serverStartTimestamp).toLocaleString()} will be ignored.`);
      }
      
      isPolling = false;
      return resolve();
    } catch (error) {
      console.error('❌ Error checking for new messages:', error.message);
      isPolling = false;
      return reject(error);
    }
  });
}

// Helper function to get channel name
function getChannelName(channelId) {
  const channels = {
    2018: 'Airbnb',
    2005: 'Booking.com',
    2002: 'Vrbo',
    2013: 'Website/Booking Engine'
  };
  return channels[channelId] || 'Unknown Channel';
}

// Function to send message to Chatwoot
async function sendToChatwoot(message, conversation) {
  // Check if this message originated from Chatwoot
  const messageKey = createMessageKey(message.body, conversation.id, message.channelId);
  if (sentMessagesLog.has(messageKey)) {
    const logEntry = sentMessagesLog.get(messageKey);
    if (logEntry.source === MESSAGE_SOURCES.CHATWOOT) {
      console.log('⏭️ Skipping message that originated from Chatwoot:', {
        content: message.body?.substring(0, 50),
        conversationId: conversation.id,
        channelId: message.channelId
      });
      return; // Don't send back to Chatwoot
    }
  }
  
  // Extract channelId from message or conversation, with fallback to default
  let channelId = message.channelId || conversation.channelId;
  
  // If channelId is still null/undefined, try to determine from other properties
  if (!channelId) {
    // Check if we can determine the channel from the conversation properties
    if (conversation.reservationId) {
      // Try to get the channel from the reservation
      try {
        const reservationResponse = await hostawayApi.get(`/reservations/${conversation.reservationId}`);
        if (reservationResponse.data?.result?.channelId) {
          channelId = reservationResponse.data.result.channelId;
          console.log(`Determined channelId ${channelId} from reservation ${conversation.reservationId}`);
        }
      } catch (error) {
        console.error(`Failed to get reservation details: ${error.message}`);
        // Continue with fallback
      }
    }
    
    // If still no channelId, use a default fallback
    if (!channelId) {
      // Default to Website/Booking Engine (ID 2013) which maps to inbox 10
      channelId = '2013';
      console.log(`Using default channelId ${channelId} (Website/Booking Engine) for conversation ${conversation.id}`);
    }
  }
  
  // Get inbox ID from channel mapping
  let inboxId = CHANNEL_TO_INBOX[channelId];
  
  // If still no mapping, use a default inbox
  if (!inboxId) {
    // Default to inbox 10 (Website/Booking Engine)
    inboxId = 10;
    console.log(`No inbox mapped for channel ${channelId}, using default inbox ${inboxId}`);
  }

  const identifier = `guest_${conversation.id}`;
  let contactId;

  try {
    // STEP 1: Find or create the contact
    console.log(`Looking for contact with Hostaway ID: ${conversation.id}`);
    
    // First check our contact cache to avoid duplicate contacts
    if (contactCache.has(conversation.id)) {
      contactId = contactCache.get(conversation.id);
      console.log(`Using cached contact ID: ${contactId} for Hostaway ID: ${conversation.id}`);
    } else {
      // If not in cache, search in Chatwoot
      const contactsResponse = await chatwootApi.get(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`);
      
      // Extract contacts from response
      let contacts = [];
      if (contactsResponse.data?.payload && Array.isArray(contactsResponse.data.payload)) {
        contacts = contactsResponse.data.payload;
      } else if (Array.isArray(contactsResponse.data)) {
        contacts = contactsResponse.data;
      }
      
      console.log(`Searching through ${contacts.length} contacts for match with Hostaway ID: ${conversation.id}`);
      
      // Look for contact with matching Hostaway ID in custom attributes first (most reliable method)
      let existingContact = contacts.find(contact => 
        contact.custom_attributes?.hostaway_id == conversation.id
      );
      
      // If no match by Hostaway ID, try to find by name as fallback
      if (!existingContact) {
        existingContact = contacts.find(contact => 
          contact.name === conversation.recipientName
        );
        if (existingContact) {
          console.log(`Found contact by name: ${existingContact.name} (ID: ${existingContact.id})`);
        }
      } else {
        console.log(`Found contact by Hostaway ID: ${existingContact.name} (ID: ${existingContact.id})`);
      }

      if (existingContact) {
        contactId = existingContact.id;
        console.log(`Using existing contact: ${existingContact.name} (ID: ${contactId})`);
        
        // Store in cache for future use
        contactCache.set(conversation.id, contactId);
        
        // Update contact's custom attributes to ensure Hostaway ID is set
        if (!existingContact.custom_attributes?.hostaway_id) {
          try {
            await chatwootApi.patch(
              `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}`,
              {
                custom_attributes: {
                  hostaway_id: conversation.id,
                  channel_id: channelId,
                  channel_name: getChannelName(channelId),
                  reservation_id: conversation.reservationId || ''
                }
              }
            );
            console.log(`Updated contact ${contactId} with Hostaway ID ${conversation.id}`);
          } catch (error) {
            console.error(`Error updating contact ${contactId}:`, error.message);
            // Continue even if update fails
          }
        }
      } else {
        // Create new contact without email validation
        try {
          const newContact = await chatwootApi.post(
            `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
            {
              identifier: `guest_${conversation.id}_${Date.now()}`, // Make identifier unique but traceable
              name: conversation.recipientName,
              custom_attributes: {
                hostaway_id: conversation.id,
                channel_id: channelId,
                channel_name: getChannelName(channelId),
                reservation_id: conversation.reservationId || ''
              }
            }
          );
          
          // Extract contact ID from response
          if (newContact.data?.payload?.contact?.id) {
            contactId = newContact.data.payload.contact.id;
          } else if (newContact.data?.contact?.id) {
            contactId = newContact.data.contact.id;
          } else if (newContact.data?.id) {
            contactId = newContact.data.id;
          }
          
          if (contactId) {
            // Store in cache for future use
            contactCache.set(conversation.id, contactId);
            console.log(`Created new contact: ${conversation.recipientName} (ID: ${contactId})`);
          } else {
            console.error('Could not extract contact ID from response:', newContact.data);
            throw new Error('Could not extract contact ID from response');
          }
        } catch (error) {
          console.error('Error creating contact:', error.message);
          throw error;
        }
      }
    }

    // STEP 2: Find existing conversation by Hostaway ID (most reliable method)
    console.log(`PRIORITY 1: Searching for conversation with Hostaway ID: ${conversation.id}`);
    let chatwootConversationId = null;
    let existingConversation = null;
    
    try {
      // Get all conversations in the account
      const allAccountConversations = await chatwootApi.get(
        `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`
      );
      
      console.log('DEBUG - Chatwoot API response type:', typeof allAccountConversations.data);
      console.log('DEBUG - Chatwoot API response structure:', JSON.stringify(allAccountConversations.data).substring(0, 300));
      
      // Extract the payload array from the Chatwoot API response
      // Chatwoot API can return data in different formats depending on version
      let conversations = [];
      
      if (allAccountConversations.data?.payload && Array.isArray(allAccountConversations.data.payload)) {
        // Standard format
        conversations = allAccountConversations.data.payload;
        console.log(`Found ${conversations.length} conversations in standard payload format`);
      } else if (allAccountConversations.data?.conversations && Array.isArray(allAccountConversations.data.conversations)) {
        // Alternative format
        conversations = allAccountConversations.data.conversations;
        console.log(`Found ${conversations.length} conversations in alternative format`);
      } else if (Array.isArray(allAccountConversations.data)) {
        // Direct array format
        conversations = allAccountConversations.data;
        console.log(`Found ${conversations.length} conversations in direct array format`);
      } else {
        console.log('Unable to extract conversations array from response, searching all properties');
        // Last resort: try to find any array in the response
        for (const key in allAccountConversations.data) {
          if (Array.isArray(allAccountConversations.data[key])) {
            conversations = allAccountConversations.data[key];
            console.log(`Found ${conversations.length} conversations in property: ${key}`);
            break;
          }
        }
      }
      
      if (conversations.length > 0) {
        console.log(`Searching through ${conversations.length} total conversations in Chatwoot`);
        
        // PRIORITY 1: Find by Hostaway conversation ID in custom attributes
        for (const conv of conversations) {
          // Custom attributes could be in different locations depending on API version
          const customAttributes = 
            conv.meta?.custom_attributes || 
            conv.custom_attributes || 
            {};
          
          console.log(`Checking conversation ${conv.id}, custom attributes:`, JSON.stringify(customAttributes));
          
          if (customAttributes.hostaway_conversation_id == conversation.id) {
            existingConversation = conv;
            chatwootConversationId = conv.id;
            console.log(`✅ FOUND BY HOSTAWAY ID: Conversation ${conv.id} matches Hostaway ID ${conversation.id}`);
            break;
          }
        }
      }
    } catch (error) {
      console.error('Error searching for conversations by Hostaway ID:', error.message);
      // Continue to next search method even if this one fails
    }
    
    // PRIORITY 2: If not found by Hostaway ID, search by contact ID and inbox ID
    if (!existingConversation && contactId) {
      console.log(`PRIORITY 2: Searching by contact ID ${contactId} and inbox ID ${inboxId}`);
      
      try {
        const contactConversations = await chatwootApi.get(
          `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
          {
            params: {
              inbox_id: inboxId,
              contact_id: contactId
            }
          }
        );
        
        console.log('DEBUG - Contact conversations response type:', typeof contactConversations.data);
        console.log('DEBUG - Contact conversations structure:', JSON.stringify(contactConversations.data).substring(0, 300));
        
        // Extract conversations from the response (handle different API formats)
        let contactConvList = [];
        
        if (contactConversations.data?.payload && Array.isArray(contactConversations.data.payload)) {
          contactConvList = contactConversations.data.payload;
          console.log(`Found ${contactConvList.length} contact conversations in standard payload format`);
        } else if (contactConversations.data?.conversations && Array.isArray(contactConversations.data.conversations)) {
          contactConvList = contactConversations.data.conversations;
          console.log(`Found ${contactConvList.length} contact conversations in alternative format`);
        } else if (Array.isArray(contactConversations.data)) {
          contactConvList = contactConversations.data;
          console.log(`Found ${contactConvList.length} contact conversations in direct array format`);
        } else {
          // Last resort: search for any array in the response
          for (const key in contactConversations.data) {
            if (Array.isArray(contactConversations.data[key])) {
              contactConvList = contactConversations.data[key];
              console.log(`Found ${contactConvList.length} contact conversations in property: ${key}`);
              break;
            }
          }
        }
        
        if (contactConvList.length > 0) {
          console.log(`Processing ${contactConvList.length} conversations for contact ID ${contactId}`);
          
          // First try to find an open conversation
          const openConversation = contactConvList.find(conv => {
            // Status could be in different locations depending on API version
            const status = conv.status || conv.meta?.status;
            return status === 'open';
          });
          
          if (openConversation) {
            existingConversation = openConversation;
            chatwootConversationId = openConversation.id;
            console.log(`✅ FOUND BY CONTACT (OPEN): Using open conversation ${openConversation.id}`);
            
            // Update the conversation with Hostaway ID for future reference
            try {
              await chatwootApi.patch(
                `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${chatwootConversationId}/custom_attributes`,
                {
                  custom_attributes: {
                    hostaway_conversation_id: conversation.id,
                    channel_id: channelId,
                    channel_name: getChannelName(channelId),
                    reservation_id: conversation.reservationId || ''
                  }
                }
              );
              console.log(`Updated open conversation ${chatwootConversationId} with Hostaway ID ${conversation.id}`);
            } catch (updateError) {
              console.error(`Error updating conversation attributes: ${updateError.message}`);
              // Continue even if update fails
            }
          } else {
            // If no open conversation, use the most recent one (first in the list)
            existingConversation = contactConvList[0];
            chatwootConversationId = contactConvList[0].id;
            console.log(`✅ FOUND BY CONTACT: Using most recent conversation ${contactConvList[0].id}`);
            
            // Update the conversation with Hostaway ID for future reference
            try {
              await chatwootApi.patch(
                `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${chatwootConversationId}/custom_attributes`,
                {
                  custom_attributes: {
                    hostaway_conversation_id: conversation.id,
                    channel_id: channelId,
                    channel_name: getChannelName(channelId),
                    reservation_id: conversation.reservationId || ''
                  }
                }
              );
              console.log(`Updated recent conversation ${chatwootConversationId} with Hostaway ID ${conversation.id}`);
            } catch (updateError) {
              console.error(`Error updating conversation attributes: ${updateError.message}`);
              // Continue even if update fails
            }
          }
        } else {
          console.log(`No conversations found for contact ID ${contactId}`);
        }
      } catch (error) {
        console.error('Error searching for conversations by contact ID:', error.message);
        // Continue to next step even if this search fails
      }
    }
    
    // If we found an existing conversation, update its attributes and status
    if (existingConversation) {
      console.log(`Using existing conversation with ID: ${chatwootConversationId}`);
      
      // If conversation is resolved, reopen it
      if (existingConversation.status === 'resolved') {
        console.log(`Conversation ${chatwootConversationId} is resolved, reopening it...`);
        try {
          await chatwootApi.post(
            `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${chatwootConversationId}/toggle_status`
          );
          console.log(`Reopened resolved conversation: ${chatwootConversationId}`);
        } catch (error) {
          console.error(`Error reopening conversation ${chatwootConversationId}:`, error.message);
          // Continue even if reopening fails
        }
      }
      
      // Always update the custom attributes to ensure they're correct
      console.log(`Updating conversation ${chatwootConversationId} with Hostaway ID ${conversation.id}`);
      try {
        await chatwootApi.patch(
          `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${chatwootConversationId}/custom_attributes`,
          {
            custom_attributes: {
              hostaway_conversation_id: conversation.id,
              channel_id: channelId,
              channel_name: getChannelName(channelId),
              reservation_id: conversation.reservationId || ''
            }
          }
        );
        console.log(`Successfully updated custom attributes for conversation ${chatwootConversationId}`);
      } catch (error) {
        console.error(`Error updating custom attributes for conversation ${chatwootConversationId}:`, error.message);
        // Continue even if update fails
      }
    }
    
    // STEP 3: Create new conversation ONLY if absolutely necessary
    if (!chatwootConversationId) {
      // Check if we have a cached conversation for this Hostaway ID
      const cacheKey = `hostaway_${conversation.id}_inbox_${inboxId}`;
      if (conversationCache.has(cacheKey)) {
        chatwootConversationId = conversationCache.get(cacheKey);
        console.log(`✅ USING CACHED CONVERSATION: ${chatwootConversationId} for Hostaway ID ${conversation.id}`);
      } else {
        console.log(`⚠️ WARNING: No existing conversation found, creating a new one as last resort`);
        try {
          // Make one final attempt to find any conversation with this contact in this inbox
          const finalCheck = await chatwootApi.get(
            `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
            {
              params: {
                inbox_id: inboxId
              }
            }
          );
          
          // Extract conversations from response
          let inboxConversations = [];
          if (finalCheck.data?.payload && Array.isArray(finalCheck.data.payload)) {
            inboxConversations = finalCheck.data.payload;
          } else if (Array.isArray(finalCheck.data)) {
            inboxConversations = finalCheck.data;
          }
          
          // Look for any conversation with this contact
          const contactConversation = inboxConversations.find(conv => {
            return conv.meta?.sender?.id === contactId || conv.contact_id === contactId;
          });
          
          if (contactConversation) {
            chatwootConversationId = contactConversation.id;
            console.log(`✅ FOUND CONVERSATION BY CONTACT IN FINAL CHECK: ${chatwootConversationId}`);
            
            // Update the conversation with Hostaway ID
            try {
              await chatwootApi.patch(
                `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${chatwootConversationId}/custom_attributes`,
                {
                  custom_attributes: {
                    hostaway_conversation_id: conversation.id,
                    channel_id: channelId,
                    channel_name: getChannelName(channelId),
                    reservation_id: conversation.reservationId || ''
                  }
                }
              );
              console.log(`Updated conversation ${chatwootConversationId} with Hostaway ID ${conversation.id}`);
              
              // Cache this conversation
              conversationCache.set(cacheKey, chatwootConversationId);
            } catch (error) {
              console.error(`Error updating conversation attributes: ${error.message}`);
              // Continue even if update fails
            }
          } else {
            // Create new conversation as last resort
            const newConversation = await chatwootApi.post(
              `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
              {
                inbox_id: inboxId,
                contact_id: contactId,
                status: 'open',
                custom_attributes: {
                  hostaway_conversation_id: conversation.id,
                  channel_id: channelId,
                  channel_name: getChannelName(channelId),
                  reservation_id: conversation.reservationId || ''
                }
              }
            );
            
            // Extract conversation ID from response (handle different API versions)
            if (newConversation.data?.id) {
              chatwootConversationId = newConversation.data.id;
            } else if (newConversation.data?.conversation?.id) {
              chatwootConversationId = newConversation.data.conversation.id;
            } else if (newConversation.data?.payload?.conversation?.id) {
              chatwootConversationId = newConversation.data.payload.conversation.id;
            } else if (typeof newConversation.data === 'object') {
              // If we can't find it in the expected places, try to find any ID property
              const flattenedData = JSON.stringify(newConversation.data);
              const idMatch = flattenedData.match(/"id":(\d+)/);
              if (idMatch && idMatch[1]) {
                chatwootConversationId = parseInt(idMatch[1], 10);
              }
            }
            
            if (!chatwootConversationId) {
              console.error('Could not extract conversation ID from response:', newConversation.data);
              throw new Error('Could not extract conversation ID from response');
            }
            
            console.log(`Created new conversation with ID: ${chatwootConversationId}`);
            
            // Cache this conversation
            conversationCache.set(cacheKey, chatwootConversationId);
          }
        } catch (error) {
          console.error('Error creating new conversation:', error.message);
          throw error;
        }
      }
    } else {
      // Cache this conversation for future use
      const cacheKey = `hostaway_${conversation.id}_inbox_${inboxId}`;
      conversationCache.set(cacheKey, chatwootConversationId);
    }

    // STEP 4: Send the message to the conversation
    const messageContent = message.body || message.message;
    const cleanContent = messageContent.replace(/<[^>]*>/g, '');

    await chatwootApi.post(
      `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${chatwootConversationId}/messages`,
      {
        content: cleanContent,
        message_type: message.isIncoming === 1 ? 'incoming' : 'outgoing'
      }
    );

    console.log('✅ Message sent successfully to Chatwoot');
    return chatwootConversationId; // Return the conversation ID for reference
  } catch (error) {
    console.error('❌ Error in sendToChatwoot:', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    throw error;
  }
}

// Clean up processing locks periodically
setInterval(() => {
  processingMessages.clear();
  console.log(`🧹 Cleared processing locks`);
}, 5 * 60 * 1000); // Run every 5 minutes

// Function to schedule next poll with adaptive interval
function scheduleNextPoll() {
  setTimeout(() => {
    checkNewMessages()
      .then(() => {
        // Success - gradually reduce interval if we've been successful
        if (POLLING_CONFIG.consecutiveErrors > 0) {
          POLLING_CONFIG.consecutiveErrors = 0;
        }
        
        // Only reduce interval if we've had no errors
        if (POLLING_CONFIG.consecutiveErrors === 0) {
          POLLING_CONFIG.currentInterval = Math.max(
            POLLING_CONFIG.minInterval,
            POLLING_CONFIG.currentInterval * POLLING_CONFIG.successReductionFactor
          );
        }
      })
      .catch(() => {
        // Error - increase interval with backoff
        POLLING_CONFIG.consecutiveErrors++;
        
        if (POLLING_CONFIG.consecutiveErrors >= POLLING_CONFIG.maxConsecutiveErrors) {
          // Too many errors, set to max interval
          POLLING_CONFIG.currentInterval = POLLING_CONFIG.maxInterval;
          console.log(`⚠️ Too many consecutive errors (${POLLING_CONFIG.consecutiveErrors}), setting polling interval to maximum: ${POLLING_CONFIG.currentInterval}ms`);
        } else {
          // Apply backoff factor
          POLLING_CONFIG.currentInterval = Math.min(
            POLLING_CONFIG.maxInterval,
            POLLING_CONFIG.currentInterval * POLLING_CONFIG.backoffFactor
          );
          console.log(`⚠️ Error during polling, increasing interval to: ${POLLING_CONFIG.currentInterval}ms`);
        }
      })
      .finally(() => {
        // Schedule next poll regardless of success/failure
        scheduleNextPoll();
      });
  }, POLLING_CONFIG.currentInterval);
}

// Start adaptive polling
scheduleNextPoll();

// Webhook endpoint for Chatwoot messages
app.post('/api/webhooks/chatwoot', async (req, res) => {
  const startTime = Date.now();
  
  console.log('\n🔥 INCOMING WEBHOOK FROM:', req.get('host'));
  console.log('📍 ENDPOINT: /api/webhooks/chatwoot');
  
  try {
    const { 
      event,
      conversation,
      id: messageId,
      content,
      message_type,
      private: isPrivate,
      sender,
      inbox
    } = req.body;

    console.log('\n🔎 MESSAGE ANALYSIS:', {
      event,
      messageId,
      content: content?.substring(0, 50),
      type: message_type,
      isPrivate,
      sender: sender?.type,
      inboxId: inbox?.id,
      source: MESSAGE_SOURCES.CHATWOOT
    });

    if (event !== 'message_created') {
      return res.status(200).json({ status: 'skipped', reason: 'Not a message creation event' });
    }

    if (isPrivate) {
      return res.status(200).json({ status: 'skipped', reason: 'Private message' });
    }

    if (!ALLOWED_INBOXES.has(inbox?.id)) {
      console.log(`⏭️ Skipping message from unallowed inbox: ${inbox?.id}`);
      return res.status(200).json({ status: 'skipped', reason: 'Inbox not allowed' });
    }

    // Check if this is a user-generated message or an echo from Hostaway
    if (sender?.type !== 'user' || message_type === 'incoming') {
      console.log('⏭️ Skipping non-user message or incoming message from Hostaway');
      return res.status(200).json({ status: 'skipped', reason: 'Not a user-generated message' });
    }

    const hostawayConversationId = conversation?.custom_attributes?.hostaway_conversation_id;
    if (!hostawayConversationId) {
      console.log('❌ No Hostaway conversation ID found');
      return res.status(400).json({ status: 'error', reason: 'No Hostaway conversation ID' });
    }

    const channelId = getHostawayChannelId(inbox?.id);
    if (!channelId) {
      console.log(`❌ No Hostaway channel ID mapped for inbox: ${inbox?.id}`);
      return res.status(400).json({ status: 'error', reason: 'No channel ID mapped' });
    }

    const messageKey = createMessageKey(content, hostawayConversationId, channelId);
    
    // Check if this message is a duplicate (already sent)
    if (isAlreadySent(content, hostawayConversationId, channelId)) {
      return res.status(200).json({ status: 'skipped', reason: 'Message already sent' });
    }
    
    // Only add to cache after confirming it's not a duplicate
    messageCache.add(messageKey);

    if (processingMessages.has(messageKey)) {
      console.log('⏭️ Skipping message in processing:', messageId);
      return res.status(200).json({ status: 'skipped', reason: 'Message in processing' });
    }

    processingMessages.add(messageKey);

    try {
      await sendToHostawayWithRetry(hostawayConversationId, content);
      trackMessage(content, hostawayConversationId, channelId, messageId, MESSAGE_SOURCES.CHATWOOT);
      console.log('✅ Message sent to Hostaway successfully');
      return res.status(200).json({ 
        status: 'success',
        message: 'Message sent to Hostaway'
      });
    } finally {
      processingMessages.delete(messageKey);
    }

  } catch (error) {
    console.error('❌ Webhook processing error:', error.stack);
    return res.status(500).json({ 
      status: 'error',
      reason: 'Internal server error'
    });
  } finally {
    console.log('🔥 Webhook processing complete\n');
  }
});

// Chatwoot Configuration was moved to the top of the file

// Function to format time in Pakistan timezone
function formatPakistanTime() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Karachi',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }) + ' PKT';
}

// We'll define the chatwootApi after defining the createApiWithRetry function

// Rate limiting code and API creation functions were moved to the top of the file

// Hostaway API instance was created at the top of the file

// Chatwoot API instance was created at the top of the file

// Webhook endpoint for Hostway messages
app.post('/api/hostway/webhook', async (req, res) => {
  const startTime = Date.now();
  
  console.log('\n🔥 INCOMING WEBHOOK FROM CHANNEL:', req.get('host'));
  console.log('📍 ENDPOINT: /api/hostway/webhook');
  
  // Enhanced logging for debugging channel messages
  console.log('📦 REQUEST BODY:', JSON.stringify(req.body, null, 2));
  console.log('📦 REQUEST HEADERS:', JSON.stringify(req.headers, null, 2));
  
  // Log to a special file for easier debugging
  fs.appendFileSync(
    'channel_webhook_debug.log', 
    `[${new Date().toLocaleString()}] Received webhook request\n` +
    `Headers: ${JSON.stringify(req.headers, null, 2)}\n` +
    `Body: ${JSON.stringify(req.body, null, 2)}\n\n`,
    'utf8'
  );
  
  try {
    // Universal message extraction from any format
    let message, conversationId, channelId, senderId, senderName;
    
    // STEP 1: Extract the message content
    if (req.body.message) {
      // Direct message field
      message = req.body.message;
    } else if (req.body.data?.message) {
      // Nested message field
      message = req.body.data.message;
    } else if (req.body.content) {
      // Content field alternative
      message = req.body.content;
    } else if (req.body.text) {
      // Text field alternative
      message = req.body.text;
    } else if (req.body.body) {
      // Body field alternative
      message = req.body.body;
    } else {
      // Deep search for any string that could be a message
      console.log('⚠️ No standard message field found, searching deeply...');
      
      const findStringInObject = (obj, depth = 0, maxDepth = 2) => {
        if (depth > maxDepth) return null;
        
        // Check direct string properties first
        for (const key of Object.keys(obj)) {
          if (typeof obj[key] === 'string' && obj[key].length > 5) {
            console.log(`Found potential message in field '${key}': ${obj[key].substring(0, 30)}...`);
            return obj[key];
          }
        }
        
        // Then check nested objects
        for (const key of Object.keys(obj)) {
          if (obj[key] && typeof obj[key] === 'object') {
            const result = findStringInObject(obj[key], depth + 1, maxDepth);
            if (result) return result;
          }
        }
        
        return null;
      };
      
      message = findStringInObject(req.body);
    }
    
    // STEP 2: Extract conversation ID
    conversationId = req.body.conversationId || 
                     req.body.data?.conversationId || 
                     req.body.id || 
                     req.body.conversation_id || 
                     req.body.threadId || 
                     `channel-${Date.now()}`;
    
    // STEP 3: Extract sender information
    senderId = req.body.senderId || 
               req.body.data?.senderId || 
               req.body.sender || 
               req.body.from || 
               'guest';
               
    senderName = req.body.senderName || 
                 req.body.data?.senderName || 
                 req.body.name || 
                 req.body.sender_name || 
                 req.body.guest || 
                 'Channel Guest';
    
    // STEP 4: Detect channel type using our smart detection function
    channelId = detectChannelType(req.body);
    
    // Final check if we could extract a message
    if (!message) {
      console.log('❌ Could not extract message from payload');
      return res.status(200).json({ // Return 200 to avoid retries, but log the issue
        status: 'error', 
        reason: 'Could not extract message from payload' 
      });
    }
    
    // Get the channel name for better logging
    const channelName = Object.entries(CHANNEL_TYPES).find(([name, id]) => id === channelId)?.[0] || 'UNKNOWN';
    
    console.log('\n🔎 CHANNEL MESSAGE ANALYSIS:', {
      conversationId,
      channelId,
      channelName,
      message: message?.substring(0, 50) + (message?.length > 50 ? '...' : ''),
      senderId,
      senderName,
      source: MESSAGE_SOURCES.HOSTAWAY
    });
    
    const messageKey = createMessageKey(message, conversationId, channelId);
    
    // Check if this message has already been processed to avoid duplicates
    if (isAlreadySent(message, conversationId, channelId)) {
      console.log('⏭️ Skipping message: already processed');
      return res.status(200).json({ status: 'skipped', reason: 'Message already processed' });
    }
    
    if (processingMessages.has(messageKey)) {
      console.log('⏭️ Skipping message: currently processing');
      return res.status(200).json({ status: 'skipped', reason: 'Message in processing' });
    }
    
    processingMessages.add(messageKey);
    
    try {
      // Create conversation object expected by sendToChatwoot
      const conversation = {
        id: conversationId,
        recipientName: senderName || 'Guest',
        channelId: channelId,
        // Add additional properties that might be useful
        reservationId: req.body.reservationId || req.body.data?.reservationId,
        listingId: req.body.listingId || req.body.data?.listingId
      };
      
      // Create a comprehensive message object with all possible properties
      // that might be needed by different parts of the code
      const messageForChatwoot = {
        // Core properties
        id: `msg-${Date.now()}`,
        content: message,
        body: message,
        channelId: channelId,
        
        // Additional metadata
        senderId: senderId,
        senderName: senderName,
        timestamp: new Date().toISOString(),
        conversationId: conversationId,
        
        // Source tracking
        source: channelName,
        platform: channelName,
        
        // For compatibility with different code paths
        isFromGuest: true,
        isIncoming: 1
      };
      
      // Send message to Chatwoot
      await sendToChatwootWithRetry(messageForChatwoot, conversation);
      
      // Track the message to prevent duplicates
      trackMessage(message, conversationId, channelId, null, MESSAGE_SOURCES.HOSTAWAY);
      
      console.log(`✅ Message from ${channelName} sent to Chatwoot successfully`);
      return res.status(200).json({ 
        status: 'success',
        message: `Message from ${channelName} sent to Chatwoot`,
        channelId: channelId,
        channelName: channelName
      });
    } finally {
      processingMessages.delete(messageKey);
    }
  } catch (error) {
    console.error('❌ Hostway webhook processing error:', error.stack);
    return res.status(500).json({ 
      status: 'error',
      reason: 'Internal server error'
    });
  } finally {
    console.log(`🔥 Hostway webhook processing complete (${Date.now() - startTime}ms)\n`);
    
    // Log to hostaway_webhook.log
    fs.appendFileSync(
      'hostaway_webhook.log', 
      `[${new Date().toLocaleString()}] Received Hostaway webhook request (hostway path)\n` +
      `Request Body: ${JSON.stringify(req.body, null, 2)}\n\n`,
      'utf8'
    );
  }
});

// Catch-all route handler
app.use('*', (req, res) => {
  res.json({ status: 'Server is running and monitoring messages' });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason.stack);
});

// Server is already started above with port fallback mechanism
