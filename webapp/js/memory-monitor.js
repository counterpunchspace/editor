// Memory Monitor for Browser
// Monitors memory usage and provides cleanup utilities

(function () {
    'use strict';

    class MemoryMonitor {
        constructor() {
            this.monitorElement = null;
            this.settingsBarElement = null;
            this.settingsPercentageElement = null;
            this.settingsDetailsElement = null;
            this.settingsIndicator = null;
            this.updateInterval = null;
            this.warningThreshold = 0.7; // 70% - show warning indicator
            this.criticalThreshold = 0.9; // 90% of limit
            this.isVisible = false;
        }

        init() {
            this.createMonitorElement();
            this.startMonitoring();
            this.setupCleanupHandlers();
            console.log('✅ Memory monitor initialized');
        }

        createMonitorElement() {
            // Create floating memory monitor (for Cmd+M)
            this.monitorElement = document.createElement('div');
            this.monitorElement.id = 'memory-monitor';
            this.monitorElement.style.cssText = `
                position: fixed;
                top: 50px;
                right: 10px;
                background: rgba(0, 0, 0, 0.9);
                color: #0f0;
                padding: 12px;
                font-family: 'IBM Plex Mono', monospace;
                font-size: 11px;
                z-index: 9999;
                border-radius: 6px;
                border: 1px solid #0f0;
                min-width: 200px;
                display: none;
                box-shadow: 0 4px 12px rgba(0, 255, 0, 0.3);
            `;

            document.body.appendChild(this.monitorElement);

            // Get settings panel elements
            this.settingsBarElement = document.getElementById(
                'settings-memory-bar'
            );
            this.settingsPercentageElement = document.getElementById(
                'settings-memory-percentage'
            );
            this.settingsDetailsElement = document.getElementById(
                'settings-memory-details'
            );
            this.settingsIndicator = document.getElementById(
                'settings-memory-indicator'
            );

            // Setup memory info popup
            this.setupInfoPopup();

            // Keyboard shortcut: Cmd+M for detailed view
            document.addEventListener('keydown', (e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
                    e.preventDefault();
                    this.toggleVisibility();
                }
            });
        }

        toggleVisibility() {
            this.isVisible = !this.isVisible;
            this.monitorElement.style.display = this.isVisible
                ? 'block'
                : 'none';

            if (this.isVisible) {
                this.updateMemoryDisplay();
            }
        }

        setupInfoPopup() {
            const infoBtn = document.getElementById('memory-info-btn');
            const popup = document.getElementById('memory-info-popup');
            const closeBtn = document.getElementById('memory-info-close');

            if (!infoBtn || !popup || !closeBtn) {
                console.warn('Memory info popup elements not found');
                return;
            }

            // Open popup
            infoBtn.addEventListener('click', (e) => {
                e.preventDefault();
                popup.style.display = 'flex';
            });

            // Close popup - close button
            closeBtn.addEventListener('click', () => {
                popup.style.display = 'none';
            });

            // Close popup - click outside
            popup.addEventListener('click', (e) => {
                if (e.target === popup) {
                    popup.style.display = 'none';
                }
            });

            // Close popup - Escape key
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && popup.style.display === 'flex') {
                    e.preventDefault();
                    e.stopPropagation();
                    popup.style.display = 'none';
                }
            });
        }

        updateSettingsDisplay() {
            const info = this.getMemoryInfo();

            if (!info.supported) {
                if (this.settingsPercentageElement) {
                    this.settingsPercentageElement.textContent = 'N/A';
                }
                if (this.settingsBarElement) {
                    this.settingsBarElement.style.width = '0%';
                }
                if (this.settingsDetailsElement) {
                    this.settingsDetailsElement.textContent =
                        'Memory monitoring not supported in this browser';
                }
                return;
            }

            const percent = Math.min(100, parseFloat(info.percentUsedRaw));

            // Update percentage display
            if (this.settingsPercentageElement) {
                this.settingsPercentageElement.textContent = `${percent.toFixed(0)}%`;
            }

            // Update memory details
            if (this.settingsDetailsElement) {
                this.settingsDetailsElement.textContent = `${info.usedMB} MB used of ${info.limitMB} MB`;
            }

            // Update bar
            if (this.settingsBarElement) {
                this.settingsBarElement.style.width = `${percent}%`;

                // Update bar color
                this.settingsBarElement.classList.remove('warning', 'critical');
                if (percent >= this.criticalThreshold * 100) {
                    this.settingsBarElement.classList.add('critical');
                } else if (percent >= this.warningThreshold * 100) {
                    this.settingsBarElement.classList.add('warning');
                }
            }

            // Update notification indicator on settings button
            if (this.settingsIndicator) {
                this.settingsIndicator.classList.remove('warning', 'critical');
                if (percent >= this.criticalThreshold * 100) {
                    this.settingsIndicator.classList.add('critical');
                } else if (percent >= this.warningThreshold * 100) {
                    this.settingsIndicator.classList.add('warning');
                }
            }
        }

        startMonitoring() {
            // Update continuously
            this.updateInterval = setInterval(() => {
                this.updateMemoryDisplay();
                this.updateSettingsDisplay();
            }, 1000);

            // Initial update
            this.updateMemoryDisplay();
            this.updateSettingsDisplay();
        }

        updateMemoryDisplay() {
            if (!this.monitorElement) return;

            const info = this.getMemoryInfo();
            const html = this.formatMemoryInfo(info);
            this.monitorElement.innerHTML = html;

            // Update color based on usage
            if (info.percentUsed >= this.criticalThreshold * 100) {
                this.monitorElement.style.color = '#f00';
                this.monitorElement.style.borderColor = '#f00';
            } else if (info.percentUsed >= this.warningThreshold * 100) {
                this.monitorElement.style.color = '#ff0';
                this.monitorElement.style.borderColor = '#ff0';
            } else {
                this.monitorElement.style.color = '#0f0';
                this.monitorElement.style.borderColor = '#0f0';
            }
        }

        getMemoryInfo() {
            const info = {
                supported: false,
                usedMB: 0,
                totalMB: 0,
                limitMB: 0,
                percentUsed: 0,
                percentUsedRaw: 0, // Uncapped percentage for calculations
                overLimit: false,
                pyodideObjects: 0,
                openFonts: 0
            };

            // Chrome/Edge specific
            if (performance.memory) {
                info.supported = true;
                info.usedMB = (
                    performance.memory.usedJSHeapSize / 1048576
                ).toFixed(2);
                info.totalMB = (
                    performance.memory.totalJSHeapSize / 1048576
                ).toFixed(2);
                info.limitMB = (
                    performance.memory.jsHeapSizeLimit / 1048576
                ).toFixed(2);

                // Calculate raw percentage
                const rawPercent =
                    (performance.memory.usedJSHeapSize /
                        performance.memory.jsHeapSizeLimit) *
                    100;
                info.percentUsedRaw = rawPercent;

                // Check if over limit
                info.overLimit = rawPercent > 100;

                // Cap display percentage at 100% for UI purposes
                info.percentUsed = Math.min(100, rawPercent).toFixed(1);
            }

            // Get Python object count if Pyodide is loaded
            if (window.pyodide) {
                try {
                    // Use _originalRunPython to avoid triggering afterPythonExecution hooks
                    const runPython =
                        window.pyodide._originalRunPython ||
                        window.pyodide.runPython;
                    const result = runPython.call(
                        window.pyodide,
                        `
import gc
import json
# Don't collect here - only when Force GC button is pressed
obj_count = len(gc.get_objects())

# Get open fonts count
open_fonts = 0
try:
    open_fonts = len(GetOpenFonts())
except:
    pass

json.dumps({"objects": obj_count, "fonts": open_fonts})
                    `
                    );
                    const data = JSON.parse(result);
                    info.pyodideObjects = data.objects.toLocaleString();
                    info.openFonts = data.fonts;
                } catch (e) {
                    // Ignore errors during memory check
                }
            }

            return info;
        }

        formatMemoryInfo(info) {
            if (!info.supported) {
                return `
                    <div style="font-weight: bold; margin-bottom: 8px;">Memory Monitor</div>
                    <div style="opacity: 0.7;">⚠️ Not supported in this browser</div>
                    <div style="margin-top: 8px; opacity: 0.7; font-size: 10px;">
                        Available in Chrome/Edge only
                    </div>
                `;
            }

            // Determine status based on raw percentage (uncapped)
            const statusIcon = info.overLimit
                ? '💀'
                : info.percentUsedRaw >= 90
                  ? '🔴'
                  : info.percentUsedRaw >= 80
                    ? '🟡'
                    : '🟢';

            // Format usage display
            const usageDisplay = info.overLimit
                ? `<span style="color: #f00; font-weight: bold;">${info.percentUsedRaw.toFixed(1)}% ⚠️ OVER LIMIT</span>`
                : `${info.percentUsed}%`;

            return `
                <div style="font-weight: bold; margin-bottom: 8px;">Memory Monitor ${statusIcon}</div>
                ${
                    info.overLimit
                        ? `
                <div style="margin-bottom: 8px; padding: 6px; background: rgba(255,0,0,0.2); border: 1px solid #f00; border-radius: 3px; font-size: 9px; line-height: 1.4;">
                    ⚠️ <strong>CRITICAL:</strong> Memory usage exceeds browser limit!<br>
                    Restart recommended.
                </div>
                `
                        : ''
                }
                <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 8px;">
                    <div>Used:</div><div style="text-align: right;">${info.usedMB} MB</div>
                    <div>Total:</div><div style="text-align: right;">${info.totalMB} MB</div>
                    <div>Limit:</div><div style="text-align: right;">${info.limitMB} MB</div>
                    <div>Usage:</div><div style="text-align: right; font-weight: bold;">${usageDisplay}</div>
                    ${
                        info.pyodideObjects
                            ? `
                    <div style="grid-column: 1/-1; margin-top: 8px; padding-top: 8px; border-top: 1px solid currentColor; opacity: 0.7;">
                        Python Objects: ${info.pyodideObjects}
                    </div>
                    <div style="grid-column: 1/-1; opacity: 0.7;">
                        Open Fonts: ${info.openFonts}
                    </div>
                    `
                            : ''
                    }
                </div>
                <div style="margin-top: 12px; padding-top: 8px; border-top: 1px solid currentColor;">
                    <button onclick="window.memoryMonitor.forceGarbageCollection()" 
                            style="width: 100%; padding: 6px; background: #222; color: currentColor; 
                                   border: 1px solid currentColor; border-radius: 3px; cursor: pointer;
                                   font-family: inherit; font-size: 10px;">
                        🗑️ Force GC
                    </button>
                </div>
                <div style="margin-top: 8px; padding: 8px; background: rgba(255,255,0,0.1); border: 1px solid rgba(255,255,0,0.3); border-radius: 3px; font-size: 9px; line-height: 1.4;">
                    💡 <strong>To free memory:</strong><br>
                    Close ALL tabs with this app, then reopen in a new tab
                </div>
                <div style="margin-top: 4px; font-size: 9px; opacity: 0.5; text-align: center;">
                    Cmd+M to toggle
                </div>
            `;
        }

        async forceGarbageCollection() {
            console.log('🗑️ Forcing garbage collection...');

            // Python GC
            if (window.pyodide) {
                try {
                    // Use _originalRunPython to avoid triggering afterPythonExecution hooks
                    const runPython =
                        window.pyodide._originalRunPython ||
                        window.pyodide.runPython;
                    const result = runPython.call(
                        window.pyodide,
                        `
import gc
collected = gc.collect()
print(f"Python GC collected {collected} objects")
collected
                    `
                    );
                    console.log(`Python GC: Collected ${result} objects`);
                } catch (e) {
                    console.error('Python GC failed:', e);
                }
            }

            // JavaScript GC (can't force directly, but we can help)
            if (window.gc) {
                // Available in Chrome with --expose-gc flag
                window.gc();
                console.log('JavaScript GC triggered (--expose-gc)');
            } else {
                // Create memory pressure to encourage GC
                console.log('JavaScript GC: Creating memory pressure...');
                const temp = new Array(1000000).fill(0);
                temp.length = 0;
            }

            // Update display after a moment
            setTimeout(() => {
                this.updateMemoryDisplay();
                console.log('✅ Garbage collection completed');
            }, 500);
        }

        setupCleanupHandlers() {
            // Clean up interval on page unload
            window.addEventListener('beforeunload', () => {
                if (this.updateInterval) {
                    clearInterval(this.updateInterval);
                }
            });

            // No automatic cleanup - user controls via Force GC button
        }

        stop() {
            if (this.updateInterval) {
                clearInterval(this.updateInterval);
                this.updateInterval = null;
            }
            if (this.monitorElement) {
                this.monitorElement.remove();
                this.monitorElement = null;
            }
        }
    }

    // Initialize when DOM is ready
    function initMemoryMonitor() {
        if (document.querySelector('.toolbar-right')) {
            console.log('🧠 Initializing memory monitor...');
            window.memoryMonitor = new MemoryMonitor();
            window.memoryMonitor.init();
        } else {
            console.warn('⚠️ Toolbar not ready, retrying in 500ms...');
            setTimeout(initMemoryMonitor, 500);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(initMemoryMonitor, 100);
        });
    } else {
        // Document already loaded
        setTimeout(initMemoryMonitor, 100);
    }

    // Export for manual control
    window.MemoryMonitor = MemoryMonitor;
})();
