/**
 * Shared Styles for SillyTavern Character Library Modules
 * Centralized styling that can be used by any module
 * 
 * @module SharedStyles
 * @version 1.0.0
 */

let isInjected = false;

/**
 * Inject shared styles into the document
 * Safe to call multiple times - will only inject once
 */
export function inject() {
    if (isInjected) return;
    
    const styles = `
    <style id="cl-shared-styles">
        /* ========================================
         * CSS Variables for Modules
         * These override/extend SillyTavern theme vars
         * ======================================== */
        :root {
            --cl-accent-rgb: 74, 158, 255;
            --cl-accent: rgb(var(--cl-accent-rgb));
            --cl-accent-hover: color-mix(in srgb, var(--cl-accent), white 20%);
            --cl-glass-bg: rgba(30, 30, 30, 0.95);
            --cl-border: rgba(58, 58, 58, 0.6);
            --cl-text-primary: var(--SmartThemeBodyColor, #e0e0e0);
            --cl-text-secondary: var(--SmartThemeQuoteColor, #a0a0a0);
            --cl-shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.15);
            --cl-shadow-md: 0 4px 16px rgba(0, 0, 0, 0.2);
            --cl-shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.3);
            --cl-shadow-xl: 0 16px 48px rgba(0, 0, 0, 0.4);
            --cl-success: #4caf50;
            --cl-error: #f44336;
            --cl-warning: #ff9800;
        }

        /* ========================================
         * Context Menu
         * ======================================== */
        .cl-context-menu {
            display: none;
            position: fixed;
            background: var(--cl-glass-bg);
            backdrop-filter: blur(16px);
            border: 1px solid rgba(var(--cl-accent-rgb), 0.2);
            border-radius: 12px;
            box-shadow: 
                var(--cl-shadow-xl),
                0 0 40px rgba(0, 0, 0, 0.3),
                inset 0 1px 0 rgba(255, 255, 255, 0.05);
            z-index: 10000;
            min-width: 200px;
            padding: 6px;
            opacity: 0;
            transform: scale(0.97);
            transition: opacity 0.08s ease-out, transform 0.08s ease-out;
        }

        .cl-context-menu.visible {
            display: block;
            animation: clContextMenuSlide 0.15s ease forwards;
        }

        @keyframes clContextMenuSlide {
            to {
                opacity: 1;
                transform: scale(1);
            }
        }

        .cl-context-menu-item {
            padding: 10px 14px;
            cursor: pointer;
            border-radius: 6px;
            transition: background 0.03s;
            display: flex;
            align-items: center;
            gap: 12px;
            color: var(--cl-text-primary);
            font-size: 14px;
            user-select: none;
        }

        .cl-context-menu-item i {
            width: 18px;
            text-align: center;
            opacity: 0.8;
            font-size: 14px;
        }

        .cl-context-menu-item:hover {
            background: rgba(var(--cl-accent-rgb), 0.2);
        }

        .cl-context-menu-item:hover i {
            opacity: 1;
        }

        .cl-context-menu-item.danger {
            color: #ff6b7a;
        }

        .cl-context-menu-item.danger:hover {
            background: rgba(244, 67, 54, 0.25);
        }

        .cl-context-menu-item.secondary {
            color: var(--cl-text-secondary);
        }

        .cl-context-menu-item.secondary:hover {
            background: rgba(255, 255, 255, 0.05);
        }

        .cl-context-menu-item.disabled {
            opacity: 0.5;
            pointer-events: none;
        }

        .cl-context-menu-separator {
            height: 1px;
            background: var(--cl-border);
            margin: 6px 0;
        }

        .cl-context-menu-header {
            padding: 8px 14px;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--cl-text-secondary);
            font-weight: 600;
        }

        /* ========================================
         * Modal Base Styles
         * ======================================== */
        .cl-modal {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.2s, visibility 0.2s;
        }
        
        .cl-modal.visible {
            opacity: 1;
            visibility: visible;
        }
        
        .cl-modal-content {
            background: var(--cl-glass-bg);
            border-radius: 12px;
            width: 90%;
            max-width: 500px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            box-shadow: var(--cl-shadow-xl);
            border: 1px solid var(--cl-border);
            transform: scale(0.95);
            transition: transform 0.2s;
        }
        
        .cl-modal.visible .cl-modal-content {
            transform: scale(1);
        }
        
        .cl-modal-header {
            display: flex;
            align-items: center;
            padding: 16px 20px;
            border-bottom: 1px solid var(--cl-border);
            gap: 12px;
        }
        
        .cl-modal-header h3 {
            margin: 0;
            font-size: 1.1em;
            color: var(--cl-text-primary);
            flex: 1;
        }
        
        .cl-modal-close {
            background: none;
            border: none;
            color: var(--cl-text-primary);
            cursor: pointer;
            padding: 4px 8px;
            font-size: 1.2em;
            opacity: 0.7;
            transition: opacity 0.2s;
        }
        
        .cl-modal-close:hover {
            opacity: 1;
        }
        
        .cl-modal-body {
            padding: 20px;
            overflow-y: auto;
            flex: 1;
        }
        
        .cl-modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            padding: 16px 20px;
            border-top: 1px solid var(--cl-border);
        }

        /* ========================================
         * Button Styles
         * ======================================== */
        .cl-btn {
            padding: 10px 20px;
            border-radius: 8px;
            border: none;
            cursor: pointer;
            font-size: 0.95em;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s;
        }
        
        .cl-btn-primary {
            background: var(--cl-accent);
            color: white;
        }
        
        .cl-btn-primary:hover:not(:disabled) {
            background: var(--cl-accent-hover);
        }
        
        .cl-btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .cl-btn-secondary {
            background: rgba(255, 255, 255, 0.1);
            color: var(--cl-text-primary);
        }
        
        .cl-btn-secondary:hover {
            background: rgba(255, 255, 255, 0.15);
        }
        
        .cl-btn-danger {
            background: rgba(244, 67, 54, 0.2);
            color: #ff6b7a;
        }
        
        .cl-btn-danger:hover {
            background: rgba(244, 67, 54, 0.35);
        }

        /* ========================================
         * Form Elements
         * ======================================== */
        .cl-input {
            width: 100%;
            padding: 10px 12px;
            border-radius: 8px;
            border: 1px solid var(--cl-border);
            background: rgba(0, 0, 0, 0.3);
            color: var(--cl-text-primary);
            font-size: 0.95em;
        }
        
        .cl-input:focus {
            outline: none;
            border-color: var(--cl-accent);
        }
        
        .cl-input::placeholder {
            color: var(--cl-text-secondary);
        }

        /* ========================================
         * Tag Pills
         * ======================================== */
        .cl-tag {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 0.85em;
            cursor: pointer;
            transition: all 0.2s;
        }

        .cl-tag-success {
            background: rgba(76, 175, 80, 0.2);
            color: #81c784;
            border: 1px solid rgba(76, 175, 80, 0.3);
        }

        .cl-tag-warning {
            background: rgba(255, 193, 7, 0.2);
            color: #ffd54f;
            border: 1px solid rgba(255, 193, 7, 0.3);
        }

        .cl-tag-info {
            background: rgba(33, 150, 243, 0.2);
            color: #64b5f6;
            border: 1px solid rgba(33, 150, 243, 0.3);
        }

        .cl-tag-danger {
            background: rgba(244, 67, 54, 0.2);
            color: #e57373;
            border: 1px solid rgba(244, 67, 54, 0.3);
        }

        /* ========================================
         * Utility Classes
         * ======================================== */
        .cl-hidden {
            display: none !important;
        }

        .cl-flex {
            display: flex;
        }

        .cl-flex-wrap {
            flex-wrap: wrap;
        }

        .cl-gap-sm {
            gap: 6px;
        }

        .cl-gap-md {
            gap: 12px;
        }

        .cl-text-muted {
            color: var(--cl-text-secondary);
        }

        .cl-text-sm {
            font-size: 0.85em;
        }
    </style>`;
    
    document.head.insertAdjacentHTML('beforeend', styles);
    isInjected = true;
    console.log('[SharedStyles] Injected shared module styles');
}

/**
 * Check if styles are already injected
 */
export function isLoaded() {
    return isInjected;
}

export default { inject, isLoaded };
