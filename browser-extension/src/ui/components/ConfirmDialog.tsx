import React from 'react';

export type ConfirmDialogTone = 'neutral' | 'danger' | 'warning';

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
  details?: React.ReactNode;
  onConfirm(): void;
  onCancel(): void;
};

export function ConfirmDialog({ open, title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'neutral', details, onConfirm, onCancel }: ConfirmDialogProps) {
  if (!open) return null;
  return <div className="nova-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="nova-dialog" role="dialog" aria-modal="true" aria-labelledby="nova-dialog-title" aria-describedby="nova-dialog-description" data-tone={tone}>
      <header className="nova-dialog-header">
        <div className="nova-dialog-icon" aria-hidden="true">!</div>
        <div>
          <h2 id="nova-dialog-title">{title}</h2>
          <p id="nova-dialog-description">{description}</p>
        </div>
      </header>
      {details ? <div className="nova-dialog-details">{details}</div> : null}
      <footer className="nova-dialog-actions">
        <button type="button" onClick={onCancel}>{cancelLabel}</button>
        <button type="button" data-variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</button>
      </footer>
    </section>
  </div>;
}

export default ConfirmDialog;
