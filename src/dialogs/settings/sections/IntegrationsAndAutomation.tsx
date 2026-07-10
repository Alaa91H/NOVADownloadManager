/* src/dialogs/settings/sections/IntegrationsAndAutomation.tsx */
import React, { useState, useEffect, useRef } from 'react';
import { AppSettings } from '../../../types/desktop-ui.types';
import { FormRow, Switch, TextField, Checkbox } from '../../../components/primitives';
import { Bot, Link, Mail, Plus, Send, Trash2, Zap } from 'lucide-react';
import { novaClient } from '../../../api/novaClient';
import { useAppStore } from '../../../state/appStore';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  onAddToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, msg: string) => void;
  activeSubTab?: 'telegram' | 'webhooks' | 'smtp' | 'rules';
  onChangeSubTab?: (tab: 'telegram' | 'webhooks' | 'smtp' | 'rules') => void;
}

export const IntegrationsAndAutomation: React.FC<Props> = ({
  settings,
  updateSetting,
  onAddToast,
  activeSubTab = 'telegram',
}) => {
  const { t } = useAppStore();
  const [webhooks, setWebhooks] = useState<Array<{ id: string; url: string; event: string; active: boolean }>>([]);
  const [webhookUrl, setWebhookUrl] = useState(settings.extra.webhookUrl || '');
  const [telegramStatus, setTelegramStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const tgSyncRef = useRef(false);

  useEffect(() => {
    if (!tgSyncRef.current) {
      tgSyncRef.current = true;
      return;
    }
    const timer = setTimeout(() => {
      void novaClient
        .updateTelegramConfig({
          enabled: settings.extra.tgEnabled,
          token: settings.extra.tgBotToken,
          chatId: parseInt(settings.extra.tgChatId, 10) || 0,
          apiBase: settings.extra.tgApiBase,
          fileUploadLimitMb: settings.extra.tgFileUploadLimitMb,
        })
        .catch(() => {
          /* daemon might not be ready */
        });
    }, 500);
    return () => {
      clearTimeout(timer);
    };
  }, [
    settings.extra.tgEnabled,
    settings.extra.tgBotToken,
    settings.extra.tgChatId,
    settings.extra.tgApiBase,
    settings.extra.tgFileUploadLimitMb,
  ]);

  const handleTestTelegram = async () => {
    setTelegramStatus('testing');
    try {
      await novaClient.updateTelegramConfig({
        enabled: settings.extra.tgEnabled,
        token: settings.extra.tgBotToken,
        chatId: parseInt(settings.extra.tgChatId, 10) || 0,
        apiBase: settings.extra.tgApiBase,
        fileUploadLimitMb: settings.extra.tgFileUploadLimitMb,
      });
      const result = await novaClient.testTelegram();
      setTelegramStatus(result.ok ? 'ok' : 'fail');
      if (result.ok) {
        onAddToast('success', t('settings_toast_telegram_test'), t('settings_toast_telegram_ok'));
      } else {
        onAddToast('error', t('settings_toast_telegram_test'), result.error || 'Test failed.');
      }
    } catch {
      setTelegramStatus('fail');
      onAddToast('error', t('settings_toast_telegram_test'), t('settings_toast_telegram_fail'));
    }
  };

  const handleAddWebhook = () => {
    if (!webhookUrl.trim()) {
      onAddToast('error', t('settings_toast_webhook_title'), t('settings_toast_webhook_url_empty'));
      return;
    }
    const next = { id: crypto.randomUUID(), url: webhookUrl.trim(), event: 'download.completed', active: true };
    setWebhooks((prev) => [...prev, next]);
    updateSetting('extra', 'webhookUrl', webhookUrl.trim());
    onAddToast('success', t('settings_toast_webhook_added'), t('settings_toast_webhook_added'));
  };

  const removeWebhook = (id: string) => {
    setWebhooks((prev) => prev.filter((item) => item.id !== id));
    onAddToast('info', t('settings_toast_webhook_removed'), t('settings_toast_webhook_removed'));
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
        <Zap className="w-4 h-4 text-[var(--accent-primary)]" />
        <h3 className="text-sm font-extrabold text-[var(--accent-primary)]">{t('settings_integrations_automation')}</h3>
      </div>

      {activeSubTab === 'telegram' && (
        <div className="space-y-4">
          <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-blue-400" />
              <span className="text-[11px] font-extrabold text-blue-400">{t('settings_telegram_notifications')}</span>
            </div>
            <FormRow label={t('settings_enable_telegram')}>
              <Switch
                checked={settings.extra.tgEnabled}
                onChange={(v) => {
                  updateSetting('extra', 'tgEnabled', v);
                }}
              />
            </FormRow>
            <TextField
              label={t('settings_bot_token')}
              value={settings.extra.tgBotToken}
              onChange={(e) => {
                updateSetting('extra', 'tgBotToken', e.target.value);
              }}
              type="password"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('settings_chat_id')}
              value={settings.extra.tgChatId}
              onChange={(e) => {
                updateSetting('extra', 'tgChatId', e.target.value);
              }}
              placeholder="-100123456789"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('settings_tg_api_base')}
              value={settings.extra.tgApiBase}
              onChange={(e) => {
                updateSetting('extra', 'tgApiBase', e.target.value);
              }}
              placeholder="https://api.telegram.org"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('settings_tg_upload_limit')}
              value={settings.extra.tgFileUploadLimitMb}
              onChange={(e) => {
                updateSetting('extra', 'tgFileUploadLimitMb', Number(e.target.value) || 50);
              }}
              type="number"
              min={1}
              max={2000}
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">{t('settings_tg_upload_limit_note')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Checkbox
                label={t('settings_tg_started')}
                checked={settings.extra.tgEventStarted}
                onChange={(v) => {
                  updateSetting('extra', 'tgEventStarted', v);
                }}
              />
              <Checkbox
                label={t('settings_tg_completed')}
                checked={settings.extra.tgEventCompleted}
                onChange={(v) => {
                  updateSetting('extra', 'tgEventCompleted', v);
                }}
              />
              <Checkbox
                label={t('settings_tg_failed')}
                checked={settings.extra.tgEventFailed}
                onChange={(v) => {
                  updateSetting('extra', 'tgEventFailed', v);
                }}
              />
              <Checkbox
                label={t('settings_tg_queue_completed')}
                checked={settings.extra.tgEventQueueCompleted}
                onChange={(v) => {
                  updateSetting('extra', 'tgEventQueueCompleted', v);
                }}
              />
            </div>
            <FormRow label={t('settings_tg_remote_control')}>
              <Switch
                checked={settings.extra.tgFullControl}
                onChange={(v) => {
                  updateSetting('extra', 'tgFullControl', v);
                }}
              />
            </FormRow>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void handleTestTelegram();
                }}
                className="px-3 py-1.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded text-xs font-bold hover:bg-blue-500/20 transition-all cursor-pointer flex items-center gap-1.5"
              >
                <Send className="w-3.5 h-3.5" /> {t('settings_tg_send_test')}
              </button>
              {telegramStatus === 'ok' && (
                <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded text-[10px] font-bold">
                  {t('settings_tg_healthy')}
                </span>
              )}
              {telegramStatus === 'fail' && (
                <span className="bg-rose-500/10 border border-rose-500/20 text-rose-400 px-2 py-0.5 rounded text-[10px] font-bold">
                  {t('settings_tg_missing')}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {activeSubTab === 'webhooks' && (
        <div className="space-y-4">
          <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
            <div className="flex items-center gap-2">
              <Link className="w-4 h-4 text-blue-400" />
              <span className="text-[11px] font-extrabold text-blue-400">{t('settings_webhook_endpoints')}</span>
            </div>
            <FormRow label={t('settings_enable_webhook')}>
              <Switch
                checked={settings.extra.webhookActive}
                onChange={(v) => {
                  updateSetting('extra', 'webhookActive', v);
                }}
              />
            </FormRow>
            <div className="flex gap-2">
              <input
                value={webhookUrl}
                onChange={(e) => {
                  setWebhookUrl(e.target.value);
                }}
                placeholder="https://api.example.com/webhook"
                className="flex-1 bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2.5 py-1.5 text-xs font-mono text-left"
                style={{ direction: 'ltr' }}
              />
              <button
                type="button"
                onClick={handleAddWebhook}
                className="px-3 py-1.5 bg-[var(--accent-primary)] text-white rounded text-xs font-bold flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" /> {t('settings_webhook_add')}
              </button>
            </div>
            <div className="border border-[var(--border-color)] rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-[var(--bg-sidebar)] text-[var(--text-secondary)]">
                  <tr>
                    <th className="p-2 text-left">{t('settings_webhook_url')}</th>
                    <th className="p-2 text-left">{t('settings_webhook_event')}</th>
                    <th className="p-2 text-center">{t('settings_webhook_status')}</th>
                    <th className="p-2 text-center w-12">{t('settings_webhook_action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {webhooks.map((item) => (
                    <tr key={item.id} className="border-t border-[var(--border-color)]">
                      <td className="p-2 font-mono text-[10px] truncate max-w-[240px]">{item.url}</td>
                      <td className="p-2">{item.event}</td>
                      <td className="p-2 text-center">
                        {item.active ? t('settings_webhook_active') : t('settings_webhook_paused')}
                      </td>
                      <td className="p-2 text-center">
                        <button
                          type="button"
                          onClick={() => {
                            removeWebhook(item.id);
                          }}
                          className="text-red-400 hover:text-red-300"
                          aria-label={t('settings_webhook_remove')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {webhooks.length === 0 && (
                    <tr>
                      <td colSpan={4} className="p-4 text-center text-slate-400 italic">
                        {t('settings_webhook_empty')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeSubTab === 'smtp' && (
        <div className="space-y-4">
          <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
            <div className="flex items-center gap-2">
              <Mail className="w-4 h-4 text-blue-400" />
              <span className="text-[11px] font-extrabold text-blue-400">{t('settings_smtp_alerts')}</span>
            </div>
            <FormRow label={t('settings_enable_email')}>
              <Switch
                checked={settings.extra.smtpActive}
                onChange={(v) => {
                  updateSetting('extra', 'smtpActive', v);
                }}
              />
            </FormRow>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <TextField
                label={t('settings_smtp_host')}
                value={settings.extra.smtpHost}
                onChange={(e) => {
                  updateSetting('extra', 'smtpHost', e.target.value);
                }}
                style={{ direction: 'ltr', textAlign: 'left' }}
              />
              <TextField
                label={t('settings_smtp_port')}
                value={settings.extra.smtpPort}
                onChange={(e) => {
                  updateSetting('extra', 'smtpPort', e.target.value);
                }}
                style={{ direction: 'ltr', textAlign: 'left' }}
              />
              <TextField
                label={t('settings_smtp_user')}
                value={settings.extra.smtpUser}
                onChange={(e) => {
                  updateSetting('extra', 'smtpUser', e.target.value);
                }}
                style={{ direction: 'ltr', textAlign: 'left' }}
              />
              <TextField
                label={t('settings_smtp_pass')}
                type="password"
                value={settings.extra.smtpPass}
                onChange={(e) => {
                  updateSetting('extra', 'smtpPass', e.target.value);
                }}
                style={{ direction: 'ltr', textAlign: 'left' }}
              />
            </div>
            <button
              type="button"
              onClick={() => {
                onAddToast('success', t('settings_toast_smtp_test'), t('settings_toast_smtp_queued'));
              }}
              className="px-3 py-1.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded text-xs font-bold hover:bg-blue-500/20 transition-all cursor-pointer"
            >
              {t('settings_send_test_email')}
            </button>
          </div>
        </div>
      )}

      {activeSubTab === 'rules' && (
        <div className="space-y-4">
          <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              <span className="text-[11px] font-extrabold text-amber-400">{t('settings_automation_rules')}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                onAddToast('info', t('settings_automation_rules'), t('settings_toast_rules_editor'));
              }}
              className="px-3 py-1.5 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded text-xs font-bold hover:bg-amber-500/20 transition-all cursor-pointer"
            >
              {t('settings_add_rule')}
            </button>
            <div className="space-y-2">
              <div className="bg-[var(--bg-input)]/50 border border-[var(--border-color)] rounded-lg p-3">
                <span className="text-xs font-extrabold text-slate-100">Rule: Organize large videos</span>
                <p className="text-[11px] text-slate-400 mt-1">
                  If size is greater than 500 MB and type is video, move the file to /Videos/Large/ and send a
                  notification.
                </p>
                <span className="inline-block mt-2 bg-amber-500/15 border border-amber-500/30 text-amber-500 text-[9px] font-bold px-1.5 py-0.5 rounded">
                  {t('settings_webhook_active')}
                </span>
              </div>
              <div className="bg-[var(--bg-input)]/50 border border-[var(--border-color)] rounded-lg p-3">
                <span className="text-xs font-extrabold text-slate-100">Rule: Critical failure alerts</span>
                <p className="text-[11px] text-slate-400 mt-1">
                  If a download fails three times, run an external recovery command.
                </p>
                <span className="inline-block mt-2 bg-slate-500/15 border border-slate-500/30 text-slate-400 text-[9px] font-bold px-1.5 py-0.5 rounded">
                  {t('settings_webhook_paused')}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
