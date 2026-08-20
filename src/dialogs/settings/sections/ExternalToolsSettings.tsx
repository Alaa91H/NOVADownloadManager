/* src/dialogs/settings/sections/ExternalToolsSettings.tsx */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Package, CheckCircle, Download, Trash2, FolderSearch, RefreshCw, AlertCircle } from 'lucide-react';
import { novaClient } from '../../../api/novaClient';
import { extractErrorMessage } from '../../../utils/formatUtils';

interface ExternalTool {
  id: string;
  name: string;
  status: string;
  version?: string;
  path?: string;
  capabilities: Array<{ id: string; name: string; available: boolean }>;
  healthOk: boolean;
  installedByApp: boolean;
  customPath: boolean;
  error?: string;
}

interface Props {
  onAddToast: (type: 'success' | 'error' | 'warning' | 'info', title: string, msg: string) => void;
}

export const ExternalToolsSettings: React.FC<Props> = ({ onAddToast }) => {
  const [tools, setTools] = useState<ExternalTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionStates, setActionStates] = useState<Record<string, string>>({});
  const [customPaths, setCustomPaths] = useState<Record<string, string>>({});
  const [updateInfo, setUpdateInfo] = useState<
    Record<string, { available: boolean; latestVersion?: string } | undefined>
  >({});
  const supportsSystemInstall = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

  const loadTools = useCallback(async () => {
    setLoading(true);
    try {
      const result = await novaClient.listExternalTools();
      setTools(result.tools);
    } catch (error) {
      onAddToast('error', 'External Tools', extractErrorMessage(error, 'Failed to load external tools.'));
    } finally {
      setLoading(false);
    }
  }, [onAddToast]);

  const loadToolsRef = useRef(loadTools);
  useEffect(() => {
    loadToolsRef.current = loadTools;
  });
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    void loadToolsRef.current();
  }, []);

  const setAction = (toolId: string, action: string) => {
    setActionStates((prev) => ({ ...prev, [`${toolId}:${action}`]: 'running' }));
  };
  const clearAction = (toolId: string, action: string) => {
    setActionStates((prev) => {
      const key = `${toolId}:${action}`;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };
  const isActionRunning = (toolId: string, action: string) => actionStates[`${toolId}:${action}`] === 'running';

  const handleDiscover = async (toolId: string) => {
    setAction(toolId, 'discover');
    try {
      const result = await novaClient.discoverExternalTool(toolId);
      if (result.ok) {
        onAddToast('success', 'Discover', `${toolId} discovered: ${result.version || 'unknown version'}`);
        await loadTools();
      } else {
        onAddToast('warning', 'Discover', `${toolId} not found on the system.`);
      }
    } catch (error) {
      onAddToast('error', 'Discover', extractErrorMessage(error, 'Discovery failed.'));
    } finally {
      clearAction(toolId, 'discover');
    }
  };

  const handleHealthCheck = async (toolId: string) => {
    setAction(toolId, 'health');
    try {
      const result = await novaClient.checkExternalToolHealth(toolId);
      if (result.ok) {
        onAddToast('success', 'Health Check', `${toolId} is healthy.`);
      } else {
        onAddToast('warning', 'Health Check', `${toolId}: ${result.error || 'unhealthy'}`);
      }
      await loadTools();
    } catch (error) {
      onAddToast('error', 'Health Check', extractErrorMessage(error, 'Health check failed.'));
    } finally {
      clearAction(toolId, 'health');
    }
  };

  const handleCheckUpdates = async (toolId: string) => {
    setAction(toolId, 'updates');
    try {
      const result = await novaClient.checkExternalToolUpdates(toolId);
      setUpdateInfo((prev) => ({
        ...prev,
        [toolId]: { available: result.available, latestVersion: result.latestVersion },
      }));
      if (result.available) {
        onAddToast('info', 'Updates', `Update available for ${toolId}: ${result.latestVersion ?? ''}`);
      } else {
        onAddToast('success', 'Updates', `${toolId} is up to date.`);
      }
    } catch (error) {
      onAddToast('error', 'Updates', extractErrorMessage(error, 'Update check failed.'));
    } finally {
      clearAction(toolId, 'updates');
    }
  };

  const handleInstall = async (toolId: string, scope: 'user' | 'system' = 'user') => {
    const action = scope === 'system' ? 'install-system' : 'install';
    setAction(toolId, action);
    try {
      const result = await novaClient.installExternalTool(toolId, scope);
      if (result.ok) {
        const destination = result.path ? ` at ${result.path}` : '';
        onAddToast('success', 'Install verified', `${toolId} was downloaded, verified, and activated${destination}.`);
        setUpdateInfo((prev) => ({ ...prev, [toolId]: { available: false } }));
        await loadTools();
      } else {
        onAddToast('error', 'Install', result.error || 'Installation failed.');
      }
    } catch (error) {
      onAddToast('error', 'Install', extractErrorMessage(error, 'Installation failed.'));
    } finally {
      clearAction(toolId, action);
    }
  };

  const handleUpdate = async (toolId: string) => {
    setAction(toolId, 'update');
    try {
      const result = await novaClient.updateExternalTool(toolId);
      if (result.ok) {
        onAddToast('success', 'Update', `${toolId} updated successfully.`);
        setUpdateInfo((prev) => ({ ...prev, [toolId]: { available: false } }));
        await loadTools();
      } else {
        onAddToast('error', 'Update', result.error || 'Update failed.');
      }
    } catch (error) {
      onAddToast('error', 'Update', extractErrorMessage(error, 'Update failed.'));
    } finally {
      clearAction(toolId, 'update');
    }
  };

  const handleSetPath = async (toolId: string) => {
    const path = customPaths[toolId];
    if (!path.trim()) {
      onAddToast('warning', 'Set Path', 'Enter a path first.');
      return;
    }
    setAction(toolId, 'setpath');
    try {
      const result = await novaClient.setExternalToolPath(toolId, path.trim());
      if (result.ok) {
        onAddToast('success', 'Set Path', `${toolId} path updated.`);
        await loadTools();
      } else {
        onAddToast('error', 'Set Path', result.error || 'Failed to set path.');
      }
    } catch (error) {
      onAddToast('error', 'Set Path', extractErrorMessage(error, 'Failed to set path.'));
    } finally {
      clearAction(toolId, 'setpath');
    }
  };

  const handleUninstall = async (toolId: string) => {
    setAction(toolId, 'uninstall');
    try {
      const result = await novaClient.uninstallExternalTool(toolId);
      if (result.ok) {
        onAddToast('success', 'Uninstall', `${toolId} uninstalled.`);
        await loadTools();
      } else {
        onAddToast('error', 'Uninstall', result.error || 'Uninstall failed.');
      }
    } catch (error) {
      onAddToast('error', 'Uninstall', extractErrorMessage(error, 'Uninstall failed.'));
    } finally {
      clearAction(toolId, 'uninstall');
    }
  };

  const handleHealthCheckAll = async () => {
    setAction('all', 'healthall');
    try {
      await Promise.allSettled(tools.map((tool) => novaClient.checkExternalToolHealth(tool.id)));
      onAddToast('success', 'Health Check', 'Health check completed for all tools.');
      await loadTools();
    } catch (error) {
      onAddToast('error', 'Health Check', extractErrorMessage(error, 'Health check failed.'));
    } finally {
      clearAction('all', 'healthall');
    }
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Package className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-extrabold text-[var(--accent-primary)]">External Tools</h3>
          <button
            type="button"
            onClick={() => {
              void handleHealthCheckAll();
            }}
            disabled={isActionRunning('all', 'healthall') || tools.length === 0}
            className="ml-auto px-2 py-1 bg-[var(--bg-hover)] border border-[var(--border-color)] text-[var(--text-secondary)] rounded text-[10px] font-bold hover:bg-[var(--bg-hover)] transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50"
          >
            {isActionRunning('all', 'healthall') && <RefreshCw className="w-3 h-3 animate-spin" />}
            Health Check All
          </button>
        </div>

        {loading && (
          <div className="flex items-center gap-2 p-4 text-[var(--text-muted)]">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span className="text-xs font-bold">Loading tools...</span>
          </div>
        )}

        {!loading && tools.length === 0 && (
          <div className="flex items-center gap-2 p-4 text-[var(--text-muted)]">
            <AlertCircle className="w-4 h-4" />
            <span className="text-xs font-bold">No external tools found.</span>
          </div>
        )}

        {tools.map((tool) => (
          <div
            key={tool.id}
            className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3"
          >
            <div className="flex items-center gap-3">
              <Package className="w-4 h-4 text-[var(--accent-primary)]" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-extrabold text-[var(--text-primary)]">{tool.name}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                      tool.healthOk
                        ? 'bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success)]'
                        : tool.status === 'unknown'
                          ? 'bg-[var(--bg-hover)] border border-[var(--border-color)] text-[var(--text-muted)]'
                          : 'bg-[var(--danger-bg)] border border-[var(--danger-border)] text-[var(--danger)]'
                    }`}
                  >
                    {tool.healthOk ? 'Healthy' : tool.status}
                  </span>
                </div>
                {tool.version && (
                  <span className="text-[10px] font-mono text-[var(--text-muted)] block">v{tool.version}</span>
                )}
                {tool.path && (
                  <span className="text-[10px] font-mono text-[var(--text-muted)] block truncate" title={tool.path}>
                    {tool.path}
                  </span>
                )}
                {tool.healthOk && (
                  <span className="text-[9px] font-bold text-[var(--text-muted)] block">
                    {tool.installedByApp ? 'Managed by NOVA' : tool.customPath ? 'Custom path' : 'System installation'}
                  </span>
                )}
                {tool.error && <span className="text-[10px] font-mono text-[var(--danger)] block">{tool.error}</span>}
              </div>
            </div>

            {tool.capabilities.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {tool.capabilities.map((cap) => (
                  <span
                    key={cap.id}
                    className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold ${
                      cap.available
                        ? 'bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success)]'
                        : 'bg-[var(--bg-hover)] border border-[var(--border-color)] text-[var(--text-muted)] line-through'
                    }`}
                  >
                    {cap.name}
                  </span>
                ))}
              </div>
            )}

            {/* Update info */}
            {updateInfo[tool.id]?.available && (
              <div className="flex items-center gap-2 p-2 bg-[var(--info-bg)] border border-[var(--info-border)] rounded">
                <Download className="w-3.5 h-3.5 text-[var(--info)]" />
                <span className="text-[10px] font-bold text-[var(--info)]">
                  Update available: v{updateInfo[tool.id]?.latestVersion}
                </span>
                <button
                  type="button"
                  onClick={() => void handleUpdate(tool.id)}
                  disabled={isActionRunning(tool.id, 'update')}
                  className="ml-auto px-2 py-1 bg-[var(--info)] text-white rounded text-[10px] font-bold hover:opacity-80 transition-all cursor-pointer disabled:opacity-50"
                >
                  {isActionRunning(tool.id, 'update') ? 'Updating...' : 'Update'}
                </button>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-1.5 pt-2 border-t border-[var(--border-color)]/50">
              {!tool.healthOk && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleInstall(tool.id, 'user')}
                    disabled={isActionRunning(tool.id, 'install') || isActionRunning(tool.id, 'install-system')}
                    className="px-2 py-1 bg-[var(--accent-primary)]/10 border border-[var(--accent-border)] text-[var(--accent-primary)] rounded text-[10px] font-bold hover:bg-[var(--accent-primary)]/20 transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50"
                    title="Download from the approved upstream source, verify SHA-256, validate the executable, and activate it for this user."
                  >
                    {isActionRunning(tool.id, 'install') ? (
                      <RefreshCw className="w-3 h-3 animate-spin" />
                    ) : (
                      <Download className="w-3 h-3" />
                    )}
                    Install for Current User
                  </button>
                  {supportsSystemInstall && (
                    <button
                      type="button"
                      onClick={() => void handleInstall(tool.id, 'system')}
                      disabled={isActionRunning(tool.id, 'install') || isActionRunning(tool.id, 'install-system')}
                      className="px-2 py-1 bg-[var(--bg-hover)] border border-[var(--border-color)] text-[var(--text-secondary)] rounded text-[10px] font-bold hover:bg-[var(--border-color)]/20 transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50"
                      title="Install under Program Files. Windows will request administrator approval after NOVA verifies the downloaded binary."
                    >
                      {isActionRunning(tool.id, 'install-system') ? (
                        <RefreshCw className="w-3 h-3 animate-spin" />
                      ) : (
                        <Package className="w-3 h-3" />
                      )}
                      Install to Program Files
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => void handleDiscover(tool.id)}
                disabled={isActionRunning(tool.id, 'discover')}
                className="px-2 py-1 bg-[var(--bg-hover)] border border-[var(--border-color)] text-[var(--text-secondary)] rounded text-[10px] font-bold hover:bg-[var(--border-color)]/20 transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50"
              >
                {isActionRunning(tool.id, 'discover') ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <FolderSearch className="w-3 h-3" />
                )}
                Discover
              </button>
              <button
                type="button"
                onClick={() => void handleHealthCheck(tool.id)}
                disabled={isActionRunning(tool.id, 'health')}
                className="px-2 py-1 bg-[var(--bg-hover)] border border-[var(--border-color)] text-[var(--text-secondary)] rounded text-[10px] font-bold hover:bg-[var(--border-color)]/20 transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50"
              >
                {isActionRunning(tool.id, 'health') ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <CheckCircle className="w-3 h-3" />
                )}
                Health Check
              </button>
              <button
                type="button"
                onClick={() => void handleCheckUpdates(tool.id)}
                disabled={isActionRunning(tool.id, 'updates')}
                className="px-2 py-1 bg-[var(--bg-hover)] border border-[var(--border-color)] text-[var(--text-secondary)] rounded text-[10px] font-bold hover:bg-[var(--border-color)]/20 transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50"
              >
                {isActionRunning(tool.id, 'updates') ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <Download className="w-3 h-3" />
                )}
                Check Updates
              </button>
              {tool.installedByApp && (
                <button
                  type="button"
                  onClick={() => void handleUninstall(tool.id)}
                  disabled={isActionRunning(tool.id, 'uninstall')}
                  className="px-2 py-1 bg-[var(--danger-bg)] border border-[var(--danger-border)] text-[var(--danger)] rounded text-[10px] font-bold hover:bg-[var(--danger-bg)] transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50"
                >
                  {isActionRunning(tool.id, 'uninstall') ? (
                    <RefreshCw className="w-3 h-3 animate-spin" />
                  ) : (
                    <Trash2 className="w-3 h-3" />
                  )}
                  Uninstall
                </button>
              )}
            </div>

            {/* Custom path */}
            <div className="flex gap-1.5 items-end pt-2 border-t border-[var(--border-color)]/50">
              <div className="flex-1">
                <label className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-wide block mb-1">
                  Custom Path
                </label>
                <input
                  type="text"
                  value={customPaths[tool.id] || ''}
                  onChange={(e) => {
                    setCustomPaths((prev) => ({ ...prev, [tool.id]: e.target.value }));
                  }}
                  placeholder="Enter custom path to binary"
                  className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1.5 text-[10px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent-primary)] focus:outline-none"
                  style={{ direction: 'ltr', textAlign: 'left' }}
                />
              </div>
              <button
                type="button"
                onClick={() => void handleSetPath(tool.id)}
                disabled={isActionRunning(tool.id, 'setpath') || !(customPaths[tool.id] || '').trim()}
                className="px-2 py-1.5 bg-[var(--accent-primary)]/10 border border-[var(--accent-border)] text-[var(--accent-primary)] rounded text-[10px] font-bold hover:bg-[var(--accent-primary)]/20 transition-all cursor-pointer disabled:opacity-50 shrink-0"
              >
                {isActionRunning(tool.id, 'setpath') ? 'Setting...' : 'Set Path'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
