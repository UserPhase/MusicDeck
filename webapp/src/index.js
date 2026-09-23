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
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
