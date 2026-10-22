#!/usr/bin/env node
'use strict';

/**
 * systemd *user* service manager for AI Voice Desk.
 *
 * Usage:
 *   node scripts/service.js install     # create + enable + start the unit
 *   node scripts/service.js uninstall   # stop + disable + remove the unit
 *   node scripts/service.js status      # show current status
 *   node scripts/service.js restart     # restart the service
 *   node scripts/service.js logs        # follow the journal
 *
 * The unit runs as the current user, so no root privileges are required.
 * For the service to start at boot while you are logged out, enable lingering:
 *   sudo loginctl enable-linger "$USER"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const SERVICE_NAME = 'ai-voice-desk.service';
const UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const UNIT_PATH = path.join(UNIT_DIR, SERVICE_NAME);
const NODE_BIN = process.execPath;

function which(cmd) {
  const res = spawnSync('command', ['-v', cmd], { shell: true, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : '';
}

function systemctl(args, { inherit = true } = {}) {
  return spawnSync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe'
  });
}

function assertSystemd() {
  if (os.platform() !== 'linux') {
    fail('systemd services are only supported on Linux.');
  }
  if (!which('systemctl')) {
    fail('systemctl was not found. Install systemd or run the app manually with `npm start`.');
  }
}

function fail(message) {
  console.error('Error: ' + message);
  process.exit(1);
}

function unitFile() {
  const envFile = path.join(PROJECT_DIR, '.env');
  const lines = [
    '[Unit]',
    'Description=AI Voice Desk - browser voice assistant',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${PROJECT_DIR}`,
    `ExecStart=${NODE_BIN} ${path.join(PROJECT_DIR, 'server.js')}`,
    `EnvironmentFile=-${envFile}`,
    'Environment=NODE_ENV=production',
    'Restart=on-failure',
    'RestartSec=3',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=10',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ];
  return lines.join('\n');
}

function install() {
  assertSystemd();
  fs.mkdirSync(UNIT_DIR, { recursive: true });

  if (fs.existsSync(UNIT_PATH)) {
    const backup = `${UNIT_PATH}.bak-${Date.now()}`;
    fs.copyFileSync(UNIT_PATH, backup);
    console.log(`Existing unit backed up to ${backup}`);
  }

  fs.writeFileSync(UNIT_PATH, unitFile(), { mode: 0o644 });
  console.log(`Wrote ${UNIT_PATH}`);

  systemctl(['daemon-reload']);
  systemctl(['enable', '--now', SERVICE_NAME]);
  console.log('');
  console.log('AI Voice Desk service installed and started.');
  console.log('  Status:  systemctl --user status ' + SERVICE_NAME);
  console.log('  Logs:    journalctl --user -u ' + SERVICE_NAME + ' -f');
  console.log('  Stop:    systemctl --user stop ' + SERVICE_NAME);
  console.log('  Remove:  npm run service:uninstall');
  console.log('');
  console.log('To keep the service running after logout, run:');
  console.log('  sudo loginctl enable-linger "$USER"');
}

function uninstall() {
  assertSystemd();
  systemctl(['stop', SERVICE_NAME]);
  systemctl(['disable', SERVICE_NAME]);
  if (fs.existsSync(UNIT_PATH)) {
    fs.unlinkSync(UNIT_PATH);
    console.log(`Removed ${UNIT_PATH}`);
  }
  systemctl(['daemon-reload']);
  console.log('AI Voice Desk service uninstalled.');
}

function status() {
  assertSystemd();
  systemctl(['status', SERVICE_NAME, '--no-pager']);
}

function restart() {
  assertSystemd();
  systemctl(['daemon-reload']);
  systemctl(['restart', SERVICE_NAME]);
  console.log('Service restarted.');
}

function logs() {
  assertSystemd();
  spawnSync('journalctl', ['--user', '-u', SERVICE_NAME, '-f', '-n', '50'], { stdio: 'inherit' });
}

const command = process.argv[2] || 'status';
switch (command) {
  case 'install': install(); break;
  case 'uninstall': uninstall(); break;
  case 'status': status(); break;
  case 'restart': restart(); break;
  case 'logs': logs(); break;
  default:
    console.log('Usage: node scripts/service.js {install|uninstall|status|restart|logs}');
    process.exit(1);
}
