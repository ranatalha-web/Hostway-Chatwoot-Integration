// Direct API endpoint for sending messages from Chatwoot to Hostaway
const axios = require('axios');
const config = require('../config.js');

// Create API client for Hostaway
const hostawayApi = axios.create({
  baseURL: 'https://api.hostaway.com/v1',
  headers: {
    'Authorization': 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI4MDA2NiIsImp0aSI6ImM5MDQ4NTgzNTBhYWNiOTdiMzBkNDAxMjczMDBjYTkyZmE1Njg0ZTU0MzJiMjMyNWM2YTIzYmVkMTQ5ZGE4YTQyNjUwMzgwMWY0YmI0YmNlIiwiaWF0IjoxNzM3OTc5NDcwLjk3NzYxMiwibmJmIjoxNzM3OTc5NDcwLjk3NzYxNCwiZXhwIjoyMDUzNTEyMjcwLjk3NzYxOCwic3ViIjoiIiwic2NvcGVzIjpbImdlbmVyYWwiXSwic2VjcmV0SWQiOjUzMDQzfQ.ItaGLJwySFtroyXsLdS_zMIeEDPivN-MjjHPxOvCjoHvFqAHuX4HBX-HCjAp-5f2gKLilxPsRcdYRkDvViILKr73qyo6nSnNPokYj3JUYXsuBLoKMejzwuvYMn_DQc2HbbdDAmV_iREKMfiPyJu2vJjRSKI5xc033CGFm5Tng-c',
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

// In-memory cache for duplicate detection
const messageCache = new Set();
const sentMessages = new Map();

// Create a unique key for message deduplication
function createMessageKey(content, conversationId, channelId) {
  return `${conversationId}:${channelId}:${content}`.substring(0, 100);
}

// Check if message is a duplicate (sent within the last 60 seconds)
function isDuplicate(content, conversationId, channelId) {
  const messageKey = createMessageKey(content, conversationId, channelId);
  
  // Check in cache first
  if (messageCache.has(messageKey)) {
    return true;
  }
  
  // Check in sent messages with time window
  if (sentMessages.has(messageKey)) {
    const timestamp = sentMessages.get(messageKey);
    const now = Date.now();
    const timeDiff = now - timestamp;
    
    // Consider as duplicate if sent within the last 60 seconds
    if (timeDiff <= 60 * 1000) {
      return true;
    }
  }
  
  return false;
}

// Handler for Chatwoot webhook
module.exports = async (req, res) => {
  console.log('📥 CHATWOOT WEBHOOK RECEIVED');
  
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
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
    
    console.log('🔎 MESSAGE ANALYSIS:', {
      event,
      messageId,
      content: content?.substring(0, 50),
      type: message_type,
      isPrivate,
      sender: sender?.type,
      inboxId: inbox?.id
    });
    
    // Skip if not a message creation event
    if (event !== 'message_created') {
      return res.status(200).json({ status: 'skipped', reason: 'Not a message creation event' });
    }
    
    // Skip private messages
    if (isPrivate) {
      return res.status(200).json({ status: 'skipped', reason: 'Private message' });
    }
    
    // Define allowed inboxes
    const ALLOWED_INBOXES = new Set([5, 6, 8, 10]); // Airbnb, Booking.com, Vrbo, Website inboxes
    
    // Skip messages from unallowed inboxes
    if (!ALLOWED_INBOXES.has(inbox?.id)) {
      console.log(`⏭️ Skipping message from unallowed inbox: ${inbox?.id}`);
      return res.status(200).json({ status: 'skipped', reason: 'Inbox not allowed' });
    }
    
    // Skip non-user messages or incoming messages
    if (sender?.type !== 'user' || message_type === 'incoming') {
      console.log('⏭️ Skipping non-user message or incoming message');
      return res.status(200).json({ status: 'skipped', reason: 'Not a user-generated message' });
    }
    
    // Get Hostaway conversation ID
    const hostawayConversationId = conversation?.custom_attributes?.hostaway_conversation_id;
    if (!hostawayConversationId) {
      console.log('❌ No Hostaway conversation ID found');
      return res.status(400).json({ status: 'error', reason: 'No Hostaway conversation ID' });
    }
    
    // Get channel ID from inbox
    let channelId;
    // Reverse lookup from inbox to channel
    for (const [chId, inboxId] of Object.entries(config.CHANNEL_TO_INBOX)) {
      if (inboxId === inbox?.id) {
        channelId = chId;
        break;
      }
    }
    
    if (!channelId) {
      console.log(`❌ No Hostaway channel ID mapped for inbox: ${inbox?.id}`);
      return res.status(400).json({ status: 'error', reason: 'No channel ID mapped' });
    }
    
    // Check for duplicates
    if (isDuplicate(content, hostawayConversationId, channelId)) {
      console.log('⏭️ Skipping duplicate message');
      return res.status(200).json({ status: 'skipped', reason: 'Duplicate message' });
    }
    
    // Add to cache to prevent duplicates
    const messageKey = createMessageKey(content, hostawayConversationId, channelId);
    messageCache.add(messageKey);
    sentMessages.set(messageKey, Date.now());
    
    // Send message to Hostaway
    try {
      console.log(`🚀 Sending message to Hostaway conversation ${hostawayConversationId}`);
      
      const response = await hostawayApi.post(`/conversations/${hostawayConversationId}/messages`, {
        body: content,
        type: 'text'
      });
      
      console.log('✅ Message sent to Hostaway successfully');
      
      return res.status(200).json({
        status: 'success',
        message: 'Message sent to Hostaway',
        hostawayResponse: response.data
      });
    } catch (error) {
      console.error('❌ Error sending message to Hostaway:', error.message);
      
      return res.status(500).json({
        status: 'error',
        message: 'Failed to send message to Hostaway',
        error: error.message,
        details: error.response?.data || {}
      });
    }
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      error: error.message
    });
  }
};
