const express = require('express');
const http = require('http');
const path = require('path');
const socketIO = require('socket.io');
const mediasoup = require('mediasoup');
const config = require('./config');

// Express app setup
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Serve static files
// app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// MediaSoup objects
let worker;
const rooms = new Map(); // Maps roomId => Room object

// Room class to manage mediasoup objects
class Room {
  constructor(roomId) {
    this.id = roomId;
    this.router = null;
    this.peers = new Map(); // userId -> Peer
    this.adminId = null;
  }
}

// Peer class to manage client connections
class Peer {
  constructor(socketId, name) {
    this.id = socketId;
    this.name = name;
    this.transports = new Map(); // transportId -> transport
    this.producers = new Map(); // producerId -> producer
    this.consumers = new Map(); // consumerId -> consumer
    this.isAudioMuted = false;
    this.isVideoOff = false;
    this.isHandRaised = false;
    this.isScreenSharing = false;
  }
}

// Start mediasoup worker
async function startMediasoup() {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  console.log('MediaSoup worker created');

  worker.on('died', () => {
    console.error('MediaSoup worker died, exiting in 2 seconds...');
    setTimeout(() => process.exit(1), 2000);
  });
}

// Create a mediasoup router
async function createRouter() {
  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  return await worker.createRouter({ mediaCodecs });
}

// Create a transport for sending media
async function createWebRtcTransport(router) {
  const {
    maxIncomingBitrate,
    initialAvailableOutgoingBitrate,
    listenIps
  } = config.mediasoup.webRtcTransport;

  const transport = await router.createWebRtcTransport({
    listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate,
  });

  if (maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(maxIncomingBitrate);
    } catch (error) {
      console.error('Error setting max incoming bitrate', error);
    }
  }

  return transport;
}

// Start the server
async function start() {
  await startMediasoup();

  // Socket.io connection handling
  io.on('connection', async (socket) => {
    console.log('Client connected:', socket.id);

    // Join or create room
    socket.on('join-room', async ({ roomId, name }, callback) => {
      try {
        let room = rooms.get(roomId);
        const isFirstPeer = !room;

        // Create room if it doesn't exist
        if (isFirstPeer) {
          console.log(`Creating room ${roomId}`);
          room = new Room(roomId);
          room.router = await createRouter();
          room.adminId = socket.id; // First peer is the admin
          rooms.set(roomId, room);
        }

        // Create peer
        const peer = new Peer(socket.id, name);
        room.peers.set(socket.id, peer);
        
        // Join socket.io room
        socket.join(roomId);

        // Notify others in the room
        socket.to(roomId).emit('peer-joined', {
          peerId: socket.id,
          name: name
        });

        // Send room info to joining peer
        const routerRtpCapabilities = room.router.rtpCapabilities;
        const peers = Array.from(room.peers.values()).map(p => ({
          id: p.id,
          name: p.name,
          isAdmin: p.id === room.adminId,
          isAudioMuted: p.isAudioMuted,
          isVideoOff: p.isVideoOff,
          isHandRaised: p.isHandRaised,
          isScreenSharing: p.isScreenSharing
        }));

        callback({
          isAdmin: isFirstPeer,
          routerRtpCapabilities,
          peers
        });
      } catch (error) {
        console.error('Error joining room', error);
        callback({ error: error.message });
      }
    });

    // Create WebRTC transport
    socket.on('create-transport', async ({ roomId, direction }, callback) => {
      try {
        const room = rooms.get(roomId);
        if (!room) {
          throw new Error(`Room ${roomId} not found`);
        }

        const peer = room.peers.get(socket.id);
        if (!peer) {
          throw new Error('Peer not found');
        }

        const transport = await createWebRtcTransport(room.router);
        peer.transports.set(transport.id, transport);

        // Listen for transport closure
        transport.on('dtlsstatechange', (dtlsState) => {
          if (dtlsState === 'closed') {
            transport.close();
            peer.transports.delete(transport.id);
          }
        });

        // Listen for transport close event
        transport.on('close', () => {
          console.log('Transport closed', transport.id);
          peer.transports.delete(transport.id);
        });

        callback({
          transportId: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters
        });
      } catch (error) {
        console.error('Error creating transport', error);
        callback({ error: error.message });
      }
    });

    // Connect transport
    socket.on('connect-transport', async ({ roomId, transportId, dtlsParameters }, callback) => {
      try {
        const room = rooms.get(roomId);
        if (!room) {
          throw new Error(`Room ${roomId} not found`);
        }

        const peer = room.peers.get(socket.id);
        if (!peer) {
          throw new Error('Peer not found');
        }

        const transport = peer.transports.get(transportId);
        if (!transport) {
          throw new Error(`Transport ${transportId} not found`);
        }

        await transport.connect({ dtlsParameters });
        callback({ connected: true });
      } catch (error) {
        console.error('Error connecting transport', error);
        callback({ error: error.message });
      }
    });

    // Produce media
    socket.on('produce', async ({ roomId, transportId, kind, rtpParameters, appData }, callback) => {
      try {
        const room = rooms.get(roomId);
        if (!room) {
          throw new Error(`Room ${roomId} not found`);
        }

        const peer = room.peers.get(socket.id);
        if (!peer) {
          throw new Error('Peer not found');
        }

        const transport = peer.transports.get(transportId);
        if (!transport) {
          throw new Error(`Transport ${transportId} not found`);
        }

        const producer = await transport.produce({ 
          kind, 
          rtpParameters,
          appData: { ...appData, peerId: socket.id, peerName: peer.name }
        });
        
        peer.producers.set(producer.id, producer);

        // Handle producer closure
        producer.on('transportclose', () => {
          producer.close();
          peer.producers.delete(producer.id);
        });

        // Notify other peers of the new producer
        const isScreen = appData.source === 'screen';
        
        if (isScreen) {
          peer.isScreenSharing = true;
          socket.to(roomId).emit('new-producer', {
            producerId: producer.id,
            peerId: socket.id,
            kind,
            source: 'screen'
          });
        } else {
          // For audio/video tracks
          socket.to(roomId).emit('new-producer', {
            producerId: producer.id,
            peerId: socket.id,
            kind,
            source: 'webcam'
          });
        }

        callback({ id: producer.id });
      } catch (error) {
        console.error('Error producing', error);
        callback({ error: error.message });
      }
    });

    // Consume media
    socket.on('consume', async ({ roomId, producerId, rtpCapabilities }, callback) => {
      try {
        const room = rooms.get(roomId);
        if (!room) {
          throw new Error(`Room ${roomId} not found`);
        }

        const peer = room.peers.get(socket.id);
        if (!peer) {
          throw new Error('Peer not found');
        }

        // Make sure router can consume the producer
        if (!room.router.canConsume({ producerId, rtpCapabilities })) {
          throw new Error('Router cannot consume this producer');
        }

        // Find the producer owner
        let producer = null;
        let producerPeer = null;
        
        for (const [peerId, p] of room.peers.entries()) {
          for (const [pid, prod] of p.producers.entries()) {
            if (pid === producerId) {
              producer = prod;
              producerPeer = p;
              break;
            }
          }
          if (producer) break;
        }

        if (!producer) {
          throw new Error(`Producer ${producerId} not found`);
        }

        // Find receive transport
        let transport = null;
        for (const [_, t] of peer.transports.entries()) {
          if (t.appData.direction === 'recv') {
            transport = t;
            break;
          }
        }

        if (!transport) {
          throw new Error('Receive transport not found');
        }

        // Create consumer
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true, // start paused
          appData: {
            peerId: producerPeer.id,
            peerName: producerPeer.name,
            source: producer.appData.source
          }
        });

        peer.consumers.set(consumer.id, consumer);

        // Handle consumer events
        consumer.on('transportclose', () => {
          consumer.close();
          peer.consumers.delete(consumer.id);
        });

        consumer.on('producerclose', () => {
          consumer.close();
          peer.consumers.delete(consumer.id);
          socket.emit('consumer-closed', { consumerId: consumer.id });
        });

        // Return consumer info
        callback({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          producerPeerId: producerPeer.id,
          source: producer.appData.source || 'webcam'
        });
      } catch (error) {
        console.error('Error consuming', error);
        callback({ error: error.message });
      }
    });

    // Resume consumer
    socket.on('consumer-resume', async ({ roomId, consumerId }, callback) => {
      try {
        const room = rooms.get(roomId);
        if (!room) {
          throw new Error(`Room ${roomId} not found`);
        }

        const peer = room.peers.get(socket.id);
        if (!peer) {
          throw new Error('Peer not found');
        }

        const consumer = peer.consumers.get(consumerId);
        if (!consumer) {
          throw new Error(`Consumer ${consumerId} not found`);
        }

        await consumer.resume();
        callback({ resumed: true });
      } catch (error) {
        console.error('Error resuming consumer', error);
        callback({ error: error.message });
      }
    });

    // Toggle audio mute
    socket.on('toggle-audio', async ({ roomId, enabled }, callback) => {
      try {
        const room = rooms.get(roomId);
        if (!room) {
          throw new Error(`Room ${roomId} not found`);
        }

        const peer = room.peers.get(socket.id);
        if (!peer) {
          throw new Error('Peer not found');
        }

        peer.isAudioMuted = !enabled;
        socket.to(roomId).emit('peer-audio-updated', {
          peerId: socket.id,
          enabled
        });

        callback({ muted: peer.isAudioMuted });
      } catch (error) {
        console.error('Error toggling audio', error);
        callback({ error: error.message });
      }
    });

    // Toggle video
    socket.on('toggle-video', async ({ roomId, enabled }, callback) => {
      try {
        const room = rooms.get(roomId);
        if (!room) {
          throw new Error(`Room ${roomId} not found`);
        }

        const peer = room.peers.get(socket.id);
        if (!peer) {
          throw new Error('Peer not found');
        }

        peer.isVideoOff = !enabled;
        socket.to(roomId).emit('peer-video-updated', {
          peerId: socket.id,
          enabled
        });

        callback({ videoOff: peer.isVideoOff });
      } catch (error) {
        console.error('Error toggling video', error);
        callback({ error: error.message });
      }
    });

    // Toggle hand raise
    socket.on('toggle-hand', async ({ roomId, raised }, callback) => {
      try {
        const room = rooms.get(roomId);
        if (!room) {
          throw new Error(`Room ${roomId} not found`);
        }

        const peer = room.peers.get(socket.id);
        if (!peer) {
          throw new Error('Peer not found');
        }

        peer.isHandRaised = raised;
        socket.to(roomId).emit('peer-hand-updated', {
          peerId: socket.id,
          raised
        });

        callback({ raised: peer.isHandRaised });
      } catch (error) {
        console.error('Error toggling hand', error);
        callback({ error: error.message });
      }
    });

    // Screen share ended
    socket.on('screen-share-ended', async ({ roomId }, callback) => {
      try {
        const room = rooms.get(roomId);
        if (!room) {
          throw new Error(`Room ${roomId} not found`);
        }

        const peer = room.peers.get(socket.id);
        if (!peer) {
          throw new Error('Peer not found');
        }

        peer.isScreenSharing = false;
        socket.to(roomId).emit('peer-screen-share-ended', {
          peerId: socket.id
        });

        callback({ success: true });
      } catch (error) {
        console.error('Error handling screen share end', error);
        callback({ error: error.message });
      }
    });

    // Admin mute user
    socket.on('admin-mute-peer', async ({ roomId, peerId }, callback) => {
      try {
        const room = rooms.get(roomId);
        if (!room) {
          throw new Error(`Room ${roomId} not found`);
        }

        // Check if requester is admin
        if (room.adminId !== socket.id) {
          throw new Error('Only admin can mute users');
        }

        const targetPeer = room.peers.get(peerId);
        if (!targetPeer) {
          throw new Error('Target peer not found');
        }

        targetPeer.isAudioMuted = true;
        
        // Notify the target peer to mute themselves
        io.to(peerId).emit('admin-mute-you');
        
        // Notify all peers about the mute
        io.to(roomId).emit('peer-audio-updated', {
          peerId,
          enabled: false
        });

        callback({ success: true });
      } catch (error) {
        console.error('Error in admin mute peer', error);
        callback({ error: error.message });
      }
    });

    // Admin kick user
    socket.on('admin-kick-peer', async ({ roomId, peerId }, callback) => {
      try {
        const room = rooms.get(roomId);
        if (!room) {
          throw new Error(`Room ${roomId} not found`);
        }

        // Check if requester is admin
        if (room.adminId !== socket.id) {
          throw new Error('Only admin can kick users');
        }

        const targetPeer = room.peers.get(peerId);
        if (!targetPeer) {
          throw new Error('Target peer not found');
        }

        // Notify the target peer they're being kicked
        io.to(peerId).emit('you-were-kicked');
        
        // Clean up resources for the kicked peer
        cleanUpPeer(room, peerId);
        
        // Notify all other peers about the kick
        socket.to(roomId).emit('peer-kicked', { peerId });

        callback({ success: true });
      } catch (error) {
        console.error('Error in admin kick peer', error);
        callback({ error: error.message });
      }
    });

    // Leave room
    socket.on('leave-room', async ({ roomId }, callback) => {
      try {
        leaveRoom(socket.id, roomId);
        callback({ success: true });
      } catch (error) {
        console.error('Error leaving room', error);
        callback({ error: error.message });
      }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
      
      // Clean up from all rooms
      for (const [roomId, room] of rooms.entries()) {
        if (room.peers.has(socket.id)) {
          leaveRoom(socket.id, roomId);
        }
      }
    });
  });

  // Function to handle a peer leaving a room
  function leaveRoom(peerId, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    cleanUpPeer(room, peerId);
    
    // Notify other peers
    io.to(roomId).emit('peer-left', { peerId });
    
    // If room is empty, close and delete it
    if (room.peers.size === 0) {
      room.router.close();
      rooms.delete(roomId);
      console.log(`Room ${roomId} has been closed`);
    } else if (room.adminId === peerId) {
      // If admin left, assign a new admin
      const nextPeerId = room.peers.keys().next().value;
      room.adminId = nextPeerId;
      
      // Notify new admin
      io.to(nextPeerId).emit('you-are-now-admin');
      
      // Notify all peers about new admin
      io.to(roomId).emit('new-admin', { peerId: nextPeerId });
    }
  }
  
  // Clean up peer resources
  function cleanUpPeer(room, peerId) {
    const peer = room.peers.get(peerId);
    if (!peer) return;
    
    // Close all transports
    for (const [_, transport] of peer.transports.entries()) {
      transport.close();
    }
    
    // Remove from peers map
    room.peers.delete(peerId);
    
    // Leave socket.io room
    const socket = io.sockets.sockets.get(peerId);
    if (socket) {
      socket.leave(room.id);
    }
  }

  // Start server
  const PORT = process.env.PORT || 8080;
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
