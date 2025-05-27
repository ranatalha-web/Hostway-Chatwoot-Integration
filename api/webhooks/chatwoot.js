// Serverless endpoint for Chatwoot webhooks
const chatwootToHostawayHandler = require('../chatwoot-to-hostaway');

// Create a handler specifically for Chatwoot webhooks
const handler = async (req, res) => {
  console.log('\n🔥 INCOMING WEBHOOK FROM VERCEL SERVERLESS:', req.headers['host']);
  console.log('📍 ENDPOINT: /api/webhooks/chatwoot');
  
  // Forward directly to our simplified handler
  return chatwootToHostawayHandler(req, res);
};

// Export the handler for Vercel
module.exports = handler;
