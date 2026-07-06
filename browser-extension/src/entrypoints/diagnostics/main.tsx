import React from 'react';
import '../../ui/styles/theme.css';
import { createRoot } from 'react-dom/client';
import { applyDocumentLocale } from '../../i18n';
import { Diagnostics } from '../../ui/diagnostics/Diagnostics';
import ErrorBoundary from '../../ui/components/ErrorBoundary';

applyDocumentLocale();

const root = document.getElementById('root');
if (root) createRoot(root).render(<ErrorBoundary><Diagnostics /></ErrorBoundary>);
