const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected clients
const clients = new Map();

// Health check endpoint for render.com
app.get('/', (req, res) => {
  res.json({ 
    status: 'Server is running',
    clients: clients.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/status', (req, res) => {
  res.json({
    connectedClients: clients.size,
    clients: Array.from(clients.keys())
  });
});

wss.on('connection', (ws, req) => {
  const clientId = Date.now().toString();
  const clientIP = req.connection.remoteAddress;
  
  console.log(`New client connected: ${clientId} from ${clientIP}`);
  
  // Store client with metadata
  clients.set(clientId, {
    ws: ws,
    type: 'unknown', // Will be set to 'website' or 'termux'
    ip: clientIP,
    connectedAt: new Date()
  });

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    clientId: clientId,
    message: 'Connected to phone control server'
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`Message from ${clientId}:`, data);

      // Identify client type
      if (data.clientType) {
        clients.get(clientId).type = data.clientType;
        console.log(`Client ${clientId} identified as ${data.clientType}`);
      }

      // Handle different message types
      switch (data.type) {
        case 'phoneData':
          // Data from Termux - broadcast to all website clients
          broadcastToWebsites(data.payload);
          break;
          
        case 'command':
          // Command from website - send to Termux clients
          broadcastToTermux({
            type: 'command',
            command: data.command,
            data: data.data
          });
          break;
          
        case 'ping':
          // Heartbeat
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
          
        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    console.log(`Client disconnected: ${clientId}`);
    clients.delete(clientId);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for client ${clientId}:`, error);
    clients.delete(clientId);
  });
});

function broadcastToWebsites(data) {
  clients.forEach((client, clientId) => {
    if (client.type === 'website' && client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(data));
      } catch (error) {
        console.error(`Error sending to website client ${clientId}:`, error);
      }
    }
  });
}

function broadcastToTermux(data) {
  clients.forEach((client, clientId) => {
    if (client.type === 'termux' && client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(data));
      } catch (error) {
        console.error(`Error sending to termux client ${clientId}:`, error);
      }
    }
  });
}

// Heartbeat to keep connections alive
setInterval(() => {
  clients.forEach((client, clientId) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify({ type: 'ping' }));
      } catch (error) {
        console.error(`Error sending ping to ${clientId}:`, error);
        clients.delete(clientId);
      }
    } else {
      clients.delete(clientId);
    }
  });
}, 30000); // Every 30 seconds

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});