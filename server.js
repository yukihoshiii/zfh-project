const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ngrok = require('ngrok');
const path = require('path');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = crypto.randomUUID();
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

const app = express();
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static('public', {
    setHeaders: (res, path) => {
        if (path.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));

app.post('/api/deleteMessage', (req, res) => {
    const { messageId, channel } = req.body;
    const sessionId = req.headers.authorization;
    const username = sessions.get(sessionId);
    const user = users.get(username);

    console.log('Delete message request:', {
        messageId: messageId,
        messageIdType: typeof messageId,
        channel,
        username,
        userRole: user?.role
    });

    if (!username) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized'
        });
    }

    const channelMessages = messages.get(channel);
    if (!channelMessages) {
        console.log('Channel not found:', channel);
        return res.json({
            success: false,
            message: 'Channel not found'
        });
    }

    console.log('All channel messages:', channelMessages.map(msg => ({
        timestamp: msg.timestamp,
        timestampType: typeof msg.timestamp,
        type: msg.type,
        author: msg.author,
        content: msg.content?.substring(0, 50)
    })));

    const messageIndex = channelMessages.findIndex(msg => {
        const msgTimestamp = Number(msg.timestamp);
        const targetTimestamp = Number(messageId);
        const timestampDiff = Math.abs(msgTimestamp - targetTimestamp);
        
        console.log('Comparing timestamps:', {
            msgTimestamp,
            targetTimestamp,
            diff: timestampDiff,
            match: timestampDiff < 1000
        });
        
        return timestampDiff < 1000;
    });

    console.log('Found message index:', messageIndex);

    if (messageIndex === -1) {
        return res.json({
            success: false,
            message: 'Message not found'
        });
    }

    const message = channelMessages[messageIndex];
    console.log('Found message:', message);

    if (message.author !== username && user.role !== 'admin') {
        return res.json({
            success: false,
            message: 'Permission denied'
        });
    }


    channelMessages.splice(messageIndex, 1);
    messages.set(channel, channelMessages);
    saveMessages();

    broadcast({
        type: 'messageDeleted',
        messageId: messageId,
        channel: channel
    }, channel);

    res.json({
        success: true,
        message: 'Message deleted'
    });
});

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

const server = http.createServer(app);

const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: false,
    clientTracking: true
});

const DATA_DIR = __dirname;
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');

let users = new Map();
let channels = new Set(['Home', 'general']);
let messages = new Map();
const sessions = new Map();

const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
}

function saveData(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`Error saving ${file}:`, error);
    }
}

function loadData(file, defaultValue) {
    try {
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            console.log(`Loaded data from ${file}:`, data);
            
            if (file === CHANNELS_FILE && data.channels) {
                return data.channels;
            }
            
            return data; 
        } else {
            console.log(`File ${file} does not exist, using default value`);
            return defaultValue;
        }
    } catch (error) {
        console.error(`Error loading ${file}:`, error);
        return defaultValue;
    }
}

function initializeData() {
    try {
        const usersData = loadData(USERS_FILE, {});
        users = new Map(Object.entries(usersData));
        console.log('Loaded users:', users.size);

        const channelsData = loadData(CHANNELS_FILE, ['Home', 'general']);
        channels = new Set(channelsData);
        console.log('Loaded channels:', channels.size);

        const messagesData = loadData(MESSAGES_FILE, {});
        console.log('Loaded messages data:', messagesData);
        messages = new Map(Object.entries(messagesData));
        console.log('Loaded messages:', messages.size);

        if (!messages.has('Home')) {
            messages.set('Home', []);
        }
        if (!messages.has('general')) {
            messages.set('general', []);
        }

    } catch (error) {
        console.error('Error initializing data:', error);
    }
}

initializeData();

function saveChannels() {
    try {
        const channelsData = {
            channels: Array.from(channels)
        };
        saveData(CHANNELS_FILE, channelsData);
        console.log('Channels saved successfully');
    } catch (error) {
        console.error('Error saving channels:', error);
    }
}

function saveMessages() {
    try {
        const messagesObject = Object.fromEntries(messages);
        console.log('Saving messages:', messagesObject);
        saveData(MESSAGES_FILE, messagesObject);
        console.log('Messages saved successfully');
    } catch (error) {
        console.error('Error saving messages:', error);
    }
}

function saveUsers() {
    try {
        const usersObject = Object.fromEntries(users);
        saveData(USERS_FILE, usersObject);
        console.log('Users saved successfully');
    } catch (error) {
        console.error('Error saving users:', error);
    }
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function getHelpMessage(role) {
    const commands = [
        '/roll - Roll dice (1-100)',
        '/tableflip - Flip table',
        '/unflip - Unflip table',
        '/shrug - Shrug',
        '/help - Show this message'
    ];

    if (role === 'admin') {
        commands.push(
            '/kick <user> - Kick user',
            '/ban <user> - Ban user',
            '/mute <user> - Mute user',
            '/unmute <user> - Unmute user'
        );
    }

    return 'Available commands:\n' + commands.join('\n');
}

function sendChannelsList(ws) {
    const username = ws.username;
    const channelsList = Array.from(channels).filter(channel => {
        if (!channel.includes('-')) {
            return true;
        }
        const [user1, user2] = channel.split('-');
        return user1 === username || user2 === username;
    });

    channelsList.forEach(channel => {
        ws.send(JSON.stringify({
            type: 'channelCreated',
            channelName: channel
        }));
    });
}

function broadcast(message, channel) {
    console.log('Broadcasting message:', message, 'to channel:', channel);
    
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            if (!channel || client.channel === channel) {
                console.log('Sending to client:', client.username);
                client.send(JSON.stringify(message));
            }
        }
    });
}

function handleCommand(command, ws, channel) {
    const args = command.slice(1).split(' ');
    const cmd = args.shift().toLowerCase();
    const user = users.get(ws.username);

    switch (cmd) {
        case 'help':
            ws.send(JSON.stringify({
                type: 'message',
                message: getHelpMessage(user.role),
                author: 'System',
                channel
            }));
            break;

        case 'roll':
            const roll = Math.floor(Math.random() * 100) + 1;
            broadcast({
                type: 'message',
                message: `🎲 ${ws.username} rolls ${roll} (1-100)`,
                author: 'System',
                channel
            }, channel);
            break;

        case 'tableflip':
            broadcast({
                type: 'message',
                message: `${ws.username}: (╯°□°）╯︵ ┻━┻`,
                author: 'System',
                channel
            }, channel);
            break;

        case 'unflip':
            broadcast({
                type: 'message',
                message: `${ws.username}: ┬─┬ ノ( ゜-゜ノ)`,
                author: 'System',
                channel
            }, channel);
            break;

        case 'shrug':
            broadcast({
                type: 'message',
                message: `${ws.username}: ¯\\_(ツ)_/¯`,
                author: 'System',
                channel
            }, channel);
            break;

        case 'kick':
        case 'ban':
        case 'mute':
        case 'unmute':
            if (user.role !== 'admin') {
                ws.send(JSON.stringify({
                    type: 'message',
                    message: 'Only administrators can use this command',
                    author: 'System',
                    channel
                }));
                return;
            }
            ws.send(JSON.stringify({
                type: 'message',
                message: 'This command is not implemented yet',
                author: 'System',
                channel
            }));
            break;

        default:
            ws.send(JSON.stringify({
                type: 'message',
                message: 'Unknown command. Type /help for available commands.',
                author: 'System',
                channel
            }));
    }
}

function handleFileUpload(fileData, filename, ws, channel) {
    console.log('Handling file upload:', filename);
    
    const fileId = crypto.randomUUID();
    const fileExt = path.extname(filename);
    const newFilename = `${fileId}${fileExt}`;
    const filePath = path.join(UPLOADS_DIR, newFilename);

    try {
        console.log('Saving file to:', filePath); 
        const buffer = Buffer.from(fileData, 'base64');
        fs.writeFileSync(filePath, buffer);

        const timestamp = Date.now();
        
        const channelMessages = messages.get(channel) || [];
        const newMessage = {
            author: ws.username,
            content: `FILE:${newFilename}:${filename}`,
            timestamp: timestamp,
            type: 'file'
        };
        channelMessages.push(newMessage);
        messages.set(channel, channelMessages);
        saveMessages();

        console.log('Broadcasting file message'); 
        broadcast({
            type: 'file',
            filename: filename,
            fileId: newFilename,
            author: ws.username,
            channel: channel,
            timestamp: timestamp
        }, channel);

    } catch (error) {
        console.error('Error saving file:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to save file'
        }));
    }
}

function handleAuthentication(ws, username, ip) {
    const user = users.get(username);
    if (user) {
        if (!user.knownIps) {
            user.knownIps = [];
        }
        
        if (!user.knownIps.includes(ip)) {
            console.log(`Adding new IP ${ip} for user ${username}`);
            user.knownIps.push(ip);
        }
        
        user.lastIp = ip;
        user.lastSeen = new Date().toISOString();
        saveUsers();
    }
}

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    const ip = req.headers['x-forwarded-for'] || 
               req.connection.remoteAddress || 
               req.socket.remoteAddress;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Missing username or password' });
    }

    if (users.has(username)) {
        return res.status(400).json({ success: false, message: 'Username already exists' });
    }

    const hashedPassword = hashPassword(password);
    users.set(username, {
        password: hashedPassword,
        role: username === 'admin' ? 'admin' : 'user',
        lastIp: ip,
        knownIps: [ip],
        lastSeen: new Date().toISOString(),
        registeredAt: new Date().toISOString()
    });

    saveUsers();

    res.json({ success: true });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.get(username);

    if (!user || user.password !== hashPassword(password)) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, username);

    res.json({ 
        success: true, 
        sessionId, 
        role: user.role,
        channels: Array.from(channels)
    });
});

app.post('/api/channels', (req, res) => {
    const { channelName, sessionId } = req.body;
    const username = sessions.get(sessionId);
    const user = users.get(username);

    if (!username || user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (channels.has(channelName)) {
        return res.status(400).json({ success: false, message: 'Channel already exists' });
    }

    channels.add(channelName);
    messages.set(channelName, []);
    saveChannels();
    saveMessages();

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'channelCreated',
                channelName
            }));
        }
    });

    res.json({ success: true, channelName });
});

app.post('/api/messages', (req, res) => {
    const { message, channel, sessionId } = req.body;
    const username = sessions.get(sessionId);

    if (!username) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const channelMessages = messages.get(channel) || [];
    const newMessage = {
        author: username,
        content: message,
        timestamp: Date.now()
    };
    channelMessages.push(newMessage);
    messages.set(channel, channelMessages);
    saveMessages();

    broadcast({
        type: 'message',
        message,
        author: username,
        channel
    }, channel);

    res.json({ success: true });
});

app.get('/api/messages/:channel', (req, res) => {
    const { channel } = req.params;
    const { sessionId } = req.query;
    const username = sessions.get(sessionId);

    if (!username) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    if (channel.includes('-')) {
        const [user1, user2] = channel.split('-');
        if (user1 !== username && user2 !== username) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }
    }

    const channelMessages = messages.get(channel) || [];
    res.json({ messages: channelMessages });
});

app.get('/uploads/:fileId', (req, res) => {
    const { fileId } = req.params;
    const filePath = path.join(UPLOADS_DIR, fileId);
    
    console.log('Requested file:', fileId);
    console.log('File path:', filePath);
    
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        console.log('File not found:', filePath);
        res.status(404).send('File not found');
    }
});

app.post('/api/auto-login', (req, res) => {
    const { ip } = req.body;
    
    let foundUser = null;
    let foundUsername = null;
    
    for (const [username, userData] of users.entries()) {
        if (userData.knownIps && userData.knownIps.includes(ip)) {
            foundUser = userData;
            foundUsername = username;
            break;
        }
    }
    
    if (foundUser) {
        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, foundUsername);
        
        foundUser.lastSeen = new Date().toISOString();
        foundUser.lastIp = ip;
        saveUsers();
        
        res.json({
            success: true,
            sessionId,
            username: foundUsername,
            role: foundUser.role,
            channels: Array.from(channels)
        });
    } else {
        res.json({ success: false });
    }
});

app.post('/api/private-chat', (req, res) => {
    const { targetUser, sessionId } = req.body;
    const username = sessions.get(sessionId);

    if (!username) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    if (!users.has(targetUser)) {
        return res.status(404).json({ success: false, message: 'User not found' });
    }

    const chatId = [username, targetUser].sort().join('-');
    if (!channels.has(chatId)) {
        channels.add(chatId);
        messages.set(chatId, []);
        saveChannels();
        saveMessages();
    }

    res.json({ success: true, chatId });
});

app.post('/api/logout', (req, res) => {
    console.log('Logout request received');
    const { sessionId } = req.body;
    
    if (sessionId) {
        sessions.delete(sessionId);
    }
    
    res.json({ success: true });
});

app.post('/api/messages/delete', (req, res) => {
    console.log('Received delete request:', req.body);
    
    const { messageId, channel, sessionId } = req.body;
    const username = sessions.get(sessionId);
    const user = users.get(username);

    if (!username) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const channelMessages = messages.get(channel);
    if (!channelMessages) {
        return res.status(404).json({ success: false, message: 'Channel not found' });
    }

    const messageIdNum = Number(messageId);
    console.log('Looking for message with timestamp:', messageIdNum);
    
    console.log('Channel messages:', channelMessages.map(msg => ({
        timestamp: msg.timestamp,
        type: msg.type,
        content: msg.content
    })));
    
    const messageIndex = channelMessages.findIndex(msg => {
        if (msg.type === 'file') {
            return msg.timestamp === messageIdNum;
        }
        return msg.timestamp === messageIdNum;
    });
    
    if (messageIndex === -1) {
        return res.status(404).json({ 
            success: false, 
            message: 'Message not found',
            debug: {
                messageId: messageIdNum,
                channelMessages: channelMessages.map(m => ({
                    timestamp: m.timestamp,
                    type: m.type,
                    content: m.content
                }))
            }
        });
    }

    const message = channelMessages[messageIndex];
    
    if (user.role !== 'admin' && message.author !== username) {
        return res.status(403).json({ success: false, message: 'Permission denied' });
    }

    if (message.type === 'file') {
        try {
            const fileId = message.content.split(':')[1];
            const filePath = path.join(__dirname, 'public', 'uploads', fileId);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log('File deleted:', filePath);
            }
        } catch (error) {
            console.error('Error deleting file:', error);
        }
    }


    channelMessages.splice(messageIndex, 1);
    messages.set(channel, channelMessages);
    saveMessages();


    const deleteNotification = {
        type: 'messageDeleted',
        messageId: message.timestamp,
        channel: channel
    };
    
    console.log('Sending delete notification:', deleteNotification);
    broadcast(deleteNotification, channel);

    res.json({ success: true });
});

wss.on('connection', (ws, req) => {
    console.log('Client connected to WebSocket');

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'auth':
                    if (message.sessionId) {
                        const username = sessions.get(message.sessionId);
                        if (!username) {
                            console.log('Auth failed - invalid session');
                            ws.send(JSON.stringify({
                                type: 'auth',
                                success: false,
                                message: 'Invalid session'
                            }));
                            return;
                        }

                        const user = users.get(username);
                        if (!user) {
                            console.log('Auth failed - user not found for session');
                            ws.send(JSON.stringify({
                                type: 'auth',
                                success: false,
                                message: 'User not found'
                            }));
                            return;
                        }

                        ws.sessionId = message.sessionId;
                        ws.username = username;

                        const ip = req.headers['x-forwarded-for'] || 
                                 req.connection.remoteAddress || 
                                 req.socket.remoteAddress;
                        
                        console.log(`Successful session auth for ${username} from IP ${ip}`);
                        handleAuthentication(ws, username, ip);

                        ws.send(JSON.stringify({
                            type: 'auth',
                            success: true,
                            role: user.role,
                            sessionId: message.sessionId
                        }));

                        sendChannelsList(ws);
                        return;
                    }

                    if (!message.username || !message.password) {
                        console.log('Auth failed - missing credentials');
                        ws.send(JSON.stringify({
                            type: 'auth',
                            success: false,
                            message: 'Missing username or password'
                        }));
                        return;
                    }

                    const user = users.get(message.username);
                    console.log('Auth attempt for user:', message.username);
                    console.log('Found user data:', user);

                    if (!user || user.password !== hashPassword(message.password)) {
                        console.log('Auth failed - invalid credentials');
                        ws.send(JSON.stringify({
                            type: 'auth',
                            success: false,
                            message: 'Invalid username or password'
                        }));
                        return;
                    }

                    const sessionId = crypto.randomUUID();
                    sessions.set(sessionId, message.username);
                    ws.sessionId = sessionId;
                    ws.username = message.username;

                    const ip = req.headers['x-forwarded-for'] || 
                              req.connection.remoteAddress || 
                              req.socket.remoteAddress;
                    
                    console.log(`Successful credentials auth for ${message.username} from IP ${ip}`);
                    handleAuthentication(ws, message.username, ip);

                    ws.send(JSON.stringify({
                        type: 'auth',
                        success: true,
                        role: user.role,
                        sessionId: sessionId
                    }));

                    sendChannelsList(ws);
                    break;

                case 'register':
                    if (!message.username || !message.password) {
                        ws.send(JSON.stringify({
                            type: 'register',
                            success: false,
                            message: 'Missing username or password'
                        }));
                        return;
                    }

                    if (users.has(message.username)) {
                        ws.send(JSON.stringify({
                            type: 'register',
                            success: false,
                            message: 'Username already exists'
                        }));
                        return;
                    }

                    const hashedPassword = hashPassword(message.password);
                    users.set(message.username, {
                        password: hashedPassword,
                        role: message.username === 'admin' ? 'admin' : 'user'
                    });

                    saveUsers();

                    ws.send(JSON.stringify({
                        type: 'register',
                        success: true
                    }));
                    break;

                case 'joinChannel':
                    ws.channel = message.channel;
                    console.log(`Client ${ws.username} joined channel: ${ws.channel}`);
                    break;

                case 'message':
                    if (!ws.username) break;
                    
                    const timestamp = message.timestamp || Date.now();
                    console.log('Using timestamp from client:', timestamp);
                    
                    const newMessage = {
                        author: ws.username,
                        content: message.message,
                        timestamp: timestamp
                    };
                    
                    const channelMessages = messages.get(message.channel) || [];
                    channelMessages.push(newMessage);
                    messages.set(message.channel, channelMessages);
                    saveMessages();
                    
                    ws.channel = message.channel;
                    
                    broadcast({
                        type: 'message',
                        message: newMessage.content,
                        author: newMessage.author,
                        timestamp: timestamp,
                        channel: message.channel
                    }, message.channel);
                    break;

                case 'createChannel':
                    console.log('Create channel request from:', ws.username);
                    if (!ws.sessionId || !sessions.has(ws.sessionId)) {
                        console.log('Create channel failed - not authenticated');
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Not authenticated'
                        }));
                        return;
                    }

                    const user_role = users.get(ws.username).role;
                    console.log('User role for channel creation:', user_role);

                    if (user_role !== 'admin') {
                        console.log('Create channel failed - not admin');
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Only admins can create channels'
                        }));
                        return;
                    }

                    if (channels.has(message.channelName)) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Channel already exists'
                        }));
                        return;
                    }

                    channels.add(message.channelName);
                    messages.set(message.channelName, []);
                    saveChannels();
                    saveMessages();

                    console.log('Channel created:', message.channelName);
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'channelCreated',
                                channelName: message.channelName
                            }));
                        }
                    });
                    break;

                case 'command':
                    if (!ws.sessionId || !sessions.has(ws.sessionId)) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Not authenticated'
                        }));
                        return;
                    }

                    handleCommand(message.message, ws, message.channel);
                    break;

                case 'file':
                    console.log('Processing file message'); 
                    if (!ws.sessionId || !sessions.has(ws.sessionId)) {
                        console.log('File upload rejected: not authenticated'); 
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Not authenticated'
                        }));
                        return;
                    }

                    handleFileUpload(
                        message.fileData,
                        message.filename,
                        ws,
                        message.channel
                    );
                    break;

                case 'logout':
                    if (ws.sessionId) {
                        sessions.delete(ws.sessionId);
                        ws.sessionId = null;
                        ws.username = null;
                        ws.send(JSON.stringify({
                            type: 'logout',
                            success: true
                        }));
                    }
                    break;
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
            console.error('Raw message data:', data.toString());
        }
    });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
    server.listen(PORT, async () => {
        console.log(`Server running on http://localhost:${PORT}`);
        try {
            const url = await ngrok.connect({
                addr: PORT,
                proto: 'http'
            });
            console.log(`Ngrok tunnel opened at: ${url}`);
        } catch (error) {
            console.error('Could not start ngrok:', error);
        }
    });
}

startServer();

app.get('/client.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'public', 'client.js'));
});

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


const defaultAvatarDir = path.join(__dirname, 'public', 'uploads', 'avatars');
const defaultAvatarPath = path.join(defaultAvatarDir, 'default-avatar.jpg');


const avatarStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (!fs.existsSync(defaultAvatarDir)) {
            fs.mkdirSync(defaultAvatarDir, { recursive: true });
        }
        cb(null, defaultAvatarDir);
    },
    filename: function (req, file, cb) {
        const sessionId = req.headers.authorization;
        const username = sessions.get(sessionId);
        
        if (!username) {
            return cb(new Error('Пользователь не авторизован'));
        }


        const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
        cb(null, `${username}${ext}`);
    }
});


app.get('/uploads/avatars/:username', (req, res) => {
    const username = req.params.username.replace(/\.[^/.]+$/, ""); 
    const possibleAvatars = [
        path.join(defaultAvatarDir, `${username}.jpg`),
        path.join(defaultAvatarDir, `${username}.png`)
    ];
    

    const existingAvatar = possibleAvatars.find(p => fs.existsSync(p));
    
    if (existingAvatar) {
        const ext = path.extname(existingAvatar);
        res.setHeader('Content-Type', ext === '.png' ? 'image/png' : 'image/jpeg');
        res.sendFile(existingAvatar);
    } else {
        console.log('Avatar not found, sending default');
        res.setHeader('Content-Type', 'image/png');
        res.sendFile(defaultAvatarPath);
    }
});


const avatarUpload = multer({
    storage: avatarStorage,
    limits: {
        fileSize: 5 * 1024 * 1024 
    },
    fileFilter: function(req, file, cb) {

        if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
            cb(null, true);
        } else {
            cb(new Error('Только JPG и PNG файлы разрешены'), false);
        }
    }
}).single('avatar');


if (!fs.existsSync(defaultAvatarDir)) {
    fs.mkdirSync(defaultAvatarDir, { recursive: true });
}

if (!fs.existsSync(defaultAvatarPath)) {
    try {

        const width = 100;
        const height = 100;
        

        const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        

        const IHDR = Buffer.from([
            0x00, 0x00, 0x00, 0x0D, 
            0x49, 0x48, 0x44, 0x52, 
            0x00, 0x00, 0x00, 0x64, 
            0x00, 0x00, 0x00, 0x64, 
            0x08, 
            0x02, 
            0x00, 
            0x00, 
            0x00  
        ]);
                const pixelData = Buffer.alloc(width * height * 3, 0);
        for (let i = 0; i < pixelData.length; i += 3) {
            pixelData[i] = 0x1a; 
            pixelData[i + 1] = 0x47; 
            pixelData[i + 2] = 0x2a; 
        }
        
        const fileStream = fs.createWriteStream(defaultAvatarPath);
        fileStream.write(pngSignature);
        fileStream.write(IHDR);
        fileStream.write(Buffer.from([0x00, 0x00, 0x00, 0x00])); 
        fileStream.write(Buffer.from([0x00, 0x00, 0x30, 0x00])); 
        fileStream.write(Buffer.from([0x49, 0x44, 0x41, 0x54])); 
        fileStream.write(pixelData);
        fileStream.write(Buffer.from([0x00, 0x00, 0x00, 0x00])); 
        fileStream.write(Buffer.from([
            0x00, 0x00, 0x00, 0x00, 
            0x49, 0x45, 0x4E, 0x44, 
            0xAE, 0x42, 0x60, 0x82  
        ]));
        fileStream.end();
        
        console.log('Default avatar created at:', defaultAvatarPath);
    } catch (error) {
        console.error('Error creating default avatar:', error);

        fs.writeFileSync(defaultAvatarPath, '');
    }
}


app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));


app.get('/uploads/avatars/:filename', (req, res) => {
    const filename = req.params.filename;
    const avatarPath = path.join(defaultAvatarDir, filename);
    
    console.log('Requesting avatar:', filename);
    console.log('Avatar path:', avatarPath);
    
    if (fs.existsSync(avatarPath)) {
        res.sendFile(avatarPath);
    } else {
        console.log('Avatar not found, sending default');
        res.sendFile(defaultAvatarPath);
    }
});


app.post('/api/upload-avatar', (req, res) => {
    avatarUpload(req, res, function (err) {
        if (err) {
            console.error('Ошибка загрузки файла:', err);
            return res.status(400).json({
                success: false,
                message: err.message || 'Ошибка загрузи файла'
            });
        }

        const sessionId = req.headers.authorization;
        const username = sessions.get(sessionId);

        console.log('Upload request for user:', username);

        if (!username) {
            return res.status(401).json({
                success: false,
                message: 'Не авторизован'
            });
        }

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Файл не бл загружен'
            });
        }

        console.log('File uploaded:', req.file);


        const user = users.get(username);
        if (user) {
            user.hasAvatar = true;
            saveUsers();
        }

        res.json({
            success: true,
            message: 'Аватар успешно загружен',
            avatarUrl: `/uploads/avatars/${username}.jpg?t=${Date.now()}`
        });
    });
});


app.post('/api/change-password', (req, res) => {
    const { newPassword, sessionId } = req.body;
    const username = sessions.get(sessionId);

    if (!username) {
        return res.status(401).json({
            success: false,
            message: 'Не авторизован'
        });
    }

    if (!newPassword) {
        return res.status(400).json({
            success: false,
            message: 'Новый пароль не указан'
        });
    }

    try {
        const user = users.get(username);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Пользователь не найден'
            });
        }


        user.password = hashPassword(newPassword);
        users.set(username, user);
        saveUsers();

        res.json({
            success: true,
            message: 'Пароль успешно изменен'
        });
    } catch (error) {
        console.error('Ошибка при смене пароля:', error);
        res.status(500).json({
            success: false,
            message: 'Внутренняя ошибка сервера'
        });
    }
});


app.get('/api/messages/:channel/last5', (req, res) => {
    const { channel } = req.params;
    const channelMessages = messages.get(channel) || [];
    

    const allMessages = [...channelMessages];
    
    console.log(`Channel ${channel} messages:`, {
        total: allMessages.length,
        messages: allMessages.map(m => ({
            timestamp: m.timestamp,
            author: m.author,
            content: m.content.substring(0, 20) + '...' 
        }))
    });
    
    res.json({
        success: true,
        messages: allMessages
    });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const sessionId = req.headers.authorization;
        const username = sessions.get(sessionId);
        const channel = req.body.channel || 'general';

        if (!username) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const fileMessage = {
            type: 'file',
            content: `FILE:${req.file.filename}:${req.file.originalname}`,
            author: username,
            channel: channel,
            timestamp: Date.now(),
            isFile: true
        };


        if (!messages.has(channel)) {
            messages.set(channel, []);
        }
        messages.get(channel).push(fileMessage);
        saveMessages();


        broadcast(fileMessage, channel);

        res.json({
            success: true,
            message: 'File uploaded successfully',
            fileUrl: `/uploads/${req.file.filename}`
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});
