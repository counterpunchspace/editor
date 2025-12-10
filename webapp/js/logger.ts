export class Logger {
    facility: string;
    enabled: boolean = true;

    constructor(facility: string, enabled: boolean = true) {
        this.facility = facility;
        this.enabled = enabled;
    }

    log(...args: any[]) {
        if (this.enabled) {
            console.log(`[${this.facility}]`, ...args);
        }
    }
    warn(...args: any[]) {
        if (this.enabled) {
            console.warn(`[${this.facility}]`, ...args);
        }
    }
    error(...args: any[]) {
        if (this.enabled) {
            console.error(`[${this.facility}]`, ...args);
        }
    }
}
