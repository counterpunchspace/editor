/**
 * MCP Log Transport - Forwards console logs to the MCP server via WebSocket
 * This module intercepts console methods and sends them to the MCP server for monitoring
 */

interface LogMessage {
    type: 'log';
    data: {
        timestamp: number;
        level: string;
        prefix: string;
        args: any[];
        stackTrace?: string;
    };
}

interface RuntimeDataMessage {
    type: 'runtime-data';
    data: Record<string, any>;
}

type MCPMessage = LogMessage | RuntimeDataMessage;

class MCPLogTransport {
    private ws: WebSocket | null = null;
    private wsUrl: string;
    private reconnectInterval = 5000;
    private reconnectTimer: number | null = null;
    private messageQueue: MCPMessage[] = [];
    private maxQueueSize = 100;
    private originalConsole: {
        log: typeof console.log;
        warn: typeof console.warn;
        error: typeof console.error;
        info: typeof console.info;
        debug: typeof console.debug;
    };

    constructor(wsUrl = 'ws://localhost:9876') {
        this.wsUrl = wsUrl;

        // Store original console methods
        this.originalConsole = {
            log: console.log.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console),
            info: console.info.bind(console),
            debug: console.debug.bind(console)
        };
    }

    connect() {
        if (this.ws?.readyState === WebSocket.OPEN) {
            return;
        }

        try {
            this.ws = new WebSocket(this.wsUrl);

            this.ws.onopen = () => {
                this.originalConsole.log(
                    '[MCPTransport] Connected to MCP server'
                );
                this.flushQueue();
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
            };

            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleIncomingMessage(message);
                } catch (error) {
                    this.originalConsole.error(
                        '[MCPTransport] Failed to parse incoming message:',
                        error
                    );
                }
            };

            this.ws.onclose = () => {
                this.originalConsole.log(
                    '[MCPTransport] Disconnected from MCP server'
                );
                this.scheduleReconnect();
            };

            this.ws.onerror = (error) => {
                this.originalConsole.error(
                    '[MCPTransport] WebSocket error:',
                    error
                );
            };
        } catch (error) {
            this.originalConsole.error(
                '[MCPTransport] Failed to connect:',
                error
            );
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect() {
        if (this.reconnectTimer) return;

        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectInterval);
    }

    private handleIncomingMessage(message: any) {
        const { type, data } = message;

        switch (type) {
            case 'reload':
                console.log('[MCPTransport] Received reload command');
                window.location.reload();
                break;

            case 'execute':
                console.log('[MCPTransport] Executing:', data?.code);
                if (data?.code) {
                    try {
                        // Execute in global scope
                        const result = (0, eval)(data.code);
                        console.log('[MCPTransport] Result:', result);
                    } catch (error) {
                        // Serialize error properly
                        const errorInfo =
                            error instanceof Error
                                ? {
                                      name: error.name,
                                      message: error.message,
                                      stack: error.stack
                                  }
                                : error;
                        console.error('[MCPTransport] Error:', errorInfo);
                    }
                }
                break;

            default:
                console.warn('[MCPTransport] Unknown message type:', type);
        }
    }

    private send(message: MCPMessage) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(message));
            } catch (error) {
                this.originalConsole.error(
                    '[MCPTransport] Failed to send message:',
                    error
                );
                this.queueMessage(message);
            }
        } else {
            this.queueMessage(message);
        }
    }

    private queueMessage(message: MCPMessage) {
        this.messageQueue.push(message);
        if (this.messageQueue.length > this.maxQueueSize) {
            this.messageQueue.shift();
        }
    }

    private flushQueue() {
        while (
            this.messageQueue.length > 0 &&
            this.ws?.readyState === WebSocket.OPEN
        ) {
            const message = this.messageQueue.shift()!;
            try {
                this.ws.send(JSON.stringify(message));
            } catch (error) {
                this.originalConsole.error(
                    '[MCPTransport] Failed to flush message:',
                    error
                );
                this.messageQueue.unshift(message);
                break;
            }
        }
    }

    private extractPrefix(args: any[]): {
        prefix: string;
        remainingArgs: any[];
    } {
        if (
            args.length > 0 &&
            typeof args[0] === 'string' &&
            args[0].startsWith('[') &&
            args[0].includes(']')
        ) {
            const match = args[0].match(/^\[([^\]]+)\]/);
            if (match) {
                return {
                    prefix: match[1],
                    remainingArgs: args.slice(1)
                };
            }
        }
        return { prefix: '', remainingArgs: args };
    }

    private createLogMessage(level: string, args: any[]): LogMessage {
        const { prefix, remainingArgs } = this.extractPrefix(args);

        // Capture stack trace for errors
        let stackTrace: string | undefined;
        if (level === 'error') {
            const error = new Error();
            stackTrace = error.stack;
        }

        return {
            type: 'log',
            data: {
                timestamp: Date.now(),
                level,
                prefix,
                args: remainingArgs,
                stackTrace
            }
        };
    }

    interceptConsole() {
        const interceptMethod = (level: keyof typeof this.originalConsole) => {
            console[level] = (...args: any[]) => {
                // Call original console method
                this.originalConsole[level](...args);

                // Send to MCP server
                const message = this.createLogMessage(level, args);
                this.send(message);
            };
        };

        interceptMethod('log');
        interceptMethod('warn');
        interceptMethod('error');
        interceptMethod('info');
        interceptMethod('debug');
    }

    sendRuntimeData(data: Record<string, any>) {
        this.send({
            type: 'runtime-data',
            data
        });
    }

    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// Create singleton instance
const mcpTransport = new MCPLogTransport();

// Auto-connect and intercept console in development mode only
// Use the global isDevelopment function from index.html
// Disable during automated tests to avoid interference
if (window.isDevelopment?.() && !window.isTest?.()) {
    mcpTransport.connect();
    mcpTransport.interceptConsole();
}

// Expose to window for manual control and runtime data updates
declare global {
    interface Window {
        mcpTransport: MCPLogTransport;
    }
}

window.mcpTransport = mcpTransport;

export default mcpTransport;
