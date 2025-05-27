// Serverless endpoint for Hostaway webhooks
const hostawayToChatwootHandler = require('../hostaway-to-chatwoot');

// Create a handler specifically for Hostaway webhooks
const handler = async (req, res) => {
  console.log('\n🔥 INCOMING WEBHOOK FROM VERCEL SERVERLESS:', req.headers['host']);
  console.log('📍 ENDPOINT: /api/webhooks/hostaway');
  
  // Forward directly to our simplified handler
  return hostawayToChatwootHandler(req, res);
};

// Export the handler for Vercel
module.exports = handler;
