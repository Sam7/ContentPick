import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getBridge } from './bridge';
import './app.css';

const { bridge, fixtureMode } = getBridge();
const root = document.getElementById('root');

if (!root) throw new Error('The application root element is missing.');

createRoot(root).render(<StrictMode><App bridge={bridge} fixtureMode={fixtureMode} /></StrictMode>);
