export function postBinaryFontExportMessage(
    targetWindow: Window,
    bytes: Uint8Array,
    metadata: Record<string, unknown>
): void {
    const messageBytes = bytes.slice();
    targetWindow.postMessage(
        {
            type: 'counterpunch:binary-font-exported',
            version: 1,
            bytes: messageBytes.buffer,
            metadata
        },
        window.location.origin,
        [messageBytes.buffer]
    );
}
