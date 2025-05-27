// Serverless entry point for Vercel
const express = require('express');
const app = require('../vercel-server');

// Create a handler for serverless functions
const handler = async (req, res) => {
  // Forward the request to the Express app
  return new Promise((resolve, reject) => {
    // This simulates the Express middleware chain
    app(req, res, (err) => {
      if (err) {
        return reject(err);
      }
      resolve();
    });
  });
};

// Export the handler for Vercel
module.exports = handler;
