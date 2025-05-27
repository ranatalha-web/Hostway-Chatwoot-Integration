// Serverless-friendly version of server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const config = require(path.join(__dirname, 'config.js'));

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 8080;

// Chatwoot Configuration from config.js
const CHATWOOT_API_URL = config.CHATWOOT_CONFIG.apiUrl;
const CHATWOOT_API_TOKEN = config.CHATWOOT_CONFIG.apiToken;
const CHATWOOT_ACCOUNT_ID = parseInt(config.CHATWOOT_CONFIG.accountId, 10);

// Mapping of Hostaway channels to Chatwoot inbox IDs from config.js
const CHANNEL_TO_INBOX = config.CHANNEL_TO_INBOX;

// Define allowed inboxes
const ALLOWED_INBOXES = new Set([5, 6, 8, 10]); // Airbnb, Booking.com, Vrbo, Website inboxes
// Explicitly exclude inbox 2 (already not in the set above)

// In-memory caches (will reset on function restart, but better than nothing)
const messageCache = new Set();
const sentMessagesLog = new Map();
const processingMessages = new Set();
const contactCache = new Map();
const conversationCache = new Map();

// Message sources for tracking
const MESSAGE_SOURCES = {
  HOSTAWAY: 'hostaway',
  CHATWOOT: 'chatwoot'
};

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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper functions
function formatPakistanTime() {
  return new Date().toLocaleString('en-US', { 
    timeZone: 'Asia/Karachi',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }) + ' PKT';
}

// Get channel name from ID
function getChannelName(channelIdStr) {
  switch (channelIdStr) {
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

// Get Hostaway channel ID from Chatwoot inbox ID
function getHostawayChannelId(inboxId) {
  // Reverse lookup from inbox to channel
  for (const [channelId, mappedInboxId] of Object.entries(CHANNEL_TO_INBOX)) {
    if (mappedInboxId === inboxId) {
      return channelId;
    }
  }
  
  // Default to Website/Booking Engine if no mapping found
  return '2013';
}

// Create a unique key for message deduplication
function createMessageKey(content, conversationId, channelId) {
  return `${conversationId}:${channelId}:${content}`.substring(0, 100);
}

// Track a sent message
function trackMessage(content, conversationId, channelId, messageId, source) {
  const messageKey = createMessageKey(content, conversationId, channelId);
  
  // Add to message cache for short-term deduplication
  messageCache.add(messageKey);
  
  // Add to sent messages log for longer-term tracking
  sentMessagesLog.set(messageKey, {
    content,
    conversationId,
    channelId,
    messageId,
    source,
    timestamp: new Date().toISOString()
  });
  
  console.log(`✅ Tracked message: ${messageId} from ${source}`);
}

// Check if message was already sent
function isAlreadySent(content, conversationId, channelId) {
  return isDuplicateMessage(content, conversationId, channelId);
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

  // Check in sentMessagesLog (long-term memory) - only if within 60 seconds (1 minute)
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
    // Default to Website/Booking Engine (ID 2013) which maps to inbox 10
    channelId = '2013';
    console.log(`Using default channelId ${channelId} (Website/Booking Engine) for conversation ${conversation.id}`);
  }
  
  // Get inbox ID from channel mapping
  let inboxId = CHANNEL_TO_INBOX[channelId];
  
  // If still no mapping, use a default inbox
  if (!inboxId) {
    // Default to inbox 10 (Website/Booking Engine)
    inboxId = 10;
    console.log(`No inbox mapped for channel ${channelId}, using default inbox ${inboxId}`);
  }

  // Create a unique identifier for this guest
  const identifier = `guest_${conversation.id}_${Date.now()}`;
  
  try {
    // Check if we have a cached conversation
    if (conversationCache.has(conversation.id)) {
      const conversationId = conversationCache.get(conversation.id);
      console.log(`✅ USING CACHED CONVERSATION: ${conversationId} for Hostaway ID ${conversation.id}`);
      
      // Send message to existing conversation
      const response = await chatwootApi.post(
        `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
        {
          content: message.body || message.content || message,
          message_type: 'incoming',
          private: false
        }
      );
      
      console.log('✅ Message sent successfully to Chatwoot');
      return response;
    } else {
      // For simplicity in serverless, create a new conversation each time
      // In a production environment, you would implement proper contact/conversation lookup
      
      // Create a new contact
      const contactResponse = await chatwootApi.post(
        `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
        {
          identifier: identifier,
          name: conversation.recipientName || 'Guest',
          custom_attributes: {
            hostaway_id: conversation.id,
            channel_id: channelId,
            channel_name: getChannelName(channelId)
          }
        }
      );
      
      const contactId = contactResponse.data.payload.contact.id;
      console.log(`Created new contact: ${contactResponse.data.payload.contact.name} (ID: ${contactId})`);
      
      // Create a new conversation
      const newConversationResponse = await chatwootApi.post(
        `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
        {
          source_id: contactId,
          inbox_id: inboxId,
          status: 'open',
          contact_id: contactId,
          custom_attributes: {
            hostaway_conversation_id: conversation.id
          }
        }
      );
      
      const newConversationId = newConversationResponse.data.id;
      console.log(`Created new conversation: ${newConversationId}`);
      
      // Cache the conversation for future use
      conversationCache.set(conversation.id, newConversationId);
      
      // Send message to the new conversation
      const messageResponse = await chatwootApi.post(
        `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${newConversationId}/messages`,
        {
          content: message.body || message.content || message,
          message_type: 'incoming',
          private: false
        }
      );
      
      console.log('✅ Message sent successfully to Chatwoot');
      return messageResponse;
    }
  } catch (error) {
    console.error('❌ Error sending message to Chatwoot:', error.message);
    throw error;
  }
}

// Routes
app.get('/', (req, res) => {
  res.send('Hostaway-Chatwoot Integration is running! 🚀');
});

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        hostaway: 'connected',
        chatwoot: 'connected'
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

// Webhook endpoint for Chatwoot messages
app.post('/api/webhooks/chatwoot', async (req, res) => {
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
    console.error('❌ Error processing Chatwoot webhook:', error.stack);
    return res.status(500).json({ 
      status: 'error',
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Webhook endpoint for Hostaway messages
app.post('/api/webhooks/hostaway', async (req, res) => {
  console.log('\n🔥 INCOMING WEBHOOK FROM:', req.get('host'));
  console.log('📍 ENDPOINT: /api/webhooks/hostaway');
  
  try {
    // Process Hostaway webhook
    // Implementation would depend on Hostaway webhook format
    
    return res.status(200).json({ 
      status: 'success',
      message: 'Webhook received'
    });
  } catch (error) {
    console.error('❌ Error processing Hostaway webhook:', error.stack);
    return res.status(500).json({ 
      status: 'error',
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Start the server if running directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Time: ${formatPakistanTime()}`);
  });
}

// Export the Express app for serverless environments like Vercel
module.exports = app;
