import React, { useState } from 'react';
import { Bell, Keyboard, ListChecks, Paintbrush, Plus, SlidersHorizontal, Trash2, Volume2, Wand2 } from 'lucide-react';
import type {
  AppSettings,
  CustomButtonAction,
  CustomButtonIcon,
  CustomToolbarButton,
  KeyboardShortcutAction,
  StatusBarItemId,
  ToolbarButtonDisplayMode,
  ToolbarButtonId,
} from '../../../types/desktop-ui.types';
import { Button, Checkbox, SelectField, Switch, TextField } from '../../../components/primitives';
import { useAppStore } from '../../../state/appStore';
import { playAppSound } from '../../../utils/sound';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
}

const toolbarButtons: Array<{ id: ToolbarButtonId; labelKey: string }> = [
  { id: 'newDownload', labelKey: 'topbar_new_download' },
  { id: 'resume', labelKey: 'resume' },
  { id: 'stop', labelKey: 'topbar_stop' },
  { id: 'delete', labelKey: 'action_delete' },
  { id: 'scheduler', labelKey: 'nav_queues' },
];

const statusItems: Array<{ id: StatusBarItemId; labelKey: string }> = [
  { id: 'speed', labelKey: 'statusbar_item_speed' },
  { id: 'counts', labelKey: 'statusbar_item_counts' },
  { id: 'downloaded', labelKey: 'statusbar_item_downloaded' },
  { id: 'daemon', labelKey: 'statusbar_item_daemon' },
  { id: 'browser', labelKey: 'statusbar_item_browser' },
  { id: 'telegram', labelKey: 'statusbar_item_telegram' },
  { id: 'clipboard', labelKey: 'statusbar_item_clipboard' },
  { id: 'speedLimiter', labelKey: 'statusbar_item_speed_limiter' },
  { id: 'notifications', labelKey: 'statusbar_item_notifications' },
];

const shortcutActions: Array<{ id: KeyboardShortcutAction; labelKey: string }> = [
  { id: 'addDownload', labelKey: 'shortcut_add_download' },
  { id: 'batchDownload', labelKey: 'shortcut_batch_download' },
  { id: 'focusSearch', labelKey: 'shortcut_focus_search' },
  { id: 'selectAllDownloads', labelKey: 'shortcut_select_all_downloads' },
  { id: 'resumeSelected', labelKey: 'shortcut_resume_selected' },
  { id: 'resumeAll', labelKey: 'shortcut_resume_all' },
  { id: 'stopSelected', labelKey: 'shortcut_stop_selected' },
  { id: 'stopAll', labelKey: 'shortcut_stop_all' },
  { id: 'deleteSelected', labelKey: 'shortcut_delete_selected' },
  { id: 'deleteCompleted', labelKey: 'shortcut_delete_completed' },
  { id: 'openSettings', labelKey: 'shortcut_open_settings' },
  { id: 'openScheduler', labelKey: 'shortcut_open_scheduler' },
  { id: 'toggleNotifications', labelKey: 'shortcut_toggle_notifications' },
  { id: 'toggleSpeedLimiter', labelKey: 'shortcut_toggle_speed_limiter' },
];

const customButtonActions: Array<{ value: CustomButtonAction; labelKey: string }> = [
  { value: 'addDownload', labelKey: 'topbar_single_url' },
  { value: 'batchDownload', labelKey: 'topbar_batch_download' },
  { value: 'webpageGrabber', labelKey: 'dlg_webpage_grabber' },
  { value: 'mediaDownload', labelKey: 'dlg_media_downloader' },
  { value: 'resumeAll', labelKey: 'topbar_resume_all' },
  { value: 'stopAll', labelKey: 'topbar_stop_all' },
  { value: 'deleteAll', labelKey: 'topbar_delete_all' },
  { value: 'deleteCompleted', labelKey: 'topbar_delete_completed' },
  { value: 'openSettings', labelKey: 'nav_settings' },
  { value: 'openScheduler', labelKey: 'nav_queues' },
  { value: 'toggleNotifications', labelKey: 'statusbar_notifications_title' },
  { value: 'toggleSpeedLimiter', labelKey: 'speed_limiter' },
  { value: 'sendSelectedToTelegram', labelKey: 'telegram_send_selected_file' },
];

const customButtonIcons: CustomButtonIcon[] = [
  'plus',
  'layers',
  'play',
  'stop',
  'trash',
  'settings',
  'telegram',
  'bell',
  'clock',
  'globe',
  'video',
];

const displayOptions: Array<{ value: ToolbarButtonDisplayMode; labelKey: string }> = [
  { value: 'full', labelKey: 'ui_display_full' },
  { value: 'iconOnly', labelKey: 'ui_display_icon_only' },
  { value: 'labelOnly', labelKey: 'ui_display_label_only' },
  { value: 'hidden', labelKey: 'ui_display_hidden' },
];

const soundOptions = [
  { value: 'off', labelKey: 'sound_off' },
  { value: 'soft', labelKey: 'sound_soft' },
  { value: 'tap', labelKey: 'sound_tap' },
  { value: 'chime', labelKey: 'sound_chime' },
  { value: 'alert', labelKey: 'sound_alert' },
  { value: 'custom', labelKey: 'sound_custom' },
];

export const InterfaceCustomization: React.FC<Props> = ({ settings, updateSetting }) => {
  const { t, addToast } = useAppStore();
  const [customLabel, setCustomLabel] = useState('');
  const [customAction, setCustomAction] = useState<CustomButtonAction>('addDownload');
  const [customIcon, setCustomIcon] = useState<CustomButtonIcon>('plus');

  const updateToolbarButton = (
    id: ToolbarButtonId,
    key: 'display' | 'showDropdown',
    value: ToolbarButtonDisplayMode | boolean,
  ) => {
    updateSetting('ui', 'toolbar', {
      ...settings.ui.toolbar,
      [id]: {
        ...settings.ui.toolbar[id],
        [key]: value,
      },
    });
  };

  const updateStatusItem = (id: StatusBarItemId, visible: boolean) => {
    updateSetting('ui', 'statusBar', {
      ...settings.ui.statusBar,
      [id]: {
        ...settings.ui.statusBar[id],
        visible,
      },
    });
  };

  const updateShortcut = (id: KeyboardShortcutAction, value: string) => {
    updateSetting('keyboardShortcuts', 'bindings', {
      ...settings.keyboardShortcuts.bindings,
      [id]: value,
    });
  };

  const updateCustomButton = (buttonId: string, patch: Partial<CustomToolbarButton>) => {
    updateSetting(
      'ui',
      'customButtons',
      settings.ui.customButtons.map((button) => (button.id === buttonId ? { ...button, ...patch } : button)),
    );
  };

  const removeCustomButton = (buttonId: string) => {
    updateSetting(
      'ui',
      'customButtons',
      settings.ui.customButtons.filter((button) => button.id !== buttonId),
    );
  };

  const addCustomButton = () => {
    const label =
      customLabel.trim() || t(customButtonActions.find((item) => item.value === customAction)?.labelKey || '');
    const nextButton: CustomToolbarButton = {
      id: `custom_${Date.now().toString(36)}`,
      label,
      action: customAction,
      icon: customIcon,
      enabled: true,
      display: 'full',
    };
    updateSetting('ui', 'customButtons', [...settings.ui.customButtons, nextButton]);
    setCustomLabel('');
  };

  const readCustomSound = (
    file: File | undefined,
    key: 'customCompleteDataUrl' | 'customErrorDataUrl' | 'customQueueFinishedDataUrl' | 'customNotificationDataUrl',
  ) => {
    if (!file) return;
    if (!file.type.startsWith('audio/')) {
      addToast('error', t('sound_custom_file'), t('sound_custom_file_invalid'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      updateSetting('sounds', key, typeof reader.result === 'string' ? reader.result : '');
    };
    reader.readAsDataURL(file);
  };

  const soundSelect = (
    label: string,
    key: 'onComplete' | 'onError' | 'onQueueFinished' | 'onNotification',
    testEvent: 'complete' | 'error' | 'queueFinished' | 'notification',
  ) => (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 items-end">
      <SelectField
        label={label}
        value={settings.sounds[key]}
        onChange={(e) => {
          updateSetting('sounds', key, e.target.value);
        }}
        options={soundOptions.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
      />
      <Button
        type="button"
        size="md"
        variant="secondary"
        onClick={() => {
          playAppSound(settings, testEvent);
        }}
      >
        {t('sound_test')}
      </Button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Paintbrush className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-extrabold text-[var(--accent-primary)]">{t('ui_customization')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-[var(--info)]" />
            <span className="text-[11px] font-extrabold text-[var(--info)]">{t('ui_toolbar_buttons')}</span>
          </div>
          <div className="grid grid-cols-1 gap-2">
            {toolbarButtons.map((button) => (
              <div key={button.id} className="grid grid-cols-1 md:grid-cols-[1fr_160px_90px] gap-2 items-center">
                <span className="text-xs font-bold text-[var(--text-primary)]">{t(button.labelKey)}</span>
                <SelectField
                  value={settings.ui.toolbar[button.id].display}
                  onChange={(e) => {
                    updateToolbarButton(button.id, 'display', e.target.value as ToolbarButtonDisplayMode);
                  }}
                  options={displayOptions.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                />
                <Checkbox
                  label={t('ui_dropdown')}
                  checked={settings.ui.toolbar[button.id].showDropdown}
                  disabled={button.id === 'scheduler'}
                  onChange={(checked) => {
                    updateToolbarButton(button.id, 'showDropdown', checked);
                  }}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-[var(--success)]" />
            <span className="text-[11px] font-extrabold text-[var(--success)]">{t('ui_custom_buttons')}</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_170px_120px_auto] gap-2 items-end">
            <TextField
              label={t('ui_custom_button_label')}
              value={customLabel}
              onChange={(e) => {
                setCustomLabel(e.target.value);
              }}
            />
            <SelectField
              label={t('ui_custom_button_action')}
              value={customAction}
              onChange={(e) => {
                setCustomAction(e.target.value as CustomButtonAction);
              }}
              options={customButtonActions.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
            />
            <SelectField
              label={t('ui_custom_button_icon')}
              value={customIcon}
              onChange={(e) => {
                setCustomIcon(e.target.value as CustomButtonIcon);
              }}
              options={customButtonIcons.map((icon) => ({ value: icon, label: icon }))}
            />
            <Button type="button" size="md" variant="primary" icon={Plus} onClick={addCustomButton}>
              {t('settings_webhook_add')}
            </Button>
          </div>

          <div className="space-y-2">
            {settings.ui.customButtons.map((button) => (
              <div
                key={button.id}
                className="grid grid-cols-1 lg:grid-cols-[auto_1fr_160px_120px_120px_auto] gap-2 items-center bg-[var(--bg-input)]/60 border border-[var(--border-color)] rounded-lg p-2"
              >
                <Switch
                  checked={button.enabled}
                  onChange={(checked) => {
                    updateCustomButton(button.id, { enabled: checked });
                  }}
                />
                <TextField
                  value={button.label}
                  onChange={(e) => {
                    updateCustomButton(button.id, { label: e.target.value });
                  }}
                />
                <SelectField
                  value={button.action}
                  onChange={(e) => {
                    updateCustomButton(button.id, { action: e.target.value as CustomButtonAction });
                  }}
                  options={customButtonActions.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                />
                <SelectField
                  value={button.icon}
                  onChange={(e) => {
                    updateCustomButton(button.id, { icon: e.target.value as CustomButtonIcon });
                  }}
                  options={customButtonIcons.map((icon) => ({ value: icon, label: icon }))}
                />
                <SelectField
                  value={button.display}
                  onChange={(e) => {
                    updateCustomButton(button.id, {
                      display: e.target.value as CustomToolbarButton['display'],
                    });
                  }}
                  options={displayOptions
                    .filter((option) => option.value !== 'hidden')
                    .map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                />
                <button
                  type="button"
                  onClick={() => {
                    removeCustomButton(button.id);
                  }}
                  className="p-1.5 text-[var(--danger)] hover:bg-[var(--danger-bg)] rounded cursor-pointer"
                  title={t('action_delete')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="flex items-center gap-2">
            <ListChecks className="w-4 h-4 text-[var(--warning)]" />
            <span className="text-[11px] font-extrabold text-[var(--warning)]">{t('ui_statusbar_icons')}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {statusItems.map((item) => (
              <Checkbox
                key={item.id}
                label={t(item.labelKey)}
                checked={settings.ui.statusBar[item.id].visible}
                onChange={(checked) => {
                  updateStatusItem(item.id, checked);
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Volume2 className="w-4 h-4 text-[var(--success)]" />
          <h3 className="text-sm font-extrabold text-[var(--success)]">{t('sound_alerts')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex items-center justify-between border-b border-[var(--border-color)]/40 pb-2">
              <span className="text-xs font-bold text-[var(--text-primary)]">{t('sound_enable')}</span>
              <Switch
                checked={settings.sounds.enabled}
                onChange={(checked) => {
                  updateSetting('sounds', 'enabled', checked);
                }}
              />
            </div>
            <div className="flex items-center justify-between border-b border-[var(--border-color)]/40 pb-2">
              <span className="text-xs font-bold text-[var(--text-primary)]">{t('sound_toasts')}</span>
              <Switch
                checked={settings.sounds.toastSound}
                onChange={(checked) => {
                  updateSetting('sounds', 'toastSound', checked);
                }}
              />
            </div>
          </div>
          <TextField
            label={t('sound_volume')}
            type="number"
            min={0}
            max={100}
            value={settings.sounds.volume}
            onChange={(e) => {
              updateSetting('sounds', 'volume', Number(e.target.value));
            }}
          />
          {soundSelect(t('sound_complete'), 'onComplete', 'complete')}
          {soundSelect(t('sound_error'), 'onError', 'error')}
          {soundSelect(t('sound_queue_finished'), 'onQueueFinished', 'queueFinished')}
          {soundSelect(t('sound_notification'), 'onNotification', 'notification')}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-[var(--border-color)]/40">
            <label className="text-xs font-bold text-[var(--text-secondary)] flex flex-col gap-1">
              {t('sound_custom_complete')}
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => {
                  readCustomSound(e.target.files?.[0], 'customCompleteDataUrl');
                }}
              />
            </label>
            <label className="text-xs font-bold text-[var(--text-secondary)] flex flex-col gap-1">
              {t('sound_custom_error')}
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => {
                  readCustomSound(e.target.files?.[0], 'customErrorDataUrl');
                }}
              />
            </label>
            <label className="text-xs font-bold text-[var(--text-secondary)] flex flex-col gap-1">
              {t('sound_custom_queue')}
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => {
                  readCustomSound(e.target.files?.[0], 'customQueueFinishedDataUrl');
                }}
              />
            </label>
            <label className="text-xs font-bold text-[var(--text-secondary)] flex flex-col gap-1">
              {t('sound_custom_notification')}
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => {
                  readCustomSound(e.target.files?.[0], 'customNotificationDataUrl');
                }}
              />
            </label>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Keyboard className="w-4 h-4 text-[var(--info)]" />
          <h3 className="text-sm font-extrabold text-[var(--info)]">{t('shortcuts_title')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="flex items-center justify-between border-b border-[var(--border-color)]/40 pb-2">
            <span className="text-xs font-bold text-[var(--text-primary)]">{t('shortcuts_enable')}</span>
            <Switch
              checked={settings.keyboardShortcuts.enabled}
              onChange={(checked) => {
                updateSetting('keyboardShortcuts', 'enabled', checked);
              }}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {shortcutActions.map((shortcut) => (
              <TextField
                key={shortcut.id}
                label={t(shortcut.labelKey)}
                value={settings.keyboardShortcuts.bindings[shortcut.id]}
                onChange={(e) => {
                  updateShortcut(shortcut.id, e.target.value);
                }}
                style={{ direction: 'ltr', textAlign: 'left' }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-start gap-2 text-[10px] text-[var(--text-muted)] bg-[var(--bg-hover)]/20 border border-[var(--border-color)] rounded-lg p-3">
        <Bell className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>{t('shortcuts_hint')}</span>
      </div>
    </div>
  );
};
