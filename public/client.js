let socket = null;
let currentUser = null;
let currentRole = null;
let currentChannel = 'general';
let scanning = false;
let sessionId = null;
let channels = new Set();
let checkMessagesInterval = null;

const authOverlay = document.getElementById('authOverlay');
const authForm = document.getElementById('authForm');
const registerBtn = document.getElementById('registerBtn');
const messagesContainer = document.getElementById('messages');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const channelList = document.getElementById('channelList');
const createChannelBtn = document.getElementById('createChannelBtn');
const connectionStatus = document.getElementById('connection-status');

async function makeRequest(url, method = 'GET', body = null) {
    try {
        const headers = {
            'Content-Type': 'application/json'
        };
        if (sessionId) {
            headers['Authorization'] = sessionId;
        }
        
        const config = {
            method,
            headers
        };
        
        if (body) {
            config.body = JSON.stringify(body);
        }
        
        const response = await fetch(url, config);
        

        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            return await response.json();
        } else {

            return {
                success: response.ok,
                status: response.status,
                message: response.statusText
            };
        }
    } catch (error) {
        console.error('Request error:', error);
        return {
            success: false,
            message: error.message
        };
    }
}

function updateConnectionStatus(status, error = false) {
    if (connectionStatus) {
        connectionStatus.textContent = status;
        connectionStatus.className = error ? 'error' : 'connected';
    }
}

async function tryConnect(ip) {
    return new Promise((resolve) => {
        try {
            console.log(`Attempting to connect to ${ip}...`);
            const ws = new WebSocket(`ws://${ip}:3000`);
            
            const timeout = setTimeout(() => {
                ws.close();
                console.log(`Connection timeout for ${ip}`);
                resolve(false);
            }, 1500);

            ws.onopen = () => {
                clearTimeout(timeout);
                console.log(`Successfully connected to ${ip}`);
                ws.close();
                resolve(ip);
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                console.log(`Connection error for ${ip}`);
                resolve(false);
            };
        } catch (error) {
            console.log(`Connection failed for ${ip}:`, error);
            resolve(false);
        }
    });
}

function logWithTimestamp(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
    if (data) {
        console.log(data);
    }
}

async function scanNetwork() {
    logWithTimestamp('Starting network scan');
    logWithTimestamp('Current location:', {
        hostname: window.location.hostname,
        protocol: window.location.protocol,
        port: window.location.port,
        href: window.location.href
    });

    if (window.location.hostname.includes('ngrok')) {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        logWithTimestamp('Attempting ngrok connection to:', wsUrl);
        
        try {
            await connectToServer(null, wsUrl);
        } catch (error) {
            logWithTimestamp('Ngrok connection failed:', error);
            updateConnectionStatus('Ngrok connection error', true);
        }
        return;
    }

    if (scanning) return;
    scanning = true;
    
    updateConnectionStatus('Scanning network...');
    console.log('Starting network scan...');

    const knownServerIP = '10.0.1.53';
    console.log('Trying known server IP:', knownServerIP);
    const directConnection = await tryConnect(knownServerIP);
    if (directConnection) {
        scanning = false;
        connectToServer(directConnection);
        return;
    }

    const networkBases = ['10.0.1'];
    const batchSize = 5;
    const maxLastOctet = 100;

    for (const networkBase of networkBases) {
        if (!scanning) break;

        const startPoints = [
            { start: 50, end: 55 },
            { start: 0, end: 49 },   
            { start: 56, end: maxLastOctet }
        ];

        for (const range of startPoints) {
            for (let start = range.start; start <= range.end; start += batchSize) {
                if (!scanning) break;
                
                const end = Math.min(start + batchSize, range.end + 1);
                const promises = [];
                
                for (let i = start; i < end; i++) {
                    const ip = `${networkBase}.${i}`;
                    promises.push(tryConnect(ip));
                }
                
                updateConnectionStatus(`Scanning: ${networkBase}.${start} - ${networkBase}.${end-1}`);
                
                const results = await Promise.all(promises);
                const foundIp = results.find(ip => ip !== false);
                
                if (foundIp) {
                    console.log(`Found server at: ${foundIp}`);
                    scanning = false;
                    connectToServer(foundIp);
                    return;
                }
            }
        }
    }
    
    scanning = false;
    updateConnectionStatus('Server not found', true);
    setTimeout(() => scanNetwork(), 5000);
}

async function tryAutoLogin(ip) {
    if (localStorage.getItem('manualLogout') === 'true') {
        console.log('Автовход отключен после явного выхода');
        return false;
    }

    try {
        const response = await makeRequest('/api/auto-login', 'POST', { ip });
        if (response.success) {
            sessionId = response.sessionId;
            currentRole = response.role;
            currentUser = response.username;
            authOverlay.style.display = 'none';
            
            updateHeaderAvatar();
            
            channelList.innerHTML = '';
            channels = new Set(response.channels);
            response.channels.forEach(channel => {
                const channelElement = createChannelElement(channel);
                channelList.appendChild(channelElement);
            });
            
            await loadChannelMessages('Home');
            return true;
        }
        return false;
    } catch (error) {
        console.error('Auto-login error:', error);
        return false;
    }
}

async function connectToServer(ip = null, ngrokUrl = null) {
    try {
        let wsUrl;
        if (ngrokUrl) {
            wsUrl = ngrokUrl;
        } else {
            wsUrl = `ws://${ip}:3000`;
        }

        logWithTimestamp('Creating WebSocket connection to:', wsUrl);

        if (socket) {
            logWithTimestamp('Closing existing socket connection');
            socket.close();
        }

        return new Promise(async (resolve, reject) => {
            try {

                if (localStorage.getItem('manualLogout') !== 'true') {
                    const autoLoginSuccessful = await tryAutoLogin(ip);
                    if (autoLoginSuccessful) {
                        authOverlay.style.display = 'none';
                        socket = new WebSocket(wsUrl);
                        setupWebSocketHandlers(socket, wsUrl, resolve, reject);
                        return;
                    }
                }


                authOverlay.style.display = 'flex';
                authOverlay.style.justifyContent = 'center';
                authOverlay.style.alignItems = 'center';
                
                socket = new WebSocket(wsUrl);
                setupWebSocketHandlers(socket, wsUrl, resolve, reject);
                
            } catch (error) {
                logWithTimestamp('Error in connectToServer:', error);
                reject(error);
            }
        });
    } catch (error) {
        logWithTimestamp('Error creating WebSocket connection:', error);
        throw error;
    }
}


function setupWebSocketHandlers(socket, wsUrl, resolve, reject) {
    socket.onopen = () => {
        logWithTimestamp('Successfully connected to:', wsUrl);
        updateConnectionStatus('Connected');
        scanning = false;
        resolve();
    };

    socket.onclose = (event) => {
        logWithTimestamp('WebSocket closed:', event);
        updateConnectionStatus('Connection closed', true);
        if (!wsUrl.includes('ngrok')) {
            setTimeout(() => scanNetwork(), 2000);
        }
    };

    socket.onerror = (error) => {
        logWithTimestamp('WebSocket error:', error);
        updateConnectionStatus('Connection error', true);
        reject(error);
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            logWithTimestamp('Received message:', data);
            handleWebSocketMessage(data);
        } catch (error) {
            logWithTimestamp('Error processing message:', error);
        }
    };
}


async function getCurrentIp() {
    try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        return data.ip;
    } catch (error) {
        console.error('Error getting IP:', error);
        return null;
    }
}

function handleWebSocketMessage(data) {
    logWithTimestamp('Processing message:', data);
    try {
        switch (data.type) {
            case 'auth':
                logWithTimestamp('Auth response:', data);
                if (data.success) {
                    currentRole = data.role;
                }
                break;
            case 'register':
                handleRegistration(data);
                break;
            case 'message':
                if (data.channel === currentChannel) {
                    const messageExists = document.querySelector(
                        `[data-message-id="${data.timestamp}"]`
                    );
                    
                    if (!messageExists) {
                        const messageObj = {
                            content: data.message,
                            author: data.author,
                            timestamp: data.timestamp
                        };
                        displayMessage(messageObj);
                    }
                }
                break;
            case 'messageDeleted':
                console.log('Handling messageDeleted event:', data);
                const messageToDelete = document.querySelector(`[data-message-id="${data.messageId}"]`);
                console.log('Found message element:', messageToDelete);
                if (messageToDelete) {
                    messageToDelete.remove();
                    console.log('Message element removed');
                }
                break;
            case 'channelDeleted':
                handleChannelDelete(data);
                break;
            case 'history':
                loadMessageHistory(data);
                break;
            case 'channelCreated':
                if (!channels.has(data.channelName)) {
                    channels.add(data.channelName);
                    const channelElement = createChannelElement(data.channelName);
                    channelList.appendChild(channelElement);
                }
                break;
            case 'error':
                alert(data.message);
                break;
            case 'file':
                console.log('Handling file message:', data);
                const messageContent = {
                    type: 'file',
                    content: `FILE:${data.fileId}:${data.filename}`,
                    author: data.author,
                    channel: data.channel,
                    timestamp: data.timestamp
                };
                displayMessage(messageContent);
                break;
        }
    } catch (error) {
        logWithTimestamp('Error in handleWebSocketMessage:', error);
    }
}

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    try {
        const response = await makeRequest('/api/login', 'POST', {
            username,
            password
        });

        console.log('Login response:', response);

        if (response.success) {

            localStorage.removeItem('manualLogout');
            sessionId = response.sessionId;
            currentUser = username;
            currentRole = response.role;
            

            authOverlay.style.display = 'none';
            

            updateHeaderAvatar();
            

            startMessageChecking();
            

            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: 'auth',
                    sessionId: sessionId
                }));
            }


            await loadInitialMessages(currentChannel);
        } else {
            console.error('Login failed:', response.message);
            alert(response.message || 'Ошибка входа');
        }
    } catch (error) {
        console.error('Login error:', error);
        alert('Ошибка входа в систему: ' + error.message);
    }
});

registerBtn.addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    if (!username || !password) {
        alert('Please enter username and password');
        return;
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'register',
            username,
            password
        }));
    } else {
        try {
            const result = await makeRequest('/api/register', 'POST', { username, password });
            
            if (result.success) {
                alert('Registration successful. You can now log in.');
            } else {
                alert(result.message || 'Registration error');
            }
        } catch (error) {
            console.error('Registration error:', error);
            alert('Network error. Please try again.');
        }
    }
});

function handleAuthentication(data) {
    if (data.success) {
        currentRole = data.role;
        currentUser = document.getElementById('username').value;
        authOverlay.style.display = 'none';
        
        updateHeaderAvatar();
        
        addMessage('Successfully logged in', 'System', null, true);
    } else {
        alert(data.message || 'Authentication error');
    }
}

function handleRegistration(data) {
    if (data.success) {
        alert('Registration successful. You can now log in.');
    } else {
        alert(data.message || 'Registration error');
    }
}

function handleMessage(data) {
    if (data.channel === currentChannel) {
        const messageObj = {
            content: data.message,
            author: data.author,
            messageId: data.messageId,
            timestamp: data.timestamp
        };
        addMessage(messageObj, data.author, data.messageId);
    }
}

function handleMessageDelete(data) {
    if (data.channel === currentChannel) {
        const messageElement = document.querySelector(`[data-message-id="${data.messageId}"]`);
        if (messageElement) {
            messageElement.remove();
        }
    }
}

function handleChannelDelete(data) {
    const deletedChannelElement = document.querySelector(`[data-channel="${data.channelName}"]`);
    if (deletedChannelElement) {
        deletedChannelElement.remove();
    }
    if (currentChannel === data.channelName) {
        switchChannel('general');
    }
}

function loadMessageHistory(data) {
    if (data.channel === currentChannel) {
        messagesContainer.innerHTML = '';
        messagesContainer.classList.add('messages-history-load');
        
        data.messages.forEach((msg, index) => {
            const messageObj = {
                content: msg.content,
                author: msg.author,
                id: msg.id,
                timestamp: msg.timestamp,
                type: msg.content.startsWith('FILE:') ? 'file' : 'text'
            };
            displayMessage(messageObj, true);
        });


        setTimeout(() => {
            messagesContainer.classList.remove('messages-history-load');
        }, data.messages.length * 100 + 500);
    }
}

function handleChannelCreation(data) {
    const channelElement = createChannelElement(data.channelName);
    channelList.appendChild(channelElement);
}

createChannelBtn.addEventListener('click', async () => {
    if (currentRole !== 'admin') {
        alert('Only administrators can create channels');
        return;
    }
    
    const channelName = prompt('Enter channel name:');
    if (channelName) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'createChannel',
                channelName
            }));
        } else {
            try {
                const result = await makeRequest('/api/channels', 'POST', { 
                    channelName, 
                    sessionId 
                });
                
                if (result.success) {
                    const channelElement = createChannelElement(result.channelName);
                    channelList.appendChild(channelElement);
                } else {
                    alert(result.message || 'Failed to create channel');
                }
            } catch (error) {
                console.error('Channel creation error:', error);
                alert('Network error. Please try again.');
            }
        }
    }
});

messageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = messageInput.value.trim();
    if (!message) return;
    
    const timestamp = Date.now();
    

    socket.send(JSON.stringify({
        type: 'message',
        message: message,
        channel: currentChannel,
        timestamp: timestamp
    }));
    
    messageInput.value = '';

});

function switchChannel(channelName) {
    currentChannel = channelName;
    console.log('Switched to channel:', currentChannel);
    document.querySelectorAll('.channel-item').forEach(item => {
        item.classList.remove('active');
    });
    
    const channelElement = document.querySelector(`[data-channel="${channelName}"]`);
    if (channelElement) {
        channelElement.classList.add('active');
    }
    
    currentChannel = channelName;
    messagesContainer.innerHTML = '';
    
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'joinChannel',
            channel: channelName
        }));
    } else {
        loadChannelMessages(channelName);
    }
}

async function loadChannelMessages(channel) {
    if (sessionId) {
        try {
            const result = await makeRequest(`/api/messages/${channel}?sessionId=${sessionId}`);
            
            if (result.messages) {
                messagesContainer.innerHTML = '';
                result.messages.forEach(msg => {
                    const messageObj = {
                        content: msg.content,
                        author: msg.author,
                        id: msg.id,
                        timestamp: msg.timestamp,
                        type: msg.content.startsWith('FILE:') ? 'file' : 'text'
                    };
                    displayMessage(messageObj);
                });
                
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
        } catch (error) {
            console.error('Load messages error:', error);
            alert('Failed to load messages');
        }
    }
}

function createChannelElement(channelName) {
    const channelElement = document.createElement('div');
    channelElement.className = 'channel-item';
    
    const channelNameSpan = document.createElement('span');
    const prefix = channelName.includes('-') ? '@ ' : '# ';
    channelNameSpan.textContent = `${prefix}${channelName}`;
    channelElement.appendChild(channelNameSpan);

    channelElement.dataset.channel = channelName;
    channelElement.addEventListener('click', () => switchChannel(channelName));
    return channelElement;
}

function formatMessageDate(timestamp) {
    const messageDate = new Date(Number(timestamp));
    const now = new Date();
    const timeDiff = now - messageDate;
    const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
    

    const timeString = messageDate.toLocaleTimeString('ru-RU', { 
        hour: '2-digit', 
        minute: '2-digit'
    });


    if (days === 0) {
        return `Сегодня, ${timeString}`;
    }
    

    if (days === 1) {
        return `Вчера, ${timeString}`;
    }
    

    if (days < 7) {
        const weekdays = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
        return `${weekdays[messageDate.getDay()]}, ${timeString}`;
    }
    

    return `${messageDate.toLocaleDateString('ru-RU')}, ${timeString}`;
}

function displayMessage(messageData) {
    const messageElement = document.createElement('div');
    const timestamp = messageData.timestamp || Date.now();
    
    console.log('Displaying message:', {
        messageData,
        timestamp,
        type: typeof timestamp
    });
    
    messageElement.className = `message ${messageData.author === currentUser ? 'own-message' : 'other-message'}`;
    messageElement.setAttribute('data-message-id', timestamp.toString());
    
    let messageHTML = `
        <div class="message-header">
            <div class="author-time-wrapper">
                <img src="/uploads/avatars/${messageData.author}.jpg?t=${Date.now()}" 
                     class="message-avatar" 
                     onerror="this.src='/uploads/avatars/default-avatar.jpg'"
                     alt="${messageData.author}'s avatar">
                <span class="author-name">${messageData.author}</span>
                <span class="timestamp">${formatMessageDate(timestamp)}</span>
            </div>
            ${messageData.author === currentUser || currentRole === 'admin' ? 
                '<button class="delete-message-btn" onclick="deleteMessage(' + timestamp + ')">🗑️</button>' : 
                ''}
        </div>
        <div class="message-content">
    `;

    if (messageData.type === 'file') {
        const [, fileId, fileName] = messageData.content.split(':');
        messageHTML += `
            <div class="file-message">
                <a href="/uploads/${fileId}" class="file-download" download="${fileName}">
                    <span class="file-icon">📎</span>
                    <span class="file-name">${fileName}</span>
                </a>
            </div>`;
    } else {
        messageHTML += messageData.content;
    }

    messageHTML += '</div>';
    messageElement.innerHTML = messageHTML;
    
    messagesContainer.appendChild(messageElement);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

window.addEventListener('load', () => {
    updateConnectionStatus('Starting scan...', true);
    scanNetwork();
});

window.addEventListener('beforeunload', () => {
    scanning = false;
    if (socket) {
        socket.close();
    }
});

document.getElementById('attachButton').addEventListener('click', () => {
    document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) {
        console.log('No file selected');
        return;
    }

    console.log('File selected:', file.name);
    console.log('Current channel:', currentChannel);
    console.log('WebSocket state:', socket?.readyState || 'No socket connection');

    if (!currentChannel) {
        console.error('No channel selected');
        alert('Please select a channel before sending a file');
        return;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.error('WebSocket is not connected');
        alert('No connection to the server');
        return;
    }

    if (file.size > 5 * 1024 * 1024) {
        alert('File is too large. Maximum size: 5MB');
        return;
    }

    try {
        const reader = new FileReader();
        
        reader.onload = () => {
            console.log('File read complete');
            const base64Data = reader.result.split(',')[1];
            
            const fileMessage = {
                type: 'file',
                filename: file.name,
                fileData: base64Data,
                channel: currentChannel
            };
            
            console.log('Preparing to send file message:', {
                filename: file.name,
                channel: currentChannel,
                messageType: 'file'
            });

            try {
                socket.send(JSON.stringify(fileMessage));
                console.log('File message sent successfully');
            } catch (sendError) {
                console.error('Error sending file message:', sendError);
                alert('Error sending file');
            }
        };

        reader.onerror = (error) => {
            console.error('Error reading file:', error);
            alert('Error reading file');
        };

        console.log('Starting to read file...');
        reader.readAsDataURL(file);
        e.target.value = '';
    } catch (error) {
        console.error('Error processing file:', error);
        alert('Error processing file');
    }
});

const style = document.createElement('style');
style.textContent = `
    .message-container {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        margin-bottom: 8px;
    }

    .avatar-container {
        flex-shrink: 0;
    }

    .user-avatar {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        object-fit: cover;
        border: 2px solid #1a472a;
    }

    .message-content {
        flex-grow: 1;
        min-width: 0;
    }

    .text-content {
        word-wrap: break-word;
        margin-top: 4px;
    }

    .own-message .message-container {
        flex-direction: row-reverse;
    }

    .own-message .message-content {
        text-align: right;
    }

    .message {
        padding: 8px;
        margin: 4px 0;
        border-radius: 8px;
    }

    .own-message {
        background: rgba(45, 90, 60, 0.7);
        margin-left: 20%;
    }

    .other-message {
        background: rgba(42, 42, 42, 0.7);
        margin-right: 20%;
    }

    .author {
        font-weight: bold;
        margin-bottom: 2px;
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .own-message .author {
        justify-content: flex-end;
    }

    .timestamp {
        font-size: 0.8em;
        color: #888;
    }

    .file-message {
        display: flex;
        align-items: center;
    }

    .file-download {
        display: inline-flex;
        align-items: center;
        color: #ffffff;
        text-decoration: none;
        padding: 5px 10px;
        border: 1px solid #ffffff;
        border-radius: 4px;
        transition: all 0.3s ease;
        margin-top: 4px;
    }

    .file-download:hover {
        background: #2d5a3c;
        color: white;
    }

    .message-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
    }

    .author-name {
        font-weight: bold;
        color: #ffffff;
    }

    .timestamp {
        color: #888;
        font-size: 0.8em;
        margin-left: 8px;
    }

    .content-wrapper {
        display: flex;
        align-items: flex-start;
        gap: 8px;
    }

    .message-text {
        word-wrap: break-word;
        color: #e0e0e0;
    }

    .own-message .message-header {
        flex-direction: row-reverse;
    }

    .own-message .timestamp {
        margin-left: 0;
        margin-right: 8px;
    }

    .own-message .content-wrapper {
        justify-content: flex-end;
    }

    .other-message .content-wrapper {
        justify-content: flex-start;
    }
`;
document.head.appendChild(style);

async function createPrivateChat(targetUser) {
    try {
        const result = await makeRequest('/api/private-chat', 'POST', { targetUser, sessionId });
        if (result.success) {
            const chatElement = createChannelElement(result.chatId);
            channelList.appendChild(chatElement);
        } else {
            alert(result.message || 'Failed to create private chat');
        }
    } catch (error) {
        console.error('Private chat creation error:', error);
        alert('Network error. Please try again.');
    }
}


document.getElementById('createPrivateChatBtn').addEventListener('click', () => {
    const targetUser = prompt('Enter the username for private chat:');
    if (targetUser) {
        createPrivateChat(targetUser);
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const profileButton = document.getElementById('profileButton');
    const profileModal = document.getElementById('profileModal');
    const closeProfileModal = document.getElementById('closeProfileModal');
    
    if (profileButton) {
        profileButton.addEventListener('click', () => {
            profileModal.classList.remove('hidden');
        });
    }


    if (closeProfileModal) {
        closeProfileModal.addEventListener('click', () => {
            profileModal.classList.add('hidden');

            document.getElementById('newPassword').value = '';
            document.getElementById('avatar').value = '';
            const preview = document.getElementById('avatarPreview');
            if (preview) {
                preview.style.display = 'none';
            }
        });
    }


    profileModal.addEventListener('click', (event) => {
        if (event.target === profileModal) {
            profileModal.classList.add('hidden');

            document.getElementById('newPassword').value = '';
            document.getElementById('avatar').value = '';
            const preview = document.getElementById('avatarPreview');
            if (preview) {
                preview.style.display = 'none';
            }
        }
    });


    const profileForm = profileModal.querySelector('.auth-form');
    if (profileForm) {
        profileForm.addEventListener('click', (event) => {
            event.stopPropagation();
        });
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const saveProfileBtn = document.getElementById('saveProfileBtn');
    
    if (!saveProfileBtn) {
        console.error('Кнопка "Сохранить" не найдена в DOM');
        return;
    }

    saveProfileBtn.addEventListener('click', async () => {
        console.log('Save button clicked');
        const newPasswordInput = document.getElementById('newPassword');
        const avatarInput = document.getElementById('avatar');

        if (!newPasswordInput || !avatarInput) {
            console.error('Н найдены элементы формы:', {
                newPassword: !!newPasswordInput,
                avatar: !!avatarInput
            });
            return;
        }

        const newPassword = newPasswordInput.value;
        const avatarFile = avatarInput.files[0];
        let successMessage = [];

        try {

            if (avatarFile) {
                console.log('Uploading avatar...');
                const formData = new FormData();
                formData.append('avatar', avatarFile);
                formData.append('username', currentUser);

                const avatarResponse = await fetch('/api/upload-avatar', {
                    method: 'POST',
                    headers: {
                        'Authorization': sessionId
                    },
                    body: formData
                });

                const avatarResult = await avatarResponse.json();
                console.log('Avatar upload response:', avatarResult);
                if (avatarResult.success) {
                    successMessage.push('Аватар успшно обновлен');
                    const timestamp = Date.now();
                    document.querySelectorAll(`img[alt="${currentUser}"].user-avatar`).forEach(img => {
                        img.src = `/uploads/avatars/${currentUser}.jpg?t=${timestamp}`;
                    });
                } else {
                    throw new Error(avatarResult.message || 'Ошибка загрузки аватара');
                }
            }


            if (newPassword) {
                console.log('Changing password...');
                const passwordResponse = await makeRequest('/api/change-password', 'POST', {
                    newPassword,
                    sessionId
                });

                console.log('Password change response:', passwordResponse);
                if (passwordResponse.success) {
                    successMessage.push('Пароль успешно изменен');
                } else {
                    throw new Error(passwordResponse.message || 'Ошибка изменения пароля');
                }
            }

            const profileModal = document.getElementById('profileModal');
            if (successMessage.length > 0) {
                alert(successMessage.join('\n'));
                if (profileModal) {
                    profileModal.classList.add('hidden');
                }
                newPasswordInput.value = '';
                avatarInput.value = '';
            } else {
                alert('Не выбраны изменения для сохранения');
            }

        } catch (error) {
            console.error('Ошибка сохранения профиля:', error);
            alert(`Ошибка: ${error.message}`);
        }
    });
});


document.addEventListener('DOMContentLoaded', () => {
    console.log('Checking elements:');
    console.log('saveProfileBtn exists:', !!document.getElementById('saveProfileBtn'));
    console.log('newPassword exists:', !!document.getElementById('newPassword'));
    console.log('avatar exists:', !!document.getElementById('avatar'));
    console.log('profileModal exists:', !!document.getElementById('profileModal'));
});


function updateHeaderAvatar() {
    const headerAvatar = document.getElementById('headerAvatar');
    if (!headerAvatar || !currentUser) return;

    const timestamp = Date.now();
    headerAvatar.src = `/uploads/avatars/${currentUser}.jpg?t=${timestamp}`;
    

    headerAvatar.onerror = function() {
        this.src = `/uploads/avatars/${currentUser}.png?t=${timestamp}`;
        

        this.onerror = function() {
            this.src = '/uploads/avatars/default-avatar.jpg';
            this.onerror = null;
        };
    };
}


document.addEventListener('DOMContentLoaded', () => {

    if (currentUser) {
        console.log('User already logged in, updating avatar on page load');
        updateHeaderAvatar();
    }
    
    const headerAvatar = document.getElementById('headerAvatar');
    if (headerAvatar) {
        headerAvatar.addEventListener('click', () => {
            const profileModal = document.getElementById('profileModal');
            if (profileModal) {
                profileModal.classList.remove('hidden');
            }
        });
    }
});


socket.addEventListener('message', async (event) => {
    const response = JSON.parse(event.data);
    if (response.type === 'auth' && response.success) {
        currentUser = response.username;
        currentRole = response.role;
        

        console.log('Auth successful, updating avatar for user:', currentUser);
        updateHeaderAvatar(true);
        

    }

});


function updateHeaderAvatar() {
    const headerAvatar = document.getElementById('headerAvatar');
    if (!headerAvatar) {
        console.error('Header avatar element not found');
        return;
    }

    if (currentUser) {
        const timestamp = Date.now();
        const avatarUrl = `/uploads/avatars/${currentUser}?t=${timestamp}`;
        console.log('Updating avatar for user:', currentUser);
        console.log('Avatar URL:', avatarUrl);
        
        headerAvatar.onerror = function() {
            console.log('Error loading user avatar, using default');
            this.src = '/uploads/avatars/default-avatar.png';
            this.onerror = null;
        };
        
        headerAvatar.src = avatarUrl;
    } else {
        console.log('No current user, using default avatar');
        headerAvatar.src = '/uploads/avatars/default-avatar.png';
    }
}


document.addEventListener('DOMContentLoaded', () => {

    if (currentUser) {
        console.log('User already logged in, updating avatar on page load');
        updateHeaderAvatar();
    }
    
    const headerAvatar = document.getElementById('headerAvatar');
    if (headerAvatar) {
        headerAvatar.addEventListener('click', () => {
            const profileModal = document.getElementById('profileModal');
            if (profileModal) {
                profileModal.classList.remove('hidden');
            }
        });
    }
});


document.getElementById('saveProfileBtn').addEventListener('click', async () => {
    const successMessage = [];
    

    if (avatarFile) {
        try {
            const formData = new FormData();
            formData.append('avatar', avatarFile);
            
            const response = await fetch('/api/upload-avatar', {
                method: 'POST',
                headers: {
                    'Authorization': sessionId
                },
                body: formData
            });
            
            const result = await response.json();
            if (result.success) {
                successMessage.push('Аватар успешно обновлен');
                console.log('Avatar uploaded successfully');
                

                updateHeaderAvatar(true);
                

                avatarFile = null;
                document.getElementById('avatarInput').value = '';
                const preview = document.getElementById('avatarPreview');
                if (preview) {
                    preview.style.display = 'none';
                }
            } else {
                throw new Error(result.message || 'Ошибка загрузки аватара');
            }
        } catch (error) {
            console.error('Error uploading avatar:', error);
            alert('Ошибка загрузки аватара: ' + error.message);
            return;
        }
    }


});


console.log('Checking elements on load:');
console.log('headerAvatar exists:', !!document.getElementById('headerAvatar'));
console.log('profileModal exists:', !!document.getElementById('profileModal'));


document.getElementById('avatarInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
            alert('Пожалуйста, выберите JPG или PNG файл');
            this.value = '';
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            alert('Файл слишком большой. Максимальный размер 5MB');
            this.value = '';
            return;
        }
        avatarFile = file;
        

        const reader = new FileReader();
        reader.onload = function(e) {
            const preview = document.getElementById('avatarPreview');
            if (preview) {
                preview.src = e.target.result;
                preview.style.display = 'block';
            }
        };
        reader.readAsDataURL(file);
    }
});


document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM загружен, ищем кнопку выхода');
    
    const logoutBtn = document.getElementById('logoutBtn');
    console.log('Кнопк выхода найдена:', !!logoutBtn);
    
    if (logoutBtn) {
        console.log('Добавляем обрабтчик на кнпку выхода');
        logoutBtn.addEventListener('click', async () => {
            console.log('Кнопка выхода наата');
            try {
                console.log('Выход из системы...'); 
                

                localStorage.setItem('manualLogout', 'true');
                

                try {
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        socket.close();
                    }
                } catch (wsError) {
                    console.log('WebSocket уже закрыт или не существует');
                }
                socket = null;
                
                const response = await makeRequest('/api/logout', 'POST', { sessionId });
                console.log('Ответ сервера при выходе:', response);


                sessionId = null;
                currentUser = null;
                currentRole = null;
                

                const profileModal = document.getElementById('profileModal');
                if (profileModal) {
                    profileModal.classList.add('hidden');
                }
                

                const authOverlay = document.getElementById('authOverlay');
                if (authOverlay) {
                    console.log('Показываем форму авторизации');
                    authOverlay.style.display = 'flex';
                    

                    const usernameInput = document.getElementById('username');
                    const passwordInput = document.getElementById('password');
                    if (usernameInput) usernameInput.value = '';
                    if (passwordInput) passwordInput.value = '';
                }
                

                const messagesContainer = document.getElementById('messages');
                if (messagesContainer) {
                    messagesContainer.innerHTML = '';
                }
                
                const channelList = document.getElementById('channelList');
                if (channelList) {
                    channelList.innerHTML = '';
                }
                
                console.log('ыход выполнен успешно');
                
            } catch (error) {
                console.error('Ошибка при выходе:', error);
                alert('Ошибка при выходе из системы');
            }
        });
    } else {
        console.error('Кнопка выхода не найдена в DOM!');
    }
});


async function switchChannel(channelName) {
    currentChannel = channelName;
    

    messagesContainer.innerHTML = '';
    

    const response = await makeRequest(`/api/messages/${channelName}`);
    if (response.messages) {
        response.messages.forEach(msg => displayMessage(msg));
    }
    

    socket.send(JSON.stringify({
        type: 'joinChannel',
        channel: channelName
    }));
    

    document.querySelectorAll('.channel-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.channel === channelName) {
            item.classList.add('active');
        }
    });
}


socket.addEventListener('message', async (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'message' && data.channel === currentChannel) {

        const existingMessage = document.querySelector(`[data-message-id="${data.timestamp}"]`);
        if (!existingMessage) {
            const messageObj = {
                content: data.message,
                author: data.author,
                timestamp: data.timestamp
            };
            displayMessage(messageObj);
        }
    }
});


async function deleteMessage(messageId) {
    console.log('Attempting to delete message:', {
        messageId: messageId,
        type: typeof messageId,
        currentChannel: currentChannel
    });
    

    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageElement) {
        console.error('Message element not found in DOM');
        return;
    }
    

    const timestamp = messageElement.getAttribute('data-message-id');
    console.log('Message timestamp from DOM:', timestamp);
    
    try {
        const response = await makeRequest('/api/deleteMessage', 'POST', {
            messageId: Number(timestamp), 
            channel: currentChannel
        });
        
        console.log('Delete response:', response);
        
        if (response.success) {
            console.log('Message deleted successfully');
            messageElement.style.animation = 'messageDelete 0.3s ease-out forwards';
            setTimeout(() => {
                messageElement.remove();
            }, 300);
        } else {
            console.error('Failed to delete message:', response.message);
            alert('Failed to delete message: ' + response.message);
        }
    } catch (error) {
        console.error('Error deleting message:', error);
        alert('Error deleting message');
    }
}


async function checkAndUpdateMessages(channel) {
    try {
        const response = await makeRequest(`/api/messages/${channel}/last5`);
        
        if (!response.success || !response.messages) {
            return;
        }

        const serverMessages = response.messages;
        const domMessages = Array.from(document.querySelectorAll('.message'))
            .map(el => ({
                id: el.dataset.messageId,
                element: el
            }));
        

        domMessages.forEach(({id, element}) => {
            const messageExistsOnServer = serverMessages.some(serverMsg => 
                serverMsg.timestamp.toString() === id
            );
            
            if (!messageExistsOnServer) {
                element.remove();
            }
        });


        serverMessages.forEach(serverMsg => {
            const messageExists = document.querySelector(
                `[data-message-id="${serverMsg.timestamp}"]`
            );
            
            if (!messageExists) {
                displayMessage({
                    content: serverMsg.content,
                    author: serverMsg.author,
                    timestamp: serverMsg.timestamp
                });
            }
        });

    } catch (error) {
        console.error('Error checking messages:', error);
    }
}


async function loadInitialMessages(channel) {
    try {
        const response = await makeRequest(`/api/messages/${channel}/last5`);
        console.log('Loading initial messages for channel:', channel, response.messages);
        
        if (response.success && response.messages) {
            messagesContainer.innerHTML = '';  
            response.messages.forEach(msg => displayMessage(msg));
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    } catch (error) {
        console.error('Error loading initial messages:', error);
    }
}


async function switchChannel(channelName) {
    currentChannel = channelName;
    await loadInitialMessages(channelName);
    
    socket.send(JSON.stringify({
        type: 'joinChannel',
        channel: channelName
    }));
    
    document.querySelectorAll('.channel-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.channel === channelName) {
            item.classList.add('active');
        }
    });
}


function startMessageChecking() {
    if (checkMessagesInterval) {
        clearInterval(checkMessagesInterval);
    }
    
    checkMessagesInterval = setInterval(() => {
        if (currentChannel) {
            checkAndUpdateMessages(currentChannel);
        }
    }, 1000);
}

