import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { I18nProvider, ThemeProvider } from './i18n.js';
import './styles.css';

const root = document.getElementById('root');
if (root) createRoot(root).render(
  <ThemeProvider>
    <I18nProvider>
      <App />
    </I18nProvider>
  </ThemeProvider>,
);
