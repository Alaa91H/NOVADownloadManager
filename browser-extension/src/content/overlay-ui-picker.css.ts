import type { OverlaySettings } from '../contracts/settings.schema';

export function pickerCss(direction: string, _settings: OverlaySettings): string {
  return `
    :host { all: initial; }
    .adm-picker {
      width: 380px;
      max-width: min(92vw, 420px);
      max-height: min(74vh, 560px);
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      direction: ${direction};
      background: #ffffff;
      color: #0f172a;
      border: 1px solid rgba(255, 255, 255, .10);
      border-radius: 14px;
      box-shadow: 0 20px 50px rgba(15, 23, 42, .32);
      font: 13px/1.4 "Segoe UI", Tahoma, Arial, sans-serif;
      overflow: hidden;
    }
    .adm-picker-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 12px 14px;
      background: linear-gradient(135deg, #3b82f6, #1d4ed8);
      color: #fff;
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    .adm-picker-header[data-dragging="true"] { cursor: grabbing; }
    .adm-picker-title { font: 700 14px/1.2 "Segoe UI", Tahoma, Arial, sans-serif; }
    .adm-picker-count { opacity: .85; font-weight: 600; }
    .adm-picker-close {
      width: 28px; height: 28px; flex: 0 0 auto;
      display: grid; place-items: center;
      border: 0; border-radius: 999px; padding: 0;
      background: rgba(255, 255, 255, .18); color: #fff;
      cursor: pointer; font: 800 14px/1 Arial, sans-serif;
      transition: background .15s ease;
    }
    .adm-picker-close:hover { background: rgba(255, 255, 255, .34); }
    .adm-picker-toolbar {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      border-bottom: 1px solid #e2e8f0; background: #f8fafc;
    }
    .adm-picker-tool {
      border: 1px solid #cbd5e1; border-radius: 999px; padding: 6px 10px;
      background: #fff; color: #334155; cursor: pointer;
      font: 700 12px/1 "Segoe UI", Tahoma, Arial, sans-serif;
    }
    .adm-picker-tool:hover { background: #eff6ff; border-color: #93c5fd; color: #3b82f6; }
    .adm-picker-list { overflow-y: auto; padding: 6px; }
    .adm-picker-item {
      display: flex; align-items: flex-start; gap: 9px;
      padding: 9px 10px; border-radius: 9px; cursor: pointer;
      transition: background .14s ease;
    }
    .adm-picker-item:hover { background: #f1f5f9; }
    .adm-picker-item[data-protected="true"] { cursor: default; background: #fff7ed; border: 1px solid #fed7aa; }
    .adm-picker-item[data-protected="true"] .adm-picker-item-name { color: #9a3412; }
    .adm-picker-item input[type="checkbox"] {
      flex: 0 0 auto; margin-top: 2px; width: 16px; height: 16px; accent-color: #1d4ed8; cursor: pointer;
    }
    .adm-picker-item-main { min-width: 0; flex: 1 1 auto; }
    .adm-picker-item-name {
      font-weight: 600; color: #0f172a;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .adm-picker-item-row { display: grid; grid-template-columns: 68px minmax(76px, auto) minmax(84px, auto); gap: 8px; margin-top: 4px; align-items: center; }
    .adm-picker-field { min-width: 0; border-radius: 999px; background: #f8fafc; border: 1px solid #e2e8f0; padding: 3px 7px; color: #475569; font: 700 11px/1.2 "Segoe UI", Tahoma, Arial, sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .adm-picker-item-ext { color: #0f766e; background: #ecfdf5; border-color: #a7f3d0; text-transform: uppercase; }
    .adm-picker-item-size { color: #3b82f6; background: #eff6ff; border-color: #bfdbfe; }
    .adm-picker-item-resolution { color: #7c2d12; background: #fff7ed; border-color: #fed7aa; }
    .adm-picker-footer { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid #e2e8f0; }
    .adm-picker-status { flex: 1 1 auto; min-width: 0; color: #475569; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .adm-picker-send {
      flex: 0 0 auto; border: 0; border-radius: 9px; padding: 9px 16px; color: #fff;
      background: linear-gradient(135deg, #3b82f6, #1d4ed8);
      cursor: pointer; font: 700 13px/1 "Segoe UI", Tahoma, Arial, sans-serif;
      box-shadow: 0 2px 8px rgba(29, 78, 216, .28);
      transition: background .15s ease, transform .1s ease;
    }
    .adm-picker-send:hover:not(:disabled) { background: linear-gradient(135deg, #1e40af, #3b82f6); }
    .adm-picker-send:active:not(:disabled) { transform: scale(.97); }
    .adm-picker-send:disabled { opacity: .55; cursor: default; }
    @media (prefers-reduced-motion: reduce) {
      .adm-picker-item, .adm-picker-send, .adm-picker-close, .adm-picker-tool { transition: none; }
    }
  `;
}
