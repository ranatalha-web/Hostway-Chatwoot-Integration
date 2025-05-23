const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 8080;

// Configuration files
const LAST_TIMESTAMP_FILE = 'last_timestamp.json';
const MESSAGE_CACHE_FILE = 'message_cache.json';
const PROCESSED_IDS_FILE = 'processed_ids.json';
const CONVERSATION_CACHE_FILE = 'conversation_cache.json';
const SENT_MESSAGES_LOG_FILE = 'sent_messages_log.json';
const LAST_PROCESSED_ID_FILE = 'last_processed_id.json';

// Define allowed inboxes
const ALLOWED_INBOXES = new Set([5, 6, 8, 10]); // Airbnb, Booking.com, Vrbo, Website inboxes

// Message tracking state
let lastMessageTimestamp;
let processedMessageIds = new Set();
let conversationCache = new Map();
let sentMessagesLog = new Map();
let lastProcessedMessageId = null;
const processingMessages = new Set();

// Track message sources to prevent echo
const MESSAGE_SOURCES = {
  CHATWOOT: 'chatwoot',
  HOSTAWAY: 'hostaway'
};

// Message retention period
const MESSAGE_RETENTION_HOURS = 24; // For messageCache

// Message cache with TTL
class MessageCache {
  constructor(ttlMs = 15 * 1000) { // 15 seconds TTL for duplicate detection
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
let isPolling = false;
const POLL_INTERVAL = 2000; // 2 seconds

// Rate limiting configuration
const rateLimiter = {
  lastRequestTime: 0,
  minInterval: 10000, // 10 seconds between requests
  consecutiveErrors: 0,
  backoffFactor: 2,
  maxBackoffTime: 120000, // 2 minutes max
  lastLogTime: 0, // Track when we last showed a rate limit message
  
  // Get the current wait time based on consecutive errors
  getWaitTime() {
    if (this.consecutiveErrors === 0) {
      return this.minInterval;
    }
    
    // Exponential backoff
    const backoffTime = Math.min(
      this.minInterval * Math.pow(this.backoffFactor, this.consecutiveErrors - 1),
      this.maxBackoffTime
    );
    
    return backoffTime;
  },
  
  // Reset error counter
  resetErrors() {
    this.consecutiveErrors = 0;
  },
  
  // Increment error counter
  incrementErrors() {
    this.consecutiveErrors++;
  },
  
  // Check if we should wait before making another request
  shouldWait() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const waitTime = this.getWaitTime();
    
    return timeSinceLastRequest < waitTime;
  },
  
  // Update the last request time
  updateLastRequestTime() {
    this.lastRequestTime = Date.now();
  },
  
  // Get time to wait in ms
  getTimeToWait() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const waitTime = this.getWaitTime();
    
    return Math.max(0, waitTime - timeSinceLastRequest);
  }
}

// Create a custom logger to control console output
const logger = {
  // Store original console methods
  originalConsole: {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info
  },
  
  // Flag to control whether logs are shown
  showLogs: false,
  
  // Custom log methods
  log: function(...args) {
    if (this.showLogs) {
      this.originalConsole.log(...args);
    }
  },
  
  error: function(...args) {
    // Always show errors
    this.originalConsole.error(...args);
  },
  
  warn: function(...args) {
    if (this.showLogs) {
      this.originalConsole.warn(...args);
    }
  },
  
  info: function(...args) {
    if (this.showLogs) {
      this.originalConsole.info(...args);
    }
  },
  
  // Enable logging
  enableLogs: function() {
    this.showLogs = true;
  },
  
  // Disable logging
  disableLogs: function() {
    this.showLogs = false;
  },
  
  // Suppress logs without using console.clear
  suppressLogs: function() {
    // Instead of clearing console, we just disable logs
    this.disableLogs();
  }
};

// Override console methods
console.log = (...args) => logger.log(...args);
console.error = (...args) => logger.error(...args);
console.warn = (...args) => logger.warn(...args);
console.info = (...args) => logger.info(...args);

// Initialize or load tracking state
try {
  if (fs.existsSync(LAST_TIMESTAMP_FILE)) {
    lastMessageTimestamp = JSON.parse(fs.readFileSync(LAST_TIMESTAMP_FILE, 'utf8')).timestamp;
  } else {
    lastMessageTimestamp = Date.now() - (5 * 60 * 1000); // Start from 5 minutes ago
    fs.writeFileSync(LAST_TIMESTAMP_FILE, JSON.stringify({ timestamp: lastMessageTimestamp }));
  }

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
    fs.writeFileSync(LAST_TIMESTAMP_FILE, JSON.stringify({ timestamp: lastMessageTimestamp }));
    fs.writeFileSync(MESSAGE_CACHE_FILE, JSON.stringify(messageCache.toJSON()));
    fs.writeFileSync(PROCESSED_IDS_FILE, JSON.stringify([...processedMessageIds]));
    fs.writeFileSync(CONVERSATION_CACHE_FILE, JSON.stringify(Object.fromEntries(conversationCache)));
    fs.writeFileSync(LAST_PROCESSED_ID_FILE, JSON.stringify({ id: lastProcessedMessageId }));
  } catch (error) {
    console.error('Error saving tracking state:', error.stack);
  }
}

// Save sent messages log
function saveSentMessagesLog() {
  try {
    fs.writeFileSync(SENT_MESSAGES_LOG_FILE, JSON.stringify(Object.fromEntries(sentMessagesLog), null, 2));
    console.log(`✅ Saved sent messages log with ${sentMessagesLog.size} entries`);
  } catch (error) {
    console.error('Error saving sent messages log:', error.stack);
  }
}

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
      console.log(`🚀 CHATWOOT API CALL - Attempt ${attempt}/${maxRetries}:`, {
        conversationId: conversation.id,
        content: message.body.substring(0, 100) + (message.body.length > 100 ? '...' : ''),
        timestamp: new Date().toISOString()
      });

      await sendToChatwoot(message, conversation);
      
      console.log(`✅ CHATWOOT SUCCESS - Attempt ${attempt}: Message ${message.id} sent successfully`);
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
    8: 2010,  // Vrbo
    10: 2013  // Website/Booking Engine
  };
  return inboxToChannel[inboxId];
}

// Enhanced duplicate check function
function isDuplicateMessage(content, conversationId, channelId) {
  const messageKey = createMessageKey(content, conversationId, channelId);
  
  // Check in messageCache first (short-term memory - 15 seconds)
  if (messageCache.has(messageKey)) {
    const timestamp = messageCache.cache.get(messageKey);
    const secondsAgo = Math.round((Date.now() - timestamp) / 1000);
    
    // Only consider it a duplicate if it's within 15 seconds
    if (secondsAgo <= 15) {
      console.log(`⏭️ Skipping duplicate message sent ${secondsAgo} seconds ago:`, {
        content: content.substring(0, 50),
        conversationId,
        channelId
      });
      return true;
    }
    // If it's more than 15 seconds old, it's not considered a duplicate
    // but we'll update the timestamp for this message
    messageCache.add(messageKey);
    return false;
  }

  // Not in cache, so it's not a duplicate
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
    // Don't log cache cleaning to keep console clean
    saveTrackingState();
  }
}, 60 * 1000);

// Function to check for new messages
async function checkNewMessages() {
  if (isPolling) {
    return;
  }
  
  // Check if we need to wait due to rate limiting
  if (rateLimiter.shouldWait()) {
    const timeToWait = rateLimiter.getTimeToWait();
    
    // Only log rate limiting messages occasionally (once every 30 seconds)
    const now = Date.now();
    if (now - rateLimiter.lastLogTime > 30000) {
      logger.enableLogs();
      console.log(`⏳ Rate limiting active: API calls limited to prevent 429 errors. Current interval: ${Math.round(rateLimiter.getWaitTime()/1000)} seconds`);
      logger.suppressLogs();
      rateLimiter.lastLogTime = now;
    }
    return;
  }

  isPolling = true;
  // Suppress logs until new messages arrive
  logger.suppressLogs();

  try {
    // Update the last request time
    rateLimiter.updateLastRequestTime();
    const conversationsResponse = await hostawayApi.get('/conversations', {
      params: {
        sortOrder: 'desc',
        sortField: 'createdAt',
        limit: 1
      }
    });

    if (!conversationsResponse.data?.result?.[0]) {
      isPolling = false;
      return;
    }

    const conversation = conversationsResponse.data.result[0];

    const messagesResponse = await hostawayApi.get(`/conversations/${conversation.id}/messages`, {
      params: {
        sortOrder: 'desc',
        sortField: 'createdAt',
        limit: 1
      }
    });

    if (!messagesResponse.data?.result?.[0]) {
      isPolling = false;
      return;
    }

    const message = messagesResponse.data.result[0];

    // Skip if this is the same message we just processed
    if (message.id === lastProcessedMessageId) {
      isPolling = false;
      return;
    }

    // Skip messages sent using Hostaway
    if (message.sentUsingHostaway === 1) {
      // Don't log skipped messages to keep console clean
      lastProcessedMessageId = message.id;
      saveTrackingState();
      isPolling = false;
      return;
    }

    // Enhanced duplicate check
    if (isDuplicateMessage(message.body, conversation.id, message.channelId)) {
      // Don't log skipped duplicate messages to keep console clean
      lastProcessedMessageId = message.id;
      saveTrackingState();
      isPolling = false;
      return;
    }

    const messageKey = createMessageKey(message.body, conversation.id, message.channelId);
    if (processingMessages.has(messageKey)) {
      // Don't log currently processing messages to keep console clean
      isPolling = false;
      return;
    }

    processingMessages.add(messageKey);
    
    // Enable logs for new messages
    logger.enableLogs();
    
    console.log(`\n=== Processing New Message ===`);
    console.log(`Time: ${formatPakistanTime()}`);
    console.log(`Message ID: ${message.id}`);
    console.log(`Conversation ID: ${conversation.id}`);
    console.log(`Content: ${message.body}`);
    console.log(`From: ${conversation.recipientName}`);
    console.log(`Channel: ${message.channelId}`);
    console.log(`Source: ${MESSAGE_SOURCES.HOSTAWAY}`);
    console.log('===========================\n');

    try {
      await sendToChatwootWithRetry(message, conversation);
      trackMessage(message.body, conversation.id, message.channelId, message.id, MESSAGE_SOURCES.HOSTAWAY);
      lastProcessedMessageId = message.id;
      saveTrackingState();
    } finally {
      processingMessages.delete(messageKey);
    }

  } catch (error) {
    console.error(`\n❌ Error checking for new messages (${formatPakistanTime()}):`, error.stack);
    
    // Handle rate limiting errors
    if (error.response && error.response.status === 429) {
      rateLimiter.incrementErrors();
      const backoffTime = rateLimiter.getWaitTime();
      
      // Only log once per rate limit adjustment
      logger.enableLogs();
      console.log(`\n⚠️ Rate limit exceeded. Increasing interval to ${Math.round(backoffTime/1000)} seconds between requests.`);
      logger.suppressLogs();
      rateLimiter.lastLogTime = Date.now();
      
      // If we've had multiple consecutive errors, increase the polling interval
      if (rateLimiter.consecutiveErrors > 3) {
        const newInterval = Math.min(POLL_INTERVAL * 2, 10000); // Max 10 seconds
        if (POLL_INTERVAL !== newInterval) {
          POLL_INTERVAL = newInterval;
          logger.enableLogs();
          console.log(`\n⚙️ Adjusted polling interval to ${POLL_INTERVAL/1000} seconds to reduce API load`);
          logger.suppressLogs();
        }
      }
    } else {
      // If it's not a rate limit error, reset the consecutive error counter
      rateLimiter.resetErrors();
    }
  } finally {
    // Disable logs after processing is complete
    logger.disableLogs();
    isPolling = false;
  }
}

// Helper function to get channel name
function getChannelName(channelId) {
  const channels = {
    2018: 'Airbnb',
    2005: 'Booking.com',
    2010: 'Vrbo',
    2013: 'Website/Booking Engine'
  };
  return channels[channelId] || 'Unknown Channel';
}

// Function to send message to Chatwoot
async function sendToChatwoot(message, conversation) {
  const channelId = message.channelId;
  const inboxId = CHANNEL_TO_INBOX[channelId];
  
  if (!inboxId) {
    throw new Error(`No inbox mapped for channel ${channelId}`);
  }

  const identifier = `guest_${conversation.id}`;
  let contactId;

  try {
    // First try to find the contact by exact name
    const contactsResponse = await chatwootApi.get(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`);
    
    let existingContact = contactsResponse.data?.payload?.find(contact => 
      contact.name === conversation.recipientName
    );

    if (existingContact) {
      contactId = existingContact.id;
      console.log(`Using existing contact: ${existingContact.name} (ID: ${contactId})`);
    } else {
      // Create new contact without email validation
      const newContact = await chatwootApi.post(
        `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
        {
          identifier: `${identifier}_${Date.now()}`, // Make identifier unique
          name: conversation.recipientName,
          custom_attributes: {
            hostaway_id: conversation.id,
            channel_id: channelId,
            channel_name: getChannelName(channelId),
            reservation_id: conversation.reservationId || ''
          }
        }
      );
      contactId = newContact.data.payload.contact.id;
      console.log(`Created new contact: ${conversation.recipientName} (ID: ${contactId})`);
    }

    // First check if we have a cached conversation for this Hostaway ID
    let chatwootConversationId = null;
    
    // Check if we have a cached conversation mapping for this Hostaway conversation
    if (conversationCache.has(conversation.id.toString())) {
      chatwootConversationId = conversationCache.get(conversation.id.toString());
      console.log(`Found cached conversation mapping: Hostaway ${conversation.id} -> Chatwoot ${chatwootConversationId}`);
      
      // Verify the conversation still exists
      try {
        const conversationCheck = await chatwootApi.get(
          `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${chatwootConversationId}`
        );
        console.log(`Using existing conversation: ${chatwootConversationId}`);
      } catch (error) {
        console.log(`Cached conversation ${chatwootConversationId} not found, will look for another one`);
        chatwootConversationId = null;
      }
    }
    
    // If no cached conversation, try to find an existing one
    if (!chatwootConversationId) {
      // Look for any conversations with this contact (open or resolved)
      const allConversations = await chatwootApi.get(
        `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
        {
          params: {
            inbox_id: inboxId,
            contact_id: contactId
          }
        }
      );
      
      if (allConversations.data?.payload?.length > 0) {
        // Use the most recent conversation
        chatwootConversationId = allConversations.data.payload[0].id;
        console.log(`Using existing conversation: ${chatwootConversationId}`);
        
        // Cache this mapping
        conversationCache.set(conversation.id.toString(), chatwootConversationId);
        saveTrackingState();
      } else {
        // Create a new conversation only if no existing ones found
        const newConversation = await chatwootApi.post(
          `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
          {
            inbox_id: inboxId,
            contact_id: contactId,
            status: 'open',
            custom_attributes: {
              hostaway_conversation_id: conversation.id
            }
          }
        );
        chatwootConversationId = newConversation.data.id;
        console.log(`Created new conversation: ${chatwootConversationId}`);
        
        // Cache this mapping
        conversationCache.set(conversation.id.toString(), chatwootConversationId);
        saveTrackingState();
      }
    }

    // Send the message
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

// Start monitoring
function startMonitoring() {
  console.log('=== Hostaway-Chatwoot Integration ===');
  console.log(`Started at: ${formatPakistanTime()}`);
  console.log(`Server running on port: ${PORT}`);
  console.log(`Initial polling interval: ${POLL_INTERVAL}ms`);
  console.log(`Rate limiting: ${rateLimiter.minInterval/1000} seconds between API calls`);
  console.log('🔍 Enhanced with adaptive rate limiting');
  console.log('===================================\n');
  
  // Use a more reliable approach for periodic checking
  function scheduleNextCheck() {
    setTimeout(() => {
      checkNewMessages().finally(() => {
        scheduleNextCheck();
      });
    }, POLL_INTERVAL);
  }
  
  // Start the first check
  scheduleNextCheck();
}

// Start server
app.listen(PORT, startMonitoring);

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

    if (sender?.type !== 'user') {
      console.log('⏭️ Skipping non-user message');
      return res.status(200).json({ status: 'skipped', reason: 'Not from a user' });
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

    if (isAlreadySent(content, hostawayConversationId, channelId)) {
      return res.status(200).json({ status: 'skipped', reason: 'Message already sent' });
    }

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

// Chatwoot Configuration
const CHATWOOT_API_URL = 'http://137.184.34.26:8081';
const CHATWOOT_API_TOKEN = 'ataY1rmRUCVE2VRJD298XVU6';
const CHATWOOT_ACCOUNT_ID = 1;

// Mapping of Hostaway channels to Chatwoot inbox IDs
const CHANNEL_TO_INBOX = {
  2018: 5,  // Airbnb -> Inbox 5
  2005: 6,  // Booking.com -> Inbox 6
  2010: 8,  // Vrbo -> Inbox 8
  2013: 10  // Website/Booking Engine -> Inbox 10
};

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

// Chatwoot API instance
const chatwootApi = axios.create({
  baseURL: CHATWOOT_API_URL,
  headers: {
    'api_access_token': CHATWOOT_API_TOKEN,
    'Content-Type': 'application/json'
  }
});

// Hostaway API instance
const hostawayApi = axios.create({
  baseURL: 'https://api.hostaway.com/v1',
  headers: {
    'Authorization': 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI4MDA2NiIsImp0aSI6ImM5MDQ4NTgzNTBhYWNiOTdiMzBkNDAxMjczMDBjYTkyZmE1Njg0ZTU0MzJiMjMyNWM2YTIzYmVkMTQ5ZGE4YTQyNjUwMzgwMWY0YmI0YmNlIiwiaWF0IjoxNzM3OTc5NDcwLjk3NzYxMiwibmJmIjoxNzM3OTc5NDcwLjk3NzYxNCwiZXhwIjoyMDUzNTEyMjcwLjk3NzYxOCwic3ViIjoiIiwic2NvcGVzIjpbImdlbmVyYWwiXSwic2VjcmV0SWQiOjUzMDQzfQ.ItaGLJwySFtroyXsLdS_zMIeEDPivN-MjjHPxOvCjoHvFqAHuX4HBX-HCjAp-5f2gKLilxPsRcdYRkDvViILKr73qyo6nSnNPokYj3JUYXsuBLoKMejzwuvYMn_DQc2HbbdDAmV_iREKMfiPyJu2vJjRSKI5xc033CGFm5Tng-c',
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

// Catch-all route handler
app.use('*', (req, res) => {
  res.json({ status: 'Server is running and monitoring messages' });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason.stack);
});
