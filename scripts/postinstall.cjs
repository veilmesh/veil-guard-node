const { exec } = require('child_process');
exec('veil-guard --version', (err) => {
  if (err) {
    console.warn('[veil-guard] Warning: "veil-guard" CLI binary was not found in your PATH.');
    console.warn('[veil-guard] Please make sure it is installed and available before signing.');
  }
});
