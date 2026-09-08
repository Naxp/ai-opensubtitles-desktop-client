'use strict';

const { spawn } = require('child_process');
const electronPath = require('electron');

const args = [
  'dist/main/main.js',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-gpu-sandbox',
];

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development' },
});

child.on('error', (error) => {
  console.error('Failed to start Electron:', error);
  process.exitCode = 1;
});

child.on('exit', (code) => {
  process.exit(code === null ? 1 : code);
});
