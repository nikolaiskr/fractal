import React from 'react';
import ReactDOM from 'react-dom/client';
import { FractalApp } from './components/FractalApp';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FractalApp />
  </React.StrictMode>,
);
