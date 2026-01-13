/**
 * AI Assistant Chat Session Management
 * Handles chat history, session persistence, and menu interactions
 */

class ChatSessionManager {
    constructor(aiAssistant) {
        this.aiAssistant = aiAssistant;
        this.currentChatId = null;
        this.chatHistory = []; // Last 50 chats for the menu
        this.isContextLocked = false; // Lock context after first message
    }

    /**
     * Start a new chat session
     */
    startNewChat() {
        // Confirm if there's an active chat
        if (this.currentChatId && this.aiAssistant.messages.length > 0) {
            if (!confirm('Start a new chat? The current chat will be saved.')) {
                return;
            }
        }

        // Reset chat state
        this.currentChatId = null;
        this.isContextLocked = false;
        this.aiAssistant.messages = [];
        this.aiAssistant.messagesContainer.innerHTML = '';

        // Show context selection
        this.showContextSelection();

        console.log('[ChatSession] New chat started');
    }

    /**
     * Show context selection at the start of a new chat
     */
    showContextSelection() {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'ai-message ai-message-context-selection';

        messageDiv.innerHTML = `
            <div class="ai-context-selection-container">
                <h3>Choose your working context</h3>
                <p>Select whether you want to work on the font or a script. This cannot be changed during the chat.</p>
                <div class="ai-context-selection-buttons">
                    <button class="ai-context-selection-btn" data-context="font">
                        <span class="material-symbols-outlined">font_download</span>
                        <span class="label">Font Context</span>
                        <span class="description">Work directly on the current font</span>
                    </button>
                    <button class="ai-context-selection-btn" data-context="script">
                        <span class="material-symbols-outlined">code</span>
                        <span class="label">Script Context</span>
                        <span class="description">Create or edit reusable scripts</span>
                    </button>
                </div>
            </div>
        `;

        this.aiAssistant.messagesContainer.appendChild(messageDiv);

        // Add event listeners to buttons
        const buttons = messageDiv.querySelectorAll(
            '.ai-context-selection-btn'
        );
        buttons.forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const context = btn.getAttribute('data-context');
                this.selectContext(context);
                messageDiv.remove();
            });
        });

        this.aiAssistant.scrollToBottom();
    }

    /**
     * Select and lock the context for this chat
     */
    selectContext(context) {
        this.aiAssistant.setContext(context);
        this.isContextLocked = true;

        // Add a system message indicating the locked context
        const messageDiv = document.createElement('div');
        messageDiv.className = 'ai-message ai-message-system';

        const contextLabel =
            context === 'font' ? 'Font Context' : 'Script Context';
        const contextDescription =
            context === 'font'
                ? 'Working directly on the current font'
                : 'Creating or editing reusable scripts';

        messageDiv.innerHTML = `
            <div class="ai-system-message">
                <span class="material-symbols-outlined">lock</span>
                <div>
                    <strong>${contextLabel} selected</strong>
                    <p>${contextDescription}</p>
                </div>
            </div>
        `;

        this.aiAssistant.messagesContainer.appendChild(messageDiv);
        this.aiAssistant.scrollToBottom();

        // Focus the input
        this.aiAssistant.promptInput.focus();

        console.log(`[ChatSession] Context locked to: ${context}`);
    }

    /**
     * Load a chat session from history
     */
    async loadChatSession(chatId) {
        try {
            const sessionToken = window.authManager
                ? window.authManager.getSessionToken()
                : null;

            const headers = {
                'Content-Type': 'application/json'
            };

            if (sessionToken) {
                headers['Authorization'] = `Bearer ${sessionToken}`;
            }

            const response = await fetch(
                `${this.aiAssistant.websiteURL}/api/ai/chat-session?chatId=${chatId}`,
                {
                    method: 'GET',
                    credentials: 'include',
                    headers: headers
                }
            );

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(
                    errorData.error || 'Failed to load chat session'
                );
            }

            const data = await response.json();

            // Set current chat ID
            this.currentChatId = data.chatSession.id;

            // Set context
            this.aiAssistant.context = data.chatSession.contextType;
            localStorage.setItem('ai_context', data.chatSession.contextType);

            // Update radio buttons
            const fontRadio = document.getElementById('ai-context-radio-font');
            const scriptRadio = document.getElementById(
                'ai-context-radio-script'
            );
            if (fontRadio && scriptRadio) {
                fontRadio.checked = data.chatSession.contextType === 'font';
                scriptRadio.checked = data.chatSession.contextType === 'script';
            }

            this.isContextLocked = true;

            // Hide context selector and show locked display
            const contextSelector = document.getElementById(
                'ai-context-selector'
            );
            const contextDisplay =
                document.getElementById('ai-context-display');
            if (contextSelector) contextSelector.classList.add('hidden');
            if (contextDisplay) {
                contextDisplay.classList.remove('hidden');
                const contextLabel =
                    data.chatSession.contextType === 'font'
                        ? 'Font Context'
                        : 'Script Context';
                contextDisplay.innerHTML = `<span class="material-symbols-outlined">lock</span> <span class="ai-context-display-text">${contextLabel}</span><span class="ai-context-display-hint">Start a new chat to change context</span>`;
            }

            // Clear current messages
            this.aiAssistant.messages = [];
            this.aiAssistant.messagesContainer.innerHTML = '';

            // Recreate messages from history
            data.messages.forEach((msg) => {
                if (msg.role === 'user') {
                    this.aiAssistant.addMessage('user', msg.content);
                } else if (msg.role === 'assistant') {
                    // Try to extract code and markdown from assistant message
                    const { pythonCode, markdownText } =
                        this.extractCodeAndMarkdown(msg.content);

                    if (pythonCode) {
                        this.aiAssistant.addOutputWithCode(
                            '',
                            pythonCode,
                            markdownText,
                            true
                        );
                    } else {
                        this.aiAssistant.addMessage('assistant', msg.content);
                    }
                }
            });

            this.aiAssistant.scrollToBottom();

            console.log(`[ChatSession] Loaded chat: ${chatId}`);
        } catch (error) {
            console.error('[ChatSession] Failed to load chat session:', error);
            alert(`Failed to load chat: ${error.message}`);
        }
    }

    /**
     * Load the last active chat on startup
     */
    async loadLastChat() {
        try {
            const sessionToken = window.authManager
                ? window.authManager.getSessionToken()
                : null;

            const headers = {
                'Content-Type': 'application/json'
            };

            if (sessionToken) {
                headers['Authorization'] = `Bearer ${sessionToken}`;
            }

            const response = await fetch(
                `${this.aiAssistant.websiteURL}/api/ai/last-chat`,
                {
                    method: 'GET',
                    credentials: 'include',
                    headers: headers
                }
            );

            if (!response.ok) {
                if (response.status === 401) {
                    console.log(
                        '[ChatSession] Not authenticated for last chat'
                    );
                } else {
                    console.log(
                        '[ChatSession] No last chat available:',
                        response.status
                    );
                }
                return;
            }

            const data = await response.json();

            if (!data.chatSession) {
                console.log('[ChatSession] No chat history found');
                return;
            }

            // Load the chat
            this.currentChatId = data.chatSession.id;

            // Set context
            this.aiAssistant.context = data.chatSession.contextType;
            localStorage.setItem('ai_context', data.chatSession.contextType);

            // Update radio buttons
            const fontRadio = document.getElementById('ai-context-radio-font');
            const scriptRadio = document.getElementById(
                'ai-context-radio-script'
            );
            if (fontRadio && scriptRadio) {
                fontRadio.checked = data.chatSession.contextType === 'font';
                scriptRadio.checked = data.chatSession.contextType === 'script';
            }

            this.isContextLocked = true;

            // Hide context selector and show locked display
            const contextSelector = document.getElementById(
                'ai-context-selector'
            );
            const contextDisplay =
                document.getElementById('ai-context-display');
            if (contextSelector) contextSelector.classList.add('hidden');
            if (contextDisplay) {
                contextDisplay.classList.remove('hidden');
                const contextLabel =
                    data.chatSession.contextType === 'font'
                        ? 'Font Context'
                        : 'Script Context';
                contextDisplay.innerHTML = `<span class="material-symbols-outlined">lock</span> <span class="ai-context-display-text">${contextLabel}</span><span class="ai-context-display-hint">Start a new chat to change context</span>`;
            }

            // Recreate messages from history
            data.messages.forEach((msg) => {
                if (msg.role === 'user') {
                    this.aiAssistant.addMessage('user', msg.content);
                } else if (msg.role === 'assistant') {
                    const { pythonCode, markdownText } =
                        this.extractCodeAndMarkdown(msg.content);

                    if (pythonCode) {
                        this.aiAssistant.addOutputWithCode(
                            '',
                            pythonCode,
                            markdownText,
                            true
                        );
                    } else {
                        this.aiAssistant.addMessage('assistant', msg.content);
                    }
                }
            });

            this.aiAssistant.scrollToBottom();

            console.log(
                `[ChatSession] Loaded last chat: ${this.currentChatId}`
            );
        } catch (error) {
            console.error('[ChatSession] Failed to load last chat:', error);
        }
    }

    /**
     * Update chat history menu
     */
    updateChatHistory(chatHistory) {
        this.chatHistory = chatHistory;

        // Update menu if it's currently open
        this.refreshHistoryMenu();
    }

    /**
     * Open chat history menu and load history from server
     */
    async openChatHistoryMenu() {
        console.log('[ChatSession] openChatHistoryMenu() called');
        const menu = document.getElementById('ai-chat-history-menu');
        const backdrop = document.getElementById('ai-chat-history-backdrop');
        console.log('[ChatSession] Menu element found:', !!menu);
        console.log('[ChatSession] Backdrop element found:', !!backdrop);

        if (!menu || !backdrop) {
            console.error(
                '[ChatSession] Menu or backdrop element not found! Cannot open menu.'
            );
            return;
        }

        try {
            // Show menu and backdrop
            console.log('[ChatSession] Showing menu and backdrop');
            menu.style.display = 'block';
            backdrop.style.display = 'block';
            console.log(
                '[ChatSession] Menu display set to:',
                menu.style.display
            );

            // Load chat history from server
            console.log('[ChatSession] Loading chat history from server...');
            await this.loadChatHistoryFromServer();
            console.log('[ChatSession] Chat history loaded');

            // Populate menu
            console.log('[ChatSession] Refreshing history menu...');
            this.refreshHistoryMenu();
            console.log('[ChatSession] Menu opened successfully');
        } catch (error) {
            console.error(
                '[ChatSession] Error in openChatHistoryMenu():',
                error
            );
        }
    }

    /**
     * Close chat history menu
     */
    closeChatHistoryMenu() {
        const menu = document.getElementById('ai-chat-history-menu');
        const backdrop = document.getElementById('ai-chat-history-backdrop');

        if (menu) menu.style.display = 'none';
        if (backdrop) backdrop.style.display = 'none';
    }

    /**
     * Load chat history from server
     */
    async loadChatHistoryFromServer() {
        try {
            const sessionToken = window.authManager
                ? window.authManager.getSessionToken()
                : null;

            const headers = {
                'Content-Type': 'application/json'
            };

            if (sessionToken) {
                headers['Authorization'] = `Bearer ${sessionToken}`;
            }

            const response = await fetch(
                `${this.aiAssistant.websiteURL}/api/ai/chat-sessions`,
                {
                    method: 'GET',
                    credentials: 'include',
                    headers: headers
                }
            );

            if (!response.ok) {
                console.error(
                    '[ChatSession] Failed to load chat history:',
                    response.status,
                    response.statusText
                );
                const errorText = await response.text();
                console.error('[ChatSession] Response:', errorText);
                return;
            }

            const data = await response.json();
            console.log('[ChatSession] Raw response data:', data);
            this.chatHistory = data.sessions || [];

            console.log(
                `[ChatSession] Loaded ${this.chatHistory.length} chat sessions`
            );
        } catch (error) {
            console.error('[ChatSession] Error loading chat history:', error);
        }
    }

    /**
     * Extract Python code and markdown from assistant response
     */
    extractCodeAndMarkdown(content) {
        let pythonCode = '';
        let markdownText = content;

        // Extract code from ```python blocks
        const codeBlockRegex = /```python\s*\n([\s\S]*?)```/g;
        const matches = content.matchAll(codeBlockRegex);

        for (const match of matches) {
            pythonCode += match[1];
        }

        // Remove code blocks from markdown
        markdownText = markdownText
            .replace(/```python\s*\n[\s\S]*?```/g, '')
            .replace(/```\s*\n[\s\S]*?```/g, '')
            .trim();

        return { pythonCode: pythonCode.trim(), markdownText };
    }

    /**
     * Refresh the history menu (stub - will be implemented with UI)
     */
    refreshHistoryMenu() {
        const listContainer = document.getElementById('ai-chat-history-list');
        if (!listContainer) {
            console.error(
                '[ChatSession] Chat history list container not found'
            );
            return;
        }

        console.log(
            '[ChatSession] Refreshing history menu, items:',
            this.chatHistory?.length || 0
        );

        // Clear existing items
        listContainer.innerHTML = '';

        if (!this.chatHistory || this.chatHistory.length === 0) {
            listContainer.innerHTML =
                '<div class="ai-chat-history-empty">No chat history yet</div>';
            return;
        }

        // Create items for each chat session
        this.chatHistory.forEach((session) => {
            console.log('[ChatSession] Processing session:', session);
            const item = document.createElement('div');
            item.className = 'ai-chat-history-item';
            if (session.id === this.currentChatId) {
                item.classList.add('active');
            }

            const contextIcon =
                session.contextType === 'font' ? 'font_download' : 'code';

            // Handle date parsing more robustly
            let timeAgo = 'Unknown';
            try {
                const timestamp = new Date(session.lastActivityAt).getTime();
                if (!isNaN(timestamp)) {
                    timeAgo = this.formatRelativeTime(timestamp);
                }
            } catch (e) {
                console.error(
                    '[ChatSession] Error parsing date:',
                    session.lastActivityAt,
                    e
                );
            }

            item.innerHTML = `
                <div class="ai-chat-history-item-icon">
                    <span class="material-symbols-outlined">${contextIcon}</span>
                </div>
                <div class="ai-chat-history-item-content">
                    <div class="ai-chat-history-item-title">${session.shortDescription || 'New Chat'}</div>
                    <div class="ai-chat-history-item-meta">${timeAgo}</div>
                </div>
            `;

            item.addEventListener('click', () => {
                if (session.id !== this.currentChatId) {
                    this.loadChatSession(session.id);
                }
                this.closeChatHistoryMenu();
            });

            listContainer.appendChild(item);
        });
    }

    /**
     * Format relative time for chat history
     */
    formatRelativeTime(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;

        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) {
            return `${days}d ago`;
        } else if (hours > 0) {
            return `${hours}h ago`;
        } else if (minutes > 0) {
            return `${minutes}m ago`;
        } else {
            return 'Just now';
        }
    }
}
