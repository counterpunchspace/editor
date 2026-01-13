// AI Assistant for Font Editing
// Sends prompts to Anthropic Claude with Python API docs
// Executes generated Python code with error handling and retry

class AIAssistant {
    constructor() {
        this.messages = [];
        this.conversationHistory = [];
        this.maxRetries = 3;
        this.autoRun = localStorage.getItem('ai_auto_run') !== 'false'; // Default to true
        this.isShowingErrorFix = false; // Flag to prevent duplicate error fix messages
        this.isAuthenticated = false; // Track authentication state
        this.hasLoadedLastChat = false; // Flag to prevent loading last chat multiple times

        // Get website URL for API calls
        this.websiteURL = this.getWebsiteURL();

        // Initialize chat session manager
        this.sessionManager = null; // Will be initialized after UI setup

        // Configure marked.js for markdown parsing
        if (typeof marked !== 'undefined') {
            marked.setOptions({
                breaks: true,
                gfm: true,
                headerIds: false,
                mangle: false
            });
        }

        this.initUI();
        this.checkAuthenticationStatus();
    }

    getWebsiteURL() {
        // Detect environment and return appropriate website URL
        const hostname = window.location.hostname;

        if (hostname === 'localhost' || hostname === '127.0.0.1') {
            return 'http://localhost:8788'; // Local development
        }

        // Production font editor URL
        if (hostname === 'production.fonteditor-863.pages.dev') {
            return 'https://fonteditorwebsite.pages.dev';
        }

        // Default to production website
        return 'https://fonteditorwebsite.pages.dev';
    }

    async checkAuthenticationStatus() {
        // Wait for authManager to be available
        if (!window.authManager) {
            setTimeout(() => this.checkAuthenticationStatus(), 100);
            return;
        }

        // Listen for auth state changes first
        const originalCallback = window.authManager.onAuthStateChanged;
        window.authManager.onAuthStateChanged = (
            isAuthenticated,
            user,
            subscription
        ) => {
            this.isAuthenticated = isAuthenticated;
            this.subscription = subscription;
            this.updateAuthUI();
            if (originalCallback) {
                originalCallback.call(
                    window.authManager,
                    isAuthenticated,
                    user,
                    subscription
                );
            }
        };

        // Check if user is authenticated (this will trigger onAuthStateChanged)
        const user = await window.authManager.checkAuthStatus();
        this.isAuthenticated = !!user;
        // Get subscription from authManager after check
        this.subscription = window.authManager.subscription;
        this.updateAuthUI();
    }

    updateAuthUI() {
        const chatContainer = document.getElementById('ai-chat-container');
        const loginContainer = document.getElementById('ai-login-container');
        const subscriptionContainer = document.getElementById(
            'ai-subscription-container'
        );

        if (!chatContainer || !loginContainer || !subscriptionContainer) return;

        if (!this.isAuthenticated) {
            // Not logged in - show login
            chatContainer.style.display = 'none';
            loginContainer.style.display = 'flex';
            subscriptionContainer.style.display = 'none';
        } else if (!this.subscription || !this.subscription.isAdvanced) {
            // Logged in but no Advanced subscription - show upgrade message
            chatContainer.style.display = 'none';
            loginContainer.style.display = 'none';
            subscriptionContainer.style.display = 'flex';
        } else {
            // Logged in with Advanced subscription - show chat
            chatContainer.style.display = 'flex';
            loginContainer.style.display = 'none';
            subscriptionContainer.style.display = 'none';

            // Load last chat session if available
            if (this.sessionManager && !this.hasLoadedLastChat) {
                this.hasLoadedLastChat = true;
                this.sessionManager.loadLastChat();
            }
        }
    }

    initUI() {
        // Get DOM elements
        this.promptInput = document.getElementById('ai-prompt');
        this.sendButton = document.getElementById('ai-send-btn');
        this.messagesContainer = document.getElementById('ai-messages');
        this.isAssistantViewFocused = false;

        // Restore saved context or default to 'font'
        const savedContext = localStorage.getItem('ai_context');
        this.context = savedContext || 'font';

        // Update context label
        this.updateContextLabel();

        // Event listeners
        this.sendButton.addEventListener('click', (event) => {
            event.stopPropagation(); // Prevent view focus
            this.sendPrompt();
            // Restore cursor to input field
            if (this.promptInput) {
                this.promptInput.focus();
                if (this._updateCursor) {
                    setTimeout(() => this._updateCursor(), 0);
                }
            }
        });

        // Setup info modal
        this.setupInfoModal();

        // Setup login button
        this.setupLoginButton();

        // Setup context selection
        this.setupContextSelection();

        // Setup chat buttons (new chat, history)
        this.setupChatButtons();

        // Setup auto-run checkbox
        this.setupAutoRunCheckbox();

        // Set default model from server settings
        this.setDefaultModel();

        // Initialize session manager after UI is ready
        console.log(
            '[AIAssistant] ChatSessionManager available:',
            typeof ChatSessionManager !== 'undefined'
        );
        if (typeof ChatSessionManager !== 'undefined') {
            this.sessionManager = new ChatSessionManager(this);
            console.log(
                '[AIAssistant] SessionManager initialized:',
                !!this.sessionManager
            );
        } else {
            console.error('[AIAssistant] ChatSessionManager class not found!');
        }

        // Add click handler for assistant view to focus text field when scrolled to bottom
        this.setupAssistantViewClickHandler();

        // Send on Cmd+Enter
        this.promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                // Don't send if modal is open
                const modal = document.getElementById('diff-review-modal');
                if (modal && modal.classList.contains('active')) {
                    return;
                }
                e.preventDefault(); // Prevent newline
                this.sendPrompt();
            }
        });

        // Listen for view focus events
        window.addEventListener('viewFocused', (event) => {
            this.isAssistantViewFocused =
                event.detail.viewId === 'view-assistant';
            this.updateContextLabel(); // Update context label appearance based on focus
            this.updateSendButtonShortcut(); // Show/hide shortcut based on focus
        });

        // Initialize shortcut visibility
        this.updateSendButtonShortcut();

        // Add global keyboard shortcuts when assistant is focused
        document.addEventListener('keydown', (event) => {
            // Skip if event already handled
            if (event.defaultPrevented) return;

            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
            const cmdKey = isMac ? event.metaKey : event.ctrlKey;
            const code = event.code;

            // Check if Cmd+Alt+R
            if (
                cmdKey &&
                event.altKey &&
                code === 'KeyR' &&
                this.isAssistantViewFocused
            ) {
                event.preventDefault();

                if (this.context === 'script') {
                    // In script context: trigger Review Changes button
                    const reviewButtons = document.querySelectorAll(
                        '.ai-review-changes-btn'
                    );
                    if (reviewButtons.length > 0) {
                        const lastButton =
                            reviewButtons[reviewButtons.length - 1];
                        if (!lastButton.disabled) {
                            lastButton.click();
                        }
                    }
                } else {
                    // In font context: trigger Run in Console button
                    const runButtons = document.querySelectorAll(
                        '.ai-run-in-console-btn'
                    );
                    if (runButtons.length > 0) {
                        const lastButton = runButtons[runButtons.length - 1];
                        if (!lastButton.disabled) {
                            lastButton.click();
                        }
                    }
                }
            }

            // Check if Cmd+Alt+O to open last visible code in script editor
            if (
                cmdKey &&
                event.altKey &&
                !event.shiftKey &&
                code === 'KeyO' &&
                this.isAssistantViewFocused
            ) {
                event.preventDefault();

                // Find all visible open in editor buttons
                const openButtons = document.querySelectorAll(
                    '.ai-open-in-editor-btn'
                );

                if (openButtons.length > 0) {
                    // Get the last button and trigger it
                    const lastButton = openButtons[openButtons.length - 1];
                    if (!lastButton.disabled) {
                        lastButton.click();
                    }
                }
            }
        });
    }

    updateContextLabel() {
        const contextLabel = document.getElementById('ai-context-label');
        const promptPrefix = document.getElementById('ai-prompt-prefix');

        if (!contextLabel || !promptPrefix) return;

        // Update text content and context classes
        if (this.context === 'font') {
            promptPrefix.textContent = '>>>';
            contextLabel.innerHTML =
                '<span id="ai-prompt-prefix">>>></span> Font Context';
            contextLabel.classList.add('font-context');
            contextLabel.classList.remove('script-context');
        } else {
            promptPrefix.textContent = '>>>';
            contextLabel.innerHTML =
                '<span id="ai-prompt-prefix">>>></span> Script Context';
            contextLabel.classList.add('script-context');
            contextLabel.classList.remove('font-context');
        }
    }

    setupContextSelection() {
        const fontRadio = document.getElementById('ai-context-radio-font');
        const scriptRadio = document.getElementById('ai-context-radio-script');

        if (fontRadio && scriptRadio) {
            fontRadio.addEventListener('change', () => {
                if (fontRadio.checked) {
                    this.context = 'font';
                    localStorage.setItem('ai_context', 'font');
                    this.updateAutoRunVisibility();
                }
            });

            scriptRadio.addEventListener('change', () => {
                if (scriptRadio.checked) {
                    this.context = 'script';
                    localStorage.setItem('ai_context', 'script');
                    this.updateAutoRunVisibility();
                }
            });

            // Set initial state based on saved context
            if (this.context === 'font') {
                fontRadio.checked = true;
            } else {
                scriptRadio.checked = true;
            }
        }
    }

    /**
     * Set the context (font or script) and update all related UI
     */
    setContext(context) {
        this.context = context;
        localStorage.setItem('ai_context', context);

        // Update radio buttons
        const fontRadio = document.getElementById('ai-context-radio-font');
        const scriptRadio = document.getElementById('ai-context-radio-script');
        if (fontRadio && scriptRadio) {
            fontRadio.checked = context === 'font';
            scriptRadio.checked = context === 'script';
        }

        // Update context display
        const contextSelector = document.getElementById('ai-context-selector');
        const contextDisplay = document.getElementById('ai-context-display');
        if (contextSelector) contextSelector.classList.add('hidden');
        if (contextDisplay) {
            contextDisplay.classList.remove('hidden');
            const contextLabel =
                context === 'font' ? 'Font Context' : 'Script Context';
            const contextIcon = context === 'font' ? 'font_download' : 'code';
            const contextClass =
                context === 'font'
                    ? 'ai-context-tag-font'
                    : 'ai-context-tag-script';
            contextDisplay.innerHTML = `<span class="ai-context-display-icon ${contextClass}"><span class="material-symbols-outlined">${contextIcon}</span></span><span class="ai-context-display-text">${contextLabel}</span><span class="ai-context-display-hint">Start a new chat to change context</span>`;
        }

        // Update auto-run visibility
        this.updateAutoRunVisibility();
    }

    async setDefaultModel() {
        this.modelBtn = document.getElementById('ai-model-btn');
        this.modelBtnName = document.getElementById('ai-model-btn-name');
        this.modelPickerOverlay = document.getElementById(
            'ai-model-picker-overlay'
        );
        this.modelPickerList = document.getElementById('ai-model-picker-list');
        this.modelPickerClose = document.getElementById(
            'ai-model-picker-close'
        );

        if (!this.modelBtn) return;

        // Store models for later reference
        this.availableModels = [];
        this.selectedModelId = null;

        try {
            // Fetch models and default from server settings
            const response = await fetch(`${this.websiteURL}/api/ai/settings`);
            if (response.ok) {
                const settings = await response.json();
                console.log('[AI] Settings received:', settings);

                this.availableModels = settings.models;

                // Restore saved model from localStorage, or use server default
                const savedModel = localStorage.getItem('ai_selected_model');
                const validModel = this.availableModels.find(
                    (m) => m.id === savedModel
                );
                if (validModel) {
                    this.selectedModelId = savedModel;
                    console.log('[AI] Restored saved model:', savedModel);
                } else if (settings.defaultModel) {
                    this.selectedModelId = settings.defaultModel;
                    console.log(
                        '[AI] Using default model:',
                        settings.defaultModel
                    );
                } else if (this.availableModels.length > 0) {
                    this.selectedModelId = this.availableModels[0].id;
                }

                this.updateModelButtonText();
                this.populateModelPicker();
                this.setupModelPickerEvents();
            }
        } catch (error) {
            console.error('[AI] Failed to load models:', error);
            // Fallback model
            this.availableModels = [
                {
                    id: 'claude-haiku-4-5-20251001',
                    shortName: 'Haiku',
                    description: 'Fast, efficient model',
                    hint: 'Best for simple tasks',
                    price: '$0.25/1M tokens'
                }
            ];
            this.selectedModelId = 'claude-haiku-4-5-20251001';
            this.updateModelButtonText();
            this.populateModelPicker();
            this.setupModelPickerEvents();
        }
    }

    updateModelButtonText() {
        const model = this.availableModels.find(
            (m) => m.id === this.selectedModelId
        );
        if (model && this.modelBtnName) {
            this.modelBtnName.textContent = model.shortName;
        }
    }

    populateModelPicker() {
        if (!this.modelPickerList) return;

        this.modelPickerList.innerHTML = '';

        this.availableModels.forEach((model) => {
            const option = document.createElement('div');
            option.className =
                'ai-model-option' +
                (model.id === this.selectedModelId ? ' selected' : '');
            option.dataset.modelId = model.id;

            option.innerHTML = `
                <div class="ai-model-option-header">
                    <span class="ai-model-option-name">${model.shortName}</span>
                    <span class="ai-model-option-price">${model.price || ''}</span>
                </div>
                ${model.description ? `<div class="ai-model-option-description">${model.description}</div>` : ''}
                ${model.hint ? `<div class="ai-model-option-hint">${model.hint}</div>` : ''}
            `;

            option.addEventListener('click', () => this.selectModel(model.id));
            this.modelPickerList.appendChild(option);
        });
    }

    selectModel(modelId) {
        this.selectedModelId = modelId;
        localStorage.setItem('ai_selected_model', modelId);
        console.log('[AI] Saved model selection:', modelId);

        this.updateModelButtonText();

        // Update selected state in picker
        const options =
            this.modelPickerList.querySelectorAll('.ai-model-option');
        options.forEach((opt) => {
            opt.classList.toggle('selected', opt.dataset.modelId === modelId);
        });

        this.closeModelPicker();
    }

    setupModelPickerEvents() {
        // Open modal
        this.modelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openModelPicker();
        });

        // Close button
        if (this.modelPickerClose) {
            this.modelPickerClose.addEventListener('click', () =>
                this.closeModelPicker()
            );
        }

        // Close on overlay click
        if (this.modelPickerOverlay) {
            this.modelPickerOverlay.addEventListener('click', (e) => {
                if (e.target === this.modelPickerOverlay) {
                    this.closeModelPicker();
                }
            });
        }

        // Close on Escape key
        this._modelPickerEscHandler = (e) => {
            if (
                e.key === 'Escape' &&
                this.modelPickerOverlay.style.display !== 'none'
            ) {
                this.closeModelPicker();
            }
        };
        document.addEventListener('keydown', this._modelPickerEscHandler);
    }

    openModelPicker() {
        if (this.modelPickerOverlay) {
            this.modelPickerOverlay.style.display = 'flex';
        }
    }

    closeModelPicker() {
        if (this.modelPickerOverlay) {
            this.modelPickerOverlay.style.display = 'none';
        }
    }

    setupChatButtons() {
        console.log('[AIAssistant] Setting up chat buttons');
        const newChatBtn = document.getElementById('ai-new-chat-btn');
        const historyBtn = document.getElementById('ai-chat-history-btn');
        console.log('[AIAssistant] New chat button found:', !!newChatBtn);
        console.log('[AIAssistant] History button found:', !!historyBtn);

        if (newChatBtn) {
            newChatBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                this.startNewChat();
            });
        }

        if (historyBtn) {
            historyBtn.addEventListener('click', (event) => {
                console.log('[AIAssistant] Chat history button clicked');
                event.stopPropagation();
                console.log(
                    '[AIAssistant] SessionManager exists:',
                    !!this.sessionManager
                );
                console.log(
                    '[AIAssistant] SessionManager type:',
                    typeof this.sessionManager
                );
                if (this.sessionManager) {
                    console.log('[AIAssistant] Calling openChatHistoryMenu()');
                    try {
                        this.sessionManager.openChatHistoryMenu();
                        console.log(
                            '[AIAssistant] openChatHistoryMenu() called successfully'
                        );
                    } catch (error) {
                        console.error(
                            '[AIAssistant] Error calling openChatHistoryMenu():',
                            error
                        );
                    }
                } else {
                    console.error(
                        '[AIAssistant] SessionManager not initialized!'
                    );
                }
            });
            console.log(
                '[AIAssistant] Chat history button click handler attached'
            );
        }

        // Setup close button for chat history menu
        const closeBtn = document.getElementById('ai-chat-history-close-btn');
        const backdrop = document.getElementById('ai-chat-history-backdrop');

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                if (this.sessionManager) {
                    this.sessionManager.closeChatHistoryMenu();
                }
            });
        }

        if (backdrop) {
            backdrop.addEventListener('click', () => {
                if (this.sessionManager) {
                    this.sessionManager.closeChatHistoryMenu();
                }
            });
        }

        // Setup Escape key to close chat history menu
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const menu = document.getElementById('ai-chat-history-menu');
                if (
                    menu &&
                    menu.style.display === 'block' &&
                    this.sessionManager
                ) {
                    this.sessionManager.closeChatHistoryMenu();
                }
            }
        });
    }

    startNewChat() {
        if (this.messages.length > 0) {
            if (!confirm('Start a new chat? The current chat will be saved.')) {
                return;
            }
        }

        // Reset chat state
        if (this.sessionManager) {
            this.sessionManager.currentChatId = null;
            this.sessionManager.isContextLocked = false;
        }

        // Clear messages
        this.messages = [];
        this.messagesContainer.innerHTML = '';

        // Show context selector again
        const contextSelector = document.getElementById('ai-context-selector');
        const contextDisplay = document.getElementById('ai-context-display');
        if (contextSelector) {
            contextSelector.classList.remove('hidden');
        }
        if (contextDisplay) {
            contextDisplay.classList.add('hidden');
        }

        // Focus input
        if (this.promptInput) {
            this.promptInput.focus();
        }

        console.log('[AIAssistant] New chat started');
    }

    setupAutoRunCheckbox() {
        const checkbox = document.getElementById('ai-auto-run-checkbox');
        if (!checkbox) return;

        // Set initial state from localStorage
        checkbox.checked = this.autoRun;

        // Update localStorage and instance variable when changed
        checkbox.addEventListener('change', () => {
            this.autoRun = checkbox.checked;
            localStorage.setItem(
                'ai_auto_run',
                checkbox.checked ? 'true' : 'false'
            );
            console.log('[AIAssistant] Auto-run set to:', this.autoRun);
        });

        // Show/hide checkbox based on context
        this.updateAutoRunVisibility();
    }

    updateAutoRunVisibility() {
        const label = document.querySelector('.ai-auto-run-label');
        if (!label) return;

        // Only show in font context
        if (this.context === 'font') {
            label.style.display = 'flex';
        } else {
            label.style.display = 'none';
        }
    }

    setupLoginButton() {
        const loginBtn = document.getElementById('ai-login-btn');
        if (!loginBtn) return;

        loginBtn.addEventListener('click', () => {
            if (window.authManager) {
                window.authManager.login();
            } else {
                console.error('[AIAssistant] AuthManager not available');
            }
        });

        // Setup Account button for subscription required message
        const accountBtn = document.getElementById('ai-account-btn');
        if (accountBtn) {
            accountBtn.addEventListener('click', () => {
                if (window.authManager) {
                    window.open(
                        `${window.authManager.websiteURL}/account`,
                        '_blank'
                    );
                } else {
                    console.error('[AIAssistant] AuthManager not available');
                }
            });
        }
    }

    setupAssistantViewClickHandler() {
        const assistantView = document.getElementById('view-assistant');
        if (!assistantView) return;

        assistantView.addEventListener('click', (event) => {
            // Don't activate if clicking on a button or select
            if (
                event.target.closest('button') ||
                event.target.closest('select')
            ) {
                return;
            }

            // Don't activate if clicking on the text field itself
            if (event.target.id === 'ai-prompt') {
                return;
            }

            // Check if scrolled to bottom
            const viewContent = assistantView.querySelector('.view-content');
            if (viewContent) {
                const isAtBottom =
                    viewContent.scrollHeight - viewContent.scrollTop <=
                    viewContent.clientHeight + 5; // 5px threshold

                // If at bottom, focus the text field
                if (isAtBottom && this.promptInput) {
                    this.promptInput.focus();
                    this.promptInput.click();
                }
            }
        });
    }

    setupInfoModal() {
        const infoButton = document.getElementById('ai-info-btn');
        const modal = document.getElementById('ai-info-modal');
        const closeBtn = document.getElementById('ai-info-modal-close-btn');

        if (!infoButton || !modal || !closeBtn) return;

        // Open modal
        infoButton.addEventListener('click', (event) => {
            event.stopPropagation();
            modal.style.display = 'flex';
        });

        // Close modal
        const closeModal = () => {
            modal.style.display = 'none';
            // Restore cursor to input field after closing modal
            if (this.promptInput && this.isAssistantViewFocused) {
                this.promptInput.focus();
                if (this._updateCursor) {
                    setTimeout(() => this._updateCursor(), 0);
                }
            }
            // Restore focus to canvas if editor view was active
            const editorView = document.getElementById('view-editor');
            if (
                editorView &&
                editorView.classList.contains('focused') &&
                window.glyphCanvas &&
                window.glyphCanvas.canvas
            ) {
                setTimeout(() => window.glyphCanvas.canvas.focus(), 0);
            }
        };

        closeBtn.addEventListener('click', closeModal);

        // Close on backdrop click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'flex') {
                e.preventDefault();
                e.stopPropagation();
                closeModal();
            }
        });
    }

    updateButtonShortcuts() {
        // Remove shortcuts from ALL buttons first
        const allRunButtons = document.querySelectorAll(
            '.ai-run-in-console-btn'
        );
        allRunButtons.forEach((btn) => {
            const text = btn.textContent || btn.innerText;
            if (text.includes('Run in Console')) {
                btn.innerHTML =
                    '<span class="material-symbols-outlined">play_arrow</span>Run in Console';
            }
        });

        const allOpenButtons = document.querySelectorAll(
            '.ai-open-in-editor-btn'
        );
        allOpenButtons.forEach((btn) => {
            const text = btn.textContent || btn.innerText;
            if (text.includes('Open in Script Editor Without Review')) {
                btn.innerHTML =
                    '<span class="material-symbols-outlined">edit_note</span>Open in Script Editor Without Review';
            } else if (text.includes('Open in Script Editor')) {
                btn.innerHTML =
                    '<span class="material-symbols-outlined">edit_note</span>Open in Script Editor';
            }
        });

        const allReviewButtons = document.querySelectorAll(
            '.ai-review-changes-btn'
        );
        allReviewButtons.forEach((btn) => {
            const text = btn.textContent || btn.innerText;
            if (text.includes('Review Changes')) {
                btn.innerHTML =
                    '<span class="material-symbols-outlined">difference</span>Review Changes';
            }
        });

        // Find the last message with buttons (most recent output message)
        const allMessages = document.querySelectorAll('.ai-message-output');
        if (allMessages.length === 0) return;

        const lastMessage = allMessages[allMessages.length - 1];

        // Add shortcuts ONLY to buttons in the last message
        // Check for Run in Console button (font context)
        const runButton = lastMessage.querySelector('.ai-run-in-console-btn');
        if (runButton) {
            runButton.innerHTML =
                '<span class="material-symbols-outlined">play_arrow</span>Run in Console <span class="ai-btn-shortcut"><span class="material-symbols-outlined">keyboard_command_key</span><span class="material-symbols-outlined">keyboard_option_key</span>R</span>';
        }

        // Check for Review Changes button (script context)
        const reviewButton = lastMessage.querySelector(
            '.ai-review-changes-btn'
        );
        if (reviewButton) {
            reviewButton.innerHTML =
                '<span class="material-symbols-outlined">difference</span>Review Changes <span class="ai-btn-shortcut"><span class="material-symbols-outlined">keyboard_command_key</span><span class="material-symbols-outlined">keyboard_option_key</span>R</span>';
        }

        // Check for Open in Script Editor button
        const openButton = lastMessage.querySelector('.ai-open-in-editor-btn');
        if (openButton) {
            const text = openButton.textContent || openButton.innerText;
            if (text.includes('Open in Script Editor Without Review')) {
                openButton.innerHTML =
                    '<span class="material-symbols-outlined">edit_note</span>Open in Script Editor Without Review <span class="ai-btn-shortcut"><span class="material-symbols-outlined">keyboard_command_key</span><span class="material-symbols-outlined">keyboard_option_key</span>O</span>';
            } else {
                openButton.innerHTML =
                    '<span class="material-symbols-outlined">edit_note</span>Open in Script Editor <span class="ai-btn-shortcut"><span class="material-symbols-outlined">keyboard_command_key</span><span class="material-symbols-outlined">keyboard_option_key</span>O</span>';
            }
        }
    }

    /**
     * Creates a message header HTML string
     * @param {string} role - 'user', 'assistant', 'output', 'error', 'system'
     * @param {object} options - Optional settings
     * @param {string} options.label - Custom label override
     * @param {string} options.icon - Custom Material Symbol icon name
     * @param {boolean} options.showContext - Whether to show context tag (default true)
     * @param {string} options.rightContent - Additional HTML for the right side
     * @returns {string} HTML string for the header
     */
    createMessageHeader(role, options = {}) {
        const timestamp = new Date().toLocaleTimeString();

        // Determine icon and label based on role
        let icon, label;
        switch (role) {
            case 'user':
                icon = options.icon || 'person';
                label = options.label || 'You';
                break;
            case 'assistant':
            case 'output':
                icon = options.icon || 'attach_file';
                label =
                    options.label ||
                    (role === 'output' ? 'Output' : 'Assistant');
                break;
            case 'error':
                icon = options.icon || 'warning';
                label = options.label || 'Script Error';
                break;
            case 'system':
                icon = options.icon || 'info';
                label = options.label || 'System';
                break;
            default:
                icon = options.icon || 'attach_file';
                label = options.label || 'AI';
        }

        const iconHtml = `<span class="material-symbols-outlined">${icon}</span>`;

        if (options.rightContent) {
            return `
                <div class="ai-message-header">
                    <span>${iconHtml} ${label} - ${timestamp}</span>
                    <div class="ai-message-header-right">
                        ${options.rightContent}
                    </div>
                </div>`;
        }

        return `<div class="ai-message-header"><span>${iconHtml} ${label} - ${timestamp}</span></div>`;
    }

    addMessage(role, content, isCode = false, isCollapsible = false) {
        // Show messages container on first message
        if (
            this.messagesContainer.style.display === 'none' ||
            !this.messagesContainer.style.display
        ) {
            this.messagesContainer.style.display = 'block';
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = `ai-message ai-message-${role}`;

        const header = this.createMessageHeader(role);

        let body;
        if (isCode) {
            if (isCollapsible) {
                // Collapsible code block
                const codeId =
                    'code-' +
                    Date.now() +
                    Math.random().toString(36).substr(2, 9);
                const btnId =
                    'btn-' +
                    Date.now() +
                    Math.random().toString(36).substr(2, 9);
                body = `
                    <div class="ai-code-collapsible">
                        <button class="ai-code-toggle" id="${btnId}" onclick="
                            const code = document.getElementById('${codeId}');
                            const btn = document.getElementById('${btnId}');
                            code.classList.toggle('collapsed');
                            if (code.classList.contains('collapsed')) {
                                btn.textContent = '▶ Show Python Code';
                            } else {
                                btn.textContent = '▼ Hide Python Code';
                            }
                        ">▶ Show Python Code</button>
                        <pre class="ai-code collapsed" id="${codeId}"><code>${this.escapeHtml(content)}</code></pre>
                    </div>`;
            } else {
                body = `<pre class="ai-code"><code>${this.escapeHtml(content)}</code></pre>`;
            }
        } else {
            // For user messages, check if there's script context to show collapsibly
            if (role === 'user') {
                const scriptContextMatch = content.match(
                    /Current script in editor:\s*```python\s*\n([\s\S]*?)```\s*\n\nUser request: ([\s\S]*)/
                );
                if (scriptContextMatch) {
                    const scriptCode = scriptContextMatch[1];
                    const userRequest = scriptContextMatch[2];
                    const codeId =
                        'code-' +
                        Date.now() +
                        Math.random().toString(36).substr(2, 9);
                    const btnId =
                        'btn-' +
                        Date.now() +
                        Math.random().toString(36).substr(2, 9);

                    // Create toggle link for header
                    const codeToggleHtml = `<span class="ai-code-toggle-link" id="${btnId}" onclick="
                        const code = document.getElementById('${codeId}');
                        const btn = document.getElementById('${btnId}');
                        code.classList.toggle('collapsed');
                        if (code.classList.contains('collapsed')) {
                            btn.textContent = '▶ Show Origin Script';
                        } else {
                            btn.textContent = '▼ Hide Origin Script';
                        }
                    ">▶ Show Origin Script</span>`;

                    // Recreate header with toggle link
                    const headerWithToggle = this.createMessageHeader(role, {
                        rightContent: codeToggleHtml
                    });

                    body = `
                        <pre class="ai-code collapsed" id="${codeId}"><code>${this.escapeHtml(scriptCode)}</code></pre>
                        <div class="ai-message-content">${this.escapeHtml(userRequest)}</div>`;

                    messageDiv.innerHTML = headerWithToggle + body;

                    // Store the user request part as the prompt for reuse
                    content = userRequest;
                    messageDiv.setAttribute('data-prompt', content);

                    this.messagesContainer.appendChild(messageDiv);
                    this.messagesContainer.scrollTop =
                        this.messagesContainer.scrollHeight;
                    this.scrollToBottom();

                    return messageDiv;
                } else {
                    body = `<div class="ai-message-content">${this.escapeHtml(content)}</div>`;
                }
            } else {
                body = `<div class="ai-message-content">${this.escapeHtml(content)}</div>`;
            }
        }

        messageDiv.innerHTML = header + body;

        // Store the original prompt content in a data attribute for user messages
        if (role === 'user') {
            messageDiv.setAttribute('data-prompt', content);
        }

        this.messagesContainer.appendChild(messageDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

        // Scroll the view-content to bottom
        this.scrollToBottom();

        return messageDiv;
    }

    addReuseButtonsToOldMessages() {
        // Find all user messages that are not error tracebacks
        const allUserMessages =
            this.messagesContainer.querySelectorAll('.ai-message-user');
        const userMessages = Array.from(allUserMessages).filter(
            (msg) => !msg.hasAttribute('data-error-traceback')
        );

        if (userMessages.length === 0) return;

        // Add reuse buttons to ALL user messages (including the last one)
        for (let i = 0; i < userMessages.length; i++) {
            const messageDiv = userMessages[i];

            // Check if button already exists
            if (messageDiv.querySelector('.ai-reuse-prompt-btn')) continue;

            // Get the stored prompt
            const prompt = messageDiv.getAttribute('data-prompt');
            if (!prompt) continue;

            // Create buttons container with both reuse and copy buttons
            const reuseId =
                'reuse-' +
                Date.now() +
                '-' +
                i +
                '-' +
                Math.random().toString(36).substr(2, 9);
            const copyId =
                'copy-' +
                Date.now() +
                '-' +
                i +
                '-' +
                Math.random().toString(36).substr(2, 9);
            const buttonDiv = document.createElement('div');
            buttonDiv.className = 'ai-reuse-prompt-container';
            buttonDiv.innerHTML = `
                <button class="ai-btn ai-reuse-prompt-btn" id="${reuseId}"><span class="material-symbols-outlined">replay</span>Reuse prompt</button>
                <button class="ai-btn ai-copy-prompt-btn" id="${copyId}"><span class="material-symbols-outlined">content_copy</span>Copy prompt</button>
            `;

            // Add buttons after the content
            const contentDiv = messageDiv.querySelector('.ai-message-content');
            if (contentDiv) {
                messageDiv.appendChild(buttonDiv);

                // Add click handler for reuse button
                const reuseBtn = document.getElementById(reuseId);
                if (reuseBtn) {
                    reuseBtn.addEventListener('click', (event) => {
                        event.stopPropagation(); // Prevent view focus

                        this.promptInput.value = prompt;
                        this.promptInput.focus();

                        // Manually activate assistant view after focusing input
                        if (window.focusView) {
                            window.focusView('view-assistant');
                        }

                        // Play a subtle click sound if available
                        if (window.playSound) {
                            window.playSound('click');
                        }
                    });
                }

                // Add click handler for copy button
                const copyBtn = document.getElementById(copyId);
                if (copyBtn) {
                    copyBtn.addEventListener('click', async (event) => {
                        event.stopPropagation(); // Prevent view focus

                        try {
                            await navigator.clipboard.writeText(prompt);

                            // Show feedback
                            const originalText = copyBtn.innerHTML;
                            copyBtn.innerHTML =
                                '<span class="material-symbols-outlined">check_circle</span>Copied!';
                            setTimeout(() => {
                                copyBtn.innerHTML = originalText;
                            }, 2000);

                            // Play a subtle click sound if available
                            if (window.playSound) {
                                window.playSound('click');
                            }
                        } catch (err) {
                            console.error(
                                '[AIAssistant]',
                                'Failed to copy text:',
                                err
                            );
                            copyBtn.innerHTML =
                                '<span class="material-symbols-outlined">error</span>Failed';
                            setTimeout(() => {
                                copyBtn.innerHTML =
                                    '<span class="material-symbols-outlined">content_copy</span>Copy prompt';
                            }, 2000);
                        }
                    });
                }
            }
        }
    }

    scrollToBottom() {
        // Scroll the messages container
        if (this.messagesContainer) {
            this.messagesContainer.scrollTop =
                this.messagesContainer.scrollHeight;
        }

        // Scroll the view-content container
        setTimeout(() => {
            const viewContent = document.querySelector(
                '#view-assistant .view-content'
            );
            if (viewContent) {
                viewContent.scrollTop = viewContent.scrollHeight;
            }
        }, 50);
    }

    addOutputWithCode(output, code, markdownText = '', showRunButton = false) {
        // Show messages container on first message
        if (
            this.messagesContainer.style.display === 'none' ||
            !this.messagesContainer.style.display
        ) {
            this.messagesContainer.style.display = 'block';
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = 'ai-message ai-message-output';

        // Generate unique IDs
        const codeId =
            'code-' + Date.now() + Math.random().toString(36).substr(2, 9);
        const btnId =
            'btn-' + Date.now() + Math.random().toString(36).substr(2, 9);
        const runBtnId =
            'run-' + Date.now() + Math.random().toString(36).substr(2, 9);
        const openBtnId =
            'open-' + Date.now() + Math.random().toString(36).substr(2, 9);

        // Create toggle link for code visibility
        const codeToggleHtml = `<span class="ai-code-toggle-link" id="${btnId}" onclick="
            const code = document.getElementById('${codeId}');
            const btn = document.getElementById('${btnId}');
            code.classList.toggle('collapsed');
            if (code.classList.contains('collapsed')) {
                btn.textContent = '▶ Show Code';
            } else {
                btn.textContent = '▼ Hide Code';
            }
        ">▶ Show Code</span>`;

        const header = this.createMessageHeader('assistant', {
            rightContent: codeToggleHtml
        });

        // Show appropriate buttons based on context
        let buttonContainerHtml = '';
        if (this.context === 'script') {
            // Script context: show both Review Changes and Open in Script Editor buttons
            const directOpenBtnId =
                'direct-open-' +
                Date.now() +
                Math.random().toString(36).substr(2, 9);
            buttonContainerHtml = `
                <div class="ai-button-group">
                    <button class="ai-btn ai-review-changes-btn" id="${openBtnId}"><span class="material-symbols-outlined">difference</span>Review Changes</button>
                    <button class="ai-btn ai-open-in-editor-btn" id="${directOpenBtnId}"><span class="material-symbols-outlined">edit_note</span>Open in Script Editor Without Review</button>
                </div>`;
        } else if (showRunButton) {
            // Font context: show both buttons
            buttonContainerHtml = `
                <div class="ai-button-group">
                    <button class="ai-btn ai-open-in-editor-btn" id="${openBtnId}"><span class="material-symbols-outlined">edit_note</span>Open in Script Editor</button>
                    <button class="ai-btn ai-run-in-console-btn" id="${runBtnId}"><span class="material-symbols-outlined">play_arrow</span>Run in Console</button>
                </div>`;
        }

        // Show markdown explanation if present
        const markdownHtml =
            markdownText && markdownText.trim()
                ? `<div class="ai-markdown-explanation">${this.formatMarkdown(markdownText)}</div>`
                : '';

        // Show Python output if present
        const outputHtml =
            output && output.trim()
                ? `<div class="ai-python-output">${this.escapeHtml(output)}</div>`
                : '';

        const body = `
            <div class="ai-output-with-code">
                <pre class="ai-code collapsed" id="${codeId}"><code>${this.escapeHtml(code)}</code></pre>
                ${markdownHtml}
                ${outputHtml}
                ${buttonContainerHtml}
            </div>`;

        messageDiv.innerHTML = header + body;
        this.messagesContainer.appendChild(messageDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

        // Add event listeners for buttons if they exist
        const openBtn = document.getElementById(openBtnId);
        if (openBtn) {
            if (this.context === 'script') {
                // In script context, this is the Review Changes button
                openBtn.addEventListener('click', (event) => {
                    event.stopPropagation(); // Prevent view focus
                    this.showDiffReview(code, markdownText);
                });
            } else {
                // In font context, open directly in editor
                openBtn.addEventListener('click', (event) => {
                    event.stopPropagation(); // Prevent view focus
                    this.openCodeInEditor(code);
                });
            }
        }

        // Handle direct open button in script context
        if (this.context === 'script') {
            const directOpenBtnId = messageDiv.querySelector(
                '.ai-button-group .ai-open-in-editor-btn'
            )?.id;
            const directOpenBtn = document.getElementById(directOpenBtnId);
            if (directOpenBtn) {
                directOpenBtn.addEventListener('click', (event) => {
                    event.stopPropagation(); // Prevent view focus
                    this.openCodeInEditor(code);
                });
            }
        }

        if (showRunButton && this.context !== 'script') {
            const runBtn = document.getElementById(runBtnId);
            if (runBtn) {
                runBtn.addEventListener('click', async (event) => {
                    event.stopPropagation(); // Prevent view focus
                    runBtn.disabled = true;
                    runBtn.innerHTML =
                        '<span class="material-symbols-outlined">hourglass_empty</span>Running...';
                    try {
                        await this.runCodeInConsole(code);
                        runBtn.innerHTML =
                            '<span class="material-symbols-outlined">check_circle</span>Executed';
                        setTimeout(() => {
                            runBtn.innerHTML =
                                '<span class="material-symbols-outlined">play_arrow</span>Run in Console';
                            this.updateButtonShortcuts();
                            runBtn.disabled = false;
                        }, 2000);
                    } catch (error) {
                        console.error(
                            '[AIAssistant]',
                            'Error running code in console:',
                            error
                        );
                        runBtn.innerHTML =
                            '<span class="material-symbols-outlined">error</span>Error';
                        setTimeout(() => {
                            runBtn.innerHTML =
                                '<span class="material-symbols-outlined">play_arrow</span>Run in Console';
                            this.updateButtonShortcuts();
                            runBtn.disabled = false;
                        }, 2000);
                    }
                });
            }
        }

        // Update which buttons show shortcuts (only the last ones)
        this.updateButtonShortcuts();

        // Scroll the view-content to bottom
        this.scrollToBottom();

        return messageDiv;
    }

    async runCodeInConsole(code) {
        if (!window.pyodide) {
            throw new Error('Python environment not ready');
        }

        if (!window.term) {
            // Console not yet initialized - execute without terminal output
            console.warn(
                '[AIAssistant]',
                'Console terminal not available, executing Python code directly'
            );
            try {
                await window.pyodide.runPythonAsync(code);
                console.log(
                    '[AIAssistant]',
                    '✅ Code executed successfully (console terminal not available for output)'
                );

                // Play done sound
                if (window.playSound) {
                    window.playSound('done');
                }
                return; // Success
            } catch (error) {
                console.error(
                    '[AIAssistant]',
                    'Python execution error:',
                    error
                );
                throw error;
            }
        }

        try {
            // Switch to console view first
            const consoleView = document.getElementById('view-console');
            if (consoleView) {
                consoleView.click();
            }

            window.term.echo('---');
            window.term.echo('🚀 Running assistant-generated code...');
            await window.pyodide.runPythonAsync(code);
            window.term.echo('✅ Code executed successfully');

            // Play done sound
            if (window.playSound) {
                window.playSound('done');
            }
        } catch (error) {
            window.term.error('Error: ' + error.message);
            throw error;
        }
    }

    openCodeInEditor(code) {
        // Get the script editor instance
        if (window.scriptEditor && window.scriptEditor.editor) {
            // Set the code in the editor
            window.scriptEditor.editor.setValue(code, -1); // -1 moves cursor to start

            // Focus the script editor view
            const scriptView = document.getElementById('view-scripts');
            if (scriptView) {
                scriptView.click(); // This will trigger the focus
            }
        } else {
            console.error(
                '[AIAssistant]',
                'Script editor not available (window.scriptEditor is not defined)'
            );
        }
    }

    showDiffReview(newCode, markdownText = '') {
        // Get current code from script editor
        const oldCode =
            window.scriptEditor && window.scriptEditor.editor
                ? window.scriptEditor.editor.getValue()
                : '';

        // Store new code for later use
        this.pendingCode = newCode;

        // Generate unified diff using jsdiff
        const diff = Diff.createPatch(
            'script.py',
            oldCode,
            newCode,
            'Current',
            'Proposed'
        );

        // Get modal elements
        const modal = document.getElementById('diff-review-modal');
        const diffContainer = document.getElementById('diff-container');
        const explanationContainer =
            document.getElementById('diff-explanation');
        const closeBtn = document.getElementById('diff-modal-close-btn');
        const cancelBtn = document.getElementById('diff-cancel-btn');
        const acceptBtn = document.getElementById('diff-accept-btn');

        // Render diff with diff2html
        const configuration = {
            drawFileList: false,
            matching: 'lines',
            outputFormat: 'side-by-side',
            renderNothingWhenEmpty: false,
            synchronisedScroll: true
        };

        const diff2htmlUi = new Diff2HtmlUI(diffContainer, diff, configuration);
        diff2htmlUi.draw();
        diff2htmlUi.synchronisedScroll();

        // Display markdown explanation if present
        if (markdownText && markdownText.trim()) {
            explanationContainer.innerHTML = this.formatMarkdown(markdownText);
            explanationContainer.style.display = 'block';
        } else {
            explanationContainer.style.display = 'none';
        }

        // Show modal
        modal.classList.add('active');

        // Close handlers
        const closeModal = () => {
            modal.classList.remove('active');
            this.pendingCode = null;
        };

        const handleKeydown = (e) => {
            // Escape to close
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeModal();
                document.removeEventListener('keydown', handleKeydown);
                modal.removeEventListener('keydown', handleKeydown);
            }
            // Cmd+Enter to accept
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                this.openCodeInEditor(this.pendingCode);
                closeModal();
                document.removeEventListener('keydown', handleKeydown);
                modal.removeEventListener('keydown', handleKeydown);
            }
        };

        // Set up event listeners (remove old ones first to prevent duplicates)
        const newCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
        newCloseBtn.addEventListener('click', closeModal);

        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
        newCancelBtn.addEventListener('click', closeModal);

        const newAcceptBtn = acceptBtn.cloneNode(true);
        acceptBtn.parentNode.replaceChild(newAcceptBtn, acceptBtn);
        newAcceptBtn.addEventListener('click', () => {
            this.openCodeInEditor(this.pendingCode);
            closeModal();
        });

        document.addEventListener('keydown', handleKeydown);
        modal.addEventListener('keydown', handleKeydown);

        // Close on backdrop click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatMarkdown(text) {
        if (!text || !text.trim()) {
            return '';
        }

        // Use marked.js for professional markdown parsing
        if (typeof marked !== 'undefined') {
            try {
                return marked.parse(text);
            } catch (error) {
                console.error(
                    '[AIAssistant]',
                    'Markdown parsing error:',
                    error
                );
                // Fallback to escaped text if parsing fails
                return this.escapeHtml(text).replace(/\n/g, '<br>');
            }
        }

        // Fallback if marked.js is not loaded
        console.warn('[AIAssistant]', 'marked.js not loaded, using fallback');
        return this.escapeHtml(text).replace(/\n/g, '<br>');
    }

    addErrorFixMessage(errorTraceback, scriptCode) {
        // Check if we're already showing or about to show an error fix message
        if (this.isShowingErrorFix) {
            // Just update the traceback for the existing/pending message
            this.currentErrorTraceback = errorTraceback;
            return;
        }

        // Check if the last message is already an error fix message
        const allMessages =
            this.messagesContainer.querySelectorAll('.ai-message');
        const lastMessage =
            allMessages.length > 0 ? allMessages[allMessages.length - 1] : null;

        if (
            lastMessage &&
            lastMessage.classList.contains('ai-message-error-fix')
        ) {
            // Update the existing message with new traceback and make it blink again
            this.currentErrorTraceback = errorTraceback;

            // Delay to avoid overlap with error sound (same delay as first time)
            setTimeout(() => {
                // Remove and re-add the animation class to restart it
                lastMessage.classList.remove('ai-message-error-fix');
                void lastMessage.offsetWidth; // Force reflow
                lastMessage.classList.add('ai-message-error-fix');

                // Play attention sound
                if (window.playSound) {
                    window.playSound('attention');
                }

                // Scroll to bottom
                this.scrollToBottom();
            }, 2500); // Same delay as first time to avoid sound overlap

            return;
        }

        // Set flag to prevent duplicates
        this.isShowingErrorFix = true;

        // Store the current error traceback
        this.currentErrorTraceback = errorTraceback;

        // Delay showing the message by 1.5 seconds + estimated sound duration (attention.wav ~1 second)
        setTimeout(() => {
            // Show messages container
            if (
                this.messagesContainer.style.display === 'none' ||
                !this.messagesContainer.style.display
            ) {
                this.messagesContainer.style.display = 'block';
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = 'ai-message ai-message-error-fix';

            const fixBtnId =
                'fix-' + Date.now() + Math.random().toString(36).substr(2, 9);

            const header = this.createMessageHeader('error', {
                showContext: false
            });

            const body = `
                <div class="ai-error-fix-content">
                    <div class="ai-error-fix-text">
                        <p><strong>An error occurred while running your script.</strong></p>
                        <p>Would you like me to analyze the error and suggest a fix?</p>
                    </div>
                    <button class="ai-btn ai-fix-code-btn" id="${fixBtnId}"><span class="material-symbols-outlined">build</span>Fix Code</button>
                </div>`;

            messageDiv.innerHTML = header + body;
            this.messagesContainer.appendChild(messageDiv);
            this.messagesContainer.scrollTop =
                this.messagesContainer.scrollHeight;

            // Clear the flag now that the message is actually shown
            this.isShowingErrorFix = false;

            // Play attention sound
            if (window.playSound) {
                window.playSound('attention');
            }

            // Scroll to bottom
            this.scrollToBottom();

            // Add event listener to fix button
            const fixBtn = document.getElementById(fixBtnId);
            if (fixBtn) {
                fixBtn.addEventListener('click', (event) => {
                    event.stopPropagation(); // Prevent view focus initially

                    // Use the latest stored traceback
                    const latestTraceback = this.currentErrorTraceback;

                    // Remove the error message from UI and clear the flag
                    messageDiv.remove();
                    this.isShowingErrorFix = false;

                    // Switch to assistant view
                    if (window.focusView) {
                        window.focusView('view-assistant');
                    }

                    // Construct the prompt with error information
                    const prompt = `The script produced an error. Please analyze and fix it, but don't refactor any other parts of the code.\n\nError traceback:\n\`\`\`\n${latestTraceback}\n\`\`\``;

                    // Add a custom user message with traceback displayed as code block
                    this.addErrorTracebackMessage(latestTraceback);

                    // Play message sent sound
                    if (window.playSound) {
                        window.playSound('message_sent');
                    }

                    // Clear input and disable controls
                    this.promptInput.value = '';
                    this.autoResizeTextarea();
                    this.promptInput.disabled = true;
                    this.sendButton.disabled = true;

                    // Show typing indicator
                    this.showTypingIndicator();

                    // Execute directly without adding another user message
                    setTimeout(async () => {
                        try {
                            await this.executeWithRetry(prompt, 0);
                        } catch (error) {
                            this.addMessage(
                                'error',
                                `Failed after ${this.maxRetries} attempts: ${error.message}`
                            );
                        } finally {
                            // Hide typing indicator
                            this.hideTypingIndicator();

                            this.promptInput.disabled = false;
                            this.sendButton.disabled = false;
                            this.autoResizeTextarea();
                            this.promptInput.focus();
                        }
                    }, 100);
                });
            }
        }, 2500); // 1500ms delay + ~1000ms for attention sound
    }

    addErrorTracebackMessage(errorTraceback) {
        // Show messages container
        if (
            this.messagesContainer.style.display === 'none' ||
            !this.messagesContainer.style.display
        ) {
            this.messagesContainer.style.display = 'block';
        }

        const messageDiv = document.createElement('div');
        messageDiv.className =
            'ai-message ai-message-user ai-message-error-traceback';

        const header = this.createMessageHeader('user');

        // Format as markdown for consistent styling with assistant messages
        const markdownContent = `The script produced an error. Please analyze and fix it, but don't refactor any other parts of the code.

**Error traceback:**

\`\`\`
${errorTraceback}
\`\`\``;

        const body = `<div class="ai-markdown-explanation">${this.formatMarkdown(markdownContent)}</div>`;

        messageDiv.innerHTML = header + body;

        // Mark this as an error traceback message (don't add reuse button to these)
        messageDiv.setAttribute('data-error-traceback', 'true');

        this.messagesContainer.appendChild(messageDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

        // Scroll the view-content to bottom
        this.scrollToBottom();

        return messageDiv;
    }

    showTypingIndicator() {
        // Remove any existing typing indicator first
        this.hideTypingIndicator();

        const typingDiv = document.createElement('div');
        typingDiv.className = 'ai-typing-indicator';
        typingDiv.id = 'ai-typing-indicator';
        typingDiv.innerHTML = `
            <span>Assistant is thinking</span>
            <div class="ai-typing-dots">
                <div class="ai-typing-dot"></div>
                <div class="ai-typing-dot"></div>
                <div class="ai-typing-dot"></div>
            </div>
        `;

        this.messagesContainer.appendChild(typingDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        this.scrollToBottom();
    }

    hideTypingIndicator() {
        const typingIndicator = document.getElementById('ai-typing-indicator');
        if (typingIndicator) {
            typingIndicator.remove();
        }
    }

    clearConversation() {
        if (
            confirm(
                'Clear conversation history? This will start a fresh conversation.'
            )
        ) {
            this.conversationHistory = [];
            this.messagesContainer.innerHTML = '';
            this.messagesContainer.style.display = 'none'; // Hide when cleared
            console.log('[AIAssistant]', 'Conversation history cleared');
        }
    }

    async sendPrompt() {
        const prompt = this.promptInput.value.trim();

        if (!prompt) {
            alert('Please enter a prompt');
            return;
        }

        // Check authentication
        if (!this.isAuthenticated) {
            if (
                confirm(
                    'You need to sign in to use the AI assistant. Sign in now?'
                )
            ) {
                window.authManager.login();
            }
            return;
        }

        // Check subscription
        if (!this.subscription || !this.subscription.isAdvanced) {
            if (
                confirm(
                    'You need an Advanced subscription to use the AI assistant. Subscribe now?'
                )
            ) {
                window.open(`${this.websiteURL}/pricing`, '_blank');
            }
            return;
        }

        if (!window.pyodide) {
            alert('Python environment not ready yet');
            return;
        }

        // Hide context selector after first message and show locked context
        const contextSelector = document.getElementById('ai-context-selector');
        const contextDisplay = document.getElementById('ai-context-display');
        if (contextSelector && !contextSelector.classList.contains('hidden')) {
            contextSelector.classList.add('hidden');
            if (contextDisplay) {
                contextDisplay.classList.remove('hidden');
                const contextLabel =
                    this.context === 'font' ? 'Font Context' : 'Script Context';
                const contextIcon =
                    this.context === 'font' ? 'font_download' : 'code';
                const contextClass =
                    this.context === 'font'
                        ? 'ai-context-tag-font'
                        : 'ai-context-tag-script';
                contextDisplay.innerHTML = `<span class="ai-context-display-icon ${contextClass}"><span class="material-symbols-outlined">${contextIcon}</span></span><span class="ai-context-display-text">${contextLabel}</span><span class="ai-context-display-hint">Start a new chat to change context</span>`;
            }
            // Lock context in session manager
            if (this.sessionManager) {
                this.sessionManager.isContextLocked = true;
            }
        }

        // Clear input
        this.promptInput.value = '';
        this.promptInput.disabled = true;
        this.sendButton.disabled = true;

        // Add user message
        this.addMessage('user', prompt);

        // Play message sent sound
        if (window.playSound) {
            window.playSound('message_sent');
        }

        // Show typing indicator
        this.showTypingIndicator();

        try {
            await this.executeWithRetry(prompt, 0);
        } catch (error) {
            this.addMessage(
                'error',
                `Failed after ${this.maxRetries} attempts: ${error.message}`
            );
        } finally {
            // Hide typing indicator
            this.hideTypingIndicator();

            this.promptInput.disabled = false;
            this.sendButton.disabled = false;
            this.autoResizeTextarea();
            this.promptInput.focus();
        }
    }

    async executeWithRetry(
        originalPrompt,
        attemptNumber,
        previousError = null
    ) {
        if (attemptNumber >= this.maxRetries) {
            throw new Error(
                `Maximum retry attempts (${this.maxRetries}) reached`
            );
        }

        try {
            // Get Python code and markdown from Claude
            const { pythonCode, markdownText } = await this.callClaude(
                originalPrompt,
                previousError,
                attemptNumber
            );

            // In script context, never auto-run - only show code with "Open in Script Editor" button
            if (this.context === 'script') {
                // Script mode: Just show the code, no execution
                this.addOutputWithCode('', pythonCode, markdownText, false);

                // Play incoming message sound
                if (window.playSound) {
                    window.playSound('incoming_message');
                }
            } else if (this.autoRun) {
                // Font mode with auto-run: Execute the Python code and capture output
                const output = await this.executePython(pythonCode);

                // Show output with collapsible code and run button
                this.addOutputWithCode(output, pythonCode, markdownText, true);

                // Play incoming message sound
                if (window.playSound) {
                    window.playSound('incoming_message');
                }
            } else {
                // Font mode, manual: Just show the code with a run button
                this.addOutputWithCode('', pythonCode, markdownText, true);

                // Play incoming message sound
                if (window.playSound) {
                    window.playSound('incoming_message');
                }
            }

            // Add reuse buttons to previous user messages now that we have a response
            this.addReuseButtonsToOldMessages();
        } catch (error) {
            console.error(
                '[AIAssistant]',
                `Attempt ${attemptNumber + 1} failed:`,
                error
            );

            // Add error message
            this.addMessage('error', `Execution error: ${error.message}`);

            // Only retry in font mode with auto-run (never retry in script context since we don't execute)
            if (
                this.context !== 'script' &&
                this.autoRun &&
                attemptNumber < this.maxRetries - 1
            ) {
                this.addMessage(
                    'system',
                    `Retrying (attempt ${attemptNumber + 2}/${this.maxRetries})...`
                );
                await this.executeWithRetry(
                    originalPrompt,
                    attemptNumber + 1,
                    error.message
                );
            } else {
                throw error;
            }
        }
    }

    async callClaude(userPrompt, previousError = null, attemptNumber = 0) {
        // Get current script content if in script mode
        let currentScript = null;
        if (
            this.context === 'script' &&
            window.scriptEditor &&
            window.scriptEditor.editor
        ) {
            currentScript = window.scriptEditor.editor.getValue();
        }

        // Build prompt with error context if retrying
        let fullPrompt = userPrompt;
        if (currentScript && currentScript.trim()) {
            fullPrompt = `Current script in editor:\n\`\`\`python\n${currentScript}\n\`\`\`\n\nUser request: ${userPrompt}`;
        }

        if (previousError && attemptNumber > 0) {
            fullPrompt = `${fullPrompt}\n\nPrevious attempt ${attemptNumber} failed with error:\n${previousError}\n\nPlease fix the code and try again.`;
        }

        // Get session token for authentication
        const sessionToken = window.authManager
            ? window.authManager.getSessionToken()
            : null;
        console.log(
            '[AIAssistant] Session token for API call:',
            sessionToken ? sessionToken.substring(0, 20) + '...' : 'NONE'
        );

        const headers = {
            'Content-Type': 'application/json'
        };

        if (sessionToken) {
            headers['Authorization'] = `Bearer ${sessionToken}`;
        }

        // Get selected model
        const selectedModel =
            this.selectedModelId || 'claude-sonnet-4-5-20250929';

        // Call the website's AI API endpoint
        const chatId = this.sessionManager
            ? this.sessionManager.currentChatId
            : null;
        const response = await fetch(`${this.websiteURL}/api/ai/assistant`, {
            method: 'POST',
            credentials: 'include', // Include cookies for authentication
            headers: headers,
            body: JSON.stringify({
                prompt: fullPrompt,
                chatId: chatId,
                context: currentScript,
                contextType: this.context,
                model: selectedModel
            })
        });

        // Log the request for debugging
        console.group('[AIAssistant] AI Prompt Sent to API');
        console.log('[AIAssistant]', 'Prompt:', fullPrompt);
        console.log('[AIAssistant]', 'Context Type:', this.context);
        console.log(
            '[AIAssistant]',
            'History length:',
            this.conversationHistory.length
        );
        console.groupEnd();

        if (!response.ok) {
            const errorData = await response.json();

            // Handle specific error cases
            if (response.status === 401) {
                // Not authenticated
                if (
                    confirm(
                        'You need to sign in to use the AI assistant. Sign in now?'
                    )
                ) {
                    window.authManager.login();
                }
                throw new Error('Authentication required');
            } else if (response.status === 403) {
                // Not subscribed
                throw new Error(
                    errorData.error || 'Active subscription required'
                );
            } else if (response.status === 402) {
                // Insufficient credits
                throw new Error(errorData.message || 'Insufficient credits');
            } else if (response.status === 429) {
                // Rate limited
                throw new Error(`Rate limit exceeded. Please try again later.`);
            }

            throw new Error(
                `API error: ${errorData.error || errorData.message || response.statusText}`
            );
        }

        const data = await response.json();

        // Update chat session ID if this was a new chat
        if (data.chatId && this.sessionManager) {
            this.sessionManager.currentChatId = data.chatId;
            this.sessionManager.isContextLocked = true;
        }

        // Update chat history menu if available
        if (data.chatHistory && this.sessionManager) {
            this.sessionManager.updateChatHistory(data.chatHistory);
        }

        // Log usage information
        if (data.usage) {
            console.log('[AIAssistant]', 'Usage:', {
                cost: `${data.usage.cost_eur_cents} EUR cents`,
                tokens: `${data.usage.prompt_tokens + data.usage.completion_tokens} total`,
                overage: data.usage.used_overage,
                balance: `${data.usage.balance_after} EUR cents remaining`
            });
        }

        // Extract Python code and markdown from response
        const fullResponse = data.response;
        let pythonCode = '';
        let markdownText = fullResponse;

        // Extract code from ```python code blocks
        const codeBlockRegex = /```python\s*\n([\s\S]*?)```/g;
        const matches = fullResponse.matchAll(codeBlockRegex);

        for (const match of matches) {
            pythonCode += match[1];
        }

        // If no python blocks found, try generic code blocks
        if (!pythonCode.trim()) {
            const genericCodeBlockRegex = /```\s*\n([\s\S]*?)```/g;
            const genericMatches = fullResponse.matchAll(genericCodeBlockRegex);

            for (const match of genericMatches) {
                pythonCode += match[1];
            }
        }

        pythonCode = pythonCode.trim();

        // Remove code blocks from markdown text, leaving only the explanations
        markdownText = markdownText
            .replace(/```python\s*\n[\s\S]*?```/g, '')
            .replace(/```\s*\n[\s\S]*?```/g, '')
            .trim();

        // Add to conversation history (only if not a retry)
        if (!previousError || attemptNumber === 0) {
            this.conversationHistory.push({
                role: 'user',
                content: fullPrompt
            });
            this.conversationHistory.push({
                role: 'assistant',
                content: fullResponse
            });

            // Keep conversation history manageable (last 10 exchanges = 20 messages)
            if (this.conversationHistory.length > 20) {
                this.conversationHistory = this.conversationHistory.slice(-20);
            }
        }

        return { pythonCode, markdownText };
    }

    async executePython(code) {
        if (!window.pyodide) {
            throw new Error('Pyodide not available');
        }

        try {
            // Capture stdout
            let capturedOutput = '';

            // Set up output capturing
            await window.pyodide.runPythonAsync(`
import sys
from io import StringIO

# Create a string buffer to capture output
_ai_output_buffer = StringIO()
_original_stdout = sys.stdout
sys.stdout = _ai_output_buffer
            `);

            // Execute the Python code
            await window.pyodide.runPythonAsync(code);

            // Get captured output
            capturedOutput = await window.pyodide.runPythonAsync(`
# Get the captured output
output = _ai_output_buffer.getvalue()

# Restore original stdout
sys.stdout = _original_stdout

# Clean up
del _ai_output_buffer
del _original_stdout

output
            `);

            return capturedOutput;
        } catch (error) {
            // Restore stdout on error
            try {
                await window.pyodide.runPythonAsync(`
if '_original_stdout' in dir():
    sys.stdout = _original_stdout
                `);
            } catch (e) {
                // Ignore cleanup errors
            }

            // Re-throw with cleaned up error message
            throw new Error(error.message || String(error));
        }
    }

    /**
     * Update send button shortcut visibility based on view focus
     */
    updateSendButtonShortcut() {
        const shortcut = document.getElementById('ai-send-btn-shortcut');
        if (shortcut) {
            shortcut.style.display = this.isAssistantViewFocused
                ? 'inline-flex'
                : 'none';
        }
    }

    /**
     * Add wider cursor styling to the prompt textarea
     */
    addWideCursorStyle() {
        const styleId = 'ai-prompt-cursor-override';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                #ai-prompt {
                    caret-color: transparent;
                }
                .custom-textarea-cursor {
                    position: absolute;
                    width: 7px;
                    background-color: var(--custom-cursor-color);
                    pointer-events: none;
                    z-index: 1;
                    animation: cursor-blink 1s step-end infinite;
                }
                @keyframes cursor-blink {
                    0%, 50% { opacity: 1; }
                    51%, 100% { opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }

        // Create custom cursor element
        const cursor = document.createElement('div');
        cursor.className = 'custom-textarea-cursor';
        cursor.id = 'ai-prompt-custom-cursor';

        const wrapper = document.getElementById('ai-prompt-wrapper');
        if (wrapper) {
            wrapper.style.position = 'relative';
            wrapper.appendChild(cursor);
        }

        // Track last cursor position to detect changes
        let lastPosition = { left: 0, top: 0 };

        // Update cursor position
        const updateCursor = () => {
            if (
                !this.promptInput ||
                this.promptInput.disabled ||
                document.activeElement !== this.promptInput
            ) {
                cursor.style.display = 'none';
                return;
            }
            cursor.style.display = 'block';

            const textarea = this.promptInput;
            const textBeforeCursor = textarea.value.substring(
                0,
                textarea.selectionStart
            );
            const lines = textBeforeCursor.split('\n');
            const currentLine = lines.length - 1;
            const currentLineText = lines[currentLine];

            // Get styles
            const style = window.getComputedStyle(textarea);
            const lineHeight = parseFloat(style.lineHeight);
            const fontSize = parseFloat(style.fontSize);

            // Calculate character width (monospace font)
            const charWidth = fontSize * 0.6; // Approximate for IBM Plex Mono

            // Get textarea padding and margin
            const paddingLeft = parseFloat(style.paddingLeft) || 0;
            const marginLeft = parseFloat(style.marginLeft) || 0;

            // Calculate position
            const left =
                paddingLeft + marginLeft + currentLineText.length * charWidth;
            const top = currentLine * lineHeight;

            // Check if cursor position changed
            if (left !== lastPosition.left || top !== lastPosition.top) {
                // Reset animation by removing and re-adding the animation
                cursor.style.animation = 'none';
                // Force reflow
                void cursor.offsetHeight;
                cursor.style.animation = 'cursor-blink 1s step-end infinite';

                // Update last position
                lastPosition = { left, top };
            }

            cursor.style.left = left + 'px';
            cursor.style.top = top + 'px';
            cursor.style.height = lineHeight + 'px';
        };

        // Store last selection position for continuous monitoring
        let lastSelectionStart = -1;

        // Continuously monitor cursor position for instant updates
        const monitorCursor = () => {
            if (
                this.promptInput &&
                !this.promptInput.disabled &&
                document.activeElement === this.promptInput
            ) {
                const currentPos = this.promptInput.selectionStart;
                if (currentPos !== lastSelectionStart) {
                    updateCursor();
                    lastSelectionStart = currentPos;
                }
            }
            requestAnimationFrame(monitorCursor);
        };

        // Start monitoring
        requestAnimationFrame(monitorCursor);

        // Update on various events as backup
        this.promptInput.addEventListener('input', updateCursor);
        this.promptInput.addEventListener('click', updateCursor);
        this.promptInput.addEventListener('keyup', updateCursor);
        this.promptInput.addEventListener('keydown', (e) => {
            // For arrow keys and navigation, schedule update after event processes
            const navKeys = [
                'ArrowLeft',
                'ArrowRight',
                'ArrowUp',
                'ArrowDown',
                'Home',
                'End',
                'PageUp',
                'PageDown'
            ];
            if (navKeys.includes(e.key)) {
                requestAnimationFrame(updateCursor);
            }
        });
        this.promptInput.addEventListener('focus', () => {
            cursor.style.display = 'block';
            lastSelectionStart = this.promptInput.selectionStart;
            updateCursor();
        });
        this.promptInput.addEventListener('blur', () => {
            cursor.style.display = 'none';
            lastSelectionStart = -1;
        });

        // Initial update
        setTimeout(updateCursor, 100);

        // Store update function for external calls
        this._updateCursor = updateCursor;
    }

    /**
     * Auto-resize textarea based on content (3 to 10 lines)
     */
    autoResizeTextarea() {
        const textarea = this.promptInput;
        const viewContent = document.querySelector(
            '#view-assistant .view-content'
        );

        // Reset height to auto to get the correct scrollHeight
        textarea.style.height = 'auto';

        // Calculate line height in pixels
        const style = window.getComputedStyle(textarea);
        const lineHeight = parseFloat(style.lineHeight);

        // Calculate min height for 3 lines and max height for 10 lines
        const minHeight = lineHeight * 3;
        const maxHeight = lineHeight * 10;

        // Set new height based on content, with min of 3 lines and max of 10 lines
        const newHeight = Math.max(
            minHeight,
            Math.min(textarea.scrollHeight, maxHeight)
        );
        textarea.style.height = newHeight + 'px';

        // Update custom cursor position after resize
        if (this._updateCursor) {
            setTimeout(() => this._updateCursor(), 0);
        }

        // Scroll the view to the bottom
        if (viewContent) {
            setTimeout(() => {
                viewContent.scrollTop = viewContent.scrollHeight;
            }, 0);
        }
    }

    populateTestMessages() {
        console.log(
            '[AIAssistant]',
            'Populating test messages for style testing'
        );

        // 1. User message
        this.addMessage(
            'user',
            'Can you help me change the weight of glyph "A" to 700?'
        );

        // 2. Assistant response with code
        const sampleCode = `# Change weight of glyph A
font = currentFontModel
glyph_a = font.glyphs['A']
for layer in glyph_a.layers:
    # Adjust all points
    for path in layer.paths:
        for node in path.nodes:
            node.x *= 1.2
            node.y *= 1.2`;

        const markdownExplanation = `I'll help you increase the weight of glyph "A". Here's what the code does:

1. **Gets the font and glyph**: Accesses the current font model and finds glyph "A"
2. **Iterates through layers**: Processes all layers in the glyph
3. **Scales the paths**: Increases the scale by 20% to make it bolder

You can adjust the scale factor (currently 1.2) to make it more or less bold.`;

        this.addOutputWithCode('', sampleCode, markdownExplanation, true);

        // Add reuse buttons to user messages
        this.addReuseButtonsToOldMessages();

        // 3. Error message
        this.addMessage(
            'error',
            'Execution error: NameError: name "currentFontModel" is not defined. Make sure a font is loaded.'
        );

        // 4. System/retry message
        this.addMessage('system', 'Retrying (attempt 2/3)...');

        // 5. Error fix message (simulate script editor error)
        setTimeout(() => {
            const sampleTraceback = `Traceback (most recent call last):
  File "<exec>", line 3, in <module>
    glyph_a = font.glyphs['A']
KeyError: 'A'`;

            this.addErrorFixMessage(sampleTraceback, sampleCode);
        }, 100);

        console.log('[AIAssistant]', 'Test messages populated');
    }
}

// Initialize AI assistant when page loads
document.addEventListener('DOMContentLoaded', () => {
    // Populate context icons in radio buttons immediately
    const fontRadio = document.querySelector(
        '#ai-context-radio-font + .ai-context-radio-custom'
    );
    const scriptRadio = document.querySelector(
        '#ai-context-radio-script + .ai-context-radio-custom'
    );

    if (fontRadio && scriptRadio) {
        // Insert icons at the beginning of each custom radio span
        fontRadio.insertAdjacentHTML(
            'afterbegin',
            ChatSessionManager.getContextIconHTML('font')
        );
        scriptRadio.insertAdjacentHTML(
            'afterbegin',
            ChatSessionManager.getContextIconHTML('script')
        );
    }

    // Wait for Pyodide to be ready
    const initAI = () => {
        if (window.pyodide) {
            window.aiAssistant = new AIAssistant();
            console.log('[AIAssistant]', 'AI Assistant initialized');

            // Check for assistant_style_test URL parameter
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.has('assistant_style_test')) {
                console.log(
                    '[AIAssistant]',
                    'Style test mode enabled - populating test messages'
                );
                setTimeout(() => {
                    window.aiAssistant.populateTestMessages();
                }, 500);
            }
        } else {
            setTimeout(initAI, 500);
        }
    };

    setTimeout(initAI, 2000);
});
