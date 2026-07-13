import type { OverlaySettings } from '../contracts/settings.schema';

export function videoOverlayCss(
  size: number,
  iconSize: number,
  compactActions: boolean,
  direction: string,
  settings: OverlaySettings,
  estimatedWidth: number,
  estimatedHeight: number,
): string {
  return `
    :host { all: initial; }
    .nova-video-download-popover {
      position: relative;
      width: 100%;
      height: 100%;
      min-width: ${compactActions ? `${estimatedWidth}px` : `${size}px`};
      min-height: ${compactActions ? `${estimatedHeight}px` : `${size}px`};
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: ${compactActions ? 'flex-start' : 'center'};
      overflow: visible;
      font: 700 13px/1.1 "Segoe UI", Tahoma, Arial, sans-serif;
      direction: ${direction};
      user-select: none;
      touch-action: none;
    }
    .nova-video-download-trigger {
      width: ${compactActions ? `${Math.max(30, estimatedHeight - 8)}px` : `${size}px`};
      height: ${compactActions ? `${Math.max(30, estimatedHeight - 8)}px` : `${size}px`};
      box-sizing: border-box;
      display: grid;
      place-items: center;
      border: 1px solid rgba(29, 78, 216, .28);
      border-radius: 999px;
      background: rgba(255, 255, 255, .78);
      box-shadow: 0 10px 28px rgba(15, 23, 42, .22);
      opacity: ${settings.opacity};
      backdrop-filter: blur(10px) saturate(1.15);
      -webkit-backdrop-filter: blur(10px) saturate(1.15);
      cursor: grab;
      outline: none;
      transition: opacity ${settings.menuAnimationMs}ms ease, background ${settings.menuAnimationMs}ms ease, border-color ${settings.menuAnimationMs}ms ease, box-shadow ${settings.menuAnimationMs}ms ease, transform ${settings.menuAnimationMs}ms ease;
    }
    .nova-video-download-popover[data-dragging="true"] .nova-video-download-trigger {
      cursor: grabbing;
      opacity: ${settings.hoverOpacity};
      transition: none;
    }
    .nova-video-download-popover:hover .nova-video-download-trigger,
    .nova-video-download-popover:focus-within .nova-video-download-trigger,
    .nova-video-download-popover[data-open="true"] .nova-video-download-trigger {
      opacity: ${settings.hoverOpacity};
      background: rgba(18, 18, 22, .94);
      border-color: rgba(29, 78, 216, .56);
      box-shadow: 0 14px 34px rgba(15, 23, 42, .30);
      transform: translateY(-1px);
    }
    .nova-video-download-popover[data-has-candidates="true"]:not([data-open="true"]):not([data-idle="true"]) .nova-video-download-trigger {
      animation: nova-pulse-glow 2.4s ease-in-out infinite;
      border-color: rgba(29, 78, 216, .42);
    }
    @keyframes nova-pulse-glow {
      0%, 100% { box-shadow: 0 10px 28px rgba(15, 23, 42, .22), 0 0 0 0 rgba(29, 78, 216, .16); }
      50% { box-shadow: 0 10px 28px rgba(15, 23, 42, .22), 0 0 0 8px rgba(29, 78, 216, 0); }
    }
    .nova-video-download-popover[data-idle="true"] .nova-video-download-trigger {
      opacity: ${Math.max(0.2, Math.min(settings.opacity, settings.opacity * 0.48))};
      transform: scale(.86);
      box-shadow: 0 5px 16px rgba(15, 23, 42, .16);
    }
    .nova-video-download-popover[data-idle="true"]:hover .nova-video-download-trigger,
    .nova-video-download-popover[data-idle="true"]:focus-within .nova-video-download-trigger,
    .nova-video-download-popover[data-idle="true"][data-open="true"] .nova-video-download-trigger {
      opacity: ${settings.hoverOpacity};
      transform: translateY(-1px);
    }
    .nova-video-download-logo {
      width: ${iconSize}px;
      height: ${iconSize}px;
      display: block;
      object-fit: contain;
      opacity: .96;
      filter: saturate(.95);
      pointer-events: none;
      transform: translateZ(0);
    }
    .nova-video-download-popover:hover .nova-video-download-logo,
    .nova-video-download-popover:focus-within .nova-video-download-logo,
    .nova-video-download-popover[data-open="true"] .nova-video-download-logo {
      opacity: 1;
      filter: none;
    }
    .nova-video-download-actions {
      position: ${compactActions ? 'static' : 'absolute'};
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: max-content;
      max-width: min(280px, calc(100vw - 24px));
      box-sizing: border-box;
      padding: ${compactActions ? '4px' : '6px'};
      border: 1px solid rgba(255, 255, 255, .10);
      border-radius: 999px;
      background: rgba(18, 18, 22, .94);
      box-shadow: 0 16px 38px rgba(15, 23, 42, .30);
      opacity: ${compactActions ? '1' : '0'};
      visibility: ${compactActions ? 'visible' : 'hidden'};
      pointer-events: auto;
      transform: ${compactActions ? 'none' : 'translateZ(0)'};
      transition: opacity ${settings.menuAnimationMs}ms ease, transform ${settings.menuAnimationMs}ms ease, visibility 0s linear ${settings.menuAnimationMs}ms;
      cursor: grab;
    }
    .nova-video-download-popover[data-placement="up"] .nova-video-download-actions {
      left: 50%;
      bottom: calc(100% + 8px);
      transform: translate(-50%, 8px) scale(.96);
      transform-origin: bottom center;
    }
    .nova-video-download-popover[data-placement="down"] .nova-video-download-actions {
      left: 50%;
      top: calc(100% + 8px);
      transform: translate(-50%, -8px) scale(.96);
      transform-origin: top center;
    }
    .nova-video-download-popover[data-placement="left"] .nova-video-download-actions {
      right: calc(100% + 8px);
      top: 50%;
      transform: translate(8px, -50%) scale(.96);
      transform-origin: right center;
    }
    .nova-video-download-popover[data-placement="right"] .nova-video-download-actions {
      left: calc(100% + 8px);
      top: 50%;
      transform: translate(-8px, -50%) scale(.96);
      transform-origin: left center;
    }
    .nova-video-download-popover[data-align="start"][data-placement="up"] .nova-video-download-actions,
    .nova-video-download-popover[data-align="start"][data-placement="down"] .nova-video-download-actions {
      left: 0;
      right: auto;
    }
    .nova-video-download-popover[data-align="end"][data-placement="up"] .nova-video-download-actions,
    .nova-video-download-popover[data-align="end"][data-placement="down"] .nova-video-download-actions {
      left: auto;
      right: 0;
    }
    .nova-video-download-popover[data-open="true"] .nova-video-download-actions,
    .nova-video-download-popover:hover .nova-video-download-actions,
    .nova-video-download-popover:focus-within .nova-video-download-actions {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transition: opacity ${settings.menuAnimationMs}ms ease, transform ${settings.menuAnimationMs}ms ease, visibility 0s;
    }
    .nova-video-download-popover[data-open="true"][data-placement="up"] .nova-video-download-actions,
    .nova-video-download-popover:hover[data-placement="up"] .nova-video-download-actions,
    .nova-video-download-popover:focus-within[data-placement="up"] .nova-video-download-actions { transform: translate(-50%, 0) scale(1); }
    .nova-video-download-popover[data-open="true"][data-placement="down"] .nova-video-download-actions,
    .nova-video-download-popover:hover[data-placement="down"] .nova-video-download-actions,
    .nova-video-download-popover:focus-within[data-placement="down"] .nova-video-download-actions { transform: translate(-50%, 0) scale(1); }
    .nova-video-download-popover[data-open="true"][data-placement="left"] .nova-video-download-actions,
    .nova-video-download-popover:hover[data-placement="left"] .nova-video-download-actions,
    .nova-video-download-popover:focus-within[data-placement="left"] .nova-video-download-actions { transform: translate(0, -50%) scale(1); }
    .nova-video-download-popover[data-open="true"][data-placement="right"] .nova-video-download-actions,
    .nova-video-download-popover:hover[data-placement="right"] .nova-video-download-actions,
    .nova-video-download-popover:focus-within[data-placement="right"] .nova-video-download-actions { transform: translate(0, -50%) scale(1); }
    .nova-video-download-popover[data-align="start"][data-open="true"][data-placement="up"] .nova-video-download-actions,
    .nova-video-download-popover[data-align="start"]:hover[data-placement="up"] .nova-video-download-actions,
    .nova-video-download-popover[data-align="start"]:focus-within[data-placement="up"] .nova-video-download-actions,
    .nova-video-download-popover[data-align="start"][data-open="true"][data-placement="down"] .nova-video-download-actions,
    .nova-video-download-popover[data-align="start"]:hover[data-placement="down"] .nova-video-download-actions,
    .nova-video-download-popover[data-align="start"]:focus-within[data-placement="down"] .nova-video-download-actions { transform: translate(0, 0) scale(1); }
    .nova-video-download-popover[data-align="end"][data-open="true"][data-placement="up"] .nova-video-download-actions,
    .nova-video-download-popover[data-align="end"]:hover[data-placement="up"] .nova-video-download-actions,
    .nova-video-download-popover[data-align="end"]:focus-within[data-placement="up"] .nova-video-download-actions,
    .nova-video-download-popover[data-align="end"][data-open="true"][data-placement="down"] .nova-video-download-actions,
    .nova-video-download-popover[data-align="end"]:hover[data-placement="down"] .nova-video-download-actions,
    .nova-video-download-popover[data-align="end"]:focus-within[data-placement="down"] .nova-video-download-actions { transform: translate(0, 0) scale(1); }
    .nova-video-download-popover[data-compact="true"] .nova-video-download-actions {
      position: static;
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: none !important;
    }
    .nova-video-download-popover[data-compact="true"] .nova-video-download-trigger { flex: 0 0 auto; }
    .nova-video-download-label {
      color: #fff;
      min-width: ${compactActions ? '82px' : '74px'};
      min-height: ${compactActions ? '32px' : '30px'};
      box-sizing: border-box;
      border: 0;
      border-radius: 999px;
      padding: 7px 13px;
      background: linear-gradient(135deg, #3b82f6, #1d4ed8);
      cursor: pointer;
      font: 800 12px/1.15 "Segoe UI", Tahoma, Arial, sans-serif;
      white-space: nowrap;
      transition: background ${settings.menuAnimationMs}ms ease, box-shadow ${settings.menuAnimationMs}ms ease, transform 80ms ease;
      box-shadow: 0 2px 8px rgba(29, 78, 216, .28);
    }
    .nova-video-download-label:hover:not(:disabled) {
      background: linear-gradient(135deg, #1e40af, #3b82f6);
      box-shadow: 0 4px 14px rgba(29, 78, 216, .42);
    }
    .nova-video-download-label:active:not(:disabled) { transform: scale(.96); }
    .nova-video-download-label:disabled { cursor: wait; opacity: .72; }
    .nova-video-download-close {
      width: ${compactActions ? '32px' : '30px'};
      height: ${compactActions ? '32px' : '30px'};
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 999px;
      padding: 0;
      background: #ef4444;
      color: #fff;
      cursor: pointer;
      font: 900 16px/1 Arial, sans-serif;
      transition: background ${settings.menuAnimationMs}ms ease, transform 80ms ease;
    }
    .nova-video-download-close:hover { background: #dc2626; }
    .nova-video-download-close:active { transform: scale(.94); }
    @media (prefers-reduced-motion: reduce) {
      .nova-video-download-trigger,
      .nova-video-download-actions,
      .nova-video-download-label,
      .nova-video-download-close { transition: none; }
    }
  `;
}
