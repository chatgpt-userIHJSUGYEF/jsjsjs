const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const cors = require('cors');

// Security configuration
const WEBSITE_PASSWORD = 'pass';  // Change this to your desired password
const TERMUX_PASSWORD = 'termux456';    // Change this to your desired password
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected clients
const clients = new Map();

// Track phone connection status
let phoneConnected = false;
// Health check endpoint for render.com
app.get('/', (req, res) => {
  res.json({ 
    status: 'Server is running',
    clients: clients.size,
    phoneConnected: phoneConnected,
    timestamp: new Date().toISOString()
  });
});

app.get('/status', (req, res) => {
  res.json({
    connectedClients: clients.size,
    phoneConnected: phoneConnected,
    clients: Array.from(clients.keys())
  });
});

// Function to broadcast phone status to all websites
function broadcastPhoneStatus() {
  const statusMessage = {
    type: 'phone_status',
    connected: phoneConnected
  };
  
  clients.forEach((client, clientId) => {
    if (client.type === 'website' && client.authenticated && client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(statusMessage));
      } catch (error) {
        console.error(`Error sending phone status to website client ${clientId}:`, error);
      }
    }
  });
}
wss.on('connection', (ws, req) => {
  const clientId = Date.now().toString();
  const clientIP = req.connection.remoteAddress;
  
  console.log(`New client connected: ${clientId} from ${clientIP}`);
  
  // Store client with metadata
  clients.set(clientId, {
    ws: ws,
    type: 'unknown', // Will be set to 'website' or 'termux'
    authenticated: false,
    ip: clientIP,
    connectedAt: new Date()
  });


  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`Message from ${clientId}:`, data);

      // Handle authentication
      if (data.type === 'auth') {
        const clientType = data.clientType;
        const password = data.password;
        
        let isValidAuth = false;
        
        if (clientType === 'website' && password === WEBSITE_PASSWORD) {
          isValidAuth = true;
        } else if (clientType === 'termux' && password === TERMUX_PASSWORD) {
          isValidAuth = true;
        }
        
        if (isValidAuth) {
          clients.get(clientId).type = clientType;
          clients.get(clientId).authenticated = true;
          
          ws.send(JSON.stringify({
            type: 'auth_result',
            success: true,
            message: 'Authentication successful'
          }));
          
          console.log(`Client ${clientId} authenticated as ${clientType}`);
          
          // If it's a termux client, update phone status
          if (clientType === 'termux') {
            phoneConnected = true;
            broadcastPhoneStatus();
          }
          
          // Send current phone status to website clients
          if (clientType === 'website') {
            ws.send(JSON.stringify({
              type: 'phone_status',
              connected: phoneConnected
            }));
          }
          
        } else {
          ws.send(JSON.stringify({
            type: 'auth_result',
            success: false,
            message: 'Invalid password'
          }));
          
          console.log(`Authentication failed for client ${clientId}`);
          ws.close();
          return;
        }
      }
      
      // Only process other messages if client is authenticated
      const client = clients.get(clientId);
      if (!client || !client.authenticated) {
        console.log(`Unauthenticated message from ${clientId}, ignoring`);
        return;
      }

      // Identify client type (legacy support)
      if (data.clientType && !client.type) {
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
    const client = clients.get(clientId);
    
    // If it was a termux client, update phone status
    if (client && client.type === 'termux' && client.authenticated) {
      phoneConnected = false;
      broadcastPhoneStatus();
    }
    
    clients.delete(clientId);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for client ${clientId}:`, error);
    const client = clients.get(clientId);
    
    // If it was a termux client, update phone status
    if (client && client.type === 'termux' && client.authenticated) {
      phoneConnected = false;
      broadcastPhoneStatus();
    }
    
    clients.delete(clientId);
  });
});

function broadcastToWebsites(data) {
  clients.forEach((client, clientId) => {
    if (client.type === 'website' && client.authenticated && client.ws.readyState === WebSocket.OPEN) {
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
    if (client.type === 'termux' && client.authenticated && client.ws.readyState === WebSocket.OPEN) {
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
  let termuxConnected = false;
  
  clients.forEach((client, clientId) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify({ type: 'ping' }));
        
        // Check if any termux client is connected
        if (client.type === 'termux' && client.authenticated) {
          termuxConnected = true;
        }
      } catch (error) {
        console.error(`Error sending ping to ${clientId}:`, error);
        clients.delete(clientId);
      }
    } else {
      clients.delete(clientId);
    }
  });
  
  // Update phone connection status
  if (phoneConnected !== termuxConnected) {
    phoneConnected = termuxConnected;
    broadcastPhoneStatus();
  }
}, 30000); // Every 30 seconds

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
