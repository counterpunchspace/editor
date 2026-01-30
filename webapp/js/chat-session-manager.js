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
        this.linkedFilePath = null; // File path for glyph filter context (session only)
    }

    /**
     * Set the linked file path for glyph filter context
     */
    setLinkedFilePath(filePath) {
        this.linkedFilePath = filePath;
        console.log('[ChatSession] Linked file path set to:', filePath);
        // Update file path display if visible
        this.updateFilePathDisplay();
    }

    /**
     * Get the linked file path for glyph filter context
     */
    getLinkedFilePath() {
        return this.linkedFilePath;
    }

    /**
     * Update the file path display at the bottom of the chat
     */
    updateFilePathDisplay() {
        const display = document.getElementById('ai-linked-file-path');
        if (!display) return;

        if (this.linkedFilePath && this.aiAssistant.context === 'glyphfilter') {
            const fileName = this.linkedFilePath.split('/').pop();
            display.innerHTML = `<span class="material-symbols-outlined">link</span><span class="ai-linked-file-name">${fileName}</span><span class="ai-linked-file-full-path">${this.linkedFilePath}</span>`;
            display.style.display = 'flex';
        } else {
            display.style.display = 'none';
        }
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
        this.linkedFilePath = null;
        this.aiAssistant.messages = [];
        this.aiAssistant.messagesContainer.innerHTML = '';

        // Clear localStorage when starting new chat
        localStorage.removeItem('ai_last_chat_id');

        // Hide input container until context is selected
        const inputContainer = document.getElementById('ai-input-container');
        if (inputContainer) {
            inputContainer.style.display = 'none';
        }

        // Show context selection
        this.showContextSelection();

        console.log('[ChatSession] New chat started');
    }

    /**
     * Generate context icon HTML
     * @param {string} contextType - 'font', 'script', or 'glyphfilter'
     * @returns {string} HTML for context icon
     */
    static getContextIconHTML(contextType) {
        let icon, contextClass;
        switch (contextType) {
            case 'script':
                icon = 'code';
                contextClass = 'script-context';
                break;
            case 'glyphfilter':
                icon = 'filter_alt';
                contextClass = 'glyphfilter-context';
                break;
            default:
                icon = 'font_download';
                contextClass = 'font-context';
        }
        return `
            <div class="ai-context-selection-icon ${contextClass}">
                <span class="material-symbols-outlined">${icon}</span>
            </div>
        `;
    }

    /**
     * Check if a glyph filter file is currently open in the script editor
     * @returns {boolean} True if a filter file is open
     * NOTE: This is now deprecated - glyph filter context is only invoked from sidebar
     */
    static isGlyphFilterFileOpen() {
        // Always return false - glyph filter context is only invoked from sidebar
        return false;
    }

    /**
     * Generate context selection buttons HTML
     * @returns {string} HTML for context selection buttons
     */
    static getContextSelectionButtonsHTML() {
        const isFilterFileOpen = ChatSessionManager.isGlyphFilterFileOpen();
        const filterDisabledClass = isFilterFileOpen ? '' : 'disabled';
        const filterDisabledAttr = isFilterFileOpen ? '' : 'disabled';

        return `
            <button class="ai-context-selection-btn" data-context="font">
                ${ChatSessionManager.getContextIconHTML('font')}
                <span class="label">Font Context</span>
                <span class="description">Work directly on the current font</span>
            </button>
            <button class="ai-context-selection-btn" data-context="script">
                ${ChatSessionManager.getContextIconHTML('script')}
                <span class="label">Script Context</span>
                <span class="description">Create or edit reusable scripts</span>
            </button>
            <button class="ai-context-selection-btn ${filterDisabledClass}" data-context="glyphfilter" ${filterDisabledAttr}>
                ${ChatSessionManager.getContextIconHTML('glyphfilter')}
                <span class="label">Glyph Filter Context</span>
                <span class="description">Create or edit glyph filter scripts</span>
            </button>
        `;
    }

    /**
     * Generate explainer HTML for glyph filter context
     * @returns {string} HTML for the explainer (always shown for glyph filter button)
     */
    static getGlyphFilterExplainerHTML() {
        return `
            <div class="ai-context-explainer">
                <span class="material-symbols-outlined">info</span>
                <span>Glyph Filter Context chats can only be started from the sidebar. Right-click on a filter file in the User Filters section and select "Open Chat Session".</span>
            </div>
        `;
    }

    /**
     * Show context selection at the start of a new chat
     */
    showContextSelection() {
        // Hide input container until context is selected
        const inputContainer = document.getElementById('ai-input-container');
        if (inputContainer) {
            inputContainer.style.display = 'none';
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = 'ai-message ai-message-context-selection';

        messageDiv.innerHTML = `
            <div class="ai-context-selection-container">
                <h3>Choose your working context</h3>
                <p>Select whether you want to work on the font, or a script in the script editor, or a glyph filter script in the sidebar. This cannot be changed during the chat.</p>
                <div class="ai-context-selection-buttons">
                    ${ChatSessionManager.getContextSelectionButtonsHTML()}
                </div>
                ${ChatSessionManager.getGlyphFilterExplainerHTML()}
            </div>
        `;

        this.aiAssistant.messagesContainer.appendChild(messageDiv);

        // Add event listeners to buttons
        const buttons = messageDiv.querySelectorAll(
            '.ai-context-selection-btn'
        );
        buttons.forEach((btn) => {
            btn.addEventListener('click', (e) => {
                // Skip if button is disabled
                if (btn.disabled) return;

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

        let contextLabel, contextDescription, contextIcon, contextClass;
        switch (context) {
            case 'script':
                contextLabel = 'Script Context';
                contextDescription = 'Creating or editing reusable scripts';
                contextIcon = 'code';
                contextClass = 'ai-context-tag-script';
                break;
            case 'glyphfilter':
                contextLabel = 'Glyph Filter Context';
                contextDescription = 'Creating or editing glyph filter scripts';
                contextIcon = 'filter_alt';
                contextClass = 'ai-context-tag-glyphfilter';
                break;
            default:
                contextLabel = 'Font Context';
                contextDescription = 'Working directly on the current font';
                contextIcon = 'font_download';
                contextClass = 'ai-context-tag-font';
        }

        messageDiv.innerHTML = `
            <div class="ai-system-message">
                <span class="ai-context-display-icon ${contextClass}"><span class="material-symbols-outlined">${contextIcon}</span></span>
                <div>
                    <strong>${contextLabel} selected</strong>
                    <p>${contextDescription}</p>
                </div>
            </div>
        `;

        this.aiAssistant.messagesContainer.appendChild(messageDiv);
        this.aiAssistant.scrollToBottom();

        // Show input container
        const inputContainer = document.getElementById('ai-input-container');
        if (inputContainer) {
            inputContainer.style.display = 'flex';
        }

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

            // Set current chat ID and save to localStorage
            this.currentChatId = data.chatSession.id;
            localStorage.setItem('ai_last_chat_id', this.currentChatId);

            // Set context using setContext to ensure all UI updates happen
            this.aiAssistant.setContext(data.chatSession.contextType);
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
                let contextLabel, contextIcon, contextClass;
                switch (data.chatSession.contextType) {
                    case 'script':
                        contextLabel = 'Script Context';
                        contextIcon = 'code';
                        contextClass = 'ai-context-tag-script';
                        break;
                    case 'glyphfilter':
                        contextLabel = 'Glyph Filter Context';
                        contextIcon = 'filter_alt';
                        contextClass = 'ai-context-tag-glyphfilter';
                        break;
                    default:
                        contextLabel = 'Font Context';
                        contextIcon = 'font_download';
                        contextClass = 'ai-context-tag-font';
                }
                contextDisplay.innerHTML = `<span class="ai-context-display-icon ${contextClass}"><span class="material-symbols-outlined">${contextIcon}</span></span><span class="ai-context-display-text">${contextLabel}</span><span class="ai-context-display-hint">Start a new chat to change context</span>`;
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

            // Show input container when loading a chat
            const inputContainer =
                document.getElementById('ai-input-container');
            if (inputContainer) {
                inputContainer.style.display = 'flex';
            }

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
            // Check if we have a saved chat ID in localStorage
            const savedChatId = localStorage.getItem('ai_last_chat_id');

            if (savedChatId) {
                // Try to load the saved chat
                console.log(`[ChatSession] Loading saved chat: ${savedChatId}`);
                try {
                    await this.loadChatSession(savedChatId);
                    return; // Successfully loaded saved chat
                } catch (error) {
                    console.log(
                        '[ChatSession] Saved chat not available, falling back to last chat:',
                        error.message
                    );
                    // Clear invalid chat ID from localStorage
                    localStorage.removeItem('ai_last_chat_id');
                    // Continue to load chronologically last chat
                }
            }

            // Fall back to loading chronologically last chat from API
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
                // Show context selection for new chat
                this.showContextSelection();
                return;
            }

            const data = await response.json();

            if (!data.chatSession) {
                console.log('[ChatSession] No chat history found');
                // Show context selection for new chat
                this.showContextSelection();
                return;
            }

            // Load the chat and save to localStorage
            this.currentChatId = data.chatSession.id;
            localStorage.setItem('ai_last_chat_id', this.currentChatId);

            // Set context using setContext to ensure all UI updates happen
            this.aiAssistant.setContext(data.chatSession.contextType);
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
                let contextLabel, contextIcon, contextClass;
                switch (data.chatSession.contextType) {
                    case 'script':
                        contextLabel = 'Script Context';
                        contextIcon = 'code';
                        contextClass = 'ai-context-tag-script';
                        break;
                    case 'glyphfilter':
                        contextLabel = 'Glyph Filter Context';
                        contextIcon = 'filter_alt';
                        contextClass = 'ai-context-tag-glyphfilter';
                        break;
                    default:
                        contextLabel = 'Font Context';
                        contextIcon = 'font_download';
                        contextClass = 'ai-context-tag-font';
                }
                contextDisplay.innerHTML = `<span class="ai-context-display-icon ${contextClass}"><span class="material-symbols-outlined">${contextIcon}</span></span><span class="ai-context-display-text">${contextLabel}</span><span class="ai-context-display-hint">Start a new chat to change context</span>`;
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

            // Show input container when loading last chat
            const inputContainer =
                document.getElementById('ai-input-container');
            if (inputContainer) {
                inputContainer.style.display = 'flex';
            }

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

            console.log(
                '[ChatSession] Session token for chat-sessions API:',
                sessionToken ? sessionToken.substring(0, 20) + '...' : 'NONE'
            );
            console.log(
                '[ChatSession] authManager exists:',
                !!window.authManager
            );

            const headers = {
                'Content-Type': 'application/json'
            };

            if (sessionToken) {
                headers['Authorization'] = `Bearer ${sessionToken}`;
                console.log('[ChatSession] Added Authorization header');
            } else {
                console.log(
                    '[ChatSession] No session token - relying on credentials: include'
                );
            }

            console.log(
                '[ChatSession] Fetching from:',
                `${this.aiAssistant.websiteURL}/api/ai/chat-sessions`
            );

            const response = await fetch(
                `${this.aiAssistant.websiteURL}/api/ai/chat-sessions`,
                {
                    method: 'GET',
                    credentials: 'include',
                    headers: headers
                }
            );

            console.log('[ChatSession] Response status:', response.status);
            console.log(
                '[ChatSession] Response headers:',
                Array.from(response.headers.entries())
            );

            if (!response.ok) {
                console.error(
                    '[ChatSession] Failed to load chat history:',
                    response.status,
                    response.statusText
                );
                const errorText = await response.text();
                console.error('[ChatSession] Response:', errorText);

                // Handle authentication errors
                if (response.status === 401) {
                    // Not authenticated - show message in the menu
                    this.chatHistory = [];
                    this.showAuthenticationRequired();
                }
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
     * Show authentication required message in chat history menu
     */
    showAuthenticationRequired() {
        const container = document.getElementById('ai-chat-history-list');
        if (!container) return;

        container.innerHTML = `
            <div class="ai-chat-history-empty">
                <span class="material-symbols-outlined" style="font-size: 48px; opacity: 0.3;">lock</span>
                <p>Please sign in to view chat history</p>
                <button class="ai-chat-history-login-btn" onclick="window.authManager && window.authManager.login()">
                    Sign In
                </button>
            </div>
        `;
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
                session.contextType === 'font'
                    ? 'font_download'
                    : session.contextType === 'glyphfilter'
                      ? 'filter_alt'
                      : 'code';
            const contextClass =
                session.contextType === 'font'
                    ? 'font-context'
                    : session.contextType === 'glyphfilter'
                      ? 'glyphfilter-context'
                      : 'script-context';

            // Handle date parsing more robustly
            let timeAgo = 'Unknown';
            try {
                // Try lastActivityAt first, fall back to updatedAt or createdAt
                const dateField =
                    session.lastActivityAt ||
                    session.updatedAt ||
                    session.createdAt;
                if (dateField) {
                    const timestamp = new Date(dateField).getTime();
                    if (!isNaN(timestamp)) {
                        timeAgo = this.formatRelativeTime(timestamp);
                    }
                } else {
                    console.warn(
                        '[ChatSession] No date field found for session:',
                        session
                    );
                }
            } catch (e) {
                console.error(
                    '[ChatSession] Error parsing date:',
                    session.lastActivityAt,
                    session.updatedAt,
                    session.createdAt,
                    e
                );
            }

            item.innerHTML = `
                <div class="ai-chat-history-item-icon ${contextClass}">
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

            // Scroll active item into view
            if (session.id === this.currentChatId) {
                requestAnimationFrame(() => {
                    item.scrollIntoView({
                        behavior: 'smooth',
                        block: 'nearest'
                    });
                });
            }
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
