// Import socket.io client
// const io = require("socket.io-client")
// import io from "socket.io-client"

// Import mediasoup client
// const mediasoupClient = require("mediasoup-client")
// import mediasoupClient from "mediasoup-client"

// import { io } from "https://cdn.socket.io/4.7.4/socket.io.esm.min.js"
// import * as mediasoupClient from "https://cdn.jsdelivr.net/npm/mediasoup-client@3/lib/index.min.js"

// main.js
// import { io } from "https://cdn.socket.io/4.7.4/socket.io.esm.min.js";

// Use the global mediasoupClient variable
// const device = new mediasoupClient.Device();

// const io = io('http://localhost:3000');

// Global variables
let currentRoom = null
let device = null
let socket = null
let producerTransport = null
let consumerTransport = null
let producers = {}
let consumers = {}
let isAdmin = false
let isAudioMuted = false
let isVideoOff = false
let isHandRaised = false
let isScreenSharing = false
let localStream = null
let screenStream = null
const peers = new Map()

// DOM Elements
const localVideo = document.querySelector("#localVideo-container video")
const videoGrid = document.querySelector("#videoGrid")
const notification = document.querySelector("#notification")
const joinScreen = document.querySelector("#join-screen")
const roomTitle = document.querySelector("#room-title")

// Control buttons
const micBtn = document.querySelector("#micBtn")
const cameraBtn = document.querySelector("#cameraBtn")
const raiseHandBtn = document.querySelector("#raiseHandBtn")
const screenShareBtn = document.querySelector("#screenShareBtn")
const controlsContainer = document.querySelector("#controls")
const leaveCallBtn = document.querySelector("#leaveCallBtn")

// Form elements
const roomInput = document.querySelector("#roomId")
const nameInput = document.querySelector("#userName")
const joinBtn = document.querySelector("#joinBtn")
const leaveBtn = document.querySelector("#leaveBtn")

// Initialize the application
async function init() {
  // if (io) {
    // Connect to signaling server
    socket = io()

    // Set up socket event listeners
    setupSocketListeners()

    // Set up UI event listeners
    setupUIListeners()
  // }
}

// Set up socket event listeners
function setupSocketListeners() {
  // New peer joined the room
  socket.on("peer-joined", ({ peerId, name }) => {
    console.log(`Peer joined: ${name} (${peerId})`)
    notify(`${name} joined the room`)

    peers.set(peerId, {
      id: peerId,
      name: name,
      isAudioMuted: false,
      isVideoOff: false,
      isHandRaised: false,
      isScreenSharing: false,
    })
  })

  // Peer left the room
  socket.on("peer-left", ({ peerId }) => {
    console.log(`Peer left: ${peerId}`)
    const peer = peers.get(peerId)
    if (peer) {
      notify(`${peer.name} left the room`)
      peers.delete(peerId)
    }

    // Remove video element
    const videoEl = document.getElementById(`video-${peerId}`)
    if (videoEl) {
      videoEl.parentElement.remove()
    }

    // Remove screen share if this peer was sharing
    if (peer && peer.isScreenSharing) {
      const screenEl = document.getElementById("screen-share-container")
      if (screenEl) {
        screenEl.remove()
      }
    }

    // Adjust grid layout
    adjustGridLayout()
  })

  // New producer (new media track available)
  socket.on("new-producer", async ({ producerId, peerId, kind, source }) => {
    console.log(`New producer: ${producerId} from ${peerId} (${kind}, ${source})`)

    if (device.rtpCapabilities) {
      // Consume the track
      consumeTrack(producerId, kind, source, peerId)
    }
  })

  // Consumer closed (producer stopped)
  socket.on("consumer-closed", ({ consumerId }) => {
    console.log(`Consumer closed: ${consumerId}`)

    const consumer = consumers[consumerId]
    if (consumer) {
      consumer.close()
      delete consumers[consumerId]
    }
  })

  // Peer audio status updated
  socket.on("peer-audio-updated", ({ peerId, enabled }) => {
    console.log(`Peer ${peerId} audio ${enabled ? "enabled" : "muted"}`)

    const peer = peers.get(peerId)
    if (peer) {
      peer.isAudioMuted = !enabled

      // Update UI
      const micStatus = document.querySelector(`#video-${peerId} .mic-status`)
      if (micStatus) {
        if (!enabled) {
          micStatus.classList.add("muted")
        } else {
          micStatus.classList.remove("muted")
        }
      }
    }
  })

  // Peer video status updated
  socket.on("peer-video-updated", ({ peerId, enabled }) => {
    console.log(`Peer ${peerId} video ${enabled ? "enabled" : "disabled"}`)

    const peer = peers.get(peerId)
    if (peer) {
      peer.isVideoOff = !enabled

      // Update UI
      const cameraStatus = document.querySelector(`#video-${peerId} .camera-status`)
      if (cameraStatus) {
        if (!enabled) {
          cameraStatus.classList.add("off")
        } else {
          cameraStatus.classList.remove("off")
        }
      }
    }
  })

  // Peer hand status updated
  socket.on("peer-hand-updated", ({ peerId, raised }) => {
    console.log(`Peer ${peerId} hand ${raised ? "raised" : "lowered"}`)

    const peer = peers.get(peerId)
    if (peer) {
      peer.isHandRaised = raised

      // Update UI
      const handStatus = document.querySelector(`#video-${peerId} .hand-status`)
      if (handStatus) {
        if (raised) {
          handStatus.classList.remove("hidden")
          notify(`${peer.name} raised their hand`)
        } else {
          handStatus.classList.add("hidden")
        }
      }
    }
  })

  // Peer screen share started
  socket.on("peer-screen-share-started", ({ peerId }) => {
    console.log(`Peer ${peerId} started screen sharing`)

    const peer = peers.get(peerId)
    if (peer) {
      peer.isScreenSharing = true
      notify(`${peer.name} started screen sharing`)
    }
  })

  // Peer screen share ended
  socket.on("peer-screen-share-ended", ({ peerId }) => {
    console.log(`Peer ${peerId} stopped screen sharing`)

    const peer = peers.get(peerId)
    if (peer) {
      peer.isScreenSharing = false
      notify(`${peer.name} stopped screen sharing`)

      // Remove screen share container if it exists
      const screenContainer = document.getElementById(`screen-${peerId}`)
      if (screenContainer) {
        screenContainer.remove()
      }
    }
  })

  // You were kicked by admin
  socket.on("you-were-kicked", () => {
    leaveRoom()
    notify("You were kicked out by the host")
  })

  // You were muted by admin
  socket.on("admin-mute-you", () => {
    if (!isAudioMuted) {
      toggleMic()
    }
    notify("You were muted by the host")
  })

  // You are now admin
  socket.on("you-are-now-admin", () => {
    isAdmin = true
    notify("You are now the host of this room")

    // Add admin controls to all peers
    addAdminControlsToPeers()
  })

  // New admin announced
  socket.on("new-admin", ({ peerId }) => {
    const peer = peers.get(peerId)
    if (peer) {
      notify(`${peer.name} is now the host`)
    }
  })
}

// Set up UI event listeners
function setupUIListeners() {
  // Join button
  joinBtn.addEventListener("click", joinRoom)

  // Leave buttons
  leaveBtn.addEventListener("click", leaveRoom)
  leaveCallBtn.addEventListener("click", leaveRoom)

  // Control buttons
  micBtn.addEventListener("click", toggleMic)
  cameraBtn.addEventListener("click", toggleCamera)
  raiseHandBtn.addEventListener("click", toggleRaiseHand)
  screenShareBtn.addEventListener("click", toggleScreenShare)

  // Make local video container draggable
  makeDraggable(document.getElementById("localVideo-container"))
}

// Join a room
async function joinRoom() {
  const roomId = roomInput.value.trim()
  const userName = nameInput.value.trim() || "Anonymous"

  if (!roomId) {
    notify("Please enter a room ID")
    return
  }

  try {
    // Load the mediasoup client device
    device = new mediasoupClient.Device()

    // Join the room
    const {
      isAdmin: adminStatus,
      routerRtpCapabilities,
      peers: roomPeers,
      error,
    } = await emitSocketEvent("join-room", {
      roomId,
      name: userName,
    })

    if (error) {
      notify(`Error joining room: ${error}`)
      return
    }

    currentRoom = roomId
    isAdmin = adminStatus

    // Load the device with router RTP capabilities
    await device.load({ routerRtpCapabilities })

    // Store peers
    roomPeers.forEach((peer) => {
      peers.set(peer.id, peer)
    })

    // Get local media
    await getLocalMedia()

    // Create WebRTC transports
    await createSendTransport()
    await createReceiveTransport()

    // Update UI
    roomTitle.textContent = `Room: ${roomId}`
    joinScreen.classList.add("hidden")
    controlsContainer.classList.remove("hidden")
    leaveBtn.classList.remove("hidden")

    notify(`Joined room ${roomId}`)

    // Publish local tracks
    await publishTracks()
  } catch (error) {
    console.error("Error joining room:", error)
    notify(`Error joining room: ${error.message}`)
  }
}

// Leave the room
async function leaveRoom() {
  if (!currentRoom) return

  try {
    // Close all producers
    Object.values(producers).forEach((producer) => {
      producer.close()
    })
    producers = {}

    // Close all consumers
    Object.values(consumers).forEach((consumer) => {
      consumer.close()
    })
    consumers = {}

    // Close transports
    if (producerTransport) {
      producerTransport.close()
      producerTransport = null
    }

    if (consumerTransport) {
      consumerTransport.close()
      consumerTransport = null
    }

    // Stop local media
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop())
      localStream = null
    }

    // Stop screen share if active
    if (screenStream) {
      screenStream.getTracks().forEach((track) => track.stop())
      screenStream = null
      isScreenSharing = false
    }

    // Clear video containers
    videoGrid.innerHTML = ""
    localVideo.srcObject = null

    const screenContainer = document.getElementById("screen-share-container")
    if (screenContainer) {
      screenContainer.remove()
    }

    // Notify server
    await emitSocketEvent("leave-room", { roomId: currentRoom })

    // Reset variables
    currentRoom = null
    device = null
    isAdmin = false
    isAudioMuted = false
    isVideoOff = false
    isHandRaised = false
    peers.clear()

    // Update UI
    roomTitle.textContent = ""
    joinScreen.classList.remove("hidden")
    controlsContainer.classList.add("hidden")
    leaveBtn.classList.add("hidden")

    // Reset button states
    micBtn.classList.remove("active")
    cameraBtn.classList.remove("active")
    raiseHandBtn.classList.remove("active")
    screenShareBtn.classList.remove("active")

    notify("Left the room")
  } catch (error) {
    console.error("Error leaving room:", error)
    notify(`Error leaving room: ${error.message}`)
  }
}

// Get access to local media
async function getLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    })

    // Display local video
    localVideo.srcObject = localStream

    return localStream
  } catch (error) {
    console.error("Error getting local media:", error)
    notify("Could not access camera or microphone")
    throw error
  }
}

// Create a transport for sending media
async function createSendTransport() {
  const { transportId, iceParameters, iceCandidates, dtlsParameters, error } = await emitSocketEvent(
    "create-transport",
    {
      roomId: currentRoom,
      direction: "send",
    },
  )

  if (error) {
    throw new Error(`Server-side transport creation failed: ${error}`)
  }

  producerTransport = device.createSendTransport({
    id: transportId,
    iceParameters,
    iceCandidates,
    dtlsParameters,
    appData: { direction: "send" },
  })

  // Set up transport event handlers
  producerTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
    try {
      await emitSocketEvent("connect-transport", {
        roomId: currentRoom,
        transportId,
        dtlsParameters,
      })
      callback()
    } catch (error) {
      errback(error)
    }
  })

  producerTransport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
    try {
      const { id } = await emitSocketEvent("produce", {
        roomId: currentRoom,
        transportId,
        kind,
        rtpParameters,
        appData,
      })
      callback({ id })
    } catch (error) {
      errback(error)
    }
  })

  producerTransport.on("connectionstatechange", (state) => {
    console.log(`Producer transport connection state: ${state}`)
    if (state === "failed" || state === "closed") {
      producerTransport.close()
    }
  })
}

// Create a transport for receiving media
async function createReceiveTransport() {
  const { transportId, iceParameters, iceCandidates, dtlsParameters, error } = await emitSocketEvent(
    "create-transport",
    {
      roomId: currentRoom,
      direction: "recv",
    },
  )

  if (error) {
    throw new Error(`Server-side transport creation failed: ${error}`)
  }

  consumerTransport = device.createRecvTransport({
    id: transportId,
    iceParameters,
    iceCandidates,
    dtlsParameters,
    appData: { direction: "recv" },
  })

  // Set up transport event handlers
  consumerTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
    try {
      await emitSocketEvent("connect-transport", {
        roomId: currentRoom,
        transportId,
        dtlsParameters,
      })
      callback()
    } catch (error) {
      errback(error)
    }
  })

  consumerTransport.on("connectionstatechange", (state) => {
    console.log(`Consumer transport connection state: ${state}`)
    if (state === "failed" || state === "closed") {
      consumerTransport.close()
    }
  })
}

// Publish local media tracks
async function publishTracks() {
  if (!producerTransport || !localStream) return

  try {
    // Publish audio track
    const audioTrack = localStream.getAudioTracks()[0]
    if (audioTrack) {
      const audioProducer = await producerTransport.produce({
        track: audioTrack,
        codecOptions: {
          opusStereo: true,
          opusDtx: true,
        },
        appData: {
          source: "mic",
        },
      })

      producers[audioProducer.id] = audioProducer
      console.log("Published audio track")

      // Handle producer events
      audioProducer.on("transportclose", () => {
        console.log("Audio producer transport closed")
        delete producers[audioProducer.id]
      })

      audioProducer.on("trackended", () => {
        console.log("Audio track ended")
        audioProducer.close()
        delete producers[audioProducer.id]
      })
    }

    // Publish video track
    const videoTrack = localStream.getVideoTracks()[0]
    if (videoTrack) {
      const videoProducer = await producerTransport.produce({
        track: videoTrack,
        codecOptions: {
          videoGoogleStartBitrate: 1000,
        },
        appData: {
          source: "webcam",
        },
      })

      producers[videoProducer.id] = videoProducer
      console.log("Published video track")

      // Handle producer events
      videoProducer.on("transportclose", () => {
        console.log("Video producer transport closed")
        delete producers[videoProducer.id]
      })

      videoProducer.on("trackended", () => {
        console.log("Video track ended")
        videoProducer.close()
        delete producers[videoProducer.id]
      })
    }
  } catch (error) {
    console.error("Error publishing tracks:", error)
    notify("Error publishing your media")
  }
}

// Consume a remote track from a producer
async function consumeTrack(producerId, kind, source, peerId) {
  if (!consumerTransport) return

  try {
    const { id, producerPeerId, rtpParameters, error } = await emitSocketEvent("consume", {
      roomId: currentRoom,
      producerId,
      rtpCapabilities: device.rtpCapabilities,
    })

    if (error) {
      console.error("Error consuming track:", error)
      return
    }

    // Create consumer
    const consumer = await consumerTransport.consume({
      id,
      producerId,
      kind,
      rtpParameters,
    })

    consumers[consumer.id] = consumer

    // Store the consumer
    consumer.on("transportclose", () => {
      consumer.close()
      delete consumers[consumer.id]
    })

    // Resume the consumer
    await emitSocketEvent("consumer-resume", {
      roomId: currentRoom,
      consumerId: consumer.id,
    })

    // Get peer info
    const peer = peers.get(peerId) || {
      id: peerId,
      name: `Peer ${peerId.substring(0, 5)}...`,
    }

    // Handle different media sources
    if (source === "screen") {
      // Handle screen share
      handleScreenTrack(consumer.track, peerId, peer.name)
      peer.isScreenSharing = true
      peers.set(peerId, peer)
    } else {
      // Handle camera/mic track
      handleMediaTrack(consumer.track, kind, peerId, peer.name)
    }
  } catch (error) {
    console.error("Error consuming track:", error)
  }
}

// Handle a screen share track
function handleScreenTrack(track, peerId, peerName) {
  // Create or get screen share container
  let screenContainer = document.getElementById("screen-share-container")
  if (!screenContainer) {
    screenContainer = document.createElement("div")
    screenContainer.id = "screen-share-container"
    screenContainer.setAttribute("data-peer-id", peerId)
    document.getElementById("videos").prepend(screenContainer)
  }

  // Create video element for screen share
  const screenVideo = document.createElement("video")
  screenVideo.autoplay = true
  screenVideo.playsInline = true
  screenVideo.id = `screen-${peerId}`

  // Create a MediaStream and add the track
  const stream = new MediaStream()
  stream.addTrack(track)
  screenVideo.srcObject = stream

  // Clear previous content and add new video
  screenContainer.innerHTML = ""
  screenContainer.appendChild(screenVideo)

  // Add screen sharer's name
  const nameLabel = document.createElement("div")
  nameLabel.textContent = `${peerName}'s screen`
  nameLabel.style.position = "absolute"
  nameLabel.style.bottom = "10px"
  nameLabel.style.left = "10px"
  nameLabel.style.backgroundColor = "rgba(0, 0, 0, 0.5)"
  nameLabel.style.color = "white"
  nameLabel.style.padding = "5px 10px"
  nameLabel.style.borderRadius = "4px"
  screenContainer.appendChild(nameLabel)
}

// Handle a camera or microphone track
function handleMediaTrack(track, kind, peerId, peerName) {
  // Find existing container for this peer or create a new one
  let videoContainer = document.getElementById(`video-${peerId}`)
  let stream

  if (!videoContainer) {
    // Create new container for this peer
    const containerDiv = document.createElement("div")
    containerDiv.className = "grid-item"
    containerDiv.id = `peer-${peerId}`

    videoContainer = document.createElement("video")
    videoContainer.id = `video-${peerId}`
    videoContainer.autoplay = true
    videoContainer.playsInline = true

    const nameLabel = document.createElement("p")
    nameLabel.textContent = peerName

    // Add status indicators
    const statusContainer = document.createElement("div")
    statusContainer.className = "status-container"

    const micStatus = document.createElement("span")
    micStatus.className = "status-indicator mic-status"
    micStatus.innerHTML = "🎤"

    const cameraStatus = document.createElement("span")
    cameraStatus.className = "status-indicator camera-status"
    cameraStatus.innerHTML = "📹"

    const handStatus = document.createElement("span")
    handStatus.className = "status-indicator hand-status hidden"
    handStatus.innerHTML = "✋"

    statusContainer.appendChild(micStatus)
    statusContainer.appendChild(cameraStatus)
    statusContainer.appendChild(handStatus)

    // Add admin controls if user is admin
    if (isAdmin) {
      const controlsDiv = document.createElement("div")
      controlsDiv.className = "participant-controls"

      const muteBtn = document.createElement("button")
      muteBtn.className = "mute_btn"
      muteBtn.textContent = "Mute"
      muteBtn.addEventListener("click", () => adminMutePeer(peerId))

      const kickBtn = document.createElement("button")
      kickBtn.className = "kick_btn"
      kickBtn.textContent = "Kick"
      kickBtn.addEventListener("click", () => adminKickPeer(peerId))

      controlsDiv.appendChild(muteBtn)
      controlsDiv.appendChild(kickBtn)
      containerDiv.appendChild(controlsDiv)
    }

    containerDiv.appendChild(videoContainer)
    containerDiv.appendChild(nameLabel)
    containerDiv.appendChild(statusContainer)

    videoGrid.appendChild(containerDiv)

    // Create new stream for this peer
    stream = new MediaStream()
    videoContainer.srcObject = stream

    // Adjust grid layout
    adjustGridLayout()
  } else {
    // Use existing stream
    stream = videoContainer.srcObject
  }

  // Add track to stream
  stream.addTrack(track)
}

// Toggle microphone
async function toggleMic() {
  isAudioMuted = !isAudioMuted

  // Update local audio track
  if (localStream) {
    const audioTracks = localStream.getAudioTracks()
    audioTracks.forEach((track) => {
      track.enabled = !isAudioMuted
    })
  }

  // Update UI
  if (isAudioMuted) {
    micBtn.classList.add("active")
    micBtn.innerHTML = "🔇"
    document.querySelector("#localVideo-container .mic-status").classList.add("muted")
  } else {
    micBtn.classList.remove("active")
    micBtn.innerHTML = "🎤"
    document.querySelector("#localVideo-container .mic-status").classList.remove("muted")
  }

  // Notify server
  await emitSocketEvent("toggle-audio", {
    roomId: currentRoom,
    enabled: !isAudioMuted,
  })
}

// Toggle camera
async function toggleCamera() {
  isVideoOff = !isVideoOff

  // Update local video track
  if (localStream) {
    const videoTracks = localStream.getVideoTracks()
    videoTracks.forEach((track) => {
      track.enabled = !isVideoOff
    })
  }

  // Update UI
  if (isVideoOff) {
    cameraBtn.classList.add("active")
    cameraBtn.innerHTML = "🚫"
    document.querySelector("#localVideo-container .camera-status").classList.add("off")
  } else {
    cameraBtn.classList.remove("active")
    cameraBtn.innerHTML = "📹"
    document.querySelector("#localVideo-container .camera-status").classList.remove("off")
  }

  // Notify server
  await emitSocketEvent("toggle-video", {
    roomId: currentRoom,
    enabled: !isVideoOff,
  })
}

// Toggle raise hand
async function toggleRaiseHand() {
  isHandRaised = !isHandRaised

  // Update UI
  if (isHandRaised) {
    raiseHandBtn.classList.add("active")
    document.querySelector("#localVideo-container .hand-status").classList.remove("hidden")
  } else {
    raiseHandBtn.classList.remove("active")
    document.querySelector("#localVideo-container .hand-status").classList.add("hidden")
  }

  // Notify server
  await emitSocketEvent("toggle-hand", {
    roomId: currentRoom,
    raised: isHandRaised,
  })
}

// Toggle screen sharing
async function toggleScreenShare() {
  if (isScreenSharing) {
    // Stop screen sharing
    if (screenStream) {
      screenStream.getTracks().forEach((track) => {
        track.stop()

        // Find and close the screen share producer
        Object.entries(producers).forEach(([id, producer]) => {
          if (producer.track && producer.track.kind === "video" && producer.appData.source === "screen") {
            producer.close()
            delete producers[id]
          }
        })
      })

      screenStream = null
    }

    // Update UI
    screenShareBtn.classList.remove("active")
    screenShareBtn.innerHTML = "📊"

    // Remove screen share container for local user
    const localScreenContainer = document.getElementById("screen-share-container")
    if (localScreenContainer && localScreenContainer.getAttribute("data-peer-id") === socket.id) {
      localScreenContainer.remove()
    }

    // Notify server
    await emitSocketEvent("screen-share-ended", { roomId: currentRoom })

    isScreenSharing = false
  } else {
    // Start screen sharing
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      })

      // Create screen share container
      let screenContainer = document.getElementById("screen-share-container")
      if (!screenContainer) {
        screenContainer = document.createElement("div")
        screenContainer.id = "screen-share-container"
        screenContainer.setAttribute("data-peer-id", socket.id)
        document.getElementById("videos").prepend(screenContainer)
      }

      // Create video element for screen share
      const screenVideo = document.createElement("video")
      screenVideo.autoplay = true
      screenVideo.playsInline = true
      screenVideo.muted = true
      screenVideo.srcObject = screenStream

      // Clear previous content and add new video
      screenContainer.innerHTML = ""
      screenContainer.appendChild(screenVideo)

      // Update UI
      screenShareBtn.classList.add("active")
      screenShareBtn.innerHTML = "⏹️"

      // Publish screen track
      const videoTrack = screenStream.getVideoTracks()[0]
      if (videoTrack) {
        const screenProducer = await producerTransport.produce({
          track: videoTrack,
          codecOptions: {
            videoGoogleStartBitrate: 1000,
          },
          appData: {
            source: "screen",
          },
        })

        producers[screenProducer.id] = screenProducer

        // Handle track ended event (user clicks "Stop sharing" in browser UI)
        videoTrack.addEventListener("ended", async () => {
          screenProducer.close()
          delete producers[screenProducer.id]
          await toggleScreenShare()
        })
      }

      // Optional: Publish screen audio track if available
      const audioTrack = screenStream.getAudioTracks()[0]
      if (audioTrack) {
        const screenAudioProducer = await producerTransport.produce({
          track: audioTrack,
          codecOptions: {
            opusStereo: true,
            opusDtx: true,
          },
          appData: {
            source: "screen-audio",
          },
        })

        producers[screenAudioProducer.id] = screenAudioProducer
      }

      isScreenSharing = true
    } catch (error) {
      console.error("Error starting screen share:", error)
      screenShareBtn.classList.remove("active")
      notify("Could not start screen sharing")
    }
  }
}

// Admin actions
async function adminMutePeer(peerId) {
  if (!isAdmin) {
    notify("Only the host can mute participants")
    return
  }

  const peer = peers.get(peerId)
  if (!peer) return

  try {
    const { success, error } = await emitSocketEvent("admin-mute-peer", {
      roomId: currentRoom,
      peerId,
    })

    if (error) {
      notify(`Error muting peer: ${error}`)
    } else if (success) {
      notify(`${peer.name} has been muted`)
    }
  } catch (error) {
    console.error("Error muting peer:", error)
    notify("Error muting peer")
  }
}

async function adminKickPeer(peerId) {
  if (!isAdmin) {
    notify("Only the host can kick participants")
    return
  }

  const peer = peers.get(peerId)
  if (!peer) return

  try {
    const { success, error } = await emitSocketEvent("admin-kick-peer", {
      roomId: currentRoom,
      peerId,
    })

    if (error) {
      notify(`Error kicking peer: ${error}`)
    } else if (success) {
      notify(`${peer.name} has been removed from the room`)
    }
  } catch (error) {
    console.error("Error kicking peer:", error)
    notify("Error removing participant")
  }
}

// Utility Functions
function notify(message) {
  notification.textContent = message
  notification.classList.remove("hidden")

  // Hide notification after 5 seconds
  setTimeout(() => {
    notification.classList.add("hidden")
  }, 5000)
}

function adjustGridLayout() {
  const participantCount = videoGrid.childElementCount

  if (participantCount <= 1) {
    videoGrid.style.gridTemplateColumns = "1fr"
  } else if (participantCount === 2) {
    videoGrid.style.gridTemplateColumns = "repeat(2, 1fr)"
  } else if (participantCount <= 4) {
    videoGrid.style.gridTemplateColumns = "repeat(2, 1fr)"
  } else if (participantCount <= 9) {
    videoGrid.style.gridTemplateColumns = "repeat(3, 1fr)"
  } else {
    videoGrid.style.gridTemplateColumns = "repeat(4, 1fr)"
  }
}

// Helper function to make an element draggable
function makeDraggable(element) {
  let isDragging = false
  let currentX
  let currentY
  let initialX
  let initialY
  let xOffset = 0
  let yOffset = 0

  element.addEventListener("mousedown", dragStart)
  element.addEventListener("mouseup", dragEnd)
  element.addEventListener("mousemove", drag)
  element.addEventListener("touchstart", dragStart)
  element.addEventListener("touchend", dragEnd)
  element.addEventListener("touchmove", drag)

  function dragStart(e) {
    if (e.type === "touchstart") {
      initialX = e.touches[0].clientX - xOffset
      initialY = e.touches[0].clientY - yOffset
    } else {
      initialX = e.clientX - xOffset
      initialY = e.clientY - yOffset
    }

    isDragging = true
  }

  function dragEnd() {
    initialX = currentX
    initialY = currentY

    isDragging = false
  }

  function drag(e) {
    if (isDragging) {
      e.preventDefault()

      if (e.type === "touchmove") {
        currentX = e.touches[0].clientX - initialX
        currentY = e.touches[0].clientY - initialY
      } else {
        currentX = e.clientX - initialX
        currentY = e.clientY - initialY
      }

      xOffset = currentX
      yOffset = currentY

      setTranslate(currentX, currentY, element)
    }
  }

  function setTranslate(xPos, yPos, el) {
    el.style.transform = `translate3d(${xPos}px, ${yPos}px, 0)`
  }
}

// Helper function to emit socket events with promise
function emitSocketEvent(eventName, data) {
  return new Promise((resolve) => {
    socket.emit(eventName, data, (response) => {
      resolve(response)
    })
  })
}

// Add admin controls to all peers
function addAdminControlsToPeers() {
  peers.forEach((peer, peerId) => {
    const peerContainer = document.getElementById(`peer-${peerId}`)
    if (!peerContainer) return

    // Check if controls already exist
    if (peerContainer.querySelector(".participant-controls")) return

    const controlsDiv = document.createElement("div")
    controlsDiv.className = "participant-controls"

    const muteBtn = document.createElement("button")
    muteBtn.className = "mute_btn"
    muteBtn.textContent = "Mute"
    muteBtn.addEventListener("click", () => adminMutePeer(peerId))

    const kickBtn = document.createElement("button")
    kickBtn.className = "kick_btn"
    kickBtn.textContent = "Kick"
    kickBtn.addEventListener("click", () => adminKickPeer(peerId))

    controlsDiv.appendChild(muteBtn)
    controlsDiv.appendChild(kickBtn)
    peerContainer.appendChild(controlsDiv)
  })
}

// Initialize the application when the DOM is loaded
document.addEventListener("DOMContentLoaded", init)

