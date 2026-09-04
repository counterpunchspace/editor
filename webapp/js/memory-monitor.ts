// Memory monitor for Preferences: live Used bar plus on-demand cache breakdown.

import { Logger } from './logger';
import {
    collectLocalMemoryBreakdown,
    liveShardMemoryFromEngine,
    readBrowserHeapSnapshot,
    refreshWorkerMemoryDomains,
    renderMemoryBreakdown,
    type BrowserHeapSnapshot
} from './memory-breakdown';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';

const console = new Logger('MemoryMonitor');

type SettingsMemoryInfo = {
    supported: boolean;
    usedMB: string;
    limitMB: string;
    percentUsedRaw: number;
};

class MemoryMonitor {
    settingsBarElement: HTMLElement | null = null;
    settingsPercentageElement: HTMLElement | null = null;
    settingsDetailsElement: HTMLElement | null = null;
    settingsIndicator: HTMLElement | null = null;
    updateInterval: ReturnType<typeof setInterval> | null = null;
    breakdownInFlight = false;
    warningThreshold = 0.7;
    criticalThreshold = 0.9;

    init() {
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
        this.bindUndoTruncation();
        this.setupInfoPopup();
        this.startMonitoring();
        window.addEventListener('beforeunload', () => {
            if (this.updateInterval) {
                clearInterval(this.updateInterval);
            }
        });
        console.log('Memory monitor initialized');
    }

    bindUndoTruncation() {
        const button = document.getElementById('truncate-undo-history-btn');
        button?.addEventListener('click', () => {
            window.patchSyncEngine?.truncateUndoHistory?.();
            this.updateSettingsDisplay(readBrowserHeapSnapshot());
        });
    }

    updateShardMemoryWarning() {
        const warning = document.getElementById('shard-memory-warning');
        const button = document.getElementById('truncate-undo-history-btn');
        const report = liveShardMemoryFromEngine();
        const show = report?.status === 'warning';
        if (warning) {
            warning.hidden = !show;
            warning.textContent =
                show && report
                    ? `Live CRDT is large (${report.decodedStructs} structs). Rebaseline keeps unsent updates. Clear undo history only if you mean to drop local undo.`
                    : '';
        }
        if (button) {
            button.hidden = !show;
        }
        if (show && this.settingsIndicator) {
            this.settingsIndicator.classList.add('warning');
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

        let escapeBinding: ModalEscapeBinding | null = null;
        const closePopup = () => {
            escapeBinding?.release();
            escapeBinding = null;
            popup.style.display = 'none';
        };

        infoBtn.addEventListener('click', (e: MouseEvent) => {
            e.preventDefault();
            popup.style.display = 'flex';
            escapeBinding?.release();
            escapeBinding = bindModalEscape(closePopup, {
                isOpen: () => popup.style.display === 'flex'
            });
            const heap = readBrowserHeapSnapshot();
            this.updateSettingsDisplay(heap);
            void this.refreshMemoryBreakdown(heap);
        });

        closeBtn.addEventListener('click', closePopup);
        popup.addEventListener('click', (e: MouseEvent) => {
            if (e.target === popup) {
                closePopup();
            }
        });
    }

    isMemoryPopupOpen(): boolean {
        const popup = document.getElementById('memory-info-popup');
        return popup?.style.display === 'flex';
    }

    renderMemoryBreakdownTable(heap: BrowserHeapSnapshot) {
        const tables = document.getElementById('memory-breakdown-tables');
        const status = document.getElementById('memory-breakdown-status');
        if (!tables) {
            return;
        }
        try {
            tables.innerHTML = renderMemoryBreakdown(
                collectLocalMemoryBreakdown(heap)
            );
            if (status) {
                status.textContent = 'Updates every second';
            }
        } catch (error) {
            console.warn('Memory breakdown failed:', error);
            tables.innerHTML = '<p>Could not measure cache sizes.</p>';
            if (status) {
                status.textContent = String(error);
            }
        }
    }

    async refreshMemoryBreakdown(heap: BrowserHeapSnapshot) {
        if (this.breakdownInFlight) {
            return;
        }
        this.breakdownInFlight = true;
        try {
            this.renderMemoryBreakdownTable(heap);
            await refreshWorkerMemoryDomains();
            if (this.isMemoryPopupOpen()) {
                this.renderMemoryBreakdownTable(heap);
            }
        } finally {
            this.breakdownInFlight = false;
        }
    }

    getSettingsMemoryInfo(heap: BrowserHeapSnapshot): SettingsMemoryInfo {
        if (heap.usedBytes == null || heap.limitBytes == null) {
            return {
                supported: false,
                usedMB: '0',
                limitMB: '0',
                percentUsedRaw: 0
            };
        }
        return {
            supported: true,
            usedMB: (heap.usedBytes / 1048576).toFixed(2),
            limitMB: (heap.limitBytes / 1048576).toFixed(2),
            percentUsedRaw: (heap.usedBytes / heap.limitBytes) * 100
        };
    }

    updateSettingsDisplay(heap: BrowserHeapSnapshot) {
        const info = this.getSettingsMemoryInfo(heap);

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

        const percent = Math.min(100, info.percentUsedRaw);

        if (this.settingsPercentageElement) {
            this.settingsPercentageElement.textContent = `${percent.toFixed(0)}%`;
        }
        if (this.settingsDetailsElement) {
            this.settingsDetailsElement.textContent = `${info.usedMB} MB used of ${info.limitMB} MB`;
        }
        if (this.settingsBarElement) {
            this.settingsBarElement.style.width = `${percent}%`;
            this.settingsBarElement.classList.remove('warning', 'critical');
            if (percent >= this.criticalThreshold * 100) {
                this.settingsBarElement.classList.add('critical');
            } else if (percent >= this.warningThreshold * 100) {
                this.settingsBarElement.classList.add('warning');
            }
        }
        if (this.settingsIndicator) {
            this.settingsIndicator.classList.remove('warning', 'critical');
            if (percent >= this.criticalThreshold * 100) {
                this.settingsIndicator.classList.add('critical');
            } else if (percent >= this.warningThreshold * 100) {
                this.settingsIndicator.classList.add('warning');
            }
        }
        this.updateShardMemoryWarning();
    }

    startMonitoring() {
        this.updateInterval = setInterval(() => {
            const heap = readBrowserHeapSnapshot();
            this.updateSettingsDisplay(heap);
            if (this.isMemoryPopupOpen()) {
                void this.refreshMemoryBreakdown(heap);
            }
        }, 1000);
        this.updateSettingsDisplay(readBrowserHeapSnapshot());
    }
}

function initMemoryMonitor() {
    if (document.querySelector('.toolbar-right')) {
        console.log('Initializing memory monitor...');
        new MemoryMonitor().init();
    } else {
        console.warn('Toolbar not ready, retrying in 500ms...');
        setTimeout(initMemoryMonitor, 500);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(initMemoryMonitor, 100);
    });
} else {
    setTimeout(initMemoryMonitor, 100);
}
