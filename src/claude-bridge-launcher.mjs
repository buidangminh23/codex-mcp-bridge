#!/usr/bin/env node
import { runSupervisor } from "./mcp-supervisor.mjs";
await runSupervisor("claude-bridge.mjs");
