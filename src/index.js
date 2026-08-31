#!/usr/bin/env node
// Install the startup failure boundary before imports that decode persisted state.
import './boot-guard.js';
import { start } from './server.js';
import { startCron } from './cron.js';

start();
startCron();
