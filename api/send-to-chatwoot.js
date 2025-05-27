// Serverless endpoint for manually sending messages from Hostaway to Chatwoot
const express = require('express');
const app = require('../vercel-server');
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

// Create a handler for manually sending messages
const handler = async (req, res) => {
  console.log('\n🔄 MANUAL API CALL FROM VERCEL SERVERLESS:', req.headers['host']);
  console.log('📍 ENDPOINT: /api/send-to-chatwoot');
  
  // Make sure this is a POST request
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { 
      conversationId,
      message,
      channelId,
      senderName
    } = req.body;

    if (!conversationId || !message) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        required: ['conversationId', 'message'],
        received: Object.keys(req.body)
      });
    }

    console.log('\n📤 SENDING MESSAGE TO CHATWOOT:', {
      conversationId,
      message: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
      channelId,
      senderName: senderName || 'Guest'
    });

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
      // Check if we have a cached conversation in Chatwoot
      // For simplicity in serverless, we'll create a new contact and conversation
      
      // Create a new contact
      const contactResponse = await chatwootApi.post(
        `/api/v1/accounts/${config.CHATWOOT_CONFIG.accountId}/contacts`,
        {
          identifier: identifier,
          name: senderName || 'Guest',
          custom_attributes: {
            hostaway_id: conversationId,
            channel_id: channelId
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
      
      const newConversationId = newConversationResponse.data.id;
      console.log(`Created new conversation: ${newConversationId}`);
      
      // Send message to the new conversation
      const messageResponse = await chatwootApi.post(
        `/api/v1/accounts/${config.CHATWOOT_CONFIG.accountId}/conversations/${newConversationId}/messages`,
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
        conversationId: newConversationId,
        contactId: contactId
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
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

// Export the handler for Vercel
module.exports = handler;
