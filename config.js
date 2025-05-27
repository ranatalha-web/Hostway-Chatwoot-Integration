/**
 * Configuration file for Hostaway-Chatwoot Integration
 */

// Chatwoot API Configuration
const CHATWOOT_CONFIG = {
  apiUrl: process.env.CHATWOOT_API_URL || 'http://137.184.34.26:8081',
  apiToken: process.env.CHATWOOT_API_TOKEN || 'ataY1rmRUCVE2VRJD298XVU6',
  accountId: process.env.CHATWOOT_ACCOUNT_ID || '1'
};

// Webhook URLs
const WEBHOOK_URLS = {
  hostaway: process.env.HOSTAWAY_WEBHOOK_URL || 'https://api.hostaway.com/v1/conversations',
  chatwoot: process.env.CHATWOOT_WEBHOOK_URL || 'https://app.chatwoot.com/api/v1'
};

// Mapping of Hostaway channel IDs to Chatwoot inbox IDs
const CHANNEL_TO_INBOX = {
  '2018': 5,  // Airbnb -> Inbox 5
  '2005': 6,  // Booking.com -> Inbox 6
  '2002': 8,  // Vrbo -> Inbox 8
  '2013': 10  // Website/Booking Engine -> Inbox 10
};

// Reverse mapping for Chatwoot to Hostaway
// This is the inverse of CHANNEL_TO_INBOX
const INBOX_TO_CHANNEL = {
  '5': '2018', // Inbox 5 -> Airbnb
  '6': '2005', // Inbox 6 -> Booking.com
  '8': '2002', // Inbox 8 -> Vrbo
  '10': '2013' // Inbox 10 -> Website/Booking Engine
};

module.exports = {
  CHATWOOT_CONFIG,
  WEBHOOK_URLS,
  CHANNEL_TO_INBOX,
  INBOX_TO_CHANNEL
};
class MessageCache {
  constructor(ttlMs = 15 * 1000) { // 15 seconds TTL
    this.cache = new Map();
    this.ttl = ttlMs;
  }
  // ...
}