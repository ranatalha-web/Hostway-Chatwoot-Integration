// Direct API endpoint for sending messages from Hostaway to Chatwoot
const axios = require('axios');
const config = require('../config.js');

// Create API client for Chatwoot
const chatwootApi = axios.create({
  baseURL: config.CHATWOOT_CONFIG.apiUrl,
  headers: {
    'api_access_token': config.CHATWOOT_CONFIG.apiToken,
    'Content-Type': 'application/json'
  }
});

// In-memory cache for duplicate detection
const messageCache = new Set();
const sentMessages = new Map();
const conversationCache = new Map();

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

// Handler for sending Hostaway messages to Chatwoot
module.exports = async (req, res) => {
  console.log('📤 HOSTAWAY TO CHATWOOT REQUEST RECEIVED');
  
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { 
      conversationId,
      message,
      channelId,
      senderName,
      messageId
    } = req.body;
    
    // Validate required fields
    if (!conversationId || !message) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        required: ['conversationId', 'message'],
        received: Object.keys(req.body)
      });
    }
    
    console.log('🔎 MESSAGE DETAILS:', {
      conversationId,
      message: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
      channelId,
      senderName: senderName || 'Guest'
    });
    
    // Check for duplicates
    if (isDuplicate(message, conversationId, channelId)) {
      console.log('⏭️ Skipping duplicate message');
      return res.status(200).json({ status: 'skipped', reason: 'Duplicate message' });
    }
    
    // Add to cache to prevent duplicates
    const messageKey = createMessageKey(message, conversationId, channelId);
    messageCache.add(messageKey);
    sentMessages.set(messageKey, Date.now());
    
    // Get inbox ID from channel mapping
    let inboxId = config.CHANNEL_TO_INBOX[channelId];
    
    // If no mapping, use a default inbox
    if (!inboxId) {
      // Default to inbox 10 (Website/Booking Engine)
      inboxId = 10;
      console.log(`No inbox mapped for channel ${channelId}, using default inbox ${inboxId}`);
    }
    
    // Create a unique identifier for this guest
    const identifier = `guest_${conversationId}_${Date.now()}`;
    
    try {
      // Check if we have a cached conversation
      let chatwootConversationId;
      if (conversationCache.has(conversationId)) {
        chatwootConversationId = conversationCache.get(conversationId);
        console.log(`Using cached conversation: ${chatwootConversationId}`);
      } else {
        // Create a new contact
        const contactResponse = await chatwootApi.post(
          `/api/v1/accounts/${config.CHATWOOT_CONFIG.accountId}/contacts`,
          {
            identifier: identifier,
            name: senderName || 'Guest',
            custom_attributes: {
              hostaway_id: conversationId,
              channel_id: channelId,
              channel_name: getChannelName(channelId)
            }
          }
        );
        
        const contactId = contactResponse.data.payload.contact.id;
        console.log(`Created new contact: ${contactResponse.data.payload.contact.name} (ID: ${contactId})`);
        
        // Create a new conversation
        const newConversationResponse = await chatwootApi.post(
          `/api/v1/accounts/${config.CHATWOOT_CONFIG.accountId}/conversations`,
          {
            source_id: contactId,
            inbox_id: inboxId,
            status: 'open',
            contact_id: contactId,
            custom_attributes: {
              hostaway_conversation_id: conversationId
            }
          }
        );
        
        chatwootConversationId = newConversationResponse.data.id;
        console.log(`Created new conversation: ${chatwootConversationId}`);
        
        // Cache the conversation for future use
        conversationCache.set(conversationId, chatwootConversationId);
      }
      
      // Send message to Chatwoot
      const messageResponse = await chatwootApi.post(
        `/api/v1/accounts/${config.CHATWOOT_CONFIG.accountId}/conversations/${chatwootConversationId}/messages`,
        {
          content: message,
          message_type: 'incoming',
          private: false
        }
      );
      
      console.log('✅ Message sent successfully to Chatwoot');
      
      return res.status(200).json({
        status: 'success',
        message: 'Message sent to Chatwoot successfully',
        conversationId: chatwootConversationId
      });
    } catch (error) {
      console.error('❌ Error sending message to Chatwoot:', error.message);
      
      return res.status(500).json({
        status: 'error',
        message: 'Failed to send message to Chatwoot',
        error: error.message,
        details: error.response?.data || {}
      });
    }
  } catch (error) {
    console.error('❌ Error processing request:', error);
    
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      error: error.message
    });
  }
};
