/**
 * VRBO-specific message checking function
 * This file is intended to be imported into server.js
 */

async function checkVrboMessages() {
  // Return a promise that resolves or rejects based on the operation
  return new Promise(async (resolve, reject) => {
    if (isVrboPolling) {
      return resolve(); // Already polling, just resolve silently
    }

    isVrboPolling = true;
    
    try {
      // Fetch conversations specifically from VRBO (channelId 2002)
      const vrboConversationsResponse = await hostawayApi.get('/conversations', {
        params: {
          sortOrder: 'desc',
          sortField: 'updatedAt',
          limit: 20, // Get more VRBO conversations
          channelId: 2002 // Specifically filter for VRBO
        }
      });
      
      if (!vrboConversationsResponse.data?.result || vrboConversationsResponse.data.result.length === 0) {
        isVrboPolling = false;
        return resolve();
      }
      
      console.log(`\n🔍 Checking ${vrboConversationsResponse.data.result.length} VRBO conversations...`);
      
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
          
          // Double-check this is actually a VRBO message
          if (channelId !== 2002) {
            console.log(`⚠️ Non-VRBO message found in VRBO query: Channel ${channelId}`);
            continue;
          }
          
          // If we're initializing, just record the message IDs without processing
          if (isInitializing) {
            lastCheckedMessageByConversation.set(conversationId, messageId);
            lastProcessedMessageIdByChannel[channelId] = messageId;
            continue;
          }
          
          // Check if this is a new message we haven't seen before
          const lastCheckedMessageId = lastCheckedMessageByConversation.get(conversationId);
          
          if (lastCheckedMessageId === messageId) {
            // We've already seen this message, skip it
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
          
          // Log the new VRBO message
          console.log(`\n🔔 NEW VRBO MESSAGE DETECTED!`);
          console.log(`Time: ${formatPakistanTime()}`);
          console.log(`Message ID: ${messageId}`);
          console.log(`Conversation ID: ${conversationId}`);
          console.log(`Content: ${message.body}`);
          console.log(`From: ${conversation.recipientName}`);
          console.log(`Channel: ${channelId} (VRBO)`);
          console.log(`Source: ${MESSAGE_SOURCES.HOSTAWAY}`);
          
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
      
      isVrboPolling = false;
      return resolve();
    } catch (error) {
      console.error('❌ Error checking for VRBO messages:', error.message);
      isVrboPolling = false;
      return reject(error);
    }
  });
}

module.exports = checkVrboMessages;
