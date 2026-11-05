import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/catalog.css';
import './styles/artist-avatar.css';
import './styles/explore.css';
import './styles/detail-pages.css';
import './styles/player.css';
import './styles/tracks.css';
import './styles/topbar.css';
import './styles/admin.css';
import './styles/layout-presets.css';
import './styles/hero.css';
import './styles/glassmorphic.css';
import './styles/tactile.css';
import './styles/theme.css';
import App from './App';
import { installDesktopRuntime } from './services/desktop/desktopRuntime';
import { registerServiceWorker } from './services/serviceWorkerRegistration';

installDesktopRuntime();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

void registerServiceWorker();
