/* src/dialogs/DialogRoot.tsx */
import React from 'react';
import { useAppStore } from '../state/appStore';
import { Modal } from './Modal';

// Sub-dialogs imports
import { AddDownloadDialog } from './download/AddDownloadDialog';
import { BatchImportDialog } from './download/BatchImportDialog';
import { SettingsDialog } from './settings/SettingsDialog';
import { DiagnosticsDialog } from './diagnostics/DiagnosticsDialog';
import { TaskPropertiesDialog } from './tasks/TaskPropertiesDialog';
import { ActiveProgressDialog } from './download/ActiveProgressDialog';
import { AboutDialog } from './system/AboutDialog';
import { BrowserIntegrationDialog } from './integration/BrowserIntegrationDialog';
import { ConfirmDialog } from './common/ConfirmDialog';
import { SchedulerPanel } from '../components/SchedulerPanel';
import { UpdateLinkDialog } from './tasks/UpdateLinkDialog';
import { AddToQueueDialog } from './download/AddToQueueDialog';
import { WebpageGrabberDialog } from './download/WebpageGrabberDialog';
import { YoutubeDownloadDialog } from './download/YoutubeDownloadDialog';
import { GenericConfirmDialog } from './common/GenericConfirmDialog';

export default function DialogRoot() {
    const { dialog, closeDialog, tasks, t } = useAppStore();

  if (!dialog.active) return null;

  // Render correct title, size and component based on router state
  let title = '';
  let size: 'sm' | 'md' | 'lg' | 'xl' | 'full' = 'md';
  let childComponent: React.ReactNode = null;

  switch (dialog.active) {
    case 'addDownload':
      title = t('action_add');
      size = 'lg';
      childComponent = <AddDownloadDialog />;
      break;
    case 'webpageGrabber':
      title = 'Webpage Grabber & Offline Reader';
      size = 'lg';
      childComponent = <WebpageGrabberDialog />;
      break;
    case 'youtubeDownload':
      title = 'Media Downloader';
      size = 'lg';
      childComponent = <YoutubeDownloadDialog />;
      break;
    case 'batchDownload':
      title = t('action_add_batch');
      size = 'lg';
      childComponent = <BatchImportDialog />;
      break;
    case 'settings':
      title = t('nav_settings');
      size = 'xl';
      childComponent = <SettingsDialog />;
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
    case 'addToQueue':
      title = t('action_add_queue');
      size = 'md';
      childComponent = <AddToQueueDialog />;
      break;
    case 'activeProgress':
      {
        const taskPayload = dialog.payload;
        const currentTask = tasks.find(t => t.id === taskPayload?.id) || taskPayload;
        if (currentTask) {
          const progressPercent = currentTask.sizeBytes > 0 ? Math.round((currentTask.downloadedBytes / currentTask.sizeBytes) * 100) : 0;
          title = `${progressPercent}%-${currentTask.name}`;
        } else {
          title = t('nav_properties');
        }
      }
      size = 'lg';
      childComponent = <ActiveProgressDialog />;
      break;
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
    case 'scheduler':
      title = t('nav_queues');
      size = 'xl';
      childComponent = <SchedulerPanel />;
      break;
    default:
      return null;
  }

  return (
    <Modal 
      isOpen={!!dialog.active} 
      onClose={closeDialog} 
      title={title} 
      size={size}
      id={dialog.active === 'activeProgress' ? 'active-progress-modal' : undefined}
    >
      {childComponent}
    </Modal>
  );
}
