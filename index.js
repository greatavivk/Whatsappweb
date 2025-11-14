#!/usr/bin/env node
/**
 * Simple WhatsApp CLI using Baileys.
 * Handles authentication, reconnection, incoming messages, and manual sending.
 */

// Use CommonJS require syntax for imports.
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const readline = require("readline");

// Folder used to persist multi-file authentication state between runs.
const AUTH_FOLDER = "auth";

// Track the active socket and CLI state globally so we can reuse them on reconnects.
let sock;
let cliInterface;
let cliStarted = false;
let authState;
let saveCreds;
let isShuttingDown = false;

/**
 * Extract a human-readable text message from the Baileys message object.
 * Returns null when the message does not contain a textual body we want to log.
 */
function getMessageText(message) {
  if (!message?.message) {
    return null;
  }

  const msg = message.message;
  const text =
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.templateButtonReplyMessage?.selectedId ||
    null;

  if (typeof text === "string" && text.trim().length > 0) {
    return text.trim();
  }

  return null;
}

/**
 * Print the CLI help instructions.
 */
function printHelp() {
  console.log("\nWhatsApp CLI commands:");
  console.log("  /msg <phone_number> <message>  Send a WhatsApp message");
  console.log("  /help                        Show this help message");
  console.log("  /quit                        Close the connection and exit");
  console.log("  Ctrl+C                       Quit immediately\n");
}

/**
 * Gracefully close the CLI and the socket.
 */
async function shutdown() {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log("\nShutting down...");
  try {
    if (cliInterface) {
      cliInterface.close();
    }
    if (sock?.ws) {
      // Close the WebSocket without logging out so credentials remain valid.
      sock.ws.close();
    }
  } catch (err) {
    console.error("Error while closing connection:", err?.message || err);
  } finally {
    process.exit(0);
  }
}

/**
 * Parse and execute CLI commands.
 */
async function handleUserInput(line) {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  if (trimmed === "/help") {
    printHelp();
    return;
  }

  if (trimmed === "/quit") {
    await shutdown();
    return;
  }

  if (trimmed.startsWith("/msg ")) {
    const parts = trimmed.split(" ");
    if (parts.length < 3) {
      console.log("Usage: /msg <phone_number> <message>");
      return;
    }

    const phoneNumber = parts[1];
    const messageText = trimmed.substring(trimmed.indexOf(phoneNumber) + phoneNumber.length).trim();

    if (!phoneNumber || !messageText) {
      console.log("Usage: /msg <phone_number> <message>");
      return;
    }

    if (!sock) {
      console.log("Socket is not ready yet. Please wait for the connection to open.");
      return;
    }

    const jid = `${phoneNumber}@s.whatsapp.net`;

    try {
      await sock.sendMessage(jid, { text: messageText });
      console.log(`Message sent to ${phoneNumber}`);
    } catch (err) {
      console.error(`Failed to send message to ${phoneNumber}:`, err?.message || err);
    }
    return;
  }

  console.log('Unknown command. Type /help to see available commands.');
}

/**
 * Start listening for user input once the connection is open.
 */
function startCLI() {
  if (cliStarted) {
    return;
  }

  cliStarted = true;
  cliInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> "
  });

  printHelp();
  cliInterface.prompt();

  cliInterface.on("line", async line => {
    await handleUserInput(line);
    cliInterface.prompt();
  });

  cliInterface.on("close", () => {
    // When readline closes (e.g., Ctrl+D), shut down gracefully.
    shutdown();
  });

  process.on("SIGINT", () => {
    // Handle Ctrl+C to exit cleanly.
    shutdown();
  });
}

/**
 * Set up listeners for receiving incoming messages.
 */
function setupMessageListener(currentSock) {
  currentSock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") {
      return;
    }

    for (const message of messages) {
      if (!message || message.key.fromMe) {
        continue; // Ignore messages sent by ourselves.
      }

      const remoteJid = message.key.remoteJid || "unknown";
      const text = getMessageText(message);

      if (!text) {
        continue; // Skip non-text/system messages.
      }

      const phoneNumber = remoteJid.replace(/@s\.whatsapp\.net$/, "");
      console.log(`New message from ${phoneNumber}: ${text}`);
    }
  });
}

/**
 * Handle updates to the connection state, including QR display and reconnection logic.
 */
function setupConnectionListener(currentSock) {
  currentSock.ev.on("connection.update", async update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Scan the QR code to link your WhatsApp account:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("Connected to WhatsApp! You can start sending messages.");
      startCLI();
    }

    if (connection === "close") {
      if (isShuttingDown) {
        return;
      }

      const error = lastDisconnect?.error;
      const statusCode = error?.output?.statusCode || error?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        console.error("Connection closed: logged out from WhatsApp. Delete the 'auth' folder and run again.");
        await shutdown();
        return;
      }

      console.warn("Connection closed. Attempting to reconnect...");
      try {
        await startSocket();
      } catch (err) {
        console.error("Failed to reconnect:", err?.message || err);
      }
    }
  });
}

/**
 * Initialize Baileys socket and attach event listeners.
 */
async function startSocket() {
  if (sock?.ev) {
    try {
      sock.ev.removeAllListeners();
    } catch (err) {
      console.error("Failed to clean up previous listeners:", err?.message || err);
    }
  }

  if (!authState || !saveCreds) {
    const auth = await useMultiFileAuthState(AUTH_FOLDER);
    authState = auth.state;
    saveCreds = auth.saveCreds;
  }

  sock = makeWASocket({
    auth: authState,
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  setupMessageListener(sock);
  setupConnectionListener(sock);
}

(async () => {
  try {
    await startSocket();
  } catch (err) {
    console.error("Failed to start WhatsApp CLI:", err?.message || err);
    process.exit(1);
  }
})();
