# Hostaway Conversations App

This application fetches and displays conversations from the Hostaway API for specific channels: Airbnb, Booking.com, Vrbo, and Website/Booking Engine.

## Features

- Fetches conversations from specified channels via the Hostaway API
- Displays the latest message from each conversation
- View full conversation message history when clicking on a conversation
- Shows reservation details for conversations associated with a reservation

## Setup

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Start the server:
   ```
   npm start
   ```
4. Open `index.html` in your web browser or access http://localhost:4000 

## Configuration

The application is configured to use the provided Hostaway API token. If you need to update the token, edit the `HOSTAWAY_TOKEN` value in `server.js`.

## API Endpoints

The backend server provides the following API endpoints:

- `GET /api/conversations` - Get all conversations from the specified channels with their latest messages and reservation details
- `GET /api/conversations/:conversationId/messages` - Get all messages for a specific conversation
- `GET /api/reservations/:reservationId` - Get details for a specific reservation

## Channel IDs

The application is configured to display conversations from the following channels:

- Airbnb (2018)
- Booking.com (2005)
- Vrbo (2010)
- Website/Booking Engine (2013) 