/* src/dialogs/DialogRoot.tsx */
import React, { lazy, Suspense } from 'react';
import { useDialogData, useDialogActions } from '../store/selectors';
import { useTaskData } from '../store/selectors';
import { useI18n } from '../store/selectors';
import { Modal } from './Modal';

const AddDownloadDialog = lazy(() =>
  import('./download/AddDownloadDialog').then((m) => ({ default: m.AddDownloadDialog })),
);
const DiagnosticsDialog = lazy(() =>
  import('./diagnostics/DiagnosticsDialog').then((m) => ({ default: m.DiagnosticsDialog })),
);
const TaskPropertiesDialog = lazy(() =>
  import('./tasks/TaskPropertiesDialog').then((m) => ({ default: m.TaskPropertiesDialog })),
);
const ActiveProgressDialog = lazy(() =>
  import('./download/ActiveProgressDialog').then((m) => ({ default: m.ActiveProgressDialog })),
);
const AboutDialog = lazy(() => import('./system/AboutDialog').then((m) => ({ default: m.AboutDialog })));
const BrowserIntegrationDialog = lazy(() =>
  import('./integration/BrowserIntegrationDialog').then((m) => ({ default: m.BrowserIntegrationDialog })),
);
const ConfirmDialog = lazy(() => import('./common/ConfirmDialog').then((m) => ({ default: m.ConfirmDialog })));
const UpdateLinkDialog = lazy(() => import('./tasks/UpdateLinkDialog').then((m) => ({ default: m.UpdateLinkDialog })));
const RenameDialog = lazy(() => import('./tasks/RenameDialog').then((m) => ({ default: m.RenameDialog })));
const AddToQueueDialog = lazy(() =>
  import('./download/AddToQueueDialog').then((m) => ({ default: m.AddToQueueDialog })),
);
const GenericConfirmDialog = lazy(() =>
  import('./common/GenericConfirmDialog').then((m) => ({ default: m.GenericConfirmDialog })),
);

const DialogFallback = () => (
  <div className="flex items-center justify-center py-12">
    <div className="w-6 h-6 border-2 border-[var(--accent-primary)] border-t-transparent rounded-full animate-spin" />
  </div>
);

export default function DialogRoot() {
  const { active, payload } = useDialogData();
  const { closeDialog } = useDialogActions();
  const tasks = useTaskData();
  const t = useI18n();

  if (!active) return null;

  let title: string;
  let size: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  let childComponent: React.ReactNode;

  switch (active) {
    case 'addDownload':
      title = t('action_add');
      size = 'lg';
      childComponent = <AddDownloadDialog />;
      break;
    case 'diagnostics':
      title = t('nav_diagnostics');
      size = 'lg';
      childComponent = <DiagnosticsDialog />;
      break;
    case 'taskProperties':
      title = t('nav_properties');
      size = 'lg';
      childComponent = <TaskPropertiesDialog />;
      break;
    case 'updateLink':
      title = t('action_update_link');
      size = 'md';
      childComponent = <UpdateLinkDialog />;
      break;
    case 'renameTask':
      title = t('action_rename');
      size = 'md';
      childComponent = <RenameDialog />;
      break;
    case 'addToQueue':
      title = t('action_add_queue');
      size = 'md';
      childComponent = <AddToQueueDialog />;
      break;
    case 'activeProgress': {
      const taskPayload = payload as
        { id?: string; name?: string; sizeBytes?: number; downloadedBytes?: number } | undefined;
      const currentTask = tasks.find((t) => t.id === taskPayload?.id) || taskPayload;
      if (currentTask) {
        const progressPercent =
          currentTask.sizeBytes && currentTask.sizeBytes > 0
            ? Math.round(((currentTask.downloadedBytes || 0) / currentTask.sizeBytes) * 100)
            : 0;
        title = `${String(progressPercent)}%-${currentTask.name || ''}`;
      } else {
        title = t('nav_properties');
      }
      size = 'lg';
      childComponent = <ActiveProgressDialog />;
      break;
    }
    case 'about':
      title = t('nav_about');
      size = 'md';
      childComponent = <AboutDialog />;
      break;
    case 'browserIntegration':
      title = t('nav_browser_integration');
      size = 'md';
      childComponent = <BrowserIntegrationDialog />;
      break;
    case 'confirmDelete':
      title = t('action_delete');
      size = 'sm';
      childComponent = <ConfirmDialog />;
      break;
    case 'genericConfirm':
      title = t('app_name');
      size = 'md';
      childComponent = <GenericConfirmDialog />;
      break;
    default:
      return null;
  }

  return (
    <Modal
      isOpen={!!active}
      onClose={closeDialog}
      title={title}
      size={size}
      id={active === 'activeProgress' ? 'active-progress-modal' : undefined}
      preventLightDismiss={active === 'activeProgress'}
    >
      <Suspense fallback={<DialogFallback />}>{childComponent}</Suspense>
    </Modal>
  );
}
