import React, { useState } from 'react';
import ConfirmDialog from '../components/ConfirmDialog';
import DetailGrid from '../components/DetailGrid';
import { useI18n } from '../../i18n/react';
import type { TranslateFunction } from '../../i18n';

export type TaskSummary = Record<string, unknown>;

function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function taskId(task: TaskSummary): string {
  return text(task.id ?? task.taskId ?? task.gid ?? task.uuid);
}

function taskTitle(task: TaskSummary, t: TranslateFunction): string {
  return text(task.name ?? task.filename ?? task.title ?? task.url, t('taskList.task.unnamed'));
}

function taskState(task: TaskSummary, t: TranslateFunction): string {
  return text(task.status ?? task.state ?? task.phase, t('taskList.task.stateUnknown'));
}

function taskProgress(task: TaskSummary): number | undefined {
  const raw = numberValue(task.progress ?? task.percent ?? task.percentage);
  if (raw === undefined) return undefined;
  return Math.max(0, Math.min(100, raw > 1 ? raw : raw * 100));
}

function taskTone(state: string): 'success' | 'warning' | 'danger' | 'info' {
  const normalized = state.toLowerCase();
  if (/complete|finished|done|success/.test(normalized)) return 'success';
  if (/error|failed|cancel/.test(normalized)) return 'danger';
  if (/pause|queued|waiting/.test(normalized)) return 'warning';
  return 'info';
}

// Task details, Cancel NOVA task?
export function TaskList({ tasks, onRefresh, onPause, onResume, onCancel }: { tasks: TaskSummary[]; onRefresh(): void; onPause(taskId: string): void; onResume(taskId: string): void; onCancel(taskId: string): void }) {
  const [cancelTarget, setCancelTarget] = useState<{ id: string; title: string }>();
  const { t } = useI18n();
  return <section className="nova-card" aria-label={t('taskList.aria')}>
    <div className="nova-card-header">
      <div>
        <h2 className="nova-card-title">{t('taskList.title')}</h2>
        <p className="nova-card-description">{t('taskList.help')}</p>
      </div>
      <button onClick={onRefresh}>{t('taskList.refresh')}</button>
    </div>
    {tasks.length === 0 ? <div className="nova-empty">
      <strong>{t('taskList.empty.title')}</strong>
      <p>{t('taskList.empty.help')}</p>
    </div> : <div className="nova-task-list">
      {tasks.slice(0, 8).map((task, index) => {
        const id = taskId(task);
        const title = taskTitle(task, t);
        const state = taskState(task, t);
        const progress = taskProgress(task);
        return <article key={id || index} className="nova-task">
          <div className="nova-task-headline">
            <strong className="nova-task-title" title={title}>{title}</strong>
            <span className="nova-pill" data-tone={taskTone(state)}>{state}</span>
          </div>
          {progress !== undefined ? <div className="nova-progress" aria-label={t('taskList.task.progress', { percent: Math.round(progress) })}><span style={{ width: `${progress}%` }} /></div> : null}
          <span className="nova-task-meta">{id ? `id: ${id}` : t('taskList.task.noId')}{progress !== undefined ? ` · ${Math.round(progress)}%` : ''}</span>
          <details className="nova-candidate-details">
            <summary>{t('taskList.task.details')}</summary>
            <DetailGrid items={[
              { label: t('taskList.task.id'), value: id },
              { label: t('taskList.task.state'), value: state },
              { label: t('taskList.task.url'), value: text(task.url) },
              { label: t('taskList.task.size'), value: text(task.size ?? task.totalBytes ?? task.length) },
              { label: t('taskList.task.speed'), value: text(task.speed ?? task.rate) },
              { label: t('taskList.task.eta'), value: text(task.eta ?? task.remaining) },
            ]} />
          </details>
          {id ? <div className="nova-toolbar">
            <button onClick={() => onPause(id)}>{t('taskList.pause')}</button>
            <button onClick={() => onResume(id)}>{t('taskList.resume')}</button>
            <button data-variant="danger" onClick={() => setCancelTarget({ id, title })}>{t('taskList.cancel')}</button>
          </div> : null}
        </article>;
      })}
    </div>}
    <ConfirmDialog
      open={Boolean(cancelTarget)}
      tone="danger"
      title={t('taskList.cancelConfirm.title')}
      description={cancelTarget ? t('taskList.cancelConfirm.description', { title: cancelTarget.title }) : t('taskList.cancelConfirm.defaultDescription')}
      confirmLabel={t('taskList.cancelConfirm.label')}
      onCancel={() => setCancelTarget(undefined)}
      onConfirm={() => {
        if (cancelTarget) onCancel(cancelTarget.id);
        setCancelTarget(undefined);
      }}
    />
  </section>;
}

export default TaskList;
