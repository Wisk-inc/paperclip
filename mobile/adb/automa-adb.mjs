#!/usr/bin/env node
// Links the Automa Android app to Automa running on this computer over ADB,
// by USB cable or Wireless debugging. `adb reverse` makes this computer's
// Automa answer on the phone at 127.0.0.1, so no Wi-Fi address, firewall rule,
// or HTTPS is needed. See mobile/README.md ("Link a computer with ADB").
//
//   node mobile/adb/automa-adb.mjs                      USB, or a phone already linked
//   node mobile/adb/automa-adb.mjs --pair 192.168.1.23:37011 --code 123456
//                                                       Wireless debugging, first time
//   node mobile/adb/automa-adb.mjs --connect 192.168.1.23:41235
//                                                       Wireless debugging, already paired
//   node mobile/adb/automa-adb.mjs --apk Automa-1.3.0.apk
//                                                       also install or update the app
//
// It keeps running and re-links when the phone reconnects (Ctrl+C to stop);
// pass --once to link and exit. Needs adb (Android SDK Platform Tools).
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const APP_ID = "com.corxlabs.automa";
export const OLD_APP_ID = "app.automa.android";
export const CONNECT_EXTRA = `${APP_ID}.CONNECT`;

export function parseArgs(argv) {
  const options = { port: 3100, once: false, launch: true, removeOld: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === "--port") options.port = Number.parseInt(value(), 10);
    else if (arg === "--serial" || arg === "-s") options.serial = value();
    else if (arg === "--pair") options.pair = value();
    else if (arg === "--code") options.code = value();
    else if (arg === "--connect") options.connect = value();
    else if (arg === "--apk") options.apk = value();
    else if (arg === "--once") options.once = true;
    else if (arg === "--no-launch") options.launch = false;
    else if (arg === "--remove-old") options.removeOld = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option ${arg} (try --help)`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("--port must be 1-65535");
  return options;
}

/** Serials of phones that are ready (state `device`) in `adb devices` output. */
export function parseDevices(output) {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial);
}

/** Wireless debugging connect addresses advertised over mDNS (`adb mdns services`). */
export function parseMdnsConnectAddresses(output) {
  return output
    .split("\n")
    .filter((line) => line.includes("_adb-tls-connect._tcp"))
    .map((line) => line.trim().split(/\s+/).pop())
    .filter((address) => /^[\d.]+:\d+$/.test(address ?? ""));
}

function run(args, { quiet = false } = {}) {
  const result = spawnSync(process.env.ADB ?? "adb", args, { encoding: "utf8" });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error("adb is not installed. Install Android SDK Platform Tools (https://developer.android.com/tools/releases/platform-tools) and try again.");
    }
    throw result.error;
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (!quiet && output) console.log(output);
  return { ok: result.status === 0, output };
}

const say = (message) => console.log(`\x1b[1;36m==>\x1b[0m ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function serverAnswers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

function pickDevice(options) {
  const devices = parseDevices(run(["devices"], { quiet: true }).output);
  if (options.serial) return devices.includes(options.serial) ? options.serial : null;
  if (options.connect && devices.includes(options.connect)) return options.connect;
  if (devices.length === 1) return devices[0];
  if (devices.length > 1) throw new Error(`More than one phone is linked (${devices.join(", ")}). Pick one with --serial.`);
  return null;
}

function hasReverse(serial, port) {
  const list = run(["-s", serial, "reverse", "--list"], { quiet: true }).output;
  return list.split("\n").some((line) => line.includes(`tcp:${port} tcp:${port}`));
}

async function link(options) {
  if (options.pair) {
    const code = options.code ?? (await askCode());
    say(`Pairing with ${options.pair}`);
    if (!run(["pair", options.pair, code]).ok) throw new Error("Pairing failed. Check the pairing port and code on the phone's Wireless debugging screen; both change each time you open it.");
    if (!options.connect) {
      // The connect port differs from the pairing port; the phone advertises it.
      const host = options.pair.split(":")[0];
      for (let attempt = 0; attempt < 5 && !options.connect; attempt += 1) {
        options.connect = parseMdnsConnectAddresses(run(["mdns", "services"], { quiet: true }).output).find((address) => address.startsWith(`${host}:`));
        if (!options.connect) await sleep(1000);
      }
      if (!options.connect) {
        throw new Error("Paired. Now run again with --connect PHONE-IP:PORT, using the IP address & Port shown at the top of Wireless debugging.");
      }
    }
  }
  if (options.connect) {
    say(`Connecting to ${options.connect}`);
    const { output } = run(["connect", options.connect]);
    if (!/connected to/i.test(output)) throw new Error(`Could not connect to ${options.connect}. Is Wireless debugging still on, with the same port?`);
  }
  const serial = pickDevice(options);
  if (!serial) {
    throw new Error("No phone found. Plug it in with USB debugging on and allow the prompt, or use --pair/--connect for Wireless debugging.");
  }
  return serial;
}

async function askCode() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question("Pairing code shown on the phone: ")).trim();
  } finally {
    prompt.close();
  }
}

function installed(serial, appId) {
  return run(["-s", serial, "shell", "pm", "list", "packages", appId], { quiet: true }).output
    .split("\n")
    .some((line) => line.trim() === `package:${appId}`);
}

function installApk(serial, apk) {
  say(`Installing ${apk} (updates Automa in place; your sign-in and settings stay)`);
  const { ok, output } = run(["-s", serial, "install", "-r", apk]);
  if (ok) return;
  if (/UPDATE_INCOMPATIBLE|signatures do not match/i.test(output)) {
    throw new Error(`The Automa on the phone was signed with a different key, so Android will not update it. Uninstall it first (adb -s ${serial} uninstall ${APP_ID}), then run this again.`);
  }
  throw new Error("Install failed (see adb's message above).");
}

function start(serial, port) {
  const url = `http://127.0.0.1:${port}`;
  run(["-s", serial, "shell", "am", "start", "-n", `${APP_ID}/.MainActivity`, "--es", CONNECT_EXTRA, url], { quiet: true });
  say(`Opened Automa on the phone, connected to ${url}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(readUsage());
    return;
  }
  run(["version"], { quiet: true });
  const serial = await link(options);
  say(`Phone: ${serial}`);

  if (!(await serverAnswers(options.port))) {
    say(`Nothing answers on http://127.0.0.1:${options.port} yet. Start Automa on this computer (pnpm dev in the source folder); the phone will reach it once it is up.`);
  }
  if (installed(serial, OLD_APP_ID)) {
    if (options.removeOld) {
      say(`Removing the old Automa 1.0 (${OLD_APP_ID})`);
      run(["-s", serial, "uninstall", OLD_APP_ID]);
    } else {
      say(`The old Automa 1.0 (${OLD_APP_ID}) is also on the phone as a separate app. Add --remove-old to uninstall it.`);
    }
  }
  if (options.apk) installApk(serial, options.apk);
  else if (!installed(serial, APP_ID)) say("Automa is not installed on the phone. Add --apk path/to/Automa.apk to install it.");

  if (!run(["-s", serial, "reverse", `tcp:${options.port}`, `tcp:${options.port}`], { quiet: true }).ok) {
    throw new Error("adb reverse failed. Unplug and replug the phone, or reconnect Wireless debugging, then try again.");
  }
  say(`Linked: the phone's 127.0.0.1:${options.port} is this computer's Automa`);
  if (options.launch && installed(serial, APP_ID)) start(serial, options.port);
  if (options.once) return;

  say("Keeping the link up (Ctrl+C to stop). Agents here can also run commands on the phone with: adb -s " + serial + " shell <command>");
  let linked = true;
  for (;;) {
    await sleep(5000);
    let current = parseDevices(run(["devices"], { quiet: true }).output).includes(serial);
    if (!current && options.connect) {
      run(["connect", options.connect], { quiet: true });
      current = parseDevices(run(["devices"], { quiet: true }).output).includes(serial);
    }
    if (!current) {
      if (linked) say("The phone went away (unplugged, asleep, or Wi-Fi changed). Waiting for it…");
      linked = false;
      continue;
    }
    if (!hasReverse(serial, options.port)) {
      run(["-s", serial, "reverse", `tcp:${options.port}`, `tcp:${options.port}`], { quiet: true });
      say(linked ? "The link dropped; restored it." : "The phone is back; linked again.");
    }
    linked = true;
  }
}

function readUsage() {
  return `Usage: node mobile/adb/automa-adb.mjs [options]

Links the Automa Android app to Automa on this computer over ADB (USB or
Wireless debugging). The phone reaches this computer's Automa at 127.0.0.1.

  --pair IP:PORT      Pair over Wireless debugging (Pair device with pairing code)
  --code CODE         The six-digit pairing code (asked for when omitted)
  --connect IP:PORT   Connect over Wireless debugging (IP address & Port on that screen)
  --serial SERIAL     Which phone, when more than one is linked (see adb devices)
  --apk FILE          Install or update the Automa app first (keeps your data)
  --port PORT         Automa's port on this computer (default 3100)
  --remove-old        Uninstall the old Automa 1.0 (${OLD_APP_ID}) if present
  --no-launch         Link only; do not open the app
  --once              Link and exit instead of keeping the link up`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`\x1b[1;31mError:\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
