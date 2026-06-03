import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { I18nProvider, ThemeProvider } from './i18n.js';
import { AuthProvider } from './components/AuthGate.js';
import './styles.css';

const root = document.getElementById('root');
if (root) createRoot(root).render(
  <ThemeProvider>
    <I18nProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </I18nProvider>
  </ThemeProvider>,
);
