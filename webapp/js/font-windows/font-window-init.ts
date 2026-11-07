// Registers this editor window with the other Counterpunch windows. Imported
// by bootstrap right after window-role, which tells font windows apart from
// same-font view windows.
import '../window-role';
import { initFontWindow } from './font-window';

initFontWindow();
