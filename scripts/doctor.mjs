#!/usr/bin/env node

import process from "node:process";
import { formatDoctorReport, runInstallationDoctor } from "../lib/installation-doctor.mjs";

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!["--json", "--help"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
}

if (args.has("--help")) {
  process.stdout.write("Usage: npm run doctor -- [--json]\n\nChecks the local Agent Bridge installation without printing credentials or private browser data.\n");
} else {
  const report = await runInstallationDoctor();
  process.stdout.write(args.has("--json") ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
  if (!report.ok) process.exitCode = 1;
}
